// Dev-only fake data for every endpoint. Deterministic (seeded) so screenshots are stable.
import type {
  Benchmark,
  BotSettings,
  CompareRange,
  FamilyInfo,
  Fill,
  HealthComponent,
  HealthDetail,
  Interval,
  LogLevel,
  LogRow,
  MarketInfo,
  Mode,
  Order,
  ResearchBucket,
  ResearchEntry,
  ResearchPayload,
  Series,
  StrategySpec,
  TrackingData,
} from '../types';

export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
};

const DAY = 86400_000;

// ---------- synthetic price paths (test period 2024-07-01 → 2026-10-25, one point per 3 days) ----------
const TEST_START = Date.UTC(2024, 6, 1);
const TEST_END = Date.UTC(2026, 9, 25);
const STEP = 3 * DAY;
const N = Math.floor((TEST_END - TEST_START) / STEP) + 1;
const times = Array.from({ length: N }, (_, i) => TEST_START + i * STEP);

function path(seed: number, start: number, drift: number, vol: number, regimes: [number, number][]) {
  const r = rng(seed);
  const out = [start];
  for (let i = 1; i < N; i++) {
    const t = i / N;
    const reg = regimes.find(([a]) => t < a)?.[1] ?? 0;
    out.push(out[i - 1] * Math.exp(drift + reg + vol * gauss(r)));
  }
  return out;
}

// BTC: strong run, a deep mid-period slump, recovery. ETH: choppier and weaker.
const regimesBtc: [number, number][] = [
  [0.18, 0.002],
  [0.42, 0.008],
  [0.62, -0.007],
  [0.85, 0.005],
  [1.01, 0.001],
];
const btc = path(11, 56_000, 0.0, 0.04, regimesBtc);
const eth = path(23, 3_100, -0.001, 0.06, regimesBtc.map(([a, d]) => [a, d * 1.1] as [number, number]));
const alts = Array.from({ length: 8 }, (_, k) => path(100 + k, 1, -0.002, 0.075, regimesBtc.map(([a, d]) => [a, d * 1.3] as [number, number])));

const toSeries = (eq: number[]): Series => eq.map((v, i) => [times[i], Math.round(v * 100) / 100]);
const buyHold = (p: number[], start = 1000) => p.map((v) => (start * v) / p[0]);

const ema = (p: number[], n: number) => {
  const out: number[] = [];
  const a = 2 / (n + 1);
  p.forEach((v, i) => out.push(i === 0 ? v : a * v + (1 - a) * out[i - 1]));
  return out;
};

/** Run a weights-per-bar strategy over one price path with fees; returns equity and trade stats. */
function simulate(prices: number[][], weightsAt: (i: number) => number[], fee = 0.0015) {
  let cash = 1000;
  const units = prices.map(() => 0);
  const eq: number[] = [];
  let trades = 0;
  let wins = 0;
  let fees = 0;
  const entry = prices.map(() => 0);
  for (let i = 0; i < N; i++) {
    const total = cash + units.reduce((s, u, k) => s + u * prices[k][i], 0);
    const w = weightsAt(i);
    prices.forEach((p, k) => {
      const want = (total * (w[k] ?? 0)) / p[i];
      const diff = want - units[k];
      if (Math.abs(diff * p[i]) < Math.max(5, total * 0.02)) return;
      const value = Math.abs(diff * p[i]);
      const f = value * fee;
      fees += f;
      trades++;
      if (diff > 0) {
        entry[k] = p[i];
        cash -= value + f;
      } else {
        if (p[i] > entry[k]) wins++;
        cash += value - f;
      }
      units[k] = want;
    });
    eq.push(cash + units.reduce((s, u, k) => s + u * prices[k][i], 0));
  }
  return { eq, trades, wins, fees };
}

function metrics(eq: number[], bh: number[], trades: number, wins: number, fees: number, exposure: number) {
  const final = eq[eq.length - 1];
  let peak = eq[0];
  let mdd = 0;
  const rets: number[] = [];
  eq.forEach((v, i) => {
    peak = Math.max(peak, v);
    mdd = Math.max(mdd, (peak - v) / peak);
    if (i) rets.push(v / eq[i - 1] - 1);
  });
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const years = (TEST_END - TEST_START) / (365 * DAY);
  const ret = (final / 1000 - 1) * 100;
  const bhRet = (bh[bh.length - 1] / 1000 - 1) * 100;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    finalEur: r2(final),
    returnPct: r2(ret),
    cagrPct: r2(((final / 1000) ** (1 / years) - 1) * 100),
    maxDrawdownPct: r2(mdd * 100),
    sharpe: r2((mean / (sd || 1)) * Math.sqrt(365 / 3)),
    trades,
    winRatePct: r2(trades ? (wins / Math.max(1, trades / 2)) * 100 : 0),
    feesEur: r2(fees),
    exposurePct: r2(exposure),
    vsBuyHoldPct: r2(ret - bhRet),
    trainReturnPct: r2(ret * 1.35 + 22),
    testPeriod: ['2024-07-01', '2026-10-25'] as [string, string],
  };
}

