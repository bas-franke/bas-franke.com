"""s10_combo: Session 9's separate wins put together in one book, starting from s9_cyclebull.

cyclebull  s8_btcbull (s7_ladder's laddered vol-scaled panic dips sold on the RSI bounce, a breakout ride and a MACD
           ride; in a bitcoin bull, BTC-EUR's daily close above its btc_days EMA until it closes under it or under its
           btc_exit_days EMA, the rides are bull_size x their vol size and banked later) with a cycle ceiling: no
           breakout or MACD ride while the coin is over e^cyc_hot times its cycle_days average.
pieces     each off at 0, added one by one and kept only when they raised the Session 10 rank:
  core     (s9_slopecore) the slope of a Hull MA of the coin's completed daily log closes, per day over slope_days in
           daily volatility units; above core_on the book holds core_size (rounded to quarter steps) until it drops
           under core_off.
  crash    (s9_ddcut) once the coin closes crash_depth (log) under its best close of crash_days, a dip buys at most
           half (CRASH_CAP).
  breadth  (s9_breadthbtc) the share of the other nine coins whose daily close is above their breadth_days EMA, on
           from br_in, off under br_out, is a second bull vote: the bull runs while either vote is on.
All regime inputs use completed earlier UTC days only; other coins' candles are read from disk and cut at the coin's
last bar. Settings that did nothing in cyclebull (gate, switching band, entry cycle check, bitcoin's gauge, hot giveback,
btcbull's core, a bar-candle ride mode) were taken out; the MACD ride's share, the speed rule's
weight on the slow dip and the crash cap are the round untuned values 1, 1 and 0.5.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import data
from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s10_combo"
VERSION = 1
TITLE = "Cycle bull combo"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0
STEP = 0.25
CRASH_CAP = 0.5         # a dip buys at most half in a crash (round, s9_ddcut; untuned)
BTC = "BTC-EUR"
_CACHE: dict = {}
_DAILY: dict = {}
UNIVERSE = ("BTC-EUR", "ETH-EUR", "ADA-EUR", "AVAX-EUR", "BNB-EUR", "DOGE-EUR", "LINK-EUR", "SOL-EUR", "TRX-EUR",
            "XRP-EUR")


def default_params() -> dict:
    return {
        "high_days": 27.0, "giveback": 3.9, "hvol_days": 11.0, "target_vol": 0.5,
        "take_gain": 0.15, "take_frac": 0.5,
        "snap_hours": 4.0, "snap_vol_days": 55.0, "z_up": 3.5, "z_down": 5.5, "snap_trend_days": 60.0,
        "exit_rsi": 50.0,
        "vdip_hours": 40.0, "vdip_z": 2.2,
        "ladder_first": 0.5, "ladder_mult": 1.25, "fast_gain": 1.0, "fast_z": 4.0,
        "macd_days": 26.0, "stretch": 1.0, "macd_vol": 0.45,
        "btc_days": 140.0, "bull_size": 4.0, "bull_take": 0.5, "bull_give": 1.0,
        "bear_size": 1.0, "bull_z": 1.0, "bull_gain": 3.0, "btc_exit_days": 75.0,
        "cycle_days": 450.0, "cyc_hot": 1.3,
        "core_size": 0.5, "smooth_days": 72.0, "slope_days": 10.0, "core_vol_days": 30.0, "core_on": 0.12,
        "core_off": 0.06,
        "crash_depth": 0.55, "crash_days": 10.0,
        "w_breadth": 1.0, "breadth_days": 150.0, "br_in": 0.9, "br_out": 0.5,
    }


def param_space() -> dict:
    return {
        "high_days": {"type": "float", "min": 5.0, "max": 120.0, "description": "a close above the highest close of this many days starts a ride"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the ride ends this many daily swings below its peak"},
        "hvol_days": {"type": "float", "min": 2.0, "max": 60.0, "description": "days of history that set the daily swing of the ride exit"},
        "target_vol": {"type": "float", "min": 0.1, "max": 3.0, "description": "yearly volatility a full ride may carry; wilder coins ride smaller"},
        "take_gain": {"type": "float", "min": 0.02, "max": 2.0, "description": "log gain of a ride (peak over buy) at which part of it is banked; again at twice it"},
        "take_frac": {"type": "float", "min": 0.0, "max": 0.9, "description": "share of what still rides that each of the two banking steps sells"},
        "snap_hours": {"type": "float", "min": 1.0, "max": 24.0, "description": "hours of the snap sell-off and of its exit RSI"},
        "snap_vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the normal move (snap depth and fall speed)"},
        "z_up": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves above the daily trend"},
        "z_down": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves below the daily trend"},
        "snap_trend_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in the daily trend that sets the snap depth"},
        "exit_rsi": {"type": "float", "min": 30.0, "max": 90.0, "description": "RSI level that sells the snap"},
        "vdip_hours": {"type": "float", "min": 6.0, "max": 240.0, "description": "hours in the average the slow dip is measured against"},
        "vdip_z": {"type": "float", "min": 0.5, "max": 5.0, "description": "volatility units under that average that buy the slow dip"},
        "ladder_first": {"type": "float", "min": 0.0, "max": 1.0, "description": "dip slice bought at the trigger (before the speed bonus)"},
        "ladder_mult": {"type": "float", "min": 1.0, "max": 4.0, "description": "how many times the trigger depth a dip must reach to buy its full ladder"},
        "fast_gain": {"type": "float", "min": 0.0, "max": 3.0, "description": "extra dip size per unit the last hour's fall is above fast_z normal moves (less when slower)"},
        "fast_z": {"type": "float", "min": 1.0, "max": 15.0, "description": "one-hour fall, in normal moves, that counts as normal speed"},
        "macd_days": {"type": "float", "min": 10.0, "max": 60.0, "description": "days in the MACD ride"},
        "stretch": {"type": "float", "min": 0.0, "max": 1.2, "description": "how high the MACD histogram must have been before a cross under zero sells"},
        "macd_vol": {"type": "float", "min": 0.0, "max": 3.0, "description": "yearly volatility a full MACD ride may carry (0 = always its full share)"},
        "btc_days": {"type": "float", "min": 10.0, "max": 300.0, "description": "days in bitcoin's daily average; bitcoin's daily close above it is a bull market"},
        "bull_size": {"type": "float", "min": 0.5, "max": 5.0, "description": "how many times larger both rides are in a bull (at most all in)"},
        "bull_take": {"type": "float", "min": 0.0, "max": 0.9, "description": "share each banking step sells in a bull (instead of take_frac)"},
        "bull_give": {"type": "float", "min": 0.5, "max": 3.0, "description": "the breakout ride's giveback is this many times wider in a bull"},
        "bear_size": {"type": "float", "min": 0.0, "max": 2.0, "description": "how many times the normal size both rides are outside a bull (0 = no rides then)"},
        "bull_z": {"type": "float", "min": 0.4, "max": 2.0, "description": "the two dip depths are this many times their normal depth in a bull"},
        "bull_gain": {"type": "float", "min": 0.5, "max": 10.0, "description": "in a bull the banking steps wait for this many times the normal gain"},
        "btc_exit_days": {"type": "float", "min": 0.0, "max": 100.0, "description": "bitcoin's vote also ends when its daily close falls under this shorter daily average (0 = off)"},
        "cycle_days": {"type": "float", "min": 60.0, "max": 1400.0, "description": "days in the slow average of the cycle gauge (log of the coin's daily close over that average)"},
        "cyc_hot": {"type": "float", "min": 0.2, "max": 9.0, "description": "above this cycle gauge the coin counts as overheated and the bull's rides stop (9 = no ceiling)"},
        "core_size": {"type": "float", "min": 0.0, "max": 1.0, "description": "slope core position, rounded to quarter steps (0 = off)"},
        "smooth_days": {"type": "float", "min": 4.0, "max": 200.0, "description": "days in the Hull moving average of daily closes"},
        "slope_days": {"type": "float", "min": 1.0, "max": 60.0, "description": "days over which the line's slope is measured"},
        "core_vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the daily volatility the slope is measured in"},
        "core_on": {"type": "float", "min": 0.0, "max": 2.0, "description": "slope (daily volatility units per day) that starts the slope core"},
        "core_off": {"type": "float", "min": -1.0, "max": 2.0, "description": "slope under which the slope core is sold"},
        "crash_depth": {"type": "float", "min": 0.0, "max": 1.5, "description": "log fall from the best close of crash_days past which a dip buys at most half (0 = off)"},
        "crash_days": {"type": "float", "min": 1.0, "max": 60.0, "description": "days of the best close the crash depth is measured from"},
        "w_breadth": {"type": "float", "min": 0.0, "max": 1.0, "description": "above 0.5 market breadth is a second bull vote (either vote starts and holds a bull)"},
        "breadth_days": {"type": "float", "min": 20.0, "max": 300.0, "description": "days in the daily average another coin must close above to count as rising"},
        "br_in": {"type": "float", "min": 0.2, "max": 1.0, "description": "share of the other coins rising at which breadth votes bull"},
        "br_out": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of the other coins rising under which breadth stops voting bull"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["core_off"]) > float(p["core_on"]):
        return "core_off must not exceed core_on"
    if float(p["br_out"]) > float(p["br_in"]):
        return "br_out must not exceed br_in"
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["high_days"]), float(p["hvol_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, BASE_DAYS, 3 * float(p["macd_days"]), float(p["btc_days"]) + 1,
                   min(float(p["cycle_days"]), 120.0),
                   2 * float(p["smooth_days"]) + float(p["slope_days"]), float(p["core_vol_days"])) * 96)


def _step(index) -> float:
    ts = np.asarray(index, dtype=np.int64)
    return max(float(np.median(np.diff(ts))), 1.0) if len(ts) > 1 else 900_000.0


def _bars(step: float, hours: float) -> int:
    return max(2, int(round(hours * _HOUR / step)))


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    return pd.Series(x).ewm(span=max(1, int(span)), adjust=False).mean().to_numpy(np.float64)


def _prev_day_ema(ts: np.ndarray, c: np.ndarray, days: float) -> np.ndarray:
    """EMA of completed daily closes (UTC days), known from the first bar of the next day."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    e = ind.ema(dc, max(2, int(round(days))))
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, e[np.clip(pos, 0, None)], np.nan)


