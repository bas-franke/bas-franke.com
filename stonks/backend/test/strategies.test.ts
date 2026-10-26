import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ema, macd, priorMax, priorMin, rsi, sma, stdPop } from '../src/strategies/indicators.js';
import { explainStrategy, families, targets, targetSeries, validateSpec, warmupBars, type Candle, type StrategySpec } from '../src/strategies/index.js';

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const H = 3_600_000;
/** Candles from closes: open = previous close, high/low = max/min(open, close) ± `wick`. */
function candles(closes: number[], wick = 0, t0 = 0): Candle[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return [t0 + i * H, o, Math.max(o, c) + wick, Math.min(o, c) - wick, c, 1];
  });
}
const spec = (s: Partial<StrategySpec> & { family: string; params?: Record<string, unknown> }) =>
  validateSpec({ markets: ['BTC-EUR'], interval: '1h', ...s });

test('SMA, population std, EMA seeding', () => {
  const v = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(sma(v, 3).map((x) => (Number.isNaN(x) ? null : x)), [null, null, 2, 3, 4, 5]);
  const sd = stdPop([2, 4, 4, 4, 5, 5, 7, 9], 8);
  assert.equal(sd[7], 2);
  const e = ema(v, 3);
  assert.ok(Number.isNaN(e[1]));
  assert.equal(e[2], 2); // seeded with the SMA of the first 3
  assert.equal(e[3], 0.5 * 4 + 0.5 * 2);
  assert.equal(e[4], 0.5 * 5 + 0.5 * 3);
  // Leading NaNs are skipped when seeding (EMA of a MACD line).
  const e2 = ema([NaN, NaN, 3, 6, 9], 2);
  assert.equal(e2[3], 4.5);
  assert.ok(close(e2[4], (2 / 3) * 9 + (1 / 3) * 4.5));
});

test('RSI uses Wilder smoothing seeded with plain means', () => {
  const c = [10, 11, 10, 12, 12, 11];
  const r = rsi(c, 3);
  // d = +1, -1, +2, 0, -1 ; first avg over d1..d3: gain 1, loss 1/3 -> RSI 75
  assert.ok(Number.isNaN(r[2]));
  assert.ok(close(r[3], 75));
  // next: d=0 -> g = (1*2+0)/3 = 2/3, l = (1/3*2+0)/3 = 2/9 -> rs = 3 -> 75
  assert.ok(close(r[4], 75));
  // next: d=-1 -> g = (2/3*2)/3 = 4/9, l = (2/9*2+1)/3 = 13/27 -> rs = 12/13
  assert.ok(close(r[5], 100 - 100 / (1 + 12 / 13)));
  assert.equal(rsi([5, 5, 5, 5], 2)[3], 50);
  assert.equal(rsi([1, 2, 3, 4], 2)[3], 100);
});

test('MACD line and signal', () => {
  const c = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.2);
  const m = macd(c, 3, 6, 4);
  const f = ema(c, 3);
  const s = ema(c, 6);
  assert.ok(Number.isNaN(m.line[4]));
  assert.ok(close(m.line[5], f[5] - s[5]));
  assert.ok(Number.isNaN(m.signal[7]));
  assert.ok(close(m.signal[8], (m.line[5] + m.line[6] + m.line[7] + m.line[8]) / 4));
});

test('prior max/min exclude the current bar', () => {
  assert.deepEqual(priorMax([1, 5, 2, 3], 2).slice(2), [5, 5]);
  assert.deepEqual(priorMin([4, 1, 2, 3], 2).slice(2), [1, 1]);
});

test('ema_cross holds while fast > slow', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 129 - i * 2);
  const s = spec({ family: 'ema_cross', params: { fast: 3, slow: 8 } });
  const series = targetSeries({ 'BTC-EUR': candles([...up, ...down]) }, s);
  assert.equal(series.length, 60);
  assert.equal(series[6][1]['BTC-EUR'], 0); // slow EMA not defined yet
  assert.equal(series[20][1]['BTC-EUR'], 1);
  assert.equal(series[59][1]['BTC-EUR'], 0);
  const half = spec({ family: 'ema_cross', params: { fast: 3, slow: 8 }, risk: { maxWeight: 0.5 } } as never);
  assert.equal(targets({ 'BTC-EUR': candles(up) }, half)['BTC-EUR'], 0.5);
});

test('donchian enters above the prior high and exits under the prior low', () => {
  const c = [10, 10, 10, 10, 11, 12, 12, 11, 9, 9];
  const s = spec({ family: 'donchian_breakout', params: { entry: 3, exit: 2 } });
  const w = targetSeries({ 'BTC-EUR': candles(c) }, s).map(([, x]) => x['BTC-EUR']);
  // bar 4: close 11 > max high of bars 1..3 (10) -> in; bar 8: close 9 < min low of bars 6..7 (11) -> out
  assert.deepEqual(w, [0, 0, 0, 0, 1, 1, 1, 1, 0, 0]);
});

