import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { beforeEach, mock, test } from 'node:test';
import * as realClient from '../src/bitvavo/client.js';
import * as precision from '../src/bitvavo/precision.js';
import type { OrderIntent } from '../src/bot/logic.js';
import type { OrderRow } from '../src/bot/store.js';
import { INTERVAL_MS, validateSpec, type Candle, type StrategySpec } from '../src/strategies/index.js';

/**
 * The engine's tick against fake brokers, store, settings and market data (no DB, no network).
 * Needs `--experimental-test-module-mocks` (set in the npm test script).
 */

const OPEN = ['pending', 'new', 'partiallyFilled', 'awaitingTrigger'];
const H = 3_600_000;

// ---- fake world ----
let settings: Record<string, unknown> = {};
let botSettings: any;
const listeners: Array<(b: any, a: any) => unknown> = [];
let orders: OrderRow[] = [];
const placed: Array<{ mode: string; intent: OrderIntent; ctx?: any }> = [];
let book = { bid: 400, ask: 401 };
const cancelled: Array<{ mode: string; id: number }> = [];
let candleFailures = 0;
let candleCalls = 0;
/** Bars the newest candle lags behind the bar asked for (a late Bitvavo candle). */
let candleLag = 0;
let onPlace: (() => void) | null = null;
/** Bitvavo has not confirmed the cancel yet: the order stays open in the DB until a later sync. */
let cancelUnconfirmed = false;

function makeCandles(n: number, lastBar: number, rising = true): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = rising ? 100 + i : 100 + 10 * Math.sin(i / 7);
    out.push([lastBar - (n - 1 - i) * H, c, c + 1, c - 1, c, 1]);
  }
  return out;
}

class FakeBroker {
  constructor(readonly mode: 'paper' | 'live') {}
  async balances() {
    return [{ symbol: 'EUR', available: 1000, inOrder: 0 }];
  }
  async place(intent: OrderIntent, ctx?: unknown) {
    placed.push({ mode: this.mode, intent, ctx });
    onPlace?.();
    return null;
  }
  async cancel(o: OrderRow) {
    cancelled.push({ mode: this.mode, id: o.id });
    if (cancelUnconfirmed) return false;
    o.status = 'canceled';
    return true;
  }
  async sync() {
    return 0;
  }
}

mock.module('../src/settings.js', {
  exports: {
    getBotSettings: async () => structuredClone(botSettings),
    getSetting: async (k: string) => structuredClone(settings[k]),
    setSetting: async (k: string, v: unknown) => {
      settings[k] = structuredClone(v);
    },
    onSettingsChange: (fn: (b: any, a: any) => unknown) => listeners.push(fn),
    updateBotSettings: async (patch: Record<string, unknown>) => {
      const before = structuredClone(botSettings);
      botSettings = { ...botSettings, ...patch };
      for (const fn of listeners) await fn(before, structuredClone(botSettings));
      return structuredClone(botSettings);
    },
  },
});
mock.module('../src/bot/store.js', {
  exports: {
    isOpenStatus: (s: string) => OPEN.includes(s),
    openOrders: async (mode: string, market?: string) => orders.filter((o) => o.mode === mode && OPEN.includes(o.status) && (!market || o.market === market)),
    fillsAfter: async () => [],
    fillsFor: async () => [],
    maxFillId: async () => 0,
    updateOrder: async (id: number, _patch: unknown, meta?: Record<string, unknown>) => {
      const o = orders.find((x) => x.id === id);
      if (o && meta) o.meta = { ...o.meta, ...meta };
    },
    chaseLeftovers: async (mode: string, since: number) =>
      orders.filter((o) => o.mode === mode && o.status === 'canceled' && (o.meta.chaseCancelAt ?? 0) > since && !o.meta.chaseDone),
  },
});
mock.module('../src/bot/live.js', { exports: { LiveBroker: class extends FakeBroker { constructor() { super('live'); } } } });
mock.module('../src/bot/paper.js', {
  exports: {
    PaperBroker: class extends FakeBroker { constructor() { super('paper'); } },
    getWallet: async () => ({ EUR: 1000 }),
    resetPaperWallet: async () => undefined,
  },
});
const btcRules = precision.parseMarketRules({ market: 'BTC-EUR', status: 'trading', base: 'BTC', quote: 'EUR', quantityDecimals: 8, notionalDecimals: 2, tickSize: '0.01', minOrderInQuoteAsset: '5' });
const ethRules = { ...btcRules, market: 'ETH-EUR', base: 'ETH' };
mock.module('../src/bot/marketData.js', {
  exports: {
    allPrices: async () => new Map([['BTC-EUR', 400], ['ETH-EUR', 400]]),
    bestBidAsk: async () => book,
    eurPrice: (s: string, p: Map<string, number>) => (s === 'EUR' ? 1 : p.get(`${s}-EUR`) ?? 0),
    marketRules: async () => new Map([['BTC-EUR', btcRules], ['ETH-EUR', ethRules]]),
    closedCandles: async (_m: string, _i: string, lastBar: number, opts: { bars: number }) => {
      candleCalls++;
      if (candleFailures > 0) {
        candleFailures--;
        throw new Error('candles: network error');
      }
      return makeCandles(Math.min(opts.bars, 400), lastBar - candleLag * INTERVAL_MS[_i as keyof typeof INTERVAL_MS]);
    },
  },
});
const fakeClient = { hasKeys: true, balance: async () => [], syncTime: async () => 0, ordersOpen: async () => [] };
mock.module('../src/bitvavo/index.js', { exports: { ...realClient, ...precision, bitvavo: fakeClient } });
mock.module('../src/db.js', { exports: { query: async () => ({ rows: [] }) } });
mock.module('../src/log.js', { exports: { log: async () => undefined, errText: (e: unknown) => (e instanceof Error ? e.message : String(e)) } });

