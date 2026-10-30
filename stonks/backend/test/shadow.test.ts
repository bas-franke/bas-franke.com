import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import { startHarness } from './helpers/api-harness.js';

/** The shadow runner against an in-memory bot_logs, settings and prices (no DB, no network). */

let logRows: any[] = [];
let settings: Record<string, any> = {};
let points: any[] = [];
let decisions: any[] = [];
let fills: any[] = [];
const logged: any[] = [];
let bot: any;
let live = new Map<string, number>();
let candleCalls = 0;
let portfolio: { at: number; equityEur: number } | undefined;

async function fakeQuery(sql: string, params: any[] = []) {
  if (sql.includes('FROM bot_logs')) return { rows: logRows.filter((r) => r.id > params[0]).slice(0, 2000) };
  if (sql.startsWith('INSERT INTO shadow_points')) {
    const [ts, mode, strategy_id, expected_eur, actual_eur, hold_eur] = params;
    if (!points.some((p) => p.ts === ts && p.mode === mode && p.strategy_id === strategy_id)) points.push({ ts, mode, strategy_id, expected_eur, actual_eur, hold_eur });
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO shadow_decisions')) {
    const [mode, strategy_id, bar, ts, prices, with_orders] = params;
    if (!decisions.some((d) => d.mode === mode && d.strategy_id === strategy_id && d.bar === bar)) decisions.push({ mode, strategy_id, bar, ts, prices: JSON.parse(prices), with_orders });
    return { rows: [] };
  }
  if (sql.includes('FROM settings WHERE key')) return { rows: settings[params[0]] ? [{ value: structuredClone(settings[params[0]]) }] : [] };
  if (sql.includes('FROM shadow_points WHERE mode = $1 AND strategy_id = $2 AND actual_eur IS NOT NULL')) {
    const rows = points.filter((p) => p.mode === params[0] && p.strategy_id === params[1] && p.actual_eur !== null).sort((a, b) => b.ts - a.ts);
    return { rows: rows.slice(0, 1) };
  }
  if (sql.includes('FROM shadow_points')) {
    return { rows: points.filter((p) => p.mode === params[0] && p.strategy_id === params[1] && p.ts >= params[2]).sort((a, b) => a.ts - b.ts).map((p) => ({ ...p, ts: new Date(p.ts) })) };
  }
  if (sql.includes('FROM fills')) return { rows: fills };
  if (sql.includes('FROM shadow_decisions')) return { rows: decisions.filter((d) => params[2].includes(d.bar)) };
  throw new Error(`unexpected SQL: ${sql}`);
}

mock.module('../src/db.js', { exports: { query: fakeQuery } });
mock.module('../src/settings.js', {
  exports: {
    getBotSettings: async () => structuredClone(bot),
    getSetting: async (k: string) => structuredClone(settings[k]),
    setSetting: async (k: string, v: unknown) => {
      settings[k] = structuredClone(v);
    },
  },
});
mock.module('../src/log.js', {
  exports: {
    log: async (level: string, event: string, message: string) => void logged.push({ level, event, message }),
    errText: (e: unknown) => String(e),
  },
});
mock.module('../src/bot/engine.js', {
  exports: {
    cachedPortfolio: () => portfolio,
    effective: (s: unknown) => s,
  },
});
mock.module('../src/bot/marketData.js', {
  exports: {
    allPrices: async () => live,
    closedCandles: async (_m: string, _i: string, lastBar: number, opts: { from: number }) => {
      candleCalls++;
      const out = [];
      for (let t = opts.from; t <= lastBar; t += H) out.push([t, 0, 0, 0, 100 + (t - opts.from) / H, 0]);
      return out;
    },
  },
});

const H = 3_600_000;
const {
  driftAlerts, expectedValue, holdValue, rebalance, resetShadow, runShadow, slippageBps, slippageStats, startVirtual, trackingReport,
} = await import('../src/bot/shadow.js');

const FEE = 0.0015;
const T0 = Date.UTC(2026, 9, 1);
const started = (id: number, sid: string, mode = 'paper', markets = ['BTC-EUR']) => ({
  id, ts: new Date(T0), event: 'strategy_started', message: `Running x (${sid}) in ${mode} mode`, data: { strategy: { id: sid, markets, interval: '1h' } },
});
const decision = (id: number, bar: number, targets: Record<string, number>, price: Record<string, number> | undefined, equityEur: number, orders: unknown[] = []) => ({
  id, ts: new Date(bar + H), event: 'decision', message: 'd', data: { bar, targets, equityEur, orders, locked: [], ...(price ? { prices: price } : {}) },
});

