"""trend_bounce v1 (agent-06, multi-tf lane): a daily trend core plus intraday panic-dip bounces in the core's cash.

panic_bounce (agent-09) found the one minute-level edge that clears fees: buy a z < -3..-4 intraday dip only while
trailing realized volatility is extreme, sell on the rebound or after minutes to hours. It earns +1..+4 % per round
trip but sits in cash > 99 % of the time, so on its own it loses to buy and hold and is ineligible (finding #209).
This family puts it on top of a slow daily trend core so the money is invested in uptrends and the bounce trades
use the cash of the downtrends:

- core: completed daily closes (UTC days, built from the intraday candles) above their SMA(coreDays) -> weight
  coreWeight. The core only uses days that have closed, so it flips at most once a day (at the first bar after
  00:00 UTC). coreDays 0 = no core (pure panic_bounce).
- bounce (as panic_bounce): z = (close - SMA(lookback)) / std(lookback); vol = std of 1-bar log returns over
  volBars bars scaled to a day, in %. Enter when z < -threshold and vol >= volMinPct; exit when z > exitZ or after
  maxHoldBars bars. While a bounce trade is open the weight is the full maxWeight.

Target = maxWeight * min(1, coreWeight * core + bounce). Decisions at bar t use candles up to and including bar t.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from ._base import _INTERVAL_MIN, bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "trend_bounce"
VERSION = 1
TITLE = "Trend core plus panic bounces"
BOT_READY = False
MULTI_MARKET = False
_DAY = 86_400_000


def default_params() -> dict:
    return {"coreDays": 130, "coreWeight": 1.0, "lookback": 279, "threshold": 3.8, "volBars": 40,
            "volMinPct": 8.0, "exitZ": 1.0, "maxHoldBars": 8}


def param_space() -> dict:
    return {
        "coreDays": {"type": "int", "min": 20, "max": 400, "zero": True, "log": True,
                     "description": "hold while the last daily close is above its SMA over this many days (0 = no core)"},
        "coreWeight": {"type": "float", "min": 0.3, "max": 1.0,
                       "description": "share of the money the trend core holds (a bounce trade tops it up to 100 %)"},
        "lookback": {"type": "int", "min": 6, "max": 500, "log": True,
                     "description": "candles in the average / standard deviation the dip is measured against"},
        "threshold": {"type": "float", "min": 2.0, "max": 5.0,
                      "description": "buy when the close is this many standard deviations below the average"},
        "volBars": {"type": "int", "min": 12, "max": 3000, "log": True,
                    "description": "candles in the trailing realized volatility"},
        "volMinPct": {"type": "float", "min": 2.0, "max": 15.0, "log": True,
                      "description": "only buy dips while the realized volatility (per day, %) is at least this"},
        "exitZ": {"type": "float", "min": -1.0, "max": 2.0,
                  "description": "sell the bounce trade when the z-score climbs back above this"},
        "maxHoldBars": {"type": "int", "min": 2, "max": 3000, "log": True,
                        "description": "sell the bounce trade anyway after this many candles"},
    }


def warmup(p: dict) -> int:
    return max(int(p["lookback"]), int(p["volBars"]) + 1)


def _bars_per_day(spec) -> float:
    return 1440.0 / _INTERVAL_MIN.get(spec.get("interval") or "5m", 5)


def daily_core(ts: np.ndarray, close: np.ndarray, days: int) -> np.ndarray:
    """Per bar: 1.0 if the last COMPLETED UTC day's close is above the SMA of the last `days` completed daily closes,
    0.0 if not, NaN until `days` days have completed. The current (unfinished) day is never used."""
    n = len(ts)
    day = ts // _DAY
    last_of_day = np.ones(n, dtype=bool)
    last_of_day[:-1] = day[1:] != day[:-1]
    last_of_day[-1] = False  # the final bar's day may still be running: never treat it as closed
    d_keys = day[last_of_day]
    d_close = close[last_of_day]
    sma = pd.Series(d_close).rolling(days, min_periods=days).mean().to_numpy(np.float64)
    state = np.where(np.isfinite(sma), (d_close > sma).astype(np.float64), np.nan)
    # bar i may use completed days strictly before its own day
    pos = np.searchsorted(d_keys, day, side="left") - 1
    out = np.full(n, np.nan)
    ok = pos >= 0
    out[ok] = state[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    ts = np.asarray(df.index, dtype=np.int64)
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
    cd = int(p.get("coreDays") or 0)
    core = daily_core(ts, c, cd) if cd else np.zeros(n)
    ready = np.isfinite(z) & np.isfinite(vol) & np.isfinite(core)
    enter = (z < -float(p["threshold"])) & (vol >= float(p["volMinPct"]))
    leave = z > float(p["exitZ"])
    mw, cw, max_hold = max_weight(spec), float(p["coreWeight"]), int(p["maxHoldBars"])
    w = np.full(n, np.nan)
    enter_l, leave_l, ready_l, core_l = enter.tolist(), leave.tolist(), ready.tolist(), core.tolist()
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
        elif enter_l[i]:
            pos, age = True, 0
        cv = core_l[i] if core_l[i] == core_l[i] else 0.0
        w[i] = mw * min(1.0, cw * cv + (1.0 if pos else 0.0))
    return frame(ts, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    cd = int(p.get("coreDays") or 0)
    steps = []
    if cd:
        cw = float(p["coreWeight"])
        steps.append(f"Once a day it compares {mk}'s daily closing price with its average over the last {cd} days. "
                     f"While the price is above it, it keeps {cw * 100:.0f} % of the money in {mk} (the trend core).")
    steps += [
        f"Every {iv} candle it measures how wild the market is: the typical move of the last "
        f"{bars_text(p['volBars'], iv)}, per day. Only when that is at least {p['volMinPct']} % per day (a panic) "
        "does it look for a dip to buy.",
        f"In such a market it buys {mk} with all the money when the price falls more than {p['threshold']} "
        f"standard deviations below its average of the last {bars_text(p['lookback'], iv)}.",
        f"It sells that dip purchase when the price is back above that average (z-score above {p['exitZ']}) or "
        f"after {bars_text(p['maxHoldBars'], iv)}, whichever comes first; the trend core stays.",
    ]
    return {
        "summary": f"Rides {mk}'s daily uptrends and, in between, buys violent panic drops for a quick rebound.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long uptrends (the core holds) and crashes with sharp snap-backs (the bounce trades).",
        "whenItLoses": "Choppy markets around the daily average (the core whipsaws) and crashes that keep falling "
                       "after it buys.",
    }
