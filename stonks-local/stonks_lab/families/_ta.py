"""Extra TAAPI-style indicators for the ladder families (``ind_ladder_a24``), each normalized to about -1..+1.

Every function here takes the bar arrays ``(o, h, l, c, v)`` and one main length ``n`` and returns a float64 array
of the same length: positive = bullish / overbought, negative = bearish / oversold, NaN during warm-up. Bar i only
uses bars 0..i (no look-ahead). Names follow TAAPI.IO's endpoint names where one exists (rsi, stochrsi, stoch,
willr, cci, mfi, cmo, ultosc, fisher, tsi, roc, macd, ppo, trix, ao, aroon, dmi, vortex, supertrend, psar, ichimoku,
kama, hma, obv, cmf, keltner, donchian, vwap, efi, dpo, bbands (%B)); the normalization is ours, so the thresholds of
the ladder are comparable between indicators. Secondary lengths are derived from ``n`` with TAAPI's default ratios
(e.g. MACD 12/26/9 -> n, 26n/12, 9n/12).

Not part of the SPEC §3 set the TypeScript bot ports; the lab's own Python runs these on the server (SPEC §6b).
"""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as _windows

from .. import indicators as ind

_CHUNK = 250_000


def _rolling(x: np.ndarray, n: int, fn) -> np.ndarray:
    """fn over trailing windows of n (axis=1), in chunks so 1m history does not need gigabytes."""
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    for s in range(n - 1, len(x), _CHUNK):
        e = min(len(x), s + _CHUNK)
        out[s:e] = fn(_windows(x[s - n + 1:e], n), axis=1)
    return out


def _sum(x, n):
    return ind.sma(x, n) * n


def _rma(x: np.ndarray, n: int) -> np.ndarray:
    """Wilder's smoothing seeded with the mean of the first n defined values (like indicators.atr)."""
    out = np.full(len(x), np.nan)
    ok = np.flatnonzero(np.isfinite(x))
    if len(ok) < n:
        return out
    s = ok[0]
    i0 = s + n - 1
    if not np.isfinite(x[s:i0 + 1]).all():
        return out
    prev = float(np.mean(x[s:i0 + 1]))
    out[i0] = prev
    xs = x.tolist()
    a = 1.0 / n
    for i in range(i0 + 1, len(x)):
        xi = xs[i]
        if xi == xi:
            prev = prev + a * (xi - prev)
        out[i] = prev
    return out


def _clip(x, lim=1.0):
    return np.clip(x, -lim, lim)


def _div(a, b):
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(np.abs(b) > 1e-300, a / b, np.nan)


def _prev(c):
    return ind.shift(c, 1)


def _atr(h, l, c, n):
    return ind.atr(h, l, c, n)


# --------------------------------------------------------------------------------------------- oscillators
def rsi(o, h, l, c, v, n):
    return (ind.rsi(c, n) - 50.0) / 50.0


def stochrsi(o, h, l, c, v, n):
    r = ind.rsi(c, n)
    lo, hi = ind.rolling_min(r, n), ind.rolling_max(r, n)
    k = _div(r - lo, hi - lo)
    return (ind.sma(k, 3) - 0.5) * 2.0


def stoch(o, h, l, c, v, n):
    lo, hi = ind.rolling_min(l, n), ind.rolling_max(h, n)
    k = _div(c - lo, hi - lo)
    return (ind.sma(k, 3) - 0.5) * 2.0


def willr(o, h, l, c, v, n):
    lo, hi = ind.rolling_min(l, n), ind.rolling_max(h, n)
    return (_div(c - lo, hi - lo) - 0.5) * 2.0


def cci(o, h, l, c, v, n):
    tp = (h + l + c) / 3.0
    m = ind.sma(tp, n)
    md = _rolling(tp, n, lambda w, axis: np.mean(np.abs(w - w.mean(axis=axis, keepdims=True)), axis=axis))
    return _clip(_div(tp - m, 0.015 * md) / 200.0, 1.5)


def mfi(o, h, l, c, v, n):
    tp = (h + l + c) / 3.0
    d = tp - _prev(tp)
    flow = tp * v
    pos = _sum(np.where(d > 0, flow, 0.0), n)
    neg = _sum(np.where(d < 0, flow, 0.0), n)
    pos[:n] = np.nan  # the first bar has no change, so the window starts one bar later
    tot = pos + neg
    return np.where(tot > 0, (_div(pos, tot) - 0.5) * 2.0, np.where(np.isfinite(tot), 0.0, np.nan))


