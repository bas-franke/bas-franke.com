"""s13_parabola: Bitcoin bull, cycle check with its size capped when a near-vertical rise starts to crack.

Speed = how far the close stands above its low of the last ``days`` days, in units of the coin's volatility over that
time. Once the speed passes ``sigmas``, the layer watches for ``hold_days`` days. If the close then falls ``crack`` daily
volatilities off its high, the multiplier is ``cap`` for the next ``hold_days`` days. All on completed UTC days.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import frame, market_names
from ._s13_core import trimmed

NAME = "s13_parabola"
VERSION = 1
TITLE = "Parabola cap"
BOT_READY = False
MULTI_MARKET = False
_DAY = 86_400_000


def default_params() -> dict:
    return {"days": 42.0, "sigmas": 2.5, "crack": 2.0, "hold_days": 14.0, "cap": 0.5, "vol_days": 90.0}


def param_space() -> dict:
    return {
        "days": {"type": "float", "min": 14.0, "max": 84.0, "step": 7.0, "label": "Length of the rise (days)"},
        "sigmas": {"type": "float", "min": 1.5, "max": 5.0, "step": 0.25, "label": "Steep above this many volatilities"},
        "crack": {"type": "float", "min": 0.5, "max": 6.0, "step": 0.5, "label": "Daily volatilities off the high that start the cap"},
        "hold_days": {"type": "float", "min": 3.0, "max": 45.0, "step": 1.0, "label": "Days the watch and the cap last"},
        "cap": {"type": "float", "min": 0.0, "max": 1.0, "step": 0.05, "label": "Share of the size while capped"},
        "vol_days": {"type": "float", "min": 30.0, "max": 180.0, "step": 10.0, "label": "Days of volatility history"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["days"]) + 1, 30.0) * 96)


def _capped_days(dc: np.ndarray, p: dict) -> np.ndarray:
    """True on each completed day after which the cap stands."""
    lc = pd.Series(np.log(dc))
    nd = max(2, int(round(float(p["days"]))))
    vd = max(5, int(round(float(p["vol_days"]))))
    vol = lc.diff().rolling(vd, min_periods=min(vd, 30)).std().to_numpy(np.float64)
    rise = (lc - lc.rolling(nd + 1, min_periods=nd + 1).min()).to_numpy(np.float64)
    steep = np.nan_to_num(rise / (vol * np.sqrt(nd)), nan=-9.0) >= float(p["sigmas"])
    hold, crack = max(1, int(round(float(p["hold_days"])))), float(p["crack"])
    out = np.zeros(len(dc), bool)
    armed, until, high = -1, -1, 0.0
    for i in range(len(dc)):
        if steep[i]:
            high = dc[i] if armed < i - hold else max(high, dc[i])
            armed = i
        if armed >= 0 and i - armed <= hold:
            high = max(high, dc[i])
            if vol[i] == vol[i] and np.log(high / dc[i]) >= crack * vol[i]:
                until = max(until, i + hold)
        out[i] = i <= until
    return out


def _trim(df, core, p) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    if len(dc) < 2:
        return np.ones(len(ts))
    flag = _capped_days(dc, p)
    pos = np.searchsorted(dd, d, side="left") - 1       # earlier UTC days only
    on = np.where(pos >= 0, flag[np.clip(pos, 0, None)], False)
    return np.where(on, float(p["cap"]), 1.0)


def targets(candles, spec, start_time=None):
    del start_time
    m, df, w = trimmed(candles, spec, _trim)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    days, hold = float(p["days"]), float(p["hold_days"])
    return {
        "summary": f"Bitcoin bull, cycle check on {mk}, with its size cut to {float(p['cap']) * 100:.0f} % for {hold:.0f} days "
                   f"when a near-vertical rise starts to crack.",
        "howItWorks": [
            "The main strategy decides every entry and exit. This layer can only make a position smaller.",
            f"Each day it measures how far the price stands above its {days:.0f}-day low, in units of the coin's own volatility.",
            f"Above {float(p['sigmas']):.1f} volatilities the rise counts as near-vertical, and the layer watches for {hold:.0f} days.",
            f"If the price then falls {float(p['crack']):.1f} daily volatilities off its high, every target is cut to "
            f"{float(p['cap']) * 100:.0f} % for {hold:.0f} days.",
            "The rise alone cuts nothing, so a healthy bull keeps its full size until the first real crack.",
        ],
        "whenItWins": "When a steep run breaks and the dip ladder would otherwise buy into the second leg, as in March 2020, September 2020 and May 2021.",
        "whenItLoses": "When a steep run dips and goes straight on up: the rebound is ridden at the smaller size. It does nothing in slow bleeds, which follow no steep rise.",
        "vsBuyHold": "Never holds more than Bitcoin bull, cycle check. Compared with holding it keeps that strategy's edge, minus some of the size in the weeks after a sharp top.",
    }
