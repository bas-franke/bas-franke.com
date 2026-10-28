"""s2_quarter: own the market while the close is above the close from months ago."""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "s2_quarter"
VERSION = 1
TITLE = "Quarter up"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000
WEEK_MS = 7 * DAY_MS


def default_params() -> dict:
    return {"lookback": 120, "below": 28, "high": 0.8, "low": 0.15}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 60, "max": 120, "description": "days back for the reference close"},
        "below": {"type": "int", "min": 15, "max": 30, "description": "days the close must stay under that reference"},
        "high": {"type": "float", "min": 0.55, "max": 0.8, "description": "size while the close is above the reference"},
        "low": {"type": "float", "min": 0.1, "max": 0.25, "description": "size after the confirmed break"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["low"]) >= float(p["high"]):
        return "the small size must sit under the large size"
    return None


def warmup(p: dict) -> int:
    return int(p["lookback"])


def _weights(df, lookback, below, high, low) -> np.ndarray:
    close = np.asarray(df["close"], dtype=np.float64)
    ts = np.asarray(df.index, dtype=np.int64)
    n = int(close.shape[0])
    out = np.full(n, high, dtype=np.float64)
    if n == 0:
        return out
    lag = int(lookback) * DAY_MS
    confirm = int(below) * DAY_MS
    cur = high
    i = int(np.searchsorted(ts, int(ts[0]) + lag, side="left"))
    while i < n:
        t = int(ts[i])
        ref_j = int(np.searchsorted(ts, t - lag, side="right") - 1)
        if 0 <= ref_j < i:
            ref = float(close[ref_j])
            px = float(close[i])
            if ref == ref and ref > 0.0 and px == px and px > ref:
                cur = high
            elif ref == ref and ref > 0.0 and px == px and px < ref:
                k = int(np.searchsorted(ts, t - confirm, side="left"))
                if k < i and int(ts[k]) <= t - confirm + DAY_MS and np.all(close[k:i + 1] < ref):
                    cur = low
        nxt = int(np.searchsorted(ts, t + WEEK_MS, side="left"))
        if nxt <= i:
            nxt = i + 1
        out[i:nxt] = cur
        i = nxt
    return out


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, p["lookback"], p["below"], float(p["high"]), float(p["low"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Holds {pct(p['high'])} of {mk} while the close is above the close from {int(p['lookback'])} days ago. "
            f"Drops to {pct(p['low'])} only after {int(p['below'])} days underneath that close."
        ),
        "howItWorks": [
            "The check is every 7 days. Between checks the size stays put.",
            f"A close above the close from {int(p['lookback'])} days ago, however far above, holds the large size.",
            f"The small size needs every close of the last {int(p['below'])} days to be under that same old close.",
            "The book starts at the large size, so a rise is owned before the first comparison exists.",
        ] + risk_steps(spec),
        "whenItWins": "A market that spends most of its time above where it was four months ago, including a late high.",
        "whenItLoses": "A coin that chops under its own four-month-old close, so the book sits at the small size through the recovery.",
    }
