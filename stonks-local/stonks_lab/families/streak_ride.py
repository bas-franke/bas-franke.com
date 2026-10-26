"""streak_ride v1 (agent-17): buy after a run of consecutive up closes, ride it for a fixed number of candles.

Diagnostic behind it (agent-17, BTC/ETH 1d 2019-2025, pre-holdout): the first day a run of >= 5 consecutive up
closes appears is followed by ~+5 % more 20-day return than the year's average day, positive in most years on both
coins; 12h candles show nothing. Streaks are a momentum signal nobody in the lab had tested as an entry.

Per market (single market):
- up streak at t = number of consecutive candles up to t whose close is above the previous close.
- Enter (weight maxWeight) at the close of a candle whose up streak reaches ``streak`` (and, with ``trendSma`` > 0,
  close > SMA(trendSma)).
- While holding, a candle whose up streak is >= ``streak`` restarts the hold timer.
- Exit after ``hold`` candles without a restart, or earlier once ``exitDown`` consecutive down closes appear
  (0 = off).
Everything at bar t uses candles up to and including t (no look-ahead).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "streak_ride"
VERSION = 1
TITLE = "Up-streak ride"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"streak": 5, "hold": 20, "exitDown": 0, "trendSma": 0}


def param_space() -> dict:
    return {
        "streak": {"type": "int", "min": 2, "max": 9, "description": "consecutive up closes needed to buy"},
        "hold": {"type": "int", "min": 2, "max": 120, "log": True,
                 "description": "candles to hold after the last qualifying streak candle"},
        "exitDown": {"type": "int", "min": 2, "max": 6, "zero": True,
                     "description": "sell early after this many consecutive down closes (0 = off)"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                     "description": "only buy while the close is above this SMA (0 = no filter)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["streak"]), int(p.get("trendSma") or 0) - 1)


def state(close: np.ndarray, p: dict) -> np.ndarray:
    """1.0 hold / 0.0 out / NaN undecided, per candle."""
    n = len(close)
    out = np.full(n, np.nan)
    k, hold, xd = int(p["streak"]), int(p["hold"]), int(p.get("exitDown") or 0)
    tl = int(p.get("trendSma") or 0)
    sma = ind.sma(close, tl) if tl > 0 else None
    up = dn = 0
    left = 0
    first = warmup(p)
    for t in range(n):
        if t > 0:
            if close[t] > close[t - 1]:
                up, dn = up + 1, 0
            elif close[t] < close[t - 1]:
                up, dn = 0, dn + 1
            else:
                up, dn = 0, 0
        if t < first or (sma is not None and not np.isfinite(sma[t])):
            continue
        if left > 0:
            left -= 1
            if up >= k:
                left = hold
            elif xd and dn >= xd:
                left = 0
        elif up >= k and (sma is None or close[t] > sma[t]):
            left = hold
        out[t] = 1.0 if left > 0 else 0.0
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    s = state(df["close"].to_numpy(np.float64), spec["params"]) * max_weight(spec)
    return frame(np.asarray(df.index, dtype=np.int64), {m: s})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    steps = [
        f"It buys {market_names(spec)} after {int(p['streak'])} candles in a row each closed higher than the one "
        "before" + (f", but only while the price is above its {bars_text(p['trendSma'], iv)} average" if
                    int(p.get("trendSma") or 0) else "") + ".",
        f"It holds for {bars_text(p['hold'], iv)}; every new candle that extends the winning streak restarts that clock.",
    ]
    if int(p.get("exitDown") or 0):
        steps.append(f"It sells early after {int(p['exitDown'])} lower closes in a row.")
    return {
        "summary": "Buys after a run of rising days and rides the momentum for a few weeks.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Steady rallies where strong streaks keep coming.",
        "whenItLoses": "Choppy markets and long bull runs without clean streaks, where it sits in euros while the "
                       "price rises.",
    }
