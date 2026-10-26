import { AsyncLocalStorage } from 'node:async_hooks';
import { bitvavo, roundAmount, roundQuote, sizeProblem, type MarketRules } from '../bitvavo/index.js';
import { query } from '../db.js';
import { errText, log } from '../log.js';
import { getBotSettings, getSetting, onSettingsChange, setSetting, updateBotSettings, type BotSettings } from '../settings.js';
import { dataMarkets, INTERVAL_MS, targets, warmupBars, type Candle, type StrategySpec } from '../strategies/index.js';
import type { Balance, Broker } from './broker.js';
import { LiveBroker } from './live.js';
import { checkDay, planOrders, replayPosition, stopHit, type DayState, type Holding, type OrderIntent } from './logic.js';
import { allPrices, closedCandles, eurPrice, marketRules } from './marketData.js';
import { getWallet, PaperBroker, resetPaperWallet } from './paper.js';
import { fillsAfter, fillsFor, maxFillId, openOrders, updateOrder, type Mode, type OrderRow } from './store.js';
import { amsterdamDay, barOpen, lastClosedBar } from './time.js';

export const TICK_MS = 15_000;
const SNAPSHOT_MS = 5 * 60_000;
const IDLE_REFRESH_MS = 5 * 60_000;
/** How often the bot retries cancelling its own orders that are still open in a mode that is not running. */
const STRAY_RETRY_MS = 60_000;
/** dca_dip replays from the strategy's start; past this many bars the history cannot be loaded and it stops trading. */
export const DCA_MAX_BARS = 50_000;

/** Per-mode engine memory, stored in `settings.bot_state` so restarts pick up where they left off. */
interface ModeState {
  day?: DayState;
  /** Open time of the last bar a decision was made on (never decide twice on one bar). */
  lastDecidedBar?: number;
  /** JSON of the strategy these fields belong to; a different strategy starts fresh. */
  strategyKey?: string;
  strategyStart?: number;
  /** Markets exited by a stop; no re-entry until the strategy's own target for them goes back to 0. */
  locks: Record<string, string>;
  /** Highest price since the current position opened, for the trailing stop. */
  trail: Record<string, { opened: number | null; peak: number }>;
  lastSnapshotAt?: number;
}
type BotState = Record<Mode, ModeState>;
const STATE_KEY = 'bot_state';
const emptyMode = (): ModeState => ({ locks: {}, trail: {} });

async function loadState(): Promise<BotState> {
  const s = await getSetting<Partial<BotState>>(STATE_KEY);
  return {
    paper: { ...emptyMode(), ...(s?.paper ?? {}) },
    live: { ...emptyMode(), ...(s?.live ?? {}) },
  };
}
const saveState = (s: BotState) => setSetting(STATE_KEY, s);

export const paperBroker = new PaperBroker(() => currentPaperStart);
export const liveBroker = new LiveBroker();
let currentPaperStart = 1000;
export const brokerFor = (mode: Mode): Broker => (mode === 'live' ? liveBroker : paperBroker);

// ---------- serialization ----------

const inLock = new AsyncLocalStorage<boolean>();
let lockChain: Promise<unknown> = Promise.resolve();
/** Runs `fn` with exclusive access to orders and state. Re-entrant within the same async call chain. */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (inLock.getStore()) return fn();
  const run = lockChain.then(() => inLock.run(true, fn));
  lockChain = run.catch(() => undefined);
  return run;
}

// ---------- runtime status ----------

export const status = {
  started: false,
  lastTickAt: null as number | null,
  lastTickError: null as string | null,
  startupDone: false,
  lastIdleRefresh: 0,
  /** Bumped by every settings change so a running tick can notice and stop placing orders. */
  settingsVersion: 0,
};

interface PortfolioView {
  at: number;
  mode: Mode;
  balances: Array<Balance & { eurValue: number }>;
  equityEur: number;
  cashEur: number;
  cashAvailableEur: number;
  quantities: Record<string, number>;
  prices: Map<string, number>;
}
const lastPortfolio: Partial<Record<Mode, PortfolioView>> = {};
export const cachedPortfolio = (mode: Mode) => lastPortfolio[mode];
export const lastDayState: Partial<Record<Mode, DayState>> = {};

