import OpenAI from 'openai';
import { config } from './config.js';
import { cleanLine, stripCitations } from './text.js';
import type { Category, PlanSection, Settings, Source, Topic, TopicKind, TopicPlan } from './types.js';

let client: OpenAI | undefined;

export const aiConfigured = () => Boolean(config.openaiApiKey);

function openai() {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set on the server.');
  client ??= new OpenAI({ apiKey: config.openaiApiKey, timeout: 180_000, maxRetries: 2 });
  return client;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  images: number;
  /** Output tokens billed by the image model (its price unit). */
  image_tokens: number;
  /** Web search tool calls (billed per call). */
  searches: number;
}

export const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, images: 0, image_tokens: 0, searches: 0 });

export const addUsage = (total: Usage, part: Partial<Usage>) => {
  total.input_tokens += part.input_tokens ?? 0;
  total.output_tokens += part.output_tokens ?? 0;
  total.images += part.images ?? 0;
  total.image_tokens += part.image_tokens ?? 0;
  total.searches += part.searches ?? 0;
  return total;
};

const isReasoningModel = (model: string) => /^(gpt-5|o\d)/.test(model);

type Schema = Record<string, unknown>;

/**
 * One structured-output request. With `webSearch`, the model may search; models that cannot combine tools with
 * structured output fall back to a plain request instead of failing the run.
 */
async function structured<T>(opts: { settings: Settings; name: string; schema: Schema; instructions: string; input: string; webSearch: boolean; effort?: 'low' | 'medium' }) {
  const request = {
    model: opts.settings.text_model,
    instructions: opts.instructions,
    input: opts.input,
    text: { format: { type: 'json_schema' as const, name: opts.name, schema: opts.schema, strict: true } },
    ...(isReasoningModel(opts.settings.text_model) ? { reasoning: { effort: opts.effort ?? ('low' as const) } } : {}),
  };
  let response;
  if (opts.webSearch) {
    try {
      response = await openai().responses.create({ ...request, tools: [{ type: 'web_search' as const }] });
    } catch (err) {
      console.warn(`${opts.name}: web search request failed, retrying without tools:`, (err as Error).message);
      response = await openai().responses.create(request);
    }
  } else {
    response = await openai().responses.create(request);
  }
  if (!response.output_text) throw new Error(`The model returned nothing for ${opts.name}.`);
  const searches = response.output.filter((o) => o.type === 'web_search_call').length;
  const usage: Usage = { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0, images: 0, image_tokens: 0, searches };
  return { data: JSON.parse(response.output_text) as T, usage, model: response.model };
}

/* ------------------------------------------------------------------ planning */

const PLAN_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['intro', 'sections'],
  properties: {
    intro: {
      type: 'string',
      description:
        'Two or three plain sentences written for readers: what this topic is and why it matters to them. Never describe the curriculum, sections, a learning path or this site.',
    },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'blurb', 'items'],
        properties: {
          name: { type: 'string', description: 'Section name, at most four words.' },
          blurb: { type: 'string', description: 'One sentence on what this section covers.' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'brief'],
              properties: {
                title: { type: 'string', description: 'The one idea a 200-word story makes click, as a concrete title of at most 60 characters.' },
                brief: { type: 'string', description: 'One sentence on what that story must explain.' },
              },
            },
          },
        },
      },
    },
  },
};

const topicBrief = (topic: Pick<Topic, 'name' | 'description' | 'kind' | 'category'>) =>
  `Topic: ${topic.name}\nKind: ${topic.kind === 'event' ? 'event (something happening in the world)' : 'field (a lasting subject)'}\nCategory: ${topic.category}\nNotes: ${topic.description || '(none)'}`;

const PLAN_RULES = [
  'You design the curriculum of a learning feed. Readers scroll through very short stories (about 200 words each); every story must make exactly ONE idea click and be fully understandable on its own.',
  'Sections go in order from "no knowledge needed" to "deeper". Each item title names the specific idea the story will make click (for example "Why a qubit can be 0 and 1 at once"), never a vague area ("Qubits").',
  'For an event (a war, a crisis, a crash): cover what is happening in plain terms, how it started (go back decades or centuries where the roots are), the people, countries and groups involved, the key moments, the consequences for ordinary people and the world economy, and what could happen next. Stay neutral and fair: describe what each side says and what is known.',
  'Do not add a "latest news" section; the site adds one automatically. Never repeat an idea across items.',
].join('\n');

