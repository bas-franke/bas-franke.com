import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import * as realClient from '../src/bitvavo/client.js';
import { BitvavoError, RateLimitedError, type BitvavoOrder } from '../src/bitvavo/client.js';
import { parseMarketRules } from '../src/bitvavo/precision.js';
import type { OrderRow } from '../src/bot/store.js';

const OPEN_STATUSES = ['pending', 'new', 'partiallyFilled', 'awaitingTrigger'] as const;

/**
 * LiveBroker against an in-memory order/fill store and a scripted Bitvavo client (no DB, no network).
 * Needs `--experimental-test-module-mocks` (set in the npm test script).
 */

const rows = new Map<number, OrderRow>();
const fills: Array<{ orderId: number | null; tradeId: string; amount: number }> = [];
let nextId = 1;

const isOpen = (s: string) => (OPEN_STATUSES as readonly string[]).includes(s);
mock.module('../src/bot/store.js', {
  exports: {
    OPEN_STATUSES,
    isOpenStatus: isOpen,
    async insertOrder(o: Record<string, unknown>) {
      const row = {
        id: nextId++, mode: o.mode, clientOrderId: o.clientOrderId, exchangeOrderId: o.exchangeOrderId ?? null, market: o.market, side: o.side,
        orderType: o.orderType, price: o.price === null ? null : Number(o.price), amount: Number(o.amount), filledAmount: 0, filledQuote: 0,
        feePaid: 0, feeCurrency: null, status: o.status, strategyId: o.strategyId, reason: o.reason, meta: o.meta, createdAt: new Date(),
      } as OrderRow;
      rows.set(row.id, row);
      return { ...row };
    },
    async updateOrder(id: number, patch: Record<string, unknown>, metaPatch?: Record<string, unknown>) {
      const r = rows.get(id)!;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v;
      if (metaPatch) r.meta = { ...r.meta, ...metaPatch };
    },
    async openOrders(mode: string) {
      return [...rows.values()].filter((r) => r.mode === mode && isOpen(r.status)).map((r) => ({ ...r }));
    },
    async unknownOrders(mode: string) {
      return [...rows.values()].filter((r) => r.mode === mode && r.status === 'unknown').map((r) => ({ ...r }));
    },
    async fillsForOrder(orderId: number) {
      return fills.filter((f) => f.orderId === orderId);
    },
    async recordFill(f: { orderId: number | null; tradeId: string; amount: number }) {
      if (fills.some((x) => x.tradeId === f.tradeId)) return false;
      fills.push(f);
      return true;
    },
  },
});

const fake = {
  placeOrder: async (_p: unknown): Promise<BitvavoOrder> => {
    throw new Error('not scripted');
  },
  getOrder: async (_m: string, _ids: unknown): Promise<BitvavoOrder> => {
    throw new Error('not scripted');
  },
  trades: async (_m: string, _o: unknown): Promise<unknown[]> => [],
  cancelOrder: async () => ({ orderId: 'x' }),
  ordersOpen: async () => [],
  balance: async () => [],
};
mock.module('../src/bitvavo/index.js', { exports: { ...realClient, bitvavo: fake } });
mock.module('../src/log.js', { exports: { log: async () => undefined, errText: (e: unknown) => (e instanceof Error ? e.message : String(e)) } });
const btc = parseMarketRules({ market: 'BTC-EUR', status: 'trading', base: 'BTC', quote: 'EUR', quantityDecimals: 8, notionalDecimals: 2, tickSize: '1.00', minOrderInQuoteAsset: '5' });
mock.module('../src/bot/marketData.js', {
  exports: { ruleFor: async () => btc, bestBidAsk: async () => ({ bid: 49_000, ask: 49_001 }) },
});
mock.module('../src/db.js', {
  exports: { query: async (_sql: string, params: unknown[]) => ({ rows: [{ status: rows.get(Number(params[0]))?.status }] }) },
});

const { LiveBroker } = await import('../src/bot/live.js');
const ctx = { strategyId: 's', expiresAt: null, fallback: 'cancel' as const, fees: { maker: 0.0015, taker: 0.0025 } };
const marketBuy = { market: 'BTC-EUR', side: 'buy' as const, orderType: 'market' as const, amountQuote: '100.00', postOnly: false, reason: 't', valueEur: 100 };

