import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

let fillRows: Record<string, unknown>[] = [];
let working: Array<{ market: string; side: string }> = [];
let mailed: number[][] = [];

mock.module('../src/db.js', {
  exports: {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('UPDATE fills')) {
        mailed.push(params[0] as number[]);
        return { rows: [] };
      }
      if (sql.includes('FROM fills')) return { rows: fillRows };
      if (sql.includes('FROM orders')) return { rows: working };
      return { rows: [] };
    },
  },
});

const { finishedTrades, mailFinishedTrades, pctText, sampleAccount, sampleTrade, sendTestAlert, tradeHtml, tradeSubject, tradeText } = await import('../src/bot/tradeMail.js');
const { mailTime } = await import('../src/bot/time.js');

const realFetch = globalThis.fetch;
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
let sent: any[] = [];
let status = 202;

const fill = (id: number, market: string, side: string, over: Record<string, unknown> = {}) => ({
  id, market, side, price: '100', amount: '1', quote: '100', fee: '0.15', fee_currency: 'EUR', taker: false,
  executed_at: new Date(1_800_000_000_000 + id * 1000), strategy_id: 's1', reason: 'target 40.0 %', ...over,
});

const account = () => ({ ...sampleAccount(), test: false, equityEur: 250 });

beforeEach(() => {
  process.env.SENDGRID_API_KEY = 'SG.key.value';
  process.env.STONKS_ALERT_EMAIL = 'owner@example.com';
  fillRows = [];
  working = [];
  mailed = [];
  sent = [];
  status = 202;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(null, { status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.SENDGRID_API_KEY;
  delete process.env.STONKS_ALERT_EMAIL;
});

describe('trade mails', () => {
  test('subject: side, share of the portfolio, Amsterdam time', () => {
    assert.equal(mailTime(Date.UTC(2026, 0, 22, 21, 1)), '22:01 22-01-2026');
    assert.equal(mailTime(Date.UTC(2026, 6, 1, 21, 1)), '23:01 01-07-2026'); // summer time
    const t = sampleTrade(Date.UTC(2026, 0, 22, 21, 1));
    assert.equal(tradeSubject(t, 1000), 'B40% - 22:01 22-01-2026');
    assert.equal(tradeSubject({ ...t, side: 'sell' }, 800), 'S50% - 22:01 22-01-2026');
  });

  test('small trades keep a decimal and never read as nothing', () => {
    assert.equal(pctText(40.4), '40%');
    assert.equal(pctText(2.46), '2.5%');
    assert.equal(pctText(0.01), '0.1%');
  });

  test('the body holds the order and escapes what it did not write', () => {
    const t = { ...sampleTrade(), reason: '<b>why</b>' };
    const html = tradeHtml(t, sampleAccount());
    assert.doesNotMatch(html, /<b>why/);
    assert.match(html, /Test mail with sample numbers/);
    assert.match(html, /€400\.00/);
    assert.match(tradeText(t, { ...sampleAccount(), test: false }), /Bought BTC[\s\S]*Fee: €0\.60/);
  });

  test('a chase is one trade, a market and side with a working order waits', async () => {
    fillRows = [fill(1, 'BTC-EUR', 'buy'), fill(2, 'BTC-EUR', 'buy'), fill(3, 'ETH-EUR', 'buy'), fill(4, 'ETH-EUR', 'sell')];
    working = [{ market: 'ETH-EUR', side: 'buy' }];
    const trades = await finishedTrades();
    assert.deepEqual(trades.map((t) => [t.market, t.side, t.fills.length]), [['BTC-EUR', 'buy', 2], ['ETH-EUR', 'sell', 1]]);
  });

  test('mails html and text from stonks@, then marks the fills', async () => {
    fillRows = [fill(1, 'BTC-EUR', 'buy'), fill(2, 'BTC-EUR', 'buy')];
    await mailFinishedTrades(account(), 1_000);
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from.email, 'stonks@bas-franke.com');
    assert.match(sent[0].subject, /^B80% - \d\d:\d\d \d\d-\d\d-\d{4}$/);
    assert.deepEqual(sent[0].content.map((c: { type: string }) => c.type), ['text/plain', 'text/html']);
    assert.deepEqual(mailed, [[1, 2]]);
  });

  test('a refused mail leaves the fills unmailed and waits before trying again', async () => {
    const errors = mock.method(console, 'error', () => undefined);
    status = 401;
    fillRows = [fill(1, 'BTC-EUR', 'buy')];
    await mailFinishedTrades(account(), Date.now());
    await flush();
    await mailFinishedTrades(account(), Date.now());
    await flush();
    errors.mock.restore();
    assert.equal(sent.length, 1);
    assert.deepEqual(mailed, []);
    await mailFinishedTrades(account(), Date.now() + 5 * 60_000 + 1000);
  });

  test('no account yet: the fills wait', async () => {
    fillRows = [fill(1, 'BTC-EUR', 'buy')];
    await mailFinishedTrades(undefined, Date.now() + 3_600_000);
    await flush();
    assert.equal(sent.length, 0);
  });

  test('the test mail looks like a trade mail', async () => {
    const r = await sendTestAlert();
    assert.deepEqual([r.ok, r.configured], [true, true]);
    assert.match(sent[0].subject, /^B40% - /);
    assert.match(sent[0].content[1].value, /no real trade happened/);
  });
});