/** Generates a fresh curriculum (intro + sections) for a topic. */
export async function planTopic(settings: Settings, topic: Topic): Promise<{ plan: TopicPlan; usage: Usage }> {
  const { data, usage } = await structured<TopicPlan>({
    settings,
    name: 'plan',
    schema: PLAN_SCHEMA,
    instructions: `${PLAN_RULES}\nReturn 4 to 7 sections with 3 to 8 items each. Language: ${settings.language}.`,
    input: topicBrief(topic),
    webSearch: settings.web_search_enabled && topic.kind === 'event',
  });
  if (!data.sections?.length) throw new Error('The planner returned no sections.');
  return { plan: { intro: stripCitations(data.intro ?? ''), sections: data.sections.map(cleanSection) }, usage };
}

/** Adds new sections/items to an exhausted plan; the model sees what exists and what was written. */
export async function extendTopicPlan(settings: Settings, topic: Topic, plan: TopicPlan, writtenTitles: string[]): Promise<{ plan: TopicPlan; usage: Usage }> {
  const existing = plan.sections
    .filter((s) => !s.live)
    .map((s) => `## ${s.name}\n${s.items.map((i) => `- ${i.title}`).join('\n')}`)
    .join('\n');
  const { data, usage } = await structured<TopicPlan>({
    settings,
    name: 'plan_extension',
    schema: PLAN_SCHEMA,
    instructions: `${PLAN_RULES}\nEvery planned item has been written. Return 1 to 3 sections with 3 to 6 NEW items each that go deeper or fill gaps: reuse an existing section name to add to it, or a new name for a new section. Return the existing intro unchanged. No item may repeat an existing or written one. Language: ${settings.language}.`,
    input: `${topicBrief(topic)}\n\nEXISTING PLAN\n${existing}\n\nSTORIES WRITTEN\n${writtenTitles.map((t) => `- ${t}`).join('\n') || '- (none)'}`,
    webSearch: settings.web_search_enabled && topic.kind === 'event',
  });
  const sections = plan.sections.map((s) => ({ ...s, items: [...s.items] }));
  for (const incoming of (data.sections ?? []).map(cleanSection)) {
    const target = sections.find((s) => !s.live && s.name.toLowerCase() === incoming.name.toLowerCase());
    const known = new Set(sections.flatMap((s) => s.items.map((i) => i.title.toLowerCase())));
    const fresh = incoming.items.filter((i) => !known.has(i.title.toLowerCase()));
    if (!fresh.length) continue;
    if (target) target.items.push(...fresh);
    else {
      const live = sections.findIndex((s) => s.live);
      sections.splice(live === -1 ? sections.length : live, 0, { ...incoming, items: fresh });
    }
  }
  return { plan: { intro: plan.intro || stripCitations(data.intro ?? ''), sections }, usage };
}

function cleanSection(s: PlanSection): PlanSection {
  return {
    name: cleanLine(s.name, 40),
    blurb: cleanLine(s.blurb),
    items: (s.items ?? []).filter((i) => i.title?.trim()).map((i) => ({ title: cleanLine(i.title, 90), brief: cleanLine(i.brief) })),
  };
}

/* ------------------------------------------------------------------ trend radar */

const RADAR_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['trends'],
  properties: {
    trends: {
      type: 'array',
      description: '6 to 10 global subjects the world is talking about and trying to understand right now, hottest first, then up to 2 national subjects for each local country.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'existing_slug', 'category', 'kind', 'country', 'heat', 'why_now', 'description'],
        properties: {
          name: { type: 'string', description: 'Neutral, specific topic name of at most 40 characters, e.g. "The Sudan civil war" or "The 2026 oil price shock".' },
          existing_slug: { type: 'string', description: 'Slug of the existing topic this trend belongs to, or empty when it is new.' },
          category: { type: 'string', enum: ['technology', 'science', 'money', 'world', 'society'] },
          kind: { type: 'string', enum: ['field', 'event'], description: 'event = something happening; field = a lasting subject that is suddenly hot.' },
          country: {
            type: 'string',
            description:
              'ISO 3166-1 alpha-2 code (e.g. "NL") when the subject matters mainly to people living in that one country; empty when people elsewhere follow it too, even if it happens in one country (riots in France, a US presidential election).',
          },
          heat: {
            type: 'integer',
            description: '5 = everyone worldwide is talking about it, 3 = big in several countries or communities, 1 = notable in one. National subjects: how hot it is inside that country.',
          },
          why_now: { type: 'string', description: 'One sentence for readers: what is happening and why people care today.' },
          description: { type: 'string', description: 'One sentence on what the topic covers, for the planner.' },
        },
      },
    },
  },
};