const baseRisk = { maxWeight: 1, stopLossPct: null, takeProfitPct: null, trailingStopPct: null };
const baseExec = { orderType: 'limit' as const, limitOffsetBps: 5, postOnly: true, timeoutBars: 1, fallback: 'cancel' as const };

function entry(
  rank: number,
  spec: Omit<StrategySpec, 'familyVersion' | 'risk' | 'execution'> & Partial<StrategySpec>,
  prices: number[][],
  weightsAt: (i: number) => number[],
  benchPrices: number[][],
  botReady: boolean,
  explanation: ResearchEntry['explanation'],
  agent: string,
): ResearchEntry {
  // Weight functions may keep state, so evaluate each bar exactly once.
  const ws = Array.from({ length: N }, (_, i) => weightsAt(i));
  const sim = simulate(prices, (i) => ws[i]);
  const bhEq = benchPrices.length === 1 ? buyHold(benchPrices[0]) : basketEq(benchPrices);
  let invested = 0;
  for (let i = 0; i < N; i++) invested += ws[i].reduce((a, b) => a + b, 0) > 0 ? 1 : 0;
  return {
    rank,
    spec: { familyVersion: 1, risk: baseRisk, execution: baseExec, ...spec } as StrategySpec,
    botReady,
    metrics: metrics(sim.eq, bhEq, sim.trades, sim.wins, sim.fees, (invested / N) * 100),
    equity: toSeries(sim.eq),
    buyHoldEquity: toSeries(bhEq),
    explanation,
    lineage: { experimentId: `exp-${(rank * 7919).toString(16)}`, agent, round: 41 - rank, parent: null },
  };
}

function basketEq(ps: number[][]) {
  return Array.from({ length: N }, (_, i) => ps.reduce((s, p) => s + (100 * p[i]) / p[0], 0) * (1000 / (100 * ps.length)));
}

const all10 = [btc, eth, ...alts];

