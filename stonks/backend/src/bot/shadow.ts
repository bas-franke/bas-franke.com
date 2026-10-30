import { query } from '../db.js';
import { errText, log } from '../log.js';
import { getBotSettings, getSetting, setSetting } from '../settings.js';
import type { Interval } from '../strategies/index.js';
import { cachedPortfolio, effective } from './engine.js';
import { CHURN_MIN_EUR, CHURN_MIN_FRACTION } from './logic.js';
import { allPrices, closedCandles } from './marketData.js';
import type { Mode } from './store.js';

// Expected vs actual (SPEC.md §5b). Beside the trading loop, like track.ts: no orders, no settings. It reads the `decision`
// rows of bot_logs and keeps a virtual portfolio that follows those targets by the backtest's rule (fills at the
// decision bar's close, maker fee, dead-band), so the gap to the real portfolio shows what execution costs.
//
// bot_logs are never pruned, so everything here can be rebuilt: the state in `settings.shadow_state` is only a cursor
// plus the running result. Without it the runner replays bot_logs from the start; rows are keyed so a replay adds nothing twice.

export const SHADOW_MS = 60_000;
const STATE_KEY = 'shadow_state';
const BATCH = 2000;
const PORTFOLIO_FRESH_MS = 6 * 60_000;
const DAY_MS = 86_400_000;
const DRIFT_CHECK_MS = 3_600_000;

export const GAP_ALERT_PCT = -5;
export const GAP_ALERT_DAYS = 30;
export const SLIPPAGE_ALERT_BPS = 25;
export const SLIPPAGE_ALERT_FILLS = 10;

type Prices = Record<string, number>;

export interface Virtual {
  strategyId: string;
  mode: Mode;
  markets: string[];
  since: number;
  startEur: number;
  cash: number;
  qty: Record<string, number>;
  /** The same start money in the strategy's markets, equal split, never traded. */
  holdCash: number;
  holdQty: Record<string, number>;
  lastBar: number;
  lastPrices: Prices;
  decisions: number;
  withOrders: number;
}

export interface ShadowState {
  lastLogId: number;
  /** What the newest strategy_started / bot_started row said; decision rows without their own ids fall back on it. */
  cur: { mode?: Mode; strategyId?: string; markets?: string[]; interval?: Interval };
  modes: Partial<Record<Mode, Virtual>>;
  lastDriftAt?: number;
}

const emptyState = (): ShadowState => ({ lastLogId: 0, cur: {}, modes: {} });

// ---------- the virtual portfolio (pure) ----------

export function startVirtual(strategyId: string, mode: Mode, markets: string[], at: number, equityEur: number, prices: Prices): Virtual {
  const per = equityEur / Math.max(1, markets.length);
  const holdQty: Record<string, number> = {};
  let holdCash = 0;
  for (const m of markets) {
    if (prices[m] > 0) holdQty[m] = per / prices[m];
    else holdCash += per; // no price at the start: that share stays in euros
  }
  return { strategyId, mode, markets, since: at, startEur: equityEur, cash: equityEur, qty: {}, holdCash, holdQty, lastBar: -1, lastPrices: {}, decisions: 0, withOrders: 0 };
}

const worth = (cash: number, qty: Record<string, number>, prices: Prices, fallback: Prices) =>
  Object.entries(qty).reduce((sum, [m, q]) => sum + q * (prices[m] ?? fallback[m] ?? 0), cash);

export const expectedValue = (v: Virtual, prices: Prices) => worth(v.cash, v.qty, prices, v.lastPrices);
export const holdValue = (v: Virtual, prices: Prices) => worth(v.holdCash, v.holdQty, prices, v.lastPrices);

