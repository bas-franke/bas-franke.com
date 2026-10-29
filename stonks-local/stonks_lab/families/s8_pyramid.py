"""s8_pyramid: Dip and breakout (s7_ladder) plus a pyramiding mountain ride.

Session 8, angle "pyramid": instead of only banking a ride as it gains, ADD to it. Two ways were built:
  per-ride adds   the breakout ride (and optionally the MACD ride) adds add_frac of the room up to pyr_max per add_gain
                  of gain or per new add_days high (add_frac = 0 by default: it hurt chop more than it helped mountains)
  mountain ride   once the coin is m_start (log) above its m_days low and above its m_trend_days average, buy m_size and
                  add m_frac per further m_step of gain, up to pyr_max, never shrinking while on; the whole stack is sold
                  m_give daily swings below its peak, and only comes back above that exit's peak or after a new low.
Everything else is s7_ladder (laddered dips sized by fall speed, banked breakout ride, MACD ride), the book holds the
largest layer. Strictly causal; lengths in hours/days are converted with the bar step (15-minute bars by default).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s8_pyramid"
VERSION = 1
TITLE = "Dip and breakout, pyramid ride"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0
STEP = 0.25


def default_params() -> dict:
    return {
        "high_days": 27.0, "giveback": 3.9, "hvol_days": 14.0, "target_vol": 0.8, "gate_days": 0.0,
        "take_gain": 0.12, "take_frac": 0.5,
        "add_gain": 0.15, "add_frac": 0.0, "pyr_max": 0.75, "add_days": 0.0, "stack_give": 1.0, "macd_add": 0.0,
        "shed_give": 0.0, "add_trend_days": 0.0,
        "m_size": 0.25, "m_days": 200.0, "m_start": 0.5, "m_step": 0.2, "m_frac": 0.5, "m_give": 4.0, "m_trend_days": 50.0,
        "snap_hours": 4.0, "snap_vol_days": 55.0, "z_up": 3.0, "z_down": 4.4, "snap_trend_days": 60.0,
        "exit_rsi": 50.0,
        "vdip_hours": 40.0, "vdip_z": 2.2,
        "ladder_first": 0.5, "ladder_mult": 1.25, "fast_gain": 1.0, "fast_z": 4.0, "speed_vdip": 1.0,
        "s_macd": 1.0, "macd_days": 26.0, "stretch": 1.0, "macd_vol": 0.65, "ride_1h": 1.0,
    }


def param_space() -> dict:
    return {
        "high_days": {"type": "float", "min": 5.0, "max": 120.0, "description": "a close above the highest close of this many days starts a ride"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the ride ends this many daily swings below its peak"},
        "hvol_days": {"type": "float", "min": 2.0, "max": 60.0, "description": "days of history that set the daily swing of the ride exit"},
        "target_vol": {"type": "float", "min": 0.1, "max": 3.0, "description": "yearly volatility a full ride may carry; wilder coins ride smaller"},
        "gate_days": {"type": "float", "min": 0.0, "max": 300.0, "description": "a ride only starts above this many days' daily average (0 = no gate)"},
        "take_gain": {"type": "float", "min": 0.02, "max": 2.0, "description": "log gain of a ride (peak over buy) at which part of it is banked; again at twice it"},
        "take_frac": {"type": "float", "min": 0.0, "max": 0.9, "description": "share of what still rides that each of the two banking steps sells"},
        "add_gain": {"type": "float", "min": 0.02, "max": 2.0, "description": "each step of this log gain (peak over buy) adds to the ride"},
        "add_frac": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of the room up to pyr_max that each add step buys (0 = no pyramiding)"},
        "pyr_max": {"type": "float", "min": 0.0, "max": 1.0, "description": "largest size the ride may grow to by adding"},
        "add_days": {"type": "float", "min": 0.0, "max": 120.0, "description": "a new high of this many days while riding also adds a step (0 = off)"},
        "stack_give": {"type": "float", "min": 0.2, "max": 3.0, "description": "the giveback exit is this times as wide once the ride has added"},
        "shed_give": {"type": "float", "min": 0.0, "max": 10.0, "description": "the added part is sold this many daily swings below the peak, the base keeps riding; adding restarts from that peak (0 = off)"},
        "add_trend_days": {"type": "float", "min": 0.0, "max": 300.0, "description": "the ride only adds above this many days' daily average (0 = always)"},
        "m_size": {"type": "float", "min": 0.0, "max": 1.0, "description": "mountain ride: size it starts at once the coin is m_start above its m_days low (0 = off)"},
        "m_days": {"type": "float", "min": 20.0, "max": 400.0, "description": "days back the mountain ride looks for the coin's low"},
        "m_start": {"type": "float", "min": 0.1, "max": 2.0, "description": "log gain over that low that starts the mountain ride (0.69 = doubled)"},
        "m_step": {"type": "float", "min": 0.05, "max": 2.0, "description": "each further step of this log gain adds m_frac to the mountain ride"},
        "m_frac": {"type": "float", "min": 0.0, "max": 1.0, "description": "size the mountain ride adds per step, up to pyr_max"},
        "m_give": {"type": "float", "min": 0.8, "max": 20.0, "description": "the mountain ride (the whole stack) ends this many daily swings below its peak"},
        "m_trend_days": {"type": "float", "min": 0.0, "max": 300.0, "description": "the mountain ride only starts above this many days' daily average (0 = no gate)"},
        "macd_add": {"type": "float", "min": 0.0, "max": 2.0, "description": "the MACD ride adds a step every this log gain over its buy, like the breakout ride (0 = off)"},
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
        "speed_vdip": {"type": "float", "min": 0.0, "max": 1.0, "description": "how much the speed rule also sizes the slow dip (0 = only the snap)"},
        "s_macd": {"type": "float", "min": 0.0, "max": 1.0, "description": "position the MACD ride takes (0 = off)"},
        "macd_days": {"type": "float", "min": 10.0, "max": 60.0, "description": "days in the MACD ride"},
        "stretch": {"type": "float", "min": 0.0, "max": 1.2, "description": "how high the MACD histogram must have been before a cross under zero sells"},
        "macd_vol": {"type": "float", "min": 0.0, "max": 3.0, "description": "yearly volatility a full MACD ride may carry (0 = always its full share)"},
        "ride_1h": {"type": "float", "min": 0.0, "max": 1.0, "description": "1 = decide the two rides on completed 1-hour candles, 0 = on the book's own candles"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["high_days"]), float(p["hvol_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, float(p["gate_days"]) + 1, BASE_DAYS,
                   3 * float(p["macd_days"]), float(p["m_days"]), float(p["m_trend_days"]) + 1,
                   float(p["add_days"]), float(p["add_trend_days"]) + 1) * 96)


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


def _breakout(ts, c, lc, step, size, p) -> np.ndarray:
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    nh = _bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    gd = float(p["gate_days"])
    if gd > 0:
        g = _prev_day_ema(ts, c, gd)
        ok = np.where(np.isfinite(g), lc > np.log(np.where(np.isfinite(g), g, 1.0)), False)
    else:
        ok = np.ones(n, dtype=bool)
    give, tg, tf = float(p["giveback"]), float(p["take_gain"]), float(p["take_frac"])
    ag, af, pm, sg = float(p["add_gain"]), float(p["add_frac"]), float(p["pyr_max"]), float(p["stack_give"])
    ad = float(p["add_days"])
    if ad > 0:
        na = _bars(step, 24.0 * ad)
        ahi = pd.Series(lc).rolling(na, min_periods=na).max().shift(1).to_numpy()
    else:
        ahi = np.full(n, np.nan)
    shg = float(p["shed_give"])
    atd = float(p["add_trend_days"])
    if atd > 0:
        tg_ = _prev_day_ema(ts, c, atd)
        aok = np.where(np.isfinite(tg_), lc > np.log(np.where(np.isfinite(tg_), tg_, 1.0)), False)
    else:
        aok = np.ones(n, dtype=bool)
    aokl = aok.tolist()
    w = np.zeros(n)
    ride = level = gadds = hadds = 0
    peak = entry = sz = base = 0.0
    prev_new = False
    ll, hl, sl, zl, okl, al = lc.tolist(), hi.tolist(), day_sd.tolist(), size.tolist(), ok.tolist(), ahi.tolist()
    for i in range(n):
        if ride == 0:
            if hl[i] == hl[i] and ll[i] > hl[i] and zl[i] > 0 and okl[i]:
                ride, peak, entry, level, gadds, hadds, sz = 1, ll[i], ll[i], 0, 0, 0, zl[i]
                base = entry
                prev_new = True
        else:
            if ll[i] > peak:
                peak = ll[i]
            g = give * (sg if (gadds + hadds) > 0 else 1.0)
            if ll[i] < peak - g * sl[i]:
                ride = 0
            else:
                while level < 2 and peak - entry >= tg * (level + 1):
                    level += 1
                if shg > 0 and (gadds + hadds) > 0 and ll[i] < peak - shg * sl[i]:
                    gadds = hadds = 0
                    base = peak
                if af > 0 and aokl[i]:
                    gadds = max(gadds, int((peak - base) / ag + 1e-9))
                    new_hi = al[i] == al[i] and ll[i] > al[i]
                    if new_hi and not prev_new:
                        hadds += 1
                    prev_new = new_hi
        if ride:
            k = gadds + hadds
            cur = sz + max(pm - sz, 0.0) * (1.0 - (1.0 - af) ** k) if k > 0 else sz
            v = cur * (1.0 - tf) ** level
            w[i] = min(np.floor(v / STEP + 1e-9) * STEP, 1.0)
    return w


def _mount(ts, c, lc, step, p) -> np.ndarray:
    """Mountain ride: once the coin is m_start (log) above its m_days low, buy m_size and add m_frac per further m_step
    of gain (never shrinking while on); the whole stack is sold m_give daily swings below its peak. After an exit it
    only comes back above that exit's peak or once a new low resets the climb."""
    n = len(lc)
    ms = float(p["m_size"])
    if ms <= 0:
        return np.zeros(n)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    nb = _bars(step, 24.0 * float(p["m_days"]))
    lo = pd.Series(lc).rolling(nb, min_periods=nb).min().to_numpy()
    td = float(p["m_trend_days"])
    if td > 0:
        g = _prev_day_ema(ts, c, td)
        ok = np.where(np.isfinite(g), lc > np.log(np.where(np.isfinite(g), g, 1.0)), False)
    else:
        ok = np.ones(n, dtype=bool)
    st, sp, fr, gv, pm = float(p["m_start"]), float(p["m_step"]), float(p["m_frac"]), float(p["m_give"]), float(p["pyr_max"])
    w = np.zeros(n)
    on = False
    peak = size = 0.0
    block = np.inf
    block_lo = np.nan
    ll, lol, sl, okl = lc.tolist(), lo.tolist(), day_sd.tolist(), ok.tolist()
    for i in range(n):
        li, low = ll[i], lol[i]
        if low != low:
            continue
        gain = li - low
        if not on:
            if block_lo == block_lo and low < block_lo - 1e-12:
                block = np.inf
            if gain >= st and okl[i] and (block == np.inf or li > block):
                on, peak, size, block = True, li, 0.0, np.inf
        if on:
            if li > peak:
                peak = li
            if li < peak - gv * sl[i]:
                on, block, block_lo, size = False, peak, low, 0.0
            else:
                k = int(max(gain - st, 0.0) / sp + 1e-9)
                s = min(pm, ms + fr * k)
                if s > size:
                    size = s
        w[i] = np.floor(size / STEP + 1e-9) * STEP if on else 0.0
    return w


