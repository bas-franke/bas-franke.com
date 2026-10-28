"""sl_slices v1: buy a quarter on a cross above the average, then add on a clock.

The stop starts under the entry close and then ratchets to the same drop under the peak.
A stop flattens the position and resets the clock. The next buy needs a fresh cross. No lookahead.
"""
from __future__ import annotations

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "sl_slices"
VERSION = 1
TITLE = "Adds on a clock"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"every": 168, "drop": 0.2, "average": 80, "step": 0.25}


def param_space() -> dict:
    return {
        "every": {"type": "int", "min": 2, "max": 2000, "log": True, "description": "candles between adds"},
        "drop": {"type": "float", "min": 0.05, "max": 0.6, "description": "stop this far under the peak close"},
        "average": {"type": "int", "min": 2, "max": 1000, "log": True, "description": "average the first buy has to cross"},
        "step": {"type": "float", "min": 0.05, "max": 1.0, "description": "size of each add"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["every"]) < 1:
        return "every must be at least 1"
    return None


def warmup(p: dict) -> int:
    return int(p["average"]) + 1


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    span = int(p["every"])
    drop = float(p["drop"])
    ma_n = int(p["average"])
    step = float(p["step"])
    close = df["close"].to_numpy(np.float64)
    n = close.shape[0]
    w = np.full(n, np.nan)
    if n < ma_n + 1 or span < 1:
        return frame(df.index, {m: w})
    roll = np.cumsum(close)
    ma = np.full(n, np.nan)
    ma[ma_n - 1] = roll[ma_n - 1] / ma_n
    if n > ma_n:
        ma[ma_n:] = (roll[ma_n:] - roll[:-ma_n]) / ma_n
    keep = 1.0 - drop
    in_trade = False
    steps = 0
    age = 0
    peak = 0.0
    stop = 0.0
    mw = max_weight(spec)
    for i in range(ma_n, n):
        c = close[i]
        if not np.isfinite(c):
            w[i] = 0.0
            in_trade = False
            steps = 0
            age = 0
            continue
        if in_trade:
            if c <= stop:
                in_trade = False
                steps = 0
                age = 0
                w[i] = 0.0
                continue
            if c > peak:
                peak = c
                trailed = peak * keep
                if trailed > stop:
                    stop = trailed
            age += 1
            if age % span == 0 and steps * step < 1.0 - 1e-12 and c > stop and c >= close[i - span]:
                steps += 1
            w[i] = min(1.0, steps * step) * mw
        else:
            prev = close[i - 1]
            if np.isfinite(ma[i]) and np.isfinite(ma[i - 1]) and c > ma[i] and prev <= ma[i - 1]:
                in_trade = True
                steps = 1
                age = 0
                peak = c
                stop = c * keep
            w[i] = min(1.0, steps * step) * mw
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": (
            f"Buys a first slice of {mk} when the price crosses above its average, then adds on a clock "
            f"while the close holds up, and sells {pct(p['drop'])} under the peak."
        ),
        "howItWorks": [
            f"The first buy is {pct(p['step'])} of the account, on the candle the close crosses above its "
            f"{bars_text(int(p['average']), iv)} average.",
            f"Every {bars_text(int(p['every']), iv)} after that entry, it adds the same slice if the close is still "
            "above the stop and at or above the close from that long ago, up to the whole account.",
            f"The stop starts {pct(p['drop'])} under the entry close, then moves up to {pct(p['drop'])} under the "
            "highest close since entry. It never moves down. A close at or under it sells everything and the clock resets. "
            "The next buy waits for a fresh cross above the average.",
        ] + risk_steps(spec),
        "whenItWins": "A rise that stays above its average for several weeks, so the later slices get bought into a trend that keeps making higher closes.",
        "whenItLoses": "A cross that fails, and a climb that makes a high and then falls through the raised stop before the next add.",
    }
