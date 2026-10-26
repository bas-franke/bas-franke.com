"""macd_days v1 (agent-19, invent lane): MACD trend with lengths in days instead of candles, plus a hysteresis band.

Why: the best result in the lab is macd_trend on ETH 1d with a very slow MACD (fast ~9-12, slow ~180-195, signal
30-40 days). macd_trend measures lengths in candles and caps slow at 200, so the same wall-clock signal cannot be
tested on 4h/6h/12h bars (it would need slow ~1100/730/365 candles). Here every length is given in days and turned
into candles for the spec's interval, so one parameter set means the same signal on every bar size. That lets us check
whether the ETH 1d edge is a property of the signal (it should survive 12h/6h/4h/1W) or of one daily bar grid.

Rule per market, decided at each bar's close:
- line = EMA(close, fast) - EMA(close, slow), sig = EMA(line, signal), h = (line - sig) / close.
- band = 0: in while line > sig (exactly macd_trend's rule).
- band > 0: get in when h > band, get out when h < -band, otherwise keep the previous state (fewer whipsaw flips).
- requirePositive: additionally only in while line > 0.
Multi-market: each market gets share = maxWeight / number of markets and decides on its own candles.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import _INTERVAL_MIN, frame, market_names, max_weight, pct, risk_steps

NAME = "macd_days"
VERSION = 1
TITLE = "MACD trend (lengths in days)"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"fastDays": 12, "slowDays": 182, "signalDays": 35, "band": 0.0, "requirePositive": False}


def param_space() -> dict:
    return {
        "fastDays": {"type": "int", "min": 1, "max": 60, "log": True, "description": "fast EMA length in days"},
        "slowDays": {"type": "int", "min": 10, "max": 400, "log": True, "description": "slow EMA length in days"},
        "signalDays": {"type": "int", "min": 2, "max": 120, "log": True,
                       "description": "signal EMA length in days (smooths the MACD line)"},
        "band": {"type": "float", "min": 0.001, "max": 0.05, "log": True, "zero": True,
                 "description": "hysteresis: buy when (MACD - signal) is this fraction of the price above zero, "
                                "sell when it is this fraction below (0 = plain cross)"},
        "requirePositive": {"type": "bool", "description": "only hold while the MACD line is above zero"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["fastDays"] < p["slowDays"] else "fastDays must be shorter than slowDays"


def to_bars(days: float, interval: str | None) -> int:
    mins = _INTERVAL_MIN.get(interval or "1d", 1440)
    return max(1, int(round(float(days) * 1440.0 / mins)))


def lengths(p: dict, interval: str | None) -> tuple[int, int, int]:
    f, s, g = to_bars(p["fastDays"], interval), to_bars(p["slowDays"], interval), to_bars(p["signalDays"], interval)
    if f >= s:  # only possible on very coarse bars (1W with fast and slow within half a week)
        s = f + 1
    return f, s, g


def warmup(p: dict) -> int:
    """In daily candles (the reference interval); multiply by candles per day for finer bars."""
    return int(p["slowDays"]) + int(p["signalDays"]) - 2


def state(close: np.ndarray, p: dict, interval: str | None) -> np.ndarray:
    """0/1 per bar (NaN before the MACD signal exists)."""
    f, s, g = lengths(p, interval)
    line, sig, _ = ind.macd(close, f, s, g)
    ok = np.isfinite(line) & np.isfinite(sig)
    band = float(p.get("band") or 0.0)
    n = len(close)
    out = np.full(n, np.nan)
    if band <= 0:
        on = line > sig
    else:
        h = np.where(ok, (line - sig) / close, 0.0).tolist()
        okl = ok.tolist()
        on = np.zeros(n, dtype=bool)
        inside = False
        for i in range(n):
            if not okl[i]:
                continue
            if not inside and h[i] > band:
                inside = True
            elif inside and h[i] < -band:
                inside = False
            on[i] = inside
    if p.get("requirePositive"):
        on = on & (line > 0)
    out[ok] = on[ok].astype(np.float64)
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("macd_days needs at least one market")
    share = max_weight(spec) / len(markets)
    series, index = {}, None
    for m in markets:
        df = candles[m]
        w = state(df["close"].to_numpy(np.float64), p, spec.get("interval")) * share
        idx = np.asarray(df.index, dtype=np.int64)
        series[m] = pd.Series(w, index=idx)
        index = idx if index is None else np.union1d(index, idx)
    cols = {m: s.reindex(index).ffill().to_numpy(np.float64) for m, s in series.items()}
    out = frame(index, cols)
    out.iloc[out.isna().any(axis=1).to_numpy(), :] = np.nan
    return out


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    n = len(spec.get("markets") or []) or 1
    steps = [
        f"After every {iv} candle it computes the MACD line of {mk}: the {p['fastDays']}-day average price minus the "
        f"{p['slowDays']}-day average (both exponential).",
        f"It smooths that line over {p['signalDays']} days: the signal line. When the MACD line is above the signal "
        "line, the long-term trend is gaining strength.",
    ]
    if p.get("band"):
        steps.append(f"It only buys once the MACD line is above the signal line by {pct(p['band'])} of the price, and "
                     f"only sells once it is {pct(p['band'])} below it, so small wiggles around the crossing don't "
                     "cause trades.")
    else:
        steps.append("It holds while the MACD line is above the signal line and sits in euros otherwise.")
    if p.get("requirePositive"):
        steps.append("Extra filter: it only holds while the short average is above the long one (MACD above zero).")
    if n > 1:
        steps.append(f"Each of the {n} coins gets an equal {pct(1 / n)} slice of the money and follows its own signal.")
    return {
        "summary": f"A slow momentum strategy on {mk}: it holds while the months-long trend is strengthening and "
                   "sits in euros when it fades.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Big multi-month bull runs and long bear markets (it is out for most of the decline).",
        "whenItLoses": "Sideways years and sharp V-shaped reversals: it buys late and sells late.",
    }
