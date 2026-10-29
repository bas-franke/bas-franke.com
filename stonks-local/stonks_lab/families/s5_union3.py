"""s5_union3: the Session 4 top three as one book, pruned to the layers that earn their place.

Session 5 stacked all five layers of the Session 4 top three (s4_hourly's breakout ride and hourly dip, s4_rsi2's
oversold snap, s4_voltarget's vol-sized trend and its dip) and kept the book in the coin whenever any layer wanted in.
Dropping layers one at a time showed the trend ride and the hourly dip cost points, so three remain:
  break  (from s4_hourly)    a close above the N-day high, ridden until price gives back G daily swings; sized like
                             s4_voltarget's trend: target_vol / yearly volatility, in quarter steps
  snap   (from s4_rsi2)      a sharp few-hour drop of Z normal moves (deeper under the daily trend), sold on RSI; all in
  vdip   (from s4_voltarget) a deep fall under a multi-hour average, sold back at it; all in
The book's weight is the largest weight any layer asks for. Strictly causal.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s5_union3"
VERSION = 1
TITLE = "Breakout plus two dips"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0   # volatility memory of the ride size and of the multi-hour dip
STEP = 0.25        # ride sizes move in quarter steps


def default_params() -> dict:
    return {
        "high_days": 27.0, "giveback": 3.0, "hvol_days": 8.25, "target_vol": 0.6,
        "snap_hours": 4.0, "snap_vol_days": 48.0, "z_up": 3.2, "z_down": 4.4, "snap_trend_days": 60.0,
        "exit_rsi": 55.0,
        "vdip_hours": 50.0, "vdip_z": 2.2,
    }


def param_space() -> dict:
    return {
        "high_days": {"type": "float", "min": 5.0, "max": 120.0, "description": "a close above the highest close of this many days starts a ride"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the ride ends this many daily swings below its peak"},
        "hvol_days": {"type": "float", "min": 2.0, "max": 60.0, "description": "days of history that set the daily swing of the ride exit"},
        "target_vol": {"type": "float", "min": 0.1, "max": 2.0, "description": "yearly volatility a full ride may carry; wilder coins ride smaller"},
        "snap_hours": {"type": "float", "min": 1.0, "max": 24.0, "description": "hours of the snap sell-off and of its exit RSI"},
        "snap_vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the snap's normal move"},
        "z_up": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves above the daily trend"},
        "z_down": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves below the daily trend"},
        "snap_trend_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in the daily trend that sets the snap depth"},
        "exit_rsi": {"type": "float", "min": 30.0, "max": 90.0, "description": "RSI level that sells the snap"},
        "vdip_hours": {"type": "float", "min": 6.0, "max": 240.0, "description": "hours in the average the slow dip is measured against"},
        "vdip_z": {"type": "float", "min": 0.5, "max": 5.0, "description": "volatility units under that average that buy the slow dip"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["high_days"]), float(p["hvol_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, BASE_DAYS) * 96)


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


def _breakout(lc, step, p) -> np.ndarray:
    """s4_hourly's ride: 0/1."""
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    nh = _bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    give = float(p["giveback"])
    w = np.zeros(n)
    ride = 0
    peak = 0.0
    ll, hl, sl = lc.tolist(), hi.tolist(), day_sd.tolist()
    for i in range(n):
        if ride == 0:
            if hl[i] == hl[i] and ll[i] > hl[i]:
                ride = 1
                peak = ll[i]
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - give * sl[i]:
                ride = 0
        w[i] = ride
    return w


def _snap(ts, c, lc, step, p) -> np.ndarray:
    """s4_rsi2's oversold snap: 0/1."""
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
    w = np.zeros(n)
    held = False
    zl, rl, tl = z.tolist(), rsi.tolist(), trend.tolist()
    for i in range(n):
        zi, ri, ti = zl[i], rl[i], tl[i]
        if zi == zi and ri == ri and ti == ti:
            if not held:
                if zi < -(zu if ti > 0.0 else zd):
                    held = True
            elif ri > er:
                held = False
        w[i] = 1.0 if held else 0.0
    return w


def _slow_dip(c, lc, step, p):
    """s4_voltarget's dip (0/1) and its ride size (target_vol / yearly vol, quarter steps)."""
    n = len(c)
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(_ema(r * r, _bars(step, 24.0 * BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(_bars(step, 24.0 * 365.0))
    size = np.floor(np.clip(float(p["target_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP
    nb = _bars(step, float(p["vdip_hours"]))
    z = (lc - np.log(_ema(c, nb))) / (vol * np.sqrt(nb))
    dz = float(p["vdip_z"])
    w = np.zeros(n)
    rev = False
    zl = z.tolist()
    for i in range(_bars(step, 24.0 * BASE_DAYS), n):
        if rev:
            if zl[i] > 0:
                rev = False
        elif zl[i] < -dz:
            rev = True
        w[i] = 1.0 if rev else 0.0
    return w, size


def layer_weights(df, p) -> dict[str, np.ndarray]:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    if n < 3:
        return {k: np.zeros(n) for k in ("break", "snap", "vdip")}
    step = _step(ts)
    lc = np.log(np.maximum(c, 1e-12))
    vdip, size = _slow_dip(c, lc, step, p)
    return {"break": _breakout(lc, step, p) * size, "snap": _snap(ts, c, lc, step, p), "vdip": vdip}


def _weights(df, p) -> np.ndarray:
    lw = layer_weights(df, p)
    return np.maximum(np.maximum(lw["break"], lw["snap"]), lw["vdip"])


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    w = _weights(df, spec["params"])
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (f"Rides {mk} breakouts to new {p['high_days']:g}-day highs with a volatility-sized position, and "
                    "buys deep panic dips all in for the bounce. In cash otherwise."),
        "howItWorks": [
            f"Ride: a close above the highest close of the last {p['high_days']:g} days buys. The ride ends when price "
            f"falls {p['giveback']:g} daily swings (measured over {p['hvol_days']:g} days) below its best since the buy.",
            f"Ride size: {p['target_vol']:g} divided by the coin's yearly volatility over the last 30 days, at most all "
            "in, in quarter steps. A wild coin or a stormy stretch rides smaller.",
            f"Snap dip: a {p['snap_hours']:g}-hour fall of {p['z_up']:g} normal moves (normal = the last "
            f"{p['snap_vol_days']:g} days) buys all in; {p['z_down']:g} are needed when the coin is under its "
            f"{p['snap_trend_days']:g}-day trend. It sells when the {p['snap_hours']:g}-hour RSI tops {p['exit_rsi']:g}.",
            f"Slow dip: a fall of {p['vdip_z']:g} volatility units under the {p['vdip_hours']:g}-hour average buys all "
            "in; it sells once price is back at that average.",
            "The book holds the largest position any of the three asks for.",
        ] + risk_steps(spec),
        "whenItWins": "Long climbs that keep making new highs, and panic flushes that snap back within hours or days.",
        "whenItLoses": "Breakouts that fail right after the buy, and slow bleeds that keep tripping the dip buys.",
    }