export interface Trend {
  name: string;
  existing_slug: string;
  category: Category;
  kind: TopicKind;
  /** Upper-case ISO code for national news, empty for global. */
  country: string;
  heat: number;
  why_now: string;
  description: string;
}

/**
 * The radar discovers, on its own, what the world is talking about right now: live signals plus web search, no
 * menu. Each trend becomes (or updates) a topic with a heat score; the existing list is only there for matching.
 */
export async function scanTrends(opts: {
  settings: Settings;
  signals: string;
  topics: Pick<Topic, 'slug' | 'name' | 'kind' | 'category' | 'heat' | 'country'>[];
}): Promise<{ trends: Trend[]; usage: Usage }> {
  const { settings } = opts;
  const local = settings.local_countries ?? [];
  const instructions = [
    `You are the trend radar for ${settings.site_name}, a learning feed that explains complicated things to anyone. Today is ${new Date().toISOString().slice(0, 10)}.`,
    'Discover, on your own, the 6 to 10 subjects the world is talking about and trying to UNDERSTAND right now, hottest first. Use the live signals as evidence of attention and use web search to confirm what is actually happening and to find big stories the signals miss (other regions, markets, science, technology).',
    'Good: wars and conflicts, elections and political crises, market crashes and rallies, inflation and rate decisions, bankruptcies and trade disputes, disasters and their causes, scientific results, technology everyone suddenly uses, cultural moments with substance behind them.',
    'Skip: celebrity gossip and scandals, individual crime cases, sports results, unverified rumours, anything where the only story is graphic detail.',
    local.length
      ? `LOCAL COUNTRIES: ${local.join(', ')}. After the global subjects, add up to 2 national subjects for each of them: what people living there are talking about and trying to understand (a national election or coalition crisis, a strike, the budget, a national policy, a domestic disaster), found with web search in that country's news. Give these the country code. Global news is never repeated as a national subject, and a national subject the whole world follows (riots in France, a US presidential election) is global: country empty.`
      : 'Every subject is global: leave country empty.',
    'Each trend becomes a topic of the site: an "event" for something happening (a specific war, election, crisis, crash, disaster, trial, launch) or a "field" for a lasting subject that is suddenly hot. Name topics neutrally and specifically; never a headline, never a person\'s name alone.',
    'The EXISTING TOPICS list is not a menu: never pick from it. It is only there so that a trend that is a development inside an existing topic (a new offensive in an ongoing war, a new model in Artificial intelligence) returns that topic\'s slug in existing_slug instead of creating a duplicate.',
    settings.trending_guidance,
  ]
    .filter(Boolean)
    .join('\n');
  const input =
    `LIVE SIGNALS\n\n${opts.signals}\n\n` +
    `EXISTING TOPICS (slug: name)\n${opts.topics.map((t) => `- ${t.slug}: ${t.name} (${t.kind}, ${t.category}${t.country ? `, national: ${t.country}` : ''}${t.heat ? `, currently hot ${t.heat}/5` : ''})`).join('\n')}`;
  const { data, usage } = await structured<{ trends: Trend[] }>({ settings, name: 'radar', schema: RADAR_SCHEMA, instructions, input, webSearch: settings.web_search_enabled });
  const trends = (data.trends ?? [])
    .filter((t) => t.name?.trim())
    .map((t) => ({
      ...t,
      name: cleanLine(t.name, 60),
      why_now: cleanLine(t.why_now),
      description: cleanLine(t.description),
      country: /^[A-Za-z]{2}$/.test(t.country?.trim() ?? '') ? t.country.trim().toUpperCase() : '',
      heat: Math.min(5, Math.max(1, Math.round(Number(t.heat) || 1))),
    }));
  if (!trends.length) throw new Error('The radar found no trends.');
  return { trends, usage };
}

/* ------------------------------------------------------------------ trend scout */

