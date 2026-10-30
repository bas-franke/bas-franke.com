import { AsyncLocalStorage } from 'node:async_hooks';
import { bitvavo, roundAmount, roundQuote, sizeProblem, type MarketRules } from '../bitvavo/index.js';
import { query } from '../db.js';
import { errText, log } from '../log.js';
import { getBotSettings, getSetting, onSettingsChange, setSetting, updateBotSettings, type BotSettings, type ManualAllocation } from '../settings.js';
import { INTERVAL_MS, validateSpec, type Candle, type StrategySpec } from '../strategies/index.js';
import { codeHashOf } from '../strategies/python.js';
import { candlePlan, decide as decideTargets, isAnchored, prepare, runsInPython, TRADED_MARKETS } from '../strategies/runtime.js';
import type { Balance, Broker } from './broker.js';
import { LiveBroker } from './live.js';
import { bookCheck, BUY_CASH_MARGIN, checkDay, followsBook, limitInEur, makerPrice, MARKET_SLIPPAGE, WINDOW_MS, windowBaseline, type LossAction, type LossLimit, planOrders, replayPosition, stopHit, type DayState, type Holding, type OrderIntent, type PlanInput } from './logic.js';
import { allPrices, bestBidAsk, bookDepth, closedCandles, eurPrice, marketRules } from './marketData.js';
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

/** Pause between a bar's order attempts, and how many there may be. */
const RETRY_BACKOFF_MS = 60_000;
export const MAX_ORDER_ATTEMPTS = 5;
/** Bitvavo's clock is measured again this often (and on every timestamp error, see the client). */
const CLOCK_SYNC_MS = 3_600_000;
/** How often `unknown` orders are looked up again. */
const UNKNOWN_RECHECK_MS = 5 * 60_000;
/** Without fresh balances or prices for this long, the loss guard says it is working blind. */
const GUARD_BLIND_MS = 5 * 60_000;
/** A tick running this long is stuck: the process restarts (PM2) instead of trading on nothing. */
export const TICK_STUCK_MS = 5 * 60_000;
const WATCHDOG_EVERY_MS = 30_000;
/** How long `drain` waits for a running tick. */
const DRAIN_WAIT_MS = 25_000;
/** How often a stop exit that cannot go out is reported. */
const STOP_WARN_MS = 10 * 60_000;

/** The loss guard while its limit is reached (SPEC §5). */
export interface GuardState {
  since: number;
  action: LossAction;
  lossEur: number;
  limitEur: number;
}

/**
 * What a bar's decision planned, kept while the bar is current so orders that never got to work are placed again
 * (retryDecision). Sizes stay those of the decision: closes and equity are stored with the weights.
 */
export interface BarDecision {
  bar: number;
  weights: Record<string, number>;
  prices: Record<string, number>;
  equityEur: number;
  /** `eur` = the order as planned, `qty` = coins held at the decision: together they cap what a retry may still buy. */
  planned: Array<{ market: string; side: 'buy' | 'sell'; eur: number; qty: number }>;
  attempts: number;
  nextAt: number;
  done: boolean;
}

/** Per-mode engine memory, stored in `settings.bot_state` so restarts pick up where they left off. */
interface ModeState {
  day?: DayState;
  /** Open time of the last bar a decision was made on (never decide twice on one bar). */
  lastDecidedBar?: number;
  decision?: BarDecision;
  guard?: GuardState;
  /** Last known EUR price per held coin, so one without a ticker keeps its value across restarts. */
  knownPrices?: Record<string, number>;
  /** Coins outside the traded markets already reported for this strategy. */
  foreignWarned?: string[];
  /** JSON of the strategy these fields belong to; a different strategy starts fresh. */
  strategyKey?: string;
  strategyStart?: number;
  /** Lab code hash the strategy started on; a change at the same VERSION is reported once (SPEC §6b). */
  codeHash?: string;
  /** Markets exited by a stop; no re-entry until the strategy's own target for them goes back to 0. */
  locks: Record<string, string>;
  /** Highest price since the current position opened, for the trailing stop. */
  trail: Record<string, { opened: number | null; peak: number }>;
  lastSnapshotAt?: number;
}
type BotState = Record<Mode, ModeState>;
const STATE_KEY = 'bot_state';
const emptyMode = (): ModeState => ({ locks: {}, trail: {} });
/** A new strategy starts fresh; the account's loss window and guard are not the strategy's. */
const nextStrategy = (ms: ModeState): ModeState => ({ ...emptyMode(), day: ms.day, guard: ms.guard, knownPrices: ms.knownPrices, lastSnapshotAt: ms.lastSnapshotAt });

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
  lastClockSync: 0,
  lastUnknownCheck: 0,
  /** Since when the loss guard has had no fresh balances or prices, and whether that was reported. */
  guardBlindSince: null as number | null,
  guardBlindLogged: false,
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
  /** EUR price of a coin: live, or the last one known when it has no ticker (never €0 for a coin that had a price). */
  priceOf: (symbol: string) => number;
}
const lastPortfolio: Partial<Record<Mode, PortfolioView>> = {};
export const cachedPortfolio = (mode: Mode) => lastPortfolio[mode];
export const lastDayState: Partial<Record<Mode, DayState>> = {};
/** The loss guard per mode as of the last check; null = not tripped. */
export const lastGuardState: Partial<Record<Mode, GuardState | null>> = {};
/** Last price seen per market. */
const knownPrices = new Map<string, number>();

