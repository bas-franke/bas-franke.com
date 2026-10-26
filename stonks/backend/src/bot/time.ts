import { INTERVAL_MS, type Interval } from '../strategies/index.js';

/** Bitvavo weekly candles start on Monday 00:00 UTC; the epoch was a Thursday. */
const WEEK_OFFSET = 4 * 86_400_000;

/** Open time of the candle that contains `ts`. Bitvavo aligns 1m..1d candles to UTC epoch multiples. */
export function barOpen(ts: number, interval: Interval): number {
  const ms = INTERVAL_MS[interval];
  const off = interval === '1W' ? WEEK_OFFSET : 0;
  return Math.floor((ts - off) / ms) * ms + off;
}

/** Open time of the newest bar that has fully closed at `now` (minus a settle delay so Bitvavo has finalized it). */
export function lastClosedBar(now: number, interval: Interval, settleMs = 5_000): number {
  return barOpen(now - settleMs, interval) - INTERVAL_MS[interval];
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Calendar day in Europe/Amsterdam ("2026-10-26"); the daily loss guard resets when it changes. */
export function amsterdamDay(ts: number): string {
  return dayFmt.format(new Date(ts));
}
