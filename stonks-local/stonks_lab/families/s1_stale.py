"""s1_stale: small adds on a new high, a smaller cap while the trade is young, and a buy after a long wait in euros.

The stop only rises. A stop bar does not buy. No lookahead.
"""
from __future__ import annotations

from collections import deque

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "s1_stale"
VERSION = 1
TITLE = "Wait, then a small buy"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {
        "trail": 0.24,
        "highDays": 30,
        "youngDays": 20,
        "flatDays": 45,
        "compareDays": 45,
        "add": 0.2,
        "youngCap": 0.4,
        "oldCap": 0.7,
    }


def param_space() -> dict:
    return {
        "trail": {"type": "float", "min": 0.08, "max": 0.4, "description": "sell this far under the peak"},
        "highDays": {"type": "int", "min": 10, "max": 90, "description": "calendar days in the new-high window"},
        "youngDays": {"type": "int", "min": 5, "max": 60, "description": "days the position stays on the smaller cap"},
        "flatDays": {"type": "int", "min": 10, "max": 120, "description": "days flat before a forced probe"},
        "compareDays": {"type": "int", "min": 10, "max": 120, "description": "the probe needs the close above the close this many days ago"},
        "add": {"type": "float", "min": 0.05, "max": 0.4, "description": "size of each add"},
        "youngCap": {"type": "float", "min": 0.1, "max": 0.8, "description": "largest position while the trade is young"},
        "oldCap": {"type": "float", "min": 0.2, "max": 1.0, "description": "largest position after that"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["youngCap"]) > float(p["oldCap"]) + 1e-9:
        return "the early cap cannot be above the later cap"
    return None


def warmup(p: dict) -> int:
    return int(p["highDays"]) + 1


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    trail = float(p["trail"])
    high_ms = int(p["highDays"]) * DAY_MS
    young_ms = int(p["youngDays"]) * DAY_MS
    flat_ms = int(p["flatDays"]) * DAY_MS
    ago_ms = int(p["compareDays"]) * DAY_MS
    add = float(p["add"])
    young_cap, old_cap = float(p["youngCap"]), float(p["oldCap"])
    band = 1.0 - trail
    close = np.asarray(df["close"], dtype=np.float64)
    ts = np.asarray(df.index, dtype=np.int64)
    n = int(close.shape[0])
    out = np.zeros(n, dtype=np.float64)
    if n == 0:
        return frame(df.index, {m: out})
    dq: deque[int] = deque()
    ago_i = 0
    active = False
    position = peak = stop = 0.0
    flat_since: int | None = int(ts[0])
    entry_ts = 0
    for i in range(n):
        t = int(ts[i])
        if i > 0:
            prev = close[i - 1]
            if np.isfinite(prev) and prev > 0.0:
                while dq and close[dq[-1]] <= prev:
                    dq.pop()
                dq.append(i - 1)
        cutoff = t - high_ms
        while dq and int(ts[dq[0]]) < cutoff:
            dq.popleft()
        window_full = int(ts[0]) <= cutoff
        href = float(close[dq[0]]) if dq else np.nan
        ago_cut = t - ago_ms
        while ago_i + 1 <= i and int(ts[ago_i + 1]) <= ago_cut:
            ago_i += 1
        if int(ts[ago_i]) <= ago_cut and np.isfinite(close[ago_i]):
            ago = float(close[ago_i])
        else:
            ago = np.nan
        px = close[i]
        if not np.isfinite(px) or px <= 0.0:
            out[i] = position if active else 0.0
            continue
        if active and px <= stop:
            active = False
            position = peak = stop = 0.0
            entry_ts = 0
            flat_since = t
            out[i] = 0.0
            continue
        if active:
            if px > peak:
                peak = px
                risen = peak * band
                if risen > stop:
                    stop = risen
            cap = young_cap if (t - entry_ts) < young_ms else old_cap
            if window_full and np.isfinite(href) and px > href and position < cap - 1e-12:
                position = min(cap, position + add)
            out[i] = position
            continue
        buy = False
        if window_full and np.isfinite(href) and px > href:
            buy = True
        elif flat_since is not None and (t - flat_since) >= flat_ms and np.isfinite(ago) and px > ago:
            buy = True
        if buy:
            active = True
            position = add
            peak = px
            stop = px * band
            entry_ts = t
            flat_since = None
            out[i] = position
        else:
            out[i] = 0.0
    out *= max_weight(spec)
    return frame(df.index, {m: out})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Buys {pct(p['add'])} of {mk} on a {int(p['highDays'])}-day high, or after {int(p['flatDays'])} days in euros. "
            f"The position stays at or under {pct(p['youngCap'])} for the first {int(p['youngDays'])} days, "
            f"then may reach {pct(p['oldCap'])}. It sells {pct(p['trail'])} under the peak."
        ),
        "howItWorks": [
            f"A new high is a close above the highest close of the previous {int(p['highDays'])} days. The current bar is not part of that high.",
            f"Each new high adds {pct(p['add'])}. Until the trade is {int(p['youngDays'])} days old the book stays at or under {pct(p['youngCap'])}. "
            f"After that it may reach {pct(p['oldCap'])}.",
            f"If the book has been flat for {int(p['flatDays'])} days and the close is above the close {int(p['compareDays'])} days ago, it buys {pct(p['add'])} anyway.",
            f"The stop sits {pct(p['trail'])} under the highest close since the entry and only moves up. The bar that hits it sells and does not buy.",
        ] + risk_steps(spec),
        "whenItWins": "A climb that lasts long enough for the later, larger cap, with the stop selling before the gain is given back.",
        "whenItLoses": "A market that triggers the forced probe and then falls, or a rise so steep that the early cap is still on when the best of the move has passed.",
    }