function buildResearch(): ResearchPayload {
  const fastE = ema(btc, 4);
  const slowE = ema(btc, 16);
  const ethF = ema(eth, 5);
  const ethS = ema(eth, 18);
  const mom = (p: number[], i: number, lb: number) => (i >= lb ? p[i] / p[i - lb] - 1 : 0);
  const sma = (p: number[], i: number, n: number) => {
    const a = Math.max(0, i - n + 1);
    const s = p.slice(a, i + 1);
    return s.reduce((x, y) => x + y, 0) / s.length;
  };
  let dcaHeld = 0;

  const top: ResearchEntry[] = [
    entry(
      1,
      {
        id: 'rotation_momentum-top10-1d-7f3a21',
        name: 'Momentum rotation, top-10, daily',
        family: 'rotation_momentum',
        markets: ['BTC-EUR', 'ETH-EUR', 'SOL-EUR', 'XRP-EUR', 'ADA-EUR', 'DOGE-EUR', 'AVAX-EUR', 'LINK-EUR', 'DOT-EUR', 'LTC-EUR'],
        interval: '1d',
        params: { lookback: 30, top: 2, regimeSma: 100 },
        risk: { ...baseRisk, trailingStopPct: 0.15 },
      },
      all10,
      (i) => {
        if (i < 10 || btc[i] < sma(btc, i, 33)) return all10.map(() => 0);
        const ranked = all10.map((p, k) => [mom(p, i, 10), k]).sort((a, b) => b[0] - a[0]);
        const w = all10.map(() => 0);
        ranked.slice(0, 2).forEach(([m, k]) => {
          if (m > 0) w[k] = 0.5;
        });
        return w;
      },
      all10,
      false,
      {
        summary:
          'Every day it looks at the ten biggest coins, picks the two that rose the most over the last month and holds those. When Bitcoin itself is in a downtrend it sits in cash.',
        howItWorks: [
          'Rank the ten largest EUR markets by how much they rose over the last 30 days.',
          'Keep the two strongest, half of the money in each, but only if they actually went up.',
          'If Bitcoin is below its 100-day average, the whole market is treated as weak: sell everything and wait in euros.',
          'Each position has a 15% trailing stop, so a sudden crash is cut short.',
        ],
        whenItWins: 'Broad bull runs where one or two coins lead for weeks at a time. It rides the leaders and skips the laggards.',
        whenItLoses:
          'Fast, choppy markets where yesterday’s leader collapses tomorrow; it keeps buying high and selling a bit lower, and the fees add up.',
        vsBuyHold:
          'Holding Bitcoin gets every bit of a rally but also every crash. This one gives up some of the very best weeks in exchange for missing most of the deep drops.',
      },
      'agent-07',
    ),
    entry(
      2,
      {
        id: 'ema_cross-btc-4h-a1b2c3',
        name: 'EMA crossover, BTC 4h',
        family: 'ema_cross',
        markets: ['BTC-EUR'],
        interval: '4h',
        params: { fast: 12, slow: 48 },
      },
      [btc],
      (i) => [i > 16 && fastE[i] > slowE[i] ? 1 : 0],
      [btc],
      true,
      {
        summary: 'Holds Bitcoin while its short-term trend is above its longer-term trend, and sits in euros otherwise.',
        howItWorks: [
          'Every 4 hours, compute two smoothed averages of the price: a fast one (last ~2 days) and a slow one (last ~8 days).',
          'When the fast average climbs above the slow one, buy Bitcoin with all the money.',
          'When it drops back below, sell everything and wait.',
          'Orders are placed as limit orders just below/above the price so they pay the lower maker fee.',
        ],
        whenItWins: 'Long, steady trends up or down: it is in for most of a rise and out for most of a fall.',
        whenItLoses: 'Sideways weeks where the averages cross back and forth; each false signal costs a little in fees and slippage.',
        vsBuyHold:
          'In a straight bull run buy and hold wins, because this strategy always enters a bit late. Its strength is the drawdown: it typically steps aside before the worst of a crash.',
      },
      'agent-03',
    ),
    entry(
      3,
      {
        id: 'dca_dip-btc-1d-55e0d9',
        name: 'Steady DCA with dip boosts, BTC daily',
        family: 'dca_dip',
        markets: ['BTC-EUR'],
        interval: '1d',
        params: { everyBars: 7, tranches: 20, dipPct: 0.12, lookback: 30, takeProfitPct: 0.45, sellFraction: 0.3 },
      },
      [btc],
      (i) => {
        if (i % 3 === 0) dcaHeld = Math.min(1, dcaHeld + 0.05);
        const hi = Math.max(...btc.slice(Math.max(0, i - 10), i + 1));
        if (btc[i] < hi * 0.88) dcaHeld = Math.min(1, dcaHeld + 0.05);
        if (i > 20 && btc[i] > btc[i - 20] * 1.45) dcaHeld *= 0.7;
        return [dcaHeld];
      },
      [btc],
      true,
      {
        summary:
          'Buys a little Bitcoin every week, buys extra when the price has dropped noticeably, and takes some profit after a big run-up.',
        howItWorks: [
          'Split the starting money into 20 equal parts.',
          'Every 7 days, buy one part.',
          'If the price is 12% or more under its high of the last 30 days, buy one extra part right away.',
          'When the price is 45% above the average buying price, sell 30% of the coins to lock in some gains.',
        ],
        whenItWins: 'Markets that dip and recover: the extra buys at lower prices pull the average entry price down.',
        whenItLoses: 'A long slide with no recovery; it keeps buying all the way down until the money is used up.',
        vsBuyHold:
          'Buy and hold puts everything in on day one. This spreads the entry over months, so it starts slower in a rally but is much calmer to live with.',
      },
      'agent-11',
    ),
    entry(
      4,
      {
        id: 'rsi_dip-eth-1h-c0ffee',
        name: 'RSI dip-buyer with trend filter, ETH 1h',
        family: 'rsi_dip',
        markets: ['ETH-EUR'],
        interval: '1h',
        params: { period: 14, buyBelow: 28, sellAbove: 62, trendSma: 200 },
        risk: { ...baseRisk, stopLossPct: 0.08 },
      },
      [eth],
      (() => {
        let held = 0;
        return (i: number) => {
          if (i < 5) return [0];
          const ch = eth[i] / eth[i - 3] - 1;
          const up = eth[i] > sma(eth, i, 40);
          if (!held && ch < -0.07 && up) held = 1;
          else if (held && ch > 0.05) held = 0;
          return [held];
        };
      })(),
      [eth],
      true,
      {
        summary: 'Buys Ethereum after a sharp short-term drop, but only while the bigger trend is still up, and sells on the bounce.',
        howItWorks: [
          'Every hour, measure how oversold the price is with the RSI (0–100; low means it fell hard recently).',
          'Only consider buying when the price is above its 200-hour average, so the overall trend is up.',
          'Buy when the RSI drops under 28.',
          'Sell when the RSI recovers above 62, or if the price falls 8% under the buy price (stop-loss).',
        ],
        whenItWins: 'Healthy uptrends with sharp, short pullbacks: it buys the panic and sells the relief.',
        whenItLoses: 'When a dip turns into a real crash; the stop-loss limits the damage but it still takes the hit.',
        vsBuyHold:
          'It is in the market only a fraction of the time, so it misses big rallies but also most of the bad days. Expect smaller swings than holding ETH.',
      },
      'agent-05',
    ),
    entry(
      5,
      {
        id: 'vol_squeeze-btc-6h-9d1e44',
        name: 'Volatility squeeze breakout, BTC 6h',
        family: 'vol_squeeze',
        markets: ['BTC-EUR'],
        interval: '6h',
        params: { window: 40, squeezePct: 0.2, holdBars: 12 },
      },
      [btc],
      (() => {
        let hold = 0;
        return (i: number) => {
          if (i < 12) return [0];
          const win = btc.slice(i - 10, i);
          const range = (Math.max(...win) - Math.min(...win)) / btc[i];
          if (hold > 0) hold--;
          else if (range < 0.16 && btc[i] > Math.max(...win)) hold = 6;
          return [hold > 0 ? 1 : 0];
        };
      })(),
      [btc],
      false,
      {
        summary: 'Waits for Bitcoin to go unusually quiet, then buys when the price breaks out upwards and holds for a few days.',
        howItWorks: [
          'Measure how wide the price range of the last 10 days was.',
          'If the range is among the narrowest 20% (a “squeeze”), get ready.',
          'Buy when the price closes above the top of that quiet range.',
          'Sell after 3 days, win or lose.',
        ],
        whenItWins: 'Calm periods that end in a strong move up, which in crypto happens more often than you would think.',
        whenItLoses: 'Fake breakouts that reverse straight away, and quiet periods that end with a move down.',
        vsBuyHold:
          'It is rarely in the market, so its result depends on a handful of trades. Promising, but it needs more testing before the bot can run it.',
      },
      'agent-14',
    ),
  ];
  top.sort((a, b) => b.metrics.finalEur - a.metrics.finalEur).forEach((e, i) => (e.rank = i + 1));

  const bench = (name: string, eq: number[]): Benchmark => {
    let peak = eq[0];
    let mdd = 0;
    eq.forEach((v) => {
      peak = Math.max(peak, v);
      mdd = Math.max(mdd, (peak - v) / peak);
    });
    return {
      name,
      returnPct: Math.round((eq[eq.length - 1] / 1000 - 1) * 10000) / 100,
      maxDrawdownPct: Math.round(mdd * 10000) / 100,
      equity: toSeries(eq),
    };
  };

  return {
    generatedAt: new Date(Date.now() - 2.5 * 3600_000).toISOString(),
    summary: {
      experiments: 18234,
      families: 23,
      rounds: 41,
      dataRange: ['2019-01-01', '2026-10-25'],
      notes:
        'Trend-following on Bitcoin keeps showing up near the top, and rotating between the strongest coins is the most promising new idea. Mean-reversion on altcoins mostly loses to fees. Next round: give the rotation family a bot implementation and stress-test the squeeze breakout on more markets.',
    },
    benchmark: bench('Buy and hold BTC', buyHold(btc)),
    benchmarks: [bench('Buy and hold ETH', buyHold(eth)), bench('Top-10 basket (equal weight)', basketEq(all10))],
    top,
  };
}

