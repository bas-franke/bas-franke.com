// Dev-only fake backend: patches window.fetch for /api/*. Loaded from main.tsx only when VITE_MOCK=1 in dev,
// so production builds never contain it.
//   ?mock=empty      research endpoint returns { empty: true }
//   ?mock=v1         research endpoint returns the old payload without timeframe buckets
//   ?mock=live       bot starts in live mode
//   ?mock=off        bot starts switched off
//   ?mock=login      start logged out
// Any non-empty password logs in, except "wrong".
import type { BotSettings, HallEntry } from '../types';
import { equityPoints, families, fills, initialBot, logs, makeLog, markets, orders, research, researchV2, rng } from './data';

const flags = new URLSearchParams(location.search).get('mock') ?? '';
const KEY = 'stonks-mock-session';
let loggedIn = !flags.includes('login') && sessionStorage.getItem(KEY) !== '0';
let notesText = '';
let notesAt: string | null = null;
let bot: BotSettings = initialBot();
let hall: HallEntry[] = [];
if (flags.includes('off')) bot.enabled = false;
if (flags.includes('live')) bot.mode = 'live';
const liveRng = rng(1234);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const delay = () => new Promise((r) => setTimeout(r, 120 + Math.random() * 260));

function page<T extends { id: number | string; mode: string; market: string }>(rows: T[], q: URLSearchParams) {
  const mode = q.get('mode');
  const market = q.get('market');
  const before = q.get('before');
  const limit = Number(q.get('limit') ?? 50);
  return rows
    .filter((r) => (!mode || r.mode === mode) && (!market || r.market === market) && (!before || Number(r.id) < Number(before)))
    .slice(0, limit);
}

function validate(patch: Partial<BotSettings> & { confirmLive?: boolean }) {
  const errors: Record<string, string> = {};
  if (patch.mode === 'live' && bot.mode !== 'live' && !patch.confirmLive) errors.mode = 'Switching to live needs confirmLive: true.';
  const l = patch.dailyLossLimit;
  if (l !== undefined && !(l.value > 0 && (l.unit === 'eur' || l.value <= 100))) errors.dailyLossLimit = l.unit === 'pct' ? 'Between 0 and 100%.' : 'Must be more than €0.';
  if (patch.maxExposureEur !== undefined && patch.maxExposureEur !== null && !(patch.maxExposureEur >= 5))
    errors.maxExposureEur = 'Must be at least €5, or empty for the whole portfolio.';
  if (patch.paperStartEur !== undefined && !(patch.paperStartEur >= 10)) errors.paperStartEur = 'Must be at least €10.';
  const s = patch.strategy;
  if (s) {
    if (s.family === 'ema_cross' && Number(s.params.fast) >= Number(s.params.slow)) errors['strategy.params.fast'] = 'Fast must be shorter than slow.';
    if (!s.markets?.length) errors['strategy.markets'] = 'Pick a market.';
    if (s.execution.limitOffsetBps < 0 || s.execution.limitOffsetBps > 500) errors['strategy.execution.limitOffsetBps'] = 'Between 0 and 500 bps.';
    for (const k of ['stopLossPct', 'takeProfitPct', 'trailingStopPct'] as const) {
      const v = s.risk[k];
      if (v !== null && !(v > 0 && v < 1)) errors[`strategy.risk.${k}`] = 'Between 0 and 1 (e.g. 0.08 = 8%).';
    }
  }
  return errors;
}

