import { statSync } from 'node:fs';
import { bitvavo } from '../bitvavo/index.js';
import { dbReady, query } from '../db.js';
import { getBotSettings, getSetting, type BotSettings } from '../settings.js';
import { INTERVAL_MS, type Interval } from '../strategies/index.js';
import { codeHashOf, labStats, pyFamilies } from '../strategies/python.js';
import { runsInPython } from '../strategies/runtime.js';
import { alertsConfigured, alertStats, scrub } from './alerts.js';
import { cachedPortfolio, effective, guardStatus, lossWindow, staleGraceMs, status as engine } from './engine.js';
import { healthVerdict } from './health.js';
import { closedCandles } from './marketData.js';
import { shadowHealth } from './shadow.js';
import { openOrders, unknownOrders, type Mode, type OrderRow } from './store.js';
import { lastClosedBar } from './time.js';

// GET /api/health/detail: one verdict per part of the bot for the dashboard's Health page (logged in, so amounts are
// fine, secrets are not). Each part is read on its own: one that fails to read says `unknown`, the others still answer.

export type Level = 'ok' | 'warn' | 'fail' | 'unknown';
export interface Component {
  status: Level;
  detail: string;
  checkedAt: string;
  data: Record<string, unknown>;
}
type Verdict = Omit<Component, 'checkedAt'>;

const say = (status: Level, detail: string, data: Record<string, unknown> = {}): Verdict => ({ status, detail, data });
const PRIVATE_FRESH_MS = 10 * 60_000;
const CLOCK_WARN_MS = 3000;
const CLOCK_FAIL_MS = 8000;
const CANDLE_CACHE_MS = 60_000;
const SHADOW_STALE_MS = 5 * 60_000;
const RSS_WARN_MB = 250;
const GUARD_NEAR = 0.7;
const STUCK_EVENTS = ['order_retries_exhausted', 'order_unknown', 'tick_stuck', 'order_rejected', 'order_failed'];

export const worst = (levels: Level[]): Level =>
  levels.includes('fail') ? 'fail' : levels.includes('warn') ? 'warn' : levels.includes('unknown') ? 'unknown' : 'ok';

// ---------- verdicts (pure) ----------

export function engineVerdict(enabled: boolean, database: boolean, lastTickAt: number | null, lastTickError: string | null, uptimeSec: number, now: number): Verdict {
  const v = healthVerdict({ enabled, database, lastTickAt, lastTickError, uptimeSec, now });
  const data = { enabled, ageSec: v.tick.ageSec, lastError: lastTickError && scrub(lastTickError) };
  if (lastTickError) return say('fail', `The last tick failed: ${scrub(lastTickError)}`, data);
  if (!enabled) return say('ok', 'The bot is switched off; the loop keeps watching.', data);
  if (!v.tick.ok) return say('fail', v.tick.ageSec === null ? 'No tick since the start.' : `No tick for ${v.tick.ageSec} s.`, data);
  return say('ok', v.tick.ageSec === null ? 'Starting up.' : `Last tick ${v.tick.ageSec} s ago.`, data);
}

export function bitvavoVerdict(mode: Mode, hasKeys: boolean, lastOkAt: number, lastError: string | null, now: number): Verdict {
  const connected = hasKeys && now - lastOkAt < PRIVATE_FRESH_MS;
  const data = { hasKeys, connected, lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null, lastError: lastError && scrub(lastError) };
  if (connected) return say('ok', 'Private calls work.', data);
  if (!hasKeys) return mode === 'live' ? say('fail', 'Live mode without an API key.', data) : say('ok', 'No API key: paper trading on public prices.', data);
  const why = lastError ? scrub(lastError) : 'no successful private call in the last 10 minutes';
  return say(mode === 'live' ? 'fail' : 'warn', `Not connected: ${why}.`, data);
}