export const research = buildResearch();

/** v2 payload (SPEC §8): the same entries spread over timeframe buckets, re-skinned per interval. */
function buildResearchV2(): ResearchPayload & { id: number } {
  const v1 = research;
  const clone = (e: ResearchEntry, rank: number, interval: Interval, scoreV: number, ready = e.botReady): ResearchEntry => ({
    ...e,
    rank,
    botReady: ready,
    spec: { ...e.spec, id: `${e.spec.id}-${interval}`, interval, name: e.spec.name.replace(/,\s*([A-Z]+)\s+\w+$/, `, $1 ${interval}`) },
    metrics: { ...e.metrics, score: scoreV },
  });
  const t = v1.top;
  const bucket = (
    label: string,
    intervals: Interval[],
    profile: ResearchBucket['profile'],
    holdScore: number,
    luckLine: ResearchBucket['luckLine'],
    notes: string,
    top: ResearchEntry[],
  ): ResearchBucket => ({ label, intervals, profile, holdScore, luckLine, benchmark: v1.benchmark, notes, top });
  return {
    ...v1,
    id: 7,
    buckets: {
      minute: bucket(
        'Minute trading',
        ['1m', '5m', '15m'],
        { holdoutDays: 60, folds: 6, foldSpanDays: 56, dataFrom: '2025-09-21' },
        -20.1,
        { median: -35, best: -8, exposure: 0.7 },
        'Nothing beats buy and hold after fees at minute level yet: every trade pays 0.25%, and at this speed the fees eat the edge.',
        [],
      ),
      hourly: bucket(
        'Hourly trading',
        ['30m', '1h', '2h', '4h'],
        { holdoutDays: 120, folds: 6, foldSpanDays: 140, dataFrom: '2023-10-26' },
        4.2,
        { median: -6.5, best: 3.1, exposure: 0.55 },
        'Dip-buying on ETH and the 4-hour trend follower are the only ones that clear the luck line. Two more are close but not ported yet.',
        [clone(t[3] ?? t[0], 1, '1h', 9.4, true), clone(t[0], 2, '4h', 7.8, true), clone(t[4] ?? t[1], 3, '2h', 6.1, false)],
      ),
      daily: bucket(
        'Daily trading',
        ['6h', '8h', '12h', '1d'],
        { holdoutDays: 365, folds: 6, foldSpanDays: 300, dataFrom: '2019-01-01' },
        12.5,
        { median: 2.4, best: 10.8, exposure: 0.5 },
        'The steadiest bucket: trend-following and rotation keep winning on daily candles.',
        t.map((e, i) => ({ ...e, metrics: { ...e.metrics, score: Math.round((24 - i * 2.7) * 10) / 10 } })),
      ),
      weekly: bucket(
        'Weekly trading',
        ['1W'],
        { holdoutDays: 365, folds: 6, foldSpanDays: 300, dataFrom: '2019-01-01' },
        15.0,
        { median: 3.2, best: 13.9, exposure: 0.6 },
        'Weekly bars have few trades, so these scores wobble more. One candidate so far.',
        [clone(t[2] ?? t[0], 1, '1W', 16.2, true)],
      ),
      mixed: bucket(
        'Mixed timeframes',
        ['1h'],
        { holdoutDays: 365, folds: 6, foldSpanDays: 300, dataFrom: '2019-03-08' },
        -26.1,
        null,
        '1 of these 2 beat buying and holding the same coin(s) in the last test year.',
        [clone(t[1] ?? t[0], 1, '1h', 7.7, false), clone(t[3] ?? t[0], 2, '1h', 5.1, false)],
      ),
      session1: bucket(
        'Session 1',
        ['1d'],
        { holdoutDays: 365, folds: 6, foldSpanDays: 300, dataFrom: '2019-01-01' },
        8.2,
        { median: 1.1, best: 6.4, exposure: 0.5 },
        'The first session’s five.',
        [clone(t[0], 1, '1d', 11.2, true)],
      ),
      session2: bucket(
        'Session 2',
        ['1d'],
        { holdoutDays: 365, folds: 6, foldSpanDays: 300, dataFrom: '2019-01-01' },
        9.4,
        { median: 1.4, best: 7.1, exposure: 0.48 },
        'Aimed at the coins session 1 lost to holding.',
        [clone(t[1] ?? t[0], 1, '1d', 12.4, true), clone(t[2] ?? t[0], 2, '1d', 10.1, true)],
      ),
      session12: bucket(
        'Session 12',
        ['15m'],
        { holdoutDays: 365, folds: 6, foldSpanDays: 300, dataFrom: '2019-01-01' },
        12.1,
        { median: 2.2, best: 9.6, exposure: 0.5 },
        'A later session, to check the tab.',
        [clone(t[0], 1, '15m', 17.4, true)],
      ),
      session5: bucket(
        'Session 5',
        ['15m'],
        { holdoutDays: 365, folds: 6, foldSpanDays: 300, dataFrom: '2019-01-01' },
        11.6,
        { median: 2.1, best: 9.4, exposure: 0.5 },
        'Scored like Session 4.',
        [clone(t[1] ?? t[0], 1, '15m', 16.3, true)],
      ),
      session4: bucket(
        'Session 4',
        ['15m'],
        { holdoutDays: 365, folds: 6, foldSpanDays: 300, dataFrom: '2019-01-01' },
        11.2,
        { median: 2.0, best: 9.3, exposure: 0.5 },
        'Rides the big rises at a 0.05 percent fee.',
        [clone(t[2] ?? t[0], 1, '15m', 15.1, true)],
      ),
      session3: bucket(
        'Session 3',
        ['1d'],
        { holdoutDays: 365, folds: 6, foldSpanDays: 300, dataFrom: '2019-01-01' },
        10.8,
        { median: 2.0, best: 9.2, exposure: 0.52 },
        'All in or all out, judged in 90-day sections.',
        [clone(t[0], 1, '1d', 14.6, true), clone(t[2] ?? t[0], 2, '1d', 13.1, true), clone(t[3] ?? t[1], 3, '1d', 11.8, false)],
      ),
    },
  };
}
export const researchV2 = buildResearchV2();