/** The executor's rule (planOrders) at the bar's close: sells first, buys scaled to the cash, maker fee, dead-band. */
export function rebalance(v: Virtual, targets: Record<string, number>, prices: Prices, makerFee: number): void {
  const equity = expectedValue(v, prices);
  if (!(equity > 0)) return;
  const threshold = Math.max(CHURN_MIN_EUR, CHURN_MIN_FRACTION * equity);
  const buys: Array<{ market: string; eur: number }> = [];
  for (const m of v.markets) {
    const price = prices[m];
    if (!(price > 0)) continue;
    const qty = v.qty[m] ?? 0;
    const target = Math.max(0, targets[m] ?? 0) * equity;
    const diff = target - qty * price;
    const fullExit = target === 0 && qty > 0;
    if (!fullExit && Math.abs(diff) < threshold) continue;
    if (diff > 0) {
      buys.push({ market: m, eur: diff });
      continue;
    }
    const sold = fullExit ? qty : -diff / price;
    v.qty[m] = qty - sold;
    if (fullExit) delete v.qty[m];
    v.cash += sold * price * (1 - makerFee);
  }
  const wanted = buys.reduce((sum, b) => sum + b.eur, 0);
  const scale = wanted > 0 ? Math.min(1, v.cash / (1 + makerFee) / wanted) : 0;
  for (const b of buys) {
    const eur = b.eur * scale;
    v.cash -= eur * (1 + makerFee);
    v.qty[b.market] = (v.qty[b.market] ?? 0) + eur / prices[b.market];
  }
}

// ---------- slippage and drift (pure) ----------

export interface FillRow {
  market: string;
  side: string;
  price: number;
  fee: number;
  feeCurrency: string | null;
  taker: boolean | null;
  bar: number | null;
}

export interface Slippage {
  /** Every fill of this strategy; takerShare and feesEur cover all of them. */
  fills: number;
  /** Fills with a decision to compare with (stop exits and fallbacks have none); avgBps covers these. */
  measured: number;
  avgBps: number | null;
  takerShare: number | null;
  feesEur: number;
}

/** Fill price vs the decision bar's close, in bps, adverse positive. */
export function slippageBps(side: string, price: number, close: number): number {
  return ((side === 'buy' ? price - close : close - price) / close) * 10_000;
}

export function slippageStats(fills: FillRow[], pricesByBar: Map<number, Prices>): Slippage {
  const bps: number[] = [];
  for (const f of fills) {
    const close = f.bar === null ? undefined : pricesByBar.get(f.bar)?.[f.market];
    if (close && close > 0) bps.push(slippageBps(f.side, f.price, close));
  }
  return {
    fills: fills.length,
    measured: bps.length,
    avgBps: bps.length ? bps.reduce((a, b) => a + b, 0) / bps.length : null,
    takerShare: fills.length ? fills.filter((f) => f.taker).length / fills.length : null,
    feesEur: fills.reduce((sum, f) => sum + (f.feeCurrency === null || f.feeCurrency === 'EUR' ? f.fee : 0), 0),
  };
}

export interface DriftAlert {
  kind: 'gap' | 'slippage';
  message: string;
}

export function driftAlerts(gapPct: number | null, days: number, slip: Slippage): DriftAlert[] {
  const out: DriftAlert[] = [];
  if (gapPct !== null && gapPct < GAP_ALERT_PCT && days >= GAP_ALERT_DAYS)
    out.push({ kind: 'gap', message: `The portfolio is ${gapPct.toFixed(1)} % behind what the strategy should have made over ${Math.floor(days)} days.` });
  if (slip.avgBps !== null && slip.avgBps > SLIPPAGE_ALERT_BPS && slip.measured >= SLIPPAGE_ALERT_FILLS)
    out.push({ kind: 'slippage', message: `Fills average ${slip.avgBps.toFixed(1)} bps worse than the decision close over ${slip.measured} fills.` });
  return out;
}

// ---------- reading bot_logs ----------

interface LogRow {
  id: string | number;
  ts: Date | string;
  event: string;
  message: string;
  data: any;
}

const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
const isMode = (v: unknown): v is Mode => v === 'paper' || v === 'live';
const modeIn = (message: string): Mode | undefined => /\b(paper|live) mode\b/.exec(message)?.[1] as Mode | undefined;

