"""s1_ladder: buy on a new high, sell tenths of the book as the gain grows, trail the rest.

The new high is the highest close of the previous days, not including the current bar.
The stop only rises. A sell bar does not buy. No lookahead.
"""
from __future__ import annotations

from collections import deque

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "s1_ladder"
VERSION = 1
TITLE = "Profit ladder"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"days": 20, "stop": 0.22, "buy": 0.2, "cap": 0.6, "clip": 0.1, "rung1": 0.2, "rung2": 0.4, "rung3": 0.7}


def param_space() -> dict:
    return {
        "days": {"type": "int", "min": 10, "max": 90, "description": "calendar days in the new-high window"},
        "stop": {"type": "float", "min": 0.08, "max": 0.4, "description": "sell the rest this far under the peak"},
        "buy": {"type": "float", "min": 0.05, "max": 0.4, "description": "size of each new-high buy"},
        "cap": {"type": "float", "min": 0.2, "max": 1.0, "description": "largest position"},
        "clip": {"type": "float", "min": 0.05, "max": 0.3, "description": "size of each profit sale"},
        "rung1": {"type": "float", "min": 0.05, "max": 0.5, "description": "first profit sale, as a gain from the average buy"},
        "rung2": {"type": "float", "min": 0.1, "max": 1.0, "description": "second profit sale"},
        "rung3": {"type": "float", "min": 0.2, "max": 2.0, "description": "third profit sale"},
    }


def valid_params(p: dict) -> str | None:
    if not (float(p["rung1"]) < float(p["rung2"]) < float(p["rung3"])):
        return "the profit sales must be in rising order"
    if float(p["buy"]) > float(p["cap"]) + 1e-9:
        return "a buy cannot be larger than the cap"
    return None


def warmup(p: dict) -> int:
    return int(p["days"]) + 1


def _prior_max(ts: np.ndarray, close: np.ndarray, window_ms: int) -> np.ndarray:
    n = close.shape[0]
    out = np.full(n, np.nan, dtype=np.float64)
    if n == 0:
        return out
    origin = int(ts[0])
    dq: deque[int] = deque()
    left = 0
    for i in range(n):
        cutoff = int(ts[i]) - window_ms
        while left < i and int(ts[left]) < cutoff:
            left += 1
        while dq and dq[0] < left:
            dq.popleft()
        if dq and int(ts[i]) - origin >= window_ms:
            out[i] = close[dq[0]]
        px = close[i]
        if px == px:
            while dq and close[dq[-1]] <= px:
                dq.pop()
            dq.append(i)
    return out


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    days, stop_drop = int(p["days"]), float(p["stop"])
    buy, cap, clip = float(p["buy"]), float(p["cap"]), float(p["clip"])
    rungs = (float(p["rung1"]), float(p["rung2"]), float(p["rung3"]))
    close = np.asarray(df["close"], dtype=np.float64)
    ts = np.asarray(df.index, dtype=np.int64)
    n = close.shape[0]
    out = np.zeros(n, dtype=np.float64)
    href = _prior_max(ts, close, days * DAY_MS)
    band = 1.0 - stop_drop
    pos = 0.0
    avg = 0.0
    peak = 0.0
    stop = 0.0
    rung = 0
    for i in range(n):
        px = close[i]
        if not np.isfinite(px) or px <= 0.0:
            out[i] = pos
            continue
        sold = False
        if pos > 0.0:
            if px > peak:
                peak = px
                raised = peak * band
                if raised > stop:
                    stop = raised
            if px <= stop:
                pos = avg = peak = stop = 0.0
                rung = 0
                sold = True
            elif rung < len(rungs) and avg > 0.0 and px >= avg * (1.0 + rungs[rung]):
                pos = max(0.0, pos - clip)
                rung += 1
                sold = True
                if pos <= 1e-9:
                    pos = avg = peak = stop = 0.0
                    rung = 0
        if not sold and pos < cap - 1e-12:
            high = href[i]
            if np.isfinite(high) and px > high:
                room = cap - pos
                add = buy if room >= buy - 1e-12 else room
                if add >= clip - 1e-12:
                    if pos <= 0.0:
                        avg = peak = px
                        stop = px * band
                        pos = add
                        rung = 0
                    else:
                        avg = (avg * pos + px * add) / (pos + add)
                        pos = pos + add
                        if px > peak:
                            peak = px
                            raised = peak * band
                            if raised > stop:
                                stop = raised
        out[i] = pos
    out *= max_weight(spec)
    return frame(df.index, {m: out})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Buys {mk} in steps of {pct(p['buy'])} on each new {int(p['days'])}-day high, up to {pct(p['cap'])}. "
            f"Sells {pct(p['clip'])} at {pct(p['rung1'])}, {pct(p['rung2'])} and {pct(p['rung3'])} above the average buy, "
            f"and sells the rest {pct(p['stop'])} under the peak."
        ),
        "howItWorks": [
            f"A new high is a close above the highest close of the previous {int(p['days'])} days. The current bar is not part of that high.",
            f"Each new high buys {pct(p['buy'])}, and the position stops at {pct(p['cap'])}.",
            f"The first time the close is {pct(p['rung1'])} above the average buy, it sells {pct(p['clip'])}. "
            f"It sells another {pct(p['clip'])} at {pct(p['rung2'])}, and another at {pct(p['rung3'])}.",
            f"What remains sells when the close is {pct(p['stop'])} under the highest close since the entry. That stop only moves up. A sell bar does not buy.",
        ] + risk_steps(spec),
        "whenItWins": "A climb that keeps making new highs, so the steps fill, and the profit sales lock in part of the rise before a deeper drop.",
        "whenItLoses": "A series of short highs that fail, so it buys and then sells the steps lower. A coin that never trends spends the time in euros.",
    }