// ---------- markets ----------
export const markets: MarketInfo[] = [
  'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX', 'MATIC', 'ATOM', 'NEAR', 'UNI', 'BCH', 'XLM', 'ETC', 'FIL', 'AAVE',
].map((b) => ({ market: `${b}-EUR`, base: b, quote: 'EUR', status: 'trading' }));

// ---------- families ----------
export const families: FamilyInfo[] = [
  {
    family: 'ema_cross',
    name: 'EMA crossover',
    version: 1,
    description: 'Trend following: long while the fast EMA is above the slow EMA, cash otherwise.',
    params: [
      { key: 'fast', type: 'int', default: 12, min: 2, max: 200, description: 'Bars in the fast average (reacts quickly).' },
      { key: 'slow', type: 'int', default: 48, min: 3, max: 400, description: 'Bars in the slow average (the bigger trend).' },
    ],
  },
  {
    family: 'macd_trend',
    name: 'MACD trend',
    version: 1,
    description: 'Long while MACD is above its signal line (and optionally above zero).',
    params: [
      { key: 'fast', type: 'int', default: 12, min: 2, max: 100, description: 'Fast EMA length.' },
      { key: 'slow', type: 'int', default: 26, min: 3, max: 200, description: 'Slow EMA length.' },
      { key: 'signal', type: 'int', default: 9, min: 2, max: 50, description: 'Signal line EMA length.' },
      { key: 'requirePositive', type: 'boolean', default: false, description: 'Only hold while MACD is above zero.' },
    ],
  },
  {
    family: 'donchian_breakout',
    name: 'Donchian breakout',
    version: 1,
    description: 'Buy on a close above the N-bar high, exit under the M-bar low.',
    params: [
      { key: 'entry', type: 'int', default: 20, min: 2, max: 400, description: 'Breakout window in bars.' },
      { key: 'exit', type: 'int', default: 10, min: 2, max: 400, description: 'Exit window in bars.' },
    ],
  },
  {
    family: 'rsi_dip',
    name: 'RSI dip',
    version: 1,
    description: 'Buy when RSI is low, sell when it recovers; optional trend filter.',
    params: [
      { key: 'period', type: 'int', default: 14, min: 2, max: 100, description: 'RSI length in bars.' },
      { key: 'buyBelow', type: 'number', default: 30, min: 1, max: 99, step: 1, description: 'Buy when RSI drops under this.' },
      { key: 'sellAbove', type: 'number', default: 60, min: 1, max: 99, step: 1, description: 'Sell when RSI rises above this.' },
      { key: 'trendSma', type: 'int', default: 0, min: 0, max: 1000, description: 'Only buy above this SMA (0 = off).' },
    ],
  },
  {
    family: 'bollinger_reversion',
    name: 'Bollinger reversion',
    version: 1,
    description: 'Buy at the lower band, sell at the middle or upper band.',
    params: [
      { key: 'period', type: 'int', default: 20, min: 2, max: 200, description: 'Band length in bars.' },
      { key: 'stdDev', type: 'number', default: 2, min: 0.5, max: 4, step: 0.1, description: 'Band width in standard deviations.' },
      { key: 'exitAt', type: 'enum', default: 'middle', options: ['middle', 'upper'], description: 'Where to take profit.' },
    ],
  },
  {
    family: 'dca_dip',
    name: 'DCA with dips',
    version: 1,
    description: 'Regular buys, extra buys on dips, partial take-profit.',
    params: [
      { key: 'everyBars', type: 'int', default: 7, min: 1, max: 500, description: 'Buy one tranche every N bars.' },
      { key: 'tranches', type: 'int', default: 20, min: 1, max: 200, description: 'Number of equal parts of the starting cash.' },
      { key: 'dipPct', type: 'number', default: 0.1, min: 0.01, max: 0.9, step: 0.01, description: 'Drop from the recent high that triggers an extra buy (0.1 = 10%).' },
      { key: 'lookback', type: 'int', default: 30, min: 2, max: 500, description: 'Bars used for the recent high.' },
      { key: 'takeProfitPct', type: 'number', default: 0.4, min: 0.01, max: 5, step: 0.01, description: 'Gain over average entry that triggers a partial sale.' },
      { key: 'sellFraction', type: 'number', default: 0.3, min: 0.05, max: 1, step: 0.05, description: 'Part of the position sold at take-profit.' },
    ],
  },
];

