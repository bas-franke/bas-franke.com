"""s15_momentum12: the s15_start book, plus a coin-own bull from monthly 12-1 style momentum when bitcoin is not in a bull.

Own bull = the coin gained mom_min over mom_days (ending a week ago) AND beat bitcoin over the same days. Rides then use bull-style
banking with own_size. Below: the start docstring.

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

NAME = "s15_momentum12"
VERSION = 1
TITLE = "Own momentum bull"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
STEP = 0.25


def default_params() -> dict:
    return {"ext_days": 100.0, "need_k": 0.25, "giveback": 3.0, "mom_days": 120.0, "mom_min": 0.5, "rel_min": 0.3, "own_size": 2.0}


def param_space() -> dict:
    return {
        "ext_days": {"type": "float", "min": 30.0, "max": 300.0, "description": "days in the coin's daily average that sets how stretched it is"},
        "need_k": {"type": "float", "min": 0.0, "max": 2.0, "description": "share of the stretch a new ride must gain before it holds anything"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the breakout ride ends this many daily swings below its peak"},
        "mom_days": {"type": "float", "min": 20.0, "max": 250.0, "description": "days the coin's momentum is measured over (ending a week ago)"},
        "mom_min": {"type": "float", "min": 0.0, "max": 1.5, "description": "log gain over those days the coin needs for its own bull"},
        "rel_min": {"type": "float", "min": -9.0, "max": 1.0, "description": "log points the coin must beat bitcoin by over the same days (-9 = no check)"},
        "own_size": {"type": "float", "min": 0.5, "max": 5.0, "description": "how many times larger the rides are in the coin's own bull while bitcoin is not in a bull"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(max(s9.warmup(main_params()) / 96, float(p["ext_days"]) + 1, float(p["mom_days"]) + 10) * 96)


def _need(ts: np.ndarray, c: np.ndarray, bull: np.ndarray, p: dict) -> np.ndarray:
    """Log gain a ride must show before it holds anything, if it starts on this bar. From completed earlier UTC days."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    x = np.log(dc) - np.log(pd.Series(dc).ewm(span=max(2, int(round(float(p["ext_days"])))), adjust=False).mean().to_numpy())
    pos = np.searchsorted(dd, d, side="left") - 1
    stretch = np.where(pos >= 0, x[np.clip(pos, 0, None)], 0.0)
    return np.where(bull, float(p["need_k"]) * np.maximum(stretch, 0.0), 0.0)


def _breakout(lc, step, size, p, bull, hot, own, need) -> np.ndarray:
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
    mul_l = np.where(hot, hmul, np.where(own, float(p["own_size"]), np.where(bull, bmul, smul))).tolist()
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


def _own_bull(hdf: pd.DataFrame, hts: np.ndarray, p: dict) -> np.ndarray:
    """The coin's own bull per hour bar, from the coin's monthly-style momentum: the log gain of its daily close from
    mom_days+7 days ago to 7 days ago must be above mom_min, and it must beat bitcoin's gain over the same span by rel_min.
    Completed earlier UTC days only; bitcoin read from disk and cut at the coin's last bar."""
    d = hts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd = d[last]
    dc = hdf["close"].to_numpy(np.float64)[last]
    sk, ln = 7, max(2, int(round(float(p["mom_days"]))))
    n = len(dc)
    idx = np.arange(n)
    a, b = np.clip(idx - sk, 0, None), np.clip(idx - sk - ln, 0, None)
    m = np.log(dc[a] / dc[b])
    m[idx - sk - ln < 0] = -9.0
    rel_min = float(p["rel_min"])
    if rel_min > -8.9:
        bd, bc = s9._btc_daily(hts)
        if len(bc) < 2:
            return np.zeros(len(hts), bool)
        bp = np.clip(np.searchsorted(bd, dd, side="right") - 1, 0, None)
        bcc = bc[bp]
        bm = np.log(bcc[a] / bcc[b])
        ok = (m > float(p["mom_min"])) & (m - bm > rel_min)
    else:
        ok = m > float(p["mom_min"])
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, ok[np.clip(pos, 0, None)], False)


def _regime(hdf, hts, hc, p):
    """(bull, hot): the bitcoin bull or the coin's own bull; hot as in the live book."""
    bull0, _ = s9._regime(hts, hc, p)
    own = _own_bull(hdf, hts, p) & ~bull0
    bull = bull0 | own
    top = float(p["cyc_hot"])
    if top >= 8.99:
        return bull, np.zeros(len(hts), bool), own
    gg = np.nan_to_num(s9._gauge(hts, hc, p), nan=-99.0)
    return bull, bull & (gg > top), own


def _rides(df, ts, c, lc, step, p, bull, hot, own):
    n = len(c)
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(s9._ema(r * r, s9._bars(step, 24.0 * s9.BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(s9._bars(step, 24.0 * 365.0))
    size = s9._q(float(p["target_vol"]) / yearly)
    need = _need(ts, c, bull, p)
    brk = _breakout(lc, step, size, p, bull, hot, own, need)
    mult = np.where(hot, float(p["hot_size"]), np.where(own, float(p["own_size"]), np.where(bull, float(p["bull_size"]), float(p["bear_size"]))))
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
    hb, hm = _rides(hdf, hts, hc, np.log(np.maximum(hc, 1e-12)), float(_HOUR), p, *_regime(hdf, hts, hc, p))
    gi = np.searchsorted(hdf.index.to_numpy(np.int64) // _HOUR, hr)
    closing = (ts + int(step)) >= (hr + 1) * _HOUR
    pos = np.where(closing, gi, gi - 1)
    okp = pos >= 0
    pc = np.clip(pos, 0, None)
    return np.where(okp, hb[pc], 0.0), np.where(okp, hm[pc], 0.0)


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
    return stopped(df, np.clip(np.maximum.reduce([brk, mac, lw["snap"], lw["vdip"]]), 0.0, 1.0))


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    return frame(df.index, {m: weights(df, spec["params"]) * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (f"Bitcoin bull or the coin's own momentum bull, cycle check on {mk} with the crash buy time stop, but in a bitcoin bull a ride that starts "
                    f"far above the coin's {p['ext_days']:g}-day average must first rise before it buys."),
        "howItWorks": [
            "The live book decides as usual: dip buys, breakout ride, MACD ride, crash buy time stop.",
            f"Stretch is how far the coin's last daily close sits above its {p['ext_days']:g}-day average, in log terms.",
            f"When a ride signal comes in a bitcoin bull, the ride buys nothing until price has risen {p['need_k']:g} times "
            "the stretch above the signal. 40 % above the average means waiting for about 8 % more.",
            "Once it has done that it is a normal ride, and it stays in if price slips back.",
            f"If bitcoin is not in a bull but the coin rose {p['mom_min']:g} (log) over {p['mom_days']:g} days ending a week ago and beat bitcoin over the same days, the coin has its own bull: bull-style rides at {p['own_size']:g}x.",
            f"The breakout ride ends {p['giveback']:g} daily swings below its peak.",
        ],
        "whenItWins": "Ranges at the top of a bull, like 2024 and late 2025: breakouts that fail never get bought.",
        "whenItLoses": "Runaway rallies: the first few percent of a ride that starts high are missed, and SOL and TRX, which trend far above their average, give up return.",
        "vsBuyHold": "Beats holding by the same rides and dips as the live book, with fewer failed all-in buys near tops.",
    }
