"""s2_crash: stay invested, and cut only after a real break of a short high."""
from __future__ import annotations

from collections import deque

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "s2_crash"
VERSION = 1
TITLE = "Crash only"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"windowDays": 14, "recoverDays": 30, "drop": 0.25, "default": 0.85, "cut": 0.30}


def param_space() -> dict:
    return {
        "windowDays": {"type": "int", "min": 7, "max": 20, "description": "days in the high the break is measured against"},
        "recoverDays": {"type": "int", "min": 15, "max": 30, "description": "days back for the close that ends the cut"},
        "drop": {"type": "float", "min": 0.2, "max": 0.3, "description": "how far under that high a close must fall"},
        "default": {"type": "float", "min": 0.7, "max": 0.85, "description": "size while no crash is on"},
        "cut": {"type": "float", "min": 0.15, "max": 0.3, "description": "size during the crash"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["cut"]) >= float(p["default"]):
        return "the cut must be smaller than the usual size"
    return None


def warmup(p: dict) -> int:
    return int(p["windowDays"])


def _weights(df, window_days, recover_days, drop, default, cut) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    close = np.asarray(df["close"], dtype=np.float64)
    n = close.shape[0]
    w = np.empty(n, dtype=np.float64)
    if n == 0:
        return w
    span = int(window_days) * DAY_MS
    recover = int(recover_days) * DAY_MS
    band = 1.0 - float(drop)
    origin = int(ts[0])
    peak_q: deque[int] = deque()
    ago = 0
    state = 0
    for i in range(n):
        t = int(ts[i])
        cutoff = t - span
        while peak_q and int(ts[peak_q[0]]) < cutoff:
            peak_q.popleft()
        c = close[i]
        finite = c == c and c > 0.0
        if finite:
            while peak_q and close[peak_q[-1]] <= c:
                peak_q.pop()
            peak_q.append(i)
        recover_cut = t - recover
        while ago + 1 < n and int(ts[ago + 1]) <= recover_cut:
            ago += 1
        if not finite:
            w[i] = cut if state else default
            continue
        old = close[ago] if int(ts[ago]) <= recover_cut and close[ago] == close[ago] and close[ago] > 0.0 else np.nan
        above = old == old and c > old
        if state:
            if above:
                state = 0
        elif origin <= cutoff and peak_q:
            peak = close[peak_q[0]]
            if peak == peak and peak > 0.0 and c <= peak * band and not above:
                state = 1
        w[i] = cut if state else default
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, p["windowDays"], p["recoverDays"], p["drop"], p["default"], p["cut"])
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Holds {pct(p['default'])} of {mk}. Cuts to {pct(p['cut'])} only after a close is {pct(p['drop'])} "
            f"under the highest close of the previous {int(p['windowDays'])} days and is also under the close from "
            f"{int(p['recoverDays'])} days ago."
        ),
        "howItWorks": [
            f"The usual size is {pct(p['default'])}. A dip smaller than {pct(p['drop'])} does not sell.",
            f"The high is the highest close of the previous {int(p['windowDays'])} days, including the current bar.",
            f"The cut also requires the close to be at or under the close from {int(p['recoverDays'])} days ago.",
            "The size returns to the usual one once the close is back above that older close.",
        ] + risk_steps(spec),
        "whenItWins": "A long rise with ordinary dips, which it holds, and a sharp break that it steps down for.",
        "whenItLoses": "A slow grind lower that never prints the 25 percent break, so the book stays large.",
    }
