"""s14_onetrend: the live book with its two rides folded into one.

The live book has a breakout ride and a MACD ride, each with its own size, banking steps and settings. Here they are two
ways into a single ride: the ride is on while either signal is on, it has one size (target_vol over the coin's yearly
volatility, times bull_size in a bitcoin bull, nothing while overheated) and it banks nothing. Gone: take_gain, take_frac,
bull_take, bull_gain and macd_vol. Dips, bitcoin bull, cycle ceiling and the time stop are the live ones, with a few settings
rounded. Dropping either signal altogether scores worse: 61.4 with the MACD alone, 55.1 with the breakout alone.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import s13_timestop, s9_cyclebull as s9
from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._s14_core import stopped

NAME = "s14_onetrend"
VERSION = 1
TITLE = "One trend ride"
BOT_READY = False
MULTI_MARKET = False

_HOUR = s9._HOUR
_STOP = ("hours", "gain", "deep", "deep_days")
_MAIN = ("high_days", "giveback", "hvol_days", "target_vol", "macd_days", "stretch", "bull_size", "btc_days", "btc_exit_days",
         "cycle_days", "cyc_hot", "snap_hours", "snap_vol_days", "z_up", "z_down", "snap_trend_days", "exit_rsi", "vdip_hours",
         "vdip_z", "ladder_first", "ladder_mult", "fast_gain", "fast_z")
_DIP_KEYS = ("snap_hours", "snap_vol_days", "z_up", "z_down", "snap_trend_days", "exit_rsi", "vdip_hours", "vdip_z", "ladder_first",
             "ladder_mult", "fast_gain", "fast_z", "btc_days", "btc_exit_days", "cyc_hot", "cycle_days")
_DIPS: dict = {}


def default_params() -> dict:
    return {
        "high_days": 27.0, "giveback": 4.0, "hvol_days": 10.0, "target_vol": 0.4, "macd_days": 26.0, "stretch": 1.0,
        "bull_size": 4.0, "btc_days": 140.0, "btc_exit_days": 80.0, "cycle_days": 450.0, "cyc_hot": 1.3,
        "snap_hours": 4.0, "snap_vol_days": 60.0, "z_up": 3.0, "z_down": 4.5, "snap_trend_days": 60.0, "exit_rsi": 50.0,
        "vdip_hours": 48.0, "vdip_z": 2.2, "ladder_first": 0.5, "ladder_mult": 1.25, "fast_gain": 1.0, "fast_z": 4.0,
        "hours": 6.0, "gain": 0.05, "deep": 0.3, "deep_days": 10.0,
    }


def param_space() -> dict:
    live, stop = s9.param_space(), s13_timestop.param_space()
    out = {k: dict(live[k]) for k in _MAIN}
    out["target_vol"]["description"] = "yearly volatility the ride may carry; wilder coins ride smaller"
    for k in _STOP:
        out[k] = {"type": "float", "min": stop[k]["min"], "max": stop[k]["max"], "description": stop[k]["label"]}
    return out


def valid_params(p: dict) -> str | None:
    return None


def _full(p: dict) -> dict:
    """The live main strategy's settings with this book's on top (everything not listed here is off in the live book too)."""
    return {**s9.default_params(), **{k: p[k] for k in _MAIN}}


def warmup(p: dict) -> int:
    return s9.warmup(_full(p))


def _dips(df, p) -> np.ndarray:
    """The live snap and slow dip layers (the larger of the two)."""
    ts = np.asarray(df.index, dtype=np.int64)
    key = (len(df), int(ts[0]), int(ts[-1]), float(df["close"].iloc[-1]), json.dumps([float(p[k]) for k in _DIP_KEYS]))
    if key in _DIPS:
        return _DIPS[key]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    step = s9._step(ts)
    lc = np.log(np.maximum(c, 1e-12))
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(s9._ema(r * r, s9._bars(step, 24.0 * s9.BASE_DAYS))), 1e-12)
    per_hour = _HOUR / step
    k1 = max(1, int(round(per_hour)))
    span = max(2, int(round(float(p["snap_vol_days"]) * 24 * per_hour)))
    sig = np.sqrt(pd.Series(r * r).ewm(span=span, min_periods=span).mean().to_numpy())
    d1 = np.full(n, np.nan)
    if n > k1:
        d1[k1:] = lc[k1:] - lc[:-k1]
    z1 = d1 / np.maximum(sig * np.sqrt(k1), 1e-12)
    fast = np.clip(np.nan_to_num(-z1, nan=0.0) / float(p["fast_z"]), 0.0, 2.0)
    bull, _ = s9._regime(ts, c, p)
    out = np.maximum(s9._snap(ts, c, lc, step, fast, p, bull), s9._vdip(c, lc, step, vol, fast, p, bull))
    if len(_DIPS) >= 60:
        _DIPS.clear()
    _DIPS[key] = out
    return out


def _hours(df):
    """Completed UTC hours built from the bars, and for each bar the last hour it may know."""
    ts = np.asarray(df.index, dtype=np.int64)
    hr = ts // _HOUR
    g = df.groupby(hr)
    h = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                      "close": g["close"].last(), "volume": g["volume"].sum()})
    idx = h.index.to_numpy(np.int64)
    h.index = idx * _HOUR
    gi = np.searchsorted(idx, hr)
    closing = (ts + int(s9._step(ts))) >= (hr + 1) * _HOUR
    return h, np.where(closing, gi, gi - 1)


def _breakout_on(lc, p) -> np.ndarray:
    """True from a close above the highest close of high_days until price is giveback daily swings under its best since."""
    step = float(_HOUR)
    r = np.diff(lc, prepend=lc[0])
    day_sd = np.sqrt(s9._ema(r * r, s9._bars(step, 24.0 * float(p["hvol_days"]))) * 24)
    nh = s9._bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    give = float(p["giveback"])
    st = np.zeros(len(lc), bool)
    on = False
    peak = 0.0
    for i, (x, top, sd) in enumerate(zip(lc.tolist(), hi.tolist(), day_sd.tolist())):
        if not on:
            if top == top and x > top:
                on, peak = True, x
        else:
            peak = max(peak, x)
            if x < peak - give * sd:
                on = False
        st[i] = on
    return st


def _size(hc, hts, p) -> np.ndarray:
    """target_vol over yearly volatility, times bull_size in a bull, nothing overheated; in quarters, at most all in."""
    step = float(_HOUR)
    lc = np.log(np.maximum(hc, 1e-12))
    r = np.zeros(len(lc))
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(s9._ema(r * r, s9._bars(step, 24.0 * s9.BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(s9._bars(step, 24.0 * 365.0))
    bull, hot = s9._regime(hts, hc, p)
    return s9._q(float(p["target_vol"]) * np.where(hot, 0.0, np.where(bull, float(p["bull_size"]), 1.0)) / yearly)


def _ride(df, p) -> np.ndarray:
    h, pos = _hours(df)
    hc = h["close"].to_numpy(np.float64)
    lc = np.log(np.maximum(hc, 1e-12))
    on = _breakout_on(lc, p) | (s9._macd(h, lc, float(_HOUR), p) > 0)
    w = _size(hc, h.index.to_numpy(np.int64), p) * on
    return np.where(pos >= 0, w[np.clip(pos, 0, None)], 0.0)


def _weights(df, params) -> np.ndarray:
    p = _full(params)
    w = np.clip(np.maximum(_ride(df, p), _dips(df, p)), 0.0, 1.0)
    return stopped(df, w, {k: float(params[k]) for k in _STOP})


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    return frame(df.index, {m: _weights(df, spec["params"]) * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (f"The live book on {mk} with one trend ride instead of two: on while a breakout or the MACD says so, "
                    "one size, nothing banked on the way up."),
        "howItWorks": [
            f"The ride is on while either signal is on. Breakout: a close above the highest close of {p['high_days']:g} days, "
            f"until price is {p['giveback']:g} daily swings under its best since. MACD: the {p['macd_days']:g}-day MACD turns "
            f"positive, until it crosses under zero after reaching {p['stretch']:g}.",
            f"One size: {p['target_vol']:g} divided by the coin's yearly volatility, {p['bull_size']:g} times that in a bitcoin "
            "bull, at most all in. Nothing is sold on the way up.",
            f"Bitcoin bull: bitcoin's daily close above its {p['btc_days']:g}-day average, until it closes under that or its "
            f"{p['btc_exit_days']:g}-day average.",
            f"Overheated: the ride stops while the coin is more than {np.exp(float(p['cyc_hot'])):.1f} times its "
            f"{p['cycle_days']:g}-day average.",
            "Panic dips are bought as in the live book, and a crash buy that does not bounce within "
            f"{p['hours']:g} hours is sold.",
            "The book holds the larger of the ride and the dips.",
        ] + risk_steps(spec),
        "whenItWins": "Long market-wide rises, and panic falls that snap back within hours.",
        "whenItLoses": "Sideways markets that switch the MACD on and off, and a coin that falls while bitcoin still looks fine.",
        "vsBuyHold": "Beats holding mostly by being out of the long falls; it earns about as much as the live book with fewer settings.",
    }
