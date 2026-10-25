import { aiConfigured } from './ai.js';
import { config } from './config.js';
import { dbReady, one } from './db.js';
import { generate, isGenerating, rewriteOldest } from './generator.js';
import type { Settings } from './types.js';

/** Hour of the day (0-23) right now in the given IANA timezone. */
export function hourIn(timezone: string, date = new Date()) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: timezone }).format(date));
  } catch {
    return date.getHours();
  }
}

export function withinActiveHours(s: Settings, date = new Date()) {
  if (s.active_hours_start === null || s.active_hours_end === null || s.active_hours_start === s.active_hours_end) return true;
  const h = hourIn(s.timezone, date);
  return s.active_hours_start < s.active_hours_end
    ? h >= s.active_hours_start && h < s.active_hours_end
    : h >= s.active_hours_start || h < s.active_hours_end;
}

export async function publishedLast24h() {
  const row = await one<{ n: string }>(`SELECT count(*) AS n FROM stories WHERE created_at > now() - interval '24 hours'`);
  return Number(row?.n ?? 0);
}

/** When the scheduler will next try to generate, or null when it is switched off / blocked. */
export function nextRunAt(s: Settings): Date | null {
  if (!s.enabled) return null;
  const earliest = s.last_run_at ? new Date(s.last_run_at.getTime() + s.interval_minutes * 60_000) : new Date();
  let t = new Date(Math.max(earliest.getTime(), Date.now()));
  // Walk forward in hourly steps until inside the active window (max 24h).
  for (let i = 0; i < 24 && !withinActiveHours(s, t); i++) {
    t = new Date(t.getTime() + 60 * 60_000);
    t.setMinutes(0, 0, 0);
  }
  return t;
}

export async function schedulerState() {
  const settings = await one<Settings>('SELECT * FROM settings WHERE id = 1');
  const [count, ready] = await Promise.all([publishedLast24h(), dbReady()]);
  const blockers: string[] = [];
  if (!ready) blockers.push('Database is not reachable.');
  if (!aiConfigured()) blockers.push('OPENAI_API_KEY is not set on the server.');
  if (!settings.enabled) blockers.push('Automatic generation is switched off.');
  if (count >= settings.max_per_day) blockers.push(`Daily limit reached (${count}/${settings.max_per_day} in the last 24 hours).`);
  if (!withinActiveHours(settings)) blockers.push(`Outside active hours (${settings.active_hours_start}:00–${settings.active_hours_end}:00 ${settings.timezone}).`);
  return { settings, generating: isGenerating(), next_run_at: nextRunAt(settings), published_24h: count, blockers };
}

async function tick() {
  if (isGenerating() || !aiConfigured() || !(await dbReady())) return;
  const settings = await one<Settings>('SELECT * FROM settings WHERE id = 1');
  if (!settings.enabled || !withinActiveHours(settings)) return;
  const due = !settings.last_run_at || Date.now() - settings.last_run_at.getTime() >= settings.interval_minutes * 60_000;
  if (due && (await publishedLast24h()) < settings.max_per_day) {
    console.log('scheduler: generating story');
    await generate('schedule');
    return;
  }
  if (rewriteDue(settings)) {
    const run = await rewriteOldest('schedule');
    if (run) console.log(`scheduler: rewrote story ${run.story_id} (${run.status})`);
  }
}

/** Stories written with an older prompt version are rewritten one at a time, every rewrite_minutes (0 = never). */
const rewriteDue = (s: Settings) =>
  s.rewrite_minutes > 0 && (!s.last_rewrite_at || Date.now() - s.last_rewrite_at.getTime() >= s.rewrite_minutes * 60_000);

export function startScheduler() {
  const safeTick = () => tick().catch((err) => console.error('scheduler tick failed', err));
  setTimeout(safeTick, 5_000);
  setInterval(safeTick, config.schedulerTickMs);
}