async function handle(method: string, url: URL, body: unknown): Promise<Response> {
  const p = url.pathname.replace(/^\/api/, '');
  const q = url.searchParams;
  if (p === '/health') return json({ status: 'ok', database: true, bitvavo: true, bot: { enabled: bot.enabled, mode: bot.mode } });
  if (p === '/auth/login' && method === 'POST') {
    const pw = (body as { password?: string })?.password ?? '';
    if (!pw || pw === 'wrong') return json({ error: 'Wrong password' }, 401);
    loggedIn = true;
    sessionStorage.setItem(KEY, '1');
    return json({ ok: true });
  }
  if (!loggedIn) return json({ error: 'Not logged in' }, 401);
  if (p === '/auth/me') return json({ loggedIn: true });
  if (p === '/auth/logout') {
    loggedIn = false;
    sessionStorage.setItem(KEY, '0');
    return json({ ok: true });
  }
  if (p === '/overview') {
    const equity = 1184.32;
    return json({
      bot,
      running: bot.enabled,
      lastTickAt: bot.enabled ? new Date(Date.now() - 42_000).toISOString() : null,
      bitvavo: { connected: true },
      balances: [
        { symbol: 'EUR', available: '12.10', inOrder: '0', eurValue: 12.1 },
        { symbol: 'BTC', available: '0.01191000', inOrder: '0', eurValue: 1172.22 },
        { symbol: 'ETH', available: '0.00000000', inOrder: '0', eurValue: 0 },
      ],
      equityEur: equity,
      todayPnlEur: -38.4,
      last24hPnlEur: -52.7,
      lossWindowSince: Date.now() - 24 * 3_600_000,
      dailyLossLimit: bot.dailyLossLimit,
      dailyLossLimitEur: bot.dailyLossLimit.unit === 'pct' ? ((equity + 52.7) * bot.dailyLossLimit.value) / 100 : bot.dailyLossLimit.value,
      activeResearch: bot.activeResearch ?? null,
      openOrders: orders.filter((o) => o.status === 'new' && o.mode === bot.mode).length,
      strategyExplanation:
        bot.strategy.family === 'ema_cross'
          ? `Every ${bot.strategy.interval} the bot compares two moving averages of the ${bot.strategy.markets[0]} price: a fast one over the last ${bot.strategy.params.fast} candles and a slow one over the last ${bot.strategy.params.slow}. While the fast average is above the slow one, the market is trending up and it holds the coin; when it dips below, it sells and waits in euros.`
          : `The bot runs “${bot.strategy.name}” on ${bot.strategy.markets.join(', ')} every ${bot.strategy.interval}.`,
    });
  }
  if (p === '/bot' && method === 'PUT') {
    const patch = body as Partial<BotSettings> & { confirmLive?: boolean };
    const errors = validate(patch);
    if (Object.keys(errors).length) return json({ error: 'Invalid settings', errors }, 400);
    const { confirmLive: _c, ...rest } = patch;
    const strategyChanged = rest.strategy && JSON.stringify(rest.strategy) !== JSON.stringify(bot.strategy);
    bot = { ...bot, ...rest, ...(strategyChanged ? { activeResearch: null } : {}) };
    return json(bot);
  }
  if (p === '/bot/activate' && method === 'POST') {
    const b = body as { researchId?: number; bucket?: string; rank?: number; start?: boolean; confirmLive?: boolean };
    if (flags.includes('v1')) return json({ error: 'Mock: v1 payload has no id' }, 400);
    if (b.researchId !== researchV2.id) return json({ error: 'The research was updated since this page loaded. Reload it and pick the strategy again.' }, 409);
    const entry = researchV2.buckets?.[b.bucket as 'daily']?.top.find((e) => e.rank === b.rank);
    if (!entry) return json({ error: `There is no number ${b.rank} in the ${b.bucket} list of this research.` }, 400);
    if (!entry.botReady) return json({ error: 'This strategy is still waiting to be ported to the bot.' }, 400);
    if (bot.mode === 'live' && b.confirmLive !== true) return json({ error: 'Live mode: confirm it first (confirmLive: true).' }, 400);
    const activeResearch = { researchId: researchV2.id, bucket: b.bucket!, rank: b.rank!, name: entry.spec.name, activatedAt: new Date().toISOString() };
    bot = { ...bot, strategy: entry.spec, activeResearch, enabled: bot.enabled || b.start === true };
    return json({ ok: true, bot, activeResearch, started: b.start === true });
  }
  if (p === '/compare' && method === 'GET') {
    const span = { day: 1, week: 7, month: 30, year: 365, all: 45 }[(q.get('range') ?? 'month') as 'day'] ?? 30;
    const to = Date.now();
    const from = to - span * 86_400_000;
    const walk = (start: number, vol: number, drift: number, seed: number) => {
      let v = start;
      let s = seed;
      return Array.from({ length: 300 }, (_, i) => {
        s = (s * 9301 + 49297) % 233280;
        v *= 1 + drift + vol * (s / 233280 - 0.5);
        return [from + ((to - from) * i) / 299, v] as [number, number];
      });
    };
    return json({
      mode: bot.mode, range: q.get('range') ?? 'month', from: new Date(from).toISOString(), start: new Date(from).toISOString(), to: new Date(to).toISOString(),
      portfolio: walk(1000, 0.02, 0.0004, 7), btc: walk(72000, 0.03, -0.0002, 3), eth: walk(2100, 0.04, -0.0006, 11),
    });
  }
  if (p === '/portfolio-history/clear' && method === 'POST') return json({ ok: true, removed: 1234 });
  // Write-ups: the mixed #1 card gets one; its content comes from public/mock-writeup.json when that file exists (dev only).
  if (p === '/writeups' && method === 'GET') {
    const id = researchV2.buckets?.mixed?.top[0]?.spec.id;
    return json({ writeups: id ? [{ specId: id, title: 'Sample write-up', updatedAt: new Date().toISOString() }] : [] });
  }
  if (p.startsWith('/writeups/') && method === 'GET') {
    const r = await fetch('/mock-writeup.json').catch(() => null);
    if (!r?.ok || !(r.headers.get('content-type') ?? '').includes('json')) return json({ error: 'There is no write-up for this strategy.' }, 404);
    return json(await r.json());
  }
  if (p === '/hall-of-fame' && method === 'GET') return json({ entries: hall });
  if (p === '/hall-of-fame' && method === 'POST') {
    const b = body as { researchId: number; bucket: string; rank: number };
    const entry = researchV2.buckets?.[b.bucket as 'daily']?.top.find((e) => e.rank === b.rank);
    if (!entry) return json({ error: `There is no number ${b.rank} in the ${b.bucket} list of that research.` }, 400);
    if (hall.some((h) => JSON.stringify(h.entry.spec) === JSON.stringify(entry.spec))) return json({ error: 'This strategy is already in the hall of fame.' }, 409);
    const id = hall.reduce((m, h) => Math.max(m, h.id), 0) + 1;
    hall = [{ id, addedAt: new Date().toISOString(), researchId: b.researchId, bucket: b.bucket, rank: b.rank, entry: structuredClone(entry) }, ...hall];
    return json({ ok: true, id });
  }
  if (p.startsWith('/hall-of-fame/') && method === 'DELETE') {
    const id = Number(p.split('/').pop());
    hall = hall.filter((h) => h.id !== id);
    return json({ ok: true });
  }
  if (p === '/bot/allocate' && method === 'POST') {
    const b = (body ?? {}) as { target?: 'BTC' | 'ETH' | 'EUR' | null; confirmLive?: boolean };
    if (b.target && bot.mode === 'live' && !b.confirmLive) return json({ error: 'The bot is in live mode: confirm it first (confirmLive: true).' }, 400);
    const started = !!b.target && !bot.enabled;
    bot = { ...bot, manual: b.target ? { target: b.target, setAt: new Date().toISOString() } : null, enabled: bot.enabled || started };
    return json({ ok: true, bot, started });
  }
  if (p === '/bot/start' && method === 'POST') {
    bot = { ...bot, enabled: true };
    return json(bot);
  }
  if (p === '/bot/stop' && method === 'POST') {
    bot = { ...bot, enabled: false };
    return json(bot);
  }
  if (p === '/orders') return json({ orders: page(orders, q) });
  if (p === '/fills') return json({ fills: page(fills, q) });
  if (p === '/equity') {
    const points = equityPoints(Number(q.get('days') ?? 30));
    // Not in SPEC yet: what the same start value would be worth holding the strategy's market.
    const r2 = rng(5);
    let v = points[0]?.totalEur ?? 1000;
    const buyHold = points.map((pt, i) => {
      if (i) v *= Math.exp(0.00002 + 0.0024 * (r2() - 0.5) * 2.2);
      return { ts: pt.ts, totalEur: Math.round(v * 100) / 100 };
    });
    return json({ points, buyHold });
  }
  if (p === '/logs') {
    if (bot.enabled && liveRng() < 0.6) logs.push(makeLog(Date.now(), liveRng));
    const after = Number(q.get('after') ?? 0);
    const level = q.get('level');
    const limit = Number(q.get('limit') ?? 200);
    const order = ['debug', 'info', 'warn', 'error'];
    let rows = logs.filter((l) => l.id > after && (!level || order.indexOf(l.level) >= order.indexOf(level)));
    // newest first when not tailing, oldest first when tailing with `after`
    rows = after ? rows.slice(0, limit) : rows.slice(-limit).reverse();
    return json({ logs: rows });
  }
  if (p === '/notes' && method === 'GET') return json({ text: notesText, updatedAt: notesAt });
  if (p === '/notes' && method === 'PUT') {
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') return json({ error: 'Send { text }.' }, 400);
    if (text.length > 50_000) return json({ error: 'Notes can be at most 50000 characters.' }, 400);
    notesText = text;
    notesAt = new Date().toISOString();
    return json({ ok: true });
  }
  if (p === '/strategies/families') return json(families);
  if (p === '/markets') return json(markets);
  if (p === '/research') return json(flags.includes('empty') ? { empty: true } : flags.includes('v1') ? research : researchV2);
  return json({ error: `Mock has no route for ${method} ${p}` }, 404);
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  await delay();
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  return handle(method, url, body);
};
console.info('[stonks] mock API active (VITE_MOCK=1)');
