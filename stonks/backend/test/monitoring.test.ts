import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, mock, test } from 'node:test';
import { alertsConfigured, notifyLog, resetAlerts, scrub, shouldAlert } from '../src/bot/alerts.js';
import { healthVerdict } from '../src/bot/health.js';
import { sendTestAlert } from '../src/bot/tradeMail.js';
import { errText, log } from '../src/log.js';
import { startHarness } from './helpers/api-harness.js';

const NAMES = ['SENDGRID_API_KEY', 'BITVAVO_API_SECRET', 'DATABASE_URL'];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
const realFetch = globalThis.fetch;
const flush = () => new Promise((r) => setImmediate(r));

let sent: any[] = [];
let answer: () => Promise<Response>;

function configure() {
  process.env.SENDGRID_API_KEY = 'SG.key.value';
}

beforeEach(() => {
  for (const n of NAMES) delete process.env[n];
  resetAlerts();
  sent = [];
  answer = async () => new Response(null, { status: 202 });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(String(init.body)) });
    return answer();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe('alerts', () => {
  test('which events mail', () => {
    assert.equal(shouldAlert('error', 'anything'), true);
    for (const e of ['decision_held', 'stale_candles', 'stop_skipped']) assert.equal(shouldAlert('warn', e), true);
    for (const e of ['thin_book', 'foreign_coin', 'tracking_drift']) assert.equal(shouldAlert('warn', e), false);
    for (const e of ['login_disabled', 'login_paused', 'family_code_changed']) assert.equal(shouldAlert('error', e), false);
    assert.equal(shouldAlert('info', 'decision_held'), false);
  });

  test('unconfigured does nothing', async () => {
    assert.equal(alertsConfigured(), false);
    notifyLog('error', 'tick_failed', 'boom');
    await flush();
    assert.equal(sent.length, 0);
    assert.deepEqual(await sendTestAlert().then((r) => [r.ok, r.configured]), [false, false]);
  });

  test('mails in SendGrid shape, once per event per 30 min, then counts what it held back', async () => {
    configure();
    const t = 1_000_000_000;
    notifyLog('error', 'tick_failed', 'boom', t);
    notifyLog('error', 'tick_failed', 'boom', t + 1000);
    notifyLog('error', 'tick_failed', 'boom', t + 2000);
    notifyLog('warn', 'stale_candles', 'late', t + 3000);
    await flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].url, 'https://api.sendgrid.com/v3/mail/send');
    assert.equal(sent[0].auth, 'Bearer SG.key.value');
    assert.deepEqual(sent[0].body.personalizations, [{ to: [{ email: 'bas.franke.89@gmail.com' }] }]);
    assert.equal(sent[0].body.from.email, 'stonks@bas-franke.com');
    assert.equal(sent[0].body.subject, '[stonks] tick_failed');
    notifyLog('error', 'tick_failed', 'again', t + 30 * 60_000 + 1);
    await flush();
    assert.equal(sent.length, 3);
    assert.match(sent[2].body.content[0].value, /2 more of these/);
  });

  test('a failed send never throws, and tries again 5 minutes later', async () => {
    configure();
    const errors = mock.method(console, 'error', () => undefined);
    answer = async () => {
      throw new Error('network down');
    };
    const t = 2_000_000_000;
    notifyLog('error', 'tick_failed', 'boom', t);
    await flush();
    answer = async () => new Response(null, { status: 202 });
    notifyLog('error', 'tick_failed', 'boom', t + 60_000);
    await flush();
    assert.equal(sent.length, 1);
    notifyLog('error', 'tick_failed', 'boom', t + 5 * 60_000);
    await flush();
    errors.mock.restore();
    assert.equal(sent.length, 2);
    assert.match(sent[1].body.content[0].value, /2 more of these/);
  });

  test('secrets never reach a mail', async () => {
    configure();
    process.env.BITVAVO_API_SECRET = 'very-secret';
    process.env.DATABASE_URL = 'postgres://u:p@host/db';
    assert.equal(scrub('a very-secret b'), 'a [hidden] b');
    assert.equal(scrub('failed postgres://u:p@host/db now'), 'failed [hidden] now');
    assert.equal(scrub('other postgresql://x:y@z/w end'), 'other [hidden] end');
    assert.equal(scrub('key SG.abc-1.def_2'), 'key [hidden]');
    notifyLog('error', 'tick_failed', 'bad key SG.key.value and very-secret', 1);
    await flush();
    assert.doesNotMatch(JSON.stringify(sent[0].body), /SG\.key|very-secret/);
  });

  test('log() mails without a database and without waiting for it', async () => {
    configure();
    const errors = mock.method(console, 'error', () => undefined);
    await log('error', 'some_event', 'it broke', { secret: 'not in the mail' });
    await flush();
    errors.mock.restore();
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.content[0].value, /it broke/);
    assert.doesNotMatch(JSON.stringify(sent[0].body), /not in the mail/);
    assert.equal(errText(new Error('x')), 'x');
  });

  test('POST /api/bot/test-alert needs a login', async () => {
    const h = await startHarness({ sendTestAlert: async () => ({ ok: true, configured: true }) });
    globalThis.fetch = realFetch;
    try {
      assert.equal((await h.req('POST', '/api/bot/test-alert', { json: {} })).status, 401);
      const cookie = await h.login();
      const res = await h.req('POST', '/api/bot/test-alert', { json: {}, cookie });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, configured: true });
      assert.ok(h.logs.some((l) => l.event === 'alert_test'));
    } finally {
      await h.close();
    }
  });
});

describe('health', () => {
  const now = 10_000_000;
  const base = { enabled: true, database: true, lastTickAt: now - 15_000, lastTickError: null, uptimeSec: 1000, now };

  test('ok while ticking', () => {
    assert.deepEqual(healthVerdict(base), { status: 'ok', tick: { ageSec: 15, ok: true }, lastError: false });
  });

  test('a stale tick is degraded only while the bot is on', () => {
    const stale = { ...base, lastTickAt: now - 121_000 };
    assert.equal(healthVerdict(stale).status, 'degraded');
    assert.equal(healthVerdict(stale).tick.ok, false);
    assert.equal(healthVerdict({ ...stale, enabled: false }).status, 'ok');
  });

  test('a failed last tick or a missing database is degraded', () => {
    const failed = healthVerdict({ ...base, lastTickError: 'boom', enabled: false });
    assert.deepEqual([failed.status, failed.lastError, failed.tick.ok], ['degraded', true, false]);
    assert.equal(healthVerdict({ ...base, database: false }).status, 'degraded');
  });

  test('no tick yet is fine just after start, not later', () => {
    assert.equal(healthVerdict({ ...base, lastTickAt: null, uptimeSec: 5 }).status, 'ok');
    const late = healthVerdict({ ...base, lastTickAt: null, uptimeSec: 300 });
    assert.deepEqual([late.status, late.tick.ageSec], ['degraded', null]);
  });
});