export function clockVerdict(offsetMs: number, lastSyncAt: number): Verdict {
  if (!lastSyncAt) return say('unknown', 'Not measured yet (needs an API key).', { offsetMs: null, lastSyncAt: null });
  const data = { offsetMs: Math.round(offsetMs), lastSyncAt: new Date(lastSyncAt).toISOString() };
  const abs = Math.abs(offsetMs);
  const text = `Server clock is ${Math.round(offsetMs)} ms from Bitvavo's.`;
  return say(abs >= CLOCK_FAIL_MS ? 'fail' : abs >= CLOCK_WARN_MS ? 'warn' : 'ok', text, data);
}

export interface LastDecision {
  at: number;
  bar: number;
  held: string | null;
  strategyId: string | null;
}

/** Bars the newest bar has been waiting, not counting the grace in which a bar's candle may still be coming. */
function barsLate(bar: number, interval: Interval, now: number) {
  const expected = lastClosedBar(now, interval);
  const behind = Math.max(0, Math.round((expected - bar) / INTERVAL_MS[interval]));
  const inGrace = behind === 1 && now < expected + INTERVAL_MS[interval] + staleGraceMs(interval);
  return { expected, behind, late: inGrace ? 0 : behind };
}

export function decisionVerdict(last: LastDecision | null, strategyId: string, interval: Interval, enabled: boolean, now: number): Verdict {
  if (!last || (last.strategyId !== null && last.strategyId !== strategyId))
    return say('unknown', enabled ? 'No decision by this strategy yet.' : 'The bot is off and this strategy has not decided yet.', { interval });
  const { behind, late } = barsLate(last.bar, interval, now);
  const data = { bar: new Date(last.bar).toISOString(), ageSec: Math.round((now - last.at) / 1000), interval, barsBehind: behind, held: last.held };
  if (!enabled) return say('ok', `The bot is off; last decision on the ${data.bar} bar.`, data);
  if (late >= 2) return say('fail', `The last decision is ${behind} ${interval} bars behind.`, data);
  if (late === 1) return say('warn', `The newest ${interval} bar has no decision yet.`, data);
  if (last.held) return say('warn', `Held on the last bar: ${last.held}`, data);
  return say('ok', `Decided on the ${data.bar} bar.`, data);
}

export function candleVerdict(newest: Record<string, number | null>, interval: Interval, now: number): Verdict {
  const markets = Object.entries(newest).map(([market, t]) => ({ market, newest: t === null ? null : new Date(t).toISOString(), ...(t === null ? { behind: Infinity, late: Infinity } : barsLate(t, interval, now)) }));
  const late = Math.max(0, ...markets.map((m) => m.late));
  const data = { interval, markets: markets.map((m) => ({ market: m.market, newest: m.newest, barsBehind: Number.isFinite(m.behind) ? m.behind : null })) };
  if (!markets.length) return say('unknown', 'The strategy has no markets.', data);
  const stale = markets.filter((m) => m.late > 0).map((m) => m.market).join(', ');
  if (late >= 2) return say('fail', `Candles are behind on ${stale}.`, data);
  if (late === 1) return say('warn', `The newest candle is late on ${stale}.`, data);
  return say('ok', 'The newest closed candle is there.', data);
}

export function labVerdict(usesLab: boolean, families: number, stats: typeof labStats, codeHashMatch: boolean | null): Verdict {
  const fail = stats.lastFailure;
  const data = {
    usesLab,
    catalogFamilies: families,
    lastCall: stats.lastCall && { at: new Date(stats.lastCall.at).toISOString(), cmd: stats.lastCall.cmd, ms: stats.lastCall.ms },
    lastFailure: fail && { at: new Date(fail.at).toISOString(), cmd: fail.cmd, error: scrub(fail.error).slice(-300) },
    codeHashMatch,
  };
  if (!usesLab) return say('ok', `This strategy has a TypeScript port; the lab catalog has ${families} families.`, data);
  if (!families) return say('fail', 'The strategy runs on the lab, but no family catalog is loaded.', data);
  if (codeHashMatch === false) return say('fail', 'The family code changed since this strategy started; it is no longer exactly what the research tested.', data);
  if (fail && (!stats.lastCall || fail.at >= stats.lastCall.at)) return say('fail', `The last lab call failed: ${data.lastFailure!.error}`, data);
  if (!stats.lastCall) return say('unknown', 'No lab call since the start.', data);
  return say('ok', `Last ${stats.lastCall.cmd} took ${stats.lastCall.ms} ms.`, data);
}

