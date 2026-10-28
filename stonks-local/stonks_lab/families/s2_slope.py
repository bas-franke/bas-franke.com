"""s2_slope: a daily average versus its own value a few weeks earlier."""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "s2_slope"
VERSION = 1
TITLE = "Average slope"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"window": 100, "lag": 20, "high": 0.85, "low": 0.30, "step": 22}


def param_space() -> dict:
    return {
        "window": {"type": "int", "min": 80, "max": 160, "description": "days in the average"},
        "lag": {"type": "int", "min": 20, "max": 40, "description": "days earlier the average is compared with"},
        "high": {"type": "float", "min": 0.65, "max": 0.85, "description": "size while the average is rising"},
        "low": {"type": "float", "min": 0.15, "max": 0.30, "description": "size while the average is falling"},
        "step": {"type": "int", "min": 15, "max": 30, "description": "days between readings"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["low"]) >= float(p["high"]):
        return "the small size must sit under the large size"
    return None


def warmup(p: dict) -> int:
    return int(p["window"]) + int(p["lag"])


def _daily_last(ts, close):
    day = ts // DAY_MS
    valid = np.isfinite(close) & (close > 0.0)
    starts = np.flatnonzero(np.r_[True, day[1:] != day[:-1]])
    ends = np.concatenate([starts[1:] - 1, [len(ts) - 1]])
    closes = np.empty(len(ends), dtype=np.float64)
    days = day[ends]
    for k, (s, e) in enumerate(zip(starts, ends)):
        seg = np.flatnonzero(valid[s:e + 1])
        closes[k] = float(close[s + int(seg[-1])]) if len(seg) else np.nan
    keep = np.isfinite(closes)
    return days[keep].astype(np.int64, copy=False), closes[keep]


def _signal(days, closes, window, lag):
    n = len(days)
    sig = np.zeros(n, dtype=np.int8)
    if n == 0:
        return sig
    valid = np.isfinite(closes) & (closes > 0.0)
    c = np.where(valid, closes, 0.0)
    v = valid.astype(np.float64)
    cs = np.concatenate([[0.0], np.cumsum(c)])
    vs = np.concatenate([[0.0], np.cumsum(v)])
    idx = np.arange(n)
    start = np.searchsorted(days, days - int(window), side="left")
    cnt = vs[idx] - vs[start]
    sm = cs[idx] - cs[start]
    span = np.zeros(n, dtype=np.int64)
    has = start < idx
    span[has] = days[idx[has]] - days[start[has]]
    ready = has & (cnt >= max(4.0, window * 0.75)) & (span >= int(window) - 1)
    sma = np.full(n, np.nan)
    sma[ready] = sm[ready] / cnt[ready]
    k = np.searchsorted(days, days - int(lag), side="right") - 1
    k_ok = (k >= 0) & (k < idx)
    then = np.full(n, np.nan)
    then[k_ok] = sma[k[k_ok]]
    known = ready & k_ok & np.isfinite(then)
    sig[known & (sma > then)] = 1
    sig[known & (sma < then)] = -1
    return sig


def _clock(ts, sig, step_ms, high, low, boot):
    n = len(ts)
    out = np.full(n, float(boot), dtype=np.float64)
    active = np.flatnonzero(sig != 0)
    if len(active) == 0:
        return out
    i = int(active[0])
    want = float(boot)
    while i < n:
        s = int(sig[i])
        want = high if s > 0 else low if s < 0 else want
        j = int(np.searchsorted(ts, int(ts[i]) + step_ms, side="left"))
        if j <= i:
            j = i + 1
        out[i:j] = want
        i = j
    return out


def _weights(df, window, lag, high, low, step) -> np.ndarray:
    close = np.asarray(df["close"], dtype=np.float64)
    ts = np.asarray(df.index, dtype=np.int64)
    n = int(close.shape[0])
    out = np.full(n, high, dtype=np.float64)
    if n == 0:
        return out
    days, dclose = _daily_last(ts, close)
    if len(days) == 0:
        return out
    sig = _signal(days, dclose, window, lag)
    w_day = _clock(days.astype(np.int64) * DAY_MS, sig, int(step) * DAY_MS, high, low, high)
    return w_day[np.searchsorted(days, ts // DAY_MS)]


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, int(p["window"]), int(p["lag"]), float(p["high"]), float(p["low"]), int(p["step"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Every {int(p['step'])} days, holds {pct(p['high'])} of {mk} when the {int(p['window'])}-day average "
            f"is above its value {int(p['lag'])} days earlier, and {pct(p['low'])} when it is below."
        ),
        "howItWorks": [
            "The average on a day uses daily closes from before that day. Today's close is not in today's average.",
            f"The comparison is that average against the same average {int(p['lag'])} days earlier.",
            f"The reading happens every {int(p['step'])} days and the size is held until the next reading.",
            "Before the average is known the book holds the large size.",
        ] + risk_steps(spec),
        "whenItWins": "A trend whose average keeps rising for months, so the book stays at the large size through the dips inside it.",
        "whenItLoses": "A market whose average flips every few weeks, so the book sells the large size and buys the small one repeatedly.",
    }
