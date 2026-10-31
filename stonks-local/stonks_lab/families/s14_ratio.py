"""s14_ratio: the live book with ride sizes set by bitcoin's bull and by the coin against bitcoin.

The ratio is the coin's daily close in bitcoin. It is rising while its log stands above its ratio_days average. The first
idea, bigger rides while it rises and smaller while it falls, lost in every form tried. The numbers said the reverse: a
coin that already gained on bitcoin is late in its run. So a rising ratio trims the ride multiplier:

                  rising     falling
  bitcoin bull    top_size   4 (live)
  no bull         up_size    1 (live)

Bitcoin itself has no ratio and runs as the live book. Overheated coins still stop riding. Dips, banking and the crash buy
time stop are the live book's. Only completed earlier UTC days are read. BTC-EUR is cut at the coin's last bar.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import s9_cyclebull as _m
from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._s14_core import main_params, stopped

NAME = "s14_ratio"
VERSION = 1
TITLE = "Coin against bitcoin"
BOT_READY = False
MULTI_MARKET = False

_DAY = 86_400_000
_HOUR = 3_600_000
FLAT = 1e-4            # closer to the average than this reads as neutral: bitcoin against itself
_DIPS: dict = {}


def default_params() -> dict:
    return {"ratio_days": 140.0, "up_size": 0.75, "top_size": 3.5}


def param_space() -> dict:
    return {
        "ratio_days": {"type": "float", "min": 20.0, "max": 300.0, "description": "days in the average of the coin's price in bitcoin"},
        "up_size": {"type": "float", "min": 0.25, "max": 2.0, "description": "ride multiplier outside a bull while the coin rises against bitcoin"},
        "top_size": {"type": "float", "min": 1.0, "max": 6.0, "description": "ride multiplier in a bull while the coin rises against bitcoin"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(max(_m.warmup(main_params()) / 96, float(p["ratio_days"]) + 1) * 96)


def ratio_state(ts: np.ndarray, c: np.ndarray, days: float) -> np.ndarray:
    """+1 rising, -1 falling, 0 neutral per bar, from completed earlier UTC days of the coin and of bitcoin."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    bd, bc = _m._btc_daily(ts)
    out = np.zeros(len(ts))
    if len(bc) < 2 or len(dc) < 2:
        return out
    bpos = np.searchsorted(bd, dd, side="right") - 1
    ok = bpos >= 0
    lr = np.where(ok, np.log(dc) - np.log(bc[np.clip(bpos, 0, None)]), np.nan)
    s = pd.Series(lr).dropna()
    n = max(2, int(round(days)))
    e = s.ewm(span=n, adjust=False, min_periods=min(n, 120)).mean().reindex(range(len(lr))).to_numpy()
    x = lr - e
    day_state = np.where(np.isfinite(x), np.where(x > FLAT, 1.0, np.where(x < -FLAT, -1.0, 0.0)), 0.0)
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, day_state[np.clip(pos, 0, None)], 0.0)


def _breakout(lc, step, size, p, mul, bank):
    """s9_cyclebull's breakout ride with a multiplier and a bull banking flag per bar."""
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _m._ema(r * r, _m._bars(step, 24.0 * float(p["hvol_days"])))
    nh = _m._bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _m._bars(step, 24.0))
    give, tg = float(p["giveback"]), float(p["take_gain"])
    tf_bear, tf_bull, bgain, bgive = float(p["take_frac"]), float(p["bull_take"]), float(p["bull_gain"]), float(p["bull_give"])
    w = np.zeros(n)
    ride = level = 0
    peak = entry = sz = 0.0
    ll, hl, sl, zl, ml, bl = lc.tolist(), hi.tolist(), day_sd.tolist(), size.tolist(), mul.tolist(), bank.tolist()
    for i in range(n):
        if ride == 0:
            if hl[i] == hl[i] and ll[i] > hl[i] and zl[i] > 0:
                ride, peak, entry, level, sz = 1, ll[i], ll[i], 0, zl[i]
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - give * (bgive if bl[i] else 1.0) * sl[i]:
                ride = 0
            else:
                gi = tg * (bgain if bl[i] else 1.0)
                while level < 2 and peak - entry >= gi * (level + 1):
                    level += 1
        if ride:
            tf = tf_bull if bl[i] else tf_bear
            w[i] = np.floor(min(sz * ml[i], 1.0) * (1.0 - tf) ** level / _m.STEP + 1e-9) * _m.STEP
    return w