export function alertsVerdict(configured: boolean, lastSentAt: number | null, lastError: string | null): Verdict {
  const data = { configured, lastSentAt: lastSentAt ? new Date(lastSentAt).toISOString() : null, lastError };
  if (!configured) return say('warn', 'Alert mails are off: SENDGRID_API_KEY, MAIL_FROM or STONKS_ALERT_EMAIL is missing.', data);
  if (lastError) return say('warn', `The last alert mail failed: ${lastError}`, data);
  return say('ok', lastSentAt ? 'Alert mails are on.' : 'Alert mails are on; none sent since the start.', data);
}

export function lossGuardVerdict(limit: BotSettings['dailyLossLimit'], active: boolean, pnlEur: number | null, limitEur: number): Verdict {
  const lossEur = pnlEur === null ? null : Math.max(0, -pnlEur);
  const data = { limit: limit.value, unit: limit.unit, action: limit.action, active, lossEur, limitEur };
  if (active) return say('fail', `The loss guard is active (${limit.action}).`, data);
  if (lossEur === null) return say('unknown', 'The 24 h window has not started.', data);
  const text = `Lost €${lossEur.toFixed(2)} of the €${limitEur.toFixed(2)} limit over 24 h.`;
  return say(limitEur > 0 && lossEur >= GUARD_NEAR * limitEur ? 'warn' : 'ok', text, data);
}

/** A chased order should be gone within minutes; a resting one at its expiry. */
export const orderIsStale = (o: Pick<OrderRow, 'meta'> & { createdAt?: unknown }, ageMs: number, now: number) =>
  o.meta.chaseSince !== undefined ? ageMs > 30 * 60_000 : o.meta.expiresAt ? now > o.meta.expiresAt + 5 * 60_000 : ageMs > 3_600_000;

export function ordersVerdict(ages: number[], stale: number, now: number): Verdict {
  const oldest = ages.length ? Math.max(...ages) : null;
  const data = { open: ages.length, oldestAgeSec: oldest === null ? null : Math.round(oldest / 1000), stale, checkedAt: now };
  if (stale) return say('warn', `${stale} order(s) have been working longer than they should.`, data);
  return say('ok', ages.length ? `${ages.length} open, oldest ${data.oldestAgeSec} s.` : 'No open orders.', data);
}

export function stuckVerdict(counts: Record<string, number>, unknown: number): Verdict {
  const data = {
    retriesExhausted24h: counts.order_retries_exhausted ?? 0,
    unknownOrders: unknown,
    orderUnknown24h: counts.order_unknown ?? 0,
    tickStuck24h: counts.tick_stuck ?? 0,
    rejected24h: counts.order_rejected ?? 0,
    failed24h: counts.order_failed ?? 0,
  };
  const serious = data.retriesExhausted24h + data.tickStuck24h + unknown;
  if (serious) return say('fail', `${data.retriesExhausted24h} exhausted retries, ${unknown} unknown orders and ${data.tickStuck24h} stuck ticks.`, data);
  if (data.rejected24h + data.failed24h + data.orderUnknown24h) return say('warn', `${data.rejected24h + data.failed24h} orders refused or failed in the last 24 h.`, data);
  return say('ok', 'Nothing stuck in the last 24 h.', data);
}

