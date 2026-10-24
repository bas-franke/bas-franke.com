import OpenAI from 'openai';
import { config } from './config.js';
import type { Settings } from './types.js';

let client: OpenAI | undefined;

export const aiConfigured = () => Boolean(config.openaiApiKey);

function openai() {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not set on the server.');
  client ??= new OpenAI({ apiKey: config.openaiApiKey, timeout: 180_000, maxRetries: 2 });
  return client;
}

/** What the writing model must return. Strict mode needs every property listed in `required`. */
export const ARTICLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'dek', 'tags', 'body_markdown', 'images', 'charts', 'sources'],
  properties: {
    title: { type: 'string', description: 'Specific, intriguing headline. No clickbait, no colon-gimmicks.' },
    dek: { type: 'string', description: 'One-sentence subtitle that makes the reader want the article.' },
    tags: { type: 'array', items: { type: 'string' }, description: '3 to 6 short lowercase tags.' },
    body_markdown: {
      type: 'string',
      description:
        'The article in Markdown. Use ## headings, short paragraphs, occasional bold for key facts. ' +
        'Where a chart belongs, put a line containing only [[chart:N]] (N = 1-based index into charts). ' +
        'Where an illustration belongs, put a line containing only [[image:N]] (N = 1-based index into images). ' +
        'Image 1 is the cover and must NOT be placed in the body.',
    },
    images: {
      type: 'array',
      description:
        'Illustrations for the article, in reading order. The first is the cover image. ' +
        'Each prompt describes one concrete scene or object from the article, visually distinct from the others. No text in images.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['prompt', 'alt', 'caption'],
        properties: {
          prompt: { type: 'string', description: 'Detailed visual description for an image model.' },
          alt: { type: 'string', description: 'Alt text.' },
          caption: { type: 'string', description: 'Short caption shown under the image (empty for the cover).' },
        },
      },
    },
    charts: {
      type: 'array',
      description: 'Zero to three data charts with REAL, well-known or clearly estimated figures. Empty if nothing worth charting.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'title', 'unit', 'labels', 'series', 'note'],
        properties: {
          type: { type: 'string', enum: ['bar', 'line', 'area', 'pie'] },
          title: { type: 'string' },
          unit: { type: 'string', description: 'Unit of the values, e.g. "%", "km", "billion USD". Empty if none.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'X-axis categories or pie slices.' },
          series: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'values'],
              properties: {
                name: { type: 'string' },
                values: { type: 'array', items: { type: 'number' }, description: 'Same length as labels.' },
              },
            },
          },
          note: { type: 'string', description: 'Where the numbers come from, or "estimate".' },
        },
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'url'],
        properties: { title: { type: 'string' }, url: { type: 'string' } },
      },
    },
  },
} as const;

export interface ImageSpec {
  prompt: string;
  alt: string;
  caption: string;
}

export interface ArticleDraft {
  title: string;
  dek: string;
  tags: string[];
  body_markdown: string;
  images: ImageSpec[];
  charts: { type: 'bar' | 'line' | 'area' | 'pie'; title: string; unit: string; labels: string[]; series: { name: string; values: number[] }[]; note: string }[];
  sources: { title: string; url: string }[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  images: number;
  /** Output tokens billed by the image model (its price unit). */
  image_tokens: number;
}

const isReasoningModel = (model: string) => /^(gpt-5|o\d)/.test(model);

export const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates', 'pick'],
  properties: {
    candidates: {
      type: 'array',
      description: '5 to 8 subjects people are curious about right now that pass the lightweight filter.',
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
      required: ['subject', 'angle', 'why_now', 'topic_hint'],
      properties: {
        subject: { type: 'string', description: 'The chosen subject.' },
        angle: { type: 'string', description: 'The specific, surprising angle the article should take.' },
        why_now: { type: 'string', description: 'One sentence for readers: why this is interesting today.' },
        topic_hint: { type: 'string', description: 'Which of the given evergreen topics it belongs to, or empty.' },
      },
    },
  },
} as const;

export interface TrendPick {
  subject: string;
  angle: string;
  why_now: string;
  topic_hint: string;
}