export async function portfolio(s: BotSettings, mode: Mode = s.mode): Promise<PortfolioView> {
  currentPaperStart = s.paperStartEur;
  const balances = await brokerFor(mode).balances();
  const prices = await allPrices();
  const valued = balances.map((b) => ({ ...b, eurValue: (b.available + b.inOrder) * eurPrice(b.symbol, prices) }));
  const eur = balances.find((b) => b.symbol === 'EUR');
  const view: PortfolioView = {
    at: Date.now(),
    mode,
    balances: valued.filter((b) => b.symbol === 'EUR' || b.available + b.inOrder > 0),
    equityEur: valued.reduce((sum, b) => sum + b.eurValue, 0),
    cashEur: eur ? eur.available + eur.inOrder : 0,
    cashAvailableEur: eur?.available ?? 0,
    quantities: Object.fromEntries(balances.map((b) => [b.symbol, b.available + b.inOrder])),
    prices,
  };
  lastPortfolio[mode] = view;
  return view;
}

// ---------- settings reactions ----------

type Pending = { cancelMode?: Mode; reason: string; resetDay?: Mode; resetStrategy?: Mode; resetPaper?: number };
const pending: Pending[] = [];
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  // Never blocks on the bot lock (that could deadlock with a tick that is switching the bot off); the work is
  // queued and done at the start of the next tick, which is triggered right away.
  onSettingsChange((before, after) => {
    status.settingsVersion++;
    if (before.enabled && !after.enabled) pending.push({ cancelMode: before.mode, reason: 'bot switched off' });
    if (!before.enabled && after.enabled) pending.push({ resetDay: after.mode, reason: 'bot switched on' });
    if (before.mode !== after.mode) pending.push({ cancelMode: before.mode, resetDay: after.mode, reason: `mode changed to ${after.mode}` });
    if (JSON.stringify(before.strategy) !== JSON.stringify(after.strategy))
      pending.push({ cancelMode: after.mode, resetStrategy: after.mode, reason: 'strategy changed' });
    if (before.paperStartEur !== after.paperStartEur) pending.push({ resetPaper: after.paperStartEur, resetDay: 'paper', reason: 'paper start changed' });
    kick();
  });
}

async function runPending() {
  while (pending.length) {
    const p = pending.shift()!;
    try {
      if (p.cancelMode) await cancelAll(p.cancelMode, p.reason);
      if (p.resetPaper !== undefined) await resetPaperWallet(p.resetPaper);
      if (p.resetDay || p.resetStrategy) {
        const st = await loadState();
        if (p.resetDay) st[p.resetDay].day = undefined;
        if (p.resetStrategy) st[p.resetStrategy] = { ...emptyMode(), day: st[p.resetStrategy].day, lastSnapshotAt: st[p.resetStrategy].lastSnapshotAt };
        await saveState(st);
      }
    } catch (err) {
      await log('error', 'settings_reaction_failed', `Could not apply "${p.reason}": ${errText(err)}`);
    }
  }
}

/** Cancels every open order of `mode` that the bot placed. */
export async function cancelAll(mode: Mode, reason: string): Promise<number> {
  let n = 0;
  for (const o of await openOrders(mode)) {
    try {
      if (await brokerFor(mode).cancel(o, reason)) n++;
    } catch (err) {
      await log('error', 'cancel_failed', `Cancelling order ${o.id} failed: ${errText(err)}`);
    }
  }
  return n;
}

/** Switches the bot off (used by the loss guard and the API): cancels open orders first. */
export async function switchOff(reason: string, level: 'info' | 'warn' | 'error' = 'info'): Promise<BotSettings> {
  // A running tick holds the lock; this makes it stop placing orders now instead of finishing its plan first.
  status.settingsVersion++;
  return withLock(async () => {
    const s = await getBotSettings();
    const cancelled = (await cancelAll('paper', reason)) + (await cancelAll('live', reason));
    const after = s.enabled ? await updateBotSettings({ enabled: false }) : s;
    await log(level, 'bot_stopped', `Bot switched off: ${reason}${cancelled ? ` (${cancelled} open order${cancelled === 1 ? '' : 's'} cancelled)` : ''}`);
    return after;
  });
}

// ---------- loop ----------

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let kickTimer: NodeJS.Timeout | null = null;

export function start() {
  if (status.started) return;
  status.started = true;
  listen();
  void log('info', 'engine_started', `Bot engine started (tick every ${TICK_MS / 1000} s)`);
  timer = setInterval(() => void tick(), TICK_MS);
  kick(2000);
}