beforeEach(() => {
  logRows = [];
  settings = {};
  points = [];
  decisions = [];
  fills = [];
  logged.length = 0;
  candleCalls = 0;
  portfolio = undefined;
  live = new Map([['BTC-EUR', 120]]);
  bot = { enabled: true, mode: 'paper', strategy: { id: 'a' }, fees: { maker: FEE, taker: 0.0025 } };
  resetShadow();
});

describe('virtual portfolio', () => {
  test('buys at the close with the maker fee, sells back with it', () => {
    const v = startVirtual('a', 'paper', ['BTC-EUR'], 0, 1000, { 'BTC-EUR': 100 });
    rebalance(v, { 'BTC-EUR': 1 }, { 'BTC-EUR': 100 }, FEE);
    assert.ok(v.cash < 1e-9);
    assert.ok(Math.abs(v.qty['BTC-EUR'] - 1000 / (1 + FEE) / 100) < 1e-9);
    rebalance(v, { 'BTC-EUR': 0 }, { 'BTC-EUR': 110 }, FEE);
    assert.equal(v.qty['BTC-EUR'], undefined);
    assert.ok(Math.abs(v.cash - (1000 / (1 + FEE)) * 1.1 * (1 - FEE)) < 1e-9);
  });

  test('the dead-band ignores small moves, a full exit does not', () => {
    const v = startVirtual('a', 'paper', ['BTC-EUR'], 0, 1000, { 'BTC-EUR': 100 });
    rebalance(v, { 'BTC-EUR': 0.015 }, { 'BTC-EUR': 100 }, FEE); // €15 < 2 % of €1000
    assert.equal(v.cash, 1000);
    v.qty['BTC-EUR'] = 0.01;
    v.cash -= 1;
    rebalance(v, { 'BTC-EUR': 0 }, { 'BTC-EUR': 100 }, FEE);
    assert.equal(v.qty['BTC-EUR'], undefined);
  });

  test('buys are scaled to the cash', () => {
    const v = startVirtual('a', 'paper', ['BTC-EUR', 'ETH-EUR'], 0, 1000, { 'BTC-EUR': 100, 'ETH-EUR': 10 });
    rebalance(v, { 'BTC-EUR': 0.5, 'ETH-EUR': 0.5 }, { 'BTC-EUR': 100, 'ETH-EUR': 10 }, FEE);
    assert.ok(Math.abs(v.cash) < 1e-9);
    assert.ok(expectedValue(v, { 'BTC-EUR': 100, 'ETH-EUR': 10 }) < 1000);
  });

  test('hold splits the start money equally and never pays a fee', () => {
    const v = startVirtual('a', 'paper', ['BTC-EUR', 'ETH-EUR'], 0, 1000, { 'BTC-EUR': 100, 'ETH-EUR': 10 });
    assert.equal(holdValue(v, { 'BTC-EUR': 100, 'ETH-EUR': 10 }), 1000);
    assert.equal(holdValue(v, { 'BTC-EUR': 200, 'ETH-EUR': 10 }), 1500);
  });
});

describe('slippage and drift', () => {
  const fill = (over = {}) => ({ market: 'BTC-EUR', side: 'buy', price: 101, fee: 1, feeCurrency: 'EUR', taker: false, bar: 5, ...over });
  const byBar = new Map([[5, { 'BTC-EUR': 100 }]]);

  test('adverse is positive on both sides', () => {
    assert.ok(Math.abs(slippageBps('buy', 101, 100) - 100) < 1e-9);
    assert.ok(Math.abs(slippageBps('sell', 99, 100) - 100) < 1e-9);
    assert.ok(Math.abs(slippageBps('sell', 101, 100) + 100) < 1e-9);
  });

  test('fills without a decision count for fees and taker share, not for bps', () => {
    const s = slippageStats([fill(), fill({ bar: null, taker: true }), fill({ feeCurrency: 'BTC' })], byBar);
    assert.deepEqual([s.fills, s.measured, s.feesEur], [3, 2, 2]);
    assert.ok(Math.abs(s.avgBps! - 100) < 1e-9);
    assert.ok(Math.abs(s.takerShare! - 1 / 3) < 1e-9);
  });

  test('flags need both the size and the sample', () => {
    const slip = (avgBps: number | null, measured: number) => ({ fills: measured, measured, avgBps, takerShare: 0, feesEur: 0 });
    assert.deepEqual(driftAlerts(-4, 40, slip(1, 20)), []);
    assert.deepEqual(driftAlerts(-6, 29, slip(30, 9)), []);
    assert.deepEqual(driftAlerts(-6, 30, slip(25, 10)).map((a) => a.kind), ['gap']);
    assert.deepEqual(driftAlerts(0, 1, slip(26, 10)).map((a) => a.kind), ['slippage']);
    assert.deepEqual(driftAlerts(null, 99, slip(null, 0)), []);
  });
});

