import { config } from './config.js';
import { query } from './db.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Turns errors and other odd values into something JSON can store. */
function safeData(data: unknown): unknown {
  if (data === undefined) return null;
  try {
    return JSON.parse(
      JSON.stringify(data, (_k, v) => {
        if (v instanceof Error) return { name: v.name, message: v.message, ...(v as unknown as Record<string, unknown>) };
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
        return v;
      }),
    );
  } catch {
    return { unserializable: String(data) };
  }
}

/**
 * Writes one line to `bot_logs` (SPEC §4) and the console. Never throws and never rejects, so callers may
 * fire and forget. Secrets must never be passed in `data`.
 */
export async function log(level: LogLevel, event: string, message: string, data?: unknown): Promise<void> {
  try {
    const lvl: LogLevel = LEVELS.includes(level) ? level : 'info';
    const payload = safeData(data);
    const line = `[stonks ${lvl}] ${event}: ${message}`;
    if (lvl === 'error') console.error(line, payload ?? '');
    else if (lvl === 'warn') console.warn(line, payload ?? '');
    else if (lvl !== 'debug' || process.env.STONKS_DEBUG === '1') console.log(line, payload ?? '');
    if (!config.databaseUrl) return;
    await query('INSERT INTO bot_logs (level, event, message, data) VALUES ($1, $2, $3, $4)', [
      lvl,
      String(event).slice(0, 100),
      String(message).slice(0, 4000),
      payload === null ? null : JSON.stringify(payload),
    ]);
  } catch (err) {
    try {
      console.error('[stonks] log write failed', err instanceof Error ? err.message : err);
    } catch {
      /* nothing left to do */
    }
  }
}

/** Short readable text for an unknown thrown value. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    return String(err);
  }
}
