"""s14_fewest: the live book rebuilt with as few settings as it can bear, all round or textbook numbers.

Same machine as s9_cyclebull plus the crash buy time stop. Gone for good: all banking of gains (four numbers), the MACD stretch
check, the trend that split the snap depth in two, the RSI exit and the full rung of the dip ladder. One number now does what
several did: `z` is the snap depth above and below the trend and also the speed of a fast fall; `days` is the breakout high and
the MACD (26, the textbook MACD); `vol` sizes both rides; bitcoin's exit average is half its bull average; the ride's giveback
reads the same 30-day swing that sizes it. 17 numbers against about 25 in the live book (32 counted the same way).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import s9_cyclebull as m
from ._base import frame, market_names, max_weight, single_market
from ._s14_core import main_params, stopped

NAME = "s14_fewest"
VERSION = 1
TITLE = "Fewest settings"
BOT_READY = False
MULTI_MARKET = False

NO_RUNG = 1e9          # a dip never reaches a second rung: its size is the first slice plus the speed bonus


def default_params() -> dict:
    return {
        "days": 26.0, "giveback": 2.5, "vol": 0.4,
        "snap_hours": 4.0, "swing_days": 100.0, "z": 4.0, "slow_hours": 48.0, "slow_z": 2.5, "first": 0.5,
        "btc_days": 160.0, "bull_size": 4.0, "cycle_days": 400.0, "hot": 1.3,
        "stop_hours": 6.0, "bounce": 0.05, "deep": 0.3, "deep_days": 10.0,
    }


def param_space() -> dict:
    return {
        "days": {"type": "float", "min": 10.0, "max": 60.0, "description": "days of the breakout's high and of the MACD ride"},
        "giveback": {"type": "float", "min": 1.0, "max": 8.0, "description": "the breakout ride ends this many daily swings below its peak"},
        "vol": {"type": "float", "min": 0.1, "max": 2.0, "description": "yearly volatility a normal ride may carry; wilder coins ride smaller"},
        "snap_hours": {"type": "float", "min": 1.0, "max": 12.0, "description": "hours of the snap sell-off"},
        "swing_days": {"type": "float", "min": 20.0, "max": 400.0, "description": "days that set the normal move of a snap"},
        "z": {"type": "float", "min": 1.5, "max": 8.0, "description": "normal moves that make a snap, and that count as a fast one-hour fall"},
        "slow_hours": {"type": "float", "min": 12.0, "max": 120.0, "description": "hours in the average the slow dip is measured against"},
        "slow_z": {"type": "float", "min": 1.0, "max": 5.0, "description": "volatility units under that average that buy the slow dip"},
        "first": {"type": "float", "min": 0.25, "max": 1.0, "description": "dip slice bought at a normal speed of fall"},
        "btc_days": {"type": "float", "min": 60.0, "max": 300.0, "description": "bitcoin's bull average; the exit average is half of it"},
        "bull_size": {"type": "float", "min": 1.0, "max": 5.0, "description": "how many times larger both rides are in a bitcoin bull"},
        "cycle_days": {"type": "float", "min": 200.0, "max": 1000.0, "description": "days in the slow average of the overheated check"},
        "hot": {"type": "float", "min": 0.5, "max": 3.0, "description": "log distance over that average where the rides stop"},
        "stop_hours": {"type": "float", "min": 1.0, "max": 48.0, "description": "hours a crash buy gets to bounce"},
        "bounce": {"type": "float", "min": 0.01, "max": 0.2, "description": "gain that counts as a bounce for a crash buy"},
        "deep": {"type": "float", "min": 0.1, "max": 0.6, "description": "fall under the recent best that makes a crash buy"},
        "deep_days": {"type": "float", "min": 2.0, "max": 30.0, "description": "days of that recent best"},
    }


def valid_params(p: dict) -> str | None:
    return None


def _main(p: dict) -> dict:
    return main_params({
        "high_days": float(p["days"]), "macd_days": float(p["days"]), "giveback": float(p["giveback"]), "hvol_days": m.BASE_DAYS,
        "target_vol": float(p["vol"]), "macd_vol": float(p["vol"]), "snap_hours": float(p["snap_hours"]),
        "snap_vol_days": float(p["swing_days"]), "fast_z": float(p["z"]), "vdip_hours": float(p["slow_hours"]),
        "vdip_z": float(p["slow_z"]), "ladder_first": float(p["first"]), "ladder_mult": NO_RUNG, "fast_gain": 1.0,
        "btc_days": float(p["btc_days"]), "btc_exit_days": float(p["btc_days"]) / 2.0, "bull_size": float(p["bull_size"]),
        "cycle_days": float(p["cycle_days"]), "cyc_hot": float(p["hot"]), "take_frac": 0.0, "bull_take": 0.0, "stretch": 0.0,
    })


def warmup(p: dict) -> int:
    return int(max(3 * float(p["days"]), float(p["swing_days"]), float(p["btc_days"]) + 1, float(p["deep_days"]), m.BASE_DAYS,
                   min(float(p["cycle_days"]), 120.0)) * 96)


def _snap(lc, step, fast, p, z) -> np.ndarray:
    """A fast fall of z normal moves over snap_hours buys; sold once price is above where it was snap_hours ago."""
    n = len(lc)
    per_hour = m._HOUR / step
    k = max(1, int(round(float(p["snap_hours"]) * per_hour)))
    span = max(2, int(round(float(p["snap_vol_days"]) * 24 * per_hour)))
    r1 = np.r_[np.nan, np.diff(lc)]
    sig = np.sqrt(pd.Series(r1 * r1).ewm(span=span, min_periods=span).mean().to_numpy())
    dk = np.full(n, np.nan)
    if n > k:
        dk[k:] = lc[k:] - lc[:-k]
    zs = dk / (sig * np.sqrt(k))
    first = float(p["ladder_first"])
    w = np.zeros(n)
    held = False
    size = 0.0
    for i, (zi, fi, di) in enumerate(zip(zs.tolist(), fast.tolist(), dk.tolist())):
        if zi == zi:
            if held and di > 0:
                held, size = False, 0.0
            elif zi < -z:
                held = True
                size = max(size, m._dip_size(-zi / z, fi, first, NO_RUNG, 1.0))
        w[i] = size if held else 0.0
    return w


def _weights(df: pd.DataFrame, params: dict) -> np.ndarray:
    p = _main(params)
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    if n < 3:
        return np.zeros(n)
    step = m._step(ts)
    lc = np.log(np.maximum(c, 1e-12))
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(m._ema(r * r, m._bars(step, 24.0 * m.BASE_DAYS))), 1e-12)
    per_hour = m._HOUR / step
    k1 = max(1, int(round(per_hour)))
    span = max(2, int(round(float(p["snap_vol_days"]) * 24 * per_hour)))
    sig = np.sqrt(pd.Series(r * r).ewm(span=span, min_periods=span).mean().to_numpy())
    d1 = np.full(n, np.nan)
    if n > k1:
        d1[k1:] = lc[k1:] - lc[:-k1]
    z1 = d1 / np.maximum(sig * np.sqrt(k1), 1e-12)
    fast = np.clip(np.nan_to_num(-z1, nan=0.0) / float(p["fast_z"]), 0.0, 2.0)
    bull, _hot = m._regime(ts, c, p)
    brk, mac = m._hourly_rides(df, ts, p)
    snap = _snap(lc, step, fast, p, float(params["z"]))
    vdip = m._vdip(c, lc, step, vol, fast, p, bull)
    w = np.clip(np.maximum.reduce([brk, mac, snap, vdip]), 0.0, 1.0)
    return stopped(df, w, {"hours": float(params["stop_hours"]), "gain": float(params["bounce"]), "deep": float(params["deep"]),
                           "deep_days": float(params["deep_days"])})


def targets(candles, spec, start_time=None):
    del start_time
    mk, df = single_market(candles, spec)
    return frame(df.index, {mk: _weights(df, spec["params"]) * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": f"The live book on {mk} with a third of its settings gone: the same rides, dips, bitcoin switch and time stop, and no banking of gains.",
        "howItWorks": [
            f"Two rides: a close above the {p['days']:g}-day high, and the {p['days']:g}-day MACD above zero. Both are sized {p['vol']:g} over the coin's yearly volatility.",
            f"The breakout ride ends {p['giveback']:g} daily swings under its peak. The MACD ride ends when it crosses under zero. Nothing is banked on the way.",
            f"While bitcoin closes above its {p['btc_days']:g}-day average and its {float(p['btc_days']) / 2:g}-day average, both rides are {p['bull_size']:g} times their size.",
            f"When the coin is far above its {p['cycle_days']:g}-day average (log distance {p['hot']:g}), the bull rides stop.",
            f"Snap dip: a {p['snap_hours']:g}-hour fall of {p['z']:g} normal moves buys. It sells once price is above where it was {p['snap_hours']:g} hours ago.",
            f"Slow dip: {p['slow_z']:g} volatility units under the {p['slow_hours']:g}-hour average buys. It sells back at that average.",
            f"A dip buys {float(p['first']) * 100:.0f} %, more when the last hour fell faster than {p['z']:g} normal moves, less when slower.",
            f"A buy made {float(p['deep']) * 100:.0f} % under the {p['deep_days']:g}-day best must bounce {float(p['bounce']) * 100:.0f} % within {p['stop_hours']:g} hours, or it is sold.",
        ],
        "whenItWins": "Big trends and panic bounces, like the live book.",
        "whenItLoses": "Sideways markets, and a coin falling hard while bitcoin still looks fine.",
        "vsBuyHold": "Beats holding by staying out of most falls.",
    }
