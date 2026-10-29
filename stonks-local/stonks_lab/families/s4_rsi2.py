"""s4_rsi2: buy sharp intraday sell-offs (oversold snaps), sell the bounce; a daily trend decides how deep a dip must be.

Connors-style short-term reversion on intraday bars. The "oversold" reading is not a fixed RSI level but how far price
fell over the last few hours, measured in that coin's own normal volatility (a z-score), so a 3 % drop on a quiet coin
and a 6 % drop on a wild one count the same. When the coin trades above its daily trend line the bar is lower
(aggressive dip buying), below it a deeper flush is needed. The position is sold when a short RSI over the same hours
recovers. Strictly causal: the daily trend uses completed UTC days only, volatility and RSI use bars up to t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "s4_rsi2"
VERSION = 1
TITLE = "Oversold snap"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000
_DAY = 86_400_000


def default_params() -> dict:
    return {"hours": 4.0, "vol_days": 48.0, "z_up": 3.2, "z_down": 4.4, "trend_days": 60.0, "exit_rsi": 55.0}


def param_space() -> dict:
    return {
        "hours": {"type": "float", "min": 1.0, "max": 24.0, "description": "hours of the sell-off and of the exit RSI"},
        "vol_days": {"type": "float", "min": 5.0, "max": 200.0, "description": "days of history that set the coin's normal volatility"},
        "z_up": {"type": "float", "min": 1.5, "max": 8.0, "description": "how many normal moves the drop must be when the daily trend is up"},
        "z_down": {"type": "float", "min": 1.5, "max": 8.0, "description": "the same when the daily trend is down"},
        "trend_days": {"type": "float", "min": 5.0, "max": 300.0, "description": "days in the daily trend average"},
        "exit_rsi": {"type": "float", "min": 30.0, "max": 90.0, "description": "RSI level that sells the bounce"},
    }


def valid_params(p: dict) -> str | None:
    return None


def _step(df) -> float:
    return float(np.median(np.diff(np.asarray(df.index, dtype=np.int64)))) if len(df) > 1 else 900_000.0


def warmup(p: dict) -> int:
    # in 15m bars (the session interval); the trend needs completed days, volatility its EWM span
    return int(max(float(p["vol_days"]), float(p["trend_days"]) + 1) * 96)


def _prev_day_ema(ts: np.ndarray, c: np.ndarray, days: float) -> np.ndarray:
    """EMA of completed daily closes (UTC days), known from the first bar of the next day."""
    d = ts // _DAY
    last = np.r_[d[1:] != d[:-1], True]
    dd, dc = d[last], c[last]
    e = ind.ema(dc, max(2, int(round(days))))
    pos = np.searchsorted(dd, d, side="left") - 1
    return np.where(pos >= 0, e[np.clip(pos, 0, None)], np.nan)


def _weights(df, hours, vol_days, z_up, z_down, trend_days, exit_rsi) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    if n < 3:
        return np.zeros(n)
    per_hour = _HOUR / max(_step(df), 1.0)
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

    w = np.zeros(n, dtype=np.float64)
    held = False
    zl, rl, tl = z.tolist(), rsi.tolist(), trend.tolist()
    for i in range(n):
        zi, ri, ti = zl[i], rl[i], tl[i]
        if zi != zi or ri != ri or ti != ti:
            w[i] = 1.0 if held else 0.0
            continue
        if not held:
            if zi < -(z_up if ti > 0.0 else z_down):
                held = True
        elif ri > exit_rsi:
            held = False
        w[i] = 1.0 if held else 0.0
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, float(p["hours"]), float(p["vol_days"]), float(p["z_up"]), float(p["z_down"]),
                 float(p["trend_days"]), float(p["exit_rsi"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    hrs = f"{p['hours']:g}"
    return {
        "summary": (
            f"Buys {mk} after a sharp {hrs}-hour sell-off and sells the bounce. A dip counts when the fall is "
            f"{p['z_up']:g} normal moves deep while the coin is above its {p['trend_days']:g}-day trend, "
            f"or {p['z_down']:g} when it is below."
        ),
        "howItWorks": [
            f"A normal move is the coin's typical {hrs}-hour swing over the last {p['vol_days']:g} days, so wild and quiet coins are judged fairly.",
            f"The daily trend is the {p['trend_days']:g}-day average of completed daily closes.",
            f"Above that line it buys dips of {p['z_up']:g} normal moves (more often); below it, only flushes of {p['z_down']:g}.",
            f"It sells the whole position when the {hrs}-hour RSI (a 0-100 gauge of recent ups vs downs) climbs past {p['exit_rsi']:g}.",
            "Most of the time it sits in cash, which is what keeps it out of long drops.",
        ] + risk_steps(spec),
        "whenItWins": "Panic flushes and liquidation wicks that snap back within hours, in quiet or rising markets.",
        "whenItLoses": "A sell-off that keeps falling for days, and long steady rises it mostly sits out.",
    }