export function stop() {
  status.started = false;
  if (timer) clearInterval(timer);
  if (kickTimer) clearTimeout(kickTimer);
  timer = null;
  kickTimer = null;
}

/** Runs a tick soon (after settings changes) without waiting for the interval. */
export function kick(delay = 200) {
  if (!status.started) return;
  if (kickTimer) clearTimeout(kickTimer);
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void tick();
  }, delay);
}

export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await withLock(tickBody);
    status.lastTickError = null;
  } catch (err) {
    status.lastTickError = errText(err);
    await log('error', 'tick_failed', `Bot tick failed: ${errText(err)}`, { stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6) : undefined });
  } finally {
    status.lastTickAt = Date.now();
    ticking = false;
  }
}

async function tickBody() {
  await runPending();
  const s = await getBotSettings();
  currentPaperStart = s.paperStartEur;
  const version = status.settingsVersion;
  const now = Date.now();

  if (!status.startupDone) {
    await startup(s);
    status.startupDone = true;
  }
  await cancelStray(s, now);

  if (!s.enabled) {
    if (now - status.lastIdleRefresh > IDLE_REFRESH_MS) {
      status.lastIdleRefresh = now;
      // Keeps the dashboard's numbers and the Bitvavo health flag fresh while the bot is off.
      await portfolio(s).catch(() => undefined);
      if (s.mode === 'paper' && bitvavo.hasKeys) await bitvavo.balance().catch(() => undefined);
      // Orders cancelled by the switch-off may have filled first; keep their rows true.
      if ((await openOrders(s.mode)).length) await brokerFor(s.mode).sync(s.fees).catch(() => undefined);
    }
    return;
  }

  if (s.mode === 'live' && !bitvavo.hasKeys) {
    await switchOff('live mode needs BITVAVO_API_KEY and BITVAVO_API_SECRET on the server', 'error');
    return;
  }

  const broker = brokerFor(s.mode);
  const st = await loadState();
  const ms = st[s.mode];
  const key = JSON.stringify(s.strategy);
  if (ms.strategyKey !== key) {
    st[s.mode] = { ...emptyMode(), day: ms.day, lastSnapshotAt: ms.lastSnapshotAt, strategyKey: key, strategyStart: now };
    await saveState(st);
    await log('info', 'strategy_started', `Running ${s.strategy.name} (${s.strategy.id}) in ${s.mode} mode`, { strategy: s.strategy });
    return tickBody2(s, broker, st, version, now);
  }
  return tickBody2(s, broker, st, version, now);
}

async function tickBody2(s: BotSettings, broker: Broker, st: BotState, version: number, now: number) {
  const ms = st[s.mode];
  let fills = await broker.sync(s.fees);
  let pf = await portfolio(s);

  // Daily loss guard (SPEC §5).
  const afterId = ms.day?.lastFillId ?? (await maxFillId(s.mode));
  const newFills = ms.day ? await fillsAfter(s.mode, afterId) : [];
  const check = checkDay(
    ms.day,
    now,
    pf.equityEur,
    pf.quantities,
    (sym) => eurPrice(sym, pf.prices),
    newFills.map((f) => ({ ...f, base: f.market.split('-')[0] })),
    s.dailyLossLimitEur,
  );
  if (!ms.day) check.state.lastFillId = afterId;
  if (check.newDay) await log('info', 'day_start', `Start-of-day equity for ${check.state.day}: €${check.state.startEquity.toFixed(2)} (${s.mode})`);
  if (check.flowEur) await log('warn', 'balance_flow', `Balance changed by €${check.flowEur.toFixed(2)} without a trade (deposit or withdrawal?); the daily loss baseline moved with it`, { flowEur: check.flowEur });
  ms.day = check.state;
  lastDayState[s.mode] = check.state;
  await saveState(st);
  if (check.tripped) {
    await log('error', 'daily_loss_limit', `Loss today is €${check.lossEur.toFixed(2)}, at or over the €${s.dailyLossLimitEur} limit: cancelling orders and switching the bot off`, { lossEur: check.lossEur, startEquity: check.state.startEquity, equity: pf.equityEur });
    await switchOff(`daily loss limit of €${s.dailyLossLimitEur} reached`, 'error');
    return;
  }

  const stillValid = () => status.settingsVersion === version;

  fills += await handleTimeouts(s, broker, now, stillValid);
  fills += await handleStops(s, broker, ms, pf, stillValid);

  const bar = lastClosedBar(now, s.strategy.interval);
  if (stillValid() && (ms.lastDecidedBar === undefined || bar > ms.lastDecidedBar)) {
    // Remember the bar BEFORE placing anything: a crash mid-way skips the rest of this bar rather than doubling it.
    // Marked right before the first order goes out (not before loading candles, so a failed fetch retries on the
    // next tick instead of skipping the whole bar).
    const markDecided = async () => {
      ms.lastDecidedBar = bar;
      await saveState(st);
    };
    if (fills) pf = await portfolio(s);
    await decide(s, broker, ms, bar, pf, stillValid, markDecided);
    fills += await broker.sync(s.fees);
  }

  if (fills > 0 || !ms.lastSnapshotAt || now - ms.lastSnapshotAt >= SNAPSHOT_MS) {
    if (fills > 0) pf = await portfolio(s);
    await snapshot(s.mode, pf);
    ms.lastSnapshotAt = now;
  }
  await saveState(st);
}