def cmo(o, h, l, c, v, n):
    d = c - _prev(c)
    up, dn = _sum(np.clip(d, 0, None), n), _sum(np.clip(-d, 0, None), n)
    return _div(up - dn, up + dn)


def ultosc(o, h, l, c, v, n):
    pc = _prev(c)
    bp = c - np.fmin(l, pc)
    tr = np.fmax(h, pc) - np.fmin(l, pc)
    a = [_div(_sum(bp, k), _sum(tr, k)) for k in (n, 2 * n, 4 * n)]
    uo = (4 * a[0] + 2 * a[1] + a[2]) / 7.0
    return (uo - 0.5) * 4.0


def bbands(o, h, l, c, v, n):
    mid, up, lo = ind.bollinger(c, n, 2.0)
    return _clip((_div(c - lo, up - lo) - 0.5) * 2.0, 1.5)


def fisher(o, h, l, c, v, n):
    mid = (h + l) / 2.0
    lo, hi = ind.rolling_min(mid, n), ind.rolling_max(mid, n)
    raw = _div(mid - lo, hi - lo) - 0.5
    out = np.full(len(c), np.nan)
    x = f = 0.0
    rl = raw.tolist()
    for i in range(len(c)):
        r = rl[i]
        if r != r:
            continue
        x = min(0.999, max(-0.999, 0.66 * r + 0.67 * x))
        f = 0.5 * np.log((1 + x) / (1 - x)) + 0.5 * f
        out[i] = f
    return _clip(out / 3.0, 1.5)


