"""s1_third: three slices, and a later slice only after the last one is up.

The stop only rises. A stop bar does not buy. No lookahead.
"""
from __future__ import annotations

from collections import deque

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "s1_third"
VERSION = 1
TITLE = "Add when up"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"lookDays": 20, "minGap": 0.1, "stop": 0.2, "slice": 0.22, "minDays": 5}


def param_space() -> dict:
    return {
        "lookDays": {"type": "int", "min": 5, "max": 90, "description": "calendar days in the new-high window"},
        "minGap": {"type": "float", "min": 0.02, "max": 0.4, "description": "the next slice needs this gain over the last add"},
        "stop": {"type": "float", "min": 0.08, "max": 0.4, "description": "sell this far under the peak"},
        "slice": {"type": "float", "min": 0.05, "max": 0.3, "description": "size of each slice"},
        "minDays": {"type": "int", "min": 1, "max": 30, "description": "minimum days between slices"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["slice"]) * 3 > 1.0 + 1e-9:
        return "three slices cannot exceed the whole account"
    return None


def warmup(p: dict) -> int:
    return int(p["lookDays"]) + 1


def _prior_max(ts: np.ndarray, close: np.ndarray, window_ms: int) -> np.ndarray:
    n = close.shape[0]
    out = np.full(n, np.nan, dtype=np.float64)
    dq: deque[int] = deque()
    for i in range(n):
        cutoff = int(ts[i]) - window_ms
        while dq and int(ts[dq[0]]) < cutoff:
            dq.popleft()
        if dq:
            out[i] = close[dq[0]]
        px = close[i]
        if px == px and px > 0.0:
            while dq and not (close[dq[-1]] > px):
                dq.pop()
            dq.append(i)
    return out


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    look_days, min_days = int(p["lookDays"]), int(p["minDays"])
    gap, stop_pct, slice_w = float(p["minGap"]), float(p["stop"]), float(p["slice"])
    close = np.asarray(df["close"], dtype=np.float64)
    ts = np.asarray(df.index, dtype=np.int64)
    n = int(close.shape[0])
    out = np.zeros(n, dtype=np.float64)
    if n == 0:
        return frame(df.index, {m: out})
    window_ms = look_days * DAY_MS
    wait_ms = min_days * DAY_MS
    levels = (0.0, round(slice_w, 2), round(slice_w * 2.0, 2), round(slice_w * 3.0, 2))
    href = _prior_max(ts, close, window_ms)
    keep = 1.0 - stop_pct
    need = 1.0 + gap
    in_trade = False
    adds = 0
    position = peak = stop = last_px = 0.0
    last_ts = 0
    start_ts = int(ts[0])
    for i in range(n):
        px = close[i]
        if not (px == px) or px <= 0.0:
            out[i] = position
            continue
        t = int(ts[i])
        if in_trade and px <= stop:
            in_trade = False
            adds = 0
            position = peak = stop = 0.0
            out[i] = 0.0
            continue
        if in_trade:
            if px > peak:
                peak = px
                lifted = peak * keep
                if lifted > stop:
                    stop = lifted
            if adds < 3 and (t - last_ts) >= wait_ms and last_px > 0.0 and px / last_px >= need - 1e-12:
                adds += 1
                position = levels[adds]
                last_px = px
                last_ts = t
            out[i] = position
        else:
            if t - start_ts >= window_ms:
                h = href[i]
                if h == h and px > h:
                    in_trade = True
                    adds = 1
                    position = levels[1]
                    peak = px
                    stop = px * keep
                    last_px = px
                    last_ts = t
            out[i] = position
    out *= max_weight(spec)
    return frame(df.index, {m: out})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Buys {mk} in slices of {pct(p['slice'])}, up to three. "
            f"A later slice is allowed only after a {pct(p['minGap'])} gain. "
            f"The whole position sells {pct(p['stop'])} under the peak."
        ),
        "howItWorks": [
            f"The first slice buys when the close is above the highest close of the previous {int(p['lookDays'])} days. "
            "That window has to be full, and the current bar is not part of the high.",
            f"The next slice is bought only when the close is at least {pct(p['minGap'])} above the previous add "
            f"and at least {int(p['minDays'])} days have passed. A third slice uses the same rule.",
            f"The stop sits {pct(p['stop'])} under the highest close since the entry and only moves up. "
            "A close at or under it sells everything and does not buy on that bar.",
        ] + risk_steps(spec),
        "whenItWins": "A steady climb, so each slice is added only after the last one is already up, and the stop sells before the gain is given back.",
        "whenItLoses": "A spike that never holds the extra gain, so only the first slice is bought and then stopped, over and over.",
    }
