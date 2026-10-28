import { ema, macd, priorMax, priorMin, rollingMax, rsi, sma, stdPop } from './indicators.js';
import type { Candle, CandlesByMarket, FamilyInfo, FamilyName, ParamInfo, StrategySpec, StrategyState, Weights } from './types.js';

/**
 * The v1 families (SPEC §3). Each one turns closed candles into a target weight per bar:
 * `run(candles, spec, state) -> [[t, { market: weight }], ...]`, oldest first, one entry per bar of the input.
 * Everything here is deterministic and depends only on the candles passed in (and `state.startTime` for dca_dip).
 *
 * Shared rules:
 * - "In" means weight = risk.maxWeight; "out" means 0. Bars where indicators are not defined yet are "out".
 * - Comparisons are strict (">" / "<") exactly as written below.
 */

export type FamilyRun = (candles: CandlesByMarket, spec: StrategySpec, state?: StrategyState) => Array<[number, Weights]>;

/** Sorted by time, duplicates removed (last one wins), values coerced to numbers. */
export function cleanCandles(raw: Candle[] | undefined): Candle[] {
  if (!raw?.length) return [];
  const byT = new Map<number, Candle>();
  for (const c of raw) {
    const row = c.map(Number) as Candle;
    if (row.length < 5 || !row.slice(0, 5).every(Number.isFinite)) continue;
    byT.set(row[0], row);
  }
  return [...byT.values()].sort((a, b) => a[0] - b[0]);
}

const num = (spec: StrategySpec, name: string) => Number(spec.params[name]);

function single(
  candles: CandlesByMarket,
  spec: StrategySpec,
  decide: (cs: Candle[], closes: number[]) => boolean[] | number[],
): Array<[number, Weights]> {
  const market = spec.markets[0];
  const cs = cleanCandles(candles[market]);
  const closes = cs.map((c) => c[4]);
  const raw = decide(cs, closes);
  return cs.map((c, i) => {
    const v = raw[i];
    const w = typeof v === 'boolean' ? (v ? spec.risk.maxWeight : 0) : v;
    return [c[0], { [market]: w }];
  });
}

/** Long while EMA(fast) > EMA(slow). */
const emaCross: FamilyRun = (candles, spec) =>
  single(candles, spec, (_cs, closes) => {
    const f = ema(closes, num(spec, 'fast'));
    const s = ema(closes, num(spec, 'slow'));
    return closes.map((_, i) => Number.isFinite(f[i]) && Number.isFinite(s[i]) && f[i] > s[i]);
  });

/** Long while MACD > signal, and with requirePositive also MACD > 0. */
const macdTrend: FamilyRun = (candles, spec) =>
  single(candles, spec, (_cs, closes) => {
    const m = macd(closes, num(spec, 'fast'), num(spec, 'slow'), num(spec, 'signal'));
    const needPos = spec.params.requirePositive === true;
    return closes.map(
      (_, i) =>
        Number.isFinite(m.line[i]) &&
        Number.isFinite(m.signal[i]) &&
        m.line[i] > m.signal[i] &&
        (!needPos || m.line[i] > 0),
    );
  });

/**
 * Out → in when close > highest high of the `entry` bars before this one.
 * In → out when close < lowest low of the `exit` bars before this one.
 */
const donchian: FamilyRun = (candles, spec) =>
  single(candles, spec, (cs, closes) => {
    const up = priorMax(cs.map((c) => c[2]), num(spec, 'entry'));
    const dn = priorMin(cs.map((c) => c[3]), num(spec, 'exit'));
    let held = false;
    return closes.map((c, i) => {
      if (!held && Number.isFinite(up[i]) && c > up[i]) held = true;
      else if (held && Number.isFinite(dn[i]) && c < dn[i]) held = false;
      return held;
    });
  });

/**
 * Out → in when RSI < buyBelow (and, with trendSma > 0, close > SMA(trendSma)).
 * In → out when RSI > sellAbove. The trend filter only gates entries.
 */
const rsiDip: FamilyRun = (candles, spec) =>
  single(candles, spec, (_cs, closes) => {
    const r = rsi(closes, num(spec, 'period'));
    const trendN = num(spec, 'trendSma');
    const trend = trendN > 0 ? sma(closes, trendN) : null;
    const buyBelow = num(spec, 'buyBelow');
    const sellAbove = num(spec, 'sellAbove');
    let held = false;
    return closes.map((c, i) => {
      if (!Number.isFinite(r[i])) return held;
      if (!held) {
        const trendOk = !trend || (Number.isFinite(trend[i]) && c > trend[i]);
        if (r[i] < buyBelow && trendOk) held = true;
      } else if (r[i] > sellAbove) held = false;
      return held;
    });
  });