def _dip_size(depth: float, fast: float, first: float, mult: float, gain: float) -> float:
    """Ladder part (first at the trigger, all from mult deep) plus the speed bonus, in quarter steps, 0..1."""
    lad = 1.0 if (first >= 1.0 or depth >= mult) else first
    s = lad + gain * (fast - 1.0)
    s = min(max(s, 0.0), 1.0)
    return float(np.floor(s / STEP + 1e-9) * STEP)


def _snap(ts, c, lc, step, fast, p) -> np.ndarray:
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
    zl, rl, tl, fl = z.tolist(), rsi.tolist(), trend.tolist(), fast.tolist()
    for i in range(n):
        zi, ri, ti = zl[i], rl[i], tl[i]
        if zi == zi and ri == ri and ti == ti:
            thr = zu if ti > 0.0 else zd
            if held and ri > er:
                held, size = False, 0.0
            elif zi < -thr:
                held = True
                s = _dip_size(-zi / thr, fl[i], f1, lm, fg)
                if s > size:
                    size = s
        w[i] = size if held else 0.0
    return w


def _vdip(c, lc, step, vol, fast, p) -> np.ndarray:
    n = len(c)
    nb = _bars(step, float(p["vdip_hours"]))
    z = (lc - np.log(_ema(c, nb))) / (vol * np.sqrt(nb))
    dz = float(p["vdip_z"])
    f1, lm = float(p["ladder_first"]), float(p["ladder_mult"])
    fg = float(p["fast_gain"]) * float(p["speed_vdip"])
    w = np.zeros(n)
    rev = False
    size = 0.0
    zl, fl = z.tolist(), fast.tolist()
    for i in range(_bars(step, 24.0 * BASE_DAYS), n):
        if rev and zl[i] > 0:
            rev, size = False, 0.0
        elif zl[i] < -dz:
            rev = True
            s = _dip_size(-zl[i] / dz, fl[i], f1, lm, fg)
            if s > size:
                size = s
        w[i] = size if rev else 0.0
    return w