test('rsi_dip and bollinger_reversion hold between entry and exit', () => {
  const c = [100, 99, 98, 97, 96, 95, 94, 96, 99, 103, 108, 109];
  const r = spec({ family: 'rsi_dip', params: { period: 3, buyBelow: 20, sellAbove: 80, trendSma: 0 } });
  const w = targetSeries({ 'BTC-EUR': candles(c) }, r).map(([, x]) => x['BTC-EUR']);
  assert.equal(w[3], 1); // RSI 0 after three falls
  assert.equal(w[11], 0);
  assert.ok(w.indexOf(0, 3) > 3);
  const withTrend = spec({ family: 'rsi_dip', params: { period: 3, buyBelow: 20, sellAbove: 80, trendSma: 3 } });
  assert.ok(targetSeries({ 'BTC-EUR': candles(c) }, withTrend).every(([, x]) => x['BTC-EUR'] === 0));

  const b = spec({ family: 'bollinger_reversion', params: { period: 5, stdDev: 1, exitAt: 'middle' } });
  const bc = [100, 101, 100, 101, 100, 90, 92, 95, 99, 102, 103];
  const bw = targetSeries({ 'BTC-EUR': candles(bc) }, b).map(([, x]) => x['BTC-EUR']);
  assert.equal(bw[5], 1);
  assert.equal(bw[10], 0);
});

test('dca_dip buys tranches on schedule, adds on dips and takes partial profit', () => {
  const s = spec({ family: 'dca_dip', params: { everyBars: 2, tranches: 4, dipPct: 0.1, lookback: 3, takeProfitPct: 0.5, sellFraction: 0.5 } });
  const flat = targetSeries({ 'BTC-EUR': candles([100, 100, 100, 100, 100, 100, 100, 100, 100]) }, s).map(([, x]) => x['BTC-EUR']);
  assert.ok(close(flat[0], 0.25));
  assert.ok(close(flat[1], 0.25));
  assert.ok(close(flat[2], 0.5));
  assert.ok(close(flat[6], 1));
  assert.ok(close(flat[8], 1));
  // Anchor: bars before startTime stay out and the schedule counts from the anchor.
  const anchored = targetSeries({ 'BTC-EUR': candles([100, 100, 100, 100]) }, s, { startTime: 2 * H }).map(([, x]) => x['BTC-EUR']);
  assert.deepEqual(anchored.slice(0, 2), [0, 0]);
  assert.ok(close(anchored[2], 0.25));
  // Dip buy, then take profit at +50 % of the average entry.
  const d = targetSeries({ 'BTC-EUR': candles([100, 100, 85, 85, 200]) }, s).map(([, x]) => x['BTC-EUR']);
  // bar0 buy .25@100, bar2 scheduled+dip .5@85; bar 4: avg entry ~89.5, 200 >= 1.5x -> sell half
  const coins = 0.25 / 100 + 0.5 / 85;
  const cash = 0.25 + (coins / 2) * 200;
  assert.ok(close(d[4], ((coins / 2) * 200) / (cash + (coins / 2) * 200)));
});

test('rotation_momentum holds the top movers with positive returns, gated by the BTC regime', () => {
  const t = (a: number[]) => candles(a);
  const data = {
    'ETH-EUR': t([10, 11, 12, 13]),
    'SOL-EUR': t([10, 10, 10, 15]),
    'ADA-EUR': t([10, 9, 8, 7]),
    'BTC-EUR': t([100, 101, 102, 103]),
  };
  const s = validateSpec({ family: 'rotation_momentum', markets: ['ETH-EUR', 'SOL-EUR', 'ADA-EUR'], interval: '1h', params: { lookback: 2, top: 2, regimeSma: 0 } });
  const w = targets(data, s);
  assert.deepEqual(w, { 'ETH-EUR': 0.5, 'SOL-EUR': 0.5, 'ADA-EUR': 0 });
  const one = validateSpec({ ...s, id: undefined, params: { lookback: 2, top: 1, regimeSma: 0 } });
  assert.deepEqual(targets(data, one), { 'ETH-EUR': 0, 'SOL-EUR': 1, 'ADA-EUR': 0 });
  const gated = validateSpec({ ...s, id: undefined, params: { lookback: 2, top: 2, regimeSma: 3 } });
  assert.deepEqual(targets(data, gated), { 'ETH-EUR': 0.5, 'SOL-EUR': 0.5, 'ADA-EUR': 0 });
  const bear = { ...data, 'BTC-EUR': t([103, 102, 101, 100]) };
  assert.deepEqual(targets(bear, gated), { 'ETH-EUR': 0, 'SOL-EUR': 0, 'ADA-EUR': 0 });
  // Only one riser: its slot is 1/top, the other slot stays cash.
  const lone = { 'ETH-EUR': t([10, 11, 12, 13]), 'SOL-EUR': t([10, 9, 9, 9]), 'ADA-EUR': t([10, 9, 8, 7]) };
  assert.deepEqual(targets(lone, s), { 'ETH-EUR': 0.5, 'SOL-EUR': 0, 'ADA-EUR': 0 });
});