/** Bar closes from candles, for decision rows logged before they carried their own prices. */
function closeLookup(lastBar: number) {
  const loaded = new Map<string, { from: number; closes: Map<number, number> }>();
  return async (market: string, interval: Interval, bar: number): Promise<number | undefined> => {
    const key = `${market} ${interval}`;
    let entry = loaded.get(key);
    if (!entry || bar < entry.from) {
      const candles = await closedCandles(market, interval, lastBar, { bars: 2, from: bar, maxBars: 10_000 });
      entry = { from: bar, closes: new Map(candles.map((c) => [c[0], c[4]])) };
      loaded.set(key, entry);
    }
    return entry.closes.get(bar);
  };
}

async function decisionPrices(row: LogRow, markets: string[], interval: Interval | undefined, known: Prices, closeAt: ReturnType<typeof closeLookup>): Promise<Prices> {
  const given: Record<string, unknown> = row.data?.prices ?? {};
  const out: Prices = {};
  for (const m of markets) {
    const p = Number(given[m]);
    const close = p > 0 ? p : interval ? await closeAt(m, interval, Number(row.data.bar)) : undefined;
    const price = close ?? known[m];
    if (price > 0) out[m] = price;
  }
  return out;
}

const insertPoint = (ts: number, mode: Mode, strategyId: string, expected: number, actual: number | null, hold: number) =>
  query(
    `INSERT INTO shadow_points (ts, mode, strategy_id, expected_eur, actual_eur, hold_eur) VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6)
     ON CONFLICT (mode, strategy_id, ts) DO NOTHING`,
    [ts, mode, strategyId, expected, actual, hold],
  );

async function applyDecision(st: ShadowState, row: LogRow, fallbackMode: Mode, fallbackStrategy: string, makerFee: number, closeAt: ReturnType<typeof closeLookup>) {
  const d = row.data;
  const at = ms(row.ts);
  const bar = Number(d?.bar);
  const equity = Number(d?.equityEur);
  if (!Number.isFinite(bar) || !(equity > 0) || !d?.targets) return;
  const mode: Mode = isMode(d.mode) ? d.mode : st.cur.mode ?? fallbackMode;
  const strategyId: string = d.strategyId ?? st.cur.strategyId ?? fallbackStrategy;
  const sameStrategy = st.cur.strategyId === strategyId;
  const markets = sameStrategy && st.cur.markets ? st.cur.markets : Object.keys(d.targets);
  const interval = sameStrategy ? st.cur.interval : undefined;

  let v = st.modes[mode];
  const isNew = !v || v.strategyId !== strategyId;
  if (!isNew && bar <= v!.lastBar) return; // the same bar again after a crash
  const prices = await decisionPrices(row, markets, interval, isNew ? {} : v!.lastPrices, closeAt);
  if (!Object.keys(prices).length) return;
  if (isNew) v = st.modes[mode] = startVirtual(strategyId, mode, markets, at, equity, prices);

  const targets: Record<string, number> = { ...d.targets };
  for (const m of d.locked ?? []) targets[m] = 0; // a market locked by a stop stays out until its signal resets
  rebalance(v!, targets, prices, makerFee);
  v!.lastBar = bar;
  v!.lastPrices = { ...v!.lastPrices, ...prices };
  v!.decisions++;
  const withOrders = (d.orders?.length ?? 0) > 0;
  if (withOrders) v!.withOrders++;

  await query(
    `INSERT INTO shadow_decisions (mode, strategy_id, bar, ts, prices, with_orders) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6)
     ON CONFLICT (mode, strategy_id, bar) DO NOTHING`,
    [mode, strategyId, bar, at, JSON.stringify(prices), withOrders],
  );
  await insertPoint(at, mode, strategyId, expectedValue(v!, prices), equity, holdValue(v!, prices));
}

function applyRowSync(st: ShadowState, row: LogRow) {
  if (row.event === 'strategy_started') {
    const spec = row.data?.strategy;
    st.cur = { mode: modeIn(row.message) ?? st.cur.mode, strategyId: spec?.id, markets: spec?.markets, interval: spec?.interval };
  } else if (row.event === 'bot_started') {
    st.cur.mode = modeIn(row.message) ?? st.cur.mode;
  } else if (row.event === 'balance_flow') {
    // Deposits and withdrawals move all three lines, or they would read as a gap.
    const flow = Number(row.data?.flowEur);
    const v = st.cur.mode && st.modes[st.cur.mode];
    if (v && Number.isFinite(flow)) {
      v.cash += flow;
      v.holdCash += flow;
    }
  }
}