export function shadowVerdict(h: Awaited<ReturnType<typeof shadowHealth>>, enabled: boolean, now: number): Verdict {
  if (!h) return say('unknown', 'No decision has been tracked yet.');
  const ageSec = h.lastPointAt === null ? null : Math.round((now - h.lastPointAt) / 1000);
  const data = { strategyId: h.strategyId, lastPointAgeSec: ageSec, gapPct: h.gapPct, avgBps: h.slippage.avgBps, fills: h.slippage.fills, alerts: h.alerts };
  if (h.alerts.length) return say('warn', h.alerts.map((a) => a.message).join(' '), data);
  if (enabled && (ageSec === null || ageSec * 1000 > SHADOW_STALE_MS)) return say('warn', ageSec === null ? 'No points yet.' : `No new point for ${ageSec} s.`, data);
  return say('ok', h.gapPct === null ? 'Tracking.' : `Portfolio is ${h.gapPct.toFixed(2)} % from expected.`, data);
}

export function processVerdict(uptimeSec: number, deployedAt: number | null, rssMb: number): Verdict {
  const data = { uptimeSec: Math.round(uptimeSec), startedAt: new Date(Date.now() - uptimeSec * 1000).toISOString(), deployedAt: deployedAt ? new Date(deployedAt).toISOString() : null, rssMb: Math.round(rssMb), node: process.version };
  return rssMb > RSS_WARN_MB
    ? say('warn', `Using ${Math.round(rssMb)} MB; PM2 restarts it at 300 MB.`, data)
    : say('ok', `Up for ${Math.round(uptimeSec / 60)} min.`, data);
}

// ---------- reading it all ----------

async function lastDecision(): Promise<LastDecision | null> {
  const { rows } = await query<any>(`SELECT ts, event, data FROM bot_logs WHERE event IN ('decision', 'decision_held') ORDER BY id DESC LIMIT 1`);
  const r = rows[0];
  if (!r || !Number.isFinite(Number(r.data?.bar))) return null;
  return { at: new Date(r.ts).getTime(), bar: Number(r.data.bar), held: r.event === 'decision_held' ? String(r.data?.reason ?? 'held') : null, strategyId: r.data?.strategyId ?? null };
}

let candleCache: { key: string; at: number; newest: Record<string, number | null> } | null = null;

/** Newest closed candle per market, cached a minute: a page refresh must not turn into Bitvavo calls. */
async function newestCandles(markets: string[], interval: Interval, now: number) {
  const key = `${interval} ${markets.join()}`;
  if (candleCache?.key === key && now - candleCache.at < CANDLE_CACHE_MS) return candleCache.newest;
  const bar = lastClosedBar(now, interval);
  const newest: Record<string, number | null> = {};
  for (const m of markets) newest[m] = (await closedCandles(m, interval, bar, { bars: 2 })).at(-1)?.[0] ?? null;
  candleCache = { key, at: now, newest };
  return newest;
}

function deployedAt(): number | null {
  try {
    return statSync(process.argv[1]).mtimeMs; // rsync keeps the build's time, so this is the deployed build
  } catch {
    return null;
  }
}

/** False once the engine reported changed family code since the strategy started (it then stores the new hash). */
async function codeHashMatch(s: BotSettings, mode: Mode): Promise<boolean | null> {
  const ms = (await getSetting<Record<string, { strategyStart?: number; codeHash?: string }>>('bot_state'))?.[mode];
  const deployed = codeHashOf(s.strategy);
  if (!ms?.strategyStart || !ms.codeHash || !deployed) return null;
  const { rows } = await query(`SELECT 1 FROM bot_logs WHERE event = 'family_code_changed' AND ts >= to_timestamp($1 / 1000.0) LIMIT 1`, [ms.strategyStart]);
  return !rows.length && ms.codeHash === deployed;
}

async function stuckCounts(now: number) {
  const { rows } = await query<any>('SELECT event, count(*) AS n FROM bot_logs WHERE ts > to_timestamp($1 / 1000.0) AND event = ANY($2) GROUP BY event', [now - 86_400_000, STUCK_EVENTS]);
  return Object.fromEntries(rows.map((r) => [r.event, Number(r.n)]));
}