# ---- regime: bitcoin vote, breadth vote, cycle ceiling ------------------------------------------------------------

def _btc_days(ts_last: int, p: dict):
    """(BTC day numbers, bitcoin vote per day) from BTC-EUR 1-hour candles cut at the coin's last bar; the coin's
    current BTC day is left out (not complete yet)."""
    b = _CACHE.get("BTC")
    if b is None:
        b = data.load_candles(BTC, "1h")
        _CACHE["BTC"] = b
    bts_all = np.asarray(b.index, dtype=np.int64)
    cut = int(np.searchsorted(bts_all, int(ts_last), side="right"))
    if cut < 3:
        return np.zeros(0, np.int64), np.zeros(0, bool)
    bts = bts_all[:cut]
    bc = b["close"].to_numpy(np.float64)[:cut]
    d = bts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    last[-1] = False
    dd, dc = d[last], bc[last]
    if len(dc) < 2:
        return np.zeros(0, np.int64), np.zeros(0, bool)
    e = ind.ema(dc, max(2, int(round(float(p["btc_days"])))))
    x = np.log(dc) - np.log(np.where(np.isfinite(e), e, dc))
    xd = float(p["btc_exit_days"])
    if xd > 0:
        e2 = ind.ema(dc, max(2, int(round(xd))))
        below2 = (dc < np.where(np.isfinite(e2), e2, -np.inf)).tolist()
    else:
        below2 = [False] * len(dc)
    st = np.zeros(len(dc), bool)
    on = False
    for i, (v, ok) in enumerate(zip(x.tolist(), np.isfinite(e).tolist())):
        if ok:
            if not on and v > 0.0 and not below2[i]:
                on = True
            elif on and (v < 0.0 or below2[i]):
                on = False
        st[i] = on
    return dd, st


