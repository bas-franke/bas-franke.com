import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import * as realClient from '../src/bitvavo/client.js';
import * as precision from '../src/bitvavo/precision.js';
import type { OrderIntent } from '../src/bot/logic.js';
import type { OrderRow } from '../src/bot/store.js';

/**
 * The paper broker against a fake wallet, order table and market (no DB, no network).
 * Needs `--experimental-test-module-mocks` (set in the npm test script).
 */

const OPEN = ['pending', 'new', 'partiallyFilled', 'awaitingTrigger'];
const FEES = { maker: 0.0015, taker: 0.0025 };
const CTX = { strategyId: 's', expiresAt: null, fallback: 'cancel' as const, fees: FEES };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

// ---- fake world ----
let wallet: Record<string, number> = {};
let orders: OrderRow[] = [];
let fills: Array<{ orderId: number; tradeId: string; amount: number; fee: number; quote: number; taker: boolean }> = [];
let book = { bid: 99, ask: 101 };
/** The market's public trades. */
let tape: Array<{ id: string; timestamp: number; amount: string; price: string; side: string }> = [];
let tradeCalls: Array<{ path: string; query: Record<string, number> }> = [];
/** The clock; a trade in the tape moves it past that trade. */
let clock = Date.parse('2026-10-30T12:00:20Z');
mock.method(Date, 'now', () => clock);

const fakeClient = {
  request: async (_m: string, path: string, opts: { query: Record<string, number> }) => {
    tradeCalls.push({ path, query: opts.query });
    const { start, end, limit } = opts.query;
    return tape.filter((t) => t.timestamp >= start && t.timestamp <= end).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  },
};

const pgClient = {
  release: () => undefined,
  query: async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT value FROM settings')) return { rows: [{ value: structuredClone(wallet) }] };
    if (sql.startsWith('INSERT INTO settings')) {
      wallet = JSON.parse(String(params[1]));
      return { rows: [] };
    }
    if (sql.startsWith('SELECT id FROM orders')) {
      const o = orders.find((x) => x.id === params[0] && OPEN.includes(x.status));
      return { rows: o ? [o] : [], rowCount: o ? 1 : 0 };
    }
    if (sql.startsWith('SELECT COUNT(*)')) return { rows: [{ n: String(fills.filter((f) => f.orderId === params[0]).length) }] };
    if (sql.startsWith("UPDATE orders SET status = 'canceled'")) {
      orders.find((x) => x.id === params[0])!.status = 'canceled';
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] }; // BEGIN, COMMIT, ROLLBACK
  },
};

mock.module('../src/settings.js', {
  exports: { getSetting: async () => structuredClone(wallet), setSetting: async (_k: string, v: Record<string, number>) => void (wallet = structuredClone(v)) },
});
mock.module('../src/bot/store.js', {
  exports: {
    openOrders: async () => orders.filter((o) => OPEN.includes(o.status)),
    getOrderRow: async (id: number) => structuredClone(orders.find((o) => o.id === id)),
    insertOrder: async (o: any) => {
      const row = { ...o, id: orders.length + 1, price: o.price === null ? null : Number(o.price), amount: Number(o.amount), filledAmount: 0, filledQuote: 0, feePaid: 0, feeCurrency: null } as OrderRow;
      orders.push(row);
      return structuredClone(row);
    },
    updateOrder: async (id: number, patch: any) => {
      const o = orders.find((x) => x.id === id)!;
      Object.assign(o, patch);
    },
    recordFill: async (f: any) => {
      assert.ok(!fills.some((x) => x.tradeId === f.tradeId), `trade id ${f.tradeId} used twice`);
      fills.push(f);
      return true;
    },
  },
});
const rules = precision.parseMarketRules({ market: 'BTC-EUR', status: 'trading', base: 'BTC', quote: 'EUR', quantityDecimals: 8, notionalDecimals: 2, tickSize: '0.01', minOrderInQuoteAsset: '5' });
mock.module('../src/bot/marketData.js', { exports: { bestBidAsk: async () => book, ruleFor: async () => rules } });
mock.module('../src/bitvavo/index.js', { exports: { ...realClient, ...precision, bitvavo: fakeClient } });
mock.module('../src/db.js', { exports: { db: () => ({ connect: async () => pgClient, query: pgClient.query }) } });
mock.module('../src/log.js', { exports: { log: async () => undefined, errText: (e: unknown) => (e instanceof Error ? e.message : String(e)) } });

const { PaperBroker, PAPER_QUEUE_SHARE, queueFillAmount, volumeThrough } = await import('../src/bot/paper.js');
const broker = new PaperBroker(() => 1000);

const limit = (side: 'buy' | 'sell', price: string, amount: string, postOnly = true): OrderIntent =>
  ({ market: 'BTC-EUR', side, orderType: 'limit', amount, price, postOnly, reason: 'test', valueEur: Number(amount) * Number(price) });

