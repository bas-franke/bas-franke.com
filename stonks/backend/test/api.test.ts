import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { memorySessionStore, parseCookies, passwordMatches, RateLimiter, rateKey } from '../src/auth.js';
import { validateResearch } from '../src/api/research.js';
import { FakeSettingsError, researchPayload, researchPayloadV2, startHarness, type Harness } from './helpers/api-harness.js';

describe('auth helpers', () => {
  test('passwordMatches is exact and refuses an empty configured password', () => {
    assert.equal(passwordMatches('secret', 'secret'), true);
    assert.equal(passwordMatches('secret ', 'secret'), false);
    assert.equal(passwordMatches('', ''), false);
    assert.equal(passwordMatches(undefined, 'secret'), false);
    assert.equal(passwordMatches(123, 'secret'), false);
  });

  test('parseCookies handles spacing, quotes, encoding and duplicates', () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies('a=1; b="two"; c=x%20y; a=override; junk'), { a: '1', b: 'two', c: 'x y' });
  });

  test('RateLimiter allows max hits per window, then resets', () => {
    let t = 0;
    const rl = new RateLimiter(3, 1000, () => t);
    assert.deepEqual([rl.hit('ip'), rl.hit('ip'), rl.hit('ip'), rl.hit('ip')], [true, true, true, false]);
    assert.equal(rl.hit('other'), true);
    t = 1001;
    assert.equal(rl.hit('ip'), true);
  });

  test('memory session store expires sessions', async () => {
    let t = 0;
    const s = memorySessionStore(() => t);
    const h = Buffer.from('ab', 'hex');
    await s.create(h, new Date(100), 'ip');
    assert.equal(await s.valid(h), true);
    t = 100;
    assert.equal(await s.valid(h), false);
    assert.equal(await s.deleteExpired(), 1);
  });
});

