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
/** The account the fake brokers report. */
let cash = 1000;
let held: Record<string, number> = {};
/** Coins in open orders, per symbol. */
let tickers = new Map([['BTC-EUR', 400], ['ETH-EUR', 400]]);
/** Thrown by balances() (a Bitvavo outage). */
let balanceError: Error | null = null;
/** place(): null = refused, 'open' = a working order row, default = what the existing tests expect (nothing back). */
let placeResult: 'open' | null = null;
let nextOrderId = 1000;
let positions: Record<string, Array<Record<string, unknown>>> = {};
let depth: { bids: Array<[number, number]>; asks: Array<[number, number]> } | null = null;
/** While set, a tick hangs on its first read. */
let hangSettings: Promise<void> | null = null;
let clockSyncs = 0;
let unknownChecks = 0;
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
    if (balanceError) throw balanceError;
    return [{ symbol: 'EUR', available: cash, inOrder: 0 }, ...Object.entries(held).map(([symbol, available]) => ({ symbol, available, inOrder: 0 }))];
  }
  async place(intent: OrderIntent, ctx?: unknown) {
    placed.push({ mode: this.mode, intent, ctx });
    onPlace?.();
    if (placeResult !== 'open') return null;
    const o = { ...order(nextOrderId++, this.mode as 'paper' | 'live'), market: intent.market, side: intent.side, orderType: intent.orderType };
    orders.push(o);
    return o;
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
    getBotSettings: async () => {
      if (hangSettings) await hangSettings;
      return structuredClone(botSettings);
    },
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
    fillsFor: async (_mode: string, market: string) => positions[market] ?? [],
    maxFillId: async () => 0,
    unknownOrders: async () => [],
    updateOrder: async (id: number, _patch: unknown, meta?: Record<string, unknown>) => {
      const o = orders.find((x) => x.id === id);
      if (o && meta) o.meta = { ...o.meta, ...meta };
    },
    chaseLeftovers: async (mode: string, since: number) =>
      orders.filter((o) => o.mode === mode && o.status === 'canceled' && (o.meta.chaseCancelAt ?? 0) > since && !o.meta.chaseDone),
  },
});
mock.module('../src/bot/live.js', {
  exports: {
    LiveBroker: class extends FakeBroker {
      constructor() {
        super('live');
      }
      async recheckUnknown() {
        unknownChecks++;
        return 0;
      }
    },
  },
});
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
    allPrices: async () => {
      if (tickers.size === 0) throw new Error('ticker: network error');
      return tickers;
    },
    bestBidAsk: async () => book,
    bookDepth: async () => {
      if (!depth) throw new Error('book: network error');
      return depth;
    },
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
const fakeClient = {
  hasKeys: true,
  balance: async () => [],
  syncTime: async () => {
    clockSyncs++;
    return 0;
  },
  ordersOpen: async () => [],
};
mock.module('../src/bitvavo/index.js', { exports: { ...realClient, ...precision, bitvavo: fakeClient } });
mock.module('../src/db.js', { exports: { query: async () => ({ rows: [] }) } });
// A lab family whose answer the tests script (SPEC §6b).
let labAnswer: unknown = { t: null, weights: {} };
let labHash: string | undefined;
const labFamily = { family: 'moon_core', title: 'Moon', summary: '', version: 1, multiMarket: true, anchored: false, params: [] };
mock.module('../src/strategies/python.js', {
  exports: {
    pyFamilies: () => new Map([['moon_core', labFamily]]),
    targetsPy: async () => labAnswer,
    cachedExplanation: () => undefined,
    describePy: async () => ({ error: null, markets: [], anchored: false, explanation: '' }),
    preparePy: () => undefined,
    codeHashOf: () => labHash,
  },
});
const logs: Array<{ level: string; event: string; message: string; data?: any }> = [];
const logged = (event: string) => logs.filter((l) => l.event === event);
mock.module('../src/log.js', { exports: { log: async (level: string, event: string, message: string, data?: unknown) => void logs.push({ level, event, message, data }), errText: (e: unknown) => (e instanceof Error ? e.message : String(e)) } });

