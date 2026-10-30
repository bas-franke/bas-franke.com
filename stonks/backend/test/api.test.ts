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
    const settingsErr = await put({ dailyLossLimit: { unit: 'pct', value: -5 } });
    assert.equal(settingsErr.status, 400);
    assert.match(((await settingsErr.json()) as any).error, /dailyLossLimit/);

    const ok = await put({ dailyLossLimit: { unit: 'eur', value: 50 } });
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as any).dailyLossLimit.value, 50);
    const goLive = await put({ mode: 'live', confirmLive: true });
    assert.equal(goLive.status, 200);
    assert.equal(h.settings.mode, 'live');
    assert.equal('confirmLive' in h.settings, false);
    // already live: re-saving the form with mode "live" needs no new confirmation
    assert.equal((await put({ mode: 'live', dailyLossLimit: { unit: 'eur', value: 60 } })).status, 200);
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
    // With a mode, only orders since that mode's portfolio history began are listed.
    assert.match(o.call.sql, /mode = \$1 AND market = \$2 AND id < \$3 AND created_at >= COALESCE\(\(SELECT min\(ts\) FROM equity_snapshots WHERE mode = \$1\), 'epoch'\) ORDER BY id DESC LIMIT 500/);
    const fm = await get('/api/fills?mode=live');
    assert.match(fm.call.sql, /WHERE mode = \$1 AND executed_at >= COALESCE\(\(SELECT min\(ts\) FROM equity_snapshots WHERE mode = \$1\), 'epoch'\) ORDER BY/);
    assert.deepEqual(fm.call.params, ['live']);
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
    assert.deepEqual(Object.keys(good.buckets), ['minute', 'hourly', 'daily', 'weekly', 'mixed']);
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

describe('POST /api/bot/allocate', () => {
  let h: Harness;
  let cookie: string;
  let started = 0;
  before(async () => {
    h = await startHarness({
      enableTrading: async () => {
        started++;
        return Object.assign(h.settings, { enabled: true });
      },
    });
    cookie = await h.login();
  });
  after(() => h.close());
  const allocate = (json: unknown) => h.req('POST', '/api/bot/allocate', { json, cookie });

  test('paper: moves everything to ETH and switches the bot on', async () => {
    const res = await allocate({ target: 'ETH' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.started, true);
    assert.equal(started, 1);
    assert.equal((h.settings.manual as any).target, 'ETH');
    assert.ok(!Number.isNaN(Date.parse((h.settings.manual as any).setAt)));
    assert.ok(h.logs.some((l) => l.event === 'manual_allocation'));
  });

  test('a running bot is not started again; null goes back to the strategy', async () => {
    assert.equal((await allocate({ target: 'EUR' })).status, 200);
    assert.equal(started, 1);
    assert.equal((h.settings.manual as any).target, 'EUR');
    const back = await allocate({ target: null });
    assert.equal(back.status, 200);
    assert.equal(h.settings.manual, null);
    assert.ok(h.logs.some((l) => l.event === 'manual_cleared'));
  });

  test('live mode needs confirmLive; bad targets are refused', async () => {
    Object.assign(h.settings, { mode: 'live', manual: null });
    const res = await allocate({ target: 'BTC' });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).error, /real money/);
    assert.equal(h.settings.manual, null);
    assert.equal((await allocate({ target: 'BTC', confirmLive: true })).status, 200);
    assert.equal((h.settings.manual as any).target, 'BTC');
    for (const bad of [{ target: 'SOL' }, { target: 'ETH', confirmLive: 'yes' }, [], {}]) assert.equal((await allocate(bad)).status, 400);
    Object.assign(h.settings, { mode: 'paper', manual: null, enabled: false });
  });
});

