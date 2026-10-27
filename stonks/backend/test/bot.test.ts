import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarketRules } from '../src/bitvavo/precision.js';
import {
  cashDelta,
  checkDay,
  paperLimitFills,
  paperMarketPrice,
  planOrders,
  postOnlyPrice,
  replayPosition,
  stopHit,
  type PlanInput,
} from '../src/bot/logic.js';
import { amsterdamDay, barOpen, lastClosedBar } from '../src/bot/time.js';
import { validateSpec } from '../src/strategies/index.js';

const btc = parseMarketRules({
  market: 'BTC-EUR', status: 'trading', base: 'BTC', quote: 'EUR', minOrderInBaseAsset: '0.00006942', minOrderInQuoteAsset: '5.00',
  maxOrderInBaseAsset: '13884', quantityDecimals: 8, notionalDecimals: 2, tickSize: '1.00',
});
const eth = parseMarketRules({
  market: 'ETH-EUR', status: 'trading', base: 'ETH', quote: 'EUR', minOrderInBaseAsset: '0.001', minOrderInQuoteAsset: '5.00',
  maxOrderInBaseAsset: '10000', quantityDecimals: 4, notionalDecimals: 2, tickSize: '0.01',
});
const fees = { maker: 0.0015, taker: 0.0025 };
const single = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h' });

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    spec: single, targets: { 'BTC-EUR': 1 }, equityEur: 1000, cashAvailableEur: 1000,
    holdings: {}, prices: { 'BTC-EUR': 50_000 }, rules: { 'BTC-EUR': btc, 'ETH-EUR': eth },
    maxExposureEur: null, otherCoinsEur: 0, openSides: {}, fees, ...over,
  };
}

test('executor: full buy is a post-only limit 5 bps under the close, sized to cash after the taker fee Bitvavo reserves', () => {
  const p = planOrders(input());
  assert.equal(p.orders.length, 1);
  const o = p.orders[0];
  assert.equal(o.side, 'buy');
  assert.equal(o.orderType, 'limit');
  assert.equal(o.postOnly, true);
  assert.equal(o.price, '49975.00'); // 50000 * (1 - 0.0005), rounded down to the 1.00 tick
  // Bitvavo holds back the taker fee (0.25 %) even on a post-only limit buy, plus a 0.1 % margin for rounding (code 216 otherwise)
  const spend = 1000 / 1.0035;
  assert.equal(o.amount, (Math.floor((spend / 49975) * 1e8) / 1e8).toFixed(8));
  assert.ok(Number(o.amount) * 49975 * 1.0025 <= 1000);
});

test('executor: churn threshold of max(€5, 2 % of equity), but target 0 always exits the whole free position', () => {
  // Holding 0.0196 BTC = €980 of €1000 equity: diff €20 = 2 % -> trades; €19 does not.
  const at = (btcQty: number, cash: number) =>
    planOrders(input({ holdings: { 'BTC-EUR': { total: btcQty, available: btcQty } }, cashAvailableEur: cash, equityEur: btcQty * 50_000 + cash }));
  assert.equal(at(0.0196, 20).orders.length, 1);
  assert.equal(at(0.01962, 19).orders.length, 0);
  // Small account: €5 floor dominates.
  const small = planOrders(input({ equityEur: 100, cashAvailableEur: 4.5, holdings: { 'BTC-EUR': { total: 0.00191, available: 0.00191 } } }));
  assert.equal(small.orders.length, 0);
  // Exit: even a 1.5 % position is sold completely when the target is 0.
  const exit = planOrders(input({ targets: { 'BTC-EUR': 0 }, holdings: { 'BTC-EUR': { total: 0.0003, available: 0.0003 } }, cashAvailableEur: 985 }));
  assert.equal(exit.orders.length, 1);
  assert.equal(exit.orders[0].side, 'sell');
  assert.equal(exit.orders[0].amount, '0.00030000');
  assert.equal(exit.orders[0].price, '50025.00'); // rounded up for sells
  // Dust under the minimum order is left alone with a note.
  const dust = planOrders(input({ targets: { 'BTC-EUR': 0 }, holdings: { 'BTC-EUR': { total: 0.00005, available: 0.00005 } } }));
  assert.equal(dust.orders.length, 0);
  assert.match(dust.notes[0].note, /minimum/);
});

test('executor: partial rebalance sells only the excess and never more than is free', () => {
  const half = validateSpec({ ...single, risk: { maxWeight: 0.5 } });
  const p = planOrders(input({ spec: half, targets: { 'BTC-EUR': 0.5 }, holdings: { 'BTC-EUR': { total: 0.02, available: 0.004 } }, cashAvailableEur: 0 }));
  // equity 1000 (0.02 BTC); target €500 -> sell €500 = 0.01 BTC, but only 0.004 is free
  assert.equal(p.orders[0].side, 'sell');
  assert.equal(p.orders[0].amount, '0.00400000');
});