let tradeSeq = 0;
/** A market trade `afterMs` after order `o` was placed. */
function trade(o: { meta: { activeFrom: number } }, afterMs: number, price: number, amount: number) {
  const timestamp = o.meta.activeFrom + afterMs;
  clock = Math.max(clock, timestamp + 1);
  tape.push({ id: `t${++tradeSeq}`, timestamp, amount: String(amount), price: String(price), side: 'sell' });
}

beforeEach(() => {
  wallet = { EUR: 1000 };
  orders = [];
  fills = [];
  tape = [];
  tradeCalls = [];
  book = { bid: 99, ask: 101 };
});

test('volumeThrough: strictly through the price, and only after the order was placed', () => {
  const t = (timestamp: number, price: string, amount: string) => ({ id: String(timestamp), timestamp, price, amount });
  const tape2 = [t(999, '90', '5'), t(1000, '90', '6'), t(1001, '100', '7'), t(1002, '99.99', '1'), t(1003, '100.01', '2'), t(1004, '90', '3')];
  assert.equal(volumeThrough(tape2, 'buy', 100, 1000), 4);
  assert.equal(volumeThrough(tape2, 'sell', 100, 1000), 2);
  assert.equal(volumeThrough([], 'buy', 100, 1000), 0);
});

test('queueFillAmount: a share of the volume through, all fills counted, rounded down to the market decimals', () => {
  assert.equal(PAPER_QUEUE_SHARE, 0.25);
  assert.equal(queueFillAmount(1, 0, 1, 8), 0.25);
  assert.equal(queueFillAmount(1, 0.25, 1, 8), 0); // nothing new traded: nothing new fills
  assert.equal(queueFillAmount(1, 0.25, 2, 8), 0.25);
  assert.equal(queueFillAmount(1, 0.25, 100, 8), 0.75); // never more than the rest
  assert.equal(queueFillAmount(1, 0, 0.00000123, 7), 0.0000003);
  assert.equal(queueFillAmount(1, 0, 0.000001, 4), 0); // under one step
  assert.equal(queueFillAmount(1, 0, 3.9996, 3), 1); // the rest would be under one step: done
  assert.equal(queueFillAmount(1, 0, 0.8, 2, 1), 0.8); // another share
});

test('a resting order fills in parts up to its share of the volume through its price', async () => {
  const o = (await broker.place(limit('buy', '100', '1'), CTX))!;
  assert.equal(o.status, 'new');
  trade(o, 1000, 101, 50); // above the price: no fill
  trade(o, 2000, 100, 50); // at the price: no fill
  assert.equal(await broker.sync(), 0);
  assert.equal(orders[0].status, 'new');

  trade(o, 3000, 99, 2); // 0.5 may fill
  assert.equal(await broker.sync(), 1);
  assert.equal(orders[0].status, 'partiallyFilled');
  near(orders[0].filledAmount, 0.5);
  assert.equal(await broker.sync(), 0); // the same trades never fill twice

  // The rest stays reserved; the filled half is paid for.
  near(wallet.EUR, 1000 - 50 * 1.0015);
  near(wallet.BTC, 0.5);
  const eur = (await broker.balances()).find((b) => b.symbol === 'EUR')!;
  near(eur.inOrder, 50 * 1.0015);

  trade(o, 4000, 98, 100);
  assert.equal(await broker.sync(), 1);
  assert.equal(orders[0].status, 'filled');
  near(orders[0].filledAmount, 1);
  assert.equal(await broker.sync(), 0);

  // Fees and the wallet are exactly those of one full fill, at the order's own price and the maker fee.
  assert.deepEqual(fills.map((f) => f.tradeId), [`paper-${o.meta.uuid}-1`, `paper-${o.meta.uuid}-2`]);
  assert.ok(fills.every((f) => f.taker === false));
  near(orders[0].feePaid, 0.15);
  near(orders[0].filledQuote, 100);
  near(wallet.EUR, 1000 - 100.15);
  near(wallet.BTC, 1);
});

test('sells take their share the same way and pay out on each part', async () => {
  wallet = { EUR: 0, BTC: 1 };
  const o = (await broker.place(limit('sell', '100', '1'), CTX))!;
  trade(o, 1000, 100.5, 1);
  await broker.sync();
  near(orders[0].filledAmount, 0.25);
  near(wallet.EUR, 25 * 0.9985);
  near(wallet.BTC, 0.75);
  trade(o, 2000, 100.5, 3);
  await broker.sync();
  assert.equal(orders[0].status, 'filled');
  near(wallet.EUR, 100 * 0.9985);
  assert.equal(wallet.BTC, undefined);
});

