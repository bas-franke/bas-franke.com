"""s7_stoch: Dip and breakout whose dips are timed by TAAPI oscillators (Stochastic RSI / Stochastic / Williams %R).

Built on s6_hourbars (Session 6 #1): the 27-day breakout ride with a vol-scaled giveback and stepped banking, the
26-day MACD ride sized by volatility, the snap and slow dip layers. The new layer, odip, buys a panic dip only when
  - the fall was fast and deep: the drop over fall_hours is fall_z normal moves (long vol memory), deeper when price is
    under its daily trend, and
  - the chosen oscillator is oversold (under -osc_lo, on a -1..+1 scale) on at least osc_vote of three horizons
    (osc_hours, x osc_mult, x osc_mult^2),
and sells it when the fastest horizon turns overbought (over osc_hi), or after max_hours.
Two clocks: with slow_set, the breakout / MACD / snap / slow-dip layers decide on completed 1-hour candles built from
the 15-minute bars (s6_hourbars as it is), while the oscillator dip trades the 15-minute bars themselves.
The book holds the largest position any layer asks for. Strictly causal.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import LABEL as _LABEL
from ._ta import compute

NAME = "s7_stoch"
VERSION = 1
TITLE = "Dip and breakout, stochastic"
BOT_READY = False
MULTI_MARKET = False
INTERVAL = "15m"

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0
STEP = 0.25


def default_params() -> dict:
    return {
        "s_break": 1.0, "s_snap": 1.0, "s_vdip": 1.0, "s_fdip": 0.0, "s_macd": 1.0, "core": 0.0,
        "high_days": 27.0, "giveback": 3.6, "hvol_days": 11.0, "target_vol": 0.6,
        "take_gain": 0.15, "take_frac": 0.5,
        "snap_hours": 4.0, "snap_vol_days": 55.0, "z_up": 3.3, "z_down": 4.4, "snap_trend_days": 60.0,
        "exit_rsi": 50.0, "wick": 0.0,
        "vdip_hours": 40.0, "vdip_z": 2.2,
        "fdip_hours": 9.0, "fdip_z": 2.2, "fdip_exit": -0.55,
        "macd_days": 26.0, "stretch": 1.0, "macd_give": 0.0, "macd_vol": 0.45,
        "s_odip": 1.0, "osc": "stochrsi", "osc_hours": 1.5, "osc_mult": 3.0, "osc_lo": 0.8, "osc_vote": 1,
        "osc_hi": 0.6, "fall_hours": 4.0, "fall_vol_days": 55.0, "fall_z": 3.3, "fall_down": 1.33,
        "fall_trend_days": 60.0, "max_hours": 24.0, "slow_set": "all",
    }


def param_space() -> dict:
    share = lambda what: {"type": "float", "min": 0.0, "max": 1.0, "description": f"position the {what} layer takes (0 = off)"}  # noqa: E731
    return {
        "s_break": share("breakout ride"),
        "s_snap": share("oversold snap"),
        "s_vdip": share("slow dip"),
        "s_fdip": share("short dip"),
        "s_macd": share("MACD ride"),
        "core": {"type": "float", "min": 0.0, "max": 1.0, "description": "constant position held at all times"},
        "high_days": {"type": "float", "min": 5.0, "max": 120.0, "description": "a close above the highest close of this many days starts a ride"},
        "giveback": {"type": "float", "min": 0.8, "max": 10.0, "description": "the ride ends this many daily swings below its peak"},
        "hvol_days": {"type": "float", "min": 2.0, "max": 60.0, "description": "days of history that set the daily swing of the ride exit"},
        "target_vol": {"type": "float", "min": 0.1, "max": 3.0, "description": "yearly volatility a full ride may carry; wilder coins ride smaller"},
        "take_gain": {"type": "float", "min": 0.02, "max": 2.0, "description": "log gain of a ride (peak over buy) at which part of it is banked; again at twice it"},
        "take_frac": {"type": "float", "min": 0.0, "max": 0.9, "description": "share of what still rides that each of the two banking steps sells"},
        "snap_hours": {"type": "float", "min": 1.0, "max": 24.0, "description": "hours of the snap sell-off and of its exit RSI"},
        "snap_vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the snap's normal move"},
        "z_up": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves above the daily trend"},
        "z_down": {"type": "float", "min": 1.5, "max": 8.0, "description": "snap depth in normal moves below the daily trend"},
        "snap_trend_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in the daily trend that sets the snap depth"},
        "exit_rsi": {"type": "float", "min": 30.0, "max": 90.0, "description": "RSI level that sells the snap"},
        "wick": {"type": "float", "min": 0.0, "max": 1.0, "description": "how much the candle's low (not only its close) counts in the snap drop"},
        "vdip_hours": {"type": "float", "min": 6.0, "max": 240.0, "description": "hours in the average the slow dip is measured against"},
        "vdip_z": {"type": "float", "min": 0.5, "max": 5.0, "description": "volatility units under that average that buy the slow dip"},
        "fdip_hours": {"type": "float", "min": 2.0, "max": 72.0, "description": "hours in the short average of the short dip"},
        "fdip_z": {"type": "float", "min": 0.8, "max": 5.0, "description": "swings under that average that buy the short dip"},
        "fdip_exit": {"type": "float", "min": -2.0, "max": 1.5, "description": "swings from the average that sell the short dip"},
        "macd_days": {"type": "float", "min": 10.0, "max": 60.0, "description": "days in the MACD ride"},
        "stretch": {"type": "float", "min": 0.0, "max": 1.2, "description": "how high the MACD histogram must have been before a cross under zero sells"},
        "macd_give": {"type": "float", "min": 0.0, "max": 20.0, "description": "the MACD ride also ends this many daily swings below its peak (0 = never), until the next cross up"},
        "macd_vol": {"type": "float", "min": 0.0, "max": 3.0, "description": "yearly volatility a full MACD ride may carry (0 = always its full share)"},
        "s_odip": share("oscillator dip"),
        "osc": {"type": "choice", "values": ["stochrsi", "stoch", "willr"], "description": "TAAPI oscillator that times the dip"},
        "osc_hours": {"type": "float", "min": 0.5, "max": 48.0, "description": "hours of the fastest oscillator horizon"},
        "osc_mult": {"type": "float", "min": 1.5, "max": 8.0, "description": "each slower horizon is this many times longer"},
        "osc_lo": {"type": "float", "min": 0.2, "max": 1.0, "description": "oversold level (0..1 below the middle) that counts a horizon"},
        "osc_vote": {"type": "int", "min": 0, "max": 3, "description": "how many of the three horizons must be oversold (0 = no oscillator gate)"},
        "osc_hi": {"type": "float", "min": -0.8, "max": 1.0, "description": "the fastest horizon above this sells the dip"},
        "fall_hours": {"type": "float", "min": 1.0, "max": 48.0, "description": "hours over which the fall is measured"},
        "fall_vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the normal move of the fall"},
        "fall_z": {"type": "float", "min": 0.0, "max": 8.0, "description": "normal moves the fall must reach (0 = no fall gate)"},
        "fall_down": {"type": "float", "min": 0.5, "max": 3.0, "description": "the depth is this many times deeper when price is under its daily trend"},
        "fall_trend_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in the daily trend"},
        "slow_set": {"type": "choice", "values": list(SLOW_SETS), "description": "layers that decide on completed 1-hour candles while the rest trade the native bars"},
        "max_hours": {"type": "float", "min": 2.0, "max": 500.0, "description": "the dip is sold after this many hours at the latest"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["fdip_exit"]) <= -float(p["fdip_z"]):
        return "fdip_exit must be above -fdip_z"
    if int(p["osc_vote"]) == 0 and float(p["fall_z"]) <= 0:
        return "the oscillator dip needs an oscillator vote or a fall gate"
    return None


def warmup(p: dict) -> int:
    return int(max(float(p["high_days"]), float(p["hvol_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, BASE_DAYS, float(p["fall_vol_days"]),
                   float(p["fall_trend_days"]) + 1, float(p["osc_hours"]) * float(p["osc_mult"]) ** 2 / 12.0, 3 * float(p["macd_days"])) * 24)


def _step(index) -> float:
    ts = np.asarray(index, dtype=np.int64)
    return max(float(np.median(np.diff(ts))), 1.0) if len(ts) > 1 else 3_600_000.0


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
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    nh = _bars(step, 24.0 * float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    day_sd = np.sqrt(var_bar * _bars(step, 24.0))
    give, tg, tf = float(p["giveback"]), float(p["take_gain"]), float(p["take_frac"])
    w = np.zeros(n)
    ride = level = 0
    peak = entry = sz = 0.0
    ll, hl, sl, zl = lc.tolist(), hi.tolist(), day_sd.tolist(), size.tolist()
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
                while level < 2 and peak - entry >= tg * (level + 1):
                    level += 1
        w[i] = sz * (1.0 - tf) ** level if ride else 0.0
    return w


def _snap(ts, c, lc, llow, step, p) -> np.ndarray:
    n = len(c)
    per_hour = _HOUR / step
    k = max(1, int(round(float(p["snap_hours"]) * per_hour)))
    span = max(2, int(round(float(p["snap_vol_days"]) * 24 * per_hour)))
    r1 = np.r_[np.nan, np.diff(lc)]
    sig = np.sqrt(pd.Series(r1 * r1).ewm(span=span, min_periods=span).mean().to_numpy())
    wk = float(p["wick"])
    now = (1.0 - wk) * lc + wk * llow
    dk = np.full(n, np.nan)
    if n > k:
        dk[k:] = now[k:] - lc[:-k]
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


def _vdip(c, lc, step, vol, p) -> np.ndarray:
    n = len(c)
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
    return w


def _fdip(lc, step, p) -> np.ndarray:
    n = len(lc)
    r = np.diff(lc, prepend=lc[0])
    var_bar = _ema(r * r, _bars(step, 24.0 * float(p["hvol_days"])))
    nd = _bars(step, float(p["fdip_hours"]))
    z = (lc - _ema(lc, nd)) / np.maximum(np.sqrt(var_bar * nd), 1e-9)
    k, ex = float(p["fdip_z"]), float(p["fdip_exit"])
    w = np.zeros(n)
    dip = 0
    zl = z.tolist()
    for i in range(_bars(step, 24.0 * 5), n):
        if dip == 0:
            if zl[i] < -k:
                dip = 1
        elif zl[i] > ex:
            dip = 0
        w[i] = dip
    return w


def _macd(df, lc, step, p) -> np.ndarray:
    reading = compute("macd", df, max(2, int(round(float(p["macd_days"]) * _DAY / step))))
    level, give = float(p["stretch"]), float(p["macd_give"])
    r = np.diff(lc, prepend=lc[0])
    day_sd = np.sqrt(_ema(r * r, _bars(step, 24.0 * float(p["hvol_days"]))) * _bars(step, 24.0))
    w = np.zeros(len(reading))
    held = False
    peak, prev, top = -1e9, np.nan, 0.0
    ll, sl = lc.tolist(), day_sd.tolist()
    for i, v in enumerate(np.asarray(reading, float).tolist()):
        if v != v:
            prev = np.nan
            continue
        if not held:
            if v > 0.0 and not (prev > 0.0):
                held, peak, top = True, v, ll[i]
        else:
            peak = max(peak, v)
            top = max(top, ll[i])
            if prev > 0.0 and v <= 0.0 and peak >= level:
                held, peak = False, -1e9
            elif give > 0 and ll[i] < top - give * sl[i]:
                held, peak = False, -1e9      # waits for the next cross up
        w[i] = 1.0 if held else 0.0
        prev = v
    return w


def _odip(ts, df, c, lc, step, p) -> np.ndarray:
    n = len(c)
    per_hour = _HOUR / step
    hrs = [float(p["osc_hours"]) * float(p["osc_mult"]) ** j for j in range(3)]
    oscs = [compute(p["osc"], df, max(2, int(round(x * per_hour)))) for x in hrs]
    lo, vote, hi = float(p["osc_lo"]), int(p["osc_vote"]), float(p["osc_hi"])
    cnt = np.zeros(n)
    for o in oscs:
        cnt += np.nan_to_num(o, nan=0.0) < -lo
    ok_osc = cnt >= vote
    fz = float(p["fall_z"])
    if fz > 0:
        k = max(1, int(round(float(p["fall_hours"]) * per_hour)))
        span = max(2, int(round(float(p["fall_vol_days"]) * 24 * per_hour)))
        r1 = np.r_[np.nan, np.diff(lc)]
        sig = np.sqrt(pd.Series(r1 * r1).ewm(span=span, min_periods=span).mean().to_numpy())
        dk = np.full(n, np.nan)
        if n > k:
            dk[k:] = lc[k:] - lc[:-k]
        z = dk / (sig * np.sqrt(k))
        trend = lc - np.log(_prev_day_ema(ts, c, float(p["fall_trend_days"])))
        need = np.where(trend > 0, fz, fz * float(p["fall_down"]))
        ok_fall = np.nan_to_num(z, nan=0.0) < -need
        ok_fall &= np.isfinite(trend)
    else:
        ok_fall = np.ones(n, bool)
    go = (ok_osc & ok_fall).tolist()
    fast = np.nan_to_num(oscs[0], nan=0.0).tolist()
    mx = max(1, int(round(float(p["max_hours"]) * per_hour)))
    w = np.zeros(n)
    held, age = False, 0
    for i in range(_bars(step, 24.0 * BASE_DAYS), n):
        if held:
            age += 1
            if fast[i] > hi or age >= mx:
                held = False
        elif go[i]:
            held, age = True, 0
        w[i] = 1.0 if held else 0.0
    return w


LAYERS = ("break", "snap", "vdip", "fdip", "macd", "odip")


def layer_weights(df, p, which=None) -> dict[str, np.ndarray]:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    out = {k: np.zeros(n) for k in LAYERS}
    if n < 3:
        return out
    step = _step(ts)
    lc = np.log(np.maximum(c, 1e-12))
    llow = np.log(np.maximum(df["low"].to_numpy(np.float64), 1e-12)) if "low" in df else lc
    r = np.zeros(n)
    r[1:] = np.diff(lc)
    vol = np.maximum(np.sqrt(_ema(r * r, _bars(step, 24.0 * BASE_DAYS))), 1e-12)
    yearly = vol * np.sqrt(_bars(step, 24.0 * 365.0))
    size = np.floor(np.clip(float(p["target_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP
    if float(p["s_break"]) > 0 and (which is None or "break" in which):
        out["break"] = _breakout(lc, step, size, p) * float(p["s_break"])
    if float(p["s_snap"]) > 0 and (which is None or "snap" in which):
        out["snap"] = _snap(ts, c, lc, llow, step, p) * float(p["s_snap"])
    if float(p["s_vdip"]) > 0 and (which is None or "vdip" in which):
        out["vdip"] = _vdip(c, lc, step, vol, p) * float(p["s_vdip"])
    if float(p["s_fdip"]) > 0 and (which is None or "fdip" in which):
        out["fdip"] = _fdip(lc, step, p) * float(p["s_fdip"])
    if float(p["s_macd"]) > 0 and (which is None or "macd" in which):
        ms = float(p["s_macd"])
        if float(p["macd_vol"]) > 0:
            ms = np.minimum(ms, np.floor(np.clip(float(p["macd_vol"]) / yearly, 0.0, 1.0) / STEP + 1e-9) * STEP)
        out["macd"] = _macd(df, lc, step, p) * ms
    if float(p["s_odip"]) > 0 and (which is None or "odip" in which):
        out["odip"] = _odip(ts, df, c, lc, step, p) * float(p["s_odip"])
    return out


SLOW_SETS = {"none": (), "ride": ("break", "macd"), "ride_vdip": ("break", "macd", "vdip"),
             "all": ("break", "snap", "vdip", "fdip", "macd")}


def _hourly(df) -> tuple[pd.DataFrame, np.ndarray]:
    """Completed-hour candles from finer bars, and for each fine bar the hourly row it may use (-1 = none yet)."""
    ts = np.asarray(df.index, dtype=np.int64)
    hr = ts // _HOUR
    g = pd.DataFrame({"open": df["open"].to_numpy(np.float64), "high": df["high"].to_numpy(np.float64),
                      "low": df["low"].to_numpy(np.float64), "close": df["close"].to_numpy(np.float64),
                      "volume": df["volume"].to_numpy(np.float64), "h": hr}).groupby("h", sort=True)
    hdf = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    hours = hdf.index.to_numpy(np.int64)
    hdf.index = hours * _HOUR
    # hour H is complete once a bar closes at or after (H + 1) * HOUR
    step = _step(ts)
    pos = np.searchsorted((hours + 1) * _HOUR, ts + step, side="right") - 1
    return hdf, pos


def _weights(df, p) -> np.ndarray:
    slow = SLOW_SETS[p["slow_set"]]
    if slow and _step(df.index) < _HOUR and len(df) > 8:
        hdf, pos = _hourly(df)
        lh = layer_weights(hdf, p, slow)
        lw = layer_weights(df, p, tuple(k for k in LAYERS if k not in slow))
        for k in slow:
            lw[k] = np.where(pos >= 0, lh[k][np.clip(pos, 0, None)], 0.0)
    else:
        lw = layer_weights(df, p)
    w = np.full(len(df), float(p["core"]))
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
    pct = lambda k: f"{round(100 * float(p[k]))} %"  # noqa: E731
    slow = SLOW_SETS[p["slow_set"]]
    if slow:
        names = {"break": "breakout ride", "snap": "snap dip", "vdip": "slow dip", "fdip": "short dip", "macd": "MACD ride"}
        on = [names[k] for k in slow if float(p[f"s_{k}"]) > 0]
        steps = [f"Two clocks on {mk}: the {', '.join(on)} layers decide once an hour on completed 1-hour candles; "
                 "the oscillator dip decides every 15 minutes, because most of a panic bounce comes in the first minutes."]
    else:
        steps = [f"Every layer decides on each candle of {mk}."]
    if float(p["s_break"]) > 0:
        steps.append(
            f"Ride: a close above the highest close of the last {p['high_days']:g} days buys up to {pct('s_break')}, "
            f"scaled down to {p['target_vol']:g} divided by the coin's yearly volatility. It ends when price falls "
            f"{p['giveback']:g} daily swings below its best since the buy.")
        if float(p["take_frac"]) > 0:
            g = float(p["take_gain"])
            steps.append(f"Banking: at {(np.exp(g) - 1) * 100:.0f} % and {(np.exp(2 * g) - 1) * 100:.0f} % above the "
                         f"buy, {pct('take_frac')} of what still rides is sold.")
    if float(p["s_snap"]) > 0:
        steps.append(
            f"Snap dip: a {p['snap_hours']:g}-hour fall of {p['z_up']:g} normal moves ({p['z_down']:g} under the "
            f"{p['snap_trend_days']:g}-day trend) buys {pct('s_snap')}; it sells when the {p['snap_hours']:g}-hour RSI "
            f"tops {p['exit_rsi']:g}.")
    if float(p["s_vdip"]) > 0:
        steps.append(f"Slow dip: {p['vdip_z']:g} volatility units under the {p['vdip_hours']:g}-hour average buys "
                     f"{pct('s_vdip')}; it sells once price is back at that average.")
    if float(p["s_fdip"]) > 0:
        steps.append(f"Short dip: {p['fdip_z']:g} swings under the {p['fdip_hours']:g}-hour average buys "
                     f"{pct('s_fdip')}; it sells at {p['fdip_exit']:g} swings from it.")
    if float(p["s_macd"]) > 0:
        cap = (f", at most {p['macd_vol']:g} divided by the coin's yearly volatility" if float(p["macd_vol"]) > 0 else "")
        steps.append(f"MACD ride: {pct('s_macd')}{cap} while the {p['macd_days']:g}-day MACD is positive, sold on a "
                     f"cross under zero after it reached {p['stretch']:g}.")
    if float(p["s_odip"]) > 0:
        gate = []
        if float(p["fall_z"]) > 0:
            gate.append(f"price fell {p['fall_z']:g} normal moves in {p['fall_hours']:g} hours ({float(p['fall_z']) * float(p['fall_down']):.1f} "
                        f"under the {p['fall_trend_days']:g}-day trend)")
        if int(p["osc_vote"]) > 0:
            hrs = ", ".join(f"{float(p['osc_hours']) * float(p['osc_mult']) ** j:g}" for j in range(3))
            gate.append(f"the {_LABEL[p['osc']]} is oversold on {int(p['osc_vote'])} of the {hrs}-hour horizons")
        steps.append(f"Oscillator dip: buys {pct('s_odip')} when " + " and ".join(gate) + f"; it sells when the "
                     f"{float(p['osc_hours']):g}-hour {_LABEL[p['osc']]} turns overbought, or after {p['max_hours']:g} hours.")
    if float(p["core"]) > 0:
        steps.append(f"Core: {pct('core')} is always held.")
    steps.append("The book holds the largest position any layer asks for.")
    return {
        "summary": (f"Dip and breakout on {mk}: rides a slow MACD trend and breakouts to new highs with "
                    "volatility-sized positions, and buys fast, deep panic dips timed by the Stochastic RSI."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long climbs that keep making new highs, and panic flushes that bounce over the next hours.",
        "whenItLoses": "Breakouts that fail right after the buy, and panic dips that keep falling for days.",
    }
