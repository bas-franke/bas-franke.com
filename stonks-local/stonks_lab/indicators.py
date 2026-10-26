"""Technical indicators, exactly as stonks/SPEC.md §3 defines them (the TypeScript bot must match to 1e-9).

Every function takes 1-D float arrays (lists, numpy arrays or pandas Series) and returns a float64 numpy array of
the same length, with NaN where the value is not defined yet ("warm-up"). Bar i only ever uses inputs 0..i, so
nothing here can look ahead.

Conventions shared with ``stonks/backend/src/strategies/indicators.ts``:

- SMA(n) at i = mean of x[i-n+1..i]; defined from index n-1. NaN anywhere in the window gives NaN.
- EMA(n): alpha = 2/(n+1), seeded at index start+n-1 with the SMA of the first n defined values (leading NaNs are
  skipped, so the EMA of a MACD line starts where the MACD line starts); then ema = alpha*x + (1-alpha)*prev.
- RSI(n), Wilder: d[i] = c[i]-c[i-1]; at index n the averages are plain means of the gains/losses of d[1..n], then
  avg = (avg*(n-1) + x)/n. RSI = 100 - 100/(1 + avgGain/avgLoss); avgLoss = 0 gives 100 (50 if avgGain is 0 too).
- MACD = EMA(fast) - EMA(slow); signal = EMA(signal) of the MACD line.
- Bollinger = SMA(n) +/- k * population std (divide by n) of the same window.
- ATR(n), Wilder: TR[0] = h-l, TR[i] = max(h-l, |h-c[i-1]|, |l-c[i-1]|); seeded at n-1 with the mean of TR[0..n-1].
- rolling_max / rolling_min include bar i; prior_max / prior_min use the n bars *before* i (defined from index n),
  which is what a breakout ("close above the N-bar high") needs.
"""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as _windows

__all__ = [
    "sma", "ema", "rsi", "macd", "bollinger", "std_pop", "atr", "rolling_max", "rolling_min", "prior_max",
    "prior_min", "donchian", "rolling_return", "zscore", "shift",
]


def _a(x) -> np.ndarray:
    return np.ascontiguousarray(np.asarray(x, dtype=np.float64))


def _check_n(n: int) -> int:
    n = int(n)
    if n < 1:
        raise ValueError(f"window must be >= 1, got {n}")
    return n


def shift(x, k: int = 1) -> np.ndarray:
    """x[i-k] at i (NaN for i < k). k >= 0 only: shifting forward would look ahead."""
    x = _a(x)
    if k < 0:
        raise ValueError("negative shift would look ahead")
    out = np.full(x.shape, np.nan)
    if k == 0:
        return x.copy()
    if k < len(x):
        out[k:] = x[:-k]
    return out


def sma(x, n: int) -> np.ndarray:
    x, n = _a(x), _check_n(n)
    out = np.full(x.shape, np.nan)
    if len(x) >= n:
        out[n - 1:] = _windows(x, n).mean(axis=1)
    return out


def std_pop(x, n: int) -> np.ndarray:
    """Population standard deviation (ddof=0) over the last n values; defined from index n-1."""
    x, n = _a(x), _check_n(n)
    out = np.full(x.shape, np.nan)
    if len(x) >= n:
        out[n - 1:] = _windows(x, n).std(axis=1)
    return out


def ema(x, n: int) -> np.ndarray:
    x, n = _a(x), _check_n(n)
    out = np.full(x.shape, np.nan)
    finite = np.flatnonzero(np.isfinite(x))
    if len(finite) == 0:
        return out
    start = int(finite[0])
    seed_end = start + n - 1
    if seed_end >= len(x):
        return out
    vals = x.tolist()
    s = 0.0
    for j in range(start, seed_end + 1):  # left-to-right, like the TS side
        s += vals[j]
    prev = s / n
    alpha = 2.0 / (n + 1)
    beta = 1.0 - alpha
    res = [prev]
    for v in vals[seed_end + 1:]:
        prev = alpha * v + beta * prev
        res.append(prev)
    out[seed_end:] = res
    return out


