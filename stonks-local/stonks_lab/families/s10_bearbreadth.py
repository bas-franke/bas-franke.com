"""s10_bearbreadth: s10_bearmix (cycle bull + bitcoin bear) with s10_breadth's loose bull.

Three regimes, read from 1-hour candles on disk (cut before the coin's current UTC day; only completed days are used):
  bull     bitcoin's daily close above its btc_days EMA (until a close under it or under its btc_exit_days EMA), OR
           market breadth: at least br_in of the 10 coins close above their breadth_days EMA, kept until fewer than
           br_out do (breadth reaches br_in only after bitcoin has turned, so in practice it keeps a bull alive through
           bitcoin's dips). Both rides are bull_size times their volatility size (at most all in), banked at bull_gain
           times the gain and selling bull_take; unless the coin is overheated (its daily close over e^cyc_hot times its
           cycle_days average): then no breakout or MACD ride at all (s9_cyclebull's ceiling)
  bear     no bull (neither bitcoin nor breadth), from a bitcoin daily close under its bear_days EMA until a close back
           above it: the MACD ride gets bear_macd of all in added to its size, and both dips need bear_z times their depth
  neither  s7_ladder: small banked rides and laddered, speed-sized panic dips
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import data
from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s10_bearbreadth"
VERSION = 1
TITLE = "Bear mode, breadth bull"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0
STEP = 0.25
BTC = "BTC-EUR"
_BTC_CACHE: dict = {}
_DAILY: dict = {}
_BREADTH: dict = {}
UNIVERSE = ("BTC-EUR", "ETH-EUR", "ADA-EUR", "AVAX-EUR", "BNB-EUR", "DOGE-EUR", "LINK-EUR", "SOL-EUR", "TRX-EUR",
            "XRP-EUR")


def default_params() -> dict:
    return {
        "high_days": 27.0, "giveback": 3.9, "hvol_days": 11.0, "target_vol": 0.5,
        "take_gain": 0.15, "take_frac": 0.5,
        "snap_hours": 4.0, "snap_vol_days": 55.0, "z_up": 3.0, "z_down": 4.4, "snap_trend_days": 60.0,
        "exit_rsi": 50.0,
        "vdip_hours": 40.0, "vdip_z": 2.2,
        "ladder_first": 0.5, "ladder_mult": 1.25, "fast_gain": 1.0, "fast_z": 4.0,
        "macd_days": 26.0, "stretch": 1.0, "macd_vol": 0.45,
        "btc_days": 140.0, "btc_exit_days": 75.0, "bull_size": 4.0, "bull_take": 0.5, "bull_gain": 3.0,
        "cycle_days": 450.0, "cyc_hot": 1.3,
        "bear_days": 365.0, "bear_macd": 0.25, "bear_z": 1.15,
        "breadth_days": 150.0, "br_in": 0.8, "br_out": 0.5,
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
        "macd_vol": {"type": "float", "min": 0.05, "max": 3.0, "description": "yearly volatility a full MACD ride may carry; wilder coins ride smaller"},
        "btc_days": {"type": "float", "min": 10.0, "max": 300.0, "description": "days in bitcoin's daily average; bitcoin's daily close above it is a bull market"},
        "btc_exit_days": {"type": "float", "min": 0.0, "max": 100.0, "description": "a bull also ends when bitcoin's daily close falls under this shorter daily average (0 = off)"},
        "bull_size": {"type": "float", "min": 0.5, "max": 5.0, "description": "how many times larger both rides are in a bitcoin bull (at most all in)"},
        "bull_take": {"type": "float", "min": 0.0, "max": 0.9, "description": "share each banking step sells in a bitcoin bull (instead of take_frac)"},
        "bull_gain": {"type": "float", "min": 0.5, "max": 10.0, "description": "in a bitcoin bull the banking steps wait for this many times the normal gain"},
        "cycle_days": {"type": "float", "min": 60.0, "max": 1400.0, "description": "days in the slow average of the cycle gauge (log of the coin's daily close over that average)"},
        "cyc_hot": {"type": "float", "min": 0.2, "max": 9.0, "description": "above this cycle gauge a bull counts as overheated: no breakout or MACD ride (9 = no ceiling)"},
        "bear_days": {"type": "float", "min": 0.0, "max": 400.0, "description": "days in bitcoin's daily average of the bear test: a bear runs from a close under it to a close back above it (0 = no bear mode)"},
        "bear_macd": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of all in added to the MACD ride's size in a bitcoin bear (the recovery ride)"},
        "bear_z": {"type": "float", "min": 0.4, "max": 3.0, "description": "the two dip depths are this many times their normal depth in a bitcoin bear"},
        "breadth_days": {"type": "float", "min": 0.0, "max": 300.0, "description": "days in the daily average each of the 10 coins must close above to count as rising (0 = breadth off)"},
        "br_in": {"type": "float", "min": 0.2, "max": 1.0, "description": "share of the 10 coins rising at which breadth may keep a bull alive"},
        "br_out": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of the 10 coins rising under which breadth stops keeping a bull alive"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["high_days"]), float(p["hvol_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, BASE_DAYS, 3 * float(p["macd_days"]), float(p["btc_days"]) + 1,
                   float(p["breadth_days"]) + 1, min(float(p["cycle_days"]), 120.0)) * 96)


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


def _daily_of(market: str):
    """(UTC day numbers, last close of each day) from the market's 1-hour candles on disk, cached."""
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


