import {
  dataMarkets,
  DEFAULT_EXECUTION,
  DEFAULT_RISK,
  explainStrategy,
  familyInfo,
  families,
  targets,
  validateSpec,
  warmupBars,
} from './index.js';
import { cachedExplanation, describePy, preparePy, pyFamilies, targetsPy, type PyFamily } from './python.js';
import { INTERVALS, type CandlesByMarket, type FamilyName, type Interval, type StrategySpec, type StrategyState, type Weights } from './types.js';

// Which engine runs a strategy (SPEC.md §6b): a family with a TypeScript port at the spec's version runs here, every
// other family the server's lab copy knows runs as the lab's own Python code. Callers use these instead of the
// TypeScript-only functions in index.ts, so any family the research publishes can trade.

/** A spec for a lab-only family may carry `universe` (point-in-time coin universe), which the lab reads. */
export type AnySpec = StrategySpec & { universe?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The family's TypeScript version when it has a port at `version` (or any version when none is given). */
function native(family: string, version?: unknown) {
  const info = familyInfo(family);
  return info && (version === undefined || version === null || version === info.version) ? info : undefined;
}

function python(family: string, version?: unknown): PyFamily | undefined {
  const f = pyFamilies().get(family);
  return f && (version === undefined || version === null || version === f.version) ? f : undefined;
}

/** The only markets the bot may buy or sell (owner's rule, 2026-10-27): everything is held in EUR, BTC or ETH. */
export const TRADED_MARKETS: readonly unknown[] = ['BTC-EUR', 'ETH-EUR'];

/** True when the spec runs as the lab's Python code. */
export const runsInPython = (spec: { family: string; familyVersion?: unknown }) =>
  !native(spec.family, spec.familyVersion) && !!python(spec.family, spec.familyVersion);

/** True when the bot can run this family at this version (TypeScript port or the lab's Python code). */
export const isRunnable = (family: string, version?: unknown) => !!native(family, version) || !!python(family, version);

/** Every runnable family for the settings editor: the TypeScript ports, then the lab's other families. */
export function allFamilies() {
  const out: unknown[] = [...families];
  for (const f of pyFamilies().values()) {
    if (familyInfo(f.family)) continue;
    out.push({
      family: f.family,
      title: f.title,
      summary: f.summary,
      version: f.version,
      multiMarket: f.multiMarket,
      params: f.params.map((p) => ({
        ...p,
        type: p.type === 'choice' ? 'enum' : p.type,
        options: p.options?.map(String),
        description: p.zero ? `${p.description} (0 = off)` : p.description,
      })),
    });
  }
  return out;
}

function fail(msg: string): never {
  throw new Error(`Invalid strategy: ${msg}`);
}

function hashParams(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * Checks a strategy spec and fills in its defaults, for either engine. Lab families are checked against their
 * published param space here; their cross-param rules run in Python (`checkSpec`). Throws a readable Error.
 */
export function validateAnySpec(input: unknown): AnySpec {
  if (!isObj(input)) fail('expected a JSON object');
  if (Array.isArray(input.markets))
    for (const m of input.markets)
      if (!TRADED_MARKETS.includes(m)) fail(`market "${String(m)}" is not allowed: the bot only trades ${TRADED_MARKETS.join(' and ')}`);
  const family = input.family;
  if (typeof family !== 'string') fail('"family" is missing');
  if (native(family, input.familyVersion) || !python(family, input.familyVersion)) {
    const py = pyFamilies().get(family);
    if (!native(family, input.familyVersion) && py)
      fail(`${family} version ${String(input.familyVersion)} is not supported, the server runs version ${py.version} (deploy the lab's newer code)`);
    return validateSpec(input);
  }
  const info = python(family, input.familyVersion)!;
  // Risk and execution follow the same rules as for TypeScript families: check them on a stand-in spec.
  const base = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1d', risk: input.risk ?? DEFAULT_RISK, execution: input.execution ?? DEFAULT_EXECUTION });

  if (!Array.isArray(input.markets) || input.markets.length === 0) fail('"markets" must list at least one market');
  const markets = input.markets.map((m) => {
    if (typeof m !== 'string' || !/^[A-Z0-9]{1,20}-EUR$/.test(m)) fail(`market "${String(m)}" must look like "BTC-EUR"`);
    return m;
  });
  if (new Set(markets).size !== markets.length) fail('"markets" lists a market twice');
  if (!info.multiMarket && markets.length !== 1) fail(`${family} trades exactly one market`);
  if (markets.length > 40) fail('at most 40 markets');

  const interval = input.interval;
  if (typeof interval !== 'string' || !(INTERVALS as readonly string[]).includes(interval)) fail(`"interval" must be one of ${INTERVALS.join(' ')}`);

  const rawParams = input.params ?? {};
  if (!isObj(rawParams)) fail('"params" must be an object');
  const known = new Set(info.params.map((p) => p.name));
  for (const k of Object.keys(rawParams)) if (!known.has(k)) fail(`${family} has no parameter "${k}"`);
  const params: Record<string, number | boolean | string> = {};
  for (const p of info.params) {
    let v = rawParams[p.name] ?? p.default;
    if (p.type === 'boolean') {
      if (typeof v !== 'boolean') fail(`${p.name} must be true or false`);
    } else if (p.type === 'choice') {
      // The settings form sends every option as text.
      const hit = p.options!.find((o) => o === v || String(o) === v);
      if (hit === undefined) fail(`${p.name} must be one of ${p.options!.join(', ')}`);
      v = hit;
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${p.name} must be a number`);
      if (p.type === 'int' && !Number.isInteger(v)) fail(`${p.name} must be a whole number`);
      const inRange = (p.min === undefined || v >= p.min) && (p.max === undefined || v <= p.max);
      if (!inRange && !(p.zero && v === 0)) fail(`${p.name} must be ${p.zero ? '0 (off) or ' : ''}between ${p.min} and ${p.max}`);
    }
    params[p.name] = v as number | boolean | string;
  }
  if (input.universe !== undefined && (typeof input.universe !== 'string' || input.universe.length > 40)) fail('"universe" must be a short name');

  const shortHash = hashParams(JSON.stringify(params)).slice(0, 6);
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : `${family}-${markets[0].split('-')[0].toLowerCase()}-${interval}-${shortHash}`;
  if (id.length > 200) fail('"id" is too long');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 200) : `${info.title}, ${markets.length > 3 ? `${markets.length} coins` : markets.map((m) => m.split('-')[0]).join('/')} ${interval}`;
  return {
    id,
    name,
    family: family as FamilyName,
    familyVersion: info.version,
    markets,
    interval: interval as Interval,
    params,
    risk: base.risk,
    execution: base.execution,
    ...(typeof input.universe === 'string' ? { universe: input.universe } : {}),
  };
}

/** `validateAnySpec` plus the lab's own checks for Python families (cross-param rules); throws a readable Error. */
export async function checkSpec(input: unknown): Promise<AnySpec> {
  const spec = validateAnySpec(input);
  if (runsInPython(spec)) {
    const d = await describePy(spec);
    if (d.error) fail(d.error);
  }
  return spec;
}

/** Every spec market present, each 0..maxWeight, the sum at most maxWeight (scaled down if needed). */
function clamp(raw: Weights, spec: AnySpec): Weights {
  const out: Weights = {};
  let sum = 0;
  for (const m of spec.markets) {
    const v = Number(raw[m] ?? 0);
    out[m] = Number.isFinite(v) && v > 0 ? Math.min(v, spec.risk.maxWeight) : 0;
    sum += out[m];
  }
  if (sum > spec.risk.maxWeight + 1e-12) for (const m of spec.markets) out[m] = (out[m] * spec.risk.maxWeight) / sum;
  return out;
}

/**
 * Candles the bot loads before deciding. TypeScript families decide on them; lab families read their own full
 * history (the same the backtest saw), so the bot only loads a few recent bars of the traded markets for prices.
 */
export function candlePlan(spec: AnySpec): { markets: string[]; bars: number } {
  if (runsInPython(spec)) return { markets: spec.markets, bars: 3 };
  return { markets: dataMarkets(spec), bars: warmupBars(spec) };
}

export type Decision = { weights: Weights; warming?: undefined } | { warming: string[] };

/**
 * Target weights at `bar` (open time of the last closed bar), from the candles of `candlePlan`. `{ warming }` means
 * the lab is still downloading a lab family's history for the first time: no decision on this bar yet.
 */
export async function decide(spec: AnySpec, bar: number, candles: CandlesByMarket, state?: StrategyState): Promise<Decision> {
  if (!runsInPython(spec)) return { weights: targets(candles, spec, state) };
  const r = await targetsPy(spec, bar, state?.startTime);
  if (r.warming) return { warming: r.warming };
  return { weights: clamp(r.weights, spec) };
}

/** Starts the lab's one-time history download for `spec` in the background (no-op for TypeScript families). */
export function prepare(spec: AnySpec, onDone: (err: Error | null) => void) {
  if (runsInPython(spec)) preparePy(spec, onDone);
}

/** True when the targets depend on the strategy's start time (dca_dip and the lab's anchored families). */
export const isAnchored = (spec: AnySpec) => (runsInPython(spec) ? !!python(spec.family, spec.familyVersion)?.anchored : spec.family === 'dca_dip');

/** One plain-language paragraph for the dashboard. */
export function explainAny(spec: AnySpec): string {
  if (!runsInPython(spec)) return explainStrategy(spec);
  const info = python(spec.family, spec.familyVersion)!;
  const text = cachedExplanation(spec) || info.summary || info.title;
  const r = spec.risk;
  const extra = r.maxWeight < 1 ? ` At most ${+(r.maxWeight * 100).toFixed(2)} % of the portfolio is ever in coins.` : '';
  return `${text}${extra} It runs on ${spec.interval} candles with the research lab's own code for this family.`;
}