// ---------- bot settings ----------
export const initialBot = (): BotSettings => ({
  enabled: true,
  mode: 'paper',
  strategy: research.top.find((t) => t.spec.family === 'ema_cross')!.spec,
  maxExposureEur: null,
  dailyLossLimit: { unit: 'pct', value: 15, action: 'no_buys' },
  fees: { maker: 0.0015, taker: 0.0025 },
  paperStartEur: 1000,
});

// ---------- expected vs actual ----------
export function tracking(mode: Mode, range: CompareRange, strategyId: string, empty: boolean): TrackingData {
  const none = { mode, range, strategyId: null, since: null, expected: [], actual: [], hold: [], gapPct: null, decisions: { total: 0, withOrders: 0 }, alerts: [] };
  if (empty) return { ...none, slippage: { fills: 0, measured: 0, avgBps: null, takerShare: null, feesEur: 0 } };
  const started = Date.now() - 42 * 86_400_000;
  const days = { day: 1, week: 7, month: 30, year: 42, all: 42 }[range];
  const from = Math.max(started, Date.now() - days * 86_400_000);
  const r2 = rng(21);
  const n = 240;
  let e = 1000;
  let h = 1000;
  let slip = 1;
  const expected: [number, number][] = [];
  const actual: [number, number][] = [];
  const hold: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = from + ((Date.now() - from) * i) / (n - 1);
    const step = (r2() - 0.48) * 0.014;
    e *= 1 + step;
    h *= 1 + step * 1.5 - 0.0005;
    slip *= 1 - r2() * 0.00018;
    expected.push([t, Math.round(e * 100) / 100]);
    actual.push([t, Math.round(e * slip * 100) / 100]);
    hold.push([t, Math.round(h * 100) / 100]);
  }
  const a = actual[n - 1][1];
  const x = expected[n - 1][1];
  return {
    ...none,
    strategyId,
    since: new Date(started).toISOString(),
    expected,
    actual,
    hold,
    gapPct: (a / x - 1) * 100,
    slippage: { fills: 34, measured: 31, avgBps: 8.4, takerShare: 0.18, feesEur: 11.62 },
    decisions: { total: 1008, withOrders: 34 },
    alerts: [],
  };
}

