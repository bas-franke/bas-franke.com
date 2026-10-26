/**
 * Indicators exactly as SPEC §3 defines them; the Python lab must match these to 1e-9.
 * Every function returns an array as long as its input with NaN where the value is not defined yet.
 * Sums are plain left-to-right sums over each window (no running sums), so results do not drift.
 */

/** Simple moving average over the last `n` values; defined from index n-1. */
export function sma(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += values[j];
    out[i] = s / n;
  }
  return out;
}

/** Population standard deviation (divide by n) over the last `n` values; defined from index n-1. */
export function stdPop(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += values[j];
    const mean = s / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (values[j] - mean) * (values[j] - mean);
    out[i] = Math.sqrt(v / n);
  }
  return out;
}

/**
 * EMA with alpha = 2/(n+1), seeded with the SMA of the first `n` defined values. Leading NaNs are skipped
 * (so the EMA of a MACD line starts where the MACD starts).
 */
export function ema(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let start = 0;
  while (start < values.length && !Number.isFinite(values[start])) start++;
  const seedEnd = start + n - 1;
  if (seedEnd >= values.length) return out;
  let s = 0;
  for (let j = start; j <= seedEnd; j++) s += values[j];
  let prev = s / n;
  out[seedEnd] = prev;
  const alpha = 2 / (n + 1);
  for (let i = seedEnd + 1; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/**
 * RSI with Wilder's smoothing. Changes d[i] = c[i] - c[i-1]. The first averages (at index `period`) are the plain
 * means of the gains and losses of d[1..period]; after that avg = (avg*(period-1) + x) / period.
 * RSI = 100 - 100/(1 + avgGain/avgLoss); avgLoss = 0 gives 100, or 50 when avgGain is 0 too (flat prices).
 */
export function rsi(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  let avgG = g / period;
  let avgL = l / period;
  const value = () => (avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL));
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + gain) / period;
    avgL = (avgL * (period - 1) + loss) / period;
    out[i] = value();
  }
  return out;
}

/** MACD = EMA(fast) - EMA(slow); signal = EMA(signal) of the MACD line. */
export function macd(closes: number[], fast: number, slow: number, signal: number) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (Number.isFinite(f[i]) && Number.isFinite(s[i]) ? f[i] - s[i] : NaN));
  return { line, signal: ema(line, signal) };
}

/** Highest of values[i-n .. i-1] (the n bars before i, not including i); defined from index n. */
export function priorMax(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = n; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - n; j < i; j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}

/** Lowest of values[i-n .. i-1]; defined from index n. */
export function priorMin(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = n; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - n; j < i; j++) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}

/** Highest of values[i-n+1 .. i] (including i); defined from index n-1. */
export function rollingMax(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = n - 1; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - n + 1; j <= i; j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}