def _daily_of(market: str):
    """(UTC day numbers, last close of each day) from the market's 1-hour candles, cached."""
    v = _DAILY.get(market)
    if v is None:
        try:
            h = data.load_candles(market, "1h")
            hts = np.asarray(h.index, dtype=np.int64)
            hc = h["close"].to_numpy(np.float64)
            d = hts // _DAY
            last = np.r_[d[1:] != d[:-1], True] if len(d) else np.zeros(0, bool)
            v = (d[last], hc[last])
        except FileNotFoundError:
            v = (np.zeros(0, np.int64), np.zeros(0))
        _DAILY[market] = v
    return v


def _breadth_days(market: str, ts_last: int, p: dict):
    """(day numbers, breadth vote): the share of the other session coins whose daily close is above the EMA of their
    daily closes, on completed UTC days before the day of the coin's last bar; on from br_in until under br_out."""
    cut_day = int(ts_last) // _DAY
    bd = max(2, int(round(float(p["breadth_days"]))))
    rows = []
    for m in UNIVERSE:
        if m == market:
            continue
        d, cl = _daily_of(m)
        k = int(np.searchsorted(d, cut_day, side="left"))
        d, cl = d[:k], cl[:k]
        if len(d) < bd + 1:
            continue
        e = ind.ema(cl, bd)
        up = (cl > e).astype(float)
        up[:bd] = np.nan
        rows.append((d, up))
    if not rows:
        return np.zeros(0, np.int64), np.zeros(0, bool)
    lo = min(int(r[0][0]) for r in rows)
    days = np.arange(lo, cut_day, dtype=np.int64)
    votes = np.zeros(len(days))
    count = np.zeros(len(days))
    for d, up in rows:
        j = np.searchsorted(d, days, side="right") - 1
        ok = (j >= 0) & (days - d[np.clip(j, 0, None)] <= 3)
        u = np.where(ok, up[np.clip(j, 0, None)], np.nan)
        f = np.isfinite(u)
        votes += np.where(f, u, 0.0)
        count += f
    share = np.where(count >= 3, votes / np.maximum(count, 1), np.nan)
    bi, bo = float(p["br_in"]), float(p["br_out"])
    st = np.zeros(len(days), bool)
    on = False
    for i, x in enumerate(share.tolist()):
        if x == x:
            if not on and x >= bi:
                on = True
            elif on and x < bo:
                on = False
        else:
            on = False
        st[i] = on
    return days, st