// ---------- health ----------
export function healthDetail(bot: BotSettings, variant: 'ok' | 'warn' | 'fail' | 'guard'): HealthDetail {
  const now = Date.now();
  const checkedAt = new Date(now).toISOString();
  const iso = (ago: number) => new Date(now - ago).toISOString();
  const part = (status: HealthComponent['status'], detail: string, data: Record<string, unknown> = {}): HealthComponent => ({ status, detail, checkedAt, data });
  const limit = bot.dailyLossLimit;
  const limitEur = limit.unit === 'pct' ? 1237 * (limit.value / 100) : limit.value;
  const guarded = variant === 'guard';
  const components: HealthDetail['components'] = {
    engine: part('ok', 'Last tick 12 s ago.', { enabled: bot.enabled, ageSec: 12, lastError: null }),
    database: part('ok', 'Answers in 4 ms.', { ms: 4 }),
    bitvavo: part('ok', 'Private calls work.', { hasKeys: true, connected: true, lastOkAt: iso(40_000), lastError: null }),
    clock: part('ok', "Server clock is 182 ms from Bitvavo's.", { offsetMs: 182, lastSyncAt: iso(1_500_000) }),
    decision: part('ok', 'Decided on the 2026-10-30T13:00:00.000Z bar.', { bar: iso(1_800_000), ageSec: 1740, interval: bot.strategy.interval, barsBehind: 0, held: null }),
    candles: part('ok', 'The newest closed candle is there.', { interval: bot.strategy.interval, markets: bot.strategy.markets.map((market) => ({ market, newest: iso(1_800_000), barsBehind: 0 })) }),
    lab: part('unknown', 'No lab call since the start.', { usesLab: true, catalogFamilies: 214, lastCall: null, lastFailure: null, codeHashMatch: null }),
    alerts: part('ok', 'Alert mails are on; none sent since the start.', { configured: true, lastSentAt: null, lastError: null }),
    lossGuard: guarded
      ? part('fail', `The loss guard is active (${limit.action ?? 'no_buys'}).`, { limit: limit.value, unit: limit.unit, action: limit.action ?? 'no_buys', active: true, lossEur: limitEur + 6.4, limitEur })
      : part('ok', `Lost €52.70 of the €${limitEur.toFixed(2)} limit over 24 h.`, { limit: limit.value, unit: limit.unit, action: limit.action ?? 'no_buys', active: false, lossEur: 52.7, limitEur }),
    orders: part('ok', 'No open orders.', { open: 0, oldestAgeSec: null, stale: 0, checkedAt: now }),
    stuckOrders: part('ok', 'Nothing stuck in the last 24 h.', { retriesExhausted24h: 0, unknownOrders: 0, orderUnknown24h: 0, tickStuck24h: 0, rejected24h: 0, failed24h: 0 }),
    shadow: part('ok', 'Portfolio is -0.84 % from expected.', { strategyId: bot.strategy.id, lastPointAgeSec: 31, gapPct: -0.84, avgBps: 8.4, fills: 34, alerts: [] }),
    process: part('ok', 'Up for 1312 min.', { uptimeSec: 78_720, startedAt: iso(78_720_000), deployedAt: iso(79_000_000), rssMb: 142, node: 'v22.12.0' }),
  };
  if (variant === 'warn' || variant === 'fail') {
    components.alerts = part('warn', 'Alert mails are off: SENDGRID_API_KEY or STONKS_ALERT_EMAIL is missing.', { configured: false, lastSentAt: null, lastError: null });
    components.candles = part('warn', 'The newest candle is late on BTC-EUR.', { interval: bot.strategy.interval, markets: [{ market: 'BTC-EUR', newest: iso(5_400_000), barsBehind: 1 }] });
  }
  if (variant === 'fail') {
    components.engine = part('fail', 'The last tick failed: Bitvavo answered 429: too many requests while reading the balance, retry after 60 s.', { enabled: true, ageSec: 94, lastError: 'Bitvavo answered 429' });
    components.bitvavo = part('fail', 'Not connected: no successful private call in the last 10 minutes.', { hasKeys: true, connected: false, lastOkAt: iso(900_000), lastError: null });
  }
  const levels = Object.values(components).map((c) => c.status);
  const status = levels.includes('fail') ? 'fail' : levels.includes('warn') ? 'warn' : 'ok';
  const events: HealthDetail['events'] =
    variant === 'ok'
      ? []
      : [
          { id: 9102, ts: iso(120_000), level: 'error', event: 'tick_failed', message: 'Tick failed: Bitvavo answered 429: too many requests while reading the balance' },
          { id: 9087, ts: iso(1_900_000), level: 'warn', event: 'stale_candles', message: 'BTC-EUR candle for the 13:00 bar is not there yet' },
          { id: 8990, ts: iso(5_400_000), level: 'warn', event: 'order_retry', message: 'Bar 2026-10-30T12:00:00.000Z: placing buy BTC-EUR €120.00 again (attempt 2 of 3)' },
        ];
  return { status, checkedAt, bot: { enabled: bot.enabled, mode: bot.mode, strategyId: bot.strategy.id }, components, events };
}

// ---------- orders, fills ----------
const r = rng(7);
const now = Date.now();
const traded = ['BTC-EUR', 'BTC-EUR', 'BTC-EUR', 'ETH-EUR', 'SOL-EUR'];
const basePrice: Record<string, number> = { 'BTC-EUR': 98_400, 'ETH-EUR': 3_420, 'SOL-EUR': 172 };
const statuses = ['filled', 'filled', 'filled', 'filled', 'cancelled', 'partiallyFilled', 'expired', 'unknown'];