test('executor: maxExposureEur caps coins (other coins count), cash shortfall scales buys', () => {
  const capped = planOrders(input({ maxExposureEur: 300, otherCoinsEur: 100 }));
  assert.ok(Math.abs(capped.orders[0].valueEur - 200) < 1);
  const rot = validateSpec({ family: 'rotation_momentum', markets: ['BTC-EUR', 'ETH-EUR'], interval: '1d', params: { top: 2 } });
  const p = planOrders(input({ spec: rot, targets: { 'BTC-EUR': 0.5, 'ETH-EUR': 0.5 }, prices: { 'BTC-EUR': 50_000, 'ETH-EUR': 2000 }, cashAvailableEur: 500 }));
  assert.equal(p.orders.length, 2);
  const total = p.orders.reduce((s, o) => s + o.valueEur * 1.0015, 0);
  assert.ok(total <= 500 && total > 495, String(total));
  assert.ok(p.notes.some((n) => /cash covers 50 %/.test(n.note)));
});

test('executor: working orders are not doubled; opposite ones are cancelled first', () => {
  const same = planOrders(input({ openSides: { 'BTC-EUR': ['buy'] } }));
  assert.equal(same.orders.length, 0);
  const opposite = planOrders(input({ openSides: { 'BTC-EUR': ['sell'] } }));
  assert.deepEqual(opposite.cancelMarkets, ['BTC-EUR']);
  assert.equal(opposite.orders.length, 1);
  const halted = planOrders(input({ rules: { 'BTC-EUR': { ...btc, status: 'halted' } } }));
  assert.equal(halted.orders.length, 0);
});

test('executor: market orders buy with amountQuote and keep room for taker fee + slippage', () => {
  const m = validateSpec({ ...single, execution: { orderType: 'market' } });
  const p = planOrders(input({ spec: m }));
  assert.equal(p.orders[0].orderType, 'market');
  assert.equal(p.orders[0].amount, undefined);
  assert.equal(p.orders[0].amountQuote, (Math.floor((1000 / 1.004) * 100) / 100).toFixed(2));
});

test('executor: a full buy of a 439.86 EUR account leaves the taker fee free (Bitvavo code 216 on 2026-10-27)', () => {
  const p = planOrders(input({ cashAvailableEur: 439.86, equityEur: 439.86, prices: { 'BTC-EUR': 72379 } }));
  const o = p.orders[0];
  assert.ok(Number(o.amount) * Number(o.price) * 1.0025 <= 439.86, `${o.amount} x ${o.price} plus the taker fee must fit`);
});

test('post-only repricing joins the best maker price', () => {
  const book = { bid: 50_000, ask: 50_001 };
  assert.equal(postOnlyPrice('buy', '50005.00', book, btc), '50000.00');
  assert.equal(postOnlyPrice('buy', '49990.00', book, btc), '49990.00');
  assert.equal(postOnlyPrice('sell', '49999.00', book, btc), '50001.00');
  assert.equal(postOnlyPrice('sell', '50010.00', book, btc), '50010.00');
});

test('paper fill rules: strictly through the price, market at the touch + 5 bps, fees in EUR', () => {
  assert.equal(paperLimitFills('buy', 100, 100, 105), false); // touching is not enough
  assert.equal(paperLimitFills('buy', 100, 99.99, 105), true);
  assert.equal(paperLimitFills('sell', 100, 95, 100), false);
  assert.equal(paperLimitFills('sell', 100, 95, 100.01), true);
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(paperMarketPrice('buy', { bid: 99, ask: 100 }), 100.05);
  near(paperMarketPrice('sell', { bid: 100, ask: 101 }), 99.95);
  const b = cashDelta('buy', 2, 100, 0.0015);
  near(b.quote, 200);
  near(b.fee, 0.3);
  near(b.eur, -200.3);
  const s = cashDelta('sell', 2, 100, 0.0025);
  near(s.fee, 0.5);
  near(s.eur, 199.5);
});

test('positions: average entry is the average fill price and resets when flat', () => {
  const f = (id: number, side: 'buy' | 'sell', amount: number, price: number, fee = 0) =>
    ({ id, market: 'BTC-EUR', side, amount, quote: amount * price, fee, feeCurrency: 'EUR' });
  const p = replayPosition([f(1, 'buy', 1, 100, 0.15), f(2, 'buy', 1, 200, 0.3), f(3, 'sell', 1, 300)]);
  assert.equal(p.qty, 1);
  assert.ok(Math.abs(p.avgEntry - 150) < 1e-9);
  assert.equal(p.openedByFill, 1);
  const q = replayPosition([f(1, 'buy', 1, 100), f(2, 'sell', 1, 120), f(3, 'buy', 2, 50)]);
  assert.deepEqual(q, { qty: 2, avgEntry: 50, openedByFill: 3 });
});

