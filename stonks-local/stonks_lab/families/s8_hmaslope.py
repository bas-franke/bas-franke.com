"""s8_hmaslope: s7_ladder plus a trend core sized by the slope of a smooth daily line.

core     a Hull MA (or linear regression / KAMA) of completed daily log closes; its slope per day over slope_days,
         divided by the daily volatility, is the trend strength in volatility units. Once it tops core_on the book
         holds a core of core_gain x strength (at most core_max, quarter steps) until it falls under core_off.
         It sits under ladder's layers: the book holds the largest of all of them.
The rest is s7_ladder:

Built on s4_hourly (Dip and breakout) through s6_hourbars, with the two Session 6 findings that cut drawdown and lifted
the score combined in one dip sizing rule:
  speed   (s6_kelly)     a dip whose last hour fell hard (in normal moves of a long volatility memory) bounces more;
                         slow drifts barely pay their fees, so they get a small slice or none
  ladder  (s6_ddcontrol) a dip buys a slice at its trigger and the rest only when it gets ladder_mult times as deep,
                         so a crash meets a part-sized book first and is bought in full nearer its low
  dip size = ladder part (ladder_first at the trigger, 1 from ladder_mult deep) + fast_gain x (speed - 1),
  in quarter steps, 0..1, raised (never lowered) while the dip trade is open.
Layers (the book holds the largest):
  break  a close above the N-day high (optionally only above the gate_days daily average), ridden until price gives
         back G daily swings; sized target_vol / yearly volatility; half banked at +take_gain and again at twice it
  snap   a sharp k-hour fall of Z normal moves (deeper under the daily trend), sold when RSI(k) tops exit_rsi
  vdip   a deep fall under a multi-hour average, sold back at it
  macd   Session 3's slow MACD ride, sized macd_vol / yearly volatility
Strictly causal; lengths in hours/days are converted with the bar step (15-minute bars by default).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s8_hmaslope"
VERSION = 1
TITLE = "Dip and breakout, slope core"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0
STEP = 0.25


def default_params() -> dict:
    return {
        "high_days": 27.0, "giveback": 3.9, "hvol_days": 11.0, "target_vol": 0.8, "gate_days": 0.0,
        "take_gain": 0.15, "take_frac": 0.5,
        "snap_hours": 4.0, "snap_vol_days": 55.0, "z_up": 3.0, "z_down": 4.4, "snap_trend_days": 60.0,
        "exit_rsi": 50.0,
        "vdip_hours": 40.0, "vdip_z": 2.2,
        "ladder_first": 0.5, "ladder_mult": 1.25, "fast_gain": 1.0, "fast_z": 4.0, "speed_vdip": 1.0,
        "s_macd": 1.0, "macd_days": 26.0, "stretch": 1.0, "macd_vol": 0.6, "ride_1h": 1.0,
        "smooth": "hma", "smooth_days": 72.0, "slope_days": 10.0, "core_vol_days": 30.0,
        "core_on": 0.12, "core_off": 0.06, "core_gain": 6.0, "core_max": 0.75, "core_give": 0.0, "core_step": 0.5,
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
        "smooth": {"type": "choice", "values": ["hma", "linreg", "kama"], "description": "the smooth daily line whose slope sizes the core"},
        "smooth_days": {"type": "float", "min": 4.0, "max": 200.0, "description": "days in the smooth daily line"},
        "slope_days": {"type": "float", "min": 1.0, "max": 60.0, "description": "days over which the line's slope is measured"},
        "core_vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the daily volatility the slope is measured in"},
        "core_on": {"type": "float", "min": 0.0, "max": 2.0, "description": "slope (daily volatility units per day) that starts the core"},
        "core_off": {"type": "float", "min": -1.0, "max": 2.0, "description": "slope under which the core is sold"},
        "core_gain": {"type": "float", "min": 0.0, "max": 20.0, "description": "core size per unit of slope"},
        "core_max": {"type": "float", "min": 0.0, "max": 1.0, "description": "largest core (0 = off)"},
        "core_step": {"type": "float", "min": 0.0, "max": 1.0, "description": "the core is resized only when its slope-based size moved at least this much (fewer small trades)"},
        "core_give": {"type": "float", "min": 0.0, "max": 30.0, "description": "the core is also sold when the daily close falls this many daily swings under its best close since the buy, and waits for a new high or a fresh slope cross (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["core_off"]) > float(p["core_on"]):
        return "core_off must not exceed core_on"
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["high_days"]), float(p["hvol_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, float(p["gate_days"]) + 1, BASE_DAYS,
                   3 * float(p["macd_days"]), 2 * float(p["smooth_days"]) + float(p["slope_days"]),
                   float(p["core_vol_days"])) * 96)


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
    w = np.zeros(n)
    ride = level = 0
    peak = entry = sz = 0.0
    ll, hl, sl, zl, okl = lc.tolist(), hi.tolist(), day_sd.tolist(), size.tolist(), ok.tolist()
    for i in range(n):
        if ride == 0:
            if hl[i] == hl[i] and ll[i] > hl[i] and zl[i] > 0 and okl[i]:
                ride, peak, entry, level, sz = 1, ll[i], ll[i], 0, zl[i]
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - give * sl[i]:
                ride = 0
            else:
                while level < 2 and peak - entry >= tg * (level + 1):
                    level += 1
        w[i] = sz * (1.0 - tf) ** level if ride else 0.0
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
        hb, hm = _hourly_rides(df, ts, p)
        out["break"], out["macd"] = hb, hm
    else:
        out["break"], out["macd"] = _rides(df, ts, c, lc, step, p)
    out["snap"] = _snap(ts, c, lc, step, fast, p)
    out["vdip"] = _vdip(c, lc, step, vol, fast, p)
    out["core"] = _core(ts, c, p)
    return out


def _wma(x: np.ndarray, n: int) -> np.ndarray:
    n = max(1, int(n))
    w = np.arange(1, n + 1, dtype=np.float64)
    return pd.Series(x).rolling(n, min_periods=n).apply(lambda a: a @ w, raw=True).to_numpy() / w.sum()


def _smooth_slope(y: np.ndarray, kind: str, n: int, k: int) -> np.ndarray:
    """Slope per day of a smooth line through the daily log closes y (causal)."""
    if kind == "linreg":
        m = max(3, n)
        x = np.arange(m, dtype=np.float64) - (m - 1) / 2.0
        den = float(x @ x)
        return pd.Series(y).rolling(m, min_periods=m).apply(lambda a: a @ x, raw=True).to_numpy() / den
    if kind == "kama":
        m = max(2, n)
        ch = np.abs(y - np.r_[np.full(m, np.nan), y[:-m]])
        pv = pd.Series(np.abs(np.diff(y, prepend=y[0]))).rolling(m, min_periods=m).sum().to_numpy()
        er = np.where(pv > 0, ch / np.where(pv > 0, pv, 1.0), 0.0)
        sc = (er * (2.0 / 3.0 - 2.0 / 31.0) + 2.0 / 31.0) ** 2
        line = np.full(len(y), np.nan)
        kv = None
        for i in range(len(y)):
            if sc[i] != sc[i]:
                continue
            kv = y[i] if kv is None else kv + sc[i] * (y[i] - kv)
            line[i] = kv
    else:
        m = max(4, n)
        raw = 2.0 * _wma(y, m // 2) - _wma(y, m)
        line = _wma(raw, max(2, int(round(np.sqrt(m)))))
    out = np.full(len(y), np.nan)
    if len(y) > k:
        out[k:] = (line[k:] - line[:-k]) / k
    return out


def _core(ts, c, p) -> np.ndarray:
    """Trend core from completed UTC days, known from the first bar of the next day."""
    n = len(c)
    cm = float(p["core_max"])
    if cm <= 0 or n < 3:
        return np.zeros(n)
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, y = d[last], np.log(np.maximum(c[last], 1e-12))
    r = np.r_[0.0, np.diff(y)]
    sd = np.sqrt(_ema(r * r, max(2, int(round(float(p["core_vol_days"]))))))
    sl = _smooth_slope(y, str(p["smooth"]), max(2, int(round(float(p["smooth_days"])))),
                       max(1, int(round(float(p["slope_days"])))))
    z = sl / np.maximum(sd, 1e-9)
    on, off, gain = float(p["core_on"]), float(p["core_off"]), float(p["core_gain"])
    give, hyst = float(p["core_give"]), float(p["core_step"])
    wd = np.zeros(len(dd))
    held = False
    blocked = False
    peak = bar = cur = 0.0
    yl, sl_ = y.tolist(), sd.tolist()
    for i, zi in enumerate(z.tolist()):
        if zi != zi or i < 20:
            continue
        if blocked and (zi < off or yl[i] > bar):
            blocked = False
        if held:
            peak = max(peak, yl[i])
            if zi < off:
                held = False
            elif give > 0 and yl[i] < peak - give * sl_[i]:
                held, blocked, bar = False, True, peak
        elif zi > on and not blocked:
            held, peak = True, yl[i]
        if held:
            t = np.floor(min(max(gain * zi, 0.0), cm) / STEP + 1e-9) * STEP
            if abs(t - cur) >= hyst - 1e-9 or t == 0.0 or cur == 0.0:
                cur = t
            wd[i] = cur
        else:
            cur = 0.0
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, wd[np.clip(pos, 0, None)], 0.0)


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
        ms = float(p["s_macd"])
        if float(p["macd_vol"]) > 0:
            ms = np.minimum(ms, np.floor(np.clip(float(p["macd_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP)
        mac = _macd(df, lc, step, p) * ms
    return brk, mac


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
    hb, hm = _rides(hdf, hts, hc, hlc, float(_HOUR), p)
    gi = np.searchsorted(hdf.index.to_numpy(np.int64) // _HOUR, hr)
    closing = (ts + int(step)) >= (hr + 1) * _HOUR
    pos = np.where(closing, gi, gi - 1)
    okp = pos >= 0
    pc = np.clip(pos, 0, None)
    return np.where(okp, hb[pc], 0.0), np.where(okp, hm[pc], 0.0)


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
    if float(p["core_max"]) > 0:
        line = {"hma": "Hull moving average", "linreg": "linear regression line", "kama": "Kaufman adaptive average"}
        steps.append(f"Trend core: the {p['smooth_days']:g}-day {line.get(str(p['smooth']), 'smooth line')} of daily "
                     f"closes; its climb per day over {p['slope_days']:g} days, in daily swings, is the trend strength. "
                     f"Above {p['core_on']:g} the book keeps a core of {p['core_gain']:g} x strength (at most "
                     f"{round(100 * float(p['core_max']))} %, resized only in steps of "
                     f"{round(100 * float(p['core_step']))} %), sold once the strength drops under {p['core_off']:g}.")
    steps.append("The book holds the largest position any of these asks for.")
    return {
        "summary": (f"Dip and breakout on {mk} with a trend core: holds a slice of the coin while a smooth daily "
                    "line climbs clearly, sized by how steep it climbs, and on top rides new highs and buys panic dips "
                    "in a ladder."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long multi-month rallies (the core stays in), and fast panic flushes that snap back within hours.",
        "whenItLoses": "The first weeks of a crash after a rally, while the slow line still climbs, and breakouts that fail right after the buy.",
    }
