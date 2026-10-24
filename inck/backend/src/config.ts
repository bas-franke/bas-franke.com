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

export const imagesDir = () => path.join(config.dataDir, 'images');