describe('runner', () => {
  test('follows decisions once: a second run adds nothing but the minute point', async () => {
    logRows = [started(1, 'a'), decision(2, T0, { 'BTC-EUR': 1 }, { 'BTC-EUR': 100 }, 1000, [{}]), decision(3, T0 + H, { 'BTC-EUR': 1 }, { 'BTC-EUR': 110 }, 1090)];
    await runShadow(T0 + 3 * H);
    const st = settings.shadow_state;
    assert.equal(st.lastLogId, 3);
    assert.deepEqual([st.modes.paper.decisions, st.modes.paper.withOrders, st.modes.paper.startEur], [2, 1, 1000]);
    assert.equal(decisions.length, 2);
    assert.equal(points.length, 3); // two decisions and this minute
    const last = points[2];
    assert.equal(last.hold_eur, 1200);
    assert.ok(Math.abs(last.expected_eur - (1000 / (1 + FEE)) * 1.2) < 1e-6);
    assert.equal(last.actual_eur, null); // no fresh portfolio
    await runShadow(T0 + 3 * H);
    assert.equal(points.length, 3);
    assert.equal(settings.shadow_state.modes.paper.decisions, 2);
  });

  test('a reset starts the figures over from the real equity and keeps the position', async () => {
    logRows = [started(1, 'a'), decision(2, T0, { 'BTC-EUR': 1 }, { 'BTC-EUR': 100 }, 1000, [{}])];
    live = new Map([['BTC-EUR', 120]]);
    portfolio = undefined;
    await runShadow(T0 + H);
    const before = settings.shadow_state.modes.paper;
    assert.equal(before.decisions, 1);

    settings.tracking_reset = { paper: T0 + 2 * H };
    await runShadow(T0 + 2 * H); // no fresh portfolio yet: it waits
    assert.equal(settings.shadow_state.modes.paper.since, before.since);

    portfolio = { at: T0 + 3 * H, equityEur: 900 };
    await runShadow(T0 + 3 * H);
    const v = settings.shadow_state.modes.paper;
    assert.deepEqual([v.since, v.startEur, v.decisions, v.withOrders], [T0 + 2 * H, 900, 0, 0]);
    assert.ok(Math.abs(expectedValue(v, { 'BTC-EUR': 120 }) - 900) < 1e-6);
    assert.ok(v.qty['BTC-EUR'] > 0); // still in the coin, like the bot
    assert.ok(Math.abs(holdValue(v, { 'BTC-EUR': 120 }) - 900) < 1e-6);
    const point = points.at(-1);
    assert.ok(Math.abs(point.expected_eur - point.actual_eur) < 1e-6);

    await runShadow(T0 + 3 * H + 60_000); // applied once
    assert.equal(settings.shadow_state.modes.paper.since, T0 + 2 * H);
    portfolio = undefined;
    delete settings.tracking_reset;
  });

  test('a lost state rebuilds the same result from bot_logs', async () => {
    logRows = [started(1, 'a'), decision(2, T0, { 'BTC-EUR': 1 }, { 'BTC-EUR': 100 }, 1000), decision(3, T0 + H, { 'BTC-EUR': 0 }, { 'BTC-EUR': 110 }, 1090)];
    await runShadow(T0 + 3 * H);
    const before = settings.shadow_state;
    settings = {};
    await runShadow(T0 + 3 * H);
    assert.deepEqual(settings.shadow_state, before);
    assert.equal(decisions.length, 2);
  });

  test('a new strategy starts over from the actual equity, a repeated bar is ignored', async () => {
    logRows = [
      started(1, 'a'), decision(2, T0, { 'BTC-EUR': 1 }, { 'BTC-EUR': 100 }, 1000), decision(3, T0, { 'BTC-EUR': 0 }, { 'BTC-EUR': 100 }, 1000),
      started(4, 'b'), decision(5, T0 + H, { 'BTC-EUR': 0 }, { 'BTC-EUR': 110 }, 900),
    ];
    bot.strategy.id = 'b';
    await runShadow(T0 + 2 * H);
    const v = settings.shadow_state.modes.paper;
    assert.deepEqual([v.strategyId, v.startEur, v.decisions, v.cash], ['b', 900, 1, 900]);
  });

  test('ids in the row beat what strategy_started said', async () => {
    const row = decision(2, T0, { 'BTC-EUR': 1 }, { 'BTC-EUR': 100 }, 1000);
    row.data = { ...row.data, mode: 'live', strategyId: 'z' } as typeof row.data;
    logRows = [started(1, 'a', 'paper'), row];
    await runShadow(T0 + H);
    assert.equal(settings.shadow_state.modes.live.strategyId, 'z');
    assert.equal(settings.shadow_state.modes.paper, undefined);
  });

  test('rows without prices use the candle closes, one fetch per batch', async () => {
    logRows = [started(1, 'a'), decision(2, T0, { 'BTC-EUR': 1 }, undefined, 1000), decision(3, T0 + H, { 'BTC-EUR': 1 }, undefined, 1000)];
    await runShadow(T0 + 3 * H);
    assert.deepEqual(decisions.map((d) => d.prices['BTC-EUR']), [100, 101]);
    assert.equal(candleCalls, 1);
  });

  test('deposits move expected and hold, so they are no gap', async () => {
    logRows = [
      started(1, 'a'), decision(2, T0, { 'BTC-EUR': 0 }, { 'BTC-EUR': 100 }, 1000),
      { id: 3, ts: new Date(T0 + H), event: 'balance_flow', message: 'm', data: { flowEur: 500 } },
    ];
    await runShadow(T0 + 2 * H);
    assert.equal(settings.shadow_state.modes.paper.cash, 1500);
  });

  test('values with the live price and the cached portfolio; nothing while off or on another strategy', async () => {
    logRows = [started(1, 'a'), decision(2, T0, { 'BTC-EUR': 0 }, { 'BTC-EUR': 100 }, 1000)];
    portfolio = { at: T0 + 2 * H, equityEur: 990 };
    await runShadow(T0 + 2 * H);
    assert.equal(points.at(-1).actual_eur, 990);
    const n = points.length;
    bot.enabled = false;
    await runShadow(T0 + 3 * H);
    bot.enabled = true;
    bot.strategy.id = 'other';
    await runShadow(T0 + 4 * H);
    assert.equal(points.length, n);
  });

  test('tracking_drift is logged once a day, across restarts', async () => {
    const start = T0;
    const later = T0 + 31 * 24 * H;
    logRows = [started(1, 'a'), decision(2, start, { 'BTC-EUR': 0 }, { 'BTC-EUR': 100 }, 1000)];
    portfolio = { at: later, equityEur: 900 };
    await runShadow(later);
    assert.deepEqual(logged.map((l) => [l.level, l.event]), [['warn', 'tracking_drift']]);
    resetShadow(); // a restart
    await runShadow(later + 2 * H);
    assert.equal(logged.length, 1);
    resetShadow();
    portfolio = { at: later + 25 * H, equityEur: 900 };
    await runShadow(later + 25 * H);
    assert.equal(logged.length, 2);
  });
});

