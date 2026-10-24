import path from 'node:path';

const env = process.env;
const optional = (value: string | undefined) => value?.trim() || undefined;

export const config = {
  port: Number(env.PORT ?? 3003),
  host: env.HOST ?? '127.0.0.1',

  /** postgres://user:pass@host:5432/inck?sslmode=require */
  databaseUrl: optional(env.DATABASE_URL),
  openaiApiKey: optional(env.OPENAI_API_KEY),

  adminUser: env.ADMIN_USER ?? 'admin',
  adminPassword: optional(env.ADMIN_PASSWORD),
  sessionSecret: optional(env.SESSION_SECRET),

  /** Generated images are stored here (outside the deployed backend folder). */
  dataDir: env.DATA_DIR ?? path.resolve(process.cwd(), '../data'),

  publicUrl: env.PUBLIC_URL ?? 'https://inck.ai',
  schedulerTickMs: 30_000,
};

/**
 * USD per million tokens, used only for the cost estimate on the dashboard. Update when OpenAI changes prices
 * (platform.openai.com/docs/pricing). Text: gpt-5.4-nano. Image: gpt-image-2 output tokens.
 */
export const PRICES = {
  textInputPerM: Number(env.PRICE_TEXT_INPUT ?? 0.2),
  textOutputPerM: Number(env.PRICE_TEXT_OUTPUT ?? 1.25),
  imageOutputPerM: Number(env.PRICE_IMAGE_OUTPUT ?? 30),
  /** Flat price per web search call. */
  webSearchCall: Number(env.PRICE_WEB_SEARCH ?? 0.01),
};

export function estimateCostUsd(u: { input_tokens?: number; output_tokens?: number; image_tokens?: number }, searches = 0) {
  return (
    ((u.input_tokens ?? 0) * PRICES.textInputPerM + (u.output_tokens ?? 0) * PRICES.textOutputPerM + (u.image_tokens ?? 0) * PRICES.imageOutputPerM) /
      1_000_000 +
    searches * PRICES.webSearchCall
  );
}

export const imagesDir = () => path.join(config.dataDir, 'images');