export async function healthDetail(now = Date.now()) {
  const checkedAt = new Date(now).toISOString();
  const read = async (fn: () => Verdict | Promise<Verdict>): Promise<Component> => {
    try {
      return { ...(await fn()), checkedAt };
    } catch (err) {
      return { status: 'unknown', detail: `Could not read this: ${scrub(err instanceof Error ? err.message : String(err))}`, checkedAt, data: {} };
    }
  };

  const started = Date.now();
  const dbOk = await dbReady();
  const dbMs = Date.now() - started;
  const s = effective(await getBotSettings());
  const { mode, enabled } = s;
  const interval = s.strategy.interval as Interval;
  const usesLab = !s.manual && runsInPython(s.strategy);

  const [engineC, database, bitvavoC, clock, decision, candles, lab, alerts, lossGuard, orders, stuck, shadow, proc] = await Promise.all([
    read(() => engineVerdict(enabled, dbOk, engine.lastTickAt, engine.lastTickError, process.uptime(), now)),
    read(() => (dbOk ? say('ok', `Answers in ${dbMs} ms.`, { ms: dbMs }) : say('fail', 'The database does not answer.', { ms: dbMs }))),
    read(() => bitvavoVerdict(mode, bitvavo.hasKeys, bitvavo.lastPrivateOkAt, bitvavo.lastPrivateError, now)),
    read(() => clockVerdict(bitvavo.timeOffset, engine.lastClockSync)),
    read(async () => decisionVerdict(await lastDecision(), s.strategy.id, interval, enabled, now)),
    read(async () => candleVerdict(await newestCandles(s.strategy.markets, interval, now), interval, now)),
    read(async () => labVerdict(usesLab, pyFamilies().size, labStats, usesLab ? await codeHashMatch(s, mode) : null)),
    read(() => alertsVerdict(alertsConfigured(), alertStats.lastSentAt, alertStats.lastError)),
    read(async () => {
      const equity = cachedPortfolio(mode)?.equityEur ?? 0;
      const [guard, window] = await Promise.all([guardStatus(mode), lossWindow(mode, equity, s.dailyLossLimit)]);
      return lossGuardVerdict(s.dailyLossLimit, guard !== null, equity > 0 ? window.pnlEur : null, guard?.limitEur ?? window.limitEur);
    }),
    read(async () => {
      const open = await openOrders(mode);
      const ages = open.map((o) => now - (o.meta.chaseSince ?? o.meta.activeFrom));
      return ordersVerdict(ages, open.filter((o, i) => orderIsStale(o, ages[i], now)).length, now);
    }),
    read(async () => stuckVerdict(await stuckCounts(now), (await unknownOrders(mode, now - 7 * 86_400_000)).length)),
    read(async () => shadowVerdict(await shadowHealth((text, params) => query(text, params), mode, now), enabled, now)),
    read(() => processVerdict(process.uptime(), deployedAt(), process.memoryUsage().rss / 1048576)),
  ]);

  const { rows } = await query<any>(`SELECT id, ts, level, event, message FROM bot_logs WHERE level IN ('warn', 'error') ORDER BY id DESC LIMIT 20`).catch(() => ({ rows: [] as any[] }));
  const components = { engine: engineC, database, bitvavo: bitvavoC, clock, decision, candles, lab, alerts, lossGuard, orders, stuckOrders: stuck, shadow, process: proc };
  return {
    status: worst(Object.values(components).map((c) => c.status).filter((l) => l !== 'unknown')),
    checkedAt,
    bot: { enabled, mode, strategyId: s.strategy.id },
    components,
    events: rows.map((r) => ({ id: Number(r.id), ts: new Date(r.ts).toISOString(), level: r.level, event: r.event, message: scrub(String(r.message)) })),
  };
}