function exOrder(over: Partial<BitvavoOrder> = {}): BitvavoOrder {
  return {
    orderId: 'ex-1', market: 'BTC-EUR', created: 1, updated: 2, status: 'filled', side: 'buy', orderType: 'market',
    filledAmount: '0.002', filledAmountQuote: '100', feePaid: '0.25', feeCurrency: 'EUR', ...over,
  };
}

test('an accepted order is never marked rejected when reading its fills fails afterwards (e.g. a rate limit)', async () => {
  rows.clear();
  fills.length = 0;
  // POST answers "filled" without the fills list, so the broker must read the trade history, which is rate limited.
  fake.placeOrder = async () => exOrder({ fills: [] });
  fake.trades = async () => {
    throw new RateLimitedError('GET /trades', Date.now() + 60_000);
  };
  const broker = new LiveBroker();
  const row = await broker.place(marketBuy, ctx);
  assert.ok(row, 'the order counts as placed');
  const stored = rows.get(row.id)!;
  assert.notEqual(stored.status, 'rejected');
  assert.ok(isOpen(stored.status), `still open so sync reads it back, got ${stored.status}`);
  assert.equal(stored.exchangeOrderId, 'ex-1');

  // Next sync: the trade history works again; the fill is recorded and only then does the order close.
  fake.getOrder = async () => exOrder({ fills: [] });
  fake.trades = async () => [{ id: 't1', orderId: 'ex-1', timestamp: 3, market: 'BTC-EUR', side: 'buy', amount: '0.002', price: '50000', taker: true, fee: '0.25', feeCurrency: 'EUR', settled: true }];
  assert.equal(await broker.sync(), 1);
  assert.equal(rows.get(row.id)!.status, 'filled');
  assert.equal(fills.length, 1);
});

test('a sync whose fill lookup fails leaves the order open instead of closing it without fills', async () => {
  rows.clear();
  fills.length = 0;
  fake.placeOrder = async () => exOrder({ status: 'new', filledAmount: '0', filledAmountQuote: '0', feePaid: '0', fills: [] });
  const broker = new LiveBroker();
  const row = (await broker.place({ ...marketBuy, orderType: 'limit', amount: '0.002', price: '48000', amountQuote: undefined, postOnly: true }, ctx))!;
  assert.equal(rows.get(row.id)!.status, 'new');
  fake.getOrder = async () => exOrder({ fills: [] });
  fake.trades = async () => {
    throw new BitvavoError('boom', 500, null, 'GET /trades', false);
  };
  await broker.sync();
  assert.equal(rows.get(row.id)!.status, 'new', 'not closed while its fills are unknown');
  assert.equal(fills.length, 0);
});

test('a definite rejection by Bitvavo still marks the order rejected; an unknown outcome stays pending', async () => {
  rows.clear();
  fake.placeOrder = async () => {
    throw new BitvavoError('insufficient balance', 400, 216, 'POST /order', true);
  };
  const broker = new LiveBroker();
  assert.equal(await broker.place(marketBuy, ctx), null);
  assert.equal([...rows.values()][0].status, 'rejected');
  fake.placeOrder = async () => {
    throw new BitvavoError('network', 0, null, 'POST /order', false);
  };
  const row = await broker.place(marketBuy, ctx);
  assert.equal(rows.get(row!.id)!.status, 'pending');
});

const notFound = () => new BitvavoError('No order found', 404, 240, 'GET /order', true);

/** A resting order, placed; Bitvavo then loses sight of it. */
async function restingOrder(broker: InstanceType<typeof LiveBroker>) {
  rows.clear();
  fills.length = 0;
  fake.placeOrder = async () => exOrder({ status: 'new', filledAmount: '0', filledAmountQuote: '0', feePaid: '0', fills: [] });
  fake.getOrder = async () => {
    throw notFound();
  };
  fake.trades = async () => [];
  return (await broker.place({ ...marketBuy, orderType: 'limit', amount: '0.002', price: '48000', amountQuote: undefined, postOnly: true }, ctx))!;
}

