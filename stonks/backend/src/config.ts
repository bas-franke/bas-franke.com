import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

/** Development: the lab checkout next to this project (stonks-local/) and its venv. */
const localLab = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../stonks-local');
function localPython() {
  for (const p of ['.venv/Scripts/python.exe', '.venv/bin/python']) if (existsSync(path.join(localLab, p))) return path.join(localLab, p);
  return process.platform === 'win32' ? 'python' : 'python3';
}

export const config = {
  port: Number(env.PORT ?? 3006),
  host: env.HOST ?? '127.0.0.1',
  production: env.NODE_ENV === 'production',
  /** PostgreSQL with settings, orders, fills, logs and research snapshots (see SPEC.md §4). */
  databaseUrl: env.DATABASE_URL,
  /** The one dashboard password. Without it nobody can log in. */
  adminPassword: env.STONKS_ADMIN_PASSWORD ?? '',
  /** Bitvavo API key with View + Trade rights (no Withdraw), IP-whitelisted to the server. */
  bitvavoKey: env.BITVAVO_API_KEY ?? '',
  bitvavoSecret: env.BITVAVO_API_SECRET ?? '',
  bitvavoUrl: env.BITVAVO_URL ?? 'https://api.bitvavo.com/v2',
  /** Bitvavo requires an operatorId on every order; any integer that identifies this bot. */
  bitvavoOperatorId: Number(env.BITVAVO_OPERATOR_ID ?? 1001),
  /** Set to 0 to keep the bot loop from starting at all (local development without keys). */
  botLoop: env.STONKS_BOT_LOOP !== '0',
  /** The lab's family code (stonks_lab/ with live.py and catalog.json) that runs families without a TypeScript port. */
  labDir: env.STONKS_LAB_DIR ?? (env.NODE_ENV === 'production' ? '/srv/apps/stonks/lab' : localLab),
  /** Python with numpy and pandas for the lab code. */
  python: env.STONKS_PYTHON ?? (env.NODE_ENV === 'production' ? '/srv/apps/stonks/venv/bin/python' : localPython()),
  /** Where lab families that read extra candles from disk keep them (fetched from Bitvavo on first use). */
  labDataDir: env.STONKS_LAB_DATA_DIR ?? (env.NODE_ENV === 'production' ? '/srv/apps/stonks/labdata' : path.join(localLab, 'data')),
  /** Login attempts per IP per 10 minutes. */
  loginAttempts: Number(env.LOGIN_ATTEMPTS ?? 10),
};
