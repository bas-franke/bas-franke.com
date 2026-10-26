"""wick_hours_a22 v1 (agent-22): wick_pressure's exit on daily candles cut at any UTC hour, or bagged over all 24 cuts.

wick_pressure (agent-16, finding #468) holds a coin and steps aside while the ``look``-candle mean of the daily wick
imbalance ((upper wick - lower wick) / range) is high. Its ETH 1d lead scores far above ETH hold, but its author
suspects it rides the 00:00 UTC daily candle cut (#469). Wicks depend on where a candle starts and ends, so this
family rebuilds the daily candles from 1h data:

- mode "single": daily candles open at ``hour`` UTC (hour 0 = Bitvavo's native 1d candles); pressure = mean wick
  imbalance of the last ``look`` completed daily candles. This is the close-hour robustness test.
- mode "bag": the same pressure computed for all 24 possible daily cuts (hours 0-23), each from its own completed
  candles only, and averaged: a wick signal that does not depend on one arbitrary cut.

Rule (as wick_pressure): starts invested once warm; sells when pressure >= ``exitAbove``, buys back when pressure
<= ``reenter`` (hysteresis). One decision per day at the close of the hourly candle that ends at ``hour`` UTC;
targets are NaN between decisions (position left alone). Made for 1h candles. A decision at bar t uses only daily
candles whose last bar is at or before t. On native 1d candles it decides at every close and equals wick_pressure.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..data import INTERVAL_MS
from ._base import frame, max_weight, risk_steps, single_market

NAME = "wick_hours_a22"
VERSION = 1
TITLE = "Wick pressure exit on shifted or bagged daily candles"
BOT_READY = False
MULTI_MARKET = False

H_MS = 3_600_000
D_MS = 86_400_000


def default_params() -> dict:
    return {"mode": "single", "hour": 0, "look": 63, "exitAbove": 0.0, "reenter": -0.0382}


def param_space() -> dict:
    return {
        "mode": {"type": "choice", "values": ["single", "bag"],
                 "description": "single = daily candles cut at 'hour'; bag = average of the signal over all 24 cuts"},
        "hour": {"type": "int", "min": 0, "max": 23,
                 "description": "UTC hour at which the daily candle opens/closes and the daily decision is made"},
        "look": {"type": "int", "min": 10, "max": 300, "log": True,
                 "description": "average the daily wick imbalance over this many days"},
        "exitAbove": {"type": "float", "min": -0.08, "max": 0.12,
                      "description": "sell when the mean (upper - lower wick) / range reaches this"},
        "reenter": {"type": "float", "min": -0.2, "max": 0.1,
                    "description": "buy back when it falls to this (at most exitAbove)"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["reenter"]) <= float(p["exitAbove"]) else "reenter must be at most exitAbove"


def warmup(p: dict) -> int:
    return 24 * (int(p["look"]) + 2)


def bar_ms(ts: np.ndarray, interval: str | None) -> int:
    if interval in INTERVAL_MS:
        return int(INTERVAL_MS[interval])
    return int(np.median(np.diff(ts))) if len(ts) > 1 else H_MS


def daily_cut(df: pd.DataFrame, hour: int, step: int = H_MS) -> tuple[pd.DataFrame, np.ndarray]:
    """Daily candles opening at ``hour`` UTC built from sub-daily bars of ``step`` ms, and the open time of each
    one's last bar. Only candles whose last bar exists in the data are returned (an unfinished day is never used)."""
    ts = np.asarray(df.index, dtype=np.int64)
    if len(ts) == 0:
        return df.iloc[:0], np.zeros(0, dtype=np.int64)
    key = (ts - hour * H_MS) // D_MS
    g = df.groupby(key, sort=True)
    out = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last()})
    k = out.index.to_numpy(np.int64)
    last = k * D_MS + hour * H_MS + D_MS - step
    keep = last <= ts[-1]
    out = out[keep]
    out.index = pd.Index(k[keep] * D_MS + hour * H_MS, name="ts")
    return out, last[keep]


