"""s15_recovery: s15_start plus a comeback ride (new 50-day high after a 40 % drawdown). s15_start is: the live book, but a ride that starts far above the coin's own average must first prove itself.

The trades behind the 2024 and 2025-26 slow bleeds on ether had one thing in common with the worst rides on every coin, in
both eras: all-in rides started when the coin had already run far above its average. Stretch = log(the coin's last
completed daily close / its ext_days daily EMA). A breakout or MACD ride that starts in a bitcoin bull with a positive
stretch holds nothing until price is need_k x stretch above where the signal came. From then on it is the normal ride,
and it stays in if price slips back. Dip buys, the time stop and rides that start level with the average are as in the live
book. The breakout's giveback is 3 daily swings instead of 3.9.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import s9_cyclebull as s9
from ._base import frame, market_names, max_weight, single_market
from ._s14_core import main_params, stopped

NAME = "s15_recovery"
VERSION = 1
TITLE = "Comeback ride"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
STEP = 0.25


def default_params() -> dict:
    return {"ext_days": 100.0, "need_k": 0.25, "giveback": 3.0, "own_vol": 0.5, "own_cap": 0.5}


def param_space() -> dict:
    return {
        "ext_days": {"type": "float", "min": 30.0, "max": 300.0, "description": "days in the coin's daily average that sets how stretched it is"},
        "need_k": {"type": "float", "min": 0.0, "max": 2.0, "description": "share of the stretch a new ride must gain before it holds anything"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the breakout ride ends this many daily swings below its peak"},
        "own_vol": {"type": "float", "min": 0.2, "max": 2.0, "description": "yearly risk the comeback ride aims for"},
        "own_cap": {"type": "float", "min": 0.25, "max": 1.0, "description": "most the comeback ride may hold"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(max(s9.warmup(main_params()) / 96, float(p["ext_days"]) + 1, 400.0) * 96)


def _need(ts: np.ndarray, c: np.ndarray, bull: np.ndarray, p: dict) -> np.ndarray:
    """Log gain a ride must show before it holds anything, if it starts on this bar. From completed earlier UTC days."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    x = np.log(dc) - np.log(pd.Series(dc).ewm(span=max(2, int(round(float(p["ext_days"])))), adjust=False).mean().to_numpy())
    pos = np.searchsorted(dd, d, side="left") - 1
    stretch = np.where(pos >= 0, x[np.clip(pos, 0, None)], 0.0)
    return np.where(bull, float(p["need_k"]) * np.maximum(stretch, 0.0), 0.0)


def _breakout(lc, step, size, p, bull, hot, need) -> np.ndarray:
    """s9_cyclebull's breakout ride, with the wait at its start."""
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = s9._ema(r * r, s9._bars(step, 24.0 * float(p["hvol_days"])))
    nh = s9._bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * s9._bars(step, 24.0))
    give, tg = float(p["giveback"]), float(p["take_gain"])
    tf_bear, tf_bull, bgain = float(p["take_frac"]), float(p["bull_take"]), float(p["bull_gain"])
    bmul, bgive, smul = float(p["bull_size"]), float(p["bull_give"]), float(p["bear_size"])
    hmul, hgive = float(p["hot_size"]), float(p["hot_give"])
    mul_l = np.where(hot, hmul, np.where(bull, bmul, smul)).tolist()
    w = np.zeros(n)
    ride = level = 0
    peak = entry = sz = nd = 0.0
    ll, hl, sl, zl, kl = lc.tolist(), hi.tolist(), day_sd.tolist(), size.tolist(), need.tolist()
    bl = (bull & ~hot).tolist()
    hl2 = hot.tolist()
    for i in range(n):
        if ride == 0:
            if hl[i] == hl[i] and ll[i] > hl[i] and zl[i] > 0:
                ride, peak, entry, level, sz, nd = 1, ll[i], ll[i], 0, zl[i], kl[i]
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - give * (bgive if bl[i] else (hgive if hl2[i] else 1.0)) * sl[i]:
                ride = 0
            else:
                gi = tg * (bgain if bl[i] else 1.0)
                while level < 2 and peak - entry >= gi * (level + 1):
                    level += 1
        if ride and peak - entry >= nd:
            tf = tf_bull if bl[i] else tf_bear
            w[i] = np.floor(min(sz * mul_l[i], 1.0) * (1.0 - tf) ** level / STEP + 1e-9) * STEP
    return w


def _macd_wait(held: np.ndarray, need: np.ndarray, lc: np.ndarray) -> np.ndarray:
    """The MACD ride's on/off, off until a ride that started stretched has gained what it needed."""
    out = np.zeros(len(held))
    on = False
    entry = nd = 0.0
    for i, (h, ni, x) in enumerate(zip(held.tolist(), need.tolist(), lc.tolist())):
        if h <= 0:
            on = False
        elif not on:
            on, entry, nd = True, x, ni
        if on and x - entry >= nd:
            nd = -1.0                 # proved: stays in even if price slips back
        out[i] = 1.0 if on and nd < 0 else 0.0
    return out


