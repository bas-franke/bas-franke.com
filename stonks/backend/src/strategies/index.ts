import { families, REGIME_MARKET, runners } from './families.js';
import {
  INTERVAL_MS,
  INTERVALS,
  type CandlesByMarket,
  type ExecutionSpec,
  type FamilyInfo,
  type FamilyName,
  type Interval,
  type RiskSpec,
  type StrategySpec,
  type StrategyState,
  type Weights,
} from './types.js';

export * from './types.js';
export { families, REGIME_MARKET } from './families.js';
export { cleanCandles } from './families.js';

export const DEFAULT_RISK: RiskSpec = { maxWeight: 1, stopLossPct: null, takeProfitPct: null, trailingStopPct: null };
export const DEFAULT_EXECUTION: ExecutionSpec = {
  orderType: 'limit',
  limitOffsetBps: 5,
  postOnly: true,
  timeoutBars: 1,
  fallback: 'cancel',
};

export const familyInfo = (family: string): FamilyInfo | undefined => families.find((f) => f.family === family);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(msg: string): never {
  throw new Error(`Invalid strategy: ${msg}`);
}

function pct(v: unknown, name: string, max = 1): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v >= max)
    fail(`${name} must be null or a number between 0 and ${max} (e.g. 0.08 for 8 %)`);
  return v;
}

/**
 * Checks a strategy spec (SPEC §2) and returns it with every default filled in. Throws an Error with a message the
 * owner can read when anything is wrong. Missing params, risk and execution fields take their defaults; unknown
 * params are rejected so typos do not silently fall back to defaults.
 */