const SCOUT_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates', 'pick'],
  properties: {
    candidates: {
      type: 'array',
      description: '5 to 8 subjects many people are trying to understand right now.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'why_now', 'buzz'],
        properties: {
          subject: { type: 'string' },
          why_now: { type: 'string', description: 'One sentence: what happened / why it is being searched.' },
          buzz: { type: 'integer', description: '1 (niche) to 5 (everyone is talking about it).' },
        },
      },
    },
    pick: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'angle', 'why_now', 'topic_slug', 'new_topic'],
      properties: {
        subject: { type: 'string', description: 'The chosen subject.' },
        angle: { type: 'string', description: 'The ONE thing a 200-word story should make the reader understand about it.' },
        why_now: { type: 'string', description: 'One sentence for readers: why this is in the air today.' },
        topic_slug: { type: 'string', description: 'Slug of the existing topic this belongs to, or empty when a new topic is needed.' },
        new_topic: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'description', 'category', 'kind'],
              properties: {
                name: { type: 'string', description: 'Neutral topic name, at most 40 characters, e.g. "The Sudan civil war" or "The 2026 oil shock".' },
                description: { type: 'string', description: 'One sentence on what the topic covers.' },
                category: { type: 'string', enum: ['technology', 'science', 'money', 'world', 'society'] },
                kind: { type: 'string', enum: ['field', 'event'] },
              },
            },
            { type: 'null' },
          ],
          description: 'Only when no existing topic fits: the topic to create for it.',
        },
      },
    },
  },
};

export interface TrendPick {
  subject: string;
  angle: string;
  why_now: string;
  topic_slug: string;
  new_topic: { name: string; description: string; category: Category; kind: TopicKind } | null;
}

/**
 * Finds what people are trying to understand right now: live signals (news headlines, trending searches, most-read
 * Wikipedia pages, Hacker News) plus web search, and picks one subject with the topic it belongs to.
 */
export async function scoutTrends(opts: {
  settings: Settings;
  signals: string;
  recentTitles: string[];
  topics: Pick<Topic, 'slug' | 'name' | 'kind' | 'category'>[];
  /** When set, the scout stays inside this hot topic and only picks what to explain about it today. */
  focus?: Pick<Topic, 'slug' | 'name' | 'heat_reason'>;
}): Promise<{ pick: TrendPick; usage: Usage }> {
  const { settings } = opts;
  const instructions = [
    `You are the trend scout for ${settings.site_name}, a learning feed of very short stories that explain complicated things to anyone. Today is ${new Date().toISOString().slice(0, 10)}.`,
    opts.focus
      ? `The topic "${opts.focus.name}" is trending (${opts.focus.heat_reason || 'in the news'}). Pick the ONE thing about it that most people would want to understand today: the newest development, a mechanism behind it, a term everyone is using, or a piece of history that explains the present. Use web search to get the current facts. Return topic_slug "${opts.focus.slug}" and no new topic.`
      : 'Find what many people are trying to UNDERSTAND right now and pick ONE subject. Good: wars and conflicts, elections and political crises, market crashes and rallies, inflation and rate decisions, bankruptcies, trade disputes, disasters and their causes, scientific results, technology everyone suddenly uses, cultural moments with substance behind them.',
    'Skip: celebrity gossip and scandals, individual crime cases, sports results, unverified rumours, anything where the only story is graphic detail.',
    'Use the live signals as evidence of attention; use web search to check what actually happened and to find things the signals miss.',
    opts.focus
      ? ''
      : 'Then decide where it lives: if it fits one of the existing topics, give its slug (a new development in an ongoing war belongs to that war\'s topic; a new AI model belongs to Artificial intelligence). Otherwise describe a new topic: an "event" for something happening (a specific conflict, crisis or crash), a "field" for a lasting subject. Give new topics neutral names.',
    'The angle must be explanatory, not a news summary: the mechanism, the history, who the parties are, why it matters. Avoid subjects already covered recently.',
    settings.trending_guidance,
  ]
    .filter(Boolean)
    .join('\n');

  const input =
    `LIVE SIGNALS\n\n${opts.signals}\n\n` +
    `EXISTING TOPICS (slug: name)\n${opts.topics.map((t) => `- ${t.slug}: ${t.name} (${t.kind}, ${t.category})`).join('\n')}\n\n` +
    `ALREADY PUBLISHED RECENTLY (avoid)\n${opts.recentTitles.map((t) => `- ${t}`).join('\n') || '- (nothing yet)'}`;

  const { data, usage } = await structured<{ pick: TrendPick }>({ settings, name: 'scout', schema: SCOUT_SCHEMA, instructions, input, webSearch: settings.web_search_enabled });
  if (!data.pick?.subject) throw new Error('The scout picked no subject.');
  const pick: TrendPick = {
    ...data.pick,
    subject: cleanLine(data.pick.subject, 200),
    angle: cleanLine(data.pick.angle, 400),
    why_now: cleanLine(data.pick.why_now),
    new_topic: data.pick.new_topic && { ...data.pick.new_topic, name: cleanLine(data.pick.new_topic.name, 60), description: cleanLine(data.pick.new_topic.description) },
  };
  return { pick, usage };
}