def _breadth_state(cut_day: int, p: dict):
    """(day numbers, breadth vote) on completed days before cut_day (the coin's current UTC day, so nothing later is
    read): on once at least br_in of the 10 coins close above their breadth_days EMA, off once fewer than br_out do
    (needs at least 3 coins with history)."""
    bd = max(2, int(round(float(p["breadth_days"]))))
    key = (cut_day, bd, float(p["br_in"]), float(p["br_out"]))
    v = _BREADTH.get(key)
    if v is not None:
        return v
    rows = []
    for m in UNIVERSE:
        d0, c0 = _daily_of(m)
        k = int(np.searchsorted(d0, cut_day, side="left"))
        d, cl = d0[:k], c0[:k]
        if len(d) < bd + 1:
            continue
        e = ind.ema(cl, bd)
        up = (cl > e).astype(float)
        up[:bd] = np.nan
        rows.append((d, up))
    if not rows:
        v = (np.zeros(0, np.int64), np.zeros(0, bool))
    else:
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
        v = (days, st)
    if len(_BREADTH) > 256:
        _BREADTH.clear()
    _BREADTH[key] = v
    return v


def _btc_regime(ts: np.ndarray, p: dict) -> np.ndarray:
    """1 = bitcoin bull, -1 = bitcoin bear, 0 = neither, on the coin's bars. BTC-EUR 1-hour candles are read from disk
    and cut at the coin's last bar; only completed earlier UTC days are used."""
    b = _BTC_CACHE.get("1h")
    if b is None:
        b = data.load_candles(BTC, "1h")
        _BTC_CACHE["1h"] = b
    n = len(ts)
    bts_all = np.asarray(b.index, dtype=np.int64)
    cut = int(np.searchsorted(bts_all, int(ts[-1]), side="right"))
    if cut < 3:
        return np.zeros(n, np.int8)
    bts = bts_all[:cut]
    bc = b["close"].to_numpy(np.float64)[:cut]
    d = bts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    last[-1] = False                       # the coin's current BTC day is not complete yet
    dd, dc = d[last], bc[last]
    if len(dc) < 2:
        return np.zeros(n, np.int8)
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
    if float(p["breadth_days"]) > 0:
        bd_days, bd_st = _breadth_state(int(ts[-1]) // _DAY, p)
        if len(bd_days):
            j = np.searchsorted(bd_days, dd, side="right") - 1
            ok = (j >= 0) & (dd - bd_days[np.clip(j, 0, None)] <= 3)
            br = np.where(ok, bd_st[np.clip(j, 0, None)], False)
            st = st | br                       # bitcoin bull OR market breadth (breadth only after reaching br_in)
    reg = st.astype(np.int8)
    bdays = float(p["bear_days"])
    if bdays > 0:
        e3 = ind.ema(dc, max(2, int(round(bdays))))
        below3 = (dc < np.where(np.isfinite(e3), e3, -np.inf))
        bear = False
        for i, (v, ok) in enumerate(zip(below3.tolist(), np.isfinite(e3).tolist())):
            if ok:
                bear = v
            if bear and not st[i]:
                reg[i] = -1
    pos = np.searchsorted(dd, ts // _DAY, side="left") - 1   # earlier UTC days only
    return np.where(pos >= 0, reg[np.clip(pos, 0, None)], 0).astype(np.int8)


def _hot(ts: np.ndarray, c: np.ndarray, p: dict) -> np.ndarray:
    """Overheated: the coin's last completed daily close over e^cyc_hot times the average of its last cycle_days daily
    closes (from 120 days of history on). Earlier UTC days only."""
    top = float(p["cyc_hot"])
    if top >= 8.99:
        return np.zeros(len(ts), bool)
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    if len(dc) < 2:
        return np.zeros(len(ts), bool)
    nd = max(2, int(round(float(p["cycle_days"]))))
    sma = pd.Series(dc).rolling(nd, min_periods=min(nd, 120)).mean().to_numpy()
    g = np.nan_to_num(np.log(dc / sma), nan=-99.0)
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, g[np.clip(pos, 0, None)], -99.0) > top


def _q(x):
    return np.floor(np.clip(x, 0.0, 1.0) / STEP + 1e-9) * STEP


def _breakout(lc, step, size, p, reg, hot) -> np.ndarray:
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    nh = _bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    give, tg = float(p["giveback"]), float(p["take_gain"])
    tf_n, tf_bull, bgain = float(p["take_frac"]), float(p["bull_take"]), float(p["bull_gain"])
    bull = (reg == 1) & ~hot
    mul = np.where(hot & (reg == 1), 0.0, np.where(bull, float(p["bull_size"]), 1.0))
    w = np.zeros(n)
    ride = level = 0
    peak = entry = sz = 0.0
    ll, hl, sl, zl, bl, ml = lc.tolist(), hi.tolist(), day_sd.tolist(), size.tolist(), bull.tolist(), mul.tolist()
    for i in range(n):
        if ride == 0:
            if hl[i] == hl[i] and ll[i] > hl[i] and zl[i] > 0:
                ride, peak, entry, level, sz = 1, ll[i], ll[i], 0, zl[i]
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - give * sl[i]:
                ride = 0
            else:
                gi = tg * (bgain if bl[i] else 1.0)
                while level < 2 and peak - entry >= gi * (level + 1):
                    level += 1
        if ride:
            tf = tf_bull if bl[i] else tf_n
            w[i] = np.floor(min(sz * ml[i], 1.0) * (1.0 - tf) ** level / STEP + 1e-9) * STEP
    return w


def _dip_size(depth: float, fast: float, first: float, mult: float, gain: float) -> float:
    """Ladder part (first at the trigger, all from mult deep) plus the speed bonus, in quarter steps, 0..1."""
    lad = 1.0 if (first >= 1.0 or depth >= mult) else first
    s = lad + gain * (fast - 1.0)
    s = min(max(s, 0.0), 1.0)
    return float(np.floor(s / STEP + 1e-9) * STEP)


def _snap(ts, c, lc, step, fast, p, reg) -> np.ndarray:
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
    ez = float(p["bear_z"])
    w = np.zeros(n)
    held = False
    size = 0.0
    zl, rl, tl, fl, el = z.tolist(), rsi.tolist(), trend.tolist(), fast.tolist(), (reg == -1).tolist()
    for i in range(n):
        zi, ri, ti = zl[i], rl[i], tl[i]
        if zi == zi and ri == ri and ti == ti:
            thr = (zu if ti > 0.0 else zd) * (ez if el[i] else 1.0)
            if held and ri > er:
                held, size = False, 0.0
            elif zi < -thr:
                held = True
                s = _dip_size(-zi / thr, fl[i], f1, lm, fg)
                if s > size:
                    size = s
        w[i] = size if held else 0.0
    return w


def _vdip(c, lc, step, vol, fast, p, reg) -> np.ndarray:
    n = len(c)
    nb = _bars(step, float(p["vdip_hours"]))
    z = (lc - np.log(_ema(c, nb))) / (vol * np.sqrt(nb))
    dz, ez = float(p["vdip_z"]), float(p["bear_z"])
    f1, lm, fg = float(p["ladder_first"]), float(p["ladder_mult"]), float(p["fast_gain"])
    w = np.zeros(n)
    rev = False
    size = 0.0
    zl, fl, el = z.tolist(), fast.tolist(), (reg == -1).tolist()
    for i in range(_bars(step, 24.0 * BASE_DAYS), n):
        di = dz * (ez if el[i] else 1.0)
        if rev and zl[i] > 0:
            rev, size = False, 0.0
        elif zl[i] < -di:
            rev = True
            s = _dip_size(-zl[i] / di, fl[i], f1, lm, fg)
            if s > size:
                size = s
        w[i] = size if rev else 0.0
    return w


def _macd(df, step, p) -> np.ndarray:
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


def _rides(df, lc, step, p, reg, hot):
    """Breakout ride and MACD ride on the given candles, each volatility-sized."""
    n = len(lc)
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(_ema(r * r, _bars(step, 24.0 * BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(_bars(step, 24.0 * 365.0))
    size = _q(float(p["target_vol"]) / yearly)
    brk = _breakout(lc, step, size, p, reg, hot)
    bull, bear = reg == 1, reg == -1
    add = np.where(bear, float(p["bear_macd"]), 0.0)
    mult = np.where(bull, float(p["bull_size"]), 1.0)
    ms = _q(float(p["macd_vol"]) * mult / yearly + add)          # at most all in
    ms = np.where(bull & hot, 0.0, ms)
    mac = _macd(df, step, p) * ms
    return brk, mac


def _hourly_rides(df, ts, p):
    """The rides decided on completed UTC 1-hour candles built from the bars, held until the next hour closes."""
    step = _step(ts)
    if step >= _HOUR:
        c = df["close"].to_numpy(np.float64)
        return _rides(df, np.log(np.maximum(c, 1e-12)), step, p, _btc_regime(ts, p), _hot(ts, c, p))
    hr = ts // _HOUR
    g = df.groupby(hr)
    hdf = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    hts = hdf.index.to_numpy(np.int64) * _HOUR
    hdf.index = hts
    hc = hdf["close"].to_numpy(np.float64)
    hlc = np.log(np.maximum(hc, 1e-12))
    hb, hm = _rides(hdf, hlc, float(_HOUR), p, _btc_regime(hts, p), _hot(hts, hc, p))
    gi = np.searchsorted(hts // _HOUR, hr)
    closing = (ts + int(step)) >= (hr + 1) * _HOUR
    pos = np.where(closing, gi, gi - 1)
    okp = pos >= 0
    pc = np.clip(pos, 0, None)
    return np.where(okp, hb[pc], 0.0), np.where(okp, hm[pc], 0.0)


LAYERS = ("break", "snap", "vdip", "macd")


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
    reg = _btc_regime(ts, p)
    out["break"], out["macd"] = _hourly_rides(df, ts, p)
    out["snap"] = _snap(ts, c, lc, step, fast, p, reg)
    out["vdip"] = _vdip(c, lc, step, vol, fast, p, reg)
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
    w = _weights(df, spec["params"])
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
    steps.append(f"MACD ride: at most {p['macd_vol']:g} divided by the coin's yearly volatility while the "
                 f"{p['macd_days']:g}-day MACD is positive, sold on a cross under zero after it reached {p['stretch']:g}.")
    xd = float(p["btc_exit_days"])
    bull_end = f" or under its {xd:g}-day average" if xd > 0 else ""
    steps.append(f"Bitcoin bull: while bitcoin's daily close is above its {p['btc_days']:g}-day average (it ends when "
                 f"bitcoin closes under it{bull_end}), both rides are {p['bull_size']:g} times their size (at most all "
                 f"in), and banking waits for {p['bull_gain']:g} times the gain and sells "
                 f"{round(100 * float(p['bull_take']))} %.")
    if float(p["breadth_days"]) > 0:
        steps.append(f"Market breadth: once at least {round(100 * float(p['br_in']))} % of the 10 coins close above their "
                     f"{p['breadth_days']:g}-day average, the bull also stays on (even when bitcoin dips) until fewer "
                     f"than {round(100 * float(p['br_out']))} % do.")
    if float(p["cyc_hot"]) < 8.99:
        steps.append(f"Overheated: in a bull, when the coin's last daily close is more than "
                     f"{np.exp(float(p['cyc_hot'])):.1f} times its {p['cycle_days']:g}-day average (a blow-off top), "
                     "the breakout and MACD rides stop.")
    if float(p["bear_days"]) > 0:
        steps.append(f"Bitcoin bear: while bitcoin's daily close is under its {p['bear_days']:g}-day average (and it "
                     f"is not a bull of either kind), the MACD ride adds {round(100 * float(p['bear_macd']))} % of all in to "
                     f"catch the recovery early, and both dips need {p['bear_z']:g} times their usual depth.")
    steps.append("Neither bull nor bear: everything above runs at its normal size. The book holds the largest "
                 "position any of these asks for.")
    return {
        "summary": (f"Dip and breakout on {mk} with bitcoin as the switch: in a bitcoin bull it rides new highs and the "
                    "MACD trend big and banks little, but stops riding once the coin is far above its long average; in a "
                    "bitcoin bear it buys only deeper dips and leans on the MACD ride for the way back "
                    "up; in between it rides small and buys panic dips in a ladder."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Market-wide crypto bull runs led by bitcoin, recoveries out of bitcoin bears, and fast panic "
                      "flushes that snap back within hours.",
        "whenItLoses": "A coin crashing while bitcoin still looks fine, and crashes that keep falling past the full ladder.",
    }
