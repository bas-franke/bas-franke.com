"""s6_union: s5_union3 (breakout ride plus two deep dips) made fee-aware for Bitvavo's real fees.

Starts from s5_union3's three layers and adds knobs that trade less and bigger:
  break  a close above the N-day high (optionally a buffer of daily swings above it), ridden until price gives back G
         daily swings; size = target_vol / yearly vol in quarter steps, locked at the buy so the ride does not
         rebalance every time volatility moves; optional stepped profit-taking
  snap   a sharp few-hour drop of Z normal moves (deeper under the daily trend), sold on RSI after a minimum hold
  vdip   a deep fall under a multi-hour average, sold back above it after a minimum hold
  trend  (optional) s4_voltarget's vol-banded trend, sized like the ride, owning a share of the account
  core   (optional) a constant position
The book's weight is the largest weight any layer asks for. Strictly causal.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s6_union"
VERSION = 1
TITLE = "Breakout plus two dips, fee-aware"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0   # volatility memory of the ride size and of the multi-hour dip
STEP = 0.25        # ride sizes move in quarter steps
LOCK_SIZE = True   # ride size is fixed at the buy


def default_params() -> dict:
    return {
        "high_days": 27.0, "giveback": 3.5, "hvol_days": 8.25, "target_vol": 0.6, "break_buf": 0.0,
        "take_gain": 0.16, "take_frac": 0.5,
        "snap_hours": 3.2, "snap_vol_days": 48.0, "z_up": 3.6, "z_down": 5.0, "snap_trend_days": 60.0,
        "exit_rsi": 45.0, "snap_min_hours": 0.0,
        "vdip_hours": 45.0, "vdip_z": 2.2, "vdip_exit": 0.0, "vdip_min_hours": 0.0,
        "s_trend": 0.0, "trend_days": 18.0, "band": 0.4, "trail": 1.0,
        "core": 0.0,
    }


def param_space() -> dict:
    return {
        "high_days": {"type": "float", "min": 5.0, "max": 120.0, "description": "a close above the highest close of this many days starts a ride"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the ride ends this many daily swings below its peak"},
        "hvol_days": {"type": "float", "min": 2.0, "max": 60.0, "description": "days of history that set the daily swing of the ride exit"},
        "target_vol": {"type": "float", "min": 0.1, "max": 2.0, "description": "yearly volatility a full ride may carry; wilder coins ride smaller"},
        "break_buf": {"type": "float", "min": 0.0, "max": 3.0, "description": "daily swings above the old high a close must reach to start a ride"},
        "take_gain": {"type": "float", "min": 0.02, "max": 2.0, "description": "log gain of a ride at which part of it is sold (doubles for the second step)"},
        "take_frac": {"type": "float", "min": 0.0, "max": 0.9, "description": "share of the ride each of the two profit-taking steps sells"},
        "snap_hours": {"type": "float", "min": 1.0, "max": 24.0, "description": "hours of the snap sell-off and of its exit RSI"},
        "snap_vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the snap's normal move"},
        "z_up": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves above the daily trend"},
        "z_down": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves below the daily trend"},
        "snap_trend_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in the daily trend that sets the snap depth"},
        "exit_rsi": {"type": "float", "min": 30.0, "max": 90.0, "description": "RSI level that sells the snap"},
        "snap_min_hours": {"type": "float", "min": 0.0, "max": 96.0, "description": "hours a snap is held at least"},
        "vdip_hours": {"type": "float", "min": 6.0, "max": 240.0, "description": "hours in the average the slow dip is measured against"},
        "vdip_z": {"type": "float", "min": 0.5, "max": 5.0, "description": "volatility units under that average that buy the slow dip"},
        "vdip_exit": {"type": "float", "min": -2.0, "max": 3.0, "description": "volatility units from the average at which the slow dip sells"},
        "vdip_min_hours": {"type": "float", "min": 0.0, "max": 240.0, "description": "hours a slow dip is held at least"},
        "s_trend": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of the account the vol-sized trend layer owns"},
        "trend_days": {"type": "float", "min": 3.0, "max": 90.0, "description": "days in the trend layer's average"},
        "band": {"type": "float", "min": 0.05, "max": 2.0, "description": "trend layer entry band in volatility units above that average"},
        "trail": {"type": "float", "min": 0.2, "max": 5.0, "description": "trend layer trailing exit in the same units"},
        "core": {"type": "float", "min": 0.0, "max": 0.6, "description": "constant position held at all times"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["high_days"]), float(p["hvol_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, float(p["trend_days"]), BASE_DAYS) * 96)


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


def _breakout(lc, step, size, p) -> np.ndarray:
    """Breakout ride, sized (locked at the buy), with optional stepped profit-taking."""
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    nh = _bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    give, buf = float(p["giveback"]), float(p["break_buf"])
    tg, tf = float(p["take_gain"]), float(p["take_frac"])
    w = np.zeros(n)
    ride = False
    peak = entry = cur = 0.0
    took = 0
    ll, hl, sl, zl = lc.tolist(), hi.tolist(), day_sd.tolist(), size.tolist()
    for i in range(n):
        if not ride:
            if hl[i] == hl[i] and ll[i] > hl[i] + buf * sl[i] and zl[i] > 0:
                ride = True
                peak = entry = ll[i]
                cur = zl[i]
                took = 0
        else:
            if ll[i] > peak:
                peak = ll[i]
            if ll[i] < peak - give * sl[i]:
                ride = False
            elif tf > 0 and took < 2 and peak - entry > tg * (took + 1):
                took += 1
                cur = cur * (1.0 - tf)
        if ride:
            w[i] = cur if LOCK_SIZE else zl[i] * (1.0 - tf) ** took
    return w


def _snap(ts, c, lc, step, p) -> np.ndarray:
    """s4_rsi2's oversold snap with a minimum hold: 0/1."""
    n = len(c)
    per_hour = _HOUR / step
    k = max(1, int(round(float(p["snap_hours"]) * per_hour)))
    span = max(2, int(round(float(p["snap_vol_days"]) * 24 * per_hour)))
    mh = int(round(float(p["snap_min_hours"]) * per_hour))
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
    since = 0
    zl, rl, tl = z.tolist(), rsi.tolist(), trend.tolist()
    for i in range(n):
        zi, ri, ti = zl[i], rl[i], tl[i]
        if zi == zi and ri == ri and ti == ti:
            if not held:
                if zi < -(zu if ti > 0.0 else zd):
                    held = True
                    since = i
            elif ri > er and i - since >= mh:
                held = False
        w[i] = 1.0 if held else 0.0
    return w


