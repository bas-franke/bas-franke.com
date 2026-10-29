"""s5_snapride: Session 4's oversold snap, plus two sized ride layers for the big rises.

Snap layer (from s4_rsi2): buy all in after a sharp few-hour sell-off measured in the coin's own long-memory
volatility (a z-score); a daily trend sets how deep that drop must be; sell when the short RSI recovers.
Breakout ride (from s4_hourly): a close above the highest close of the last high_days starts a ride, held until price
gives back a number of daily swings (short swing memory) from its peak; sized break_vol / yearly volatility.
Trend ride (from s4_voltarget): price a volatility band above its 18-day average, with a trailing stop; sized
trend_vol / yearly volatility, so at the tuned value only calm coins and calm stretches ride it.
Sizes move in quarter steps. The book holds the snap's full position, or else the larger ride. Strictly causal:
daily trend from completed UTC days, everything else from bars up to t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s5_snapride"
VERSION = 1
TITLE = "Snap and ride"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000
STEP = 0.25        # ride sizes move in quarter steps
BASE_DAYS = 30.0   # volatility memory of the trend ride (as in s4_voltarget)


def default_params() -> dict:
    return {"hours": 4.0, "vol_days": 48.0, "z_up": 3.2, "z_down": 4.4, "trend_days": 60.0, "exit_rsi": 55.0,
            "high_days": 27.0, "giveback": 3.0, "swing_days": 8.25, "break_vol": 0.4,
            "trend_ride_days": 18.0, "band": 0.4, "trail": 1.0, "trend_vol": 0.25}


def param_space() -> dict:
    return {
        "hours": {"type": "float", "min": 1.0, "max": 24.0, "description": "hours of the sell-off and of the exit RSI"},
        "vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the coin's normal volatility for the snap"},
        "z_up": {"type": "float", "min": 1.5, "max": 8.0, "description": "how many normal moves the drop must be when the daily trend is up"},
        "z_down": {"type": "float", "min": 1.5, "max": 8.0, "description": "the same when the daily trend is down"},
        "trend_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in the daily trend average"},
        "exit_rsi": {"type": "float", "min": 30.0, "max": 90.0, "description": "RSI level that sells the bounce"},
        "high_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "a close above the highest close of this many days starts a breakout ride"},
        "giveback": {"type": "float", "min": 0.5, "max": 12.0, "description": "the breakout ride ends when price falls this many daily swings below its peak"},
        "swing_days": {"type": "float", "min": 2.0, "max": 200.0, "description": "days of history that set the daily swing for the breakout's trailing exit"},
        "break_vol": {"type": "float", "min": 0.0, "max": 5.0, "description": "yearly volatility a full breakout ride may carry; wilder coins ride smaller"},
        "trend_ride_days": {"type": "float", "min": 3.0, "max": 90.0, "description": "days in the average of the trend ride"},
        "band": {"type": "float", "min": 0.05, "max": 2.0, "description": "volatility units above / below that average that switch the trend ride on / off"},
        "trail": {"type": "float", "min": 0.2, "max": 4.0, "description": "fall from the high (volatility units) that ends a trend ride early"},
        "trend_vol": {"type": "float", "min": 0.0, "max": 5.0, "description": "yearly volatility a full trend ride may carry (calm coins only at low values)"},
    }


def valid_params(p: dict) -> str | None:
    return None


def _step(df) -> float:
    return float(np.median(np.diff(np.asarray(df.index, dtype=np.int64)))) if len(df) > 1 else 900_000.0


def warmup(p: dict) -> int:
    return int(max(float(p["vol_days"]), float(p["trend_days"]) + 1, float(p["high_days"]), float(p["swing_days"]),
                   float(p["trend_ride_days"]), BASE_DAYS) * 96)


def _prev_day_ema(ts: np.ndarray, c: np.ndarray, days: float) -> np.ndarray:
    """EMA of completed daily closes (UTC days), known from the first bar of the next day."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    e = ind.ema(dc, max(2, int(round(days))))
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, e[np.clip(pos, 0, None)], np.nan)


def _ema(x: np.ndarray, span: int) -> np.ndarray:
    return pd.Series(x).ewm(span=max(int(span), 1), adjust=False).mean().to_numpy(np.float64)


def _size(target: float, yearly: np.ndarray) -> np.ndarray:
    return np.floor(np.clip(target / np.maximum(yearly, 1e-9), 0.0, 1.0) / STEP + 1e-9) * STEP


