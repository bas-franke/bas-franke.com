"""s6_dailymix: big waves decided on completed daily candles, 15-minute candles only for dip buys.

Session 5's best book (s5_union3) decides its breakout ride on 15-minute closes, so in chop it keeps buying intraday
pokes above the 27-day high. This book moves the slow decision to daily candles and to Session 3's oscillator:
  wave   (daily)  the daily MACD histogram (20-day fast average) crossing above zero starts a wave; it ends when the
                  histogram crosses back under zero after it had stretched (Session 3's s3_macd top), or when the
                  14-day RSI reached 80 and fell 15 points from its peak. Sized target_vol / yearly vol, frozen at the
                  buy; once the wave is 25 % (log) up, half of it is banked.
  timing (15m)    optional: a new wave waits for a 15-minute pullback under a short average (off by default; it did
                  not pay)
  snap   (15m)    s5_union3's deep panic dip (Z normal moves in a few hours), sold when the 4-hour RSI tops 55; all in
  vdip   (15m)    s5_union3's slow dip under the 50-hour average, sold back at it; all in
The book holds the largest weight any layer asks for. Strictly causal: a daily candle is used only from the first bar
of the next UTC day.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s6_dailymix"
VERSION = 1
TITLE = "Daily waves, 15-minute dips"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
BASE_DAYS = 30.0   # volatility memory of the wave size and of the slow dip
STEP = 0.25        # wave sizes move in quarter steps


def default_params() -> dict:
    return {
        "macd_days": 20.0, "stretch": 0.3, "target_vol": 0.5,
        "rsi_days": 14.0, "top_rsi": 80.0, "top_drop": 15.0,
        "take_gain": 0.25, "take_keep": 0.5,
        "wait_hours": 0.0, "pull_hours": 6.0,
        "snap_hours": 4.0, "snap_vol_days": 48.0, "z_up": 3.2, "z_down": 4.4, "snap_trend_days": 60.0,
        "exit_rsi": 55.0,
        "vdip_hours": 50.0, "vdip_z": 2.0,
    }


def param_space() -> dict:
    return {
        "macd_days": {"type": "float", "min": 5.0, "max": 60.0, "description": "days in the fast average of the daily MACD"},
        "stretch": {"type": "float", "min": 0.0, "max": 1.5, "description": "how high the daily MACD histogram must have been before a cross under zero sells"},
        "target_vol": {"type": "float", "min": 0.1, "max": 2.0, "description": "yearly volatility a full wave may carry; wilder coins ride smaller"},
        "rsi_days": {"type": "float", "min": 3.0, "max": 60.0, "description": "days in the daily RSI that calls a top"},
        "top_rsi": {"type": "float", "min": 55.0, "max": 101.0, "description": "the daily RSI must have reached this during the wave before a rollover sells (101 = off)"},
        "top_drop": {"type": "float", "min": 2.0, "max": 40.0, "description": "RSI points under its wave peak that sell the top"},
        "take_gain": {"type": "float", "min": 0.0, "max": 2.0, "description": "log gain over the wave's first price that banks part of it (0 = off)"},
        "take_keep": {"type": "float", "min": 0.0, "max": 1.0, "description": "share of the wave kept after that"},
        "wait_hours": {"type": "float", "min": 0.0, "max": 72.0, "description": "hours a new wave waits for a 15-minute pullback before buying anyway (0 = buy at once)"},
        "pull_hours": {"type": "float", "min": 1.0, "max": 48.0, "description": "hours in the short average a pullback must dip under"},
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
    return int(max(3 * float(p["macd_days"]), float(p["snap_vol_days"]),
                   float(p["snap_trend_days"]) + 1, float(p["rsi_days"]) + 1, BASE_DAYS) * 96)


def _step(index) -> float:
    ts = np.asarray(index, dtype=np.int64)
    return max(float(np.median(np.diff(ts))), 1.0) if len(ts) > 1 else 900_000.0


def _bars(step: float, hours: float) -> int:
    return max(2, int(round(hours * _HOUR / step)))


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    return pd.Series(x).ewm(span=max(1, int(span)), adjust=False).mean().to_numpy(np.float64)


def _daily(ts: np.ndarray, c: np.ndarray):
    """Completed UTC daily closes and, per bar, the index of the last completed day (-1 before the first)."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    pos = np.searchsorted(dd, d, side="left") - 1
    return dd, dc, pos


