import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  alertsVerdict, bitvavoVerdict, candleVerdict, clockVerdict, decisionVerdict, engineVerdict, labVerdict, lossGuardVerdict, orderIsStale, ordersVerdict, processVerdict, shadowVerdict, stuckVerdict, worst,
} from '../src/bot/healthDetail.js';
import { startHarness } from './helpers/api-harness.js';

const H = 3_600_000;
const now = Date.UTC(2026, 9, 30, 12, 30);
const bar = Date.UTC(2026, 9, 30, 11); // the newest closed 1h bar

describe('health detail verdicts', () => {
  test('the overall verdict is the worst known one', () => {
    assert.equal(worst(['ok', 'warn', 'fail']), 'fail');
    assert.equal(worst(['ok', 'warn']), 'warn');
    assert.equal(worst(['ok', 'unknown']), 'unknown');
    assert.equal(worst(['ok']), 'ok');
  });

  test('engine', () => {
    assert.equal(engineVerdict(true, true, now - 15_000, null, 100, now).status, 'ok');
    assert.equal(engineVerdict(true, true, now - 200_000, null, 1000, now).status, 'fail');
    assert.equal(engineVerdict(false, true, now - 200_000, null, 1000, now).status, 'ok');
    assert.equal(engineVerdict(false, true, now, 'boom', 1000, now).detail, 'The last tick failed: boom');
  });

  test('Bitvavo and its clock', () => {
    assert.equal(bitvavoVerdict('live', true, now - 1000, null, now).status, 'ok');
    assert.equal(bitvavoVerdict('live', false, 0, null, now).status, 'fail');
    assert.equal(bitvavoVerdict('paper', false, 0, null, now).status, 'ok');
    assert.equal(bitvavoVerdict('paper', true, now - 11 * 60_000, 'denied', now).status, 'warn');
    assert.equal(bitvavoVerdict('live', true, now - 11 * 60_000, 'denied', now).status, 'fail');
    assert.equal(clockVerdict(0, 0).status, 'unknown');
    assert.equal(clockVerdict(200, now).status, 'ok');
    assert.equal(clockVerdict(-4000, now).status, 'warn');
    assert.equal(clockVerdict(9000, now).status, 'fail');
  });

  test('decision: on time, late, held, another strategy, off', () => {
    const last = { at: bar + H, bar, held: null, strategyId: 'a' };
    assert.equal(decisionVerdict(last, 'a', '1h', true, now).status, 'ok');
    assert.equal(decisionVerdict({ ...last, held: 'stale read' }, 'a', '1h', true, now).status, 'warn');
    assert.equal(decisionVerdict({ ...last, bar: bar - H }, 'a', '1h', true, now).status, 'warn');
    assert.equal(decisionVerdict({ ...last, bar: bar - 3 * H }, 'a', '1h', true, now).status, 'fail');
    assert.equal(decisionVerdict({ ...last, bar: bar - 3 * H }, 'a', '1h', false, now).status, 'ok');
    assert.equal(decisionVerdict({ ...last, strategyId: 'b' }, 'a', '1h', true, now).status, 'unknown');
    assert.equal(decisionVerdict(null, 'a', '1h', true, now).status, 'unknown');
  });

  test('a bar that closed moments ago is not late yet', () => {
    const justClosed = bar + 2 * H + 30_000;
    const last = { at: bar + H, bar, held: null, strategyId: 'a' };
    assert.equal(decisionVerdict(last, 'a', '1h', true, justClosed).status, 'ok');
    assert.equal(decisionVerdict(last, 'a', '1h', true, justClosed + 10 * 60_000).status, 'warn');
  });

  test('candles', () => {
    assert.equal(candleVerdict({ 'BTC-EUR': bar }, '1h', now).status, 'ok');
    assert.equal(candleVerdict({ 'BTC-EUR': bar - H }, '1h', now).status, 'warn');
    assert.equal(candleVerdict({ 'BTC-EUR': bar, 'ETH-EUR': null }, '1h', now).status, 'fail');
    assert.equal(candleVerdict({}, '1h', now).status, 'unknown');
  });

  test('lab', () => {
    const stats = (over = {}) => ({ lastCall: { at: now, cmd: 'targets', ms: 900 }, lastFailure: null, ...over });
    assert.equal(labVerdict(false, 0, stats(), null).status, 'ok');
    assert.equal(labVerdict(true, 0, stats(), null).status, 'fail');
    assert.equal(labVerdict(true, 40, stats({ lastCall: null }), null).status, 'unknown');
    assert.equal(labVerdict(true, 40, stats(), false).status, 'fail');
    const fine = labVerdict(true, 40, stats(), true);
    assert.deepEqual([fine.status, fine.data.codeHashMatch], ['ok', true]);
    const failure = { at: now, cmd: 'targets', error: 'boom' };
    assert.equal(labVerdict(true, 40, stats({ lastFailure: failure }), null).status, 'fail');
    assert.equal(labVerdict(true, 40, stats({ lastFailure: { ...failure, at: now - 1000 } }), null).status, 'ok');
  });

  test('alerts, loss guard, orders, stuck orders', () => {
    assert.equal(alertsVerdict(false, null, null).status, 'warn');
    assert.equal(alertsVerdict(true, null, 'SendGrid answered 401').status, 'warn');
    assert.equal(alertsVerdict(true, now, null).status, 'ok');
    const limit = { unit: 'pct', value: 15, action: 'no_buys' } as const;
    assert.equal(lossGuardVerdict(limit, true, -200, 150).status, 'fail');
    assert.equal(lossGuardVerdict(limit, false, -110, 150).status, 'warn');
    assert.equal(lossGuardVerdict(limit, false, 20, 150).data.lossEur, 0);
    assert.equal(lossGuardVerdict(limit, false, null, 150).status, 'unknown');
    assert.equal(ordersVerdict([], 0, now).status, 'ok');
    assert.equal(ordersVerdict([1000, 5000], 1, now).status, 'warn');
    assert.equal(ordersVerdict([1000, 5000], 0, now).data.oldestAgeSec, 5);
    assert.equal(orderIsStale({ meta: { chaseSince: 1 } as any }, 31 * 60_000, now), true);
    assert.equal(orderIsStale({ meta: { expiresAt: now + 60_000 } as any }, 5 * H, now), false);
    assert.equal(orderIsStale({ meta: { expiresAt: now - 6 * 60_000 } as any }, 5 * H, now), true);
    assert.equal(stuckVerdict({}, 0).status, 'ok');
    assert.equal(stuckVerdict({ order_rejected: 2 }, 0).status, 'warn');
    assert.equal(stuckVerdict({ order_retries_exhausted: 1 }, 0).status, 'fail');
    assert.equal(stuckVerdict({}, 1).status, 'fail');
  });

  test('shadow and process', () => {
    const slippage = { fills: 3, measured: 3, avgBps: 2, takerShare: 0, feesEur: 1 };
    const h = { strategyId: 'a', since: 0, lastPointAt: now - 60_000, gapPct: -0.5, slippage, alerts: [] };
    assert.equal(shadowVerdict(null, true, now).status, 'unknown');
    assert.equal(shadowVerdict(h, true, now).status, 'ok');
    assert.equal(shadowVerdict({ ...h, lastPointAt: now - 6 * 60_000 }, true, now).status, 'warn');
    assert.equal(shadowVerdict({ ...h, lastPointAt: now - 6 * 60_000 }, false, now).status, 'ok');
    assert.equal(shadowVerdict({ ...h, alerts: [{ kind: 'gap' as const, message: 'behind' }] }, true, now).status, 'warn');
    assert.equal(processVerdict(600, null, 100).status, 'ok');
    assert.equal(processVerdict(600, null, 280).status, 'warn');
  });

  test('GET /api/health/detail needs a login', async () => {
    const h = await startHarness({ healthDetail: async () => ({ status: 'ok' }) });
    try {
      assert.equal((await h.req('GET', '/api/health/detail')).status, 401);
      const res = await h.req('GET', '/api/health/detail', { cookie: await h.login() });
      assert.deepEqual(await res.json(), { status: 'ok' });
    } finally {
      await h.close();
    }
  });
});