def _rides(df, ts, c, lc, step, p, bull, hot):
    n = len(c)
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(s9._ema(r * r, s9._bars(step, 24.0 * s9.BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(s9._bars(step, 24.0 * 365.0))
    size = s9._q(float(p["target_vol"]) / yearly)
    need = _need(ts, c, bull, p)
    brk = _breakout(lc, step, size, p, bull, hot, need)
    mult = np.where(hot, float(p["hot_size"]), np.where(bull, float(p["bull_size"]), float(p["bear_size"])))
    ms = np.minimum(float(p["s_macd"]), s9._q(float(p["macd_vol"]) * mult / yearly))
    return brk, _macd_wait(s9._macd(df, lc, step, p), need, lc) * ms


def _hourly(df, ts, p):
    """The rides on completed 1-hour candles, held until the next hour closes (as s9_cyclebull)."""
    step = s9._step(ts)
    hr = ts // _HOUR
    g = df.groupby(hr)
    hdf = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    hts = hdf.index.to_numpy(np.int64) * _HOUR
    hdf.index = hts
    hc = hdf["close"].to_numpy(np.float64)
    hb, hm = _rides(hdf, hts, hc, np.log(np.maximum(hc, 1e-12)), float(_HOUR), p, *s9._regime(hts, hc, p))
    gi = np.searchsorted(hdf.index.to_numpy(np.int64) // _HOUR, hr)
    closing = (ts + int(step)) >= (hr + 1) * _HOUR
    pos = np.where(closing, gi, gi - 1)
    okp = pos >= 0
    pc = np.clip(pos, 0, None)
    return np.where(okp, hb[pc], 0.0), np.where(okp, hm[pc], 0.0)


HI_DAYS = 30     # round, untuned: new 30-day closing high
LO_DAYS = 20     # round, untuned: exit under the 20-day low
DEPTH = 0.8      # round, untuned: the coin was 20 % under its 1-year high
PAST = 180       # round, untuned: the deep drop happened within the last 180 days
YEAR = 365


def _own(df: pd.DataFrame, ts: np.ndarray, p: dict) -> np.ndarray:
    """Comeback ride, bitcoin-free: after the coin fell 20 %+ under its 1-year high within the last 180 days, a completed daily
    close above the highest close of the 30 days before opens a ride; a close under the lowest close of the 20 days before ends it.
    Held on the following day's bars, sized by the coin's volatility."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd = d[last]
    dc = df["close"].to_numpy(np.float64)[last]
    s = pd.Series(dc)
    hi = s.rolling(HI_DAYS, min_periods=HI_DAYS).max().shift(1).to_numpy()
    lo = s.rolling(LO_DAYS, min_periods=LO_DAYS).min().shift(1).to_numpy()
    ratio = dc / s.rolling(YEAR, min_periods=30).max().to_numpy()
    deep = (pd.Series(ratio).rolling(PAST, min_periods=1).min().to_numpy() <= DEPTH)
    sd = s.pipe(np.log).diff().ewm(span=30, adjust=False).std().to_numpy() * np.sqrt(365.0)
    state = np.zeros(len(dc))
    on = False
    for i in range(len(dc)):
        if not on:
            if hi[i] == hi[i] and dc[i] > hi[i] and deep[i]:
                on = True
        elif lo[i] == lo[i] and dc[i] < lo[i]:
            on = False
        sz = 0.0
        if on and sd[i] == sd[i] and sd[i] > 0:
            sz = min(float(p["own_cap"]), float(p["own_vol"]) / sd[i])
        state[i] = np.floor(sz / STEP + 1e-9) * STEP
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, state[np.clip(pos, 0, None)], 0.0)


_CACHE: dict = {}


def weights(df: pd.DataFrame, params: dict) -> np.ndarray:
    """The live book with its two rides rebuilt; the dip buys stay as they are."""
    ts = np.asarray(df.index, dtype=np.int64)
    key = (len(df), int(ts[0]), int(ts[-1]), float(df["close"].iloc[-1]))
    lw = _CACHE.get(key)
    if lw is None:
        if len(_CACHE) > 12:
            _CACHE.clear()
        lw = s9.layer_weights(df, main_params())
        _CACHE[key] = lw
    brk, mac = _hourly(df, ts, {**main_params(), **params})
    return stopped(df, np.clip(np.maximum.reduce([brk, mac, lw["snap"], lw["vdip"], _own(df, ts, {**default_params(), **params})]), 0.0, 1.0))


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    return frame(df.index, {m: weights(df, spec["params"]) * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": f"The start book on {mk}, plus a bitcoin-free comeback ride: a new 30-day high after the coin was 20 % under its 1-year high.",
        "howItWorks": [
            "The start book decides as usual: dip buys, breakout ride, MACD ride, crash buy time stop, stretched rides wait.",
            "Comeback ride: the coin fell at least 20 % under its 1-year high within the last 180 days, and a completed daily close tops the highest close of the 30 days before. Then it holds a part of the account.",
            "It ends when a daily close falls under the lowest close of the 20 days before.",
            f"Size is {p['own_vol']:g} yearly risk divided by the coin's volatility, at most {p['own_cap']:g} of the account. The largest weight of all rides wins.",
        ],
        "whenItWins": "A coin recovering on its own while bitcoin is weak or flat, like ether in spring 2021.",
        "whenItLoses": "Recoveries that fail within days: the ride is cut by the 20-day low and a small loss follows.",
        "vsBuyHold": "Keeps more of coin-specific rallies than the start, with the same dip protection.",
    }