def _at(dd: np.ndarray, st: np.ndarray, d: np.ndarray) -> np.ndarray:
    """State of the last day strictly before each day in d (False before the first)."""
    if len(dd) == 0:
        return np.zeros(len(d), bool)
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, st[np.clip(pos, 0, None)], False).astype(bool)


def _gauge(ts: np.ndarray, c: np.ndarray, p: dict) -> np.ndarray:
    """Cycle gauge per bar: log(the coin's last completed daily close / average of its last cycle_days daily closes,
    from 120 days of history on). Earlier UTC days only; NaN before history."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    if len(dc) < 2:
        return np.full(len(ts), np.nan)
    nd = max(2, int(round(float(p["cycle_days"]))))
    sma = pd.Series(dc).rolling(nd, min_periods=min(nd, 120)).mean().to_numpy()
    g = np.log(dc / sma)
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, g[np.clip(pos, 0, None)], np.nan)


def _regime(ts: np.ndarray, c: np.ndarray, p: dict):
    """(bull, hot) per bar. bull: the bitcoin vote, or the breadth vote when it is on; hot: a bull whose coin is over
    e^cyc_hot times its cycle_days average (the rides stop there)."""
    d = ts // _DAY
    bull = _at(*_btc_days(int(ts[-1]), p), d)
    if float(p["w_breadth"]) > 0.5:
        bull = bull | _at(*_breadth_days(str(p.get("_market", "")), int(ts[-1]), p), d)
    top = float(p["cyc_hot"])
    if top >= 8.99:
        return bull, np.zeros(len(ts), bool)
    gg = np.nan_to_num(_gauge(ts, c, p), nan=-99.0)
    return bull, bull & (gg > top)


def _q(x):
    return np.floor(np.clip(x, 0.0, 1.0) / STEP + 1e-9) * STEP


# ---- rides -------------------------------------------------------------------------------------------------------

def _breakout(ts, c, lc, step, size, p, bull, hot) -> np.ndarray:
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    nh = _bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    give, tg = float(p["giveback"]), float(p["take_gain"])
    tf_bear, tf_bull, bgain = float(p["take_frac"]), float(p["bull_take"]), float(p["bull_gain"])
    bmul, bgive, smul = float(p["bull_size"]), float(p["bull_give"]), float(p["bear_size"])
    mul_l = np.where(hot, 0.0, np.where(bull, bmul, smul)).tolist()
    w = np.zeros(n)
    ride = level = 0
    peak = entry = sz = 0.0
    ll, hl, sl, zl = lc.tolist(), hi.tolist(), day_sd.tolist(), size.tolist()
    bl = (bull & ~hot).tolist()
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
            w[i] = np.floor(min(sz * mul_l[i], 1.0) * (1.0 - tf) ** level / STEP + 1e-9) * STEP
    return w


def _macd(df, lc, step, p) -> np.ndarray:
    reading = compute("macd", df, max(2, int(round(float(p["macd_days"]) * _DAY / step))))
    level = float(p["stretch"])
    w = np.zeros(len(reading))
    held = False
    peak, prev = -1e9, np.nan
    for i, v in enumerate(np.asarray(reading, float).tolist()):
        if v != v:
            prev = np.nan
            continue
        if not held:
            if v > 0.0 and not (prev > 0.0):
                held, peak = True, v
        else:
            peak = max(peak, v)
            if prev > 0.0 and v <= 0.0 and peak >= level:
                held, peak = False, -1e9
        w[i] = 1.0 if held else 0.0
        prev = v
    return w


def _rides(df, ts, c, lc, step, p, bull, hot):
    """Breakout ride and MACD ride on the given candles, each volatility-sized."""
    n = len(c)
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(_ema(r * r, _bars(step, 24.0 * BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(_bars(step, 24.0 * 365.0))
    size = _q(float(p["target_vol"]) / yearly)
    brk = _breakout(ts, c, lc, step, size, p, bull, hot)
    ms = np.ones(n)
    if float(p["macd_vol"]) > 0:
        mult = np.where(hot, 0.0, np.where(bull, float(p["bull_size"]), float(p["bear_size"])))
        ms = np.minimum(ms, _q(float(p["macd_vol"]) * mult / yearly))
    mac = _macd(df, lc, step, p) * ms
    return brk, mac


def _hourly_rides(df, ts, p):
    """The rides decided on completed UTC 1-hour candles built from the bars, held until the next hour closes."""
    step = _step(ts)
    hr = ts // _HOUR
    g = df.groupby(hr)
    hdf = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    hts = hdf.index.to_numpy(np.int64) * _HOUR
    hdf.index = hts
    hc = hdf["close"].to_numpy(np.float64)
    hlc = np.log(np.maximum(hc, 1e-12))
    hb, hm = _rides(hdf, hts, hc, hlc, float(_HOUR), p, *_regime(hts, hc, p))
    gi = np.searchsorted(hdf.index.to_numpy(np.int64) // _HOUR, hr)
    closing = (ts + int(step)) >= (hr + 1) * _HOUR
    pos = np.where(closing, gi, gi - 1)
    okp = pos >= 0
    pc = np.clip(pos, 0, None)
    return np.where(okp, hb[pc], 0.0), np.where(okp, hm[pc], 0.0)


# ---- dips --------------------------------------------------------------------------------------------------------

def _crash_cap(lc, step, p) -> np.ndarray:
    """Largest dip size per bar: CRASH_CAP once the coin is crash_depth (log) under its best close of crash_days."""
    cd = float(p["crash_depth"])
    if cd <= 0:
        return np.ones(len(lc))
    nb = _bars(step, 24.0 * float(p["crash_days"]))
    hi = pd.Series(lc).rolling(nb, min_periods=1).max().to_numpy()
    return np.where(lc < hi - cd, CRASH_CAP, 1.0)


def _dip_size(depth: float, fast: float, first: float, mult: float, gain: float) -> float:
    """Ladder part (first at the trigger, all from mult deep) plus the speed bonus, in quarter steps, 0..1."""
    lad = 1.0 if (first >= 1.0 or depth >= mult) else first
    s = lad + gain * (fast - 1.0)
    s = min(max(s, 0.0), 1.0)
    return float(np.floor(s / STEP + 1e-9) * STEP)


def _snap(ts, c, lc, step, fast, cap, p, bull) -> np.ndarray:
    n = len(c)
    per_hour = _HOUR / step
    k = max(1, int(round(float(p["snap_hours"]) * per_hour)))
    span = max(2, int(round(float(p["snap_vol_days"]) * 24 * per_hour)))
    r1 = np.r_[np.nan, np.diff(lc)]
    sig = np.sqrt(pd.Series(r1 * r1).ewm(span=span, min_periods=span).mean().to_numpy())
    dk = np.full(n, np.nan)
    if n > k:
        dk[k:] = lc[k:] - lc[:-k]
    z = dk / (sig * np.sqrt(k))
    rsi = ind.rsi(c, max(2, k))
    trend = lc - np.log(_prev_day_ema(ts, c, float(p["snap_trend_days"])))
    zu, zd, er = float(p["z_up"]), float(p["z_down"]), float(p["exit_rsi"])
    f1, lm, fg = float(p["ladder_first"]), float(p["ladder_mult"]), float(p["fast_gain"])
    w = np.zeros(n)
    held = False
    size = 0.0
    bz = float(p["bull_z"])
    zl, rl, tl, fl, bl, cl = z.tolist(), rsi.tolist(), trend.tolist(), fast.tolist(), bull.tolist(), cap.tolist()
    for i in range(n):
        zi, ri, ti = zl[i], rl[i], tl[i]
        if zi == zi and ri == ri and ti == ti:
            thr = (zu if ti > 0.0 else zd) * (bz if bl[i] else 1.0)
            if held and ri > er:
                held, size = False, 0.0
            elif zi < -thr:
                held = True
                s = min(_dip_size(-zi / thr, fl[i], f1, lm, fg), cl[i])
                if s > size:
                    size = s
        w[i] = size if held else 0.0
    return w


def _vdip(c, lc, step, vol, fast, cap, p, bull) -> np.ndarray:
    n = len(c)
    nb = _bars(step, float(p["vdip_hours"]))
    z = (lc - np.log(_ema(c, nb))) / (vol * np.sqrt(nb))
    dz = float(p["vdip_z"])
    f1, lm = float(p["ladder_first"]), float(p["ladder_mult"])
    fg = float(p["fast_gain"])
    w = np.zeros(n)
    rev = False
    size = 0.0
    bz = float(p["bull_z"])
    zl, fl, bl, cl = z.tolist(), fast.tolist(), bull.tolist(), cap.tolist()
    for i in range(_bars(step, 24.0 * BASE_DAYS), n):
        di = dz * (bz if bl[i] else 1.0)
        if rev and zl[i] > 0:
            rev, size = False, 0.0
        elif zl[i] < -di:
            rev = True
            s = min(_dip_size(-zl[i] / di, fl[i], f1, lm, fg), cl[i])
            if s > size:
                size = s
        w[i] = size if rev else 0.0
    return w


# ---- slope core --------------------------------------------------------------------------------------------------

def _wma(x: np.ndarray, n: int) -> np.ndarray:
    n = max(1, int(n))
    w = np.arange(1, n + 1, dtype=np.float64)
    return pd.Series(x).rolling(n, min_periods=n).apply(lambda a: a @ w, raw=True).to_numpy() / w.sum()


def _hma_slope(y: np.ndarray, n: int, k: int) -> np.ndarray:
    """Slope per day of the Hull moving average of the daily log closes y (causal)."""
    m = max(4, n)
    raw = 2.0 * _wma(y, m // 2) - _wma(y, m)
    line = _wma(raw, max(2, int(round(np.sqrt(m)))))
    out = np.full(len(y), np.nan)
    if len(y) > k:
        out[k:] = (line[k:] - line[:-k]) / k
    return out


def _core(ts, c, p) -> np.ndarray:
    """Slope core weight per bar from completed UTC days (known from the next day's first bar)."""
    n = len(c)
    size = float(np.round(min(max(float(p["core_size"]), 0.0), 1.0) / STEP) * STEP)
    if n < 3 or size <= 0:
        return np.zeros(n)
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, y = d[last], np.log(np.maximum(c[last], 1e-12))
    r = np.r_[0.0, np.diff(y)]
    sd = np.sqrt(_ema(r * r, max(2, int(round(float(p["core_vol_days"]))))))
    sl = _hma_slope(y, max(2, int(round(float(p["smooth_days"])))), max(1, int(round(float(p["slope_days"])))))
    z = sl / np.maximum(sd, 1e-9)
    on, off = float(p["core_on"]), float(p["core_off"])
    wd = np.zeros(len(dd))
    held = False
    for i, zi in enumerate(z.tolist()):
        if zi != zi or i < 20:
            continue
        if held:
            if zi < off:
                held = False
        elif zi > on:
            held = True
        wd[i] = size if held else 0.0
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, wd[np.clip(pos, 0, None)], 0.0)