/**
 * Finds what is interesting today: combines live signals (trending searches, most-read Wikipedia pages,
 * Hacker News) with web search and picks one lightweight subject.
 */
export async function scoutTrends(opts: {
  settings: Settings;
  signals: string;
  recentTitles: string[];
  topicNames: string[];
}): Promise<{ pick: TrendPick; candidates: { subject: string; why_now: string; buzz: number }[]; usage: Usage }> {
  const { settings } = opts;
  const instructions = [
    `You are the trend scout for ${settings.site_name}, a magazine of genuinely interesting articles. Today is ${new Date().toISOString().slice(0, 10)}.`,
    'Find what people are curious about RIGHT NOW and pick ONE subject worth a thoughtful, enjoyable article.',
    'Use the live signals below as your primary evidence of attention, and use web search to understand each candidate and to find things the signals miss (a discovery, a launch, a record, an odd market move, a viral puzzle).',
    'Lightweight only: science and discoveries, space, technology and gadgets, culture and sports moments, markets and economics explained calmly, nature, records, internet phenomena, anniversaries, how-things-work behind a headline.',
    'Hard exclusions: war and armed conflict, terrorism, crime and violence, deaths and accidents, disasters with casualties, elections and party politics, divisive social issues, celebrity gossip and scandals, anything that reads as breaking hard news.',
    settings.trending_guidance,
    'Prefer subjects with strong, broad attention (high buzz) that still allow a lasting, explanatory piece. Avoid anything already covered recently.',
  ]
    .filter(Boolean)
    .join('\n');

  const input =
    `LIVE SIGNALS\n\n${opts.signals}\n\n` +
    `Evergreen topics on the site (for topic_hint): ${opts.topicNames.join(', ')}\n\n` +
    `Already published recently (avoid):\n${opts.recentTitles.map((t) => `- ${t}`).join('\n') || '- (nothing yet)'}`;

  const request = {
    model: settings.text_model,
    instructions,
    input,
    text: { format: { type: 'json_schema' as const, name: 'scout', schema: SCOUT_SCHEMA as unknown as Record<string, unknown>, strict: true } },
    ...(isReasoningModel(settings.text_model) ? { reasoning: { effort: 'low' as const } } : {}),
  };
  let response;
  try {
    response = await openai().responses.create({ ...request, tools: [{ type: 'web_search' as const }] });
  } catch (err) {
    console.warn('scout web search failed, retrying without tools:', (err as Error).message);
    response = await openai().responses.create(request);
  }
  if (!response.output_text) throw new Error('The scout returned nothing.');
  const parsed = JSON.parse(response.output_text) as { candidates: { subject: string; why_now: string; buzz: number }[]; pick: TrendPick };
  if (!parsed.pick?.subject) throw new Error('The scout picked no subject.');
  return {
    pick: parsed.pick,
    candidates: parsed.candidates ?? [],
    usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0, images: 0, image_tokens: 0 },
  };
}

