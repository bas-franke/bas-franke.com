"""panic_bounce v1: buy a sharp intraday dip only while the market is in a high-volatility (panic) regime, sell on
the rebound or after a fixed time.

Built by agent-09 (scalp lane). Signal study on 5m BTC/ETH 2019-2025: ordinary z < -3 dips rebound by less than the
0.30 % maker round trip, but in the top decile of trailing 1-day realized volatility they rebound +0.5..+1.5 % within
1-4 h. This family tests whether that survives the fill model and walk-forward folds.

- z = (close - SMA(lookback)) / std(lookback)
- vol = std of 1-bar log returns over `volBars` bars, scaled to a daily figure (sqrt(bars per day)), in %
- enter when z < -threshold and vol >= volMinPct
- exit when z > exitZ, or after `maxHoldBars` bars
Everything is decided at the bar close from candles up to and including that bar.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from ._base import _INTERVAL_MIN, bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "panic_bounce"
VERSION = 1
TITLE = "Panic dip bounce"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"lookback": 48, "threshold": 3.0, "volBars": 288, "volMinPct": 5.0, "exitZ": 0.0, "maxHoldBars": 48}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 6, "max": 500, "log": True,
                     "description": "candles in the average / standard deviation the dip is measured against"},
        "threshold": {"type": "float", "min": 1.5, "max": 5.0,
                      "description": "buy when the close is this many standard deviations below the average"},
        "volBars": {"type": "int", "min": 12, "max": 3000, "log": True,
                    "description": "candles in the trailing realized volatility"},
        "volMinPct": {"type": "float", "min": 1.0, "max": 15.0, "log": True,
                      "description": "only buy while the realized volatility (per day, %) is at least this"},
        "exitZ": {"type": "float", "min": -1.0, "max": 2.0,
                  "description": "sell when the z-score climbs back above this"},
        "maxHoldBars": {"type": "int", "min": 2, "max": 3000, "log": True,
                        "description": "sell anyway after this many candles"},
    }


def warmup(p: dict) -> int:
    return max(int(p["lookback"]), int(p["volBars"]) + 1)


def _bars_per_day(spec) -> float:
    return 1440.0 / _INTERVAL_MIN.get(spec.get("interval") or "5m", 5)


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    s = pd.Series(c)
    lb = int(p["lookback"])
    mean = s.rolling(lb, min_periods=lb).mean().to_numpy(np.float64)
    sd = s.rolling(lb, min_periods=lb).std(ddof=0).to_numpy(np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = (c - mean) / sd
    z[(sd == 0) & np.isfinite(mean)] = 0.0
    lr = np.log(s).diff()
    vb = int(p["volBars"])
    vol = (lr.rolling(vb, min_periods=vb).std(ddof=0) * math.sqrt(_bars_per_day(spec)) * 100).to_numpy(np.float64)
    ready = np.isfinite(z) & np.isfinite(vol)
    enter = (z < -float(p["threshold"])) & (vol >= float(p["volMinPct"]))
    leave = z > float(p["exitZ"])
    w_on, max_hold = max_weight(spec), int(p["maxHoldBars"])
    w = np.full(n, np.nan)
    enter_l, leave_l, ready_l = enter.tolist(), leave.tolist(), ready.tolist()
    pos, age, started = False, 0, False
    for i in range(n):
        if not started:
            if not ready_l[i]:
                continue
            started = True
        if pos:
            age += 1
            if leave_l[i] or age >= max_hold:
                pos = False
        elif ready_l[i] and enter_l[i]:
            pos, age = True, 0
        w[i] = w_on if pos else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": f"Buys sharp drops in {mk} only during panicky, very volatile markets and sells on the rebound.",
        "howItWorks": [
            f"It measures how wild the market is: the typical move of the last {bars_text(p['volBars'], iv)}, "
            f"expressed per day. It only trades when that is at least {p['volMinPct']} % per day (a panic).",
            f"In such a market it buys {mk} when the price falls more than {p['threshold']} standard deviations "
            f"below its average of the last {bars_text(p['lookback'], iv)}.",
            f"It sells when the price is back above that average (z-score above {p['exitZ']}) or after "
            f"{bars_text(p['maxHoldBars'], iv)}, whichever comes first.",
            *risk_steps(spec),
        ],
        "whenItWins": "Crashes with violent snap-backs: forced sellers push the price far down for minutes to hours "
                      "and it rebounds by more than the fees.",
        "whenItLoses": "Calm markets (it never trades, so it misses the long-term rise) and crashes that keep "
                       "falling after it buys.",
    }