def _prev_day_ema(dc: np.ndarray, pos: np.ndarray, days: float) -> np.ndarray:
    e = ind.ema(dc, max(2, int(round(days))))
    return np.where(pos >= 0, e[np.clip(pos, 0, None)], np.nan)


def _daily_frame(ts: np.ndarray, df) -> pd.DataFrame:
    """UTC daily candles from the bars (the last one may still be forming; it is only read from the next day on)."""
    d = ts // _DAY
    g = df.groupby(d)
    return pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                         "close": g["close"].last(), "volume": g["volume"].sum()})


def _wave(ddf: pd.DataFrame, p) -> np.ndarray:
    """Per completed day: 1 while a wave is on after that day's close.

    In: the daily MACD histogram crosses above zero.
    Out: the histogram crosses back under zero after it reached `stretch` (Session 3's top), or a stretched
    daily RSI rolls over.
    """
    dc = ddf["close"].to_numpy(np.float64)
    m = len(dc)
    if m < 5:
        return np.zeros(m)
    hist = compute("macd", ddf, max(2, int(round(float(p["macd_days"])))))
    rsi = ind.rsi(dc, max(2, int(round(float(p["rsi_days"])))))
    top, drop, stretch = float(p["top_rsi"]), float(p["top_drop"]), float(p["stretch"])
    w = np.zeros(m)
    on = False
    rpk = hpk = 0.0
    prev = float("nan")
    rl, xl = rsi.tolist(), hist.tolist()
    for j in range(m):
        x, rj = xl[j], rl[j]
        if not on:
            if x == x and x > 0.0 and not (prev > 0.0):
                on = True
                rpk = rj if rj == rj else 0.0
                hpk = x if x == x else 0.0
        else:
            if rj == rj and rj > rpk:
                rpk = rj
            if x == x and x > hpk:
                hpk = x
            if x == x and prev > 0.0 and x <= 0.0 and hpk >= stretch:
                on = False
            elif rpk >= top and rj == rj and rj < rpk - drop:
                on = False
        w[j] = 1.0 if on else 0.0
        prev = x
    return w


def _timed(wave_bar: np.ndarray, c: np.ndarray, step: float, p) -> np.ndarray:
    """A new wave buys at the first 15-minute close under the pull_hours average, or after wait_hours."""
    wait = float(p["wait_hours"])
    if wait <= 0:
        return wave_bar
    avg = _ema(c, _bars(step, float(p["pull_hours"])))
    lim = _bars(step, wait)
    out = np.zeros(len(c))
    state = 0       # 0 off, 1 waiting, 2 in
    since = 0
    wl, cl, al = wave_bar.tolist(), c.tolist(), avg.tolist()
    for i in range(len(c)):
        if wl[i] <= 0:
            state = 0
        elif state == 0:
            state, since = 1, 0
        if state == 1:
            since += 1
            if cl[i] < al[i] or since > lim:
                state = 2
        out[i] = wl[i] if state == 2 else 0.0
    return out


def _freeze(on: np.ndarray, size: np.ndarray, c: np.ndarray, take: float, keep: float) -> np.ndarray:
    """A wave keeps the size it was bought with, so a drifting volatility does not trade it in quarter steps.
    Once price is `take` (log) above the wave's first price, it keeps only `keep` of that size (take <= 0: off)."""
    out = np.zeros(len(on))
    cur = 0.0
    entry = 0.0
    cut = False
    lim = np.exp(take) if take > 0 else np.inf
    ol, sl, cl = on.tolist(), size.tolist(), c.tolist()
    for i in range(len(on)):
        if ol[i] <= 0:
            cur, cut = 0.0, False
        elif cur == 0.0:
            cur, entry = max(sl[i], STEP), cl[i]
        elif not cut and cl[i] > entry * lim:
            cut = True
            cur = cur * keep
        out[i] = cur
    return out


