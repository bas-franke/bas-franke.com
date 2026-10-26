"""panic_overlay v1 (agent-20): a slow daily trend core that holds the coin in uptrends, plus agent-09's
panic_bounce minute dip-buyer that uses the idle cash while the core is out (or only partly in).

Why: panic_bounce nets +1..4 % per round trip but sits in cash >99 % of the time (finding #209), and panic dips
happen mostly when the daily trend is down, i.e. exactly when a trend strategy holds cash. Combined, the trend core
supplies the exposure and the overlay adds the crash bounces.

Per bar (spec interval, meant for 5m/15m), decided at the bar close from candles up to and including that bar:
- daily closes are built from the fast candles; only *completed* UTC days count
- base ``sma``: on while the last completed daily close is above SMA(baseDays) of completed daily closes, with a
  hysteresis band (on above SMA*(1+band), off below SMA*(1-band)); base ``macd``: on while the daily MACD line
  (macdFast/macdSlow days) is above its signal (macdSignal days); base ``none``: never on (overlay alone)
- ``coreWeight``: fraction always held, whatever the base says (0 = off)
- overlay (``overlay`` true): panic_bounce's rule on the fast candles: z = (close - SMA(lookback)) / std(lookback),
  realized vol = std of 1-bar log returns over ``volBars`` scaled per day in %; enter when z < -threshold and
  vol >= volMinPct, exit when z > exitZ or after ``maxHoldBars`` bars
- weight = maxWeight * max(core, base on ? 1 : 0, overlay in trade ? 1 : 0)
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .. import indicators as ind
from ..data import DAY, INTERVAL_MS
from ._base import _INTERVAL_MIN, bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "panic_overlay"
VERSION = 1
TITLE = "Trend core with panic-dip overlay"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"base": "sma", "baseDays": 100, "band": 0.01, "macdFast": 12, "macdSlow": 182, "macdSignal": 30,
            "coreWeight": 0, "overlay": True, "lookback": 279, "threshold": 3.8, "volBars": 40,
            "volMinPct": 8.0, "exitZ": 1.0, "maxHoldBars": 8}


def param_space() -> dict:
    return {
        "base": {"type": "choice", "values": ["sma", "macd", "none"],
                 "description": "daily trend core: price above its daily SMA, daily MACD above signal, or none"},
        "baseDays": {"type": "int", "min": 10, "max": 300, "log": True,
                     "description": "SMA length of the trend core, in days (base sma)"},
        "band": {"type": "float", "min": 0.0, "max": 0.06,
                 "description": "hysteresis band around the daily SMA (0.01 = 1 %)"},
        "macdFast": {"type": "int", "min": 3, "max": 40, "log": True, "description": "daily MACD fast EMA, days"},
        "macdSlow": {"type": "int", "min": 20, "max": 250, "log": True, "description": "daily MACD slow EMA, days"},
        "macdSignal": {"type": "int", "min": 3, "max": 60, "log": True, "description": "daily MACD signal, days"},
        "coreWeight": {"type": "float", "min": 0.05, "max": 0.6, "zero": True,
                       "description": "fraction of the money always held (0 = none)"},
        "overlay": {"type": "bool", "description": "use the panic-dip overlay on the idle cash"},
        "lookback": {"type": "int", "min": 6, "max": 500, "log": True,
                     "description": "fast candles in the average / standard deviation the dip is measured against"},
        "threshold": {"type": "float", "min": 2.5, "max": 5.0,
                      "description": "buy when the close is this many standard deviations below the average"},
        "volBars": {"type": "int", "min": 12, "max": 3000, "log": True,
                    "description": "fast candles in the trailing realized volatility"},
        "volMinPct": {"type": "float", "min": 3.0, "max": 15.0, "log": True,
                      "description": "only buy dips while the realized volatility (per day, %) is at least this"},
        "exitZ": {"type": "float", "min": -1.0, "max": 2.0,
                  "description": "sell the dip trade when the z-score climbs back above this"},
        "maxHoldBars": {"type": "int", "min": 2, "max": 600, "log": True,
                        "description": "sell the dip trade anyway after this many fast candles"},
    }


def valid_params(p: dict) -> str | None:
    if p["macdFast"] >= p["macdSlow"]:
        return "macdFast must be below macdSlow"
    if p["base"] == "none" and not p["overlay"] and not p["coreWeight"]:
        return "nothing to trade"
    return None


def warmup(p: dict) -> int:
    return max(int(p["lookback"]), int(p["volBars"]) + 1)


def _daily_base(ts: np.ndarray, close: np.ndarray, step_ms: int, p: dict) -> np.ndarray:
    """Per fast bar: 1.0 / 0.0 = base on/off from completed days only, NaN = not decided yet."""
    n = len(ts)
    out = np.full(n, np.nan)
    if p["base"] == "none":
        out[:] = 0.0
        return out
    b = ts // DAY
    last = np.flatnonzero(np.r_[b[1:] != b[:-1], True])
    ub, dc = b[last], close[last]
    if p["base"] == "sma":
        s = ind.sma(dc, int(p["baseDays"]))
        band = float(p["band"])
        st = np.full(len(dc), np.nan)
        on = False
        for k in range(len(dc)):
            if not np.isfinite(s[k]):
                continue
            if on and dc[k] < s[k] * (1 - band):
                on = False
            elif not on and dc[k] > s[k] * (1 + band):
                on = True
            st[k] = 1.0 if on else 0.0
    else:
        line, sig, _ = ind.macd(dc, int(p["macdFast"]), int(p["macdSlow"]), int(p["macdSignal"]))
        st = np.where(np.isfinite(sig), (line > sig).astype(np.float64), np.nan)
    cur = (ts + step_ms) // DAY  # the day current at bar i's close
    j = np.searchsorted(ub, cur, side="left") - 1  # newest day strictly before it: complete at bar i
    ok = j >= 0
    out[ok] = st[j[ok]]
    return out


def _overlay(close: np.ndarray, p: dict, bars_per_day: float) -> tuple[np.ndarray, np.ndarray]:
    """(in_trade bool array, ready bool array) for panic_bounce's rule."""
    n = len(close)
    s = pd.Series(close)
    lb = int(p["lookback"])
    mean = s.rolling(lb, min_periods=lb).mean().to_numpy(np.float64)
    sd = s.rolling(lb, min_periods=lb).std(ddof=0).to_numpy(np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = (close - mean) / sd
    z[(sd == 0) & np.isfinite(mean)] = 0.0
    lr = np.log(s).diff()
    vb = int(p["volBars"])
    vol = (lr.rolling(vb, min_periods=vb).std(ddof=0) * math.sqrt(bars_per_day) * 100).to_numpy(np.float64)
    ready = np.isfinite(z) & np.isfinite(vol)
    if not p["overlay"]:
        return np.zeros(n, dtype=bool), ready
    enter = ((z < -float(p["threshold"])) & (vol >= float(p["volMinPct"]))).tolist()
    leave = (z > float(p["exitZ"])).tolist()
    ready_l = ready.tolist()
    max_hold = int(p["maxHoldBars"])
    inside = np.zeros(n, dtype=bool)
    pos, age = False, 0
    for i in range(n):
        if pos:
            age += 1
            if leave[i] or age >= max_hold:
                pos = False
        elif ready_l[i] and enter[i]:
            pos, age = True, 0
        inside[i] = pos
    return inside, ready


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    iv = spec.get("interval") or "5m"
    step = INTERVAL_MS.get(iv, 300_000)
    base = _daily_base(ts, c, step, p)
    inside, ready = _overlay(c, p, 1440.0 / _INTERVAL_MIN.get(iv, 5))
    core = float(p["coreWeight"] or 0.0)
    w = np.maximum(np.maximum(np.nan_to_num(base, nan=0.0), inside.astype(np.float64)), core) * max_weight(spec)
    decided = np.isfinite(base) & ready
    if decided.any():
        first = int(np.argmax(decided))
        decided[first:] = True
    w = np.where(decided, w, np.nan)
    return frame(ts, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = []
    if p["base"] == "sma":
        steps.append(f"Core: it holds {mk} while the last finished daily close is above its {p['baseDays']}-day "
                     f"average (by more than {pct(p['band'])} to switch on, less than {pct(p['band'])} below it "
                     "to switch off), and sits in euros otherwise.")
    elif p["base"] == "macd":
        steps.append(f"Core: it holds {mk} while the daily MACD ({p['macdFast']}/{p['macdSlow']} days) is above its "
                     f"{p['macdSignal']}-day signal line, and sits in euros otherwise.")
    if p["coreWeight"]:
        steps.append(f"It always keeps {pct(p['coreWeight'])} of the money in {mk}.")
    if p["overlay"]:
        steps += [
            f"With the money that is idle, it watches the {iv} candles for panics: when the typical move of the "
            f"last {bars_text(p['volBars'], iv)} is at least {p['volMinPct']} % per day and the price falls more "
            f"than {p['threshold']} standard deviations below its average of the last {bars_text(p['lookback'], iv)}, "
            "it buys the dip with everything.",
            f"It sells that dip trade when the price is back near the average (z-score above {p['exitZ']}) or after "
            f"{bars_text(p['maxHoldBars'], iv)}, unless the core wants to hold anyway.",
        ]
    return {
        "summary": f"Holds {mk} in daily uptrends and, while out, buys sharp panic drops for a quick rebound.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bull trends (the core holds) and crashes with violent snap-backs (the overlay buys the "
                      "capitulation and sells the bounce).",
        "whenItLoses": "Choppy markets around the daily average (the core flips on and off) and crashes that keep "
                       "falling after a dip buy.",
    }