test('validateSpec fills defaults and rejects bad specs with readable messages', () => {
  const s = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '4h' });
  assert.equal(s.params.fast, 12);
  assert.equal(s.params.slow, 48);
  assert.equal(s.execution.orderType, 'limit');
  assert.equal(s.execution.postOnly, true);
  assert.equal(s.risk.maxWeight, 1);
  assert.match(s.id, /^ema_cross-btc-4h-[0-9a-f]{6}$/);
  const bad: Array<[unknown, RegExp]> = [
    [null, /object/],
    [{ family: 'moon', markets: ['BTC-EUR'], interval: '1h' }, /not runnable/],
    [{ family: 'ema_cross', markets: ['BTC-USD'], interval: '1h' }, /BTC-EUR/],
    [{ family: 'ema_cross', markets: ['BTC-EUR', 'ETH-EUR'], interval: '1h' }, /exactly one/],
    [{ family: 'ema_cross', markets: ['BTC-EUR'], interval: '3h' }, /interval/],
    [{ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 50, slow: 20 } }, /fast must be smaller/],
    [{ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fats: 5 } }, /no parameter "fats"/],
    [{ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 2.5 } }, /whole number/],
    [{ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', familyVersion: 2 }, /version 2/],
    [{ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', risk: { maxWeight: 1.5 } }, /maxWeight/],
    [{ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', risk: { stopLossPct: 8 } }, /stopLossPct/],
    [{ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', execution: { fallback: 'pray' } }, /fallback/],
    [{ family: 'rotation_momentum', markets: ['BTC-EUR'], interval: '1h', params: { top: 3 } }, /top cannot be larger/],
    [{ family: 'bollinger_reversion', markets: ['BTC-EUR'], interval: '1h', params: { exitAt: 'lower' } }, /middle, upper/],
  ];
  for (const [input, re] of bad) assert.throws(() => validateSpec(input), re, JSON.stringify(input));
});

test('every family has info, valid defaults and an explanation', () => {
  assert.equal(families.length, 7);
  for (const f of families) {
    const markets = f.multiMarket ? ['BTC-EUR', 'ETH-EUR', 'SOL-EUR'] : ['BTC-EUR'];
    const s = validateSpec({ family: f.family, markets, interval: '1d' });
    for (const p of f.params) assert.equal(s.params[p.name], p.default);
    const text = explainStrategy(s);
    assert.ok(text.length > 80, f.family);
    assert.doesNotMatch(text, /undefined|NaN/);
    // Runs on random data without throwing and stays within 0..maxWeight.
    const data = Object.fromEntries(markets.map((m, k) => [m, candles(Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.sin(i / (7 + k)) + i * 0.05), 0.5)]));
    for (const [, w] of targetSeries(data, s)) {
      const sum = Object.values(w).reduce((a, b) => a + b, 0);
      assert.ok(sum >= 0 && sum <= 1 + 1e-12);
    }
  }
});

test('the bot loads enough warmup that a long EMA matches the full-history value the backtest sees', () => {
  // A random-ish walk of 20000 closes; the bot only sees the last warmupBars of them.
  const closes: number[] = [];
  let x = 100;
  for (let i = 0; i < 20_000; i++) closes.push((x *= 1 + 0.01 * Math.sin(i * 12.9898) * Math.cos(i * 0.37)));
  for (const slow of [48, 200, 1000]) {
    const spec = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 12, slow } });
    const n = warmupBars(spec);
    const full = ema(closes, slow).at(-1)!;
    const tail = ema(closes.slice(-n), slow).at(-1)!;
    assert.ok(Math.abs(full - tail) / full < 1e-6, `slow ${slow}: ${n} bars give ${tail} instead of ${full}`);
  }
  const rot = validateSpec({ family: 'rotation_momentum', markets: ['BTC-EUR', 'ETH-EUR'], interval: '1d', params: { lookback: 30, top: 1, regimeSma: 200 } });
  assert.ok(warmupBars(rot) >= 202 && warmupBars(rot) <= 1440, 'rotation only needs its lookback');
});