export async function portfolio(s: BotSettings, mode: Mode = s.mode): Promise<PortfolioView> {
  currentPaperStart = s.paperStartEur;
  const balances = await brokerFor(mode).balances();
  const prices = await allPrices();
  for (const [m, p] of prices) knownPrices.set(m, p);
  const priceOf = (symbol: string) => eurPrice(symbol, prices) || eurPrice(symbol, knownPrices);
  const valued = balances.map((b) => ({ ...b, eurValue: (b.available + b.inOrder) * priceOf(b.symbol) }));
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
    priceOf,
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
        if (p.resetDay) {
          const ms = st[p.resetDay];
          ms.day = undefined;
          ms.guard = undefined;
          lastGuardState[p.resetDay] = null;
          // Switched on again: as before, the bar in progress is left alone and the next one decides.
          if (ms.decision) ms.decision.done = true;
        }
        if (p.resetStrategy) st[p.resetStrategy] = nextStrategy(st[p.resetStrategy]);
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
let watchdogTimer: NodeJS.Timeout | null = null;
/** When the running tick began, and its promise for `drain`. */
let tickStartedAt: number | null = null;
let running: Promise<void> | null = null;
let draining = false;

export function start() {
  if (status.started) return;
  status.started = true;
  draining = false;
  listen();
  void log('info', 'engine_started', `Bot engine started (tick every ${TICK_MS / 1000} s)`);
  timer = setInterval(() => void tick(), TICK_MS);
  // Outside the tick and its lock: this is what still runs when a tick hangs.
  watchdogTimer = setInterval(() => watchdog(), WATCHDOG_EVERY_MS);
  watchdogTimer.unref();
  kick(2000);
}

export function stop() {
  status.started = false;
  if (timer) clearInterval(timer);
  if (kickTimer) clearTimeout(kickTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  timer = null;
  kickTimer = null;
  watchdogTimer = null;
}

/** For a clean shutdown: no new ticks, and the running one stops placing orders and gets up to 25 s to finish. */
export async function drain(): Promise<void> {
  stop();
  draining = true;
  status.settingsVersion++;
  if (!running) return;
  let wait: NodeJS.Timeout | undefined;
  await Promise.race([running, new Promise((r) => (wait = setTimeout(r, DRAIN_WAIT_MS)))]);
  clearTimeout(wait);
}

/** Exits (PM2 restarts the process) when a tick has been running too long. Returns true when it did. */
export function watchdog(now = Date.now(), exit: (code: number) => void = (code) => process.exit(code)): boolean {
  if (tickStartedAt === null || now - tickStartedAt < TICK_STUCK_MS) return false;
  const minutes = ((now - tickStartedAt) / 60_000).toFixed(1);
  tickStartedAt = null;
  // The log goes to the database, which may be the very thing that hangs.
  const done = () => exit(1);
  void Promise.race([log('error', 'tick_stuck', `A bot tick has been running for ${minutes} min; restarting the process`), new Promise((r) => setTimeout(r, 3000))]).then(done, done);
  return true;
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

export function tick(): Promise<void> {
  if (ticking || draining) return Promise.resolve();
  ticking = true;
  tickStartedAt = Date.now();
  running = runTick();
  return running;
}

async function runTick(): Promise<void> {
  try {
    await withLock(tickBody);
    status.lastTickError = null;
  } catch (err) {
    status.lastTickError = errText(err);
    await log('error', 'tick_failed', `Bot tick failed: ${errText(err)}`, { stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6) : undefined });
  } finally {
    status.lastTickAt = Date.now();
    ticking = false;
    tickStartedAt = null;
    running = null;
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
  if (bitvavo.hasKeys && now - status.lastClockSync >= CLOCK_SYNC_MS) {
    status.lastClockSync = now;
    await bitvavo.syncTime().catch((err) => log('warn', 'clock_sync_failed', `Measuring Bitvavo's clock failed: ${errText(err)}`));
  }
  await cancelStray(s, now);
  await recheckUnknown(now);

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
    st[s.mode] = { ...nextStrategy(ms), strategyKey: key, strategyStart: now, codeHash: codeHashOf(s.strategy) };
    await saveState(st);
    await log('info', 'strategy_started', `Running ${s.strategy.name} (${s.strategy.id}) in ${s.mode} mode`, { strategy: s.strategy });
    return tickBody2(s, broker, st, version, now);
  }
  const code = codeHashOf(s.strategy);
  if (code && code !== ms.codeHash) {
    // The first check after this was added has nothing to compare with; it only records the hash.
    if (ms.codeHash) await log('error', 'family_code_changed', `${s.strategy.name}: the lab code behind it changed without a VERSION bump. The bot keeps trading it, but it is no longer exactly the code the research tested`, { family: s.strategy.family, before: ms.codeHash, after: code });
    ms.codeHash = code;
    await saveState(st);
  }
  return tickBody2(s, broker, st, version, now);
}

async function tickBody2(s: BotSettings, broker: Broker, st: BotState, version: number, now: number) {
  const ms = st[s.mode];
  for (const [symbol, price] of Object.entries(ms.knownPrices ?? {})) if (!knownPrices.has(`${symbol}-EUR`)) knownPrices.set(`${symbol}-EUR`, price);
  // A failed Bitvavo call fails the tick, but only after the loss guard has run on the last known numbers.
  let failure: unknown;
  let fills = 0;
  try {
    fills = await broker.sync(s.fees);
  } catch (err) {
    failure = err;
  }
  let pf: PortfolioView | undefined;
  try {
    pf = await portfolio(s);
  } catch (err) {
    failure ??= err;
  }
  const view = pf ?? (await lastKnownView(ms));
  await watchGuardBlindness(pf ? null : (failure ?? 'no data'), now);
  const stopped = view ? await lossGuard(s, broker, st, view, !pf, now) : false;
  if (failure) throw failure;
  if (stopped || !pf) return;
  const blockBuys = !!ms.guard && s.dailyLossLimit.action === 'no_buys';

  const stillValid = () => status.settingsVersion === version;

  fills += await handleTimeouts(s, broker, now, stillValid, blockBuys);
  fills += await handleChase(s, broker, now, stillValid, blockBuys);
  fills += await handleStops(s, broker, ms, pf, stillValid);

  const bar = lastClosedBar(now, s.strategy.interval);
  if (stillValid() && (ms.lastDecidedBar === undefined || bar > ms.lastDecidedBar)) {
    // Remember the bar and its plan BEFORE placing anything: a crash mid-way resumes through retryDecision, whose
    // open-order check keeps it from doubling what did go out. Marked right before the first order goes out (not
    // before loading candles, so a failed fetch retries on the next tick instead of skipping the whole bar).
    const markDecided = async (decision?: BarDecision) => {
      ms.lastDecidedBar = bar;
      ms.decision = decision;
      await saveState(st);
    };
    if (fills) pf = await portfolio(s);
    await decide(s, broker, ms, bar, pf, stillValid, markDecided, blockBuys);
    fills += await broker.sync(s.fees);
  } else if (stillValid() && ms.decision && !ms.decision.done && ms.decision.bar === bar && now >= ms.decision.nextAt) {
    if (fills) pf = await portfolio(s);
    const placed = await retryDecision(s, broker, ms, ms.decision, pf, now, stillValid, blockBuys);
    if (placed) fills += placed + (await broker.sync(s.fees));
  }

  if (fills > 0 || !ms.lastSnapshotAt || now - ms.lastSnapshotAt >= SNAPSHOT_MS) {
    if (fills > 0) pf = await portfolio(s);
    await snapshot(s.mode, pf);
    ms.lastSnapshotAt = now;
  }
  await saveState(st);
}

type GuardView = Pick<PortfolioView, 'equityEur' | 'quantities' | 'priceOf'>;

/** The portfolio by the last known holdings and prices, for the loss guard when Bitvavo's balances or prices fail. */
async function lastKnownView(ms: ModeState): Promise<GuardView | null> {
  const quantities = ms.day?.lastHoldings;
  if (!quantities) return null;
  const fresh = await allPrices().catch(() => null);
  for (const [m, p] of fresh ?? []) knownPrices.set(m, p);
  const priceOf = (symbol: string) => eurPrice(symbol, knownPrices);
  return { equityEur: Object.entries(quantities).reduce((sum, [symbol, qty]) => sum + qty * priceOf(symbol), 0), quantities, priceOf };
}

/** Says so, once per outage, when the guard has gone without fresh numbers for a while (`failure` null = it has them). */
async function watchGuardBlindness(failure: unknown, now: number) {
  if (failure === null) {
    status.guardBlindSince = null;
    status.guardBlindLogged = false;
    return;
  }
  status.guardBlindSince ??= now;
  if (status.guardBlindLogged || now - status.guardBlindSince < GUARD_BLIND_MS) return;
  status.guardBlindLogged = true;
  await log('error', 'guard_blind', `The loss guard has had no fresh balances or prices for ${Math.round((now - status.guardBlindSince) / 60_000)} min (${errText(failure)}); at best it runs on the last known numbers`);
}

/**
 * Daily loss guard (SPEC §5). Logs a trip once, re-arms when the loss is back under the limit, and acts on
 * `dailyLossLimit.action`. Returns true when it switched the bot off. `stale` = a view from last known numbers: nothing
 * in it can be told from a deposit, so fills wait for a fresh one.
 */
async function lossGuard(s: BotSettings, broker: Broker, st: BotState, pf: GuardView, stale: boolean, now: number): Promise<boolean> {
  const ms = st[s.mode];
  const limit = s.dailyLossLimit;
  const afterId = ms.day?.lastFillId ?? (await maxFillId(s.mode));
  const newFills = ms.day && !stale ? await fillsAfter(s.mode, afterId) : [];
  const check = checkDay(ms.day, now, pf.equityEur, pf.quantities, pf.priceOf, newFills.map((f) => ({ ...f, base: f.market.split('-')[0] })), limit);
  if (!ms.day) check.state.lastFillId = afterId;
  if (check.newDay) await log('info', 'day_start', `Loss window starts at €${check.state.startEquity.toFixed(2)} equity (${s.mode}); the limit counts the last 24 h from here`);
  if (check.flowEur) await log('warn', 'balance_flow', `Balance changed by €${check.flowEur.toFixed(2)} without a trade (deposit or withdrawal?); the daily loss baseline moved with it`, { flowEur: check.flowEur });
  ms.day = check.state;
  lastDayState[s.mode] = check.state;
  ms.knownPrices = Object.fromEntries(Object.keys(pf.quantities).filter((c) => c !== 'EUR' && pf.quantities[c] > 0 && pf.priceOf(c) > 0).map((c) => [c, pf.priceOf(c)]));
  const limitText = `${fmtLimit(limit)}${limit.unit === 'pct' ? ` (€${check.limitEur.toFixed(2)})` : ''}`;
  if (check.tripped && !ms.guard) {
    const consequence = { alert: 'trading goes on', no_buys: 'open buys are cancelled and new buys are withheld, exits go on', stop: 'cancelling orders and switching the bot off' }[limit.action];
    await log('error', 'daily_loss_limit', `Loss over the last 24 h is €${check.lossEur.toFixed(2)}, at or over the ${limitText} limit: ${consequence}`, { lossEur: check.lossEur, limitEur: check.limitEur, limit, baselineEur: check.baselineEur, equity: pf.equityEur });
    ms.guard = { since: now, action: limit.action, lossEur: check.lossEur, limitEur: check.limitEur };
  } else if (!check.tripped && ms.guard && pf.equityEur > 0) {
    await log('info', 'guard_cleared', `Loss over the last 24 h is €${check.lossEur.toFixed(2)}, back under the ${limitText} limit`, { lossEur: check.lossEur, limitEur: check.limitEur, since: ms.guard.since });
    ms.guard = undefined;
  }
  if (check.tripped && limit.action === 'stop') ms.guard = undefined; // switching on again starts a new window
  lastGuardState[s.mode] = ms.guard ?? null;
  await saveState(st);
  if (check.tripped && limit.action === 'stop') {
    await switchOff(`24 h loss limit of ${limitText} reached`, 'error');
    return true;
  }
  // Every tick while it lasts: a cancel Bitvavo did not confirm is simply tried again.
  if (ms.guard && limit.action === 'no_buys')
    for (const o of await openOrders(s.mode))
      if (o.side === 'buy') await broker.cancel(o, 'loss guard: no new buys').catch((err) => log('error', 'cancel_failed', `Cancelling order ${o.id} failed: ${errText(err)}`));
  return false;
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

/** Orders Bitvavo stopped finding no longer block anything but may still have filled (live broker). */
async function recheckUnknown(now: number) {
  if (!bitvavo.hasKeys || now - status.lastUnknownCheck < UNKNOWN_RECHECK_MS) return;
  status.lastUnknownCheck = now;
  await liveBroker.recheckUnknown().catch((err) => log('warn', 'order_sync_failed', `Rechecking unknown orders failed: ${errText(err)}`));
}

async function startup(s: BotSettings) {
  // Crash safety: whatever the DB thinks is open gets checked against the exchange before anything new happens.
  try {
    const liveOpen = await openOrders('live');
    if (bitvavo.hasKeys) {
      await bitvavo.syncTime().catch(() => undefined);
      status.lastClockSync = Date.now();
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

async function handleTimeouts(s: BotSettings, broker: Broker, now: number, stillValid: () => boolean, blockBuys: boolean): Promise<number> {
  let fills = 0;
  for (const o of await openOrders(s.mode)) {
    if (o.orderType !== 'limit' || !o.meta.expiresAt || now < o.meta.expiresAt) continue;
    const ok = await broker.cancel(o, `not filled within ${s.strategy.execution.timeoutBars} bar(s)`);
    if (!ok || o.meta.fallback !== 'market' || o.meta.fallbackDone || !stillValid() || (blockBuys && o.side === 'buy')) continue;
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
async function handleChase(s: BotSettings, broker: Broker, now: number, stillValid: () => boolean, blockBuys: boolean): Promise<number> {
  const c = s.chase;
  let placed = 0;
  for (const o of await openOrders(s.mode)) {
    if (o.orderType !== 'limit' || o.meta.chaseSince === undefined || o.status === 'pending' || !stillValid() || (blockBuys && o.side === 'buy')) continue;
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
    if (o.strategyId !== s.strategy.id || (blockBuys && o.side === 'buy') || (await openOrders(s.mode, o.market)).some((x) => x.side === o.side)) {
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
    // A locked market that still holds a position is an exit that has not happened yet: the lock must not hide it, so
    // every tick tries again (a cancel not confirmed, nothing free to sell yet, a refused order).
    const pending = ms.locks[m];
    const hit = pending ? null : stopHit(risk, pos.avgEntry, tr.peak, price);
    const why = pending ?? hit;
    if (!why || !stillValid()) continue;
    if (hit) {
      ms.locks[m] = hit;
      await log('warn', 'stop_triggered', `${m}: ${hit}; selling the position at market`, { avgEntry: pos.avgEntry, peak: tr.peak, price });
    }
    const rules = (await marketRules()).get(m);
    if (!rules) continue;
    if (pending && pos.qty * price < rules.minOrderInQuoteAsset) continue; // the exit happened: only dust is left
    const open = await openOrders(s.mode, m);
    if (open.some((o) => o.side === 'sell' && o.orderType === 'market')) continue; // the exit is on its way
    for (const o of open) await broker.cancel(o, 'stop triggered');
    const bal = (await broker.balances()).find((b) => b.symbol === baseOf(m));
    const amount = roundAmount(Math.min(bal?.available ?? 0, pos.qty), rules.quantityDecimals);
    const problem = sizeProblem(rules, Number(amount), price);
    if (problem) {
      const warned = stopWarned.get(m) ?? 0;
      if (Date.now() - warned >= STOP_WARN_MS) {
        stopWarned.set(m, Date.now());
        await log('warn', 'stop_skipped', `${m}: stop exit cannot go out yet (${problem}); trying again every tick`);
      }
      continue;
    }
    if (await broker.place({ market: m, side: 'sell', orderType: 'market', amount, postOnly: false, reason: why, valueEur: Number(amount) * price }, { strategyId: s.strategy.id, expiresAt: null, fallback: 'cancel', fees: s.fees }))
      placed++;
  }
  return placed;
}

/** When a market's stop exit that could not go out was last reported. */
const stopWarned = new Map<string, number>();

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

async function decide(s: BotSettings, broker: Broker, ms: ModeState, bar: number, pf: PortfolioView, stillValid: () => boolean, markDecided: (d?: BarDecision) => Promise<void>, blockBuys: boolean) {
  const spec = s.strategy;
  if (s.manual) {
    const prices: Record<string, number> = {};
    for (const m of spec.markets) {
      const p = pf.prices.get(m);
      if (p) prices[m] = p;
    }
    return placeTargets(s, broker, ms, bar, pf, manualWeights(s.manual), prices, stillValid, markDecided, blockBuys);
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
  if (decision.hold !== undefined) {
    // The family cannot decide right now: keep every position and ask again on the next ticks, up to the same grace
    // period as a late candle; then this bar is given up (still without touching anything).
    if (Date.now() - (bar + INTERVAL_MS[spec.interval]) < staleGraceMs(spec.interval)) return;
    await markDecided();
    await log('warn', 'decision_held', `${spec.name}: no decision on the ${new Date(bar).toISOString()} bar (${decision.hold}); every position stays as it is`, { bar, reason: decision.hold, t: decision.t });
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
  return placeTargets(s, broker, ms, bar, pf, decision.weights, prices, stillValid, markDecided, blockBuys);
}

/** Stop locks overrule the strategy: a locked market's weight is 0 until the strategy's own signal goes there. */
const lockedWeights = (raw: Record<string, number>, ms: ModeState) => {
  const w = { ...raw };
  for (const m of Object.keys(ms.locks)) if (m in w) w[m] = 0;
  return w;
};

/** Limit orders of this spec follow the book; a manual move always does. */
const chases = (s: BotSettings) => !!s.manual || followsBook(s.strategy);

/** BTC or ETH held although the strategy has no such market: it is sold (TRADED_MARKETS only, manual moves excepted). */
const strandedMarkets = (s: BotSettings, pf: PortfolioView) =>
  s.manual ? [] : (TRADED_MARKETS as readonly string[]).filter((m) => !s.strategy.markets.includes(m) && (pf.quantities[baseOf(m)] ?? 0) > 0);

/**
 * planOrders on the account as it is now, valued like the backtest: closes for everything that has one (coins and equity
 * alike), so holdings and targets are measured with the same price. A retry passes the decision's equity and `only`.
 */
async function planFor(s: BotSettings, pf: PortfolioView, weights: Record<string, number>, closes: Record<string, number>, retry?: { equityEur: number; only: NonNullable<PlanInput['only']> }) {
  const spec = s.strategy;
  const stranded = strandedMarkets(s, pf);
  const markets = [...spec.markets, ...stranded];
  const prices = { ...closes };
  for (const m of stranded) {
    const p = pf.prices.get(m); // not in the strategy's candles
    if (p) prices[m] = p;
  }
  const rulesMap = await marketRules();
  const rules: Record<string, MarketRules> = {};
  const holdings: Record<string, Holding> = {};
  let liveCoins = 0;
  let closeCoins = 0;
  for (const m of markets) {
    const r = rulesMap.get(m);
    if (r) rules[m] = r;
    const b = pf.balances.find((x) => x.symbol === baseOf(m));
    const total = b ? b.available + b.inOrder : 0;
    holdings[m] = { total, available: b?.available ?? 0 };
    liveCoins += b ? b.eurValue : 0;
    closeCoins += prices[m] ? total * prices[m] : (b?.eurValue ?? 0);
  }
  const openSides: Record<string, Array<'buy' | 'sell'>> = {};
  for (const o of await openOrders(s.mode)) (openSides[o.market] ??= []).push(o.side);
  const otherCoinsEur = pf.equityEur - pf.cashEur - liveCoins;
  const equityEur = retry?.equityEur ?? pf.cashEur + closeCoins + otherCoinsEur;

  // Limit orders that follow the book start one tick inside the live best bid (buy) / ask (sell) on Bitvavo's book, not
  // at the candle close; specs tuned to rest stay at close∓offset. Stranded coins always leave with a chase.
  const book: Record<string, { bid: number; ask: number }> = {};
  if (spec.execution.orderType === 'limit') {
    for (const m of chases(s) ? markets : stranded) {
      try {
        book[m] = await bestBidAsk(m);
      } catch (err) {
        await log('warn', 'no_book', `${m}: reading the order book failed (${errText(err)}); pricing from the last close`);
      }
    }
  }
  const plan = planOrders({
    spec: { ...spec, markets }, targets: weights, equityEur, cashAvailableEur: pf.cashAvailableEur, holdings, prices, book, rules,
    maxExposureEur: s.maxExposureEur, otherCoinsEur, openSides, fees: s.fees, only: retry?.only,
  });
  for (const o of plan.orders) if (stranded.includes(o.market)) o.reason = "not one of this strategy's markets: selling it";
  return { plan, equityEur, prices, stranded, book };
}

/** Places a decision's orders: resting at their price with timeout and fallback, or following the book (handleChase). */
async function placeOrders(s: BotSettings, broker: Broker, orders: OrderIntent[], stranded: string[], bar: number, stillValid: () => boolean) {
  const spec = s.strategy;
  const expiresAt = bar + INTERVAL_MS[spec.interval] * (1 + spec.execution.timeoutBars);
  let placed = 0;
  for (const intent of orders) {
    if (!stillValid()) break;
    const chase = intent.orderType === 'limit' && (chases(s) || stranded.includes(intent.market));
    const row = await broker.place(intent, chase
      ? { strategyId: spec.id, expiresAt: null, fallback: 'cancel', barTime: bar, fees: s.fees, chase: { since: Date.now(), root: null } }
      : { strategyId: spec.id, expiresAt, fallback: spec.execution.fallback, barTime: bar, fees: s.fees });
    if (row) placed++;
  }
  return placed;
}

/** Book check before a decision's orders go out: warns, never blocks; a failed read is ignored. Returns the spreads. */
async function checkBooks(orders: OrderIntent[]) {
  const spreads: Record<string, number> = {};
  for (const o of orders) {
    try {
      const c = bookCheck(await bookDepth(o.market), o.side, o.valueEur);
      if (!c) continue;
      spreads[o.market] = c.spreadBps;
      if (c.thin.length) await log('warn', 'thin_book', `${o.market}: thin book for this ${o.side}: ${c.thin.join(', ')}`, { market: o.market, side: o.side, valueEur: o.valueEur, spreadBps: c.spreadBps, depthEur: c.depthEur });
    } catch {
      // only a warning was at stake
    }
  }
  return spreads;
}

/** Once per strategy: coins the bot may not trade are left alone, but the owner should know they are there. */
async function warnForeignCoins(ms: ModeState, pf: PortfolioView) {
  const seen = (ms.foreignWarned ??= []);
  for (const b of pf.balances) {
    if (b.symbol === 'EUR' || TRADED_MARKETS.includes(`${b.symbol}-EUR`) || seen.includes(b.symbol)) continue;
    seen.push(b.symbol);
    await log('warn', 'foreign_coin', `${b.symbol} (€${b.eurValue.toFixed(2)}) is in the account but the bot only trades ${TRADED_MARKETS.join(' and ')}; it stays untouched`, { symbol: b.symbol, eurValue: b.eurValue });
  }
}

/** Target weights -> orders (planOrders) -> placed, for the strategy's decision or a manual allocation. */
async function placeTargets(
  s: BotSettings, broker: Broker, ms: ModeState, bar: number, pf: PortfolioView, raw: Record<string, number>,
  closes: Record<string, number>, stillValid: () => boolean, markDecided: (d?: BarDecision) => Promise<void>, blockBuys: boolean,
) {
  const spec = s.strategy;
  for (const m of Object.keys(ms.locks)) {
    if (!spec.markets.includes(m) || (raw[m] ?? 0) === 0) {
      await log('info', 'stop_lock_cleared', `${m}: the strategy's signal reset after the stop exit; it may buy again`);
      delete ms.locks[m];
    }
  }
  const w = lockedWeights(raw, ms);
  if (!s.manual) await warnForeignCoins(ms, pf);

  const { plan, equityEur, prices, stranded, book } = await planFor(s, pf, w, closes);
  const planned = plan.orders.map((o) => ({ market: o.market, side: o.side, eur: o.valueEur, qty: pf.quantities[baseOf(o.market)] ?? 0 }));
  // Loss guard: the decision stands and is logged, its buys wait until the loss is back under the limit.
  const withheld = blockBuys ? plan.orders.filter((o) => o.side === 'buy') : [];
  for (const o of withheld) plan.notes.push({ market: o.market, note: `buy of €${o.valueEur.toFixed(2)} withheld by the loss guard` });
  const orders = plan.orders.filter((o) => !withheld.includes(o));
  const cancelMarkets = plan.cancelMarkets.filter((m) => !withheld.some((o) => o.market === m));

  const spreads = await checkBooks(orders);
  for (const [m, b] of Object.entries(book)) spreads[m] ??= ((b.ask - b.bid) / ((b.ask + b.bid) / 2)) * 10_000;
  await log('info', 'decision', `Bar ${new Date(bar).toISOString()}: targets ${fmtWeights(w)}; ${orders.length ? orders.map((o) => `${o.side} ${o.market} €${o.valueEur.toFixed(2)}`).join(', ') : 'no orders'}`, {
    bar, strategyId: spec.id, mode: s.mode, targets: raw, prices, locked: Object.keys(ms.locks), equityEur, cashEur: pf.cashAvailableEur, spreads, notes: plan.notes, orders,
  });
  const decision: BarDecision = { bar, weights: raw, prices: closes, equityEur, planned, attempts: 0, nextAt: 0, done: !planned.length };
  await markDecided(decision);
  if (!stillValid()) {
    await log('info', 'decision_aborted', 'Settings changed during the decision; no orders placed');
    return;
  }
  for (const m of cancelMarkets) for (const o of await openOrders(s.mode, m)) await broker.cancel(o, 'strategy changed direction');
  decision.attempts = 1;
  decision.nextAt = Date.now() + RETRY_BACKOFF_MS;
  await placeOrders(s, broker, orders, stranded, bar, stillValid);
}

/**
 * Second chance for a bar's orders while it is current: a planned market+side with no working order (rejected, cancelled
 * post-only, a crash before placing, a chase that ended unfilled) whose holdings still differ from the target beyond the
 * dead-band is planned again from the stored decision. Only what was planned, and a buy only up to its planned size: as
 * in the backtest, cash from this bar's sells waits for the next decision. Returns the orders placed.
 */
async function retryDecision(s: BotSettings, broker: Broker, ms: ModeState, d: BarDecision, pf: PortfolioView, now: number, stillValid: () => boolean, blockBuys: boolean): Promise<number> {
  const open = await openOrders(s.mode);
  const idle = d.planned.filter((p) => !open.some((o) => o.market === p.market && o.side === p.side));
  d.nextAt = now + RETRY_BACKOFF_MS;
  const allowed = idle.filter((p) => !(blockBuys && p.side === 'buy'));
  if (!allowed.length) return 0;
  const only = allowed.map((p) => ({
    market: p.market, side: p.side,
    maxEur: p.side === 'buy' ? p.eur - Math.max(0, (pf.quantities[baseOf(p.market)] ?? 0) - p.qty) * (d.prices[p.market] ?? 0) : undefined,
  }));
  const { plan, stranded } = await planFor(s, pf, lockedWeights(d.weights, ms), d.prices, { equityEur: d.equityEur, only });
  if (!plan.orders.length) {
    if (idle.length === d.planned.length && allowed.length === idle.length) d.done = true; // nothing is working, nothing is left
    return 0;
  }
  if (d.attempts >= MAX_ORDER_ATTEMPTS) {
    d.done = true;
    await log('error', 'order_retries_exhausted', `Bar ${new Date(d.bar).toISOString()}: ${plan.orders.map((o) => `${o.side} ${o.market}`).join(', ')} still not working after ${d.attempts} attempts; giving up until the next decision`, { bar: d.bar, attempts: d.attempts, orders: plan.orders });
    return 0;
  }
  d.attempts++;
  await log('warn', 'order_retry', `Bar ${new Date(d.bar).toISOString()}: placing ${plan.orders.map((o) => `${o.side} ${o.market} €${o.valueEur.toFixed(2)}`).join(', ')} again (attempt ${d.attempts} of ${MAX_ORDER_ATTEMPTS})`, { bar: d.bar, attempts: d.attempts, orders: plan.orders, notes: plan.notes });
  for (const m of plan.cancelMarkets) for (const o of await openOrders(s.mode, m)) await broker.cancel(o, 'strategy changed direction');
  return placeOrders(s, broker, plan.orders, stranded, d.bar, stillValid);
}

const fmtWeights = (w: Record<string, number>) =>
  Object.entries(w).map(([m, v]) => `${m} ${(v * 100).toFixed(1)} %`).join(', ') || 'none';

const fmtLimit = (l: LossLimit) => (l.unit === 'pct' ? `${l.value} %` : `€${l.value}`);

async function dayState(mode: Mode): Promise<DayState | undefined> {
  return lastDayState[mode] ?? (await loadState())[mode].day;
}

/** For the Overview: the loss guard right now, or null when it has not tripped. */
export async function guardStatus(mode: Mode): Promise<GuardState | null> {
  const known = lastGuardState[mode];
  return known !== undefined ? known : ((await loadState())[mode].guard ?? null);
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