/**
 * Bands: mid = SMA(period), lower/upper = mid ∓ stdDev·(population std).
 * Out → in when close < lower. In → out when close > mid (exitAt "middle") or close > upper (exitAt "upper").
 */
const bollinger: FamilyRun = (candles, spec) =>
  single(candles, spec, (_cs, closes) => {
    const n = num(spec, 'period');
    const k = num(spec, 'stdDev');
    const mid = sma(closes, n);
    const sd = stdPop(closes, n);
    const exitUpper = spec.params.exitAt === 'upper';
    let held = false;
    return closes.map((c, i) => {
      if (!Number.isFinite(mid[i])) return held;
      const lower = mid[i] - k * sd[i];
      const upper = mid[i] + k * sd[i];
      if (!held && c < lower) held = true;
      else if (held && c > (exitUpper ? upper : mid[i])) held = false;
      return held;
    });
  });

/**
 * DCA with dip buys and partial take profit, run on a virtual fee-free portfolio of 1 unit of cash that starts at
 * the anchor bar a (first bar with t >= state.startTime, else the first bar). For each bar i >= a, k = i - a,
 * close c, tranche = 1/tranches:
 *  1. Take profit: if coins > 0 and c >= avgEntry*(1+takeProfitPct): sell sellFraction of the coins at c
 *     (cost basis shrinks by the same fraction, avgEntry stays) and buy nothing this bar.
 *  2. Otherwise buy = 0; if k % everyBars == 0 and fewer than `tranches` scheduled buys happened: buy += tranche.
 *     dip = c <= (highest high of bars i-lookback+1..i)*(1-dipPct). If dip and armed: buy += tranche, armed = false.
 *     Spend min(buy, cash) at c.
 *  3. Whenever not dip: armed = true (armed starts true). A take-profit bar still updates "armed" this way.
 * weight = maxWeight · coins·c / (cash + coins·c). Bars before the anchor have weight 0.
 */
const dcaDip: FamilyRun = (candles, spec, state) =>
  single(candles, spec, (cs, closes) => {
    const every = num(spec, 'everyBars');
    const tranches = num(spec, 'tranches');
    const dipPct = num(spec, 'dipPct');
    const tp = num(spec, 'takeProfitPct');
    const sellFraction = num(spec, 'sellFraction');
    const hi = rollingMax(cs.map((c) => c[2]), num(spec, 'lookback'));
    let anchor = 0;
    if (state?.startTime !== undefined) {
      anchor = cs.findIndex((c) => c[0] >= state.startTime!);
      if (anchor < 0) anchor = cs.length;
    }
    const tranche = 1 / tranches;
    let cash = 1;
    let coins = 0;
    let cost = 0;
    let scheduled = 0;
    let armed = true;
    return closes.map((c, i) => {
      if (i < anchor) return 0;
      const k = i - anchor;
      const dip = Number.isFinite(hi[i]) && c <= hi[i] * (1 - dipPct);
      const tpHit = coins > 0 && c >= (cost / coins) * (1 + tp);
      if (tpHit) {
        if (sellFraction >= 1) {
          cash += coins * c;
          coins = 0;
          cost = 0;
        } else {
          const q = coins * sellFraction;
          cash += q * c;
          coins -= q;
          cost -= cost * sellFraction;
        }
      } else {
        let buy = 0;
        if (k % every === 0 && scheduled < tranches) {
          buy += tranche;
          scheduled++;
        }
        if (dip && armed) {
          buy += tranche;
          armed = false;
        }
        const spend = Math.min(buy, cash);
        if (spend > 1e-12) {
          coins += spend / c;
          cost += spend;
          cash -= spend;
        }
      }
      if (!dip) armed = true;
      const value = coins * c;
      const total = cash + value;
      return total > 0 ? spec.risk.maxWeight * (value / total) : 0;
    });
  });

export const REGIME_MARKET = 'BTC-EUR';