export function validateSpec(input: unknown): StrategySpec {
  if (!isObj(input)) fail('expected a JSON object');
  const family = input.family;
  if (typeof family !== 'string') fail('"family" is missing');
  const info = familyInfo(family);
  if (!info) fail(`family "${family}" is not runnable by the bot (known: ${families.map((f) => f.family).join(', ')})`);
  const familyVersion = input.familyVersion ?? info.version;
  if (familyVersion !== info.version)
    fail(`${family} version ${String(familyVersion)} is not supported, the bot runs version ${info.version}`);

  if (!Array.isArray(input.markets) || input.markets.length === 0) fail('"markets" must list at least one market');
  const markets = input.markets.map((m) => {
    if (typeof m !== 'string' || !/^[A-Z0-9]{1,20}-EUR$/.test(m)) fail(`market "${String(m)}" must look like "BTC-EUR"`);
    return m;
  });
  if (new Set(markets).size !== markets.length) fail('"markets" lists a market twice');
  if (!info.multiMarket && markets.length !== 1) fail(`${family} trades exactly one market`);
  if (info.multiMarket && markets.length > 30) fail('at most 30 markets');

  const interval = input.interval;
  if (typeof interval !== 'string' || !(INTERVALS as readonly string[]).includes(interval))
    fail(`"interval" must be one of ${INTERVALS.join(' ')}`);

  const rawParams = input.params ?? {};
  if (!isObj(rawParams)) fail('"params" must be an object');
  const known = new Set(info.params.map((p) => p.name));
  for (const k of Object.keys(rawParams)) if (!known.has(k)) fail(`${family} has no parameter "${k}"`);
  const params: Record<string, number | boolean | string> = {};
  for (const p of info.params) {
    const v = rawParams[p.name] ?? p.default;
    if (p.type === 'boolean') {
      if (typeof v !== 'boolean') fail(`${p.name} must be true or false`);
    } else if (p.type === 'enum') {
      if (typeof v !== 'string' || !p.options!.includes(v)) fail(`${p.name} must be one of ${p.options!.join(', ')}`);
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${p.name} must be a number`);
      if (p.type === 'int' && !Number.isInteger(v)) fail(`${p.name} must be a whole number`);
      if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max))
        fail(`${p.name} must be between ${p.min} and ${p.max}`);
    }
    params[p.name] = v as number | boolean | string;
  }
  if ((family === 'ema_cross' || family === 'macd_trend') && !((params.fast as number) < (params.slow as number)))
    fail('fast must be smaller than slow');
  if (family === 'rsi_dip' && !((params.buyBelow as number) < (params.sellAbove as number)))
    fail('buyBelow must be smaller than sellAbove');
  if (family === 'rotation_momentum' && (params.top as number) > markets.length)
    fail('top cannot be larger than the number of markets');

  const r = input.risk ?? {};
  if (!isObj(r)) fail('"risk" must be an object');
  const maxWeight = r.maxWeight ?? DEFAULT_RISK.maxWeight;
  if (typeof maxWeight !== 'number' || !(maxWeight > 0 && maxWeight <= 1)) fail('risk.maxWeight must be above 0 and at most 1');
  const risk: RiskSpec = {
    maxWeight,
    stopLossPct: pct(r.stopLossPct, 'risk.stopLossPct'),
    takeProfitPct: pct(r.takeProfitPct, 'risk.takeProfitPct', 100),
    trailingStopPct: pct(r.trailingStopPct, 'risk.trailingStopPct'),
  };

  const e = input.execution ?? {};
  if (!isObj(e)) fail('"execution" must be an object');
  const execution: ExecutionSpec = {
    orderType: (e.orderType ?? DEFAULT_EXECUTION.orderType) as ExecutionSpec['orderType'],
    limitOffsetBps: (e.limitOffsetBps ?? DEFAULT_EXECUTION.limitOffsetBps) as number,
    postOnly: (e.postOnly ?? DEFAULT_EXECUTION.postOnly) as boolean,
    timeoutBars: (e.timeoutBars ?? DEFAULT_EXECUTION.timeoutBars) as number,
    fallback: (e.fallback ?? DEFAULT_EXECUTION.fallback) as ExecutionSpec['fallback'],
  };
  if (execution.orderType !== 'limit' && execution.orderType !== 'market') fail('execution.orderType must be "limit" or "market"');
  if (typeof execution.limitOffsetBps !== 'number' || !(execution.limitOffsetBps >= 0 && execution.limitOffsetBps <= 500))
    fail('execution.limitOffsetBps must be between 0 and 500');
  if (typeof execution.postOnly !== 'boolean') fail('execution.postOnly must be true or false');
  if (!Number.isInteger(execution.timeoutBars) || execution.timeoutBars < 1 || execution.timeoutBars > 100)
    fail('execution.timeoutBars must be a whole number from 1 to 100');
  if (execution.fallback !== 'cancel' && execution.fallback !== 'market') fail('execution.fallback must be "cancel" or "market"');

  const shortHash = hashParams(JSON.stringify(params)).slice(0, 6);
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : `${family}-${markets[0].split('-')[0].toLowerCase()}-${interval}-${shortHash}`;
  if (id.length > 200) fail('"id" is too long');
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 200) : `${info.title}, ${markets.map((m) => m.split('-')[0]).join('/')} ${interval}`;

  return { id, name, family: family as FamilyName, familyVersion: info.version, markets, interval: interval as Interval, params, risk, execution };
}

function hashParams(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export const intervalMs = (interval: Interval) => INTERVAL_MS[interval];

/** Markets whose candles the family needs (rotation with a regime filter also needs BTC-EUR). */
export function dataMarkets(spec: StrategySpec): string[] {
  const set = new Set(spec.markets);
  if (spec.family === 'rotation_momentum' && Number(spec.params.regimeSma) > 0) set.add(REGIME_MARKET);
  return [...set];
}

/** How many closed bars the bot should load so indicators and stateful families have settled. */
export function warmupBars(spec: StrategySpec): number {
  const numbers = Object.values(spec.params).filter((v): v is number => typeof v === 'number');
  const longest = Math.max(1, ...numbers.filter((v) => Number.isInteger(v)));
  return Math.min(1440, Math.max(300, longest * 6));
}

/** Target weights for every bar of the input (SPEC §2 decision model). */
export function targetSeries(candles: CandlesByMarket, specInput: StrategySpec, state?: StrategyState): Array<[number, Weights]> {
  const spec = validateSpec(specInput);
  const series = runners[spec.family](candles, spec, state);
  return series.map(([t, w]) => [t, clampWeights(w, spec)]);
}

/** Targets at the last bar of the input. Every market of the spec is present (0 when not held). */
export function targets(candles: CandlesByMarket, spec: StrategySpec, state?: StrategyState): Weights {
  const series = targetSeries(candles, spec, state);
  const last = series[series.length - 1];
  return last ? last[1] : Object.fromEntries(spec.markets.map((m) => [m, 0]));
}

/** Every spec market present, each 0..maxWeight, the sum at most maxWeight (scaled down if needed). */
function clampWeights(w: Weights, spec: StrategySpec): Weights {
  const out: Weights = {};
  let sum = 0;
  for (const m of spec.markets) {
    const v = Number(w[m] ?? 0);
    out[m] = Number.isFinite(v) && v > 0 ? Math.min(v, spec.risk.maxWeight) : 0;
    sum += out[m];
  }
  if (sum > spec.risk.maxWeight + 1e-12) for (const m of spec.markets) out[m] = (out[m] * spec.risk.maxWeight) / sum;
  return out;
}

const pctText = (v: number) => `${+(v * 100).toFixed(2)} %`;
const coin = (m: string) => m.split('-')[0];
const intervalText: Record<Interval, string> = {
  '1m': '1-minute', '5m': '5-minute', '15m': '15-minute', '30m': '30-minute', '1h': 'hourly', '2h': '2-hour',
  '4h': '4-hour', '6h': '6-hour', '8h': '8-hour', '12h': '12-hour', '1d': 'daily', '1W': 'weekly',
};

/** One plain-language paragraph for the dashboard. */
export function explainStrategy(specInput: StrategySpec): string {
  let spec: StrategySpec;
  try {
    spec = validateSpec(specInput);
  } catch (err) {
    return `This strategy cannot run: ${(err as Error).message}`;
  }
  const p = spec.params;
  const c = coin(spec.markets[0]);
  const bars = `${intervalText[spec.interval]} candles`;
  const parts: string[] = [];
  switch (spec.family) {
    case 'ema_cross':
      parts.push(`Looks at ${c} on ${bars} and holds ${c} while the ${p.fast}-bar average price (EMA) is above the ${p.slow}-bar average, which means the price is trending up; when the fast average drops under the slow one it sells and waits in euros.`);
      break;
    case 'macd_trend':
      parts.push(`Looks at ${c} on ${bars} and holds ${c} while the MACD line (${p.fast}-bar minus ${p.slow}-bar EMA) is above its ${p.signal}-bar signal line${p.requirePositive ? ' and above zero' : ''}; otherwise it waits in euros.`);
      break;
    case 'donchian_breakout':
      parts.push(`Looks at ${c} on ${bars}, buys when a candle closes above the highest price of the previous ${p.entry} candles and sells when one closes below the lowest price of the previous ${p.exit} candles.`);
      break;
    case 'rsi_dip':
      parts.push(`Looks at ${c} on ${bars}, buys when the ${p.period}-bar RSI falls under ${p.buyBelow} (the coin looks oversold)${Number(p.trendSma) > 0 ? `, but only while the price is above its ${p.trendSma}-bar average,` : ''} and sells when the RSI climbs above ${p.sellAbove}.`);
      break;
    case 'bollinger_reversion':
      parts.push(`Looks at ${c} on ${bars}, buys when the price closes under the lower Bollinger band (${p.period}-bar average minus ${p.stdDev} standard deviations) and sells when it closes above the ${p.exitAt === 'upper' ? 'upper band' : 'middle band (the average)'}.`);
      break;
    case 'dca_dip':
      parts.push(`Buys ${c} in ${p.tranches} equal slices, one every ${p.everyBars} ${bars.replace(' candles', ' bars')}; when the price falls ${pctText(Number(p.dipPct))} below its ${p.lookback}-bar high it buys an extra slice, and when the price is ${pctText(Number(p.takeProfitPct))} above the average entry it sells ${pctText(Number(p.sellFraction))} of the position.`);
      break;
    case 'rotation_momentum':
      parts.push(`Every ${intervalText[spec.interval]} candle it ranks ${spec.markets.length} coins (${spec.markets.map(coin).join(', ')}) by their return over the last ${p.lookback} candles and holds the best ${p.top} in equal parts, but only coins that actually went up${Number(p.regimeSma) > 0 ? ` and only while BTC is above its ${p.regimeSma}-bar average` : ''}; the rest stays in euros.`);
      break;
  }
  const r = spec.risk;
  parts.push(r.maxWeight < 1 ? `At most ${pctText(r.maxWeight)} of the portfolio is ever in coins.` : 'It may put the whole portfolio into coins.');
  const stops: string[] = [];
  if (r.stopLossPct) stops.push(`sells everything ${pctText(r.stopLossPct)} under the average entry`);
  if (r.trailingStopPct) stops.push(`sells after a ${pctText(r.trailingStopPct)} fall from the highest price since buying`);
  if (r.takeProfitPct) stops.push(`takes profit ${pctText(r.takeProfitPct)} above the average entry`);
  if (stops.length) parts.push(`Safety exits: it ${stops.join(', ')}.`);
  const e = spec.execution;
  parts.push(
    e.orderType === 'market'
      ? 'Orders are market orders, which fill immediately but pay the higher taker fee.'
      : `Orders are limit orders ${e.limitOffsetBps ? `${e.limitOffsetBps / 100} % better than the last close` : 'at the last close'}${e.postOnly ? ' that only ever pay the lower maker fee' : ''}; an order that has not filled after ${e.timeoutBars} candle${e.timeoutBars === 1 ? '' : 's'} is ${e.fallback === 'market' ? 'replaced by a market order' : 'cancelled'}.`,
  );
  return parts.join(' ');
}