test('an order Bitvavo keeps not finding turns unknown after 10 min, a found one starts the clock over', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const now = Date.now();
  const broker = new LiveBroker();
  const row = await restingOrder(broker);
  t.mock.timers.setTime(now + 30 * 60_000); // an old order: its age alone means nothing
  await broker.sync();
  assert.equal(rows.get(row.id)!.status, 'new');
  assert.equal(rows.get(row.id)!.meta.notFoundSince, now + 30 * 60_000);
  // found again: the miss is forgotten
  fake.getOrder = async () => exOrder({ status: 'new', filledAmount: '0', filledAmountQuote: '0', feePaid: '0', fills: [] });
  t.mock.timers.setTime(now + 35 * 60_000);
  await broker.sync();
  assert.equal(rows.get(row.id)!.meta.notFoundSince, null);
  fake.getOrder = async () => {
    throw notFound();
  };
  t.mock.timers.setTime(now + 36 * 60_000);
  await broker.sync();
  t.mock.timers.setTime(now + 45 * 60_000);
  await broker.sync();
  assert.equal(rows.get(row.id)!.status, 'new', 'under 10 min since the first miss');
  t.mock.timers.setTime(now + 46 * 60_000);
  await broker.sync();
  assert.equal(rows.get(row.id)!.status, 'unknown');
  assert.equal(isOpen('unknown'), false, 'it no longer blocks its side');
  assert.deepEqual(await broker.sync(), 0, 'and sync leaves it alone');
});

test('an unknown order that comes back gets its fills and final status; still open it is cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const broker = new LiveBroker();
  const row = await restingOrder(broker);
  rows.get(row.id)!.status = 'unknown';
  // still gone: nothing changes
  assert.equal(await broker.recheckUnknown(), 0);
  assert.equal(rows.get(row.id)!.status, 'unknown');
  // back, partly filled and still open
  const fill = { id: 't9', timestamp: 3, amount: '0.001', price: '48000', taker: false, fee: '0.07', feeCurrency: 'EUR', settled: true };
  fake.getOrder = async () => exOrder({ status: 'partiallyFilled', filledAmount: '0.001', filledAmountQuote: '48', fills: [fill] });
  let cancels = 0;
  (fake as any).cancelOrder = async () => {
    cancels++;
    fake.getOrder = async () => exOrder({ status: 'canceled', filledAmount: '0.001', filledAmountQuote: '48', fills: [fill] });
    return { orderId: 'ex-1' };
  };
  assert.equal(await broker.recheckUnknown(), 1);
  assert.equal(fills.length, 1);
  assert.equal(cancels, 1);
  assert.equal(rows.get(row.id)!.status, 'canceled');
  assert.equal(await broker.recheckUnknown(), 0, 'closed: not looked up again');
});

test('an unknown order that stays unfindable still gives up its fills from the trade history', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const broker = new LiveBroker();
  const row = await restingOrder(broker);
  rows.get(row.id)!.status = 'unknown';
  const trade = { id: 't1', orderId: 'ex-1', timestamp: 3, market: 'BTC-EUR', side: 'buy', amount: '0.002', price: '48000', taker: false, fee: '0.14', feeCurrency: 'EUR', settled: true };
  fake.trades = async () => [trade, { ...trade, id: 't2', orderId: 'someone-else' }];
  assert.equal(await broker.recheckUnknown(), 1);
  assert.deepEqual(fills.map((f) => f.tradeId), ['t1']);
  assert.equal(rows.get(row.id)!.status, 'filled');
  assert.equal(await broker.recheckUnknown(), 0);
});

test('client: a timestamp error resyncs the clock and resends once, also for writes', async () => {
  const calls: string[] = [];
  let bad = 1;
  const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const client = new realClient.BitvavoClient({
    apiKey: 'k', apiSecret: 's', operatorId: 1,
    fetchImpl: (async (url: string, init: RequestInit) => {
      const u = String(url);
      calls.push(`${init.method} ${new URL(u).pathname}`);
      if (u.endsWith('/time')) return res({ time: Date.now() + 5000 });
      if (bad-- > 0) return res({ errorCode: 304, error: 'not received within the window' }, 403);
      return res({ orderId: 'x' });
    }) as typeof fetch,
  });
  const out = await client.placeOrder({ market: 'BTC-EUR', side: 'buy', orderType: 'market', amountQuote: '10' });
  assert.equal(out.orderId, 'x');
  assert.deepEqual(calls, ['POST /v2/order', 'GET /v2/time', 'POST /v2/order']);
  assert.ok(Math.abs(client.timeOffset - 5000) < 1000);
  // a second refusal is the caller's problem, not a loop
  bad = 2;
  await assert.rejects(client.balance(), /code 304/);
});