/**
 * Each bar t of the union of all timestamps: for every market in spec.markets with a candle at t and at least
 * `lookback` earlier candles in its own series, ret = close[idx]/close[idx-lookback] - 1. Markets with ret > 0 are
 * ranked by ret (desc; ties by market name asc) and the best `top` get maxWeight/top each (unused slots stay cash).
 * With regimeSma > 0 everything is cash unless BTC-EUR has a candle at t with close > SMA(regimeSma) of its closes.
 */
const rotation: FamilyRun = (candles, spec) => {
  const lookback = num(spec, 'lookback');
  const top = num(spec, 'top');
  const regimeN = num(spec, 'regimeSma');
  const series = new Map<string, { idx: Map<number, number>; closes: number[] }>();
  const load = (m: string) => {
    if (series.has(m)) return;
    const cs = cleanCandles(candles[m]);
    series.set(m, { idx: new Map(cs.map((c, i) => [c[0], i])), closes: cs.map((c) => c[4]) });
  };
  for (const m of spec.markets) load(m);
  if (regimeN > 0) load(REGIME_MARKET);
  const regime = series.get(REGIME_MARKET);
  const regimeSma = regimeN > 0 && regime ? sma(regime.closes, regimeN) : null;
  const times = new Set<number>();
  for (const m of spec.markets) for (const t of series.get(m)!.idx.keys()) times.add(t);
  const sorted = [...times].sort((a, b) => a - b);
  const w = spec.risk.maxWeight / top;
  return sorted.map((t) => {
    const out: Weights = Object.fromEntries(spec.markets.map((m) => [m, 0]));
    if (regimeN > 0) {
      const ri = regime?.idx.get(t);
      if (ri === undefined || !regimeSma || !Number.isFinite(regimeSma[ri]) || !(regime!.closes[ri] > regimeSma[ri]))
        return [t, out];
    }
    const ranked: Array<[string, number]> = [];
    for (const m of spec.markets) {
      const s = series.get(m)!;
      const i = s.idx.get(t);
      if (i === undefined || i < lookback) continue;
      const ret = s.closes[i] / s.closes[i - lookback] - 1;
      if (ret > 0) ranked.push([m, ret]);
    }
    ranked.sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [m] of ranked.slice(0, top)) out[m] = w;
    return [t, out];
  });
};

/** alt_froth's signal-only pool: altcoins already listed on Bitvavo in 2019 (no hindsight in the list). Never traded. */
export const ALT_FROTH_POOL = ['XRP-EUR', 'ADA-EUR', 'LINK-EUR', 'TRX-EUR', 'LTC-EUR', 'BCH-EUR', 'XLM-EUR', 'XTZ-EUR', 'MIOTA-EUR'];
export const ALT_FROTH_BTC = 'BTC-EUR';
const ALT_FROTH_MIN_POOL = 3;

/**
 * "As of" lookup: for every time in `times` (ascending), the value of the last candle of `cs` whose open time is
 * <= that time (NaN before the first candle). `cs` is sorted by time.
 */
function asOf(cs: Candle[], values: number[], times: number[]): number[] {
  const out = new Array<number>(times.length).fill(NaN);
  let j = -1;
  for (let i = 0; i < times.length; i++) {
    while (j + 1 < cs.length && cs[j + 1][0] <= times[i]) j++;
    if (j >= 0) out[i] = values[j];
  }
  return out;
}

/** log(close[i]) - log(close[i-n]) on the market's own series; NaN for the first n candles. */
function logReturn(cs: Candle[], n: number): number[] {
  const lc = cs.map((c) => Math.log(c[4]));
  return lc.map((v, i) => (i >= n ? v - lc[i - n] : NaN));
}

/** Cleaned candles of the traded markets and the sorted union of their open times (the bars a family decides on). */
function unionTimes(candles: CandlesByMarket, markets: string[]): { own: Map<string, Candle[]>; idx: number[] } {
  const own = new Map(markets.map((m) => [m, cleanCandles(candles[m])]));
  const times = new Set<number>();
  for (const cs of own.values()) for (const c of cs) times.add(c[0]);
  return { own, idx: [...times].sort((a, b) => a - b) };
}

/**
 * alt_froth's spread on `idx`: mean `lookback` log return of the ALT_FROTH_POOL markets defined as of t (NaN with
 * fewer than 3) minus BTC-EUR's `lookback` log return as of t (NaN without BTC).
 */
