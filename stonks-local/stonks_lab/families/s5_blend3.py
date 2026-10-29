"""s5_blend3: three Session 4 books share one account; the position is the share-weighted sum of their positions.

The books (copied from s4_hourly, s4_rsi2 and s4_voltarget at their Session 4 tuned settings, kept standalone):
  breakout  27-day-high breakout ridden until it gives back 3 daily swings, plus a buy 2.2 swings under the
            9-hour average sold back near it (s4_hourly "Dip and breakout")
  snap      a 4-hour drop of 3.2 normal moves (4.4 under the 60-day EMA) bought, sold when the 4-hour RSI > 55
            (s4_rsi2 "Oversold snap")
  trend     18-day trend with a vol-scaled band and trail, sized 0.6 / yearly vol; out of trend, buy a 2.2-swing
            dip under the 50-hour average (s4_voltarget)
Each book owns a share of the account (its own 0/1 or sized position times its share). The shares may add up to
more than 1: then two books that agree put more in, but the total is capped at all in. One shared knob, ``depth``,
scales every dip threshold of the three books together. Strictly causal: every book only uses bars up to t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s5_blend3"
VERSION = 1
TITLE = "Three-book blend"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000


def default_params() -> dict:
    return {"s_breakout": 0.3, "s_snap": 0.5, "s_trend": 0.9, "depth": 1.0}


def param_space() -> dict:
    return {
        "s_breakout": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of the account the breakout book owns"},
        "s_snap": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of the account the oversold-snap book owns"},
        "s_trend": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of the account the volatility-sized trend book owns"},
        "depth": {"type": "float", "min": 0.5, "max": 2.0, "description": "multiplies how deep a dip must be in all three books (1 = Session 4 settings)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["s_breakout"]) + float(p["s_snap"]) + float(p["s_trend"]) <= 0:
        return "at least one book needs a share"
    return None


def warmup(p: dict) -> int:
    return int(61 * 96)


def _step(index) -> float:
    ts = np.asarray(index, dtype=np.int64)
    if len(ts) < 2:
        return 900_000.0
    return max(float(np.median(np.diff(ts))), 1.0)


def _nbars(step: float, hours: float) -> int:
    return max(2, int(round(hours * _HOUR / step)))


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    return pd.Series(x).ewm(span=max(1, int(span)), adjust=False).mean().to_numpy(np.float64)


# ------------------------------------------------------------------ book 1: breakout + short dip (s4_hourly)
def _breakout(df, depth: float, dip_hours=9.0, dip_depth=2.2, dip_exit=-0.55, vol_days=8.25, high_days=27.0,
              giveback=3.0) -> np.ndarray:
    c = df["close"].to_numpy(dtype=np.float64)
    n = len(c)
    if n == 0:
        return np.zeros(0)
    step = _step(df.index)
    lc = np.log(np.maximum(c, 1e-12))
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _nbars(step, 24.0 * vol_days))
    nd = _nbars(step, dip_hours)
    mean = _ema(lc, nd)
    z = (lc - mean) / np.maximum(np.sqrt(var_bar * nd), 1e-9)
    nh = _nbars(step, 24.0 * high_days)
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _nbars(step, 24.0))
    k = dip_depth * depth
    ex = max(dip_exit, -0.9 * k)
    w = np.zeros(n)
    dip = ride = 0
    peak = 0.0
    zl, ll, hl, sl = z.tolist(), lc.tolist(), hi.tolist(), day_sd.tolist()
    for i in range(n):
        if dip == 0:
            if zl[i] < -k:
                dip = 1
        elif zl[i] > ex:
            dip = 0
        if ride == 0:
            if hl[i] == hl[i] and ll[i] > hl[i]:
                ride = 1
                peak = ll[i]
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - giveback * sl[i]:
                ride = 0
        w[i] = 1.0 if (dip or ride) else 0.0
    return w


# ------------------------------------------------------------------ book 2: oversold snap (s4_rsi2)
def _prev_day_ema(ts: np.ndarray, c: np.ndarray, days: float) -> np.ndarray:
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    e = ind.ema(dc, max(2, int(round(days))))
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, e[np.clip(pos, 0, None)], np.nan)


def _snap(df, depth: float, hours=4.0, vol_days=48.0, z_up=3.2, z_down=4.4, trend_days=60.0,
          exit_rsi=55.0) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    if n < 3:
        return np.zeros(n)
    per_hour = _HOUR / _step(df.index)
    k = max(1, int(round(hours * per_hour)))
    span = max(2, int(round(vol_days * 24 * per_hour)))
    lc = np.log(c)
    r1 = np.r_[np.nan, np.diff(lc)]
    sig = np.sqrt(pd.Series(r1 * r1).ewm(span=span, min_periods=span).mean().to_numpy())
    dk = np.full(n, np.nan)
    if n > k:
        dk[k:] = lc[k:] - lc[:-k]
    z = dk / (sig * np.sqrt(k))
    rsi = ind.rsi(c, max(2, k))
    trend = lc - np.log(_prev_day_ema(ts, c, trend_days))
    zu, zd = z_up * depth, z_down * depth
    w = np.zeros(n, dtype=np.float64)
    held = False
    zl, rl, tl = z.tolist(), rsi.tolist(), trend.tolist()
    for i in range(n):
        zi, ri, ti = zl[i], rl[i], tl[i]
        if zi != zi or ri != ri or ti != ti:
            w[i] = 1.0 if held else 0.0
            continue
        if not held:
            if zi < -(zu if ti > 0.0 else zd):
                held = True
        elif ri > exit_rsi:
            held = False
        w[i] = 1.0 if held else 0.0
    return w


# ------------------------------------------------------------------ book 3: volatility-sized trend (s4_voltarget)
def _trend(df, depth: float, trend_days=18.0, band=0.4, trail=1.0, target_vol=0.6, dip_hours=50.0, dip_z=2.2,
           base_days=30.0, size_step=0.25) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    w = np.zeros(n)
    if n < 3:
        return w
    step = _step(df.index)
    lc = np.log(c)
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    nt = _nbars(step, 24.0 * trend_days)
    nb = _nbars(step, dip_hours)
    vol = np.maximum(np.sqrt(_ema(r * r, _nbars(step, 24.0 * base_days))), 1e-12)
    scale = vol * np.sqrt(nt)
    dev = (lc - np.log(_ema(c, nt))) / scale
    yearly = vol * np.sqrt(_nbars(step, 24.0 * 365.0))
    size = np.floor(np.clip(target_vol / yearly, 0.0, 1.0) / size_step + 1e-9) * size_step
    z = (lc - np.log(_ema(c, nb))) / (vol * np.sqrt(nb))
    dz = dip_z * depth
    warm = _nbars(step, 24.0 * max(trend_days, base_days))
    up = rev = blocked = False
    peak = 0.0
    dl, zl, sl, ll, scl = dev.tolist(), z.tolist(), size.tolist(), lc.tolist(), scale.tolist()
    for i in range(warm, n):
        d = dl[i]
        if up:
            if ll[i] > peak:
                peak = ll[i]
            if d < -band or ll[i] < peak - trail * scl[i]:
                up = False
                blocked = d >= -band
        else:
            if blocked and d < 0:
                blocked = False
            if d > band and not blocked:
                up, rev, peak = True, False, ll[i]
        if up:
            w[i] = sl[i]
            continue
        if rev:
            if zl[i] > 0:
                rev = False
        elif zl[i] < -dz:
            rev = True
        w[i] = 1.0 if rev else 0.0
    return w


def books(df, depth: float = 1.0) -> dict[str, np.ndarray]:
    return {"breakout": _breakout(df, depth), "snap": _snap(df, depth), "trend": _trend(df, depth)}


def blend(b: dict[str, np.ndarray], p: dict) -> np.ndarray:
    w = (float(p["s_breakout"]) * b["breakout"] + float(p["s_snap"]) * b["snap"]
         + float(p["s_trend"]) * b["trend"])
    return np.clip(w, 0.0, 1.0)


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = blend(books(df, float(p["depth"])), p)
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    sb, ss, st = (round(100 * float(p[k])) for k in ("s_breakout", "s_snap", "s_trend"))
    return {
        "summary": (
            f"Three trading books share the {mk} account: a breakout rider ({sb} %), an oversold-snap dip buyer "
            f"({ss} %) and a volatility-sized trend follower ({st} %). The position is the sum of their positions, "
            "at most all in."
        ),
        "howItWorks": [
            f"Breakout book ({sb} % of the account): buys a close above the 27-day high and holds until price falls "
            "3 daily swings below its best since the buy; it also buys a sharp drop under the 9-hour average and sells "
            "the bounce back near it.",
            f"Snap book ({ss} %): buys when the last 4 hours fell about 3 normal moves (deeper when the coin is below "
            "its 60-day trend) and sells when the 4-hour RSI climbs past 55.",
            f"Trend book ({st} %): holds while price is above its 18-day average, sized smaller on wild coins, leaves "
            "on a fall from the high; out of the trend it buys deep dips under the 50-hour average.",
            "Each book decides on its own; when they agree the position grows, when only one is in the account is "
            "partly in. If the shares add up to more than 100 % the total is capped at all in.",
            f"All dip thresholds are scaled by {float(p['depth']):g} (1 = the books' own tuned depth).",
        ] + risk_steps(spec),
        "whenItWins": "Strong rallies (two or three books in at once) and panic flushes that bounce, where every book buys.",
        "whenItLoses": "Failed breakouts and slow bleeds that keep triggering dip buys in all three books together.",
    }