# ---- book --------------------------------------------------------------------------------------------------------

LAYERS = ("break", "snap", "vdip", "macd", "core")


def layer_weights(df, p) -> dict[str, np.ndarray]:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    out = {k: np.zeros(n) for k in LAYERS}
    if n < 3:
        return out
    step = _step(ts)
    lc = np.log(np.maximum(c, 1e-12))
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(_ema(r * r, _bars(step, 24.0 * BASE_DAYS))), 1e-12)
    per_hour = _HOUR / step
    k1 = max(1, int(round(per_hour)))
    span = max(2, int(round(float(p["snap_vol_days"]) * 24 * per_hour)))
    sig = np.sqrt(pd.Series(r * r).ewm(span=span, min_periods=span).mean().to_numpy())
    d1 = np.full(n, np.nan)
    if n > k1:
        d1[k1:] = lc[k1:] - lc[:-k1]
    z1 = d1 / np.maximum(sig * np.sqrt(k1), 1e-12)
    fast = np.clip(np.nan_to_num(-z1, nan=0.0) / float(p["fast_z"]), 0.0, 2.0)
    bull, hot = _regime(ts, c, p)
    if step < _HOUR:
        out["break"], out["macd"] = _hourly_rides(df, ts, p)
    else:
        out["break"], out["macd"] = _rides(df, ts, c, lc, step, p, bull, hot)
    cap = _crash_cap(lc, step, p)
    out["snap"] = _snap(ts, c, lc, step, fast, cap, p, bull)
    out["vdip"] = _vdip(c, lc, step, vol, fast, cap, p, bull)
    out["core"] = _core(ts, c, p)
    return out