function frothSpread(candles: CandlesByMarket, lookback: number, idx: number[]): number[] {
  const n = idx.length;
  const tot = new Array<number>(n).fill(0);
  const cnt = new Array<number>(n).fill(0);
  for (const m of ALT_FROTH_POOL) {
    const cs = cleanCandles(candles[m]);
    if (!cs.length) continue;
    const r = asOf(cs, logReturn(cs, lookback), idx);
    for (let i = 0; i < n; i++)
      if (Number.isFinite(r[i])) {
        tot[i] += r[i];
        cnt[i]++;
      }
  }
  const btcCs = cleanCandles(candles[ALT_FROTH_BTC]);
  const btc = btcCs.length ? asOf(btcCs, logReturn(btcCs, lookback), idx) : new Array<number>(n).fill(NaN);
  return idx.map((_, i) => (cnt[i] >= ALT_FROTH_MIN_POOL ? tot[i] / cnt[i] - btc[i] : NaN));
}

/**
 * Bars = union of the open times of spec.markets. froth[t] = mean `lookback` log return of the ALT_FROTH_POOL markets
 * that have a defined return as of t (each on its own series, "as of" t; NaN with fewer than 3 of them) minus BTC-EUR's
 * `lookback` log return as of t. One shared state, starting "in": when froth is defined, in -> out when froth >
 * threshold; out -> in when froth < threshold - band and at least `minOut` defined bars have passed since the exit.
 * Weight per market = maxWeight / markets.length while in, times (with trendSma > 0) [close > SMA(trendSma)] of that
 * market as of t; 0 while out, before the market's first candle, or while the signal is undefined.
 */
const altFroth: FamilyRun = (candles, spec) => {
  const lookback = num(spec, 'lookback');
  const thr = num(spec, 'threshold');
  const band = num(spec, 'band');
  const minOut = num(spec, 'minOut');
  const tsma = num(spec, 'trendSma');
  const { own, idx } = unionTimes(candles, spec.markets);
  const n = idx.length;
  const sp = frothSpread(candles, lookback, idx);
  const state = new Array<number>(n).fill(NaN);
  let out = false;
  let since = 0;
  for (let i = 0; i < n; i++) {
    const s = sp[i];
    if (!Number.isFinite(s)) continue;
    if (out) {
      since++;
      if (s < thr - band && since >= minOut) out = false;
    } else if (s > thr) {
      out = true;
      since = 0;
    }
    state[i] = out ? 0 : 1;
  }
  const each = spec.risk.maxWeight / spec.markets.length;
  const trend = new Map<string, number[]>();
  for (const [m, cs] of own) {
    let ok: number[];
    if (tsma > 0) {
      const closes = cs.map((c) => c[4]);
      const s = sma(closes, tsma);
      ok = closes.map((c, i) => (Number.isFinite(s[i]) ? (c > s[i] ? 1 : 0) : NaN));
    } else ok = cs.map(() => 1);
    trend.set(m, asOf(cs, ok, idx));
  }
  return idx.map((t, i) => {
    const w: Weights = {};
    for (const m of spec.markets) {
      const v = state[i] * trend.get(m)![i] * each;
      w[m] = Number.isFinite(v) ? v : 0;
    }
    return [t, w];
  });
};

/** froth_dip's signal-only panic pool: BTC, ETH and the 2019 altcoins (no hindsight in the list). */
export const FROTH_DIP_POOL = ['BTC-EUR', 'ETH-EUR', ...ALT_FROTH_POOL];

/** Weights per bar (rows) and market (columns in `markets` order), NaN on bars before the first decision. */
type Matrix = number[][];

function toSeries(idx: number[], markets: string[], W: Matrix): Array<[number, Weights]> {
  return idx.map((t, i) => {
    const w: Weights = {};
    markets.forEach((m, j) => (w[m] = Number.isFinite(W[i][j]) ? W[i][j] : 0));
    return [t, w];
  });
}

/** Like the lab's tail: NaN before the first bar where every column is defined, undefined values 0 after it. */
function fromFirstGood(cols: number[][], n: number): Matrix {
  let first = n;
  for (let i = 0; i < n; i++)
    if (cols.every((c) => Number.isFinite(c[i]))) {
      first = i;
      break;
    }
  return Array.from({ length: n }, (_, i) => cols.map((c) => (i < first ? NaN : Number.isFinite(c[i]) ? c[i] : 0)));
}

export interface FrothDipParams {
  coreSma: number;
  rsiPeriod: number;
  rsiBelow: number;
  breadthMin: number;
  sellAbove: number;
  maxHold: number;
  frothLook: number;
  frothThr: number;
  frothBand: number;
}