def _macd(df, lc, step, p, base) -> np.ndarray:
    """The MACD ride at size base (array); with macd_add > 0 it adds add_frac of the room to pyr_max per step of gain."""
    reading = compute("macd", df, max(2, int(round(float(p["macd_days"]) * _DAY / step))))
    level = float(p["stretch"])
    ma, af, pm = float(p["macd_add"]), float(p["add_frac"]), float(p["pyr_max"])
    w = np.zeros(len(reading))
    held = False
    peak, prev = -1e9, np.nan
    entry = top = sz = 0.0
    k = 0
    ll, bl = lc.tolist(), np.asarray(base, float).tolist()
    for i, v in enumerate(np.asarray(reading, float).tolist()):
        if v != v:
            prev = np.nan
            continue
        if not held:
            if v > 0.0 and not (prev > 0.0):
                held, peak = True, v
                entry = top = ll[i]
                sz, k = bl[i], 0
        else:
            peak = max(peak, v)
            if prev > 0.0 and v <= 0.0 and peak >= level:
                held, peak = False, -1e9
        if held:
            if ll[i] > top:
                top = ll[i]
            if ma > 0 and af > 0:
                k = max(k, int((top - entry) / ma + 1e-9))
            cur = sz + max(pm - sz, 0.0) * (1.0 - (1.0 - af) ** k) if k > 0 else sz
            w[i] = min(np.floor(cur / STEP + 1e-9) * STEP, 1.0)
        prev = v
    return w


