"""vol_target v1: position size = targetVol / realised volatility (ATR or stdev of log returns), capped at maxWeight,
rounded down to a step, optionally only while a trend filter (close > SMA) and/or time-series momentum
(return over momLookback > 0) agree; otherwise cash. Everything is computed from candles up to and including bar t."""
from __future__ import annotations

import math

import numpy as np

from .. import indicators as ind
from ._base import _INTERVAL_MIN, bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "vol_target"
VERSION = 1
TITLE = "Volatility targeting"
BOT_READY = False
MULTI_MARKET = False

_MIN_PER_YEAR = 365.0 * 24 * 60


def default_params() -> dict:
    return {"volMethod": "stdev", "volLookback": 60, "targetVol": 0.5, "step": 0.1, "trendSma": 0,
            "momLookback": 0}


def param_space() -> dict:
    return {
        "volMethod": {"type": "choice", "values": ["stdev", "atr"],
                      "description": "volatility estimate: stdev of log returns or ATR / close"},
        "volLookback": {"type": "int", "min": 5, "max": 500, "log": True,
                        "description": "candles in the volatility estimate"},
        "targetVol": {"type": "float", "min": 0.1, "max": 2.0, "log": True,
                      "description": "annualised volatility the position aims for (0.5 = 50 %/yr)"},
        "step": {"type": "choice", "values": [0.05, 0.1, 0.2, 0.25, 0.5],
                 "description": "weights are rounded down to multiples of this (fewer small rebalances)"},
        "trendSma": {"type": "int", "min": 10, "max": 500, "zero": True, "log": True,
                     "description": "only hold while the close is above this SMA (0 = off)"},
        "momLookback": {"type": "int", "min": 5, "max": 500, "zero": True, "log": True,
                        "description": "only hold while the return over this many candles is positive (0 = off)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["volLookback"]), int(p["trendSma"]), int(p["momLookback"]))


def _bars_per_year(interval) -> float:
    return _MIN_PER_YEAR / _INTERVAL_MIN.get(interval or "4h", 240)


def realised_vol(df, p: dict, interval) -> np.ndarray:
    """Annualised volatility estimate at every bar (NaN until enough bars)."""
    c = df["close"].to_numpy(np.float64)
    n = int(p["volLookback"])
    if p["volMethod"] == "atr":
        a = ind.atr(df["high"].to_numpy(np.float64), df["low"].to_numpy(np.float64), c, n)
        per_bar = a / c
    else:
        lr = np.full(c.shape, np.nan)
        lr[1:] = np.log(c[1:] / c[:-1])
        per_bar = np.full(c.shape, np.nan)
        if len(c) > n:
            per_bar[n:] = ind.std_pop(lr[1:], n)[n - 1:]
    return per_bar * math.sqrt(_bars_per_year(interval))


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    vol = realised_vol(df, p, spec.get("interval"))
    mw = max_weight(spec)
    with np.errstate(divide="ignore", invalid="ignore"):
        raw = np.minimum(mw, float(p["targetVol"]) / vol)
    step = float(p["step"])
    w = np.floor(raw / step + 1e-9) * step
    w = np.minimum(w, mw)
    ok = np.isfinite(vol) & (vol > 0)
    if p["trendSma"]:
        s = ind.sma(c, int(p["trendSma"]))
        ok &= np.isfinite(s)
        w = np.where(c > s, w, 0.0)
    if p["momLookback"]:
        k = int(p["momLookback"])
        prev = np.full(c.shape, np.nan)
        prev[k:] = c[:-k]
        ok &= np.isfinite(prev)
        w = np.where(c > prev, w, 0.0)
    w = np.where(ok, w, np.nan)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    est = ("the average true range (typical candle size) as a share of the price"
           if p["volMethod"] == "atr" else "the standard deviation of the candle-to-candle returns")
    steps = [
        f"After every {iv} candle it measures how wild {mk} has been: {est} over the last "
        f"{bars_text(p['volLookback'], iv)}, scaled to a yearly figure.",
        f"It holds {mk} in proportion to how calm it is: target {pct(p['targetVol'])} a year divided by the measured "
        f"volatility. When {mk} swings twice as hard, it holds half as much; the rest stays in euros.",
        f"The size is rounded down to steps of {pct(p['step'])} so it does not trade on tiny changes.",
    ]
    if p["trendSma"]:
        steps.append(f"It only holds while the price is above its average of the last {bars_text(p['trendSma'], iv)};"
                     " below it, everything goes to euros.")
    if p["momLookback"]:
        steps.append(f"It only holds while the price is higher than {bars_text(p['momLookback'], iv)} ago.")
    return {
        "summary": f"Holds {mk} with a size that shrinks when the market gets wild and grows when it is calm"
                   + (", and only while the trend is up." if p["trendSma"] or p["momLookback"] else "."),
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Crashes usually come with exploding volatility: it is already smaller when the big drops "
                      "hit, so drawdowns are shallower than holding.",
        "whenItLoses": "Fast rallies out of a volatile bottom: it is underweight exactly when the price rockets, so it "
                       "usually trails buy and hold in strong bull markets, and every rebalance costs fees.",
    }