/**
 * froth_dip on the union bars `idx` of `markets` (each market gets maxWeight/markets.length while on):
 *  - panic[t] = at least breadthMin (-1e-12) of the FROTH_DIP_POOL markets defined as of t have RSI(rsiPeriod) <
 *    rsiBelow (each on its own series, as of t); undefined with fewer than 3 defined pool markets.
 *  - froth[t] = alt_froth's spread with lookback frothLook: in -> out when > frothThr, back when < frothThr - frothBand
 *    (undefined while the spread is; frothThr 0 = never froth).
 *  - per market: core = close > SMA(coreSma) as of t (coreSma 0 = 1 from the first candle); RSI as of t. On bars where
 *    panic, RSI, core and froth are all defined: not in a dip trade -> start one when panic (held = 0); in one ->
 *    held += 1 and end it when RSI > sellAbove or (maxHold > 0 and held >= maxHold). On = (dip trade or core) and not
 *    froth.
 */
function frothDipMatrix(candles: CandlesByMarket, markets: string[], p: FrothDipParams, maxWeight: number, idx: number[]): Matrix {
  const n = idx.length;
  const low = new Array<number>(n).fill(0);
  const defined = new Array<number>(n).fill(0);
  for (const m of FROTH_DIP_POOL) {
    const cs = cleanCandles(candles[m]);
    if (!cs.length) continue;
    const r = rsi(cs.map((c) => c[4]), p.rsiPeriod);
    const f = asOf(cs, r.map((v) => (Number.isFinite(v) ? (v < p.rsiBelow ? 1 : 0) : NaN)), idx);
    for (let i = 0; i < n; i++)
      if (Number.isFinite(f[i])) {
        low[i] += f[i];
        defined[i]++;
      }
  }
  const panic = idx.map((_, i) =>
    defined[i] >= ALT_FROTH_MIN_POOL ? (low[i] / defined[i] >= p.breadthMin - 1e-12 ? 1 : 0) : NaN,
  );
  let froth: number[];
  if (p.frothThr <= 0) froth = new Array<number>(n).fill(0);
  else {
    const sp = frothSpread(candles, p.frothLook, idx);
    const lo = p.frothThr - p.frothBand;
    froth = new Array<number>(n).fill(NaN);
    let inside = false;
    for (let i = 0; i < n; i++) {
      const s = sp[i];
      if (Number.isNaN(s)) continue;
      if (inside) {
        if (s < lo) inside = false;
      } else if (s > p.frothThr) inside = true;
      froth[i] = inside ? 1 : 0;
    }
  }
  const each = maxWeight / markets.length;
  const cols = markets.map((m) => {
    const cs = cleanCandles(candles[m]);
    const closes = cs.map((c) => c[4]);
    const r = asOf(cs, rsi(closes, p.rsiPeriod), idx);
    let coreRaw: number[];
    if (p.coreSma) {
      const s = sma(closes, p.coreSma);
      coreRaw = closes.map((c, i) => (Number.isFinite(s[i]) ? (c > s[i] ? 1 : 0) : NaN));
    } else coreRaw = closes.map(() => 1);
    const core = asOf(cs, coreRaw, idx);
    const w = new Array<number>(n).fill(NaN);
    let inside = false;
    let held = 0;
    for (let i = 0; i < n; i++) {
      if (!(Number.isFinite(panic[i]) && Number.isFinite(r[i]) && Number.isFinite(core[i]) && Number.isFinite(froth[i]))) continue;
      if (!inside) {
        if (panic[i] === 1) {
          inside = true;
          held = 0;
        }
      } else {
        held++;
        if (r[i] > p.sellAbove || (p.maxHold && held >= p.maxHold)) inside = false;
      }
      w[i] = (inside || core[i] === 1) && froth[i] === 0 ? each : 0;
    }
    return w;
  });
  return fromFirstGood(cols, n);
}

const FROTH_DIP_KNOBS = ['coreSma', 'rsiPeriod', 'rsiBelow', 'breadthMin', 'sellAbove', 'maxHold', 'frothLook', 'frothThr', 'frothBand'] as const;
const frothDipParams = (spec: StrategySpec): FrothDipParams =>
  Object.fromEntries(FROTH_DIP_KNOBS.map((k) => [k, num(spec, k)])) as unknown as FrothDipParams;

