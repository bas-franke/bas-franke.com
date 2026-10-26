"""ramp_core_a07 v1 (agent-07): an SMA trend core whose position ramps in and out over several candles.

A plain SMA core flips 0 <-> 100 % on one close, so its result depends on the exact day of each cross (findings
#462, #475: single specs are lucky timings; a bag of nearby specs scores like the plateau). This family spreads every
switch over time instead: while the close is above the average the weight rises by 1/rampIn per candle, while it is
below it falls by 1/rampOut, clipped to floor..1. That is the same as holding the average of rampIn (rampOut)
copies of the core that act 0, 1, 2, ... candles late: time bagging inside one strategy.

rampIn = rampOut = 1 and floor = 0 is the plain SMA core (the ablation). The recursion starts at the first bar with
an average (weight = 1 if above, else floor), so it never depends on where a test window starts.
Steps under 2 % of equity are skipped by the backtester, so ramps are capped at 40 candles.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "ramp_core_a07"
VERSION = 1
TITLE = "SMA trend core with gradual (ramped) entries and exits"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"smaLen": 60, "rampIn": 5, "rampOut": 5, "floor": 0.0}


def param_space() -> dict:
    return {
        "smaLen": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "length of the simple moving average (candles)"},
        "rampIn": {"type": "int", "min": 1, "max": 40, "log": True,
                   "description": "candles to go from the floor to fully invested while above the average"},
        "rampOut": {"type": "int", "min": 1, "max": 40, "log": True,
                    "description": "candles to go from fully invested to the floor while below the average"},
        "floor": {"type": "float", "min": 0.05, "max": 0.6, "zero": True,
                  "description": "weight kept even in a downtrend (0 = all cash)"},
    }


def warmup(p: dict) -> int:
    return int(p["smaLen"])


def ramp_weights(above: np.ndarray, ramp_in: int, ramp_out: int, floor: float) -> np.ndarray:
    """Weight path from a 1/0/NaN 'above' series: +1/ramp_in per bar above, -1/ramp_out below, clipped floor..1."""
    out = np.full(len(above), np.nan)
    w = None
    up, dn = 1.0 / ramp_in, 1.0 / ramp_out
    for i, a in enumerate(above.tolist()):
        if a != a:
            continue
        if w is None:
            w = 1.0 if a >= 0.5 else floor
        elif a >= 0.5:
            w = min(1.0, w + up)
        else:
            w = max(floor, w - dn)
        out[i] = w
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    sm = ind.sma(c, int(p["smaLen"]))
    above = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
    w = ramp_weights(above, int(p["rampIn"]), int(p["rampOut"]), float(p["floor"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    ri, ro, fl = int(p["rampIn"]), int(p["rampOut"]), float(p["floor"])
    steps = [f"It watches whether {mk} closes above its average price over {bars_text(p['smaLen'], iv)}.",
             f"While it does, it buys a bit more every candle, reaching fully invested after {ri} "
             f"candle{'s' if ri > 1 else ''} in a row.",
             f"While it closes below, it sells a bit every candle, reaching "
             + (f"{pct(fl)} invested" if fl > 0 else "all euros") + f" after {ro} candle{'s' if ro > 1 else ''}.",
             "So one close on the wrong side of the line moves only a slice of the money, not all of it."]
    return {
        "summary": f"Follows the trend of {mk}, but moves in and out gradually instead of all at once.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Choppy markets around the average, where one-day crosses would flip the whole position.",
        "whenItLoses": "Sharp crashes and V-shaped rebounds: the slow exit holds part of the fall and the slow "
                       "entry misses part of the rebound.",
    }