/** Runs code outside the tick's async context, like an API request arriving while a tick runs. */
const outside = AsyncLocalStorage.snapshot();
const engine = await import('../src/bot/engine.js');
const { tick, status, switchOff, start, stop, staleGraceMs } = engine;

const ema = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 2, slow: 5 }, execution: { orderType: 'market' } });
const rot = validateSpec({ family: 'rotation_momentum', markets: ['BTC-EUR', 'ETH-EUR'], interval: '1h', params: { lookback: 3, top: 2 }, execution: { orderType: 'market' } });

function reset(spec: StrategySpec, enabled = true, mode: 'paper' | 'live' = 'paper') {
  settings = {};
  orders = [];
  placed.length = 0;
  cancelled.length = 0;
  candleFailures = 0;
  candleLag = 0;
  candleCalls = 0;
  onPlace = null;
  cancelUnconfirmed = false;
  botSettings = { enabled, mode, strategy: spec, maxExposureEur: null, dailyLossLimit: { unit: 'eur', value: 100 }, fees: { maker: 0.0015, taker: 0.0025 }, paperStartEur: 1000 };
  status.startupDone = true;
  status.lastIdleRefresh = Date.now();
}

function order(id: number, mode: 'paper' | 'live', status = 'new'): OrderRow {
  return {
    id, mode, clientOrderId: `stonks-${id}`, exchangeOrderId: null, market: 'BTC-EUR', side: 'buy', orderType: 'limit', price: 100, amount: 1,
    filledAmount: 0, filledQuote: 0, feePaid: 0, feeCurrency: null, status, strategyId: null, reason: null,
    meta: { uuid: String(id), activeFrom: 0, expiresAt: null, fallback: 'cancel', postOnly: true }, createdAt: new Date(),
  };
}

// The listener is registered by start(); stop() right away so no timers run during the tests.
start();
stop();
let stray = 0;
beforeEach(() => {
  // cancelStray retries at most once a minute; give every test a fresh minute.
  stray++;
});

test('a failed candle fetch does not skip the bar: the next tick decides it', async (t) => {
  reset(ema);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T10:30:00Z') + stray * 120_000 });
  candleFailures = 1;
  await tick();
  assert.match(status.lastTickError ?? '', /network error/);
  assert.equal(placed.length, 0);
  await tick();
  assert.equal(status.lastTickError, null);
  assert.equal(placed.length, 1, 'the bar was decided on the retry');
  assert.equal(placed[0].intent.side, 'buy');
  const calls = candleCalls;
  await tick();
  assert.equal(candleCalls, calls, 'and only once');
  assert.equal(placed.length, 1);
});

test('a late candle is retried instead of deciding on the previous bar', async (t) => {
  reset(ema);
  // 10 s after a bar closes: its candle may simply not be published yet.
  const step = INTERVAL_MS[ema.interval];
  const t0 = Math.ceil((Date.parse('2026-10-26T10:30:00Z') + stray * 120_000) / step) * step + 10_000;
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  candleLag = 1;
  await tick();
  assert.equal(placed.length, 0, 'the newest candle is the previous bar: wait');
  candleLag = 0;
  await tick();
  assert.equal(placed.length, 1, 'decided once the candle is there');
});

test('a candle that never arrives is decided on the newest one after the grace period', async (t) => {
  reset(ema);
  // 10 s after a bar closes: its candle may simply not be published yet.
  const step = INTERVAL_MS[ema.interval];
  const t0 = Math.ceil((Date.parse('2026-10-26T10:30:00Z') + stray * 120_000) / step) * step + 10_000;
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  candleLag = 1;
  await tick();
  assert.equal(placed.length, 0);
  t.mock.timers.setTime(t0 + staleGraceMs(ema.interval) + 1_000);
  await tick();
  assert.equal(placed.length, 1, 'after the grace period it decides anyway');
});

