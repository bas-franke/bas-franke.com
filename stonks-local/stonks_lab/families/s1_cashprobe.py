"""s1_cashprobe: a small buy after a long stretch in euros, then adds on new highs.

The stop only rises. A stop bar does not buy. No lookahead.
"""
from __future__ import annotations

from collections import deque

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "s1_cashprobe"
VERSION = 1
TITLE = "Cash probe"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"flatDays": 30, "stop": 0.22, "step": 0.15, "capSteps": 4, "highDays": 20, "gapDays": 7}


def param_space() -> dict:
    return {
        "flatDays": {"type": "int", "min": 10, "max": 120, "description": "days flat before a probe buy"},
        "stop": {"type": "float", "min": 0.08, "max": 0.4, "description": "sell this far under the peak"},
        "step": {"type": "float", "min": 0.05, "max": 0.3, "description": "size of the probe and of each add"},
        "capSteps": {"type": "int", "min": 1, "max": 6, "description": "how many steps fit in the book"},
        "highDays": {"type": "int", "min": 5, "max": 90, "description": "calendar days in the new-high window"},
        "gapDays": {"type": "int", "min": 1, "max": 30, "description": "minimum days between adds"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["step"]) * int(p["capSteps"]) > 1.0 + 1e-9:
        return "the steps together cannot exceed the whole account"
    return None


def warmup(p: dict) -> int:
    return max(int(p["flatDays"]), int(p["highDays"])) + 1


def _prior_high(ts: np.ndarray, high: np.ndarray, window_ms: int) -> np.ndarray:
    n = len(ts)
    out = np.full(n, np.nan, dtype=np.float64)
    dq: deque[int] = deque()
    left = 0
    for i in range(n):
        cutoff = int(ts[i]) - window_ms
        while left < i and int(ts[left]) < cutoff:
            left += 1
        while dq and dq[0] < left:
            dq.popleft()
        if dq:
            out[i] = high[dq[0]]
        v = high[i]
        if v == v:
            while dq and high[dq[-1]] <= v:
                dq.pop()
            dq.append(i)
    return out


def _close_before(ts: np.ndarray, close: np.ndarray, lag_ms: int) -> np.ndarray:
    j = np.searchsorted(ts, ts - lag_ms, side="right") - 1
    out = np.full(len(ts), np.nan, dtype=np.float64)
    ok = (j >= 0) & (j < np.arange(len(ts)))
    out[ok] = close[j[ok]]
    return out


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    flat_ms = int(p["flatDays"]) * DAY_MS
    gap_ms = int(p["gapDays"]) * DAY_MS
    high_ms = int(p["highDays"]) * DAY_MS
    step = float(p["step"])
    cap_steps = int(p["capSteps"])
    keep = 1.0 - float(p["stop"])
    close = np.asarray(df["close"], dtype=np.float64)
    high = np.asarray(df["high"], dtype=np.float64)
    ts = np.asarray(df.index, dtype=np.int64)
    n = close.shape[0]
    out = np.zeros(n, dtype=np.float64)
    if n == 0:
        return frame(df.index, {m: out})
    prior = _prior_high(ts, high, high_ms)
    ago = _close_before(ts, close, flat_ms)
    in_trade = False
    steps = 0
    peak = stop = 0.0
    last_buy = -1
    flat_since = int(ts[0])
    for i in range(n):
        px = close[i]
        if px != px or px <= 0.0:
            out[i] = steps * step
            continue
        broke = prior[i] == prior[i] and px > prior[i]
        if in_trade:
            if px <= stop:
                in_trade = False
                steps = 0
                last_buy = -1
                flat_since = int(ts[i])
                out[i] = 0.0
                continue
            if px > peak:
                peak = px
                raised = peak * keep
                if raised > stop:
                    stop = raised
            if steps < cap_steps and broke and int(ts[i]) - last_buy >= gap_ms:
                steps += 1
                last_buy = int(ts[i])
            out[i] = steps * step
        else:
            up = ago[i] == ago[i] and px > ago[i]
            if broke or (int(ts[i]) - flat_since >= flat_ms and up):
                in_trade = True
                steps = 1
                peak = px
                stop = px * keep
                last_buy = int(ts[i])
                out[i] = step
            else:
                out[i] = 0.0
    np.round(out, 2, out=out)
    out *= max_weight(spec)
    return frame(df.index, {m: out})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Buys {pct(p['step'])} of {mk} after {int(p['flatDays'])} days in euros, or on a {int(p['highDays'])}-day high. "
            f"Adds the same step up to {int(p['capSteps'])} times, and sells {pct(p['stop'])} under the peak."
        ),
        "howItWorks": [
            f"From a flat book, a close above the highest high of the previous {int(p['highDays'])} days buys {pct(p['step'])}.",
            f"If the book has been flat for {int(p['flatDays'])} days and the close is higher than it was then, it buys that same probe even without a new high.",
            f"Later adds are {pct(p['step'])}, only on a new high, at least {int(p['gapDays'])} days apart, and at most {int(p['capSteps'])} steps.",
            f"The stop sits {pct(p['stop'])} under the highest close since the entry and only moves up. The bar that hits it sells and does not buy.",
        ] + risk_steps(spec),
        "whenItWins": "A market that spends stretches going up, so the probe is in for the rise and the stop sells before a large giveback.",
        "whenItLoses": "A market that drifts just high enough to force the probe, then falls. The probe is small, and a string of those still costs money.",
    }
