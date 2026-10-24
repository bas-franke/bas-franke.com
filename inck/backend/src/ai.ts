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
  required: ['title', 'dek', 'tags', 'body_markdown', 'image_prompt', 'image_alt', 'charts', 'sources'],
  properties: {
    title: { type: 'string', description: 'Specific, intriguing headline. No clickbait, no colon-gimmicks.' },
    dek: { type: 'string', description: 'One-sentence subtitle that makes the reader want the article.' },
    tags: { type: 'array', items: { type: 'string' }, description: '3 to 6 short lowercase tags.' },
    body_markdown: {
      type: 'string',
      description:
        'The article in Markdown. Use ## headings, short paragraphs, occasional bold for key facts. ' +
        'Where a chart belongs, put a line containing only [[chart:N]] (N = 1-based index into charts).',
    },
    image_prompt: {
      type: 'string',
      description: 'Prompt for an editorial illustration of the article. Describe a concrete scene, no text in the image.',
    },
    image_alt: { type: 'string', description: 'Alt text for that illustration.' },
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

export interface ArticleDraft {
  title: string;
  dek: string;
  tags: string[];
  body_markdown: string;
  image_prompt: string;
  image_alt: string;
  charts: { type: 'bar' | 'line' | 'area' | 'pie'; title: string; unit: string; labels: string[]; series: { name: string; values: number[] }[]; note: string }[];
  sources: { title: string; url: string }[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  images: number;
}

const isReasoningModel = (model: string) => /^(gpt-5|o\d)/.test(model);

export async function writeArticle(opts: {
  settings: Settings;
  topic: { name: string; description: string };
  recentTitles: string[];
}): Promise<{ draft: ArticleDraft; usage: Usage; model: string }> {
  const { settings, topic } = opts;

  const instructions = [
    `You write for ${settings.site_name}, a site that publishes one genuinely interesting article at a time.`,
    `Audience: ${settings.audience}. Tone: ${settings.tone}. Language: ${settings.language}.`,
    `Length: about ${settings.target_words} words.`,
    'Pick ONE specific, surprising angle inside the topic, not an overview. Open with the most interesting fact.',
    'Formatting rules for body_markdown: start directly with the opening paragraph (no title, no labels such as "lead" or "intro"); ' +
      'split the article into 3 to 5 sections, each introduced by a Markdown heading line starting with "## "; ' +
      'short paragraphs; **bold** only for a handful of key facts; no bullet lists longer than five items.',
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
    `Topic: ${topic.name}\nTopic notes: ${topic.description || '(none)'}\n\n` +
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

  return {
    draft,
    model: response.model,
    usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0, images: 0 },
  };
}

export async function illustrate(settings: Settings, prompt: string): Promise<Buffer> {
  const style =
    'Editorial illustration for a thoughtful online magazine. Clean, modern, slightly painterly, rich but harmonious colours, ' +
    'strong single focal point, no text, no letters, no logos, no watermark.';
  const result = await openai().images.generate({
    model: settings.image_model,
    prompt: `${style}\n\nScene: ${prompt}`,
    n: 1,
    size: '1536x1024',
    quality: settings.image_quality,
    output_format: 'webp',
    // Lossy WebP; without this the API returns ~2 MB files for a hero image.
    output_compression: 80,
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error('The image model returned no image.');
  return Buffer.from(b64, 'base64');
}
