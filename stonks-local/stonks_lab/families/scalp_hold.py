"""scalp_hold v1: a minute-level entry signal with an enforced minimum holding time, optional maximum holding time,
a cooldown after every exit and an optional slow trend filter.

Built by agent-09 (scalp lane) to answer "how long must a minute-level trade be held before fees stop eating it?".
The entry signal is a z-score of the close against its SMA(lookback):

- momentum:  enter when z > threshold (price stretched upward), exit when z < 0
- reversion: enter when z < -threshold (price stretched downward), exit when z > 0
- breakout:  enter when the close beats the highest high of the previous `lookback` bars, exit when z < 0

An exit signal is only obeyed once the position is at least `minHoldBars` old; `maxHoldBars` (0 = off) forces an
exit; after an exit no new entry for `cooldownBars`. `trendSma` (0 = off) only allows entries while the close is
above that SMA. Everything is decided at the bar close from candles up to and including that bar.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "scalp_hold"
VERSION = 1
TITLE = "Minute signal with minimum holding time"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"signal": "momentum", "lookback": 60, "threshold": 2.0, "minHoldBars": 60, "maxHoldBars": 0,
            "cooldownBars": 0, "trendSma": 0}


def param_space() -> dict:
    return {
        "signal": {"type": "choice", "values": ["momentum", "reversion", "breakout"],
                   "description": "entry signal: z-score stretch up (momentum), stretch down (reversion) or new high"},
        "lookback": {"type": "int", "min": 5, "max": 3000, "log": True,
                     "description": "candles in the SMA / standard deviation / breakout window"},
        "threshold": {"type": "float", "min": 0.5, "max": 4.0,
                      "description": "z-score needed to enter (momentum/reversion)"},
        "minHoldBars": {"type": "int", "min": 1, "max": 20000, "log": True,
                        "description": "candles a position is held at least before an exit signal counts"},
        "maxHoldBars": {"type": "int", "min": 10, "max": 50000, "zero": True, "log": True,
                        "description": "force an exit after this many candles (0 = off)"},
        "cooldownBars": {"type": "int", "min": 1, "max": 5000, "zero": True, "log": True,
                         "description": "candles to wait after an exit before a new entry (0 = off)"},
        "trendSma": {"type": "int", "min": 100, "max": 50000, "zero": True, "log": True,
                     "description": "only enter while the close is above this SMA (0 = no filter)"},
    }


def valid_params(p: dict) -> str | None:
    if p["maxHoldBars"] and p["maxHoldBars"] <= p["minHoldBars"]:
        return "maxHoldBars must exceed minHoldBars"
    return None


def warmup(p: dict) -> int:
    return max(int(p["lookback"]), int(p["trendSma"] or 0))


def _roll(x: np.ndarray, n: int):
    s = pd.Series(x)
    r = s.rolling(n, min_periods=n)
    return r.mean().to_numpy(np.float64), r.std(ddof=0).to_numpy(np.float64)


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    h = df["high"].to_numpy(np.float64)
    n = len(c)
    lb = int(p["lookback"])
    mean, sd = _roll(c, lb)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = (c - mean) / sd
    z[(sd == 0) & np.isfinite(mean)] = 0.0
    sig = p["signal"]
    thr = float(p["threshold"])
    if sig == "momentum":
        enter, leave = z > thr, z < 0
    elif sig == "reversion":
        enter, leave = z < -thr, z > 0
    else:
        prior_hi = pd.Series(h).rolling(lb, min_periods=lb).max().shift(1).to_numpy(np.float64)
        enter, leave = c > prior_hi, z < 0
    ready = np.isfinite(z)
    if sig == "breakout":
        ready &= np.isfinite(prior_hi)
    ts = int(p["trendSma"] or 0)
    if ts:
        tsma = pd.Series(c).rolling(ts, min_periods=ts).mean().to_numpy(np.float64)
        ready &= np.isfinite(tsma)
        enter = enter & (c > tsma)
    w_on = max_weight(spec)
    min_hold, max_hold, cool = int(p["minHoldBars"]), int(p["maxHoldBars"] or 0), int(p["cooldownBars"] or 0)
    w = np.full(n, np.nan)
    enter_l, leave_l, ready_l = enter.tolist(), leave.tolist(), ready.tolist()
    pos = False
    age = 0
    wait = 0
    started = False
    for i in range(n):
        if not started:
            if not ready_l[i]:
                continue
            started = True
        if pos:
            age += 1
            if (age >= min_hold and leave_l[i]) or (max_hold and age >= max_hold):
                pos = False
                wait = cool
        else:
            if wait > 0:
                wait -= 1
            elif ready_l[i] and enter_l[i]:
                pos = True
                age = 0
        w[i] = w_on if pos else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    sig = p["signal"]
    if sig == "momentum":
        entry = (f"It buys {mk} when the price jumps more than {p['threshold']} standard deviations above its "
                 f"average of the last {bars_text(p['lookback'], iv)}, betting the move continues.")
        out = "Once the price falls back under that average, it sells."
    elif sig == "reversion":
        entry = (f"It buys {mk} when the price drops more than {p['threshold']} standard deviations below its "
                 f"average of the last {bars_text(p['lookback'], iv)}, betting it bounces back.")
        out = "Once the price is back above that average, it sells."
    else:
        entry = f"It buys {mk} when the price beats the highest price of the last {bars_text(p['lookback'], iv)}."
        out = "Once the price falls back under its average over the same window, it sells."
    steps = [entry,
             f"{out} But it always holds a position for at least {bars_text(p['minHoldBars'], iv)}, so it does not "
             "pay fees on every small wiggle."]
    if p["maxHoldBars"]:
        steps.append(f"It sells anyway after {bars_text(p['maxHoldBars'], iv)}.")
    if p["cooldownBars"]:
        steps.append(f"After selling it waits {bars_text(p['cooldownBars'], iv)} before buying again.")
    if p["trendSma"]:
        steps.append(f"It only buys while the price is above its average of the last {bars_text(p['trendSma'], iv)}.")
    steps += risk_steps(spec)
    return {
        "summary": f"Short-term trading of {mk} on {iv} candles with a forced minimum holding time to keep fees down.",
        "howItWorks": steps,
        "whenItWins": "When short moves keep going (momentum) or snap back (reversion) by clearly more than the "
                      "0.3-0.5 % that a buy plus a sell costs in fees.",
        "whenItLoses": "Most of the time at minute level: typical moves are smaller than the fees, so every trade "
                       "starts behind, and it is out of the market during part of the long-term rise.",
    }
