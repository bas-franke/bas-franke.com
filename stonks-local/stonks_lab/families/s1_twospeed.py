"""s1_twospeed: two sleeves on the same new high, with a fast stop and a slow stop.

Each sleeve is a quarter. The book never goes past a half. Stops only rise.
A sleeve that sells does not buy on that bar. No lookahead.
"""
from __future__ import annotations

from collections import deque

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "s1_twospeed"
VERSION = 1
TITLE = "Two speeds"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"fastDays": 20, "slowDays": 20, "fastStop": 0.14, "slowStop": 0.28, "sleeve": 0.25}


def param_space() -> dict:
    return {
        "fastDays": {"type": "int", "min": 5, "max": 90, "description": "calendar days in the fast sleeve's new high"},
        "slowDays": {"type": "int", "min": 5, "max": 90, "description": "calendar days in the slow sleeve's new high"},
        "fastStop": {"type": "float", "min": 0.05, "max": 0.25, "description": "fast sleeve sells this far under its own peak"},
        "slowStop": {"type": "float", "min": 0.1, "max": 0.45, "description": "slow sleeve sells this far under its own peak"},
        "sleeve": {"type": "float", "min": 0.05, "max": 0.25, "description": "size of each sleeve"},
    }


def valid_params(p: dict) -> str | None:
    if not float(p["fastStop"]) < float(p["slowStop"]):
        return "the fast stop must be tighter than the slow stop"
    if float(p["sleeve"]) * 2 > 1.0 + 1e-9:
        return "the two sleeves together cannot exceed the whole account"
    return None


def warmup(p: dict) -> int:
    return max(int(p["fastDays"]), int(p["slowDays"])) + 1


def _prior_max(close: np.ndarray, ts: np.ndarray, days: int) -> np.ndarray:
    n = close.shape[0]
    out = np.full(n, np.nan, dtype=np.float64)
    window = int(days) * DAY_MS
    dq: deque[int] = deque()
    left = 0
    for i in range(n):
        cutoff = int(ts[i]) - window
        while left < i and int(ts[left]) < cutoff:
            left += 1
        while dq and dq[0] < left:
            dq.popleft()
        if dq:
            out[i] = close[dq[0]]
        px = close[i]
        if px == px and px > 0.0:
            while dq and close[dq[-1]] <= px:
                dq.pop()
            dq.append(i)
    return out


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    fast_days, slow_days = int(p["fastDays"]), int(p["slowDays"])
    fast_band = 1.0 - float(p["fastStop"])
    slow_band = 1.0 - float(p["slowStop"])
    sleeve = float(p["sleeve"])
    close = np.asarray(df["close"], dtype=np.float64)
    ts = np.asarray(df.index, dtype=np.int64)
    n = close.shape[0]
    fast_href = _prior_max(close, ts, fast_days)
    slow_href = fast_href if slow_days == fast_days else _prior_max(close, ts, slow_days)
    out = np.full(n, np.nan, dtype=np.float64)
    fast_on = slow_on = False
    fast_peak = slow_peak = 0.0
    fast_px = slow_px = 0.0
    started = False
    for i in range(n):
        px = close[i]
        if not (px == px and px > 0.0):
            continue
        fast_stopped = slow_stopped = False
        if fast_on and px <= fast_px:
            fast_on = False
            fast_peak = fast_px = 0.0
            fast_stopped = True
        if slow_on and px <= slow_px:
            slow_on = False
            slow_peak = slow_px = 0.0
            slow_stopped = True
        f_href, s_href = fast_href[i], slow_href[i]
        fast_known = f_href == f_href
        slow_known = s_href == s_href
        if fast_known and (not fast_on) and (not fast_stopped) and px > f_href:
            fast_on = True
            fast_peak = px
            fast_px = px * fast_band
        elif fast_on and px > fast_peak:
            fast_peak = px
            raised = fast_peak * fast_band
            if raised > fast_px:
                fast_px = raised
        if slow_known and (not slow_on) and (not slow_stopped) and px > s_href:
            slow_on = True
            slow_peak = px
            slow_px = px * slow_band
        elif slow_on and px > slow_peak:
            slow_peak = px
            raised = slow_peak * slow_band
            if raised > slow_px:
                slow_px = raised
        if fast_known or slow_known or started:
            started = True
            out[i] = sleeve * ((1.0 if fast_on else 0.0) + (1.0 if slow_on else 0.0))
    finite = np.isfinite(out)
    out[finite] *= max_weight(spec)
    return frame(df.index, {m: out})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Holds {mk} as two sleeves of {pct(p['sleeve'])}. Both buy a new high. "
            f"The fast one sells {pct(p['fastStop'])} under its own peak, the slow one {pct(p['slowStop'])} under its own."
        ),
        "howItWorks": [
            f"A new high is a close above every close in the previous {int(p['fastDays'])} days for the fast sleeve "
            f"and {int(p['slowDays'])} days for the slow sleeve. The current bar is not part of that high.",
            f"Each sleeve buys {pct(p['sleeve'])} when it is flat and that high breaks. Together they stay at or under half the account.",
            f"The fast stop sits {pct(p['fastStop'])} under that sleeve's highest close and only moves up. "
            f"The slow stop sits {pct(p['slowStop'])} under its own highest close and only moves up.",
            "A sleeve that sells stays flat until a later new high. It does not buy on the bar it sells.",
        ] + risk_steps(spec),
        "whenItWins": "A rise that both sleeves catch, with the fast sleeve banking the sharp part and the slow sleeve staying through the smaller dips.",
        "whenItLoses": "A choppy market that keeps stopping the fast sleeve and buying it back lower, while the slow sleeve sits through a long fall.",
    }
