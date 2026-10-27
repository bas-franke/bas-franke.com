import { query } from './db.js';
import { log } from './log.js';
import { validateSpec, type StrategySpec } from './strategies/index.js';
import { validateAnySpec } from './strategies/runtime.js';

/** `settings.bot` (SPEC §5). */
export interface BotSettings {
  enabled: boolean;
  mode: 'paper' | 'live';
  strategy: StrategySpec;
  maxExposureEur: number | null;
  dailyLossLimitEur: number;
  fees: { maker: number; taker: number };
  paperStartEur: number;
  /** The research strategy the owner activated (SPEC §8); null once the strategy is changed any other way. */
  activeResearch: ActiveResearch | null;
  /** "Move everything" from Settings: while set, the bot holds all of it in this coin (or euros) instead of following
   * the strategy, with post-only limit orders re-placed every minute until filled. null = follow the strategy. */
  manual: ManualAllocation | null;
}

export const MANUAL_TARGETS = ['BTC', 'ETH', 'EUR'] as const;
export interface ManualAllocation {
  target: (typeof MANUAL_TARGETS)[number];
  setAt: string;
}

export interface ActiveResearch {
  researchId: number;
  bucket: string;
  rank: number;
  name: string;
  activatedAt: string;
}

/** Thrown for invalid settings changes; the API answers these with 400 and the message. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

export function defaultBotSettings(): BotSettings {
  return {
    enabled: false,
    mode: 'paper',
    strategy: validateSpec({
      id: 'ema_cross-btc-4h-default',
      name: 'EMA crossover, BTC 4h',
      family: 'ema_cross',
      familyVersion: 1,
      markets: ['BTC-EUR'],
      interval: '4h',
      params: { fast: 12, slow: 48 },
    }),
    maxExposureEur: null,
    dailyLossLimitEur: 100,
    fees: { maker: 0.0015, taker: 0.0025 },
    paperStartEur: 1000,
    activeResearch: null,
    manual: null,
  };
}

function checkManual(v: unknown): ManualAllocation | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw new SettingsError('manual must be an object or null');
  if (!(MANUAL_TARGETS as readonly unknown[]).includes(v.target)) throw new SettingsError(`manual.target must be one of ${MANUAL_TARGETS.join(', ')}`);
  if (typeof v.setAt !== 'string' || Number.isNaN(Date.parse(v.setAt))) throw new SettingsError('manual.setAt must be an ISO date');
  return { target: v.target as ManualAllocation['target'], setAt: v.setAt };
}

function checkActiveResearch(v: unknown): ActiveResearch | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw new SettingsError('activeResearch must be an object or null');
  const { researchId, bucket, rank, name, activatedAt } = v;
  if (typeof researchId !== 'number' || !Number.isInteger(researchId) || researchId < 1) throw new SettingsError('activeResearch.researchId must be a snapshot id');
  if (typeof bucket !== 'string' || bucket.length > 20) throw new SettingsError('activeResearch.bucket must be a bucket name');
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1 || rank > 5) throw new SettingsError('activeResearch.rank must be 1 to 5');
  if (typeof name !== 'string' || name.length > 200) throw new SettingsError('activeResearch.name must be a string');
  if (typeof activatedAt !== 'string' || Number.isNaN(Date.parse(activatedAt))) throw new SettingsError('activeResearch.activatedAt must be an ISO date');
  return { researchId, bucket, rank, name, activatedAt };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a full settings object; throws SettingsError. */
export function checkSettings(s: Record<string, unknown>): BotSettings {
  if (typeof s.enabled !== 'boolean') throw new SettingsError('enabled must be true or false');
  if (s.mode !== 'paper' && s.mode !== 'live') throw new SettingsError('mode must be "paper" or "live"');
  let strategy: StrategySpec;
  try {
    strategy = validateAnySpec(s.strategy);
  } catch (err) {
    throw new SettingsError((err as Error).message);
  }
  const maxExposureEur = s.maxExposureEur ?? null;
  if (maxExposureEur !== null && (typeof maxExposureEur !== 'number' || !Number.isFinite(maxExposureEur) || maxExposureEur < 5))
    throw new SettingsError('maxExposureEur must be empty (whole portfolio) or at least 5 euros');
  const limit = s.dailyLossLimitEur;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0)
    throw new SettingsError('dailyLossLimitEur must be a positive number of euros');
  if (!isObj(s.fees)) throw new SettingsError('fees must be { maker, taker }');
  const { maker, taker } = s.fees;
  for (const [name, v] of [['maker', maker], ['taker', taker]] as const)
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 0.01)
      throw new SettingsError(`fees.${name} must be a fraction between 0 and 0.01 (0.0015 = 0.15 %)`);
  const paperStartEur = s.paperStartEur;
  if (typeof paperStartEur !== 'number' || !Number.isFinite(paperStartEur) || paperStartEur < 10 || paperStartEur > 10_000_000)
    throw new SettingsError('paperStartEur must be between 10 and 10,000,000');
  return {
    enabled: s.enabled,
    mode: s.mode,
    strategy,
    maxExposureEur: maxExposureEur as number | null,
    dailyLossLimitEur: limit,
    fees: { maker: maker as number, taker: taker as number },
    paperStartEur,
    activeResearch: checkActiveResearch(s.activeResearch),
    manual: checkManual(s.manual),
  };
}

