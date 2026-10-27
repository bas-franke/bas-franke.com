import { query } from '../db.js';
import { errText, log } from '../log.js';
import { getBotSettings } from '../settings.js';
import { INTERVAL_MS, type Interval } from '../strategies/index.js';
import { cachedPortfolio } from './engine.js';
import { allPrices, closedCandles } from './marketData.js';
import { lastClosedBar } from './time.js';

// Informative tracking for the Overview's comparison chart (SPEC.md §5a): once a minute the BTC-EUR and ETH-EUR price
// and the portfolio value of the bot's current mode go into `track_points`. It only reads: no orders, no settings,
// no effect on any strategy. The portfolio value comes from the engine's last portfolio view (no extra Bitvavo calls).

export const TRACK_MS = 60_000;
/** A cached portfolio older than this is not recorded (the bot refreshes it every 15 s running, 5 min resting). */
const PORTFOLIO_FRESH_MS = 6 * 60_000;

let timer: NodeJS.Timeout | null = null;
let failing = false;

export async function recordTrackPoint(now = Date.now()): Promise<void> {
  const s = await getBotSettings();
  const prices = await allPrices();
  const pf = cachedPortfolio(s.mode);
  const equity = pf && now - pf.at < PORTFOLIO_FRESH_MS ? pf.equityEur : null;
  await query('INSERT INTO track_points (ts, mode, portfolio_eur, btc_eur, eth_eur) VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5)', [
    now, s.mode, equity, prices.get('BTC-EUR') ?? null, prices.get('ETH-EUR') ?? null,
  ]);
}

export function startTracking() {
  if (timer) return;
  const run = () =>
    recordTrackPoint().then(
      () => (failing = false),
      (err) => {
        // Logged once per outage, not every minute.
        if (!failing) void log('warn', 'track_failed', `Recording the BTC/ETH/portfolio comparison point failed: ${errText(err)}`);
        failing = true;
      },
    );
  timer = setInterval(run, TRACK_MS);
  void run();
}

export function stopTracking() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Candle interval that gives at most ~500 points over `spanMs`. */
export function historyInterval(spanMs: number): Interval {
  const options: Interval[] = ['5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '1W'];
  return options.find((iv) => spanMs / INTERVAL_MS[iv] <= 500) ?? '1W';
}

const candleCache = new Map<string, { at: number; points: [number, number][] }>();

/** Closes of `market` from `from` to `to` (ms) from Bitvavo candles, to fill the chart where no track points exist. */
export async function priceHistory(market: string, from: number, to: number): Promise<[number, number][]> {
  const iv = historyInterval(to - from);
  const ms = INTERVAL_MS[iv];
  const key = `${market} ${iv} ${Math.floor(from / ms)} ${Math.floor(to / ms)}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.points;
  const last = lastClosedBar(to, iv);
  const candles = await closedCandles(market, iv, last, { bars: 2, from, maxBars: 600 });
  // close of the candle at its close time
  const points = candles.filter((c) => c[0] + ms >= from).map((c) => [c[0] + ms, c[4]] as [number, number]);
  if (candleCache.size > 100) candleCache.clear();
  candleCache.set(key, { at: Date.now(), points });
  return points;
}