def _hourly_rides(df, ts, mp, p):
    """The two rides on completed 1-hour candles, as s9_cyclebull, with the ratio's sizes."""
    step = _m._step(ts)
    hr = ts // _HOUR
    g = df.groupby(hr)
    hdf = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    hts = hdf.index.to_numpy(np.int64) * _HOUR
    hdf.index = hts
    hc = hdf["close"].to_numpy(np.float64)
    hlc = np.log(np.maximum(hc, 1e-12))
    bull, hot = _m._regime(hts, hc, mp)
    st = ratio_state(hts, hc, float(p["ratio_days"]))
    mul = np.where(st > 0, np.where(bull, float(p["top_size"]), float(p["up_size"])), np.where(bull, float(mp["bull_size"]), 1.0))
    mul = np.where(hot, float(mp["hot_size"]), mul)
    bank = bull & ~hot
    n = len(hc)
    r = np.zeros(n)
    r[1:] = np.diff(hlc)
    vol = np.maximum(np.sqrt(_m._ema(r * r, _m._bars(float(_HOUR), 24.0 * _m.BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(_m._bars(float(_HOUR), 24.0 * 365.0))
    hb = _breakout(hlc, float(_HOUR), _m._q(float(mp["target_vol"]) / yearly), mp, mul, bank)
    ms = np.minimum(float(mp["s_macd"]), _m._q(float(mp["macd_vol"]) * mul / yearly))
    hm = _m._macd(hdf, hlc, float(_HOUR), mp) * ms
    gi = np.searchsorted(hdf.index.to_numpy(np.int64) // _HOUR, hr)
    closing = (ts + int(step)) >= (hr + 1) * _HOUR
    pos = np.where(closing, gi, gi - 1)
    okp = pos >= 0
    pc = np.clip(pos, 0, None)
    return np.where(okp, hb[pc], 0.0), np.where(okp, hm[pc], 0.0)


def _dips(df, mp):
    """The live dip layers, which the ratio does not touch: kept per candle set."""
    key = (len(df), int(df.index[0]), int(df.index[-1]), float(df["close"].iloc[-1]))
    if key not in _DIPS:
        if len(_DIPS) >= 24:
            _DIPS.clear()
        lw = _m.layer_weights(df, mp)
        _DIPS[key] = np.maximum(lw["snap"], lw["vdip"])
    return _DIPS[key]


def weights(df: pd.DataFrame, p: dict) -> np.ndarray:
    mp = main_params()
    ts = np.asarray(df.index, dtype=np.int64)
    if len(ts) < 3:
        return np.zeros(len(ts))
    hb, hm = _hourly_rides(df, ts, mp, p)
    w = np.maximum(np.maximum(hb, hm), _dips(df, mp))
    return stopped(df, np.clip(np.nan_to_num(w, nan=0.0), 0.0, 1.0))


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    return frame(df.index, {m: weights(df, spec["params"]) * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": f"The live book on {mk}, with somewhat smaller rides while the coin is already ahead of bitcoin.",
        "howItWorks": [f"The coin's daily close in bitcoin is compared with its {p['ratio_days']:g}-day average.",
                       f"While the coin is above that line, the rides are {p['top_size']:g} times their size in a bitcoin bull instead of 4, and {p['up_size']:g} times outside a bull instead of 1.",
                       "Under that line the rides are the live book's.",
                       "Dips, banking, the overheated stop and the crash buy time stop are as in the live book."] + risk_steps(spec),
        "whenItWins": "Coin rallies that top out after a long run ahead of bitcoin, where the smaller ride gives back less.",
        "whenItLoses": "Long stretches when a coin keeps leading bitcoin, as the rides stay smaller all the way.",
        "vsBuyHold": "Beats holding by staying out of most falls, like the live book.",
    }
