"""armed_exit v1 (agent-03, long lane): hold by default; the trend exit is only armed after a big run.

Why: SMA cores on BTC 1d win the crash folds (2021-22, 2025) but lose the steady bull folds (2023-05..2024-02) to
whipsaw under the average (findings #287, #324). alt_froth/froth_dip time the exit with an alt-season signal. This
family asks whether the coin's *own* froth is enough: the trend exit is switched on ("armed") only after the coin
gained at least ``armRet`` over ``armLook`` candles, and stays armed ``armKeep`` candles after the last such bar.
Outside that window the coin is simply held.

Per bar t (decided at the close, candles up to and including t only):
- froth bar: close[t] / close[t - armLook] - 1 >= armRet; armed while t - (last froth bar) <= armKeep.
- holding and armed and close < SMA(smaLen) * (1 - band): sell (weight 0).
- out: buy back when close > SMA(smaLen) * (1 + band), or (buyOnDisarm) as soon as the arm expires.
The first decision bar starts invested.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "armed_exit"
VERSION = 1
TITLE = "Hold, exit only after froth"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"armLook": 365, "armRet": 1.0, "armKeep": 365, "smaLen": 100, "band": 0.0, "buyOnDisarm": False}


def param_space() -> dict:
    return {
        "armLook": {"type": "int", "min": 30, "max": 600, "log": True,
                    "description": "candles over which the coin's run is measured"},
        "armRet": {"type": "float", "min": 0.1, "max": 3.0, "log": True,
                   "description": "arm the exit once the coin gained at least this much over armLook (1.0 = +100 %)"},
        "armKeep": {"type": "int", "min": 10, "max": 900, "log": True,
                    "description": "candles the exit stays armed after the last bar with such a gain"},
        "smaLen": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "trend average: while armed, sell below it; buy back above it"},
        "band": {"type": "float", "min": 0.0, "max": 0.06,
                 "description": "hysteresis: sell below SMA*(1-band), buy above SMA*(1+band)"},
        "buyOnDisarm": {"type": "bool", "description": "also buy back as soon as the exit is no longer armed"},
    }


def warmup(p: dict) -> int:
    return max(int(p["armLook"]), int(p["smaLen"]))


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    look, ret, keep = int(p["armLook"]), float(p["armRet"]), int(p["armKeep"])
    band = float(p.get("band") or 0.0)
    dis = bool(p.get("buyOnDisarm"))
    ma = ind.sma(c, int(p["smaLen"]))
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    start = min(warmup(p), n)
    last_froth = -10 ** 9
    holding = True
    for t in range(start, n):
        if c[t] / c[t - look] - 1.0 >= ret:
            last_froth = t
        armed = t - last_froth <= keep
        if holding:
            if armed and c[t] < ma[t] * (1 - band):
                holding = False
        else:
            if c[t] > ma[t] * (1 + band) or (dis and not armed):
                holding = True
        w[t] = mw if holding else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    band = float(p.get("band") or 0.0)
    steps = [
        f"It holds {mk} by default.",
        f"Only after {mk} rose at least {pct(float(p['armRet']))} within {bars_text(p['armLook'], iv)} (a frothy run) "
        f"does it watch for the end of the trend, for {bars_text(p['armKeep'], iv)} after the last such day.",
        f"While watching, it sells when the price closes "
        + (f"more than {pct(band)} below" if band else "below")
        + f" its {bars_text(p['smaLen'], iv)} average, and buys back when it closes back above it.",
    ]
    if p.get("buyOnDisarm"):
        steps.append("When the watch period ends it buys back in, whatever the average says.")
    return {
        "summary": f"Buy and hold {mk}, but after a big run up it sells when the trend breaks, to sidestep the "
                   "crash that usually follows a blow-off.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bear markets that follow a parabolic rally (2018, 2021-22 style): it is out for most of the fall.",
        "whenItLoses": "Pullbacks in a bull run that is still frothy (it sells and buys back higher), and crashes "
                       "that come without a big run first (it just holds through them).",
    }