let lastStrayAttempt = 0;
/**
 * Cancels the bot's own orders that are still open in a mode that is not running: all of them while the bot is off,
 * the other mode's while it is on. Covers cancels that failed at switch-off or mode change and orders whose
 * outcome was unknown then (they may have reached the book after all). Retried at most once a minute.
 */
async function cancelStray(s: BotSettings, now: number) {
  if (now - lastStrayAttempt < STRAY_RETRY_MS) return;
  const modes: Mode[] = s.enabled ? [s.mode === 'live' ? 'paper' : 'live'] : ['paper', 'live'];
  for (const mode of modes) {
    if (mode === 'live' && !bitvavo.hasKeys) continue;
    const open = await openOrders(mode);
    if (!open.length) continue;
    lastStrayAttempt = now;
    const why = s.enabled ? `the bot runs in ${s.mode} mode` : 'the bot is off';
    const n = await cancelAll(mode, why);
    await log('warn', 'stray_orders', `${open.length} ${mode} order(s) were still working although ${why}; ${n} cancelled`, { orderIds: open.map((o) => o.id) });
  }
}

async function startup(s: BotSettings) {
  // Crash safety: whatever the DB thinks is open gets checked against the exchange before anything new happens.
  try {
    const liveOpen = await openOrders('live');
    if (bitvavo.hasKeys) {
      await bitvavo.syncTime().catch(() => undefined);
      if (liveOpen.length || s.mode === 'live') {
        await liveBroker.reconcile();
        await log('info', 'reconciled', `Checked ${liveOpen.length} open live order(s) with Bitvavo after start`);
      } else await bitvavo.balance().catch(() => undefined);
    } else if (liveOpen.length) {
      await log('error', 'reconcile_failed', `${liveOpen.length} live order(s) are open in the DB but no Bitvavo key is configured to check them`);
    }
    if ((await openOrders('paper')).length) await paperBroker.sync();
  } catch (err) {
    await log('error', 'reconcile_failed', `Startup reconcile failed: ${errText(err)}`);
  }
}

async function snapshot(mode: Mode, pf: PortfolioView) {
  const holdings = Object.fromEntries(
    pf.balances.filter((b) => b.symbol !== 'EUR').map((b) => [b.symbol, { amount: b.available + b.inOrder, eurValue: b.eurValue }]),
  );
  await query('INSERT INTO equity_snapshots (mode, total_eur, cash_eur, holdings) VALUES ($1, $2, $3, $4)', [
    mode,
    pf.equityEur,
    pf.cashEur,
    JSON.stringify(holdings),
  ]);
}

const baseOf = (market: string) => market.split('-')[0];

