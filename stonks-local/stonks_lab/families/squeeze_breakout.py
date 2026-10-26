"""squeeze_breakout v1 (agent-19, trend lane): volatility-squeeze breakout, long only, one coin.

A "squeeze" bar is one where the Bollinger bandwidth (population std / SMA over ``bbLen``) ranks in the lowest
``sqPct`` of its own last ``sqLookback`` values: the market has gone unusually quiet. A breakout is a close above the
upper band (SMA + ``bbK`` std) within ``armBars`` candles after a squeeze bar (optionally only above a slow SMA).
The position is held until the close falls under the SMA over ``exitLen`` candles. Unlike a plain Donchian or band
breakout this only trades expansions out of quiet ranges, the classic "calm before the move" setup.
Decisions at bar t use candles up to and including bar t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "squeeze_breakout"
VERSION = 1
TITLE = "Volatility squeeze breakout"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"bbLen": 20, "bbK": 2.0, "sqLookback": 180, "sqPct": 0.2, "armBars": 10, "exitLen": 50, "trendSma": 0}


def param_space() -> dict:
    return {
        "bbLen": {"type": "int", "min": 5, "max": 120, "log": True, "description": "Bollinger band length in candles"},
        "bbK": {"type": "float", "min": 0.5, "max": 3.5, "description": "band width in standard deviations"},
        "sqLookback": {"type": "int", "min": 30, "max": 600, "log": True,
                       "description": "candles over which the bandwidth is ranked"},
        "sqPct": {"type": "float", "min": 0.02, "max": 0.6, "log": True,
                  "description": "a squeeze is a bandwidth in this lowest fraction of its recent values"},
        "armBars": {"type": "int", "min": 1, "max": 120, "log": True,
                    "description": "a breakout counts this many candles after the last squeeze bar"},
        "exitLen": {"type": "int", "min": 5, "max": 400, "log": True,
                    "description": "sell when the close falls under the SMA over this many candles"},
        "trendSma": {"type": "int", "min": 20, "max": 600, "log": True, "zero": True,
                     "description": "only buy while the close is above this SMA (0 = off)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["bbLen"]) + int(p["sqLookback"]), int(p["exitLen"]), int(p["trendSma"] or 0))


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    bl = int(p["bbLen"])
    mid = ind.sma(c, bl)
    sd = ind.std_pop(c, bl)
    upper = mid + float(p["bbK"]) * sd
    with np.errstate(invalid="ignore", divide="ignore"):
        bw = sd / mid
    L = int(p["sqLookback"])
    rank = pd.Series(bw).rolling(L, min_periods=L).rank(pct=True).to_numpy(np.float64)
    squeeze = np.nan_to_num(rank, nan=2.0) <= float(p["sqPct"])
    ex = ind.sma(c, int(p["exitLen"]))
    ts = int(p["trendSma"] or 0)
    gate = ind.sma(c, ts) if ts else np.zeros(n)
    defined = np.isfinite(rank) & np.isfinite(ex) & np.isfinite(gate) & np.isfinite(upper)
    arm = int(p["armBars"])
    w = np.full(n, np.nan)
    mw = max_weight(spec)
    held = False
    last_sq = -10**9
    for i in range(n):
        if squeeze[i]:
            last_sq = i
        if not defined[i]:
            continue
        if held:
            if c[i] < ex[i]:
                held = False
        elif c[i] > upper[i] and i - last_sq <= arm and (not ts or c[i] > gate[i]):
            held = True
        w[i] = mw if held else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    ts = int(p["trendSma"] or 0)
    steps = [
        f"After every {iv} candle it measures how wide {mk}'s Bollinger bands are ({bars_text(int(p['bbLen']), iv)}, "
        f"{float(p['bbK']):g} standard deviations) relative to the price.",
        f"When that width is among the narrowest {pct(float(p['sqPct']))} of the last "
        f"{bars_text(int(p['sqLookback']), iv)}, the market is in a 'squeeze': unusually quiet.",
        f"If within {bars_text(int(p['armBars']), iv)} after a squeeze the close breaks above the upper band"
        + (f" (and the price is above its {bars_text(ts, iv)} average)" if ts else "") + ", it buys.",
        f"It sells everything when the close falls under its {bars_text(int(p['exitLen']), iv)} average.",
    ]
    return {
        "summary": f"Buys {mk} when it breaks upward out of an unusually quiet period, rides the move with a moving-"
                   "average exit.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Quiet ranges that end in a strong rally.",
        "whenItLoses": "False breakouts that fall straight back, and rallies that start from volatile, not quiet, markets.",
    }