test('a re-placed order starts from its own activeFrom: older moves do not count, the next seconds do', async () => {
  const first = (await broker.place(limit('buy', '100', '0.1'), { ...CTX, chase: { since: 1, root: null } }))!;
  trade(first, 1000, 99, 0.1); // a part of the first order
  await broker.sync();
  near(orders[0].filledAmount, 0.025);
  await broker.cancel(orders[0], 'repricing');

  const second = (await broker.place(limit('buy', '100', '0.075'), { ...CTX, chase: { since: 1, root: first.id } }))!;
  // Far under its price, but before it existed: it cannot have traded there.
  tape.push({ id: 'before', timestamp: second.meta.activeFrom - 1, amount: '500', price: '50', side: 'sell' });
  assert.equal(await broker.sync(), 0);
  assert.equal(orders[1].status, 'new');
  assert.ok(tradeCalls.at(-1)!.query.start === second.meta.activeFrom);

  // Inside the very minute it was placed: no waiting for a closed candle.
  trade(second, 5000, 99.5, 1);
  assert.equal(await broker.sync(), 1);
  assert.equal(orders[1].status, 'filled');
  assert.equal(orders[0].status, 'canceled');
  near(wallet.BTC, 0.1);
});

test('trades are paged back to the moment the order was placed', async () => {
  const o = (await broker.place(limit('buy', '100', '10'), CTX))!;
  for (let i = 0; i < 1500; i++) trade(o, 1 + i, 99, 0.01);
  assert.equal(await broker.sync(), 1);
  assert.ok(Math.abs(orders[0].filledAmount - 3.75) < 2e-8, String(orders[0].filledAmount)); // 1500 * 0.01 * 25 %, rounded down
  assert.equal(tradeCalls.length, 2);
  assert.equal(tradeCalls[0].path, '/BTC-EUR/trades');
  assert.ok(tradeCalls[1].query.end < tradeCalls[0].query.end);
});

test('a failing trades request skips the check and fills nothing', async () => {
  await broker.place(limit('buy', '100', '1'), CTX);
  const real = fakeClient.request;
  fakeClient.request = async () => {
    throw new Error('network');
  };
  try {
    assert.equal(await broker.sync(), 0);
  } finally {
    fakeClient.request = real;
  }
  assert.equal(orders[0].status, 'new');
  assert.equal(fills.length, 0);
});

test('a post-only limit that would cross the book is cancelled like Bitvavo does, with nothing reserved', async () => {
  for (const [side, price] of [['buy', '101'], ['buy', '105'], ['sell', '99'], ['sell', '90']] as const) {
    wallet = { EUR: 1000, BTC: 1 };
    const o = (await broker.place(limit(side, price, '0.5'), CTX))!;
    assert.equal(o.status, 'canceledPostOnly', `${side} at ${price}`);
    assert.equal(o.price, Number(price));
    near(wallet.EUR, 1000);
    near(wallet.BTC, 1);
  }
  assert.equal(fills.length, 0);
  const b = await broker.balances();
  assert.ok(b.every((x) => x.inOrder === 0));
  assert.equal(await broker.sync(), 0); // not looked at again
  assert.equal(tradeCalls.length, 0);
});

test('a post-only limit inside the spread rests', async () => {
  const buy = (await broker.place(limit('buy', '100', '0.5'), CTX))!;
  assert.equal(buy.status, 'new');
  near(buy.meta.feeRate!, FEES.maker);
  wallet.BTC = 1;
  assert.equal((await broker.place(limit('sell', '100.5', '0.5'), CTX))!.status, 'new');
});

test('a marketable limit without post-only still takes the whole fill at taker', async () => {
  const o = (await broker.place(limit('buy', '102', '0.5', false), CTX))!;
  assert.equal(o.status, 'filled');
  near(wallet.EUR, 1000 - 51 * 1.0025);
  assert.equal(fills[0].taker, true);
  assert.equal(fills[0].tradeId, `paper-${o.meta.uuid}-1`);
});

test('market orders fill completely at the touch plus slippage', async () => {
  const o = (await broker.place({ market: 'BTC-EUR', side: 'buy', orderType: 'market', amountQuote: '100', postOnly: false, reason: 'test', valueEur: 100 }, CTX))!;
  assert.equal(o.status, 'filled');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].taker, true);
  near(wallet.BTC, Number(precision.roundAmount(100 / (101 * 1.0005), 8)));
});

test('a part that the wallet cannot pay is capped; an empty wallet cancels the rest', async () => {
  const o = (await broker.place(limit('buy', '100', '1'), CTX))!;
  wallet = { EUR: 40 }; // spent elsewhere after placing
  trade(o, 1000, 99, 2);
  assert.equal(await broker.sync(), 1);
  near(orders[0].filledAmount, 40 / (100 * 1.0015));
  near(wallet.EUR, 0);
  assert.equal(orders[0].status, 'partiallyFilled');
  trade(o, 2000, 99, 4);
  assert.equal(await broker.sync(), 0);
  assert.equal(orders[0].status, 'canceled');
});
