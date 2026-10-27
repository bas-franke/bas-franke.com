"""williams_dip v1: buy Williams %R oversold dips (optionally only in an uptrend), exit on recovery or after a time cap.

%R = -100 * (highest high(n) - close) / (highest high(n) - lowest low(n)), in -100..0.
It buys when %R <= -entryLevel (and the close is above the optional trend SMA); it sells when %R >= -exitLevel or
after ``maxHold`` candles (0 = no cap).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "williams_dip"
VERSION = 1
TITLE = "Williams %R dip"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"n": 14, "entryLevel": 90.0, "exitLevel": 30.0, "maxHold": 0, "trendSma": 200}


def param_space() -> dict:
    return {
        "n": {"type": "int", "min": 3, "max": 100, "log": True, "description": "%R look-back in candles"},
        "entryLevel": {"type": "float", "min": 70.0, "max": 99.5, "description": "buy when %R <= -entryLevel"},
        "exitLevel": {"type": "float", "min": 0.0, "max": 60.0, "description": "sell when %R >= -exitLevel"},
        "maxHold": {"type": "int", "min": 2, "max": 200, "log": True, "zero": True,
                    "description": "sell after this many candles in the trade (0 = off)"},
        "trendSma": {"type": "int", "min": 10, "max": 600, "log": True, "zero": True,
                     "description": "only buy while the close is above this SMA (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["exitLevel"] < p["entryLevel"] else "exitLevel must be below entryLevel"


def warmup(p: dict) -> int:
    return max(int(p["n"]), int(p["trendSma"] or 0)) - 1


def williams_r(high, low, close, n: int) -> np.ndarray:
    hh, ll = ind.rolling_max(high, n), ind.rolling_min(low, n)
    c = np.asarray(close, np.float64)
    rng = hh - ll
    with np.errstate(invalid="ignore", divide="ignore"):
        r = np.where(rng > 0, -100.0 * (hh - c) / rng, -50.0)  # a flat range counts as the middle
    r[~np.isfinite(rng)] = np.nan
    return r


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    r = williams_r(df["high"].to_numpy(np.float64), df["low"].to_numpy(np.float64), c, int(p["n"]))
    tsma = int(p["trendSma"] or 0)
    gate = ind.sma(c, tsma) if tsma else np.full(len(c), -np.inf)
    cap, mw = int(p["maxHold"] or 0), max_weight(spec)
    w = np.full(len(c), np.nan)
    held, bars_in = False, 0
    for i in range(len(c)):
        if not np.isfinite(r[i]) or (tsma and not np.isfinite(gate[i])):
            continue
        if held:
            bars_in += 1
            if r[i] >= -p["exitLevel"] or (cap and bars_in >= cap):
                held = False
        elif r[i] <= -p["entryLevel"] and c[i] > gate[i]:
            held, bars_in = True, 0
        w[i] = mw if held else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    gate = (f" while {mk} is above its {bars_text(int(p['trendSma']), iv)} average (an uptrend)"
            if p.get("trendSma") else "")
    cap = (f" or after {bars_text(int(p['maxHold']), iv)} in the trade, whichever comes first"
           if p.get("maxHold") else "")
    return {
        "summary": f"Buys short, sharp dips in {mk}{gate} and sells on the bounce.",
        "howItWorks": [
            f"After every {iv} candle it measures where the close sits in the range of the last "
            f"{bars_text(int(p['n']), iv)} (Williams %R: -100 = at the bottom, 0 = at the top).",
            f"It buys when %R is at or below -{p['entryLevel']:.0f}{gate}.",
            f"It sells everything once %R climbs back to -{p['exitLevel']:.0f} or higher{cap}.",
            *risk_steps(spec),
        ],
        "whenItWins": "Uptrends with brief panics: it buys the panic and sells the snap-back.",
        "whenItLoses": "Real breakdowns: a dip that keeps falling is held until the exit or a stop.",
    }
