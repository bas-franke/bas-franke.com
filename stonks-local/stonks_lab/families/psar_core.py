"""psar_core v1 (agent-06, trend lane): Wilder's Parabolic SAR as a long-only trend core.

The stop-and-reverse line trails under the price in an uptrend and accelerates towards it: each bar it moves a
fraction ``af`` of the way to the extreme point (highest high of the trend), and ``af`` grows by ``afStep`` at every
new high, up to ``afMax``. When the price crosses it the trend flips: the line jumps to the extreme point of the old
trend and starts trailing from the other side. Unlike a moving average or the ATR supertrend, the exit tightens with
the *age* of the trend, not with volatility: young trends get room, mature trends a tight stop.

Long only: hold ``maxWeight`` while the SAR trend is up (and, optionally, the close is above a slow SMA), hold
``offWeight`` otherwise. ``trigger`` picks what crosses the line: the close (decided at the close) or the bar's
low/high (classic Wilder; the flip is still acted on at that bar's close). Decisions at bar t use candles up to and
including bar t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "psar_core"
VERSION = 1
TITLE = "Parabolic SAR trend core"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"afStart": 0.02, "afStep": 0.02, "afMax": 0.2, "trigger": "close", "trendSma": 0, "offWeight": 0.0}


def param_space() -> dict:
    return {
        "afStart": {"type": "float", "min": 0.002, "max": 0.1, "log": True,
                    "description": "starting acceleration: share of the gap to the extreme point the line moves per bar"},
        "afStep": {"type": "float", "min": 0.001, "max": 0.1, "log": True,
                   "description": "acceleration added at every new extreme (new high in an uptrend)"},
        "afMax": {"type": "float", "min": 0.02, "max": 0.5, "log": True,
                  "description": "cap on the acceleration"},
        "trigger": {"type": "choice", "values": ["close", "hl"],
                    "description": "what must cross the line to flip: the close, or the bar's low/high (classic)"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                     "description": "only hold while the close is above this SMA too (0 = off)"},
        "offWeight": {"type": "float", "min": 0.05, "max": 0.6, "zero": True,
                      "description": "share kept invested while the SAR trend is down (0 = all cash)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["afMax"]) < float(p["afStart"]):
        return "afMax must be >= afStart"
    return None


def warmup(p: dict) -> int:
    return max(3, int(p["trendSma"] or 0))


def sar_trend(h: np.ndarray, lo: np.ndarray, c: np.ndarray, af0: float, step: float, afmax: float,
              trigger: str = "close") -> np.ndarray:
    """1.0 where the SAR trend is up at bar i's close, 0.0 where down, NaN before it starts. Causal."""
    n = len(c)
    out = np.full(n, np.nan)
    if n < 3:
        return out
    up = bool(c[1] >= c[0])
    sar = lo[0] if up else h[0]
    ep = h[1] if up else lo[1]
    af = af0
    out[1] = 1.0 if up else 0.0
    for i in range(2, n):
        s = sar + af * (ep - sar)
        if up:
            s = min(s, lo[i - 1], lo[i - 2])
            x = c[i] if trigger == "close" else lo[i]
            if x < s:
                up, s, ep, af = False, ep, lo[i], af0
            elif h[i] > ep:
                ep, af = h[i], min(af + step, afmax)
        else:
            s = max(s, h[i - 1], h[i - 2])
            x = c[i] if trigger == "close" else h[i]
            if x > s:
                up, s, ep, af = True, ep, h[i], af0
            elif lo[i] < ep:
                ep, af = lo[i], min(af + step, afmax)
        sar = s
        out[i] = 1.0 if up else 0.0
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    h = df["high"].to_numpy(np.float64)
    lo = df["low"].to_numpy(np.float64)
    n = len(c)
    tr = sar_trend(h, lo, c, float(p["afStart"]), float(p["afStep"]), float(p["afMax"]), p["trigger"])
    ts = int(p["trendSma"] or 0)
    gate_ok = c > ind.sma(c, ts) if ts else np.ones(n, dtype=bool)
    gate_ready = np.isfinite(ind.sma(c, ts)) if ts else np.ones(n, dtype=bool)
    mw = max_weight(spec)
    off = float(p["offWeight"] or 0.0) * mw
    w = np.where((tr == 1.0) & gate_ok, mw, off)
    w = np.where(np.isfinite(tr) & gate_ready, w, np.nan)
    w[: warmup(p)] = np.nan
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    ts = int(p["trendSma"] or 0)
    off = float(p["offWeight"] or 0.0)
    trig = "closes" if p["trigger"] == "close" else "trades (the candle's low or high)"
    steps = [
        f"After every {iv} candle it updates a Parabolic SAR line for {mk}. In an uptrend the line sits under the "
        f"price and each candle moves {float(p['afStart']):g} of the way towards the trend's highest high; every new "
        f"high speeds it up by {float(p['afStep']):g}, up to {float(p['afMax']):g}. So young trends get room and old "
        "trends a tight stop.",
        f"When the price {trig} under the line the trend turns down and the line jumps above the price, falling the "
        "same way until the price crosses it upwards again.",
        "It holds while the trend is up" + (f" and the price is above its {bars_text(ts, iv)} average" if ts else "")
        + (f"; otherwise it keeps {off:.0%} invested." if off else "; otherwise it holds euros."),
    ]
    return {
        "summary": f"A Parabolic SAR trend follower on {mk}: in while the accelerating stop line stays under the price, "
                   "out after it breaks.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long trends with steady new highs, and long bear markets (it is out after the first break).",
        "whenItLoses": "Sideways markets and bull-market pullbacks: the tightening stop sells normal dips and buys back "
                       "higher, paying fees each time.",
    }