export async function writeArticle(opts: {
  settings: Settings;
  topic: { name: string; description: string };
  recentTitles: string[];
  /** Set for "right now" pieces: the article explains why the subject is in the air today. */
  trend?: TrendPick;
}): Promise<{ draft: ArticleDraft; usage: Usage; model: string }> {
  const { settings, topic } = opts;
  const imagesWanted = settings.images_enabled
    ? `Provide between ${settings.images_min} and ${settings.images_max} images, as many as the article genuinely benefits from: ` +
      'image 1 is the cover (not placed in the body); place each further image with a [[image:N]] line where it illustrates the text.'
    : 'Provide exactly one image (the cover) and no [[image:N]] markers.';

  const instructions = [
    `You write for ${settings.site_name}, a site that publishes one genuinely interesting article at a time.`,
    `Audience: ${settings.audience}. Tone: ${settings.tone}. Language: ${settings.language}.`,
    `Length: ${settings.target_words} words or more (count only body_markdown). Do not stop early; develop each section properly.`,
    opts.trend
      ? `This is a "right now" piece. Subject: ${opts.trend.subject}. Angle: ${opts.trend.angle}. Why it is in the air today: ${opts.trend.why_now}. ` +
        'Use web search to get the current facts right, say early on why people are talking about it, then go deeper than the news: explain the mechanism, history or science behind it so the piece still reads well next month. Keep it light and curious, not breaking-news.'
      : 'Pick ONE specific, surprising angle inside the topic, not an overview. Open with the most interesting fact.',
    'Formatting rules for body_markdown: start directly with the opening paragraph (no title, no labels such as "lead" or "intro"); ' +
      'split the article into 3 to 6 sections, each introduced by a Markdown heading line starting with "## "; ' +
      'short paragraphs; **bold** only for a handful of key facts; no bullet lists longer than five items.',
    imagesWanted,
    'Every [[chart:N]] or [[image:N]] marker goes on a line of its own, never inside a heading or sentence. ' +
      'Do not add a "Sources" or "References" section to the body: sources go only in the sources field.',
    'Be accurate. Prefer well-established facts; when numbers are estimates, say so. Never invent studies, quotes or URLs.',
    settings.charts_enabled
      ? 'Include 1 to 3 charts only when there is real quantitative data worth showing, and place [[chart:N]] markers in the body.'
      : 'Do not include charts: return an empty charts array and no [[chart:N]] markers.',
    settings.web_search_enabled ? 'Use web search to verify facts and find recent developments; list the pages you relied on as sources.' : '',
    settings.extra_instructions,
  ]
    .filter(Boolean)
    .join('\n');

  const input =
    (opts.trend ? `Subject: ${opts.trend.subject}\nAngle: ${opts.trend.angle}\n\n` : `Topic: ${topic.name}\nTopic notes: ${topic.description || '(none)'}\n\n`) +
    `Already published recently (do not repeat these subjects):\n${opts.recentTitles.map((t) => `- ${t}`).join('\n') || '- (nothing yet)'}`;

  const request = {
    model: settings.text_model,
    instructions,
    input,
    text: { format: { type: 'json_schema' as const, name: 'article', schema: ARTICLE_SCHEMA as unknown as Record<string, unknown>, strict: true } },
    ...(isReasoningModel(settings.text_model) ? { reasoning: { effort: 'low' as const } } : {}),
  };

  let response;
  try {
    response = await openai().responses.create(
      settings.web_search_enabled ? { ...request, tools: [{ type: 'web_search' as const }] } : request,
    );
  } catch (err) {
    // Some models cannot combine tools with structured output; retry without search rather than fail the run.
    if (!settings.web_search_enabled) throw err;
    console.warn('web search request failed, retrying without tools:', (err as Error).message);
    response = await openai().responses.create(request);
  }

  const text = response.output_text;
  if (!text) throw new Error('The model returned no text.');
  const draft = JSON.parse(text) as ArticleDraft;
  if (!draft.title || !draft.body_markdown) throw new Error('The model returned an incomplete article.');
  if (!Array.isArray(draft.images) || !draft.images.length) {
    draft.images = [{ prompt: `${draft.title}. ${draft.dek}`, alt: draft.title, caption: '' }];
  }

  return {
    draft,
    model: response.model,
    usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0, images: 0, image_tokens: 0 },
  };
}

export type ImageQuality = Settings['image_quality'];

/** Renders one illustration. Returns the WebP bytes and the image output tokens the API billed. */
export async function illustrate(settings: Settings, prompt: string, quality: ImageQuality): Promise<{ bytes: Buffer; tokens: number }> {
  const style =
    'Editorial illustration for a thoughtful online magazine. Clean, modern, slightly painterly, rich but harmonious colours, ' +
    'strong single focal point, no text, no letters, no numbers, no logos, no watermark.';
  const result = await openai().images.generate({
    model: settings.image_model,
    prompt: `${style}\n\nScene: ${prompt}`,
    n: 1,
    size: '1536x1024',
    quality,
    output_format: 'webp',
    // Lossy WebP; without this the API returns ~2 MB files for a hero image.
    output_compression: 80,
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error('The image model returned no image.');
  return { bytes: Buffer.from(b64, 'base64'), tokens: result.usage?.output_tokens ?? 0 };
}