/* ------------------------------------------------------------------ writing */

const STORY_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'hook', 'body_markdown', 'takeaway', 'section', 'difficulty', 'tags', 'images', 'sources'],
  properties: {
    title: { type: 'string', description: 'At most 60 characters. Concrete and curiosity-making; no clickbait, no colon gimmicks.' },
    hook: { type: 'string', description: 'One sentence, at most 140 characters, saying what the reader will understand.' },
    body_markdown: {
      type: 'string',
      description: 'The story in Markdown: short paragraphs only, no headings, no links, no citation numbers, **bold** on the 1-3 terms to remember.',
    },
    takeaway: { type: 'string', description: 'One plain sentence stating the idea, as a line the reader could repeat to a friend.' },
    section: { type: 'string', description: 'The name of the topic section this story belongs to, chosen from the list given.' },
    difficulty: { type: 'integer', description: '1 = anyone, 2 = everyday knowledge helps, 3 = a detail inside the topic. Still fully standalone.' },
    tags: { type: 'array', items: { type: 'string' }, description: '3 to 5 short lowercase tags.' },
    images: {
      type: 'array',
      description: 'Zero to two pictures, only when a picture genuinely helps understanding. Usually empty.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'alt', 'caption', 'relevance'],
        properties: {
          prompt: { type: 'string', description: 'Concrete visual description of a place, object, machine or physical process. No text in the image.' },
          alt: { type: 'string' },
          caption: { type: 'string', description: 'Short caption, or empty.' },
          relevance: { type: 'string', enum: ['essential', 'helpful', 'decorative'], description: 'Decorative pictures are not rendered.' },
        },
      },
    },
    sources: {
      type: 'array',
      description: '1 to 4 pages you relied on.',
      items: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: { type: 'string' }, url: { type: 'string' } } },
    },
  },
};

export interface ImageSpec {
  prompt: string;
  alt: string;
  caption: string;
  relevance: 'essential' | 'helpful' | 'decorative';
}

export interface StoryDraft {
  title: string;
  hook: string;
  body_markdown: string;
  takeaway: string;
  section: string;
  difficulty: number;
  tags: string[];
  images: ImageSpec[];
  sources: Source[];
}

/** How many pictures a story gets and how useful they must be; decided by how hot its topic is (see picturePolicy). */
export interface PicturePolicy {
  min: number;
  max: number;
  /** Lowest relevance that still gets rendered. */
  accept: ImageSpec['relevance'][];
}

/**
 * The most relevant topics get pictures, the rest mostly do not: a story in a topic everyone is talking about
 * (heat 4–5) always gets at least one; a warm topic (2–3) gets one when it helps; a cool topic only when essential.
 */
export function picturePolicy(settings: Settings, heat: number): PicturePolicy {
  const cap = settings.images_enabled ? Math.max(0, Math.min(2, settings.images_max)) : 0;
  if (!cap) return { min: 0, max: 0, accept: [] };
  if (heat >= 4) return { min: 1, max: cap, accept: ['essential', 'helpful', 'decorative'] };
  if (heat >= 2) return { min: 0, max: Math.min(1, cap), accept: ['essential', 'helpful'] };
  return { min: 0, max: Math.min(1, cap), accept: ['essential'] };
}