describe('login, sessions and CSRF', () => {
  let h: Harness;
  before(async () => (h = await startHarness()));
  after(() => h.close());

  test('protected routes need a session', async () => {
    for (const [m, p] of [
      ['GET', '/api/auth/me'],
      ['GET', '/api/overview'],
      ['GET', '/api/orders'],
      ['GET', '/api/logs'],
      ['GET', '/api/research'],
      ['GET', '/api/markets'],
    ]) {
      const res = await h.req(m, p);
      assert.equal(res.status, 401, `${m} ${p}`);
    }
    assert.equal((await h.req('POST', '/api/bot/start', { json: {} })).status, 401);
    assert.equal((await h.req('GET', '/api/auth/me', { cookie: 'stonks_session=forged' })).status, 401);
    assert.equal(
      (await h.req('GET', '/api/auth/me', { cookie: `stonks_session=${'A'.repeat(43)}` })).status,
      401,
    );
  });

  test('wrong password is 401, right password sets a hardened cookie', async () => {
    const bad = await h.req('POST', '/api/auth/login', { json: { password: 'nope' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);
    assert.ok(h.logs.some((l) => l.event === 'login_failed'));

    const ok = await h.req('POST', '/api/auth/login', { json: { password: 'test-pass' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    const cookie = ok.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^stonks_session=[A-Za-z0-9_-]{43}; /);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=2592000/);
    assert.doesNotMatch(cookie, /Secure/); // not production
    assert.ok(h.logs.some((l) => l.event === 'login'));

    const session = cookie.split(';')[0];
    const me = await h.req('GET', '/api/auth/me', { cookie: session });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { loggedIn: true });
    assert.equal(me.headers.get('cache-control'), 'no-store');

    const out = await h.req('POST', '/api/auth/logout', { json: {}, cookie: session });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.equal((await h.req('GET', '/api/auth/me', { cookie: session })).status, 401);
  });

  test('state-changing requests need JSON and a same-origin Origin', async () => {
    const form = await h.req('POST', '/api/auth/login', {
      json: 'password=test-pass',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(form.status, 415);
    const plain = await h.req('POST', '/api/auth/login', { json: '{"password":"test-pass"}', headers: { 'content-type': 'text/plain' } });
    assert.equal(plain.status, 415);
    const cross = await h.req('POST', '/api/auth/login', { json: { password: 'test-pass' }, headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    const nullOrigin = await h.req('POST', '/api/auth/login', { json: { password: 'test-pass' }, headers: { origin: 'null' } });
    assert.equal(nullOrigin.status, 403);
    const same = await h.req('POST', '/api/auth/login', { json: { password: 'test-pass' }, headers: { origin: h.base } });
    assert.equal(same.status, 200);

    const session = await h.login();
    // Body-less POST without a type: allowed only with a matching Origin (what browsers send for fetch POST).
    assert.equal((await h.req('POST', '/api/bot/stop', { cookie: session })).status, 415);
    assert.equal((await h.req('POST', '/api/bot/stop', { cookie: session, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await h.req('POST', '/api/bot/stop', { cookie: session, headers: { origin: h.base } })).status, 200);
  });
});

describe('login rate limit and missing password', () => {
  test('11th attempt within 10 minutes is 429, even with the right password', async () => {
    const h = await startHarness();
    try {
      for (let i = 0; i < 10; i++) {
        assert.equal((await h.req('POST', '/api/auth/login', { json: { password: 'x' } })).status, 401);
      }
      const res = await h.req('POST', '/api/auth/login', { json: { password: 'test-pass' } });
      assert.equal(res.status, 429);
      assert.ok(Number(res.headers.get('retry-after')) > 0);
    } finally {
      await h.close();
    }
  });

  test('without a configured password nobody can log in', async () => {
    const h = await startHarness({ password: () => '' });
    try {
      for (const password of ['', 'anything']) {
        const res = await h.req('POST', '/api/auth/login', { json: { password } });
        assert.equal(res.status, 503);
        assert.equal(res.headers.get('set-cookie'), null);
      }
    } finally {
      await h.close();
    }
  });

  test('production cookies are Secure', async () => {
    const h = await startHarness({ production: true });
    try {
      const res = await h.req('POST', '/api/auth/login', { json: { password: 'test-pass' } });
      assert.match(res.headers.get('set-cookie') ?? '', /; Secure/);
    } finally {
      await h.close();
    }
  });
});

describe('bot routes', () => {
  let h: Harness;
  let cookie: string;
  before(async () => {
    h = await startHarness();
    cookie = await h.login();
  });
  after(() => h.close());
  const put = (json: unknown) => h.req('PUT', '/api/bot', { json, cookie });

  test('overview, families and markets', async () => {
    assert.equal(((await (await h.req('GET', '/api/overview', { cookie })).json()) as any).equityEur, 1000);
    const fam = (await (await h.req('GET', '/api/strategies/families', { cookie })).json()) as any[];
    assert.equal(fam[0].family, 'ema_cross');
    const m = (await (await h.req('GET', '/api/markets', { cookie })).json()) as any;
    assert.equal(m.markets[0].market, 'BTC-EUR');
  });

  test('start and stop', async () => {
    const on = (await (await h.req('POST', '/api/bot/start', { json: {}, cookie })).json()) as any;
    assert.equal(on.enabled, true);
    const off = (await (await h.req('POST', '/api/bot/stop', { json: {}, cookie })).json()) as any;
    assert.equal(off.enabled, false);
  });

  test('PUT /api/bot validates and never touches enabled', async () => {
    assert.equal((await put({ enabled: true })).status, 400);
    assert.equal(h.settings.enabled, false);
    assert.equal((await put({ bogus: 1 })).status, 400);
    assert.equal((await put({})).status, 400);
    assert.equal((await put([1])).status, 400);
    assert.equal((await put({ mode: 'yolo' })).status, 400);
    const live = await put({ mode: 'live' });
    assert.equal(live.status, 400);
    assert.match(((await live.json()) as any).error, /confirmLive/);
    assert.equal(h.settings.mode, 'paper');
    assert.equal((await put({ strategy: { name: 'no family' } })).status, 400);
    const settingsErr = await put({ dailyLossLimitEur: -5 });
    assert.equal(settingsErr.status, 400);
    assert.match(((await settingsErr.json()) as any).error, /dailyLossLimitEur/);

    const ok = await put({ dailyLossLimitEur: 50 });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).dailyLossLimitEur, 50);
    const goLive = await put({ mode: 'live', confirmLive: true });
    assert.equal(goLive.status, 200);
    assert.equal(h.settings.mode, 'live');
    assert.equal('confirmLive' in h.settings, false);
    // already live: re-saving the form with mode "live" needs no new confirmation
    assert.equal((await put({ mode: 'live', dailyLossLimitEur: 60 })).status, 200);
  });

  test('a bot crash is a 500, not a leak', async () => {
    const h2 = await startHarness({
      getOverview: async () => {
        throw new Error('boom');
      },
    });
    try {
      const c = await h2.login();
      const res = await h2.req('GET', '/api/overview', { cookie: c });
      assert.equal(res.status, 500);
    } finally {
      await h2.close();
    }
  });
});

describe('history routes', () => {
  let h: Harness;
  let cookie: string;
  before(async () => {
    h = await startHarness(
      {},
      {
        orders: [
          {
            id: '7', mode: 'paper', client_order_id: 'stonks-1', exchange_order_id: null, market: 'BTC-EUR', side: 'buy',
            order_type: 'limit', price: '60000.5', amount: '0.001', filled_amount: '0', filled_quote: '0', fee_paid: '0',
            fee_currency: null, status: 'new', strategy_id: 's', reason: 'r', created_at: new Date(0), updated_at: new Date(0),
          },
        ],
        fills: [
          {
            id: '3', order_id: '7', mode: 'paper', exchange_trade_id: 't', market: 'BTC-EUR', side: 'buy', price: '60000',
            amount: '0.001', quote: '60', fee: '0.09', fee_currency: 'EUR', taker: false, executed_at: new Date(0),
          },
        ],
        equity_snapshots: [{ ts: new Date(0), total_eur: '1000.25', cash_eur: '940' }],
        bot_logs: [
          { id: '2', ts: new Date(0), level: 'info', event: 'a', message: 'm', data: null },
          { id: '3', ts: new Date(0), level: 'warn', event: 'b', message: 'n', data: { x: 1 } },
        ],
      },
    );
    cookie = await h.login();
  });
  after(() => h.close());
  const get = async (p: string) => {
    const res = await h.req('GET', p, { cookie });
    return { status: res.status, body: (await res.json()) as any, call: h.calls.at(-1)! };
  };

  test('orders and fills: numbers, filters, pagination', async () => {
    const o = await get('/api/orders?mode=paper&market=BTC-EUR&limit=500&before=100');
    assert.equal(o.status, 200);
    assert.deepEqual(o.call.params, ['paper', 'BTC-EUR', 100]);
    assert.match(o.call.sql, /mode = \$1 AND market = \$2 AND id < \$3 ORDER BY id DESC LIMIT 500/);
    assert.equal(o.body.orders[0].id, 7);
    assert.equal(o.body.orders[0].price, 60000.5);
    assert.equal(o.body.orders[0].clientOrderId, 'stonks-1');
    assert.equal(o.body.orders[0].createdAt, '1970-01-01T00:00:00.000Z');

    const f = await get('/api/fills');
    assert.match(f.call.sql, /ORDER BY id DESC LIMIT 100/);
    assert.equal(f.body.fills[0].fee, 0.09);
    assert.equal(f.body.fills[0].orderId, 7);

    for (const bad of ['limit=501', 'limit=0', 'limit=abc', 'mode=real', 'market=btc', "market=BTC-EUR'--", 'before=-1', 'limit=1&limit=2']) {
      assert.equal((await get(`/api/orders?${bad}`)).status, 400, bad);
    }
  });

  test('equity defaults to the bot mode', async () => {
    const e = await get('/api/equity?days=7');
    assert.deepEqual(e.call.params, ['paper', 7]);
    assert.deepEqual(e.body.points, [{ ts: '1970-01-01T00:00:00.000Z', totalEur: 1000.25, cashEur: 940 }]);
    assert.equal((await get('/api/equity?days=99999')).status, 400);
  });

  test('logs: level is a minimum, after tails ascending but returns newest first', async () => {
    const l = await get('/api/logs?level=warn&after=1&limit=50');
    assert.deepEqual(l.call.params, [['warn', 'error'], 1]);
    assert.match(l.call.sql, /ORDER BY id ASC LIMIT 50/);
    assert.deepEqual(l.body.logs.map((x: any) => x.id), [3, 2]);
    const d = await get('/api/logs');
    assert.match(d.call.sql, /ORDER BY id DESC LIMIT 200/);
    assert.equal((await get('/api/logs?level=fatal')).status, 400);
  });
});

describe('research', () => {
  test('validateResearch accepts the SPEC payload and rejects bad shapes', () => {
    const good = validateResearch(researchPayload());
    assert.equal(good.top.length, 5);
    assert.equal(validateResearch(researchPayload(1)).top.length, 1);
    const bad = (mut: (p: any) => void) => {
      const p = researchPayload();
      mut(p);
      assert.throws(() => validateResearch(p));
    };
    bad((p) => (p.top = []));
    bad((p) => p.top.push({ ...p.top[0], rank: 5 }));
    bad((p) => (p.top[1].rank = 1));
    bad((p) => (p.top[0].rank = 9));
    bad((p) => (p.generatedAt = 'yesterday'));
    bad((p) => delete p.summary);
    bad((p) => (p.top[0].equity = Array.from({ length: 1001 }, (_, i) => [i, 1])));
    bad((p) => (p.top[0].equity[0] = [1, 'x']));
    bad((p) => (p.top[0].metrics.nested = { a: 1 }));
    bad((p) => (p.top[0].explanation.summary = 'x'.repeat(2001)));
    bad((p) => (p.top[0].spec.family = 42));
    bad((p) => (p.benchmark.returnPct = Infinity));
    // unknown top-level and entry keys are dropped
    const extra: any = researchPayload(2);
    extra.evil = '<script>';
    extra.top[0].html = '<b>';
    const cleaned: any = validateResearch(extra);
    assert.equal('evil' in cleaned, false);
    assert.equal('html' in cleaned.top[0], false);
  });

  test('upload and read back', async () => {
    const h = await startHarness();
    try {
      const cookie = await h.login();
      assert.deepEqual(await (await h.req('GET', '/api/research', { cookie })).json(), { empty: true });
      assert.equal((await h.req('POST', '/api/research', { json: researchPayload(), headers: { origin: 'https://evil.example' }, cookie })).status, 403);
      assert.equal((await h.req('POST', '/api/research', { json: researchPayload() })).status, 401);
      assert.equal((await h.req('POST', '/api/research', { json: { top: [] }, cookie })).status, 400);
      const up = await h.req('POST', '/api/research', { json: researchPayload(3), cookie });
      assert.equal(up.status, 200);
      assert.deepEqual(await up.json(), { ok: true, id: 1 });
      assert.ok(h.calls.some((c) => c.sql.startsWith('DELETE FROM research_snapshots') && c.sql.includes('LIMIT 200')));
      const got = (await (await h.req('GET', '/api/research', { cookie })).json()) as any;
      assert.equal(got.id, 1);
      assert.equal(got.top.length, 3);
      assert.equal(typeof got.createdAt, 'string');
      assert.equal(got.summary.experiments, 18234);
    } finally {
      await h.close();
    }
  });
});

describe('research v2 buckets', () => {
  test('validateResearch accepts buckets, keeps v1, and caps sizes', () => {
    const good: any = validateResearch(researchPayloadV2());
    assert.deepEqual(Object.keys(good.buckets), ['minute', 'hourly', 'daily', 'weekly']);
    assert.equal(good.buckets.minute.top.length, 0);
    assert.equal(good.buckets.hourly.top.length, 3);
    assert.equal(good.buckets.minute.holdScore, -20.1);
    assert.equal(good.buckets.minute.luckLine.best, -8);
    assert.equal(good.buckets.minute.benchmark.name, 'Buy and hold BTC');
    assert.equal(good.top.length, 3);
    // v1 payloads have no buckets key at all
    assert.equal('buckets' in validateResearch(researchPayload()), false);
    // with buckets, top may be empty (the daily bucket found nothing)
    const emptyTop: any = researchPayloadV2();
    emptyTop.top = [];
    assert.equal(validateResearch(emptyTop).top.length, 0);
    // unknown bucket names are dropped
    const extra: any = researchPayloadV2();
    extra.buckets.monthly = extra.buckets.weekly;
    assert.equal('monthly' in (validateResearch(extra) as any).buckets, false);
    const bad = (mut: (p: any) => void) => {
      const p: any = researchPayloadV2();
      mut(p);
      assert.throws(() => validateResearch(p));
    };
    bad((p) => (p.buckets = []));
    bad((p) => (p.buckets = { monthly: p.buckets.weekly }));
    bad((p) => p.buckets.hourly.top.push(...p.buckets.daily.top));
    bad((p) => (p.buckets.hourly.top[1].rank = 1));
    bad((p) => (p.buckets.minute.holdScore = 'bad'));
    bad((p) => (p.buckets.minute.luckLine = { nested: { a: 1 } }));
    bad((p) => (p.buckets.minute.notes = 'x'.repeat(4001)));
    bad((p) => (p.buckets.minute.benchmark.equity = Array.from({ length: 5001 }, (_, i) => [i, 1])));
    bad((p) => (p.buckets.weekly.top[0].equity = Array.from({ length: 1001 }, (_, i) => [i, 1])));
    bad((p) => (p.buckets.weekly.top[0].spec.family = 42));
  });

  test('upload v2 and read it back', async () => {
    const h = await startHarness();
    try {
      const cookie = await h.login();
      const up = await h.req('POST', '/api/research', { json: researchPayloadV2(), cookie });
      assert.equal(up.status, 200);
      const got = (await (await h.req('GET', '/api/research', { cookie })).json()) as any;
      assert.equal(got.buckets.hourly.top[0].rank, 1);
      assert.equal(got.buckets.weekly.label, 'Weekly trading');
    } finally {
      await h.close();
    }
  });
});

describe('POST /api/bot/activate', () => {
  let h: Harness;
  let cookie: string;
  let started = 0;
  before(async () => {
    h = await startHarness({
      validateSpec: (spec) => {
        const f = (spec as { family?: unknown } | null)?.family;
        if (f !== 'ema_cross') throw new Error(`unknown family "${String(f)}"`);
      },
      enableTrading: async () => {
        started++;
        return Object.assign(h.settings, { enabled: true });
      },
    });
    cookie = await h.login();
  });
  after(() => h.close());
  const activate = (json: unknown) => h.req('POST', '/api/bot/activate', { json, cookie });
  const error = async (res: Response) => ((await res.json()) as any).error as string;

  test('needs a session and research', async () => {
    assert.equal((await h.req('POST', '/api/bot/activate', { json: { researchId: 1, bucket: 'hourly', rank: 1 } })).status, 401);
    const none = await activate({ researchId: 1, bucket: 'hourly', rank: 1 });
    assert.equal(none.status, 400);
    assert.match(await error(none), /no research/);
    assert.equal((await h.req('POST', '/api/research', { json: researchPayloadV2(), cookie })).status, 200);
  });

  test('validates the request', async () => {
    for (const body of [
      [1],
      { bucket: 'hourly', rank: 1 },
      { researchId: '1', bucket: 'hourly', rank: 1 },
      { researchId: 1, bucket: 'monthly', rank: 1 },
      { researchId: 1, bucket: 'hourly', rank: 6 },
      { researchId: 1, bucket: 'hourly', rank: 1, start: 'yes' },
    ])
      assert.equal((await activate(body)).status, 400, JSON.stringify(body));
    const missing = await activate({ researchId: 1, bucket: 'minute', rank: 1 });
    assert.equal(missing.status, 400);
    assert.match(await error(missing), /no number 1 in the minute list/);
  });

  test('refuses entries that are not bot-ready or whose family the bot lacks', async () => {
    const notReady = await activate({ researchId: 1, bucket: 'hourly', rank: 3 });
    assert.equal(notReady.status, 400);
    assert.match(await error(notReady), /does not have this strategy family/);
    const unknown = await activate({ researchId: 1, bucket: 'hourly', rank: 2 });
    assert.equal(unknown.status, 400);
    assert.match(await error(unknown), /unknown family "mystery_family"/);
    assert.equal(h.settings.strategy, undefined);
  });

  test('activates the stored spec, never one from the body, without starting', async () => {
    const res = await activate({ researchId: 1, bucket: 'hourly', rank: 1, start: false, spec: { family: 'evil' } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.started, false);
    assert.equal(started, 0);
    assert.equal((h.settings.strategy as any).id, 'ema_cross-btc-1h-1');
    assert.equal((h.settings.strategy as any).interval, '1h');
    const ar = h.settings.activeResearch as any;
    assert.deepEqual({ ...ar, activatedAt: 0 }, { researchId: 1, bucket: 'hourly', rank: 1, name: 'ema_cross BTC 1h #1', activatedAt: 0 });
    assert.ok(!Number.isNaN(Date.parse(ar.activatedAt)));
    assert.deepEqual(body.activeResearch, ar);
    assert.ok(h.logs.some((l) => l.event === 'research_activated'));
    const ov = (await (await h.req('GET', '/api/overview', { cookie })).json()) as any;
    assert.equal(ov.bot.activeResearch.bucket, 'hourly');
  });

  test('start: true switches the bot on', async () => {
    const res = await activate({ researchId: 1, bucket: 'weekly', rank: 1, start: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.started, true);
    assert.equal(body.bot.enabled, true);
    assert.equal(started, 1);
    assert.equal((h.settings.activeResearch as any).bucket, 'weekly');
    Object.assign(h.settings, { enabled: false });
  });

  test('v1 snapshots: daily maps to top', async () => {
    assert.equal((await h.req('POST', '/api/research', { json: researchPayload(2), cookie })).status, 200);
    assert.equal((await activate({ researchId: 2, bucket: 'hourly', rank: 1 })).status, 400);
    const ok = await activate({ researchId: 2, bucket: 'daily', rank: 2 });
    assert.equal(ok.status, 200);
    assert.equal((h.settings.strategy as any).id, 'ema_cross-btc-4h-1');
  });

  test('a stale snapshot id is a 409', async () => {
    const stale = await activate({ researchId: 1, bucket: 'hourly', rank: 1 });
    assert.equal(stale.status, 409);
    assert.match(await error(stale), /updated since this page loaded/);
    assert.equal((h.settings.activeResearch as any).researchId, 2);
  });

  test('live mode needs confirmLive', async () => {
    Object.assign(h.settings, { mode: 'live' });
    const before = JSON.stringify(h.settings.strategy);
    for (const json of [
      { researchId: 2, bucket: 'daily', rank: 1, start: true },
      { researchId: 2, bucket: 'daily', rank: 1, start: false },
      { researchId: 2, bucket: 'daily', rank: 1, start: true, confirmLive: false },
    ]) {
      const res = await activate(json);
      assert.equal(res.status, 400);
      assert.match(await error(res), /confirmLive/);
    }
    assert.equal(JSON.stringify(h.settings.strategy), before);
    assert.equal(started, 1);
    const ok = await activate({ researchId: 2, bucket: 'daily', rank: 1, start: true, confirmLive: true });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).started, true);
    assert.equal(started, 2);
    assert.equal(h.settings.mode, 'live');
    Object.assign(h.settings, { mode: 'paper', enabled: false });
  });

  test('a refused start still reports the activation', async () => {
    const h2 = await startHarness({
      enableTrading: async () => {
        throw new FakeSettingsError('Live trading needs BITVAVO_API_KEY');
      },
    });
    try {
      const c = await h2.login();
      await h2.req('POST', '/api/research', { json: researchPayloadV2(), cookie: c });
      const res = await h2.req('POST', '/api/bot/activate', { json: { researchId: 1, bucket: 'daily', rank: 1, start: true }, cookie: c });
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.started, false);
      assert.match(body.startError, /BITVAVO_API_KEY/);
      assert.equal((h2.settings.activeResearch as any).bucket, 'daily');
    } finally {
      await h2.close();
    }
  });
});

describe('security hardening', () => {
  test('rateKey groups an IPv6 /64 and unwraps IPv4-mapped addresses', () => {
    assert.equal(rateKey('203.0.113.7'), '203.0.113.7');
    assert.equal(rateKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(rateKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(rateKey('2001:0db8:0001:0002:ffff:1:2:3'), '2001:db8:1:2::/64');
    assert.equal(rateKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(rateKey('::1'), '0:0:0:0::/64');
  });

  test('changing the password signs every session out', async () => {
    let password = 'first-pass';
    const h = await startHarness({ password: () => password });
    try {
      const cookie = await h.login('first-pass');
      assert.equal((await h.req('GET', '/api/auth/me', { cookie })).status, 200);
      password = 'second-pass';
      assert.equal((await h.req('GET', '/api/auth/me', { cookie })).status, 401);
      password = '';
      assert.equal((await h.req('GET', '/api/auth/me', { cookie })).status, 401);
    } finally {
      await h.close();
    }
  });

  test('failed logins from everywhere together pause login for an hour, and refusals are logged once', async () => {
    const h = await startHarness({ maxLoginAttempts: 1000 });
    try {
      for (let i = 0; i < 50; i++) assert.equal((await h.req('POST', '/api/auth/login', { json: { password: 'x' } })).status, 401);
      const res = await h.req('POST', '/api/auth/login', { json: { password: 'test-pass' } });
      assert.equal(res.status, 429);
      assert.equal(res.headers.get('set-cookie'), null);
      assert.equal(h.logs.filter((l) => l.event === 'login_paused').length, 1);
    } finally {
      await h.close();
    }
    const h2 = await startHarness({ maxLoginAttempts: 2 });
    try {
      for (let i = 0; i < 6; i++) await h2.req('POST', '/api/auth/login', { json: { password: 'x' } });
      assert.equal(h2.logs.filter((l) => l.event === 'login_rate_limited').length, 1);
    } finally {
      await h2.close();
    }
  });

  test('anonymous bodies get a small limit; research uploads may be large once logged in', async () => {
    const h = await startHarness();
    try {
      const padding = 'x'.repeat(100_000);
      const anon = await h.req('POST', '/api/auth/login', { json: { password: 'x', padding } });
      assert.equal(anon.status, 413);
      const big = researchPayload();
      const curve = Array.from({ length: 5000 }, (_, i) => [1700000000 + i * 86400, 1000 + i / 7]);
      big.benchmarks = Array.from({ length: 10 }, (_, i) => ({ name: `b${i}`, returnPct: 1, maxDrawdownPct: 1, equity: curve }));
      assert.ok(JSON.stringify(big).length > 1_000_000);
      assert.equal((await h.req('POST', '/api/research', { json: big })).status, 401);
      assert.equal((await h.req('POST', '/API/Research', { json: big })).status, 401);
      const cookie = await h.login();
      assert.equal((await h.req('POST', '/api/research', { json: big, cookie })).status, 200);
      assert.equal((await h.req('PUT', '/api/bot', { json: { dailyLossLimitEur: 50, padding }, cookie })).status, 413);
      assert.equal((await h.req('PUT', '/api/bot', { json: '{"dailyLossLimitEur": ', cookie })).status, 400);
    } finally {
      await h.close();
    }
  });

  test('research maps cannot carry a __proto__ key', () => {
    const p: any = researchPayload(1);
    p.top[0].metrics = JSON.parse('{"__proto__": null, "returnPct": 1}');
    assert.throws(() => validateResearch(p), /forbidden key/);
  });
});