async function handleTimeouts(s: BotSettings, broker: Broker, now: number, stillValid: () => boolean): Promise<number> {
  let fills = 0;
  for (const o of await openOrders(s.mode)) {
    if (o.orderType !== 'limit' || !o.meta.expiresAt || now < o.meta.expiresAt) continue;
    const ok = await broker.cancel(o, `not filled within ${s.strategy.execution.timeoutBars} bar(s)`);
    if (!ok || o.meta.fallback !== 'market' || o.meta.fallbackDone || !stillValid()) continue;
    const { rows } = await query('SELECT amount, filled_amount FROM orders WHERE id = $1', [o.id]);
    const remaining = Number(rows[0].amount) - Number(rows[0].filled_amount);
    await updateOrder(o.id, {}, { fallbackDone: true }); // before placing: never two fallbacks for one order
    const rules = (await marketRules()).get(o.market);
    if (!rules || !(remaining > 0)) continue;
    const price = o.price ?? 0;
    const intent: OrderIntent =
      o.side === 'sell'
        ? { market: o.market, side: 'sell', orderType: 'market', amount: roundAmount(remaining, rules.quantityDecimals), postOnly: false, reason: `market fallback for order ${o.id}`, valueEur: remaining * price }
        : { market: o.market, side: 'buy', orderType: 'market', amountQuote: roundQuote(remaining * price, rules.notionalDecimals), postOnly: false, reason: `market fallback for order ${o.id}`, valueEur: remaining * price };
    if ((o.side === 'sell' && sizeProblem(rules, Number(intent.amount), price)) || (o.side === 'buy' && Number(intent.amountQuote) < rules.minOrderInQuoteAsset)) {
      await log('info', 'fallback_skipped', `Fallback for order ${o.id} skipped: the rest is under the minimum order size`);
      continue;
    }
    const placed = await broker.place(intent, { strategyId: o.strategyId, expiresAt: null, fallback: 'cancel', fees: s.fees });
    if (placed) fills++;
  }
  return fills;
}

async function handleStops(s: BotSettings, broker: Broker, ms: ModeState, pf: PortfolioView, stillValid: () => boolean): Promise<number> {
  const risk = s.strategy.risk;
  if (!risk.stopLossPct && !risk.takeProfitPct && !risk.trailingStopPct) return 0;
  let placed = 0;
  for (const m of s.strategy.markets) {
    const pos = replayPosition(await fillsFor(s.mode, m));
    if (!(pos.qty > 0)) {
      delete ms.trail[m];
      continue;
    }
    const price = pf.prices.get(m);
    if (!price) continue;
    let tr = ms.trail[m];
    if (!tr || tr.opened !== pos.openedByFill) tr = { opened: pos.openedByFill, peak: Math.max(price, pos.avgEntry) };
    tr.peak = Math.max(tr.peak, price);
    ms.trail[m] = tr;
    const hit = stopHit(risk, pos.avgEntry, tr.peak, price);
    if (!hit || ms.locks[m] || !stillValid()) continue;
    ms.locks[m] = hit;
    await log('warn', 'stop_triggered', `${m}: ${hit}; selling the position at market`, { avgEntry: pos.avgEntry, peak: tr.peak, price });
    for (const o of await openOrders(s.mode, m)) await broker.cancel(o, 'stop triggered');
    const bal = (await broker.balances()).find((b) => b.symbol === baseOf(m));
    const rules = (await marketRules()).get(m);
    if (!rules) continue;
    const amount = roundAmount(Math.min(bal?.available ?? 0, pos.qty), rules.quantityDecimals);
    const problem = sizeProblem(rules, Number(amount), price);
    if (problem) {
      await log('warn', 'stop_skipped', `${m}: stop exit skipped: ${problem}`);
      continue;
    }
    if (await broker.place({ market: m, side: 'sell', orderType: 'market', amount, postOnly: false, reason: hit, valueEur: Number(amount) * price }, { strategyId: s.strategy.id, expiresAt: null, fallback: 'cancel', fees: s.fees }))
      placed++;
  }
  return placed;
}

async function loadCandles(spec: StrategySpec, ms: ModeState, bar: number): Promise<Record<string, Candle[]>> {
  const ms_ = INTERVAL_MS[spec.interval];
  const bars = warmupBars(spec);
  const from = spec.family === 'dca_dip' && ms.strategyStart ? barOpen(ms.strategyStart, spec.interval) - Number(spec.params.lookback) * ms_ : undefined;
  const out: Record<string, Candle[]> = {};
  for (const m of dataMarkets(spec)) out[m] = await closedCandles(m, spec.interval, bar, { bars, from, maxBars: from === undefined ? undefined : DCA_MAX_BARS });
  return out;
}

/** Bars dca_dip must replay at `bar` (from the lookback before its start), or 0 for other families. */
export function dcaBarsNeeded(spec: StrategySpec, strategyStart: number | undefined, bar: number): number {
  if (spec.family !== 'dca_dip' || !strategyStart) return 0;
  const ms = INTERVAL_MS[spec.interval];
  const from = barOpen(strategyStart, spec.interval) - Number(spec.params.lookback) * ms;
  return Math.ceil((bar - from) / ms) + 1;
}