def _weights(df, p) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    if n < 3:
        return np.zeros(n)
    hours, vol_days = float(p["hours"]), float(p["vol_days"])
    z_up, z_down, exit_rsi = float(p["z_up"]), float(p["z_down"]), float(p["exit_rsi"])
    give, band, trail = float(p["giveback"]), float(p["band"]), float(p["trail"])
    per_hour = _HOUR / max(_step(df), 1.0)
    bars = lambda days: max(2, int(round(days * 24 * per_hour)))  # noqa: E731
    lc = np.log(c)
    r1 = np.r_[np.nan, np.diff(lc)]
    r0 = np.nan_to_num(r1)

    # snap layer (s4_rsi2): a k-bar fall in units of the long-memory volatility, depth set by the daily trend
    k = max(1, int(round(hours * per_hour)))
    span = bars(vol_days)
    sig = np.sqrt(pd.Series(r1 * r1).ewm(span=span, min_periods=span).mean().to_numpy())
    dk = np.full(n, np.nan)
    if n > k:
        dk[k:] = lc[k:] - lc[:-k]
    z = dk / (sig * np.sqrt(k))
    rsi = ind.rsi(c, max(2, k))
    trend = lc - np.log(_prev_day_ema(ts, c, float(p["trend_days"])))

    # breakout ride (s4_hourly): close above the high_days high, trailing exit in daily swings; sized by break_vol
    nh = bars(float(p["high_days"]))
    hi = pd.Series(lc).rolling(nh, min_periods=nh).max().shift(1).to_numpy()
    rspan = bars(float(p["swing_days"]))
    rsig = np.sqrt(pd.Series(r1 * r1).ewm(span=rspan, min_periods=rspan).mean().to_numpy())
    day_sd = rsig * np.sqrt(24 * per_hour)
    bsize = _size(float(p["break_vol"]), sig * np.sqrt(365 * 24 * per_hour))

    # trend ride (s4_voltarget): price a band above its average, trailing stop, sized by trend_vol
    nt = bars(float(p["trend_ride_days"]))
    vol = np.maximum(np.sqrt(_ema(r0 * r0, bars(BASE_DAYS))), 1e-12)
    scale = vol * np.sqrt(nt)
    dev = (lc - np.log(_ema(c, nt))) / scale
    tsize = _size(float(p["trend_vol"]), vol * np.sqrt(bars(365.0)))
    warm = bars(max(float(p["trend_ride_days"]), BASE_DAYS))

    w = np.zeros(n, dtype=np.float64)
    held = brk = up = blocked = False
    bpeak = tpeak = bsz = 0.0
    zl, rl, tl, ll, hl, sl, bl = z.tolist(), rsi.tolist(), trend.tolist(), lc.tolist(), hi.tolist(), day_sd.tolist(), bsize.tolist()
    dl, scl, tsl = dev.tolist(), scale.tolist(), tsize.tolist()
    for i in range(n):
        zi, ri, ti, li = zl[i], rl[i], tl[i], ll[i]
        if not (zi != zi or ri != ri or ti != ti):
            if not held:
                if zi < -(z_up if ti > 0.0 else z_down):
                    held = True
            elif ri > exit_rsi:
                held = False
        if not brk:
            if hl[i] == hl[i] and sl[i] == sl[i] and li > hl[i] and bl[i] > 0:
                brk, bpeak, bsz = True, li, bl[i]
        else:
            if li > bpeak:
                bpeak = li
            if li < bpeak - give * sl[i]:
                brk = False
        wt = 0.0
        if i >= warm:
            d = dl[i]
            if up:
                if li > tpeak:
                    tpeak = li
                if d < -band or li < tpeak - trail * scl[i]:
                    up = False
                    blocked = d >= -band          # trail exit: wait for price to reset under the average
            else:
                if blocked and d < 0:
                    blocked = False
                if d > band and not blocked:
                    up, tpeak = True, li
            if up:
                wt = tsl[i]
        w[i] = 1.0 if held else max(bsz if brk else 0.0, wt)
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    w = _weights(df, spec["params"])
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    hrs = f"{p['hours']:g}"
    return {
        "summary": (
            f"Buys {mk} all in after a sharp {hrs}-hour sell-off and sells the bounce. Between snaps it rides part of "
            f"the book on breakouts to a {p['high_days']:g}-day high and, on calm coins, on a {p['trend_ride_days']:g}-day trend."
        ),
        "howItWorks": [
            f"A normal move is the coin's typical swing over the last {p['vol_days']:g} days, so wild and quiet coins are judged fairly.",
            f"Snap: a {hrs}-hour fall of {p['z_up']:g} normal moves buys all in when the coin is above its {p['trend_days']:g}-day "
            f"trend, {p['z_down']:g} when below. It sells when the {hrs}-hour RSI climbs past {p['exit_rsi']:g}.",
            f"Breakout ride: a close above the highest close of the previous {p['high_days']:g} days buys a share of the book "
            f"({p['break_vol']:g} divided by the coin's yearly volatility, in quarter steps). It ends when price falls "
            f"{p['giveback']:g} daily swings (measured over {p['swing_days']:g} days) below its best price since the buy.",
            f"Trend ride: when price is {p['band']:g} volatility units above its {p['trend_ride_days']:g}-day average it holds "
            f"{p['trend_vol']:g} divided by the yearly volatility (often nothing on wild coins); it ends {p['band']:g} units "
            f"under the average or after a {p['trail']:g}-unit fall from the high.",
            "A snap trade is all in; otherwise the book holds the larger ride; with none it sits in cash.",
        ] + risk_steps(spec),
        "whenItWins": "Panic flushes that snap back within hours, and long rallies that keep making new highs.",
        "whenItLoses": "Breakouts that fail right after the buy, and sell-offs that keep falling for days.",
    }