def _weights(df, p) -> np.ndarray:
    lw = layer_weights(df, p)
    w = np.zeros(len(df))
    for k in LAYERS:
        w = np.maximum(w, lw[k])
    return np.clip(w, 0.0, 1.0)


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = dict(spec["params"])
    p["_market"] = m          # only used to leave this coin out of the breadth count
    w = _weights(df, p)
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    g = float(p["take_gain"])
    steps = [
        f"Ride: a close above the highest close of the last {p['high_days']:g} days buys, sized "
        f"{p['target_vol']:g} divided by the coin's yearly volatility (at most all in). It ends when price falls "
        f"{p['giveback']:g} daily swings below its best since the buy.",
    ]
    if float(p["take_frac"]) > 0:
        steps.append(f"Banking: at {(np.exp(g) - 1) * 100:.0f} % and {(np.exp(2 * g) - 1) * 100:.0f} % above the "
                     f"buy, {round(100 * float(p['take_frac']))} % of what still rides is sold.")
    steps += [
        f"Snap dip: a {p['snap_hours']:g}-hour fall of {p['z_up']:g} normal moves ({p['z_down']:g} under the "
        f"{p['snap_trend_days']:g}-day trend) buys; it sells when the {p['snap_hours']:g}-hour RSI tops {p['exit_rsi']:g}.",
        f"Slow dip: {p['vdip_z']:g} volatility units under the {p['vdip_hours']:g}-hour average buys; it sells once "
        "price is back at that average.",
        f"Dip ladder: a dip first buys {round(100 * float(p['ladder_first']))} %, and the full amount once it is "
        f"{p['ladder_mult']:g} times as deep as its trigger.",
        f"Fall speed: a dip whose last hour fell more than {p['fast_z']:g} normal moves gets {p['fast_gain']:g} more "
        "per unit faster; a slow drift gets less, or nothing. Sizes only go up while the dip is held.",
    ]
    if float(p["crash_depth"]) > 0:
        steps.append(f"Crash cap: once the coin is {(1 - np.exp(-float(p['crash_depth']))) * 100:.0f} % under its best "
                     f"close of the last {p['crash_days']:g} days, a dip buys at most "
                     f"{round(100 * CRASH_CAP)} %, so a crash's second leg cannot catch the whole book.")
    steps.append(f"MACD ride: at most {p['macd_vol']:g} divided by the coin's yearly volatility while the "
                 f"{p['macd_days']:g}-day MACD is positive, sold on a cross under zero after it reached {p['stretch']:g}.")
    xd = float(p["btc_exit_days"])
    bull_end = f" or under its {xd:g}-day average" if xd > 0 else ""
    vote = (f" Market breadth is a second vote: once {round(100 * float(p['br_in']))} % of the other coins close above "
            f"their {p['breadth_days']:g}-day average the bull is on too, until fewer than "
            f"{round(100 * float(p['br_out']))} % do." if float(p["w_breadth"]) > 0.5 else "")
    steps.append(f"Bull market: while bitcoin's daily close is above its {p['btc_days']:g}-day average (it ends when "
                 f"bitcoin closes under it{bull_end}).{vote} In a bull both rides are {p['bull_size']:g} times their "
                 f"size (at most all in), and banking waits for {p['bull_gain']:g} times the gain and sells "
                 f"{round(100 * float(p['bull_take']))} %. Outside a bull everything above runs as normal.")
    if float(p["cyc_hot"]) < 8.99:
        steps.append(f"Overheated: when the coin's last daily close is more than {np.exp(float(p['cyc_hot'])):.1f} times "
                     f"its {p['cycle_days']:g}-day average (a blow-off top), the breakout and MACD rides stop, even in a bull.")
    if float(p["core_size"]) > 0:
        steps.append(f"Slope core: the {p['smooth_days']:g}-day Hull moving average of daily closes; its climb per day "
                     f"over {p['slope_days']:g} days, in daily swings, is the coin's trend strength. Above "
                     f"{p['core_on']:g} the book keeps {round(100 * float(np.round(float(p['core_size']) / STEP) * STEP))} % "
                     f"until the strength drops under {p['core_off']:g}.")
    steps.append("The book holds the largest position any of these asks for.")
    return {
        "summary": (f"Dip and breakout on {mk} with bitcoin as the switch: in a bull market it rides new highs and the "
                    "MACD trend with big positions and banks little, but stops riding once the coin is far above its "
                    "long average; a smooth daily trend line adds a core while it climbs; otherwise it rides small and "
                    "buys panic dips in a ladder, capped in crashes."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Market-wide crypto bull runs, steady climbs of the coin itself, and fast panic flushes that snap back.",
        "whenItLoses": "A coin bleeding for months while the market still looks fine (the big rides take the hit).",
    }