/** Called after every successful change with the old and new settings (the bot cancels orders when needed). */
type Listener = (before: BotSettings, after: BotSettings) => Promise<void> | void;
const listeners: Listener[] = [];
export function onSettingsChange(fn: Listener) {
  listeners.push(fn);
}

/** Reads `settings.bot`, inserting the defaults on first run. Stored values that no longer validate fall back field by field. */
export async function getBotSettings(): Promise<BotSettings> {
  const { rows } = await query<{ value: Record<string, unknown> }>("SELECT value FROM settings WHERE key = 'bot'");
  const defaults = defaultBotSettings();
  if (!rows[0]) {
    await query("INSERT INTO settings (key, value) VALUES ('bot', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(defaults)]);
    const again = await query<{ value: Record<string, unknown> }>("SELECT value FROM settings WHERE key = 'bot'");
    return again.rows[0] ? safeParse(again.rows[0].value, defaults) : defaults;
  }
  return safeParse(rows[0].value, defaults);
}

async function safeParse(stored: Record<string, unknown>, defaults: BotSettings): Promise<BotSettings> {
  try {
    return checkSettings({ ...defaults, ...stored });
  } catch (err) {
    // A stored value broke (e.g. a family version bump). Keep the bot off rather than guess, and store that: a later
    // deploy that makes the old value valid again must not switch the bot back on by itself.
    if (stored.enabled !== false) {
      await query("UPDATE settings SET value = jsonb_set(value, '{enabled}', 'false'::jsonb), updated_at = now() WHERE key = 'bot'").catch(() => undefined);
      await log('error', 'settings_invalid', `Stored bot settings are invalid, the bot is switched off: ${(err as Error).message}`);
    }
    const merged = { ...defaults, ...stored, enabled: false } as Record<string, unknown>;
    try {
      return checkSettings(merged);
    } catch {
      return { ...defaults, enabled: false, mode: stored.mode === 'live' ? 'live' : 'paper' };
    }
  }
}

const ALLOWED = new Set(['enabled', 'mode', 'strategy', 'maxExposureEur', 'dailyLossLimitEur', 'fees', 'paperStartEur', 'activeResearch', 'manual']);

let chain: Promise<unknown> = Promise.resolve();
/** Serializes settings writes inside this process. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Applies a partial change (SPEC §7 `PUT /api/bot`). Switching `mode` to "live" needs `{ confirmLive: true }`.
 * Throws SettingsError for anything invalid. Unknown keys are rejected.
 */
export function updateBotSettings(patch: Record<string, unknown>, opts: { confirmLive?: boolean } = {}): Promise<BotSettings> {
  return serial(async () => {
    if (!isObj(patch)) throw new SettingsError('Expected a JSON object');
    const keys = Object.keys(patch).filter((k) => k !== 'confirmLive');
    for (const k of keys) if (!ALLOWED.has(k)) throw new SettingsError(`Unknown setting "${k}"`);
    const before = await getBotSettings();
    const merged: Record<string, unknown> = { ...before };
    for (const k of keys) merged[k] = patch[k];
    if (isObj(patch.fees)) merged.fees = { ...before.fees, ...patch.fees };
    const confirm = opts.confirmLive === true || patch.confirmLive === true;
    if (merged.mode === 'live' && before.mode !== 'live' && !confirm)
      throw new SettingsError('Switching to live trading needs confirmLive: true');
    const after = checkSettings(merged);
    // A strategy picked by hand is no longer the activated research strategy.
    if (!keys.includes('activeResearch') && JSON.stringify(after.strategy) !== JSON.stringify(before.strategy)) after.activeResearch = null;
    // Picking a strategy (by hand or from research) ends a manual "move everything".
    if (!keys.includes('manual') && JSON.stringify(after.strategy) !== JSON.stringify(before.strategy)) after.manual = null;
    await query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('bot', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(after)],
    );
    const changed = keys.filter((k) => JSON.stringify((before as unknown as Record<string, unknown>)[k]) !== JSON.stringify((after as unknown as Record<string, unknown>)[k]));
    if (changed.length) {
      await log(
        after.mode === 'live' && before.mode !== 'live' ? 'warn' : 'info',
        'settings_changed',
        `Bot settings changed: ${changed.join(', ')}`,
        Object.fromEntries(changed.map((k) => [k, (after as unknown as Record<string, unknown>)[k]])),
      );
      for (const fn of listeners) {
        try {
          await fn(before, after);
        } catch (err) {
          await log('error', 'settings_listener_failed', `Reacting to a settings change failed: ${(err as Error).message}`);
        }
      }
    }
    return after;
  });
}

/** Generic settings rows (paper_wallet, bot_state). */
export async function getSetting<T>(key: string): Promise<T | undefined> {
  const { rows } = await query<{ value: T }>('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