describe('going live: strategy confirmation', () => {
  const spec = (id: string, slow = 48) => ({ id, name: id, family: 'ema_cross', params: { fast: 12, slow } });
  let h: Harness;
  let cookie: string;
  before(async () => {
    h = await startHarness();
    cookie = await h.login();
    assert.equal((await h.req('POST', '/api/research', { json: researchPayloadV2(), cookie })).status, 200);
  });
  after(() => h.close());
  const put = (json: unknown) => h.req('PUT', '/api/bot', { json, cookie });
  const activate = (json: unknown) => h.req('POST', '/api/bot/activate', { json, cookie });
  const paperWith = (id: string) => Object.assign(h.settings, { mode: 'paper', strategy: spec(id) });
  const liveWith = (id: string) => Object.assign(h.settings, { mode: 'live', strategy: spec(id) });

  test('switching to live needs only the confirmation', async () => {
    paperWith('s1');
    const res = await put({ mode: 'live' });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).error, /confirmLive/);
    assert.equal(h.settings.mode, 'paper');
    assert.equal((await put({ mode: 'live', confirmLive: true })).status, 200);
    assert.equal(h.settings.mode, 'live');
  });

  test('a new strategy while live needs only the confirmation', async () => {
    liveWith('s1');
    const unconfirmed = await put({ strategy: spec('s2') });
    assert.equal(unconfirmed.status, 400);
    assert.match(((await unconfirmed.json()) as any).error, /confirmLive/);
    assert.equal((h.settings.strategy as any).id, 's1');
    assert.equal((await put({ strategy: spec('s2'), confirmLive: true })).status, 200);
    assert.equal((h.settings.strategy as any).id, 's2');
  });

  test('same id with other params is a change too, and needs the confirmation', async () => {
    liveWith('s1');
    assert.equal((await put({ strategy: spec('s1', 50) })).status, 400);
  });

  test('a running live bot is untouched: saving the form, other settings, leaving live', async () => {
    liveWith('s1');
    const reordered = { params: { slow: 48, fast: 12 }, family: 'ema_cross', name: 's1', id: 's1' };
    assert.equal((await put({ mode: 'live', strategy: reordered, dailyLossLimit: { unit: 'eur', value: 60 } })).status, 200);
    assert.equal((await put({ dailyLossLimit: { unit: 'eur', value: 70 } })).status, 200);
    assert.equal((await put({ mode: 'paper', strategy: spec('s9') })).status, 200);
    assert.equal(h.settings.mode, 'paper');
  });

  test('paper mode changes the strategy freely', async () => {
    paperWith('s1');
    assert.equal((await put({ strategy: spec('s2') })).status, 200);
  });

  test('activating while live needs only the confirmation', async () => {
    paperWith('s1');
    assert.equal((await activate({ researchId: 1, bucket: 'daily', rank: 1 })).status, 200);

    liveWith('s1');
    const body = { researchId: 1, bucket: 'daily', rank: 2 };
    assert.equal((await activate(body)).status, 400);
    assert.equal((h.settings.strategy as any).id, 's1');
    assert.equal((await activate({ ...body, confirmLive: true })).status, 200);
    assert.equal((h.settings.strategy as any).id, 'ema_cross-btc-4h-1');
    Object.assign(h.settings, { mode: 'paper' });
  });
});

describe('hall of fame', () => {
  let h: Harness;
  let cookie: string;
  before(async () => {
    h = await startHarness({
      validateSpec: (spec) => {
        if ((spec as { family?: unknown } | null)?.family !== 'ema_cross') throw new Error('unknown family');
      },
      isRunnable: (family) => family === 'ema_cross',
    });
    cookie = await h.login();
  });
  after(() => h.close());
  const add = (json: unknown) => h.req('POST', '/api/hall-of-fame', { json, cookie });
  const list = async () => ((await (await h.req('GET', '/api/hall-of-fame', { cookie })).json()) as any).entries as any[];

  test('keeps a full copy of a research entry, once per spec', async () => {
    assert.equal((await h.req('POST', '/api/research', { json: researchPayloadV2(), cookie })).status, 200);
    const res = await add({ researchId: 1, bucket: 'hourly', rank: 2 });
    assert.equal(res.status, 200);
    const again = await add({ researchId: 1, bucket: 'hourly', rank: 2 });
    assert.equal(again.status, 409);
    const got = await list();
    assert.equal(got.length, 1);
    assert.equal(got[0].bucket, 'hourly');
    assert.equal(got[0].entry.spec.family, 'mystery_family');
    assert.equal(got[0].entry.botReady, false, 'botReady is what this server can run now');
    assert.ok(Array.isArray(got[0].entry.equity) && got[0].entry.explanation.summary);
    assert.ok(h.logs.some((l) => l.event === 'hall_of_fame_added'));
  });

  test('survives newer research uploads and can be activated from its own copy', async () => {
    assert.equal((await add({ researchId: 1, bucket: 'weekly', rank: 1 })).status, 200);
    assert.equal((await h.req('POST', '/api/research', { json: researchPayloadV2(), cookie })).status, 200); // snapshot 2
    const got = await list();
    assert.equal(got.length, 2);
    const weekly = got.find((x) => x.bucket === 'weekly');
    const res = await h.req('POST', '/api/bot/activate', { json: { hallOfFameId: weekly.id, start: false }, cookie });
    assert.equal(res.status, 200);
    assert.equal((h.settings.strategy as any).interval, '1W');
    assert.deepEqual({ ...(h.settings.activeResearch as any), activatedAt: 0 }, { researchId: weekly.id, bucket: 'hall', rank: 1, name: 'ema_cross BTC 1W #1', activatedAt: 0 });
    // a family this server cannot run is refused, as for research picks
    const mystery = got.find((x) => x.bucket === 'hourly');
    assert.equal((await h.req('POST', '/api/bot/activate', { json: { hallOfFameId: mystery.id }, cookie })).status, 400);
  });

  test('can be put in any order, which then sticks', async () => {
    const before = await list();
    assert.ok(before.length >= 2);
    const ids = before.map((x) => Number(x.id)).reverse();
    const put = (json: unknown) => h.req('PUT', '/api/hall-of-fame/order', { json, cookie });
    assert.equal((await put({ ids })).status, 200);
    assert.deepEqual((await list()).map((x) => Number(x.id)), ids);
    assert.equal((await put({ ids: ids.slice(1) })).status, 409, 'a missing id means the list changed meanwhile');
    assert.equal((await put({ ids: [ids[0], ids[0]] })).status, 409);
    assert.equal((await put({ ids: 'x' })).status, 400);
    assert.ok(h.logs.some((l) => l.event === 'hall_of_fame_reordered'));
  });

  test('bad requests and removal', async () => {
    for (const bad of [{}, { researchId: 1, bucket: 'monthly', rank: 1 }, { researchId: 1, bucket: 'daily', rank: 9 }, { researchId: 99, bucket: 'daily', rank: 1 }])
      assert.equal((await add(bad)).status, 400, JSON.stringify(bad));
    const before = await list();
    const del = await h.req('DELETE', `/api/hall-of-fame/${before[0].id}`, { json: {}, cookie });
    assert.equal(del.status, 200);
    assert.equal((await list()).length, before.length - 1);
    assert.equal((await h.req('DELETE', `/api/hall-of-fame/${before[0].id}`, { json: {}, cookie })).status, 404);
    assert.equal((await h.req('POST', '/api/bot/activate', { json: { hallOfFameId: before[0].id }, cookie })).status, 400);
    assert.ok(h.logs.some((l) => l.event === 'hall_of_fame_removed'));
  });
});