test('switching off during a tick stops the orders that tick had not placed yet', async (t) => {
  reset(rot);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T10:30:00Z') + stray * 120_000 });
  let off: Promise<unknown> | null = null;
  onPlace = () => {
    // The owner presses Stop while the first of two buys is being sent.
    if (!off) off = outside(() => switchOff('owner pressed stop'));
  };
  await tick();
  await off;
  assert.equal(placed.length, 1, `placed ${placed.map((p) => p.intent.market).join(', ')}`);
  assert.equal(botSettings.enabled, false);
});

test('orders still open while the bot is off are cancelled on a later tick (stray orders)', async (t) => {
  reset(ema, false, 'live');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T10:30:00Z') + stray * 120_000 });
  orders = [order(1, 'live', 'pending'), order(2, 'paper'), order(3, 'live', 'filled')];
  await tick();
  assert.deepEqual(cancelled.map((c) => `${c.mode}:${c.id}`).sort(), ['live:1', 'paper:2']);
  assert.equal(placed.length, 0);
});

test('while running live, leftover paper orders are cancelled but live ones are left working', async (t) => {
  reset(ema, true, 'live');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-26T10:30:00Z') + stray * 120_000 });
  orders = [order(1, 'paper'), order(2, 'live')];
  await tick();
  assert.deepEqual(cancelled.map((c) => `${c.mode}:${c.id}`), ['paper:1']);
});

test('dca_dip that ran past its replayable history places nothing instead of restarting the DCA at zero', async (t) => {
  const dca = validateSpec({ family: 'dca_dip', markets: ['BTC-EUR'], interval: '1m', params: { lookback: 30 }, execution: { orderType: 'market' } });
  reset(dca);
  const now = Date.parse('2026-10-26T10:30:00Z') + stray * 120_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  settings.bot_state = { paper: { locks: {}, trail: {}, strategyKey: JSON.stringify(dca), strategyStart: now - (engine.DCA_MAX_BARS + 10) * 60_000 }, live: { locks: {}, trail: {} } };
  await tick();
  assert.equal(placed.length, 0);
  assert.equal(candleCalls, 0);
  assert.ok(engine.dcaBarsNeeded(dca, now - 1000 * 60_000, now) < engine.DCA_MAX_BARS);
});

test('a manual "move everything to ETH" places one post-only limit buy for the whole cash, without candles', async (t) => {
  reset(ema);
  botSettings.manual = { target: 'ETH', setAt: '2026-10-27T12:00:00Z' };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T12:00:30Z') + stray * 120_000 });
  await tick();
  assert.equal(status.lastTickError, null);
  assert.equal(candleCalls, 0, 'a manual move needs no strategy candles');
  assert.equal(placed.length, 1);
  const o = placed[0].intent;
  assert.equal(o.market, 'ETH-EUR');
  assert.equal(o.side, 'buy');
  assert.equal(o.orderType, 'limit');
  assert.equal(o.postOnly, true);
  assert.ok(o.valueEur > 990 && o.valueEur <= 1000, `whole cash minus room for the fee, got ${o.valueEur}`);
  assert.equal(engine.manualSpec(botSettings.manual).interval, '1m');
  assert.deepEqual(engine.manualWeights({ target: 'EUR', setAt: '' }), { 'BTC-EUR': 0, 'ETH-EUR': 0 });
});

// ---- order-book chase (settings.chase) ----
function chased(id: number, over: Partial<OrderRow> & { since: number; active: number }): OrderRow {
  const o = order(id, 'paper');
  return { ...o, price: 399, amount: 1, ...over, meta: { ...o.meta, activeFrom: over.active, chaseSince: over.since } } as OrderRow;
}
const CHASE = { repriceSec: 30, marketAfterMin: 10 };

test('chase: a limit buy left behind by the book is re-placed one tick over the best bid after 30 s, keeping the chain', async (t) => {
  reset(ema, false);
  botSettings.enabled = true;
  botSettings.chase = CHASE;
  const now = Date.parse('2026-10-27T12:00:40Z') + stray * 120_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  // decide nothing new this tick: the bar was already decided
  settings.bot_state = { paper: { locks: {}, trail: {}, lastDecidedBar: now, strategyKey: JSON.stringify(ema), strategyStart: now - 3600_000 }, live: { locks: {}, trail: {} } };
  book = { bid: 400.5, ask: 401 };
  orders = [chased(41, { since: now - 40_000, active: now - 40_000, market: 'BTC-EUR' })];
  await tick();
  assert.equal(status.lastTickError, null);
  assert.deepEqual(cancelled.map((c) => c.id), [41]);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].intent.orderType, 'limit');
  assert.equal(placed[0].intent.price, '400.51');
  assert.equal(placed[0].intent.amount, '1.00000000');
  assert.match(placed[0].intent.reason, /\(repriced\)$/);
  assert.deepEqual(placed[0].ctx.chase, { since: now - 40_000, root: 41 });
  assert.equal(placed[0].ctx.expiresAt, null);
});