test('stops: stop loss, trailing stop and take profit', () => {
  const risk = { maxWeight: 1, stopLossPct: 0.08, takeProfitPct: 0.2, trailingStopPct: 0.1 };
  assert.equal(stopHit(risk, 100, 100, 95), null);
  assert.match(stopHit(risk, 100, 100, 92)!, /stop loss/);
  assert.match(stopHit(risk, 100, 115, 103)!, /trailing/);
  assert.equal(stopHit(risk, 100, 115, 104), null);
  assert.match(stopHit(risk, 100, 120, 120)!, /take profit/);
  assert.equal(stopHit({ ...risk, stopLossPct: null, trailingStopPct: null, takeProfitPct: null }, 100, 200, 1), null);
});

const EUR100 = { unit: 'eur' as const, value: 100 };

test('daily loss guard: trips at the limit, deposits move the baseline, today figure resets at Amsterdam midnight', () => {
  // 2026-10-26 22:59:59Z is 23:59:59 in Amsterdam (CET after the DST change on 25 Oct); one second later is a new day.
  const beforeMidnight = Date.parse('2026-10-26T22:59:59Z');
  assert.equal(amsterdamDay(beforeMidnight), '2026-10-26');
  assert.equal(amsterdamDay(beforeMidnight + 1000), '2026-10-27');
  assert.equal(amsterdamDay(Date.parse('2026-07-01T21:59:59Z')), '2026-07-01'); // CEST
  assert.equal(amsterdamDay(Date.parse('2026-07-01T22:00:00Z')), '2026-07-02');

  const price = (s: string) => (s === 'EUR' ? 1 : s === 'BTC' ? 50_000 : 0);
  const t0 = Date.parse('2026-10-26T08:00:00Z');
  const first = checkDay(undefined, t0, 1000, { EUR: 500, BTC: 0.01 }, price, [], EUR100);
  assert.equal(first.newDay, true);
  assert.equal(first.state.startEquity, 1000);
  assert.equal(first.tripped, false);

  // BTC falls to 40k: equity 900 -> loss 100 >= limit.
  const p40 = (s: string) => (s === 'BTC' ? 40_000 : price(s));
  const down = checkDay(first.state, t0 + 60_000, 900, { EUR: 500, BTC: 0.01 }, p40, [], EUR100);
  assert.equal(down.flowEur, 0);
  assert.ok(Math.abs(down.lossEur - 100) < 1e-9);
  assert.equal(down.tripped, true);
  const almost = checkDay(first.state, t0 + 60_000, 900.01, { EUR: 500.01, BTC: 0.01 }, p40, [], EUR100);
  assert.equal(almost.tripped, false);

  // A trade explains its own quantity changes: buy 0.002 BTC for 100 EUR + 0.15 fee.
  const fill = { id: 7, market: 'BTC-EUR', base: 'BTC', side: 'buy' as const, amount: 0.002, quote: 100, fee: 0.15, feeCurrency: 'EUR' };
  const traded = checkDay(first.state, t0 + 120_000, 999.85, { EUR: 399.85, BTC: 0.012 }, price, [fill], EUR100);
  assert.equal(traded.flowEur, 0);
  assert.equal(traded.state.lastFillId, 7);
  assert.equal(traded.state.startEquity, 1000);

  // A €500 deposit is not profit; a withdrawal is not a loss.
  const dep = checkDay(traded.state, t0 + 180_000, 1499.85, { EUR: 899.85, BTC: 0.012 }, price, [], EUR100);
  assert.ok(Math.abs(dep.flowEur - 500) < 1e-9);
  assert.ok(Math.abs(dep.state.startEquity - 1500) < 1e-9);
  const wd = checkDay(dep.state, t0 + 240_000, 999.85, { EUR: 399.85, BTC: 0.012 }, price, [], EUR100);
  assert.ok(Math.abs(wd.flowEur + 500) < 1e-9);
  assert.equal(wd.tripped, false);

  // Next Amsterdam day: fresh baseline.
  const next = checkDay(wd.state, Date.parse('2026-10-26T23:00:01Z'), 950, { EUR: 350, BTC: 0.012 }, price, [], EUR100);
  assert.equal(next.newCalendarDay, true);
  assert.equal(next.newDay, false);
  assert.equal(next.state.startEquity, 950);
  // ...but the guard still counts from the window start, not from midnight.
  assert.ok(Math.abs(next.baselineEur - (1000 + next.flowEur)) < 1e-9);
});