/** froth_dip: trend core + market-wide panic buys + alt-froth exit (see frothDipMatrix). */
const frothDip: FamilyRun = (candles, spec) => {
  const { idx } = unionTimes(candles, spec.markets);
  return toSeries(idx, spec.markets, frothDipMatrix(candles, spec.markets, frothDipParams(spec), spec.risk.maxWeight, idx));
};

export const runners: Record<FamilyName, FamilyRun> = {
  ema_cross: emaCross,
  macd_trend: macdTrend,
  donchian_breakout: donchian,
  rsi_dip: rsiDip,
  bollinger_reversion: bollinger,
  dca_dip: dcaDip,
  rotation_momentum: rotation,
  alt_froth: altFroth,
  froth_dip: frothDip,
};

const FROTH_DIP_PARAMS: ParamInfo[] = [
  { name: 'coreSma', type: 'int', default: 132, min: 0, max: 600, description: 'Hold while the close is above this SMA (20 or more); 0 = always hold unless froth.' },
  { name: 'rsiPeriod', type: 'int', default: 12, min: 4, max: 40, description: 'RSI length in candles.' },
  { name: 'rsiBelow', type: 'number', default: 36.5, min: 15, max: 45, description: 'A pool coin counts as oversold while its RSI is under this.' },
  { name: 'breadthMin', type: 'number', default: 0.85, min: 0.4, max: 1, description: 'Panic buy when at least this fraction of the 2019 coin pool is oversold at once.' },
  { name: 'sellAbove', type: 'number', default: 85, min: 50, max: 95, description: "End the dip trade when the coin's own RSI rises over this." },
  { name: 'maxHold', type: 'int', default: 97, min: 0, max: 500, description: 'End the dip trade after this many candles at the latest (5 or more); 0 = no limit.' },
  { name: 'frothLook', type: 'int', default: 120, min: 20, max: 400, description: "Candles over which the old altcoins' return is compared with Bitcoin's." },
  { name: 'frothThr', type: 'number', default: 0.1, min: 0, max: 0.6, description: 'Step aside while the old altcoins beat Bitcoin by more than this log return (0.02 or more); 0 = froth exit off.' },
  { name: 'frothBand', type: 'number', default: 0.05, min: 0, max: 0.3, description: "Back in once the altcoins' lead is under the threshold minus this." },
];