test('chase: a cancel Bitvavo has not confirmed yet is re-placed on a later tick, exactly once', async (t) => {
  reset(ema, false);
  botSettings.enabled = true;
  botSettings.chase = CHASE;
  botSettings.strategy = { ...ema, id: 'chased-strategy' };
  const now = Date.parse('2026-10-27T12:30:40Z') + stray * 120_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  settings.bot_state = { paper: { locks: {}, trail: {}, lastDecidedBar: now, strategyKey: JSON.stringify(botSettings.strategy), strategyStart: now - 3600_000 }, live: { locks: {}, trail: {} } };
  book = { bid: 400.5, ask: 401 };
  orders = [{ ...chased(45, { since: now - 40_000, active: now - 40_000, market: 'BTC-EUR' }), strategyId: 'chased-strategy' }];
  cancelUnconfirmed = true;
  await tick();
  assert.deepEqual(cancelled.map((c) => c.id), [45]);
  assert.equal(placed.length, 0, 'nothing re-placed while the cancel is unconfirmed');
  // the next sync reads the order back as cancelled
  orders[0].status = 'canceled';
  t.mock.timers.setTime(now + 15_000);
  await tick();
  assert.equal(placed.length, 1);
  assert.equal(placed[0].intent.price, '400.51');
  assert.deepEqual(placed[0].ctx.chase, { since: now - 40_000, root: 45 });
  await tick();
  assert.equal(placed.length, 1, 'never placed twice');
});

test('chase: an order that is itself the best bid keeps its place; younger than 30 s is left alone', async (t) => {
  reset(ema, false);
  botSettings.enabled = true;
  botSettings.chase = CHASE;
  const now = Date.parse('2026-10-27T13:00:40Z') + stray * 120_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  settings.bot_state = { paper: { locks: {}, trail: {}, lastDecidedBar: now, strategyKey: JSON.stringify(ema), strategyStart: now - 3600_000 }, live: { locks: {}, trail: {} } };
  book = { bid: 399, ask: 400 };
  orders = [chased(42, { since: now - 60_000, active: now - 60_000 }), chased(43, { since: now - 10_000, active: now - 10_000, price: 380 })];
  await tick();
  assert.equal(cancelled.length, 0);
  assert.equal(placed.length, 0);
});

test('chase: after 10 minutes the unfilled rest of a buy goes out at market, sized to the free cash', async (t) => {
  reset(ema, false);
  botSettings.enabled = true;
  botSettings.chase = CHASE;
  const now = Date.parse('2026-10-27T14:00:40Z') + stray * 120_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  settings.bot_state = { paper: { locks: {}, trail: {}, lastDecidedBar: now, strategyKey: JSON.stringify(ema), strategyStart: now - 3600_000 }, live: { locks: {}, trail: {} } };
  book = { bid: 400, ask: 401 };
  orders = [chased(44, { since: now - 10 * 60_000 - 1, active: now - 20_000, amount: 3, filledAmount: 0.5 })];
  await tick();
  assert.deepEqual(cancelled.map((c) => c.id), [44]);
  const o = placed[0].intent;
  assert.equal(o.orderType, 'market');
  assert.equal(o.side, 'buy');
  // 2.5 BTC wanted at 401 = 1002.5, but 1000 EUR cash keeps taker fee + slippage + margin free
  assert.ok(Number(o.amountQuote) <= 1000 / (1 + 0.0025 + 0.0005 + 0.001) + 0.01 && Number(o.amountQuote) > 990, String(o.amountQuote));
  assert.equal(placed[0].ctx.chase, undefined);
});

test('chase: new limit orders from a decision start one tick over the live best bid and carry the chase start, no bar timeout', async (t) => {
  reset(ema);
  // even with an old stored `enabled: false`, limit orders follow the book
  botSettings.chase = { ...CHASE, enabled: false };
  book = { bid: 412.3, ask: 413 };
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T15:30:00Z') + stray * 120_000 });
  const lim = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 2, slow: 5 } });
  botSettings.strategy = lim;
  await tick();
  assert.equal(placed.length, 1);
  assert.equal(placed[0].intent.orderType, 'limit');
  assert.equal(placed[0].ctx.expiresAt, null);
  assert.equal(placed[0].ctx.chase.root, null);
  assert.ok(placed[0].ctx.chase.since > 0);
  assert.equal(Number(placed[0].intent.price), 412.31);
});
