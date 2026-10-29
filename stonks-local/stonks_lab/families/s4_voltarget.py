"""s4_voltarget: a trend sets the direction, realized volatility sets the size, deep dips get a rebound buy."""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s4_voltarget"
VERSION = 1
TITLE = "Volatility-sized trend"
BOT_READY = False
MULTI_MARKET = False

BASE_DAYS = 30.0   # how far back the "normal" volatility looks
STEP = 0.25        # sizes move in quarter steps, so small volatility wiggles do not trade


def default_params() -> dict:
    return {"trend_days": 18.0, "band": 0.4, "trail": 1.0, "target_vol": 0.6, "dip_hours": 50.0, "dip_z": 2.2}


def param_space() -> dict:
    return {
        "trend_days": {"type": "float", "min": 3.0, "max": 90.0, "description": "days in the trend average"},
        "band": {"type": "float", "min": 0.05, "max": 2.0,
                 "description": "how far above / below the trend average (in volatility units) price must go to switch"},
        "trail": {"type": "float", "min": 0.2, "max": 4.0,
                  "description": "fall from the high since entry (in volatility units) that ends a ride early"},
        "target_vol": {"type": "float", "min": 0.1, "max": 2.0,
                       "description": "yearly volatility a full position may carry; wilder coins get a smaller size"},
        "dip_hours": {"type": "float", "min": 6.0, "max": 240.0, "description": "hours in the short average a dip is measured against"},
        "dip_z": {"type": "float", "min": 0.5, "max": 5.0,
                  "description": "how deep under that average (in volatility units) price must fall to buy the rebound"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["trend_days"]), BASE_DAYS) * 96)


def _bars(index, days: float) -> int:
    idx = np.asarray(index, dtype=np.int64)
    step = float(np.median(np.diff(idx))) if len(idx) > 1 else 900_000.0
    return max(2, int(round(days * 86_400_000 / max(step, 1.0))))


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    return pd.Series(x).ewm(span=max(int(span), 1), adjust=False).mean().to_numpy(np.float64)


def _weights(df, trend_days, band, trail, target_vol, dip_hours, dip_z) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    w = np.full(n, np.nan)
    if n < 3:
        return w
    lc = np.log(c)
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    nt = _bars(df.index, trend_days)
    nb = _bars(df.index, dip_hours / 24.0)
    vol = np.maximum(np.sqrt(_ema(r * r, _bars(df.index, BASE_DAYS))), 1e-12)   # per-bar volatility
    scale = vol * np.sqrt(nt)
    dev = (lc - np.log(_ema(c, nt))) / scale
    yearly = vol * np.sqrt(_bars(df.index, 365.0))
    size = np.floor(np.clip(target_vol / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP
    z = (lc - np.log(_ema(c, nb))) / (vol * np.sqrt(nb))
    warm = _bars(df.index, max(trend_days, BASE_DAYS))
    up = rev = blocked = False
    peak = 0.0
    dl, zl, sl, ll, scl = dev.tolist(), z.tolist(), size.tolist(), lc.tolist(), scale.tolist()
    for i in range(warm, n):
        d = dl[i]
        if up:
            if ll[i] > peak:
                peak = ll[i]
            if d < -band or ll[i] < peak - trail * scl[i]:
                up = False
                blocked = d >= -band          # trail exit: wait for price to reset under the average
        else:
            if blocked and d < 0:
                blocked = False
            if d > band and not blocked:
                up, rev, peak = True, False, ll[i]
        if up:
            w[i] = sl[i]
            continue
        if rev:
            if zl[i] > 0:
                rev = False
        elif zl[i] < -dip_z:
            rev = True
        w[i] = 1.0 if rev else 0.0
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, float(p["trend_days"]), float(p["band"]), float(p["trail"]), float(p["target_vol"]),
                 float(p["dip_hours"]), float(p["dip_z"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Rides {mk} while it trades above its {p['trend_days']:g}-day average, with a size set by how wild the "
            f"coin is, and buys sharp dips back to a {p['dip_hours']:g}-hour average when out of the trend."
        ),
        "howItWorks": [
            "Volatility here means how much the price normally swings, measured over the last 30 days.",
            f"The trend is on when price is {p['band']:g} swing-units above its {p['trend_days']:g}-day average, "
            f"and off when it is {p['band']:g} units below.",
            f"A ride also ends when price falls {p['trail']:g} swing-units from its high since the buy. "
            "It then waits for price to dip under the average before a new ride can start.",
            f"While riding, the size is {p['target_vol']:g} divided by the coin's yearly volatility (at most all in, "
            "in quarter steps). A calm coin is held in full, a wild coin or a stormy stretch gets less.",
            f"Out of the trend, a fall of {p['dip_z']:g} swing-units under the {p['dip_hours']:g}-hour average buys "
            "all in, and it sells once price is back at that average.",
        ] + risk_steps(spec),
        "whenItWins": "Long steady climbs, and panic flushes that snap back within a day or two.",
        "whenItLoses": "Sideways stretches that cross the average again and again, and dips that keep falling after the buy.",
    }