async function decide(s: BotSettings, broker: Broker, ms: ModeState, bar: number, pf: PortfolioView, stillValid: () => boolean, markDecided: () => Promise<void>) {
  const spec = s.strategy;
  if (dcaBarsNeeded(spec, ms.strategyStart, bar) > DCA_MAX_BARS) {
    // Replaying from a later bar would restart the virtual DCA portfolio at zero and sell the position.
    await markDecided();
    await log('error', 'dca_history_too_long', `${spec.name} has run for more than ${DCA_MAX_BARS} ${spec.interval} bars; its history can no longer be replayed, so it places no orders. Restart the strategy (save it again) to start a new DCA cycle.`);
    return;
  }
  const candles = await loadCandles(spec, ms, bar);
  const missing = spec.markets.filter((m) => !candles[m]?.length);
  if (missing.length === spec.markets.length) {
    await markDecided();
    await log('warn', 'no_candles', `No candles for ${missing.join(', ')}; skipping this bar`);
    return;
  }
  const state = spec.family === 'dca_dip' && ms.strategyStart ? { startTime: barOpen(ms.strategyStart, spec.interval) } : undefined;
  const raw = targets(candles, spec, state);
  const w = { ...raw };
  for (const m of Object.keys(ms.locks)) {
    if (!spec.markets.includes(m) || (raw[m] ?? 0) === 0) {
      await log('info', 'stop_lock_cleared', `${m}: the strategy's signal reset after the stop exit; it may buy again`);
      delete ms.locks[m];
    } else w[m] = 0;
  }

  const rulesMap = await marketRules();
  const rules: Record<string, MarketRules> = {};
  const prices: Record<string, number> = {};
  const holdings: Record<string, Holding> = {};
  let strategyCoins = 0;
  for (const m of spec.markets) {
    const r = rulesMap.get(m);
    if (r) rules[m] = r;
    const cs = candles[m];
    if (cs?.length) prices[m] = cs[cs.length - 1][4];
    const b = pf.balances.find((x) => x.symbol === baseOf(m));
    holdings[m] = { total: b ? b.available + b.inOrder : 0, available: b?.available ?? 0 };
    strategyCoins += b ? b.eurValue : 0;
  }
  const openSides: Record<string, Array<'buy' | 'sell'>> = {};
  for (const o of await openOrders(s.mode)) (openSides[o.market] ??= []).push(o.side);
  const otherCoinsEur = pf.equityEur - pf.cashEur - strategyCoins;

  const plan = planOrders({
    spec, targets: w, equityEur: pf.equityEur, cashAvailableEur: pf.cashAvailableEur, holdings, prices, rules,
    maxExposureEur: s.maxExposureEur, otherCoinsEur, openSides, fees: s.fees,
  });
  await log('info', 'decision', `Bar ${new Date(bar).toISOString()}: targets ${fmtWeights(w)}; ${plan.orders.length ? plan.orders.map((o) => `${o.side} ${o.market} €${o.valueEur.toFixed(2)}`).join(', ') : 'no orders'}`, {
    bar, targets: raw, locked: Object.keys(ms.locks), equityEur: pf.equityEur, cashEur: pf.cashAvailableEur, notes: plan.notes, orders: plan.orders,
  });
  await markDecided();
  if (!stillValid()) {
    await log('info', 'decision_aborted', 'Settings changed during the decision; no orders placed');
    return;
  }
  for (const m of plan.cancelMarkets) for (const o of await openOrders(s.mode, m)) await broker.cancel(o, 'strategy changed direction');
  const expiresAt = bar + INTERVAL_MS[spec.interval] * (1 + spec.execution.timeoutBars);
  for (const intent of plan.orders) {
    if (!stillValid()) break;
    await broker.place(intent, { strategyId: spec.id, expiresAt, fallback: spec.execution.fallback, barTime: bar, fees: s.fees });
  }
}

const fmtWeights = (w: Record<string, number>) =>
  Object.entries(w).map(([m, v]) => `${m} ${(v * 100).toFixed(1)} %`).join(', ') || 'none';

export async function todayPnl(mode: Mode, equity: number): Promise<number | null> {
  let day = lastDayState[mode];
  if (!day) day = (await loadState())[mode].day;
  if (!day || day.day !== amsterdamDay(Date.now())) return null;
  return equity - day.startEquity;
}

export async function paperWalletSnapshot(startEur: number) {
  return getWallet(startEur);
}
