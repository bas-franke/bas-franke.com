import { bitvavo } from '../bitvavo/index.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { getBotSettings, SettingsError, updateBotSettings, type BotSettings } from '../settings.js';
import { explainAny } from '../strategies/runtime.js';
import { cachedPortfolio, kick, portfolio, start, status, stop, switchOff, todayPnl, withLock } from './engine.js';
import { marketRules } from './marketData.js';
import { resetPaperWallet as resetWallet } from './paper.js';
import { openOrders } from './store.js';

/**
 * The trading bot (SPEC §2, §5). It runs inside the backend process: `startBot()` starts a loop that ticks every
 * 15 s, syncs orders and fills, enforces the daily loss guard and stops, and decides once per closed candle.
 * It stays idle while `settings.bot.enabled` is false (the default); deploys never switch it on.
 */

export type { BotSettings } from '../settings.js';

export interface Overview {
  bot: BotSettings;
  /** The engine loop is alive and the bot is switched on. */
  running: boolean;
  lastTickAt: string | null;
  bitvavo: { connected: boolean; error?: string };
  balances: Array<{ symbol: string; available: number; inOrder: number; eurValue: number }>;
  equityEur: number;
  /** Equity now minus start-of-day equity (Europe/Amsterdam); null before the first check of the day. */
  todayPnlEur: number | null;
  dailyLossLimitEur: number;
  openOrders: number;
  strategyExplanation: string;
  /** The research strategy activated from the dashboard (SPEC §8), or null. */
  activeResearch: BotSettings['activeResearch'];
}

export function startBot(): void {
  try {
    start();
  } catch (err) {
    void log('error', 'engine_start_failed', `Bot engine did not start: ${(err as Error).message}`);
  }
}

export function stopBot(): void {
  stop();
}

const PRIVATE_FRESH_MS = 10 * 60_000;
const bitvavoConnected = () => bitvavo.hasKeys && Date.now() - bitvavo.lastPrivateOkAt < PRIVATE_FRESH_MS;

/** For GET /api/health: no amounts. */
export async function botHealth(): Promise<{ bitvavo: boolean; bot: { enabled: boolean; mode: 'paper' | 'live' } }> {
  try {
    if (!config.databaseUrl) return { bitvavo: bitvavoConnected(), bot: { enabled: false, mode: 'paper' } };
    const s = await getBotSettings();
    return { bitvavo: bitvavoConnected(), bot: { enabled: s.enabled, mode: s.mode } };
  } catch {
    return { bitvavo: bitvavoConnected(), bot: { enabled: false, mode: 'paper' } };
  }
}

/** For GET /api/overview (SPEC §7). */
export async function getOverview(): Promise<Overview> {
  const s = await getBotSettings();
  let pf = cachedPortfolio(s.mode);
  let pfError: string | undefined;
  if (!pf || Date.now() - pf.at > 30_000) {
    try {
      pf = await portfolio(s);
    } catch (err) {
      pfError = (err as Error).message;
    }
  }
  let bv: Overview['bitvavo'];
  if (!bitvavo.hasKeys) bv = { connected: false, error: 'No Bitvavo API key configured on the server (paper mode runs on public prices).' };
  else if (bitvavoConnected()) bv = { connected: true };
  else bv = { connected: false, error: bitvavo.lastPrivateError ?? (s.mode === 'live' ? pfError : undefined) ?? 'No successful Bitvavo call in the last 10 minutes.' };
  const equityEur = pf?.equityEur ?? 0;
  const lastTick = status.lastTickAt;
  return {
    bot: s,
    running: status.started && s.enabled && lastTick !== null && Date.now() - lastTick < 120_000,
    lastTickAt: lastTick ? new Date(lastTick).toISOString() : null,
    bitvavo: bv,
    balances: (pf?.balances ?? []).map((b) => ({ symbol: b.symbol, available: b.available, inOrder: b.inOrder, eurValue: b.eurValue })),
    equityEur,
    todayPnlEur: pf ? await todayPnl(s.mode, equityEur) : null,
    dailyLossLimitEur: s.dailyLossLimitEur,
    openOrders: (await openOrders(s.mode)).length,
    strategyExplanation: explainAny(s.strategy),
    activeResearch: s.activeResearch ?? null,
  };
}

/** POST /api/bot/start. Live mode needs keys on the server. Resets today's loss baseline. */
export async function enableTrading(): Promise<BotSettings> {
  const s = await getBotSettings();
  if (s.mode === 'live' && !bitvavo.hasKeys)
    throw new SettingsError('Live trading needs BITVAVO_API_KEY and BITVAVO_API_SECRET on the server.');
  if (s.enabled) return s;
  const after = await withLock(() => updateBotSettings({ enabled: true }));
  await log(s.mode === 'live' ? 'warn' : 'info', 'bot_started', `Bot switched on in ${s.mode} mode running ${s.strategy.name}`);
  kick();
  return after;
}

/** POST /api/bot/stop: cancels the bot's open orders and switches it off. */
export function disableTrading(reason: string): Promise<BotSettings> {
  return switchOff(reason || 'switched off by the owner');
}

/** Bitvavo EUR markets for GET /api/markets (cached 1 h). */
export async function listMarkets(): Promise<Array<{ market: string; base: string; quote: string; status: string; minOrderInQuoteAsset: string }>> {
  const rules = await marketRules();
  return [...rules.values()]
    .filter((r) => r.quote === 'EUR')
    .sort((a, b) => a.market.localeCompare(b.market))
    .map((r) => ({ market: r.market, base: r.base, quote: r.quote, status: r.status, minOrderInQuoteAsset: String(r.minOrderInQuoteAsset) }));
}

/** Cancels open paper orders and refills the paper wallet with `paperStartEur` (only while the bot is off). */
export async function resetPaperWallet(): Promise<void> {
  const s = await getBotSettings();
  if (s.enabled && s.mode === 'paper') throw new SettingsError('Switch the bot off before resetting the paper wallet.');
  await withLock(() => resetWallet(s.paperStartEur));
}