def tsi(o, h, l, c, v, n):
    d = c - _prev(c)
    s = max(2, n // 2)
    return _div(ind.ema(ind.ema(d, n), s), ind.ema(ind.ema(np.abs(d), n), s))


def zscore(o, h, l, c, v, n):
    return _clip(ind.zscore(c, n) / 2.0, 1.5)


def roc(o, h, l, c, v, n):
    lr = np.log(c)
    r1 = lr - _prev(lr)
    sig = ind.std_pop(r1, 4 * n) * np.sqrt(n)
    return _clip(_div(lr - ind.shift(lr, n), sig) / 2.0, 1.5)


# --------------------------------------------------------------------------------------------- trend / direction
def macd(o, h, l, c, v, n):
    slow, sig = max(n + 1, round(n * 26 / 12)), max(2, round(n * 9 / 12))
    line, signal, hist = ind.macd(c, n, slow, sig)
    return _clip(_div(hist, _atr(h, l, c, slow)), 1.5)


def ppo(o, h, l, c, v, n):
    slow = max(n + 1, round(n * 26 / 12))
    return np.tanh(_div(ind.ema(c, n) - ind.ema(c, slow), _atr(h, l, c, slow)))


def trix(o, h, l, c, v, n):
    e = ind.ema(ind.ema(ind.ema(np.log(c), n), n), n)
    t = e - _prev(e)
    return np.tanh(_div(t, ind.std_pop(t, 4 * n)))


def ao(o, h, l, c, v, n):
    mid = (h + l) / 2.0
    fast = max(2, round(n * 5 / 34))
    return np.tanh(_div(ind.sma(mid, fast) - ind.sma(mid, n), _atr(h, l, c, n)))


def aroon(o, h, l, c, v, n):
    w = n + 1
    # bars since the n-bar high/low, counted from the newest bar (argmax on the reversed window)
    since_hi = _rolling(h, w, lambda x, axis: np.argmax(x[:, ::-1], axis=axis))
    since_lo = _rolling(l, w, lambda x, axis: np.argmin(x[:, ::-1], axis=axis))
    up, dn = (n - since_hi) / n, (n - since_lo) / n
    return up - dn


def dmi(o, h, l, c, v, n):
    uh, dl = h - _prev(h), _prev(l) - l
    pdm = np.where((uh > dl) & (uh > 0), uh, 0.0)
    mdm = np.where((dl > uh) & (dl > 0), dl, 0.0)
    pdm[0] = mdm[0] = np.nan
    p, m = _rma(pdm, n), _rma(mdm, n)
    return _div(p - m, p + m)


def vortex(o, h, l, c, v, n):
    pc = _prev(c)
    tr = np.fmax(h, pc) - np.fmin(l, pc)
    vp, vm = np.abs(h - _prev(l)), np.abs(l - _prev(h))
    st = _sum(tr, n)
    return _clip(_div(_sum(vp, n) - _sum(vm, n), st) * 2.0, 1.5)


def supertrend(o, h, l, c, v, n):
    a = _atr(h, l, c, n)
    mid = (h + l) / 2.0
    ub, lb = (mid + 3.0 * a).tolist(), (mid - 3.0 * a).tolist()
    cl = c.tolist()
    out = np.full(len(c), np.nan)
    fu = fl = None
    d = 1.0
    for i in range(len(c)):
        if ub[i] != ub[i]:
            continue
        if fu is None:
            fu, fl = ub[i], lb[i]
        else:
            fu = ub[i] if (ub[i] < fu or cl[i - 1] > fu) else fu
            fl = lb[i] if (lb[i] > fl or cl[i - 1] < fl) else fl
            if d < 0 and cl[i] > fu:
                d = 1.0
            elif d > 0 and cl[i] < fl:
                d = -1.0
        out[i] = d
    return out


def psar(o, h, l, c, v, n):
    step = 0.02 * 14.0 / n
    mx = min(0.5, step * 10)
    hl, ll = h.tolist(), l.tolist()
    out = np.full(len(c), np.nan)
    if len(c) < 3:
        return out
    up = True
    sar, ep, af = ll[0], hl[0], step
    for i in range(1, len(c)):
        sar = sar + af * (ep - sar)
        if up:
            sar = min(sar, ll[i - 1], ll[i - 2] if i > 1 else ll[i - 1])
            if ll[i] < sar:
                up, sar, ep, af = False, ep, ll[i], step
            elif hl[i] > ep:
                ep, af = hl[i], min(mx, af + step)
        else:
            sar = max(sar, hl[i - 1], hl[i - 2] if i > 1 else hl[i - 1])
            if hl[i] > sar:
                up, sar, ep, af = True, ep, hl[i], step
            elif ll[i] < ep:
                ep, af = ll[i], min(mx, af + step)
        if i >= n:
            out[i] = 1.0 if up else -1.0
    return out


def ichimoku(o, h, l, c, v, n):
    def mid(k):
        return (ind.rolling_max(h, k) + ind.rolling_min(l, k)) / 2.0
    tenkan, kijun = mid(n), mid(max(n + 1, round(n * 26 / 9)))
    return np.tanh(_div(tenkan - kijun, _atr(h, l, c, n)))


def kama(o, h, l, c, v, n):
    change = np.abs(c - ind.shift(c, n))
    vol = _sum(np.abs(c - _prev(c)), n)
    er = np.nan_to_num(_div(change, vol), nan=np.nan)
    fast, slow = 2.0 / 3.0, 2.0 / 31.0
    sc = (er * (fast - slow) + slow) ** 2
    out = np.full(len(c), np.nan)
    cl, scl = c.tolist(), sc.tolist()
    k = None
    for i in range(len(c)):
        s = scl[i]
        if s != s:
            continue
        k = cl[i - 1] if k is None else k
        k = k + s * (cl[i] - k)
        out[i] = k
    return np.tanh(_div(c - out, _atr(h, l, c, n)))


def _wma(x, n):
    w = np.arange(1, n + 1, dtype=np.float64)
    return _rolling(x, n, lambda a, axis: a @ w / w.sum())


def hma(o, h, l, c, v, n):
    n = max(n, 4)
    raw = 2 * _wma(c, n // 2) - _wma(c, n)
    hm = _wma(raw, max(2, int(round(np.sqrt(n)))))
    return np.tanh(_div(hm - _prev(hm), _atr(h, l, c, n)) * 4.0)


def obv(o, h, l, c, v, n):
    d = np.sign(c - _prev(c))
    d[0] = 0.0
    ob = np.cumsum(d * v)
    return np.tanh(_div(ob - ind.ema(ob, n), ind.sma(v, n) * np.sqrt(n)))


def cmf(o, h, l, c, v, n):
    mfm = np.where(h > l, _div((c - l) - (h - c), h - l), 0.0)
    return _clip(_div(_sum(mfm * v, n), _sum(v, n)) * 2.0, 1.5)


def keltner(o, h, l, c, v, n):
    return _clip(_div(c - ind.ema(c, n), 2.0 * _atr(h, l, c, n)), 1.5)


def donchian(o, h, l, c, v, n):
    hi, lo = ind.rolling_max(h, n), ind.rolling_min(l, n)
    return (_div(c - lo, hi - lo) - 0.5) * 2.0


def vwap(o, h, l, c, v, n):
    tp = (h + l + c) / 3.0
    vw = _div(_sum(tp * v, n), _sum(v, n))
    return _clip(_div(c - vw, 2.0 * _atr(h, l, c, n)), 1.5)


def efi(o, h, l, c, v, n):
    f = (c - _prev(c)) * v
    return _div(ind.ema(f, n), ind.ema(np.abs(f), n))


def dpo(o, h, l, c, v, n):
    k = n // 2 + 1
    return np.tanh(_div(ind.shift(c, k) - ind.sma(c, n), _atr(h, l, c, n)))


OSCILLATORS = ["rsi", "stochrsi", "stoch", "willr", "cci", "mfi", "cmo", "ultosc", "bbands", "fisher", "tsi",
               "zscore", "roc"]
TRENDS = ["macd", "ppo", "trix", "ao", "aroon", "dmi", "vortex", "supertrend", "psar", "ichimoku", "kama", "hma",
          "obv", "cmf", "keltner", "donchian", "vwap", "efi", "dpo"]
ALL = OSCILLATORS + TRENDS
_FN = {k: globals()[k] for k in ALL}

LABEL = {
    "rsi": "RSI", "stochrsi": "Stochastic RSI", "stoch": "Stochastic oscillator", "willr": "Williams %R",
    "cci": "Commodity Channel Index", "mfi": "Money Flow Index", "cmo": "Chande Momentum Oscillator",
    "ultosc": "Ultimate Oscillator", "bbands": "Bollinger %B", "fisher": "Fisher Transform",
    "tsi": "True Strength Index", "zscore": "price z-score", "roc": "rate of change", "macd": "MACD histogram",
    "ppo": "Percentage Price Oscillator", "trix": "TRIX", "ao": "Awesome Oscillator", "aroon": "Aroon oscillator",
    "dmi": "Directional Movement (+DI vs -DI)", "vortex": "Vortex indicator", "supertrend": "Supertrend",
    "psar": "Parabolic SAR", "ichimoku": "Ichimoku tenkan/kijun", "kama": "Kaufman adaptive moving average",
    "hma": "Hull moving average slope", "obv": "On-Balance Volume trend", "cmf": "Chaikin Money Flow",
    "keltner": "Keltner channel position", "donchian": "Donchian channel position", "vwap": "rolling VWAP distance",
    "efi": "Elder Force Index", "dpo": "Detrended Price Oscillator",
}


# Fixed stretch per indicator so the 5th/95th percentile reading on BTC 1h (n=20) sits near -0.85/+0.85 for all of
# them, like choosing RSI 30/70 by hand; a constant, so no look-ahead. Readings are clipped to -1.5..+1.5.
STRETCH = {"rsi": 2.4, "cmo": 1.8, "mfi": 1.55, "ultosc": 1.9, "tsi": 2.2, "macd": 1.8, "dmi": 1.8, "cmf": 1.6,
           "efi": 1.3, "obv": 1.1}


def compute(name: str, df, n: int) -> np.ndarray:
    """Normalized indicator ``name`` (one of ALL) with main length ``n`` on a lab candle frame."""
    a = [df[k].to_numpy(np.float64) for k in ("open", "high", "low", "close", "volume")]
    x = np.asarray(_FN[name](*a, int(n)), dtype=np.float64) * STRETCH.get(name, 1.0)
    return np.clip(x, -1.5, 1.5)


def warmup(name: str, n: int) -> int:
    n = int(n)
    if name in ("ultosc", "roc", "trix"):
        return 4 * n + 3
    if name in ("macd", "ppo", "ichimoku"):
        return 3 * n + 10
    return 2 * n + 5
