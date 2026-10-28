"""s2_golden: a fast daily average against a slow one. The cross is the sale."""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "s2_golden"
VERSION = 1
TITLE = "Golden cross"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"fastDays": 34, "slowDays": 155, "high": 0.9, "low": 0.25}


def param_space() -> dict:
    return {
        "fastDays": {"type": "int", "min": 30, "max": 60, "description": "days in the fast average"},
        "slowDays": {"type": "int", "min": 150, "max": 250, "description": "days in the slow average"},
        "high": {"type": "float", "min": 0.7, "max": 0.9, "description": "size when the fast average is above the slow one"},
        "low": {"type": "float", "min": 0.1, "max": 0.25, "description": "size when the fast average is below"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["fastDays"]) >= int(p["slowDays"]):
        return "the fast average must be shorter than the slow one"
    if float(p["low"]) >= float(p["high"]):
        return "the small size must sit under the large size"
    return None


def warmup(p: dict) -> int:
    return int(p["slowDays"])


def _daily_closes(day, close):
    n = int(close.shape[0])
    ends = np.asarray([0], dtype=np.int64) if n == 1 else np.concatenate([np.flatnonzero(day[1:] != day[:-1]), [n - 1]])
    finite = np.isfinite(close) & (close > 0.0)
    last = np.full(n, -1, dtype=np.int64)
    seen = -1
    for i in range(n):
        if finite[i]:
            seen = i
        last[i] = seen
    src = last[ends]
    ok = (src >= 0) & (day[src] == day[ends])
    return day[ends][ok].astype(np.int64, copy=False), close[src[ok]]


def _window_mean(csum, idx, left):
    count = idx - left
    end = idx - 1
    total = np.zeros(idx.shape[0], dtype=np.float64)
    ok_end = end >= 0
    total[ok_end] = csum[end[ok_end]]
    prev_i = left - 1
    has_prev = prev_i >= 0
    prev = np.zeros(idx.shape[0], dtype=np.float64)
    prev[has_prev] = csum[prev_i[has_prev]]
    mean = np.full(idx.shape[0], np.nan, dtype=np.float64)
    good = count > 0
    mean[good] = (total[good] - prev[good]) / count[good]
    return mean, count


def _weights(df, fast_days, slow_days, high, low) -> np.ndarray:
    close = np.asarray(df["close"], dtype=np.float64)
    ts = np.asarray(df.index, dtype=np.int64)
    n = int(close.shape[0])
    out = np.full(n, high, dtype=np.float64)
    if n == 0:
        return out
    day = ts // DAY_MS
    d_day, d_close = _daily_closes(day, close)
    if d_day.size == 0:
        return out
    nd = int(d_day.shape[0])
    csum = np.cumsum(d_close)
    idx = np.arange(nd)
    f_mean, f_count = _window_mean(csum, idx, np.searchsorted(d_day, d_day - fast_days, side="left"))
    s_mean, s_count = _window_mean(csum, idx, np.searchsorted(d_day, d_day - slow_days, side="left"))
    ready = (int(d_day[0]) <= (d_day - slow_days)) & (f_count > 0) & (s_count > 0)
    state = high
    wday = np.full(nd, high, dtype=np.float64)
    for k in range(nd):
        if ready[k] and f_mean[k] == f_mean[k] and s_mean[k] == s_mean[k]:
            if f_mean[k] > s_mean[k]:
                state = high
            elif f_mean[k] < s_mean[k]:
                state = low
        wday[k] = state
    slot = np.searchsorted(d_day, day, side="left")
    out[:] = wday[slot]
    return out


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, int(p["fastDays"]), int(p["slowDays"]), float(p["high"]), float(p["low"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Holds {pct(p['high'])} of {mk} when the {int(p['fastDays'])}-day average of daily closes is above "
            f"the {int(p['slowDays'])}-day average, and {pct(p['low'])} when it is below."
        ),
        "howItWorks": [
            "Both averages use daily closes from before today. Today's close is not part of today's signal.",
            "A daily close is the last close of that UTC day.",
            f"The cross down from {pct(p['high'])} to {pct(p['low'])} is the sale. The book does not go flat.",
            "There is no percent trailing stop.",
        ] + risk_steps(spec),
        "whenItWins": "A bull market whose short average stays above the long one, so the book holds the large size through ordinary dips.",
        "whenItLoses": "A cross that flips often, selling part of the book and buying it back, or a long stretch where the short average stays under.",
    }