def rsi(close, n: int = 14) -> np.ndarray:
    c, n = _a(close), _check_n(n)
    out = np.full(c.shape, np.nan)
    if len(c) <= n:
        return out
    vals = c.tolist()
    g = l = 0.0
    for i in range(1, n + 1):
        d = vals[i] - vals[i - 1]
        if d > 0:
            g += d
        else:
            l -= d
    ag, al = g / n, l / n
    m = n - 1
    res = []

    def value(ag, al):
        if al == 0:
            return 50.0 if ag == 0 else 100.0
        return 100.0 - 100.0 / (1.0 + ag / al)

    res.append(value(ag, al))
    prev = vals[n]
    for v in vals[n + 1:]:
        d = v - prev
        prev = v
        gain = d if d > 0 else 0.0
        loss = -d if d < 0 else 0.0
        ag = (ag * m + gain) / n
        al = (al * m + loss) / n
        res.append(100.0 - 100.0 / (1.0 + ag / al) if al != 0 else (50.0 if ag == 0 else 100.0))
    out[n:] = res
    return out


def macd(close, fast: int = 12, slow: int = 26, signal: int = 9):
    """(macd_line, signal_line, histogram)."""
    c = _a(close)
    line = ema(c, fast) - ema(c, slow)  # NaN until both are defined
    sig = ema(line, signal)
    return line, sig, line - sig


def bollinger(close, n: int = 20, k: float = 2.0):
    """(middle, upper, lower) with population std."""
    mid = sma(close, n)
    sd = std_pop(close, n)
    return mid, mid + k * sd, mid - k * sd


def atr(high, low, close, n: int = 14) -> np.ndarray:
    h, l, c, n = _a(high), _a(low), _a(close), _check_n(n)
    out = np.full(c.shape, np.nan)
    if len(c) < n:
        return out
    pc = shift(c, 1)
    tr = np.fmax(h - l, np.fmax(np.abs(h - pc), np.abs(l - pc)))  # fmax ignores the NaN previous close at 0
    tr[0] = h[0] - l[0]
    vals = tr.tolist()
    s = 0.0
    for j in range(n):
        s += vals[j]
    prev = s / n
    res = [prev]
    for v in vals[n:]:
        prev = (prev * (n - 1) + v) / n
        res.append(prev)
    out[n - 1:] = res
    return out


def rolling_max(x, n: int) -> np.ndarray:
    x, n = _a(x), _check_n(n)
    out = np.full(x.shape, np.nan)
    if len(x) >= n:
        out[n - 1:] = _windows(x, n).max(axis=1)
    return out


def rolling_min(x, n: int) -> np.ndarray:
    x, n = _a(x), _check_n(n)
    out = np.full(x.shape, np.nan)
    if len(x) >= n:
        out[n - 1:] = _windows(x, n).min(axis=1)
    return out


def prior_max(x, n: int) -> np.ndarray:
    """Highest of x[i-n..i-1] (the n bars before i); defined from index n."""
    return shift(rolling_max(x, n), 1)


def prior_min(x, n: int) -> np.ndarray:
    """Lowest of x[i-n..i-1]; defined from index n."""
    return shift(rolling_min(x, n), 1)


def donchian(high, low, n: int):
    """(upper, lower) Donchian channel over the last n bars including bar i."""
    return rolling_max(high, n), rolling_min(low, n)


def rolling_return(x, n: int) -> np.ndarray:
    """x[i] / x[i-n] - 1; defined from index n."""
    x = _a(x)
    return x / shift(x, _check_n(n)) - 1.0


def zscore(x, n: int) -> np.ndarray:
    """(x - SMA(n)) / population std(n); 0 where the std is 0."""
    x = _a(x)
    m, sd = sma(x, n), std_pop(x, n)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = (x - m) / sd
    z[(sd == 0) & np.isfinite(m)] = 0.0
    return z