def _snap(c, lc, trend_ema, step, p) -> np.ndarray:
    """s5_union3's oversold snap: 0/1."""
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
    trend = lc - np.log(trend_ema)
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
    """s5_union3's slow dip (0/1) and the wave size (target_vol / yearly vol, quarter steps)."""
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
        return {k: np.zeros(n) for k in ("wave", "snap", "vdip")}
    step = _step(ts)
    lc = np.log(np.maximum(c, 1e-12))
    dd, dc, pos = _daily(ts, c)
    wd = _wave(_daily_frame(ts, df), p)
    wave_bar = np.where(pos >= 0, wd[np.clip(pos, 0, None)], 0.0)
    vdip, size = _slow_dip(c, lc, step, p)
    wave = _freeze(_timed(wave_bar, c, step, p), size, c, float(p["take_gain"]), float(p["take_keep"]))
    snap = _snap(c, lc, _prev_day_ema(dc, pos, float(p["snap_trend_days"])), step, p)
    return {"wave": wave, "snap": snap, "vdip": vdip}


def _weights(df, p) -> np.ndarray:
    lw = layer_weights(df, p)
    return np.clip(np.maximum(np.maximum(lw["wave"], lw["snap"]), lw["vdip"]), 0.0, 1.0)


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    w = _weights(df, spec["params"])
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    steps = [
        f"Wave: when the daily MACD histogram ({p['macd_days']:g}-day fast average, daily candles) crosses above "
        f"zero, {mk} starts a wave. It ends when the histogram crosses back under zero after reaching "
        f"{p['stretch']:g}; a weaker dip under zero is a pause, not a top, so the wave stays on.",
    ]
    if float(p["top_rsi"]) <= 100:
        steps.append(f"Top: if the {p['rsi_days']:g}-day RSI reached {p['top_rsi']:g} during the wave and then drops "
                     f"{p['top_drop']:g} points below its peak, the wave is sold as a top.")
    steps.append(f"Wave size: {p['target_vol']:g} divided by the coin's yearly volatility over the last 30 days, at "
                 "most all in, in quarter steps, fixed at the buy.")
    if float(p["take_gain"]) > 0:
        steps.append(f"Banking: once price is {np.expm1(float(p['take_gain'])):.0%} above the wave's buy, the wave "
                     f"keeps {float(p['take_keep']):.0%} of its size.")
    if float(p["wait_hours"]) > 0:
        steps.append(f"Timing: a new wave buys at the first 15-minute close under the {p['pull_hours']:g}-hour "
                     f"average, or after {p['wait_hours']:g} hours at the latest.")
    steps += [
        f"Snap dip: a {p['snap_hours']:g}-hour fall of {p['z_up']:g} normal moves (normal = the last "
        f"{p['snap_vol_days']:g} days) buys all in; {p['z_down']:g} are needed under the {p['snap_trend_days']:g}-day "
        f"trend. It sells when the {p['snap_hours']:g}-hour RSI tops {p['exit_rsi']:g}.",
        f"Slow dip: a fall of {p['vdip_z']:g} volatility units under the {p['vdip_hours']:g}-hour average buys all "
        "in; it sells once price is back at that average.",
        "The book holds the largest position any layer asks for.",
    ]
    return {
        "summary": (f"Rides {mk}'s big waves, decided once a day on daily closes, and buys deep panic dips on "
                    "15-minute candles for the bounce. In cash otherwise."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long climbs that stretch the daily MACD, and panic flushes that snap back within hours.",
        "whenItLoses": "A wave that rolls over without stretching first (it rides the fall), and bleeds that keep tripping the dip buys.",
    }
