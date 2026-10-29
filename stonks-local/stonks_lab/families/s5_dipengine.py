"""s5_dipengine: buy panic dips seen over two horizons, sell the first bounce, keep a small core between trades.

Built from the dip layers of the Session 4 top three: s4_rsi2's 4-hour drop and RSI exit, s4_voltarget's 50-hour
horizon, all measured against a long (weeks) volatility memory. A dip is a fall in units of the coin's normal move;
whichever horizon is deepest relative to its own threshold counts. A daily trend line sets how deep the dip must be
(deeper under it), never forbids it. Between dip trades the book holds a constant core share. Strictly causal: the
trend uses completed UTC days, everything else bars up to t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s5_dipengine"
VERSION = 1
TITLE = "Dip engine"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000


def default_params() -> dict:
    return {"hours": 4.0, "z_short": 3.2, "long_hours": 50.0, "z_long": 2.5, "vol_days": 80.0,
            "trend_days": 60.0, "down_mult": 1.25, "exit_rsi": 55.0, "core": 0.25}


def param_space() -> dict:
    return {
        "hours": {"type": "float", "min": 1.0, "max": 24.0, "description": "hours of the short drop and of the exit RSI"},
        "z_short": {"type": "float", "min": 1.0, "max": 10.0, "description": "normal moves the short drop must reach"},
        "long_hours": {"type": "float", "min": 12.0, "max": 240.0, "description": "hours of the long drop"},
        "z_long": {"type": "float", "min": 1.0, "max": 10.0, "zero": True, "description": "normal moves the long drop must reach (0 = off)"},
        "vol_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days of history that set the coin's normal volatility"},
        "trend_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in the daily trend average"},
        "down_mult": {"type": "float", "min": 1.0, "max": 3.0, "description": "how much deeper a dip must be under the trend"},
        "exit_rsi": {"type": "float", "min": 30.0, "max": 90.0, "description": "RSI level over the short hours that sells the bounce"},
        "core": {"type": "float", "min": 0.0, "max": 0.8, "description": "share held between dip trades"},
    }


def valid_params(p: dict) -> str | None:
    return None


def _step(df) -> float:
    return float(np.median(np.diff(np.asarray(df.index, dtype=np.int64)))) if len(df) > 1 else 900_000.0


def warmup(p: dict) -> int:
    return int(max(float(p["vol_days"]), float(p["trend_days"]) + 1) * 96)


def _prev_day_ema(ts: np.ndarray, c: np.ndarray, days: float) -> np.ndarray:
    """EMA of completed daily closes (UTC days), known from the first bar of the next day."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    e = ind.ema(dc, max(2, int(round(days))))
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, e[np.clip(pos, 0, None)], np.nan)


def _weights(df, p) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    if n < 3:
        return np.zeros(n)
    per_hour = _HOUR / max(_step(df), 1.0)
    span = max(2, int(round(float(p["vol_days"]) * 24 * per_hour)))
    lc = np.log(np.maximum(c, 1e-12))
    r1 = np.r_[np.nan, np.diff(lc)]
    sig = np.sqrt(pd.Series(r1 * r1).ewm(span=span, min_periods=span).mean().to_numpy())

    trend = lc - np.log(_prev_day_ema(ts, c, float(p["trend_days"])))
    mult = np.where(trend > 0.0, 1.0, float(p["down_mult"]))
    worst = np.full(n, np.inf)   # deepest drop relative to its own threshold; < -1 is a dip
    for hours, zt in ((float(p["hours"]), float(p["z_short"])), (float(p["long_hours"]), float(p["z_long"]))):
        if zt <= 0:
            continue
        k = max(1, int(round(hours * per_hour)))
        d = np.full(n, np.nan)
        if n > k:
            d[k:] = lc[k:] - lc[:-k]
        rel = d / (sig * np.sqrt(k)) / (zt * mult)
        worst = np.fmin(worst, np.where(np.isnan(rel), np.inf, rel))
    worst[np.isnan(trend) | np.isnan(sig)] = np.inf
    rsi = ind.rsi(c, max(2, int(round(float(p["hours"]) * per_hour))))

    lvl = float(p["exit_rsi"])
    w = np.zeros(n, dtype=np.float64)
    held = False
    wl, rl = worst.tolist(), rsi.tolist()
    for i in range(n):
        if not held:
            if wl[i] < -1.0:
                held = True
        elif rl[i] == rl[i] and rl[i] > lvl:
            held = False
        w[i] = 1.0 if held else 0.0
    return np.maximum(w, float(p["core"]))


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    return frame(df.index, {m: _weights(df, spec["params"]) * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    core = float(p["core"])
    long_dip = (f" or a {p['long_hours']:g}-hour fall of {p['z_long']:g}" if float(p["z_long"]) > 0 else "")
    return {
        "summary": (
            f"Keeps {core:.0%} of the money in {mk} and goes all in after a panic sell-off (a {p['hours']:g}-hour fall "
            f"of {p['z_short']:g} normal moves{long_dip}); sells back to {core:.0%} on the first bounce."
        ),
        "howItWorks": [
            f"A normal move is the coin's typical swing over that many hours, measured over the last {p['vol_days']:g} days, "
            "so wild and quiet coins are judged fairly.",
            f"Below its {p['trend_days']:g}-day trend line (completed daily closes) a dip must be {p['down_mult']:g} times as deep.",
            f"It sells the dip trade when the {p['hours']:g}-hour RSI (a 0-100 gauge of recent ups vs downs) passes {p['exit_rsi']:g}.",
            f"Between dip trades it holds a steady {core:.0%} share, which earns part of every rise.",
        ] + risk_steps(spec),
        "whenItWins": "Panic flushes and liquidation wicks that snap back within hours, in any market; steady rises through the core.",
        "whenItLoses": "Sell-offs that keep falling for days after the buy, and long drops through the core share.",
    }