/** Runs code outside the tick's async context, like an API request arriving while a tick runs. */
const outside = AsyncLocalStorage.snapshot();
const engine = await import('../src/bot/engine.js');
const { barOpen } = await import('../src/bot/time.js');
const { tick, status, switchOff, start, stop, staleGraceMs } = engine;

const ema = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 2, slow: 5 }, execution: { orderType: 'market' } });
const rot = validateSpec({ family: 'rotation_momentum', markets: ['BTC-EUR', 'ETH-EUR'], interval: '1h', params: { lookback: 3, top: 2 }, execution: { orderType: 'market' } });

function reset(spec: StrategySpec, enabled = true, mode: 'paper' | 'live' = 'paper') {
  settings = {};
  orders = [];
  placed.length = 0;
  cancelled.length = 0;
  logs.length = 0;
  labAnswer = { t: null, weights: {} };
  cash = 1000;
  held = {};
  tickers = new Map([['BTC-EUR', 400], ['ETH-EUR', 400]]);
  balanceError = null;
  placeResult = null;
  positions = {};
  depth = null;
  book = { bid: 400, ask: 401 };
  candleFailures = 0;
  candleLag = 0;
  candleCalls = 0;
  onPlace = null;
  cancelUnconfirmed = false;
  botSettings = { enabled, mode, strategy: spec, maxExposureEur: null, dailyLossLimit: { unit: 'eur', value: 100, action: 'stop' }, fees: { maker: 0.0015, taker: 0.0025 }, paperStartEur: 1000 };
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

// ---- hold contract (SPEC §6b) ----
const lab = { ...validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', execution: { orderType: 'market' } }), family: 'moon_core', familyVersion: 1 } as StrategySpec;
const lastBar = (now: number) => barOpen(now - 5_000, '1h') - INTERVAL_MS['1h'];
const barStart = (ms: number) => Math.ceil(ms / INTERVAL_MS['1h']) * INTERVAL_MS['1h'];

test('lab code that changes without a VERSION bump is reported once and trading goes on', async (t) => {
  reset(lab);
  t.mock.timers.enable({ apis: ['Date'], now: barStart(Date.parse('2026-10-28T10:30:00Z') + stray * 120_000) + 10_000 });
  labAnswer = { hold: 'not relevant here' };
  labHash = 'aaa';
  await tick();
  await tick();
  assert.equal(logged('family_code_changed').length, 0);
  labHash = 'bbb';
  await tick();
  await tick();
  assert.equal(logged('family_code_changed').length, 1);
  assert.equal(status.lastTickError, null);
  labHash = undefined;
});

test('hold: the lab cannot decide: nothing is placed, it asks again, and after the grace period the bar is given up', async (t) => {
  reset(lab);
  const t0 = barStart(Date.parse('2026-10-28T10:30:00Z') + stray * 120_000) + 10_000;
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  labAnswer = { hold: 'candle store is behind' };
  await tick();
  assert.equal(status.lastTickError, null);
  assert.equal(placed.length, 0);
  assert.equal(logged('decision_held').length, 0, 'still retrying');
  t.mock.timers.setTime(t0 + staleGraceMs('1h') + 1_000);
  await tick();
  assert.equal(placed.length, 0);
  assert.equal(logged('decision_held').length, 1);
  assert.match(logged('decision_held')[0].message, /candle store is behind/);
  await tick();
  assert.equal(logged('decision_held').length, 1, 'once per bar');
});

test('hold: a hold that clears within the grace period decides the bar normally', async (t) => {
  reset(lab);
  const t0 = barStart(Date.parse('2026-10-28T12:30:00Z') + stray * 120_000) + 10_000;
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  labAnswer = { hold: 'busy', t: null };
  await tick();
  assert.equal(placed.length, 0);
  labAnswer = { t: lastBar(t0), weights: { 'BTC-EUR': 1 } };
  await tick();
  assert.equal(placed.length, 1);
});

test('hold: { t: null } with zero weights never sells', async (t) => {
  reset(lab);
  held = { BTC: 1 };
  const t0 = barStart(Date.parse('2026-10-28T14:30:00Z') + stray * 120_000) + 10_000;
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  labAnswer = { t: null, weights: { 'BTC-EUR': 0 } };
  await tick();
  assert.equal(status.lastTickError, null);
  assert.equal(placed.length, 0);
  t.mock.timers.setTime(t0 + staleGraceMs('1h') + 1_000);
  await tick();
  assert.equal(placed.length, 0);
  assert.equal(logged('decision_held').length, 1);
});

// ---- helpers for the account-level tests below ----
const stateOf = () => (settings.bot_state as any).paper;
/** A tick time well inside a bar, unique per test. */
const midBar = (base: string) => Date.parse(base) + stray * 2 * INTERVAL_MS['1h'];
/** Stored state for a strategy already running, with this bar decided. */
function running(spec: StrategySpec, now: number, extra: Record<string, unknown> = {}) {
  settings.bot_state = { paper: { locks: {}, trail: {}, lastDecidedBar: lastBar(now), strategyKey: JSON.stringify(spec), strategyStart: now - 86_400_000, ...extra }, live: { locks: {}, trail: {} } };
}

// ---- loss guard action (SPEC §5) ----
test('guard no_buys: logged once, open buys cancelled, new buys withheld with notes, sells go on, then cleared', async (t) => {
  reset(rot);
  botSettings.dailyLossLimit = { unit: 'eur', value: 100, action: 'no_buys' };
  const now = midBar('2026-11-01T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  cash = 0;
  held = { BTC: 1 };
  tickers = new Map([['BTC-EUR', 1000], ['ETH-EUR', 400]]);
  running(rot, now);
  await tick();
  assert.equal(logged('daily_loss_limit').length, 0);
  orders = [{ ...order(70, 'paper'), side: 'buy' }, { ...order(71, 'paper'), side: 'sell' }];
  tickers = new Map([['BTC-EUR', 850], ['ETH-EUR', 400]]);
  t.mock.timers.setTime(now + 15_000);
  await tick();
  assert.equal(status.lastTickError, null);
  assert.equal(logged('daily_loss_limit').length, 1);
  assert.equal(logged('daily_loss_limit')[0].level, 'error');
  assert.equal(botSettings.enabled, true, 'the bot stays on');
  assert.deepEqual(cancelled.map((c) => c.id), [70], 'buys only');
  assert.equal(engine.lastGuardState.paper?.action, 'no_buys');
  assert.equal((await engine.guardStatus('paper'))?.action, 'no_buys');
  await tick();
  assert.equal(logged('daily_loss_limit').length, 1, 'once per trip');
  // a new bar: the decision is logged, its buy withheld
  cash = 500;
  orders = [];
  t.mock.timers.setTime(now + INTERVAL_MS['1h']);
  await tick();
  assert.equal(status.lastTickError, null);
  assert.ok(placed.every((p) => p.intent.side === 'sell'), 'no buy placed');
  const d = logged('decision').at(-1)!;
  assert.ok(d.data.notes.some((n: { note: string }) => /withheld by the loss guard/.test(n.note)), JSON.stringify(d.data.notes));
  // recovered: cleared once, and the withheld buy of this bar goes out through the retry path
  tickers = new Map([['BTC-EUR', 1000], ['ETH-EUR', 400]]);
  t.mock.timers.setTime(now + INTERVAL_MS['1h'] + 61_000);
  await tick();
  assert.equal(logged('guard_cleared').length, 1);
  assert.equal(await engine.guardStatus('paper'), null);
  assert.ok(placed.some((p) => p.intent.side === 'buy'), 'the buy is released');
  // tripping again logs again
  tickers = new Map([['BTC-EUR', 850], ['ETH-EUR', 400]]);
  t.mock.timers.setTime(now + INTERVAL_MS['1h'] + 76_000);
  await tick();
  assert.equal(logged('daily_loss_limit').length, 2, 're-armed');
});

test('guard alert only logs; stop switches the bot off as before', async (t) => {
  for (const action of ['alert', 'stop']) {
    reset(ema);
    botSettings.dailyLossLimit = { unit: 'eur', value: 100, action };
    const now = midBar('2026-11-02T10:30:00Z');
    t.mock.timers.enable({ apis: ['Date'], now });
    cash = 0;
    held = { BTC: 1 };
    tickers = new Map([['BTC-EUR', 1000]]);
    running(ema, now);
    await tick();
    orders = [{ ...order(72, 'paper'), side: 'buy' }];
    tickers = new Map([['BTC-EUR', 800]]);
    t.mock.timers.setTime(now + 15_000);
    await tick();
    assert.equal(logged('daily_loss_limit').length, 1);
    assert.equal(botSettings.enabled, action === 'alert');
    t.mock.timers.reset();
    if (action === 'alert') assert.equal(cancelled.length, 0);
    else assert.deepEqual(cancelled.map((c) => c.id), [72]);
  }
});

test('guard: a coin without a ticker keeps its last known price, and zero equity never trips', async (t) => {
  reset(ema);
  const now = midBar('2026-11-03T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  cash = 0;
  held = { BTC: 1 };
  tickers = new Map([['BTC-EUR', 1000], ['ETH-EUR', 400]]);
  running(ema, now);
  await tick();
  tickers = new Map([['ETH-EUR', 400]]); // BTC's ticker is gone
  t.mock.timers.setTime(now + 15_000);
  await tick();
  assert.equal(status.lastTickError, null);
  assert.equal(logged('daily_loss_limit').length, 0);
  assert.equal(engine.cachedPortfolio('paper')!.equityEur, 1000);
  assert.equal(stateOf().knownPrices.BTC, 1000);
  held = {}; // a read that comes back empty
  t.mock.timers.setTime(now + 30_000);
  await tick();
  assert.equal(logged('daily_loss_limit').length, 0);
  assert.equal(botSettings.enabled, true);
});

test('guard: a failed Bitvavo tick still runs it on the last known numbers, and says so after a while', async (t) => {
  reset(ema);
  botSettings.dailyLossLimit = { unit: 'eur', value: 100, action: 'stop' };
  const now = midBar('2026-11-04T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  cash = 0;
  held = { BTC: 1 };
  tickers = new Map([['BTC-EUR', 1000]]);
  running(ema, now);
  await tick();
  balanceError = new Error('balance: network error');
  t.mock.timers.setTime(now + 15_000);
  await tick();
  assert.match(status.lastTickError ?? '', /balance/);
  assert.equal(logged('guard_blind').length, 0);
  t.mock.timers.setTime(now + 6 * 60_000);
  await tick();
  assert.equal(logged('guard_blind').length, 1);
  await tick();
  assert.equal(logged('guard_blind').length, 1, 'once per outage');
  tickers = new Map([['BTC-EUR', 800]]);
  await tick();
  assert.equal(logged('daily_loss_limit').length, 1, 'the price fell while balances are down: it trips');
  assert.equal(botSettings.enabled, false);
});

// ---- retries of a bar's orders ----
test('retry: a refused order is placed again after 60 s, five attempts in all, then order_retries_exhausted', async (t) => {
  reset(ema);
  const now = midBar('2026-11-05T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  await tick();
  assert.equal(placed.length, 1);
  assert.equal(stateOf().decision.attempts, 1);
  t.mock.timers.setTime(now + 30_000);
  await tick();
  assert.equal(placed.length, 1, 'backoff');
  for (let i = 1; i <= 4; i++) {
    t.mock.timers.setTime(now + i * 61_000);
    await tick();
    assert.equal(placed.length, 1 + i, `attempt ${i + 1}`);
  }
  assert.equal(logged('order_retries_exhausted').length, 0);
  t.mock.timers.setTime(now + 5 * 61_000);
  await tick();
  assert.equal(placed.length, 5);
  assert.equal(logged('order_retries_exhausted').length, 1);
  assert.equal(logged('order_retries_exhausted')[0].level, 'error');
  t.mock.timers.setTime(now + 6 * 61_000);
  await tick();
  assert.equal(placed.length, 5, 'done for this bar');
});

test('retry: a working order is not doubled, and a filled plan ends the decision', async (t) => {
  reset(ema);
  placeResult = 'open';
  const now = midBar('2026-11-06T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  await tick();
  assert.equal(placed.length, 1);
  t.mock.timers.setTime(now + 61_000);
  await tick();
  assert.equal(placed.length, 1, 'its order still works');
  assert.equal(stateOf().decision.done, false);
  // filled: the coins are there, the order closed
  orders[0].status = 'filled';
  cash = 5;
  held = { BTC: 2.48 };
  t.mock.timers.setTime(now + 122_000);
  await tick();
  assert.equal(placed.length, 1);
  assert.equal(stateOf().decision.done, true);
});

test('retry: the next bar drops the old plan; a crash after markDecided resumes through the same path', async (t) => {
  reset(ema);
  const now = midBar('2026-11-07T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const bar = lastBar(now);
  // the state a crash leaves: bar marked decided, nothing placed
  running(ema, now, { decision: { bar, weights: { 'BTC-EUR': 1 }, prices: { 'BTC-EUR': 400 }, equityEur: 1000, planned: [{ market: 'BTC-EUR', side: 'buy', eur: 990, qty: 0 }], attempts: 0, nextAt: 0, done: false } });
  await tick();
  assert.equal(placed.length, 1, 'resumed');
  assert.equal(candleCalls, 0, 'from the stored weights');
  assert.equal(placed[0].ctx.barTime, bar);
  assert.equal(stateOf().decision.attempts, 1);
  // an unknown-outcome order from before the crash blocks it instead
  placed.length = 0;
  running(ema, now, { decision: { ...stateOf().decision, attempts: 0, nextAt: 0 } });
  orders = [{ ...order(80, 'paper', 'pending'), side: 'buy' }];
  await tick();
  assert.equal(placed.length, 0);
  // and a plan of an older bar is never retried
  orders = [];
  running(ema, now, { decision: { ...stateOf().decision, bar: bar - INTERVAL_MS['1h'], attempts: 0, nextAt: 0 } });
  await tick();
  assert.equal(placed.length, 0);
});

test('retry: a rotation does not buy this bar with cash from this bar\'s sell, a planned buy never grows', async (t) => {
  reset(rot);
  const now = midBar('2026-11-08T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const bar = lastBar(now);
  // the decision sold BTC and could only afford a €100 buy of ETH, which was refused; the sell has filled since
  cash = 900;
  running(rot, now, { decision: { bar, weights: { 'BTC-EUR': 0, 'ETH-EUR': 1 }, prices: { 'BTC-EUR': 400, 'ETH-EUR': 400 }, equityEur: 1000, planned: [{ market: 'BTC-EUR', side: 'sell', eur: 900, qty: 2.25 }, { market: 'ETH-EUR', side: 'buy', eur: 100, qty: 0 }], attempts: 1, nextAt: 0, done: false } });
  await tick();
  assert.equal(status.lastTickError, null);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].intent.market, 'ETH-EUR');
  assert.ok(placed[0].intent.valueEur <= 100, `only what was planned, got ${placed[0].intent.valueEur}`);
  // a market the decision did not plan stays out however much cash there is
  placed.length = 0;
  running(rot, now, { decision: { ...stateOf().decision, planned: [{ market: 'BTC-EUR', side: 'sell', eur: 900, qty: 2.25 }], attempts: 1, nextAt: 0, done: false } });
  await tick();
  assert.equal(placed.length, 0);
  assert.equal(stateOf().decision.done, true);
});

// ---- chase per spec ----
test('a spec tuned to rest rests at close-offset with its timeout and fallback; the default follows the book', async (t) => {
  const tuned = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 2, slow: 5 }, execution: { limitOffsetBps: 20, timeoutBars: 3, fallback: 'market' } });
  reset(tuned);
  const now = midBar('2026-11-09T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  book = { bid: 600, ask: 601 };
  await tick();
  assert.equal(placed.length, 1);
  const close = logged('decision')[0].data.prices['BTC-EUR'];
  assert.equal(placed[0].intent.price, (close * 0.998).toFixed(2));
  assert.equal(placed[0].ctx.chase, undefined);
  assert.equal(placed[0].ctx.fallback, 'market');
  assert.equal(placed[0].ctx.expiresAt, lastBar(now) + 4 * INTERVAL_MS['1h']);
});

// ---- stranded coins ----
test('stranded: ETH under a BTC strategy is sold with a chase, foreign coins are reported once and left alone', async (t) => {
  const lim = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 2, slow: 5 } });
  reset(lim);
  const now = midBar('2026-11-10T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  cash = 0;
  held = { ETH: 1, DOGE: 100 };
  tickers = new Map([['BTC-EUR', 400], ['ETH-EUR', 400], ['DOGE-EUR', 0.1]]);
  await tick();
  assert.equal(status.lastTickError, null);
  const sells = placed.filter((p) => p.intent.market === 'ETH-EUR');
  assert.equal(sells.length, 1);
  assert.equal(sells[0].intent.side, 'sell');
  assert.equal(sells[0].intent.amount, '1.00000000');
  assert.ok(sells[0].ctx.chase);
  assert.ok(!placed.some((p) => p.intent.market.startsWith('DOGE')));
  assert.equal(logged('foreign_coin').length, 1);
  assert.deepEqual(stateOf().decision.planned.map((p: { market: string }) => p.market), ['ETH-EUR']);
  // the next bar: the sell still works, so it is not sold twice, and DOGE is not reported again
  orders = [{ ...order(90, 'paper'), market: 'ETH-EUR', side: 'sell' }];
  placed.length = 0;
  t.mock.timers.setTime(now + INTERVAL_MS['1h']);
  await tick();
  assert.equal(placed.filter((p) => p.intent.market === 'ETH-EUR').length, 0);
  assert.equal(logged('foreign_coin').length, 1);
});

test('stranded: a manual move touches only its own markets and reports nothing', async (t) => {
  reset(ema);
  botSettings.manual = { target: 'BTC', setAt: '2026-11-11T12:00:00Z' };
  const now = midBar('2026-11-11T12:00:30Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  held = { DOGE: 100 };
  tickers = new Map([['BTC-EUR', 400], ['ETH-EUR', 400], ['DOGE-EUR', 0.1]]);
  await tick();
  assert.equal(status.lastTickError, null);
  assert.equal(logged('foreign_coin').length, 0);
  assert.deepEqual(placed.map((p) => p.intent.market), ['BTC-EUR']);
  assert.ok(placed[0].ctx.chase, 'a manual move keeps chasing');
});

// ---- stops ----
const stopped = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 2, slow: 5 }, risk: { maxWeight: 1, stopLossPct: 0.1 }, execution: { orderType: 'market' } });
const longAt = (price: number) => [{ id: 1, market: 'BTC-EUR', side: 'buy', amount: 1, quote: price, fee: 0, feeCurrency: 'EUR' }];

test('stop: an exit that could not sell is tried again every tick until it goes out, once', async (t) => {
  reset(stopped);
  const now = midBar('2026-11-12T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  running(stopped, now);
  positions = { 'BTC-EUR': longAt(500) };
  tickers = new Map([['BTC-EUR', 400]]);
  // nothing free yet: the coins sit in an order whose cancel Bitvavo has not confirmed
  cash = 0;
  orders = [{ ...order(95, 'paper'), side: 'sell', market: 'BTC-EUR' }];
  cancelUnconfirmed = true;
  await tick();
  assert.equal(status.lastTickError, null);
  assert.equal(logged('stop_triggered').length, 1);
  assert.equal(placed.length, 0);
  assert.equal(logged('stop_skipped').length, 1);
  // the cancel lands, the first place is refused
  cancelUnconfirmed = false;
  orders = [];
  held = { BTC: 1 };
  t.mock.timers.setTime(now + 15_000);
  await tick();
  assert.equal(placed.length, 1, 'tried');
  // the next one works: a market sell is on its way, so it is not sent twice
  placeResult = 'open';
  t.mock.timers.setTime(now + 30_000);
  await tick();
  assert.equal(placed.length, 2);
  assert.equal(orders.at(-1)!.side, 'sell');
  t.mock.timers.setTime(now + 45_000);
  await tick();
  assert.equal(placed.length, 2, 'the exit is working');
  // sold: the position is gone and the lock stays
  orders.at(-1)!.status = 'filled';
  positions = {};
  held = {};
  t.mock.timers.setTime(now + 60_000);
  await tick();
  assert.equal(placed.length, 2);
  assert.ok(stateOf().locks['BTC-EUR']);
  assert.equal(logged('stop_triggered').length, 1, 'one trigger');
});

test('stop: dust left after the exit is not an unfilled exit', async (t) => {
  reset(stopped);
  const now = midBar('2026-11-12T16:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  running(stopped, now, { locks: { 'BTC-EUR': 'stop loss' } });
  positions = { 'BTC-EUR': [{ ...longAt(500)[0], amount: 0.000001, quote: 0.0005 }] };
  held = { BTC: 0.000001 };
  await tick();
  assert.equal(placed.length, 0);
  assert.equal(logged('stop_skipped').length, 0);
});

// ---- decision data, sizing, depth ----
test('decision log: bar, targets, close prices, equity, strategy and mode; sized on closes for coins and equity alike', async (t) => {
  const half = validateSpec({ family: 'ema_cross', markets: ['BTC-EUR'], interval: '1h', params: { fast: 2, slow: 5 }, risk: { maxWeight: 0.5 }, execution: { orderType: 'market' } });
  reset(half);
  const now = midBar('2026-11-13T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  cash = 0;
  held = { BTC: 1 };
  tickers = new Map([['BTC-EUR', 1000]]); // far from the candle close the fake serves
  await tick();
  const d = logged('decision')[0];
  const close = d.data.prices['BTC-EUR'];
  assert.ok(close < 600, String(close));
  assert.equal(d.data.bar, lastBar(now));
  assert.deepEqual(d.data.targets, { 'BTC-EUR': 0.5 });
  assert.equal(d.data.strategyId, half.id);
  assert.equal(d.data.mode, 'paper');
  assert.equal(d.data.equityEur, close, 'the coin at its close, not the ticker');
  // 50 % at the same price on both sides: half the coin goes (live equity against a close would sell nothing here)
  assert.equal(placed[0].intent.side, 'sell');
  assert.equal(placed[0].intent.amount, '0.50000000');
});

test('depth: a wide spread or thin depth warns but never blocks, a failed read is ignored, the spread goes in the log', async (t) => {
  reset(ema);
  const now = midBar('2026-11-14T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  depth = { bids: [[399, 1]], asks: [[401, 1]] }; // 50 bps, nothing within 25 bps of mid
  await tick();
  assert.equal(placed.length, 1);
  assert.equal(logged('thin_book').length, 1);
  assert.ok(Math.abs(logged('decision')[0].data.spreads['BTC-EUR'] - 50) < 0.1);
  depth = null;
  placed.length = 0;
  logs.length = 0;
  t.mock.timers.setTime(now + INTERVAL_MS['1h']);
  await tick();
  assert.equal(status.lastTickError, null);
  assert.equal(placed.length, 1);
  assert.equal(logged('thin_book').length, 0);
});

// ---- process health ----
test('clock is measured hourly; unknown orders are rechecked from the tick', async (t) => {
  reset(ema, false);
  const now = midBar('2026-11-15T10:30:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  status.lastClockSync = now - 3_600_001;
  status.lastUnknownCheck = 0;
  const syncs = clockSyncs;
  const checks = unknownChecks;
  await tick();
  assert.equal(clockSyncs, syncs + 1);
  assert.equal(unknownChecks, checks + 1);
  t.mock.timers.setTime(now + 15_000);
  await tick();
  assert.equal(clockSyncs, syncs + 1);
  assert.equal(unknownChecks, checks + 1);
});

test('watchdog: a tick stuck over 5 minutes exits the process; drain waits for the running tick and blocks new ones', async () => {
  reset(ema);
  botSettings.enabled = false;
  const exits: number[] = [];
  assert.equal(engine.watchdog(Date.now(), (c) => exits.push(c)), false, 'no tick is running');
  let release = () => undefined as void;
  const gate = new Promise<void>((r) => (release = r));
  const started = Date.now();
  hangSettings = gate;
  const running_ = tick();
  assert.equal(engine.watchdog(started + 60_000, (c) => exits.push(c)), false);
  assert.equal(engine.watchdog(started + engine.TICK_STUCK_MS + 1, (c) => exits.push(c)), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [1]);
  // drain: resolves only when the tick is done
  let drained = false;
  const d = engine.drain().then(() => (drained = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(drained, false);
  hangSettings = null;
  release();
  await d;
  await running_;
  assert.equal(drained, true);
  const before = status.lastTickAt;
  await tick();
  assert.equal(status.lastTickAt, before, 'no tick after draining');
  start();
  stop();
});