/** Follows bot_logs from the cursor. Failing halfway leaves the cursor at the last finished batch. */
async function catchUp(st: ShadowState, fallbackMode: Mode, fallbackStrategy: string, makerFee: number) {
  for (;;) {
    const { rows } = await query<any>(
      `SELECT id, ts, event, message, data FROM bot_logs
       WHERE id > $1 AND event IN ('decision', 'strategy_started', 'bot_started', 'balance_flow') ORDER BY id LIMIT ${BATCH}`,
      [st.lastLogId],
    );
    if (!rows.length) return;
    const closeAt = closeLookup(Math.max(...rows.map((r) => Number(r.data?.bar)).filter(Number.isFinite), 0));
    for (const row of rows as LogRow[]) {
      if (row.event === 'decision') await applyDecision(st, row, fallbackMode, fallbackStrategy, makerFee, closeAt);
      else applyRowSync(st, row);
      st.lastLogId = Number(row.id);
    }
    await setSetting(STATE_KEY, st);
    if (rows.length < BATCH) return;
  }
}

// ---------- the report behind GET /api/tracking ----------

export type TrackingQuery = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;

type Pt = [number, number];
const MAX_POINTS = 500;

export const RANGE_MS = { day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS, year: 365 * DAY_MS } as const;
export type TrackingRange = keyof typeof RANGE_MS | 'all';

async function strategyFills(q: TrackingQuery, v: Virtual): Promise<Slippage> {
  const { rows } = await q(
    `SELECT f.market, f.side, f.price, f.fee, f.fee_currency, f.taker, o.raw->>'barTime' AS bar
     FROM fills f JOIN orders o ON o.id = f.order_id
     WHERE f.mode = $1 AND o.strategy_id = $2 AND f.executed_at >= to_timestamp($3 / 1000.0)`,
    [v.mode, v.strategyId, v.since],
  );
  const fills: FillRow[] = rows.map((r) => ({
    market: r.market, side: r.side, price: Number(r.price), fee: Number(r.fee), feeCurrency: r.fee_currency, taker: r.taker, bar: r.bar === null ? null : Number(r.bar),
  }));
  const bars = [...new Set(fills.map((f) => f.bar).filter((b): b is number => b !== null))];
  const pricesByBar = new Map<number, Prices>();
  if (bars.length) {
    const d = await q('SELECT bar, prices FROM shadow_decisions WHERE mode = $1 AND strategy_id = $2 AND bar = ANY($3::bigint[])', [v.mode, v.strategyId, bars]);
    for (const r of d.rows) pricesByBar.set(Number(r.bar), r.prices);
  }
  return slippageStats(fills, pricesByBar);
}

async function latestGap(q: TrackingQuery, v: Virtual): Promise<number | null> {
  const { rows } = await q(
    `SELECT expected_eur, actual_eur FROM shadow_points WHERE mode = $1 AND strategy_id = $2 AND actual_eur IS NOT NULL ORDER BY ts DESC LIMIT 1`,
    [v.mode, v.strategyId],
  );
  const expected = Number(rows[0]?.expected_eur);
  return expected > 0 ? (Number(rows[0].actual_eur) / expected - 1) * 100 : null;
}

const daysSince = (v: Virtual, now: number) => (now - v.since) / DAY_MS;

async function driftOf(q: TrackingQuery, v: Virtual, now: number) {
  const [gapPct, slippage] = await Promise.all([latestGap(q, v), strategyFills(q, v)]);
  return { gapPct, slippage, alerts: driftAlerts(gapPct, daysSince(v, now), slippage) };
}