export const families: FamilyInfo[] = [
  {
    family: 'ema_cross',
    title: 'EMA crossover',
    summary: 'Trend following: holds the coin while the fast moving average is above the slow one.',
    version: 1,
    multiMarket: false,
    params: [
      { name: 'fast', type: 'int', default: 12, min: 2, max: 500, description: 'Bars in the fast EMA.' },
      { name: 'slow', type: 'int', default: 48, min: 3, max: 1000, description: 'Bars in the slow EMA (must be larger than fast).' },
    ],
  },
  {
    family: 'macd_trend',
    title: 'MACD trend',
    summary: 'Trend following: holds the coin while the MACD line is above its signal line.',
    version: 1,
    multiMarket: false,
    params: [
      { name: 'fast', type: 'int', default: 12, min: 2, max: 200, description: 'Bars in the fast EMA.' },
      { name: 'slow', type: 'int', default: 26, min: 3, max: 500, description: 'Bars in the slow EMA (must be larger than fast).' },
      { name: 'signal', type: 'int', default: 9, min: 2, max: 200, description: 'Bars in the EMA of the MACD line.' },
      { name: 'requirePositive', type: 'boolean', default: false, description: 'Only hold while MACD is also above zero.' },
    ],
  },
  {
    family: 'donchian_breakout',
    title: 'Donchian breakout',
    summary: 'Trend following: buys when the close breaks above the recent high, sells when it breaks below the recent low.',
    version: 1,
    multiMarket: false,
    params: [
      { name: 'entry', type: 'int', default: 20, min: 2, max: 500, description: 'Buy when the close is above the highest high of this many previous bars.' },
      { name: 'exit', type: 'int', default: 10, min: 2, max: 500, description: 'Sell when the close is below the lowest low of this many previous bars.' },
    ],
  },
  {
    family: 'rsi_dip',
    title: 'RSI dip buyer',
    summary: 'Buys when the RSI says the coin is oversold and sells once it is overbought, optionally only in an uptrend.',
    version: 1,
    multiMarket: false,
    params: [
      { name: 'period', type: 'int', default: 14, min: 2, max: 100, description: 'Bars in the RSI (Wilder smoothing).' },
      { name: 'buyBelow', type: 'number', default: 30, min: 1, max: 99, description: 'Buy when RSI drops under this.' },
      { name: 'sellAbove', type: 'number', default: 70, min: 1, max: 99, description: 'Sell when RSI rises above this.' },
      { name: 'trendSma', type: 'int', default: 0, min: 0, max: 1000, description: 'Only buy while the close is above this SMA; 0 turns the filter off.' },
    ],
  },
  {
    family: 'bollinger_reversion',
    title: 'Bollinger reversion',
    summary: 'Buys when the price falls under the lower Bollinger band and sells when it returns to the middle or upper band.',
    version: 1,
    multiMarket: false,
    params: [
      { name: 'period', type: 'int', default: 20, min: 2, max: 500, description: 'Bars in the moving average and standard deviation.' },
      { name: 'stdDev', type: 'number', default: 2, min: 0.5, max: 5, description: 'Band width in standard deviations.' },
      { name: 'exitAt', type: 'enum', default: 'middle', options: ['middle', 'upper'], description: 'Sell at the middle band or at the upper band.' },
    ],
  },
  {
    family: 'dca_dip',
    title: 'DCA with dip buys',
    summary: 'Buys in equal slices on a schedule, adds a slice on big dips and takes partial profit when far above the average entry.',
    version: 1,
    multiMarket: false,
    params: [
      { name: 'everyBars', type: 'int', default: 6, min: 1, max: 1000, description: 'Bars between scheduled buys.' },
      { name: 'tranches', type: 'int', default: 10, min: 1, max: 200, description: 'Number of equal slices the starting cash is split into.' },
      { name: 'dipPct', type: 'number', default: 0.1, min: 0.005, max: 0.9, description: 'A fall of this fraction from the recent high buys an extra slice.' },
      { name: 'lookback', type: 'int', default: 30, min: 2, max: 1000, description: 'Bars that define the recent high.' },
      { name: 'takeProfitPct', type: 'number', default: 0.2, min: 0.005, max: 10, description: 'Take profit this fraction above the average entry.' },
      { name: 'sellFraction', type: 'number', default: 0.5, min: 0.01, max: 1, description: 'Part of the position sold at take profit.' },
    ],
  },
  {
    family: 'rotation_momentum',
    title: 'Momentum rotation',
    summary: 'Holds the strongest coins of a basket by recent return, spread equally, and sits in cash when nothing is rising.',
    version: 1,
    multiMarket: true,
    params: [
      { name: 'lookback', type: 'int', default: 30, min: 2, max: 1000, description: 'Bars over which the return is measured.' },
      { name: 'top', type: 'int', default: 3, min: 1, max: 10, description: 'How many of the best coins to hold.' },
      { name: 'regimeSma', type: 'int', default: 0, min: 0, max: 1000, description: 'Only hold coins while BTC is above this SMA; 0 turns the filter off.' },
    ],
  },
  {
    family: 'alt_froth',
    title: 'Altcoin froth exit',
    summary: 'Holds the coin, but sells while old altcoins race far ahead of Bitcoin (a sign of a frothy top) and buys back once they cool off.',
    version: 1,
    multiMarket: true,
    params: [
      { name: 'lookback', type: 'int', default: 90, min: 5, max: 400, description: "Candles over which the old altcoins' return is compared with Bitcoin's." },
      { name: 'threshold', type: 'number', default: 0.25, min: 0, max: 1, description: 'Sell when the old altcoins beat Bitcoin by more than this log return (0.1 is about 10.5 %).' },
      { name: 'band', type: 'number', default: 0.1, min: 0, max: 0.5, description: 'Buy back once their lead is under threshold minus this.' },
      { name: 'minOut', type: 'int', default: 0, min: 0, max: 400, description: 'Stay out at least this many candles after a froth exit; 0 = no minimum.' },
      { name: 'trendSma', type: 'int', default: 0, min: 0, max: 600, description: 'Also stay out of a coin while it is under this SMA (10 or more); 0 turns the filter off.' },
    ],
  },
  {
    family: 'froth_dip',
    title: 'Trend core, panic buys and froth exits',
    summary: 'Rides the uptrend above a moving average, buys market-wide panic sell-offs, and steps aside while old altcoins race far ahead of Bitcoin.',
    version: 1,
    multiMarket: true,
    params: FROTH_DIP_PARAMS,
  },
];
