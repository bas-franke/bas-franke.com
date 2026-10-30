import { AsyncLocalStorage } from 'node:async_hooks';
import { bitvavo, roundAmount, roundQuote, sizeProblem, type MarketRules } from '../bitvavo/index.js';
import { query } from '../db.js';
import { errText, log } from '../log.js';
import { getBotSettings, getSetting, onSettingsChange, setSetting, updateBotSettings, type BotSettings, type ManualAllocation } from '../settings.js';
import { INTERVAL_MS, validateSpec, type Candle, type StrategySpec } from '../strategies/index.js';
import { candlePlan, decide as decideTargets, isAnchored, prepare, runsInPython } from '../strategies/runtime.js';
import type { Balance, Broker } from './broker.js';
import { LiveBroker } from './live.js';
import { BUY_CASH_MARGIN, checkDay, limitInEur, makerPrice, MARKET_SLIPPAGE, WINDOW_MS, windowBaseline, type LossLimit, planOrders, replayPosition, stopHit, type DayState, type Holding, type OrderIntent } from './logic.js';
import { allPrices, bestBidAsk, closedCandles, eurPrice, marketRules } from './marketData.js';
import { getWallet, PaperBroker, resetPaperWallet } from './paper.js';
import { chaseLeftovers, fillsAfter, fillsFor, maxFillId, openOrders, updateOrder, type Mode, type OrderRow } from './store.js';
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

/** Markets a manual "move everything" trades: the only ones the bot may hold (owner's rule, 2026-10-27). */
export const MANUAL_MARKETS = ['BTC-EUR', 'ETH-EUR'];

/** The stand-in strategy the bot runs while a manual allocation is set: decides every minute, post-only limit
 * orders at the best bid/ask that follow the book (handleChase) like every other limit order. */
export function manualSpec(m: ManualAllocation): StrategySpec {
  const where = m.target === 'EUR' ? 'euros' : m.target;
  return {
    ...validateSpec({
      // any two-market family will do: only its markets, interval and execution are used, never its signal
      family: 'rotation_momentum', markets: MANUAL_MARKETS, interval: '1m', params: { lookback: 3, top: 2 },
      execution: { orderType: 'limit', postOnly: true, limitOffsetBps: 0, timeoutBars: 1, fallback: 'cancel' },
    }),
    id: `manual-${m.target.toLowerCase()}-${m.setAt}`,
    name: `Manual: everything in ${where}`,
  };
}

export const manualWeights = (m: ManualAllocation): Record<string, number> =>
  Object.fromEntries(MANUAL_MARKETS.map((mk) => [mk, mk === `${m.target}-EUR` ? 1 : 0]));

/** The settings the loop acts on: a manual allocation replaces the strategy while it is set. */
export const effective = (s: BotSettings): BotSettings => (s.manual ? { ...s, strategy: manualSpec(s.manual) } : s);

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
    if (JSON.stringify(before.manual) !== JSON.stringify(after.manual))
      pending.push({ cancelMode: after.mode, resetStrategy: after.mode, reason: after.manual ? `moving everything to ${after.manual.target}` : 'back to the strategy' });
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
  const s = effective(await getBotSettings());
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
    s.dailyLossLimit,
  );
  if (!ms.day) check.state.lastFillId = afterId;
  if (check.newDay) await log('info', 'day_start', `Loss window starts at €${check.state.startEquity.toFixed(2)} equity (${s.mode}); the limit counts the last 24 h from here`);
  if (check.flowEur) await log('warn', 'balance_flow', `Balance changed by €${check.flowEur.toFixed(2)} without a trade (deposit or withdrawal?); the daily loss baseline moved with it`, { flowEur: check.flowEur });
  ms.day = check.state;
  lastDayState[s.mode] = check.state;
  await saveState(st);
  if (check.tripped) {
    const limitText = `${fmtLimit(s.dailyLossLimit)}${s.dailyLossLimit.unit === 'pct' ? ` (€${check.limitEur.toFixed(2)})` : ''}`;
    await log('error', 'daily_loss_limit', `Loss over the last 24 h is €${check.lossEur.toFixed(2)}, at or over the ${limitText} limit: cancelling orders and switching the bot off`, { lossEur: check.lossEur, limitEur: check.limitEur, limit: s.dailyLossLimit, baselineEur: check.baselineEur, equity: pf.equityEur });
    await switchOff(`24 h loss limit of ${limitText} reached`, 'error');
    return;
  }

  const stillValid = () => status.settingsVersion === version;

  fills += await handleTimeouts(s, broker, now, stillValid);
  fills += await handleChase(s, broker, now, stillValid);
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

const CHASE_SUFFIX = / \((repriced|rest at market)\)$/;