def imbalance(d: pd.DataFrame) -> np.ndarray:
    o, h, l, c = (d[k].to_numpy(np.float64) for k in ("open", "high", "low", "close"))
    rng = h - l
    up = h - np.maximum(o, c)
    dn = np.minimum(o, c) - l
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(rng > 0, (up - dn) / rng, 0.0)


def phase_pressure(df: pd.DataFrame, hour: int, look: int, step: int = H_MS) -> tuple[np.ndarray, np.ndarray]:
    """(time the value becomes known = open of the candle's last bar, pressure) for the cut at ``hour``."""
    if step >= D_MS:                               # daily (or slower) bars: the bars are the candles
        pr = pd.Series(imbalance(df)).rolling(look, min_periods=look).mean().to_numpy()
        return np.asarray(df.index, dtype=np.int64), pr
    d, last = daily_cut(df, hour, step)
    pr = pd.Series(imbalance(d)).rolling(look, min_periods=look).mean().to_numpy()
    return last, pr


def _asof(src_t: np.ndarray, vals: np.ndarray, t: np.ndarray) -> np.ndarray:
    pos = np.searchsorted(src_t, t, side="right") - 1
    out = np.full(len(t), np.nan)
    ok = pos >= 0
    out[ok] = vals[pos[ok]]
    return out


def pressure_at(df: pd.DataFrame, p: dict, dec_t: np.ndarray, step: int = H_MS) -> np.ndarray:
    look, hour = int(p["look"]), int(p["hour"]) % 24
    if p["mode"] == "single" or step >= D_MS:
        last, pr = phase_pressure(df, hour, look, step)
        return _asof(last, pr, dec_t)
    acc = np.zeros(len(dec_t))
    for h in range(24):
        last, pr = phase_pressure(df, h, look, step)
        acc += _asof(last, pr, dec_t)          # NaN until every cut is warm
    return acc / 24.0


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    ts = np.asarray(df.index, dtype=np.int64)
    n = len(ts)
    hour = int(p["hour"]) % 24
    step = bar_ms(ts, spec.get("interval"))
    if step >= D_MS:                    # native daily candles: decide at every close (hour/bag do not apply)
        dec_idx = np.arange(n)
    else:                               # bars whose close is at hour:00 UTC
        dec_idx = np.nonzero(((ts + step) % D_MS) == hour * H_MS)[0]
    pr = pressure_at(df, p, ts[dec_idx], step)
    ex, re_ = float(p["exitAbove"]), float(p["reenter"])
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    state = 1.0
    for j, i in enumerate(dec_idx):
        x = pr[j]
        if not np.isfinite(x):
            continue
        if state == 1.0 and x >= ex - 1e-12:
            state = 0.0
        elif state == 0.0 and x <= re_ + 1e-12:
            state = 1.0
        w[i] = state * mw
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p = spec["params"]
    mk = (spec.get("markets") or ["the coin"])[0].split("-")[0]
    h = int(p["hour"]) % 24
    if p["mode"] == "bag":
        cut = ("daily candles cut at every one of the 24 UTC hours (the 24 readings are averaged, so no single "
               "candle cut decides)")
    else:
        cut = f"daily candles that close at {h:02d}:00 UTC"
    return {
        "summary": f"Holds {mk} and steps into euros while rallies keep getting sold back down inside the day.",
        "howItWorks": [
            f"Every day at {h:02d}:00 UTC it looks at {mk}'s {cut} over the last {int(p['look'])} days.",
            "For each day it compares the upper wick (prices reached but sold back down) with the lower wick (dips "
            "bought back up), relative to the day's range, and averages that.",
            f"It sells when that average reaches {float(p['exitAbove']):+.3f} (sellers dominate) and buys back once it "
            f"falls to {float(p['reenter']):+.3f} (dips get bought again).",
        ] + risk_steps(spec),
        "whenItWins": "Slow tops where every rally is sold inside the day, before the price itself breaks down.",
        "whenItLoses": "Choppy bull markets with long upper wicks: it sits in euros while the price keeps rising.",
    }