test('daily loss guard: rolling 24 h window, % or euro limit', () => {
  // One coin whose price is the whole equity, so equity moves are price moves, not deposits.
  const at = (eq: number) => [eq, { BTC: 1 }, (s: string) => (s === 'BTC' ? eq : 1)] as const;
  const pct10 = { unit: 'pct' as const, value: 10 };
  const H = 3_600_000;
  const t0 = Date.parse('2026-10-26T08:00:00Z');
  let st = checkDay(undefined, t0, ...at(1000), [], pct10).state;
  // Equity rises to 2000 over 12 h, sampled every 5 minutes.
  for (let t = t0 + 5 * 60_000; t <= t0 + 12 * H; t += 5 * 60_000) {
    const c = checkDay(st, t, ...at(1000 + ((t - t0) / (12 * H)) * 1000), [], pct10);
    assert.equal(c.flowEur, 0);
    st = c.state;
  }
  // 23 h in: still measured against the first 1000. Losing to 905 is under 10 % of 1000.
  let c = checkDay(st, t0 + 23 * H, ...at(905), [], pct10);
  assert.ok(Math.abs(c.baselineEur - 1000) < 1e-9);
  assert.ok(Math.abs(c.limitEur - 100) < 1e-9);
  assert.equal(c.tripped, false);
  assert.equal(checkDay(st, t0 + 23 * H, ...at(900), [], pct10).tripped, true);
  assert.equal(checkDay(st, t0 + 23 * H, ...at(905), [], { unit: 'eur', value: 90 }).tripped, true);
  st = c.state;
  // 36 h in: the baseline is the equity 24 h earlier (12 h in = 2000), so 1850 is a 7.5 % loss, 1790 trips.
  c = checkDay(st, t0 + 36 * H, ...at(1850), [], pct10);
  assert.ok(Math.abs(c.baselineEur - 2000) < 1e-6);
  assert.ok(Math.abs(c.limitEur - 200) < 1e-6);
  assert.equal(c.tripped, false);
  assert.equal(checkDay(st, t0 + 36 * H, ...at(1790), [], pct10).tripped, true);
  // Samples older than the window are dropped (one kept just before it).
  assert.ok(c.state.samples[1].t > t0 + 12 * H);
  assert.ok(c.state.samples.length <= 24 * 12 + 2);
  // A withdrawal inside the window is not a loss: €400 worth of the coin leaves at 1850.
  const wd = checkDay(c.state, t0 + 36 * H + 60_000, 1450, { BTC: 1450 / 1850 }, (s) => (s === 'BTC' ? 1850 : 1), [], pct10);
  assert.ok(Math.abs(wd.flowEur + 400) < 1e-9);
  assert.ok(Math.abs(wd.baselineEur - 1600) < 1e-6);
  assert.equal(wd.tripped, false);
});

test('daily loss guard: state from before the rolling window keeps its start-of-day baseline', () => {
  const price = (s: string) => (s === 'EUR' ? 1 : 0);
  const old = { day: amsterdamDay(Date.parse('2026-10-27T08:00:00Z')), startEquity: 1000, lastHoldings: { EUR: 950 }, lastFillId: 0 };
  const c = checkDay(old, Date.parse('2026-10-27T09:00:00Z'), 950, { EUR: 950 }, price, [], { unit: 'pct', value: 10 });
  assert.equal(c.baselineEur, 1000);
  assert.equal(c.lossEur, 50);
  assert.equal(c.state.samples.length, 1);
});

test('bar timing: decide only on closed bars, weekly bars start on Monday', () => {
  const H = 3_600_000;
  const t = Date.parse('2026-10-26T10:30:00Z');
  assert.equal(barOpen(t, '1h'), Date.parse('2026-10-26T10:00:00Z'));
  assert.equal(lastClosedBar(t, '1h'), Date.parse('2026-10-26T09:00:00Z'));
  // Right after the close the settle delay keeps the previous bar until Bitvavo has finalized it.
  assert.equal(lastClosedBar(Date.parse('2026-10-26T11:00:02Z'), '1h'), Date.parse('2026-10-26T09:00:00Z'));
  assert.equal(lastClosedBar(Date.parse('2026-10-26T11:00:06Z'), '1h'), Date.parse('2026-10-26T10:00:00Z'));
  assert.equal(barOpen(t, '4h'), Date.parse('2026-10-26T08:00:00Z'));
  assert.equal(barOpen(t, '1W'), 1792972800000); // Monday 2026-10-26, as Bitvavo returns
  assert.equal(barOpen(Date.parse('2026-11-01T23:00:00Z'), '1W'), 1792972800000);
  assert.equal(lastClosedBar(t, '1d'), Date.parse('2026-10-25T00:00:00Z'));
  assert.ok(H > 0);
});