/** The strategy that mode runs now: its points, the gap since its start, slippage and any decay flags. */
export async function trackingReport(q: TrackingQuery, mode: Mode, range: TrackingRange, now = Date.now()) {
  const state = (await q('SELECT value FROM settings WHERE key = $1', [STATE_KEY])).rows[0]?.value as ShadowState | undefined;
  const v = state?.modes?.[mode];
  if (!v) {
    return {
      mode, range, strategyId: null, since: null, expected: [] as Pt[], actual: [] as Pt[], hold: [] as Pt[], gapPct: null,
      slippage: { fills: 0, measured: 0, avgBps: null, takerShare: null, feesEur: 0 } as Slippage,
      decisions: { total: 0, withOrders: 0 }, alerts: [] as DriftAlert[],
    };
  }
  const from = range === 'all' ? v.since : Math.max(v.since, now - RANGE_MS[range]);
  // Evenly thinned in SQL, because a year is half a million rows; the newest point always stays.
  const { rows } = await q(
    `SELECT ts, expected_eur, actual_eur, hold_eur FROM (
       SELECT *, row_number() OVER (ORDER BY ts) AS rn, count(*) OVER () AS total FROM shadow_points
       WHERE mode = $1 AND strategy_id = $2 AND ts >= to_timestamp($3 / 1000.0)
     ) x WHERE (rn - 1) % GREATEST(ceil(total / ${MAX_POINTS - 1}.0)::bigint, 1) = 0 OR rn = total ORDER BY ts`,
    [mode, v.strategyId, from],
  );
  const series = (col: string): Pt[] => rows.filter((r) => r[col] !== null).map((r) => [ms(r.ts), Number(r[col])]);
  const { gapPct, slippage, alerts } = await driftOf(q, v, now);
  return {
    mode,
    range,
    strategyId: v.strategyId,
    since: new Date(v.since).toISOString(),
    expected: series('expected_eur'),
    actual: series('actual_eur'),
    hold: series('hold_eur'),
    gapPct,
    slippage,
    decisions: { total: v.decisions, withOrders: v.withOrders },
    alerts,
  };
}

// ---------- the runner ----------

let lastDriftCheck = 0;

export async function runShadow(now = Date.now()): Promise<void> {
  const s = effective(await getBotSettings());
  const st = (await getSetting<ShadowState>(STATE_KEY)) ?? emptyState();
  await catchUp(st, s.mode, s.strategy.id, s.fees.maker);

  const v = st.modes[s.mode];
  if (!v || !s.enabled || v.strategyId !== s.strategy.id) return;
  const live = await allPrices();
  const prices: Prices = {};
  for (const m of v.markets) {
    const p = live.get(m);
    if (p) prices[m] = p;
  }
  const pf = cachedPortfolio(s.mode);
  await insertPoint(now, s.mode, v.strategyId, expectedValue(v, prices), pf && now - pf.at < PORTFOLIO_FRESH_MS ? pf.equityEur : null, holdValue(v, prices));

  if (now - lastDriftCheck < DRIFT_CHECK_MS || now - (st.lastDriftAt ?? 0) < DAY_MS) return;
  lastDriftCheck = now;
  const { alerts, gapPct, slippage } = await driftOf((text, params) => query(text, params), v, now);
  if (!alerts.length) return;
  st.lastDriftAt = now;
  await setSetting(STATE_KEY, st);
  await log('warn', 'tracking_drift', alerts.map((a) => a.message).join(' '), { strategyId: v.strategyId, mode: v.mode, gapPct, avgBps: slippage.avgBps });
}

/** For tests. */
export const resetShadow = () => {
  lastDriftCheck = 0;
};

let timer: NodeJS.Timeout | null = null;
let running = false;
let failing = false;

export function startShadow() {
  if (timer) return;
  const run = async () => {
    if (running) return; // a rebuild can take longer than a minute
    running = true;
    try {
      await runShadow();
      failing = false;
    } catch (err) {
      // Logged once per outage, not every minute.
      if (!failing) void log('warn', 'shadow_failed', `Updating expected vs actual failed: ${errText(err)}`);
      failing = true;
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void run(), SHADOW_MS);
  void run();
}

export function stopShadow() {
  if (timer) clearInterval(timer);
  timer = null;
}