describe('report', () => {
  test('nothing tracked yet', async () => {
    const r = await trackingReport(fakeQuery, 'paper', 'all', T0);
    assert.equal(r.strategyId, null);
    assert.deepEqual(r.expected, []);
    assert.deepEqual(r.decisions, { total: 0, withOrders: 0 });
  });

  test('series, gap, slippage and flags', async () => {
    logRows = [started(1, 'a'), decision(2, T0, { 'BTC-EUR': 1 }, { 'BTC-EUR': 100 }, 1000, [{}])];
    const now = T0 + 31 * 24 * H;
    portfolio = { at: now, equityEur: 1000 };
    await runShadow(now); // BTC at 120 with hold €1200 and expected ~€1198
    fills = [{ market: 'BTC-EUR', side: 'buy', price: '100.5', fee: '1.5', fee_currency: 'EUR', taker: false, bar: String(T0) }];
    const r = await trackingReport(fakeQuery, 'paper', 'all', now);
    assert.equal(r.strategyId, 'a');
    assert.equal(r.since, new Date(T0 + H).toISOString());
    assert.equal(r.expected.length, 2);
    assert.equal(r.actual.length, 2);
    assert.equal(r.hold.at(-1)![1], 1200);
    assert.ok(r.gapPct! < -16);
    assert.deepEqual(r.alerts.map((a) => a.kind), ['gap']);
    assert.deepEqual([r.slippage.fills, r.slippage.measured, r.slippage.feesEur], [1, 1, 1.5]);
    assert.ok(Math.abs(r.slippage.avgBps! - 50) < 1e-9);
    assert.deepEqual(r.decisions, { total: 1, withOrders: 1 });
  });

  test('GET /api/tracking validates and picks the running mode', async () => {
    const seen: unknown[] = [];
    const h = await startHarness({ tracking: async (mode, range) => (seen.push([mode, range]), { strategyId: 'a' }) });
    try {
      assert.equal((await h.req('GET', '/api/tracking')).status, 401);
      const cookie = await h.login();
      assert.equal((await h.req('GET', '/api/tracking?range=nope', { cookie })).status, 400);
      assert.equal((await h.req('GET', '/api/tracking', { cookie })).status, 200);
      assert.equal((await h.req('GET', '/api/tracking?mode=live&range=week', { cookie })).status, 200);
      assert.deepEqual(seen, [['paper', 'month'], ['live', 'week']]);
    } finally {
      await h.close();
    }
  });
});