export async function writeStory(opts: {
  settings: Settings;
  topic: Topic;
  plan: TopicPlan;
  /** Planned stories: the section and item to write. */
  item?: { section: string; title: string; brief: string };
  /** Trending stories: what the scout picked. */
  trend?: TrendPick;
  recentTitles: string[];
  pictures: PicturePolicy;
}): Promise<{ draft: StoryDraft; usage: Usage; model: string }> {
  const { settings, topic, plan, pictures } = opts;
  const sectionNames = plan.sections.map((s) => s.name);
  const maxWords = Math.round(settings.target_words * 1.3);
  const pictureRules = !pictures.max
    ? 'PICTURES. Return an empty images array.'
    : pictures.min > 0
      ? `PICTURES. This topic is what everyone is talking about and the story will be seen by many readers: include at least one picture (at most ${pictures.max}) that anchors it, such as the place, the object, the machine or the scene at the heart of the story. Never the face of a real person, no text in the image. Mark each as essential, helpful or decorative.`
      : `PICTURES. Most stories need none. Add at most ${pictures.max}, and only when a picture genuinely helps understanding: a real place, object, machine, map-like scene or physical process. Never for abstract ideas, never as decoration, never the face of a real person. Mark each as essential, helpful or decorative.`;

  const instructions = [
    `You write for ${settings.site_name}, a learning feed: people scroll through very short stories, and each one makes a single complicated idea click.`,
    `Audience: ${settings.audience}. Tone: ${settings.tone}. Language: ${settings.language}.`,
    `THE STORY. About ${settings.target_words} words in body_markdown, never more than ${maxWords}. Paragraphs of one to three sentences. No headings, no lists longer than three items, no links, no URLs, no citation numbers.`,
    'Fully standalone: assume the reader has never heard of the topic and has read nothing else here. Define every term the moment you use it, in plain words. Never refer to other stories ("as we saw", "in the previous part").',
    'Tell it as a story, not a lecture: open with a concrete scene, person, moment or question (first sentence at most fifteen words), explain the mechanism or the why with one strong, everyday analogy, then land on why it matters to the reader.',
    'Bold (**like this**) the one to three terms a reader should remember. Use numbers only when they really help, rounded and with context.',
    'Be accurate. Prefer well-established facts; say "roughly" for estimates; never invent studies, quotes, figures or URLs.',
    'On contested matters (wars, politics, economics): be neutral and fair, attribute claims to who makes them, describe what each side says and what is known, no advocacy.',
    `Title: at most 60 characters, concrete, no clickbait. Hook: one sentence, at most 140 characters. Takeaway: the idea in one plain sentence. tags: 3 to 5 lowercase. Sources: 1 to 4 pages you relied on (in the sources field only).`,
    pictureRules,
    opts.trend
      ? `THIS STORY is about something happening right now. Subject: ${opts.trend.subject}. The one thing to make click: ${opts.trend.angle}. Why people care today: ${opts.trend.why_now}. ` +
        'Use web search to get the current facts right. State what happened in one or two sentences, then spend most words on the explanation (history, mechanism, who and why) so the story still reads well next month. ' +
        `Choose the section from: ${sectionNames.join(' | ')} (use "${plan.sections.find((s) => s.live)?.name ?? 'Latest'}" for a day-to-day development).`
      : `THIS STORY is one item of the topic's curriculum. Section: ${opts.item!.section}. Idea to make click: ${opts.item!.title}. What it must explain: ${opts.item!.brief}. Return exactly this section name.`,
    settings.extra_instructions,
  ]
    .filter(Boolean)
    .join('\n');

  const input =
    `${topicBrief(topic)}\nTopic intro: ${plan.intro}\n\n` +
    `ALREADY ON THE SITE (do not retell these)\n${opts.recentTitles.map((t) => `- ${t}`).join('\n') || '- (nothing yet)'}`;

  const webSearch = settings.web_search_enabled && (Boolean(opts.trend) || topic.kind === 'event');
  const { data, usage, model } = await structured<StoryDraft>({ settings, name: 'story', schema: STORY_SCHEMA, instructions, input, webSearch, effort: 'medium' });
  if (!data.title || !data.body_markdown) throw new Error('The model returned an incomplete story.');
  const draft: StoryDraft = {
    ...data,
    title: cleanLine(data.title, 90) || data.title,
    hook: cleanLine(data.hook, 200),
    takeaway: cleanLine(data.takeaway, 300),
    section: cleanLine(data.section, 40),
    tags: (data.tags ?? []).map((t) => cleanLine(t, 40)),
    images: (data.images ?? []).map((i) => ({ ...i, alt: cleanLine(i.alt, 200), caption: cleanLine(i.caption, 200) })),
  };
  return { draft, usage, model };
}

/* ------------------------------------------------------------------ pictures */

/** Renders one picture. Returns the WebP bytes and the image output tokens the API billed. */
export async function illustrate(settings: Settings, prompt: string): Promise<{ bytes: Buffer; tokens: number }> {
  const style =
    'Clear editorial illustration for a learning site. Clean, modern, slightly painterly, harmonious colours, one strong focal point, ' +
    'realistic proportions, no text, no letters, no numbers, no logos, no watermark.';
  const result = await openai().images.generate({
    model: settings.image_model,
    prompt: `${style}\n\nScene: ${prompt}`,
    n: 1,
    size: '1536x1024',
    quality: settings.image_quality,
    output_format: 'webp',
    // Lossy WebP; without this the API returns ~2 MB files.
    output_compression: 80,
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error('The image model returned no image.');
  return { bytes: Buffer.from(b64, 'base64'), tokens: result.usage?.output_tokens ?? 0 };
}
