"""sl_floor v1: buy a quarter on each close above the prior high. The stop is the highest recent low, and it only rises.

The breakout high is the highest high of the previous n bars, not including the current bar.
The floor is the highest rolling n-bar low seen since entry. No lookahead.
"""
from __future__ import annotations

import numpy as np

from stonks_lab import indicators as ind

from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "sl_floor"
VERSION = 1
TITLE = "Breakout floor"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"n": 480}


def param_space() -> dict:
    return {
        "n": {"type": "int", "min": 8, "max": 2000, "log": True, "description": "breakout and floor length in candles"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(p["n"]) + 1


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    n = int(spec["params"]["n"])
    high = df["high"].to_numpy(np.float64)
    low = df["low"].to_numpy(np.float64)
    close = df["close"].to_numpy(np.float64)
    length = close.shape[0]
    w = np.full(length, np.nan)
    if length <= n:
        return frame(df.index, {m: w})
    prior_high = ind.prior_max(high, n)
    roll_low = ind.rolling_min(low, n)
    quarters = 0
    floor = 0.0
    mw = max_weight(spec)
    for i in range(n, length):
        c = close[i]
        hi = prior_high[i]
        lo = roll_low[i]
        if quarters:
            if lo == lo and lo > floor:
                floor = lo
            if c == c and c <= floor:
                quarters = 0
                w[i] = 0.0
                continue
            if quarters < 4 and c == c and hi == hi and c > hi:
                quarters += 1
        elif c == c and hi == hi and lo == lo and c > hi and c > lo:
            quarters = 1
            floor = lo
        w[i] = quarters * 0.25 * mw
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    window = bars_text(int(p["n"]), iv)
    return {
        "summary": f"Buys {mk} a quarter at a time on each new high, and sells when the close falls through the highest recent low.",
        "howItWorks": [
            f"After {window}, a close above the highest high of the previous window buys a quarter of the account.",
            "While that trade is open, the stop is the highest low of any window of that length since the entry, and that floor only moves up. "
            "Each later close above the previous window's high, still above the floor, buys another quarter, up to the whole account.",
            "A close at or under the floor sells everything. The next trade starts the floor over.",
        ] + risk_steps(spec),
        "whenItWins": "A breakout that keeps closing above its old highs while the recent lows themselves keep rising, so the stop walks up under the trade.",
        "whenItLoses": "A breakout that fails back through the recent low, especially on a short history where one fall is most of the sample.",
    }