/**
 * Order-book chase (settings.chase, always on): a limit order still unfilled `repriceSec` after it was placed is
 * cancelled and placed again for the unfilled rest one tick inside the best bid (buy) or best ask (sell) (makerPrice),
 * post-only as before, unless it already leads the book. Once the first order of the chain is `marketAfterMin` old,
 * the rest goes out as a market order. Buys are capped to the free cash (taker fee and margin kept free, as in
 * planOrders). A cancel Bitvavo has not confirmed yet is continued on a later tick, once sync has closed the order.
 */
async function handleChase(s: BotSettings, broker: Broker, now: number, stillValid: () => boolean): Promise<number> {
  const c = s.chase;
  let placed = 0;
  for (const o of await openOrders(s.mode)) {
    if (o.orderType !== 'limit' || o.meta.chaseSince === undefined || o.status === 'pending' || !stillValid()) continue;
    const toMarket = now - o.meta.chaseSince >= c.marketAfterMin * 60_000;
    if (!toMarket && now - o.meta.activeFrom < c.repriceSec * 1000) continue;
    const rules = (await marketRules()).get(o.market);
    if (!rules) continue;
    const book = await bestBidAsk(o.market);
    const target = makerPrice(o.side, book, rules, o.price);
    if (!toMarket && Number(target) === o.price) continue; // still leads the book: keep its place in the queue
    const why = toMarket ? `not filled within ${c.marketAfterMin} min: the rest goes at market` : `repricing to the order book (${target})`;
    await updateOrder(o.id, {}, { chaseCancelAt: now }); // before cancelling: a later tick may finish the chain
    if (!(await broker.cancel(o, why))) continue;
    placed += await continueChase(s, broker, o, now, stillValid);
  }
  for (const o of await chaseLeftovers(s.mode, now - CHASE_LEFTOVER_MS)) {
    if (!stillValid()) break;
    if (o.strategyId !== s.strategy.id || (await openOrders(s.mode, o.market)).some((x) => x.side === o.side)) {
      await updateOrder(o.id, {}, { chaseDone: true }); // the strategy moved on, or a newer order already works
      continue;
    }
    await log('info', 'chase_resumed', `${o.market}: order ${o.id} is cancelled now; placing its rest again`, { orderId: o.id });
    placed += await continueChase(s, broker, o, now, stillValid);
  }
  return placed;
}

/** How long after a chase cancel the chain may still be continued. */
const CHASE_LEFTOVER_MS = 5 * 60_000;

/** Places the unfilled rest of a cancelled chase order again: at the book, or at market once the chain is old. */
async function continueChase(s: BotSettings, broker: Broker, o: OrderRow, now: number, stillValid: () => boolean): Promise<number> {
  const c = s.chase;
  await updateOrder(o.id, {}, { chaseDone: true }); // before placing: never two re-placements for one order
  const rules = (await marketRules()).get(o.market);
  if (!rules || !stillValid()) return 0;
  const toMarket = now - (o.meta.chaseSince ?? now) >= c.marketAfterMin * 60_000;
  const { rows } = await query('SELECT amount, filled_amount FROM orders WHERE id = $1', [o.id]);
  let rest = Number(rows[0]?.amount ?? o.amount) - Number(rows[0]?.filled_amount ?? o.filledAmount ?? 0);
  if (!(rest > 0)) return 0;
  const book = await bestBidAsk(o.market);
  const target = makerPrice(o.side, book, rules);
  const price = toMarket ? (o.side === 'buy' ? book.ask : book.bid) : Number(target);
  if (o.side === 'buy') {
    const cash = (await broker.balances()).find((b) => b.symbol === 'EUR')?.available ?? 0;
    rest = Math.min(rest, cash / (price * (1 + s.fees.taker + BUY_CASH_MARGIN + (toMarket ? MARKET_SLIPPAGE : 0))));
  }
  const base = (o.reason ?? 'order').replace(CHASE_SUFFIX, '');
  let intent: OrderIntent;
  if (toMarket && o.side === 'buy') {
    const quote = roundQuote(rest * price, rules.notionalDecimals);
    if (Number(quote) < rules.minOrderInQuoteAsset) {
      await log('info', 'chase_done', `${o.market}: the unfilled rest (€${quote}) is under the minimum order; not sent at market`, { orderId: o.id });
      return 0;
    }
    intent = { market: o.market, side: 'buy', orderType: 'market', amountQuote: quote, postOnly: false, reason: `${base} (rest at market)`, valueEur: Number(quote) };
  } else {
    const amount = roundAmount(rest, rules.quantityDecimals);
    const problem = sizeProblem(rules, Number(amount), price);
    if (problem) {
      await log('info', 'chase_done', `${o.market}: the unfilled rest is too small to place again (${problem})`, { orderId: o.id });
      return 0;
    }
    intent = toMarket
      ? { market: o.market, side: 'sell', orderType: 'market', amount, postOnly: false, reason: `${base} (rest at market)`, valueEur: Number(amount) * price }
      : { market: o.market, side: o.side, orderType: 'limit', amount, price: target, postOnly: o.meta.postOnly, reason: `${base} (repriced)`, valueEur: Number(amount) * price };
  }
  await log('info', toMarket ? 'chase_market' : 'chase_reprice', toMarket
    ? `${o.market}: ${o.side} not filled within ${c.marketAfterMin} min; sending the rest (${intent.amount ?? `€${intent.amountQuote}`}) at market`
    : `${o.market}: ${o.side} ${intent.amount} moved from ${o.price} to ${target} (book ${book.bid} / ${book.ask})`,
    { orderId: o.id, root: o.meta.chaseRoot ?? o.id, book });
  const row = await broker.place(intent, {
    strategyId: o.strategyId, expiresAt: null, fallback: 'cancel', barTime: o.meta.barTime, fees: s.fees,
    ...(toMarket ? {} : { chase: { since: o.meta.chaseSince ?? now, root: o.meta.chaseRoot ?? o.id } }),
  });
  return row ? 1 : 0;
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
  const { markets, bars } = candlePlan(spec);
  const from = isNativeDca(spec) && ms.strategyStart ? barOpen(ms.strategyStart, spec.interval) - Number(spec.params.lookback) * ms_ : undefined;
  const out: Record<string, Candle[]> = {};
  for (const m of markets) out[m] = await closedCandles(m, spec.interval, bar, { bars, from, maxBars: from === undefined ? undefined : DCA_MAX_BARS });
  return out;
}

