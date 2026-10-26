"""tsmom_blend v1 (agent-03, trend lane): blended time-series momentum.

Classic trend following without moving-average crosses: look at the market's own return over several horizons
(lookback, lookback*mult, lookback*mult^2, ...). Each horizon whose return is above ``threshold`` votes "up"; the
target weight is maxWeight * (up votes / horizons). Averaging horizons gives a graded position that changes a third or
a quarter at a time, so a single parameter is less of a cliff than one EMA cross. Decisions at bar t use closes up to
and including bar t only.
"""
from __future__ import annotations

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "tsmom_blend"
VERSION = 1
TITLE = "Blended time-series momentum"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"lookback": 30, "mult": 2.0, "horizons": 3, "threshold": 0.0}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 3, "max": 400, "log": True,
                     "description": "shortest horizon: return measured over this many candles"},
        "mult": {"type": "float", "min": 1.3, "max": 4.0,
                 "description": "each next horizon is this many times longer"},
        "horizons": {"type": "int", "min": 1, "max": 4, "description": "number of horizons that vote"},
        "threshold": {"type": "float", "min": 0.005, "max": 0.3, "zero": True, "log": True,
                      "description": "a horizon votes up only if its return beats this fraction (0 = any gain)"},
    }


def lengths(p: dict) -> list[int]:
    return [int(round(p["lookback"] * p["mult"] ** k)) for k in range(int(p["horizons"]))]


def valid_params(p: dict) -> str | None:
    if lengths(p)[-1] > 1500:
        return "longest horizon over 1500 candles"
    return None


def warmup(p: dict) -> int:
    return lengths(p)[-1]


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    thr = float(p.get("threshold") or 0.0)
    ls = lengths(p)
    votes = np.zeros(n)
    for L in ls:
        r = np.full(n, np.nan)
        if L < n:
            r[L:] = c[L:] / c[:-L] - 1.0
        votes += np.where(r > thr, 1.0, 0.0)
    longest = ls[-1]
    w = max_weight(spec) * votes / len(ls)
    w[: min(longest, n)] = np.nan
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    ls = lengths(p)
    hz = ", ".join(bars_text(L, iv) for L in ls)
    thr = float(p.get("threshold") or 0.0)
    cond = "went up" if thr == 0 else f"rose more than {thr * 100:.1f} %"
    steps = [
        f"After every {iv} candle it checks how {mk}'s price changed over {len(ls)} look-back "
        f"period{'s' if len(ls) > 1 else ''}: {hz}.",
        f"Each period in which the price {cond} is one vote for 'trend is up'.",
        f"It holds {mk} in proportion to the votes: all periods up means fully invested, none means all euros, "
        "and in between it holds a matching part.",
    ]
    return {
        "summary": f"A trend follower on {mk}: it holds more of it the more look-back periods show a rising price, "
                   "and steps into euros as the trends turn down.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bull and bear phases: it is fully in for sustained rallies and mostly out for long declines.",
        "whenItLoses": "Sharp V-shaped reversals and long sideways chop, where the votes flip and every step costs fees.",
    }