export const orders: Order[] = [];
export const fills: Fill[] = [];
for (let i = 0; i < 140; i++) {
  const market = traded[Math.floor(r() * traded.length)];
  const side = r() < 0.5 ? 'buy' : 'sell';
  const mode = i < 110 ? 'paper' : 'live';
  const isMarket = r() < 0.15;
  const p = basePrice[market] * (1 + (r() - 0.5) * 0.12);
  const eurSize = 60 + r() * 380;
  const amt = eurSize / p;
  const status = i === 0 ? 'new' : i === 1 ? 'new' : statuses[Math.floor(r() * statuses.length)];
  const filledFrac = status === 'filled' ? 1 : status === 'partiallyFilled' ? 0.4 : 0;
  const fee = eurSize * filledFrac * (isMarket ? 0.0025 : 0.0015);
  const ts = new Date(now - i * 5.3 * 3600_000 - r() * 3600_000).toISOString();
  const id = 9000 - i;
  orders.push({
    id,
    mode,
    market,
    side,
    type: isMarket ? 'market' : 'limit',
    price: isMarket ? null : Number(p.toPrecision(5)),
    amount: Number(amt.toFixed(8)),
    filled: Number((amt * filledFrac).toFixed(8)),
    feeEur: Math.round(fee * 100) / 100,
    status,
    strategyId: 'ema_cross-btc-4h-a1b2c3',
    reason: side === 'buy' ? 'target 100% (fast EMA crossed above slow)' : 'target 0% (fast EMA crossed below slow)',
    exchangeOrderId: mode === 'live' ? crypto.randomUUID?.() ?? `ex-${id}` : null as unknown as string,
    clientOrderId: `stonks-${id.toString(36)}-${(i * 31).toString(36)}`,
    createdAt: ts,
  });
  if (filledFrac > 0) {
    const parts = r() < 0.3 ? 2 : 1;
    for (let k = 0; k < parts; k++) {
      fills.push({
        id: id * 10 + k,
        mode,
        market,
        side,
        price: Number((p * (isMarket ? (side === 'buy' ? 1.0005 : 0.9995) : 1)).toPrecision(5)),
        amount: Number(((amt * filledFrac) / parts).toFixed(8)),
        feeEur: Math.round((fee / parts) * 100) / 100,
        liquidity: isMarket ? 'taker' : 'maker',
        orderId: id,
        exchangeTradeId: mode === 'live' ? `t-${id}-${k}` : `paper-${id}-${k}`,
        ts: new Date(new Date(ts).getTime() + (k + 1) * 600_000).toISOString(),
      });
    }
  }
}
fills.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

// ---------- equity (paper, last 90 days, hourly) ----------
export function equityPoints(days: number) {
  const rr = rng(42);
  const pts: { ts: string; totalEur: number }[] = [];
  const n = 90 * 24;
  let v = 1000;
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    v *= Math.exp(0.00008 + 0.0022 * gauss(rr));
    raw.push(v);
  }
  // end at the overview equity
  const scale = 1184.32 / raw[raw.length - 1];
  const from = n - Math.min(n, days * 24);
  for (let i = from; i < n; i++) {
    pts.push({ ts: new Date(now - (n - 1 - i) * 3600_000).toISOString(), totalEur: Math.round(raw[i] * scale * 100) / 100 });
  }
  return pts;
}

// ---------- logs ----------
const logTemplates: [LogLevel, string, string, (rr: () => number) => unknown][] = [
  ['debug', 'tick', 'Tick: candles up to date, no new closed bar', (rr) => ({ market: 'BTC-EUR', lastClose: Math.round(98_000 + rr() * 900) })],
  ['info', 'decision', 'Target weight BTC-EUR 100% (fast EMA 98 512 > slow EMA 97 044)', (rr) => ({ targets: { 'BTC-EUR': 1 }, fast: 98512.4, slow: 97044.1 + rr() })],
  ['info', 'order_placed', 'Placed limit buy 0.00412 BTC @ €98 350 (post-only)', () => ({ market: 'BTC-EUR', side: 'buy', price: '98350', amount: '0.00412', clientOrderId: 'stonks-k2j9-1a' })],
  ['info', 'fill', 'Filled 0.00412 BTC @ €98 350, fee €0.61 (maker)', () => ({ market: 'BTC-EUR', fee: 0.61, liquidity: 'maker' })],
  ['debug', 'equity_snapshot', 'Equity €1 184.32 (cash €12.10, BTC €1 172.22)', () => ({ totalEur: 1184.32, cashEur: 12.1, holdings: { BTC: 0.01191 } })],
  ['warn', 'order_timeout', 'Limit order not filled after 1 bar, cancelled (fallback: cancel)', () => ({ clientOrderId: 'stonks-k2j8-19', fallback: 'cancel' })],
  ['info', 'no_change', 'Already at target, difference €3.20 is under the €5 minimum', () => ({ diffEur: 3.2 })],
];
let logId = 0;
export const logs: LogRow[] = [];
export function makeLog(at: number, rr: () => number): LogRow {
  const t = logTemplates[Math.floor(rr() * logTemplates.length)];
  return { id: ++logId, ts: new Date(at).toISOString(), level: t[0], event: t[1], message: t[2], data: t[3](rr) };
}
{
  const lr = rng(99);
  for (let i = 0; i < 120; i++) logs.push(makeLog(now - (120 - i) * 4 * 60_000, lr));
  logs.splice(40, 0, {
    id: ++logId,
    ts: new Date(now - 300 * 60_000).toISOString(),
    level: 'error',
    event: 'bitvavo_error',
    message: 'Bitvavo request failed: 429 rate limited, backing off 30 s',
    data: { status: 429, endpoint: '/v2/order', retryInMs: 30000 },
  });
  logs.forEach((l, i) => (l.id = i + 1));
  logId = logs.length;
}