const isNativeDca = (spec: StrategySpec) => spec.family === 'dca_dip' && !runsInPython(spec);

/** How long the bot keeps retrying a bar whose candle has not arrived: half a bar, at most 5 minutes. */
export const staleGraceMs = (interval: StrategySpec['interval']) => Math.min(INTERVAL_MS[interval] / 2, 5 * 60_000);

/** Bar whose late candle was last reported, so "retrying" is logged once per bar. */
let lateBar: number | null = null;

/** JSON of the strategy whose lab history download was last reported, so "loading" is logged once per strategy. */
let warmingFor: string | null = null;

/** Bars dca_dip must replay at `bar` (from the lookback before its start), or 0 for other families. */
export function dcaBarsNeeded(spec: StrategySpec, strategyStart: number | undefined, bar: number): number {
  if (!isNativeDca(spec) || !strategyStart) return 0;
  const ms = INTERVAL_MS[spec.interval];
  const from = barOpen(strategyStart, spec.interval) - Number(spec.params.lookback) * ms;
  return Math.ceil((bar - from) / ms) + 1;
}

async function decide(s: BotSettings, broker: Broker, ms: ModeState, bar: number, pf: PortfolioView, stillValid: () => boolean, markDecided: () => Promise<void>) {
  const spec = s.strategy;
  if (s.manual) {
    const prices: Record<string, number> = {};
    for (const m of spec.markets) {
      const p = pf.prices.get(m);
      if (p) prices[m] = p;
    }
    return placeTargets(s, broker, ms, bar, pf, manualWeights(s.manual), prices, stillValid, markDecided);
  }
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
  const state = isAnchored(spec) && ms.strategyStart ? { startTime: barOpen(ms.strategyStart, spec.interval) } : undefined;
  const decision = await decideTargets(spec, bar, candles, state);
  if (decision.warming) {
    // A lab family's first run: its full candle history (what the backtest saw) downloads in the background. No
    // decision on this bar until it is there; the next tick asks again.
    const key = JSON.stringify(spec);
    if (warmingFor !== key) {
      warmingFor = key;
      await log('info', 'history_loading', `${spec.name}: downloading the candle history it decides on (${decision.warming.length} market${decision.warming.length === 1 ? '' : 's'}); the first decision follows when that is done`, { markets: decision.warming });
    }
    prepare(spec, (err) => {
      if (err) void log('error', 'history_failed', `${spec.name}: downloading its candle history failed: ${errText(err)}`);
      else {
        void log('info', 'history_ready', `${spec.name}: candle history is ready`);
        kick();
      }
    });
    return;
  }
  if (decision.t !== null && decision.t < bar) {
    // The bar that just closed is not in the candles yet (Bitvavo is late, or the fetch failed): deciding now would
    // act on the previous bar's signal and then never revisit this bar. Retry on the next ticks; only after a grace
    // period (a market with no trades has no candle at all) decide on what there is, and say so.
    const lateMs = Date.now() - (bar + INTERVAL_MS[spec.interval]);
    if (lateMs < staleGraceMs(spec.interval)) {
      if (lateBar !== bar) {
        lateBar = bar;
        await log('info', 'candle_late', `${spec.name}: the ${new Date(bar).toISOString()} candle is not available yet (newest is ${new Date(decision.t).toISOString()}); retrying`, { bar, newest: decision.t });
      }
      return;
    }
    await log('warn', 'stale_candles', `${spec.name}: the ${new Date(bar).toISOString()} candle never arrived; deciding on the newest one there is (${new Date(decision.t).toISOString()})`, { bar, newest: decision.t });
  }
  const prices: Record<string, number> = {};
  for (const m of spec.markets) {
    const cs = candles[m];
    if (cs?.length) prices[m] = cs[cs.length - 1][4];
  }
  return placeTargets(s, broker, ms, bar, pf, decision.weights, prices, stillValid, markDecided);
}