LAYERS = ("break", "snap", "vdip", "macd", "mount")


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
    # speed of the fall: the last hour's log move in normal moves of the long (snap_vol_days) memory
    per_hour = _HOUR / step
    k1 = max(1, int(round(per_hour)))
    span = max(2, int(round(float(p["snap_vol_days"]) * 24 * per_hour)))
    sig = np.sqrt(pd.Series(r * r).ewm(span=span, min_periods=span).mean().to_numpy())
    d1 = np.full(n, np.nan)
    if n > k1:
        d1[k1:] = lc[k1:] - lc[:-k1]
    z1 = d1 / np.maximum(sig * np.sqrt(k1), 1e-12)
    fast = np.clip(np.nan_to_num(-z1, nan=0.0) / float(p["fast_z"]), 0.0, 2.0)
    if float(p["ride_1h"]) > 0.5 and step < _HOUR:
        hb, hm, hx = _hourly_rides(df, ts, p)
        out["break"], out["macd"], out["mount"] = hb, hm, hx
    else:
        out["break"], out["macd"], out["mount"] = _rides(df, ts, c, lc, step, p)
    out["snap"] = _snap(ts, c, lc, step, fast, p)
    out["vdip"] = _vdip(c, lc, step, vol, fast, p)
    return out


def _rides(df, ts, c, lc, step, p):
    """Breakout ride and MACD ride on the given candles, each volatility-sized."""
    n = len(c)
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(_ema(r * r, _bars(step, 24.0 * BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(_bars(step, 24.0 * 365.0))
    size = np.floor(np.clip(float(p["target_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP
    brk = _breakout(ts, c, lc, step, size, p)
    mac = np.zeros(n)
    if float(p["s_macd"]) > 0:
        ms = np.full(n, float(p["s_macd"]))
        if float(p["macd_vol"]) > 0:
            ms = np.minimum(ms, np.floor(np.clip(float(p["macd_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP)
        mac = _macd(df, lc, step, p, ms)
    return brk, mac, _mount(ts, c, lc, step, p)


def _hourly_rides(df, ts, p):
    """The rides decided on completed UTC 1-hour candles built from the bars, held until the next hour closes.

    An hour counts as complete at its last bar (the bar whose end reaches the next hour), so the decision is taken at
    that bar's close, exactly when a 1-hour book would see it; earlier bars of a forming hour use the previous hour."""
    step = _step(ts)
    hr = ts // _HOUR
    g = df.groupby(hr)
    hdf = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    hts = hdf.index.to_numpy(np.int64) * _HOUR
    hdf.index = hts
    hc = hdf["close"].to_numpy(np.float64)
    hlc = np.log(np.maximum(hc, 1e-12))
    hb, hm, hx = _rides(hdf, hts, hc, hlc, float(_HOUR), p)
    gi = np.searchsorted(hdf.index.to_numpy(np.int64) // _HOUR, hr)
    closing = (ts + int(step)) >= (hr + 1) * _HOUR
    pos = np.where(closing, gi, gi - 1)
    okp = pos >= 0
    pc = np.clip(pos, 0, None)
    return np.where(okp, hb[pc], 0.0), np.where(okp, hm[pc], 0.0), np.where(okp, hx[pc], 0.0)


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
    gate = (f" Only above the {p['gate_days']:g}-day daily average." if float(p["gate_days"]) > 0 else "")
    steps = [
        f"Ride: a close above the highest close of the last {p['high_days']:g} days buys, sized "
        f"{p['target_vol']:g} divided by the coin's yearly volatility (at most all in).{gate} It ends when price falls "
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
    if float(p["s_macd"]) > 0:
        steps.append(f"MACD ride: at most {p['macd_vol']:g} divided by the coin's yearly volatility while the "
                     f"{p['macd_days']:g}-day MACD is positive, sold on a cross under zero after it reached {p['stretch']:g}.")
    if float(p["m_size"]) > 0:
        steps.append(f"Mountain ride: once the coin is {(np.exp(float(p['m_start'])) - 1) * 100:.0f} % above its "
                     f"{p['m_days']:g}-day low and above its {p['m_trend_days']:g}-day average, buy "
                     f"{round(100 * float(p['m_size']))} %, and add {round(100 * float(p['m_frac']))} % for every further "
                     f"{(np.exp(float(p['m_step'])) - 1) * 100:.0f} % up, to at most {round(100 * float(p['pyr_max']))} %. "
                     f"The whole stack is sold {p['m_give']:g} daily swings below its best; it comes back only above "
                     "that best or after a new low.")
    steps.append("The book holds the largest position any of these asks for.")
    return {
        "summary": (f"Dip and breakout on {mk}: rides new highs and a slow MACD trend with volatility-sized positions, "
                    "buys panic dips in a ladder, and stacks up a bigger position as a big rally keeps climbing."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Fast panic flushes that snap back within hours, and months-long rallies where the coin doubles and keeps going.",
        "whenItLoses": "Breakouts that fail right after the buy, crashes past the full ladder, and the first leg down after a big rally tops.",
    }