def _vol_size(c, lc, step, p):
    n = len(c)
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(_ema(r * r, _bars(step, 24.0 * BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(_bars(step, 24.0 * 365.0))
    size = np.floor(np.clip(float(p["target_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP
    return vol, size


def _slow_dip(c, lc, step, vol, p):
    """s4_voltarget's dip with its own exit level and a minimum hold: 0/1."""
    n = len(c)
    nb = _bars(step, float(p["vdip_hours"]))
    mh = int(round(float(p["vdip_min_hours"]) * _HOUR / step))
    z = (lc - np.log(_ema(c, nb))) / (vol * np.sqrt(nb))
    dz, ex = float(p["vdip_z"]), float(p["vdip_exit"])
    w = np.zeros(n)
    rev = False
    since = 0
    zl = z.tolist()
    for i in range(_bars(step, 24.0 * BASE_DAYS), n):
        if rev:
            if zl[i] > ex and i - since >= mh:
                rev = False
        elif zl[i] < -dz:
            rev = True
            since = i
        w[i] = 1.0 if rev else 0.0
    return w


def _trend(c, lc, step, vol, size, p) -> np.ndarray:
    """s4_voltarget's vol-banded trend (no dip part), sized like the ride, locked at the buy."""
    n = len(c)
    w = np.zeros(n)
    nt = _bars(step, 24.0 * float(p["trend_days"]))
    scale = vol * np.sqrt(nt)
    dev = (lc - np.log(_ema(c, nt))) / scale
    band, trail = float(p["band"]), float(p["trail"])
    warm = _bars(step, 24.0 * max(float(p["trend_days"]), BASE_DAYS))
    up = blocked = False
    peak = cur = 0.0
    dl, sl, ll, scl = dev.tolist(), size.tolist(), lc.tolist(), scale.tolist()
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
                up, peak, cur = True, ll[i], sl[i]
        if up:
            w[i] = cur if LOCK_SIZE else sl[i]
    return w


def layer_weights(df, p) -> dict[str, np.ndarray]:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    names = ("break", "snap", "vdip", "trend", "core")
    if n < 3:
        return {k: np.zeros(n) for k in names}
    step = _step(ts)
    lc = np.log(np.maximum(c, 1e-12))
    vol, size = _vol_size(c, lc, step, p)
    st = float(p["s_trend"])
    return {
        "break": _breakout(lc, step, size, p),
        "snap": _snap(ts, c, lc, step, p),
        "vdip": _slow_dip(c, lc, step, vol, p),
        "trend": st * _trend(c, lc, step, vol, size, p) if st > 0 else np.zeros(n),
        "core": np.full(n, float(p["core"])),
    }


def _weights(df, p) -> np.ndarray:
    lw = layer_weights(df, p)
    w = lw["core"]
    for k in ("break", "snap", "vdip", "trend"):
        w = np.maximum(w, lw[k])
    return np.clip(w, 0.0, 1.0)


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    w = _weights(df, spec["params"])
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    steps = [
        f"Ride: a close above the highest close of the last {p['high_days']:g} days"
        + (f" by {p['break_buf']:g} daily swings" if float(p["break_buf"]) > 0 else "")
        + f" buys. The ride ends when price falls {p['giveback']:g} daily swings (measured over {p['hvol_days']:g} "
        "days) below its best since the buy.",
        f"Ride size: {p['target_vol']:g} divided by the coin's yearly volatility over the last 30 days, at most all "
        "in, in quarter steps, fixed at the buy. A wild coin or a stormy stretch rides smaller.",
    ]
    if float(p["take_frac"]) > 0:
        steps.append(f"Profit-taking: at +{100 * float(p['take_gain']):.0f} % (log) over the buy the ride sells "
                     f"{100 * float(p['take_frac']):.0f} % of itself, and again at twice that gain.")
    steps += [
        f"Snap dip: a {p['snap_hours']:g}-hour fall of {p['z_up']:g} normal moves (normal = the last "
        f"{p['snap_vol_days']:g} days) buys all in; {p['z_down']:g} are needed when the coin is under its "
        f"{p['snap_trend_days']:g}-day trend. It sells when the {p['snap_hours']:g}-hour RSI tops {p['exit_rsi']:g}"
        + (f", but not before {p['snap_min_hours']:g} hours" if float(p["snap_min_hours"]) > 0 else "") + ".",
        f"Slow dip: a fall of {p['vdip_z']:g} volatility units under the {p['vdip_hours']:g}-hour average buys all "
        f"in; it sells once price is {p['vdip_exit']:g} units from that average"
        + (f", held at least {p['vdip_min_hours']:g} hours" if float(p["vdip_min_hours"]) > 0 else "") + ".",
    ]
    if float(p["s_trend"]) > 0:
        steps.append(f"Trend: price {p['band']:g} volatility units above its {p['trend_days']:g}-day average buys "
                     f"{100 * float(p['s_trend']):.0f} % of the ride size; it sells below the band or "
                     f"{p['trail']:g} units under its peak.")
    if float(p["core"]) > 0:
        steps.append(f"Core: {100 * float(p['core']):.0f} % is always held.")
    steps.append("The book holds the largest position any layer asks for.")
    return {
        "summary": (f"Rides {mk} breakouts to new {p['high_days']:g}-day highs with a volatility-sized position, and "
                    "buys deep panic dips all in for the bounce, trading rarely to keep fees low."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long climbs that keep making new highs, and panic flushes that snap back within hours or days.",
        "whenItLoses": "Breakouts that fail right after the buy, and slow bleeds that keep tripping the dip buys.",
    }