describe('portfolio vs buy and hold', () => {
  const T0 = Date.parse('2026-10-27T12:00:00Z');
  let h: Harness;
  let cookie: string;
  const asked: Array<{ market: string; from: number; to: number }> = [];
  const tables = {
    // min(ts) for "all", then the portfolio rows, then the track rows (the fake answers by table name)
    equity_snapshots: [{ first: new Date(T0 - 3 * 86_400_000), ts: new Date(T0 - 3 * 86_400_000), v: '400' }, { ts: new Date(T0 - 60_000), v: '440' }],
    track_points: [{ ts: new Date(T0 - 120_000), btc_eur: '72000', eth_eur: '2100' }, { ts: new Date(T0 - 60_000), btc_eur: '72100', eth_eur: null }],
  };
  before(async () => {
    h = await startHarness(
      {
        now: () => T0,
        priceHistory: async (market, from, to) => {
          asked.push({ market, from, to });
          return [[from + 1000, market === 'BTC-EUR' ? 70000 : 2000], [to - 1000, market === 'BTC-EUR' ? 71000 : 2050]];
        },
      },
      tables,
    );
    cookie = await h.login();
  });
  after(() => h.close());

  test('BTC and ETH start where the portfolio starts, filled from candles before the first minute point', async () => {
    const res = await h.req('GET', '/api/compare?range=week', { cookie });
    assert.equal(res.status, 200);
    const b = (await res.json()) as any;
    assert.equal(b.range, 'week');
    assert.equal(Date.parse(b.from), T0 - 7 * 86_400_000);
    assert.equal(Date.parse(b.start), T0 - 3 * 86_400_000, 'the portfolio began 3 days ago, so the race starts there');
    assert.ok(b.btc[0][0] >= T0 - 3 * 86_400_000 && b.eth[0][0] >= T0 - 3 * 86_400_000);
    assert.deepEqual(b.btc.map((p: number[]) => p[1]), [70000, 71000, 72000, 72100]);
    assert.deepEqual(b.eth.map((p: number[]) => p[1]), [2000, 2050, 2100], 'a missing price is skipped, not zero');
    assert.deepEqual(asked.map((a) => [a.market, a.from, a.to]), [['BTC-EUR', T0 - 3 * 86_400_000, T0 - 120_000], ['ETH-EUR', T0 - 3 * 86_400_000, T0 - 120_000]]);
    assert.ok(b.portfolio.length >= 2);
    const sql = h.calls.map((c) => c.sql).join(' ; ');
    assert.ok(!/INSERT|UPDATE|DELETE/.test(sql), 'reading the chart writes nothing');
  });

  test('with no portfolio points (just cleared) BTC and ETH start again from scratch too', async () => {
    const empty = await startHarness(
      { now: () => T0, priceHistory: async (_m, from, to) => [[from + 1000, 1], [to - 1000, 2]] },
      { equity_snapshots: [], track_points: [{ ts: new Date(T0 - 2 * 86_400_000), btc_eur: '70000', eth_eur: '2000' }] },
    );
    try {
      const b = (await (await empty.req('GET', '/api/compare?range=week', { cookie: await empty.login() })).json()) as any;
      assert.deepEqual([b.portfolio, b.btc, b.eth], [[], [], []]);
    } finally {
      await empty.close();
    }
  });

  test('"all" starts at the first portfolio point; bad ranges are refused', async () => {
    const b = (await (await h.req('GET', '/api/compare?range=all', { cookie })).json()) as any;
    assert.equal(Date.parse(b.from), T0 - 3 * 86_400_000);
    assert.equal((await h.req('GET', '/api/compare?range=decade', { cookie })).status, 400);
  });

  test('clearing the portfolio history needs CLEAR and deletes only the chart history of that mode', async () => {
    assert.equal((await h.req('POST', '/api/portfolio-history/clear', { json: { confirm: 'clear' }, cookie })).status, 400);
    const n = h.calls.length;
    const res = await h.req('POST', '/api/portfolio-history/clear', { json: { confirm: 'CLEAR' }, cookie });
    assert.equal(res.status, 200);
    const sql = h.calls.slice(n).map((c) => c.sql);
    assert.deepEqual(sql.filter((q) => q.startsWith('DELETE')), ['DELETE FROM equity_snapshots WHERE mode = $1', 'DELETE FROM track_points WHERE mode = $1']);
    assert.deepEqual(h.calls.slice(n).filter((c) => c.sql.startsWith('DELETE')).map((c) => c.params), [['paper'], ['paper']]);
    assert.ok(h.logs.some((l) => l.event === 'portfolio_history_cleared'));
    assert.ok(h.calls.slice(n).some((c) => c.sql.includes("'tracking_reset'") && c.params?.[0] === 'paper')); // expected vs actual starts over too
  });

  test('resetting expected vs actual needs RESET and deletes nothing', async () => {
    assert.equal((await h.req('POST', '/api/tracking/reset', { json: {}, cookie })).status, 400);
    assert.equal((await h.req('POST', '/api/tracking/reset', { json: { confirm: 'RESET' } })).status, 401);
    const n = h.calls.length;
    const res = await h.req('POST', '/api/tracking/reset', { json: { confirm: 'RESET' }, cookie });
    assert.equal(res.status, 200);
    const sql = h.calls.slice(n).map((c) => c.sql);
    assert.ok(sql.some((q) => q.includes("'tracking_reset'")));
    assert.equal(sql.some((q) => q.startsWith('DELETE')), false);
    assert.ok(h.logs.some((l) => l.event === 'tracking_reset'));
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
      assert.equal((await h.req('PUT', '/api/bot', { json: { dailyLossLimit: { unit: 'eur', value: 50 }, padding }, cookie })).status, 413);
      assert.equal((await h.req('PUT', '/api/bot', { json: '{"dailyLossLimit": ', cookie })).status, 400);
    } finally {
      await h.close();
    }
  });

  test('notes start empty, then save and reject a bad body', async () => {
    const h = await startHarness();
    try {
      const cookie = await h.login();
      assert.equal((await h.req('GET', '/api/notes')).status, 401);
      const first = await h.req('GET', '/api/notes', { cookie });
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { text: '', updatedAt: null });
      assert.equal((await h.req('PUT', '/api/notes', { json: { text: 'buy milk' }, cookie })).status, 200);
      const again = (await (await h.req('GET', '/api/notes', { cookie })).json()) as { text: string; updatedAt: string | null };
      assert.equal(again.text, 'buy milk');
      assert.equal(typeof again.updatedAt, 'string');
      assert.equal((await h.req('PUT', '/api/notes', { json: { text: 1 }, cookie })).status, 400);
      assert.equal((await h.req('PUT', '/api/notes', { json: { text: 'x'.repeat(50_001) }, cookie })).status, 400);
      const still = (await (await h.req('GET', '/api/notes', { cookie })).json()) as { text: string };
      assert.equal(still.text, 'buy milk');
      assert.equal((await h.req('PUT', '/api/notes', { json: { text: '' }, cookie })).status, 200);
      assert.equal(((await (await h.req('GET', '/api/notes', { cookie })).json()) as { text: string }).text, '');
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