/** Target weights -> orders (planOrders) -> placed, for the strategy's decision or a manual allocation. */
async function placeTargets(
  s: BotSettings, broker: Broker, ms: ModeState, bar: number, pf: PortfolioView, raw: Record<string, number>,
  prices: Record<string, number>, stillValid: () => boolean, markDecided: () => Promise<void>,
) {
  const spec = s.strategy;
  const w = { ...raw };
  for (const m of Object.keys(ms.locks)) {
    if (!spec.markets.includes(m) || (raw[m] ?? 0) === 0) {
      await log('info', 'stop_lock_cleared', `${m}: the strategy's signal reset after the stop exit; it may buy again`);
      delete ms.locks[m];
    } else w[m] = 0;
  }

  const rulesMap = await marketRules();
  const rules: Record<string, MarketRules> = {};
  const holdings: Record<string, Holding> = {};
  let strategyCoins = 0;
  for (const m of spec.markets) {
    const r = rulesMap.get(m);
    if (r) rules[m] = r;
    const b = pf.balances.find((x) => x.symbol === baseOf(m));
    holdings[m] = { total: b ? b.available + b.inOrder : 0, available: b?.available ?? 0 };
    strategyCoins += b ? b.eurValue : 0;
  }
  const openSides: Record<string, Array<'buy' | 'sell'>> = {};
  for (const o of await openOrders(s.mode)) (openSides[o.market] ??= []).push(o.side);
  const otherCoinsEur = pf.equityEur - pf.cashEur - strategyCoins;

  // Limit orders start one tick inside the live best bid (buy) / ask (sell) on Bitvavo's book, not at the candle close.
  const book: Record<string, { bid: number; ask: number }> = {};
  if (spec.execution.orderType === 'limit') {
    for (const m of spec.markets) {
      try {
        book[m] = await bestBidAsk(m);
      } catch (err) {
        await log('warn', 'no_book', `${m}: reading the order book failed (${errText(err)}); pricing from the last close`);
      }
    }
  }

  const plan = planOrders({
    spec, targets: w, equityEur: pf.equityEur, cashAvailableEur: pf.cashAvailableEur, holdings, prices, book, rules,
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
    // Limit orders always follow the order book: handleChase re-prices them and finally sends the rest at market.
    const chase = intent.orderType === 'limit';
    await broker.place(intent, chase
      ? { strategyId: spec.id, expiresAt: null, fallback: 'cancel', barTime: bar, fees: s.fees, chase: { since: Date.now(), root: null } }
      : { strategyId: spec.id, expiresAt, fallback: spec.execution.fallback, barTime: bar, fees: s.fees });
  }
}

const fmtWeights = (w: Record<string, number>) =>
  Object.entries(w).map(([m, v]) => `${m} ${(v * 100).toFixed(1)} %`).join(', ') || 'none';

const fmtLimit = (l: LossLimit) => (l.unit === 'pct' ? `${l.value} %` : `€${l.value}`);

async function dayState(mode: Mode): Promise<DayState | undefined> {
  return lastDayState[mode] ?? (await loadState())[mode].day;
}

export async function todayPnl(mode: Mode, equity: number): Promise<number | null> {
  const day = await dayState(mode);
  if (!day || day.day !== amsterdamDay(Date.now())) return null;
  return equity - day.startEquity;
}

/** For the Overview: change over the rolling 24 h window and the limit in euros right now. */
export async function lossWindow(mode: Mode, equity: number, limit: LossLimit): Promise<{ pnlEur: number | null; baselineEur: number | null; limitEur: number; since: number | null }> {
  const day = await dayState(mode);
  const now = Date.now();
  const baseline = day?.samples?.length ? windowBaseline(day, now) : null;
  if (baseline === null) return { pnlEur: null, baselineEur: null, limitEur: limitInEur(limit, equity), since: null };
  return { pnlEur: equity - baseline, baselineEur: baseline, limitEur: limitInEur(limit, baseline), since: Math.max(day!.samples[0].t, now - WINDOW_MS) };
}

export async function paperWalletSnapshot(startEur: number) {
  return getWallet(startEur);
}
