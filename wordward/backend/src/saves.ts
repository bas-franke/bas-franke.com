// Player saves: the same shape the game keeps in cookies/localStorage (see frontend/src/game/save.ts). The server
// never trusts a save blindly: it keeps only known fields with sane values, and merges instead of overwriting, so
// two devices playing at once both keep their progress (best of each number, settings from the newer copy).

export interface SaveData {
  settings?: Record<string, unknown>;
  best: Record<string, number>;
  levels: Record<string, number>;
  words: { 'en-ro': Record<string, number>; 'ro-en': Record<string, number> };
  t: number;
}

const DIRECTIONS = ['en-ro', 'ro-en'] as const;
const MAX_KEYS = { best: 2000, levels: 5000, words: 20000 };

export const emptySave = (): SaveData => ({ best: {}, levels: {}, words: { 'en-ro': {}, 'ro-en': {} }, t: 0 });

function numbers(input: unknown, keyPattern: RegExp, cap: number, limit: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!input || typeof input !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= limit) break;
    if (!keyPattern.test(k) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[k] = Math.max(0, Math.min(cap, Math.round(v)));
    n++;
  }
  return out;
}

/** Keeps only what a real save contains. Throws on something that is not a save at all. */
export function sanitize(input: unknown): SaveData {
  if (!input || typeof input !== 'object') throw new Error('Not a save');
  const o = input as Record<string, unknown>;
  const out = emptySave();
  if (o.settings && typeof o.settings === 'object' && JSON.stringify(o.settings).length <= 8000) out.settings = o.settings as Record<string, unknown>;
  out.best = numbers(o.best, /^[\w:.-]{1,80}$/, 1e9, MAX_KEYS.best);
  out.levels = numbers(o.levels, /^[\w:.-]{1,80}$/, 3, MAX_KEYS.levels);
  const words = (o.words ?? {}) as Record<string, unknown>;
  for (const dir of DIRECTIONS) out.words[dir] = numbers(words[dir], /^[0-9a-z]{5}$/, 3, MAX_KEYS.words);
  out.t = typeof o.t === 'number' && Number.isFinite(o.t) ? o.t : 0;
  return out;
}

/** Combine two saves: settings from the newer one, the best of everything else. */
export function merge(x: SaveData, y: SaveData): SaveData {
  const out = emptySave();
  out.settings = (x.t >= y.t ? x.settings : y.settings) ?? x.settings ?? y.settings;
  out.t = Math.max(x.t, y.t);
  const max = (a: Record<string, number>, b: Record<string, number>, into: Record<string, number>) => {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) into[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
  };
  max(x.best, y.best, out.best);
  max(x.levels, y.levels, out.levels);
  for (const dir of DIRECTIONS) max(x.words[dir], y.words[dir], out.words[dir]);
  return out;
}
