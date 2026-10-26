"""osc_core_a09 v1 (agent-09): a slow oscillator (RSI, stochastic or CCI) used as a trend regime, with hysteresis.

The fleet uses oscillators only for dips (rsi_dip, core_dip: buy when the RSI is very low). Chart traders also use
them the other way round, as a momentum regime: a slow RSI above ~50-60 means up-moves dominate, so hold; below
~40, step aside. Unlike an SMA core (close vs a line) an oscillator measures the *balance* of up and down moves
(RSI), where the close sits in its recent range (stochastic) or how far the typical price is from its mean in
units of its mean deviation (CCI), so it may whipsaw differently.

- osc_t: RSI(len), stochastic %K(len) = (close - lowest low) / (highest high - lowest low) * 100, or CCI(len)
  mapped to 0..100 as 50 + CCI / 4 (CCI +-100 -> 75 / 25); EMA-smoothed over ``smooth`` bars.
- out -> in when osc_t >= ``onLevel``; in -> out when osc_t <= ``offLevel``; otherwise keep the state.
- optional ``gateSma``: hold only while close > SMA(gateSma) too. ``osc = none`` is the plain SMA-core ablation.
- ``dayHour`` (only on 1h candles): build daily candles closing at that UTC hour and decide once a day there (the
  close-hour check of finding #505); on any other interval it is ignored.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "osc_core_a09"
VERSION = 1
TITLE = "Oscillator regime trend core"
BOT_READY = False
MULTI_MARKET = False

H_MS = 3_600_000
D_MS = 86_400_000


def default_params() -> dict:
    return {"osc": "rsi", "len": 30, "smooth": 1, "onLevel": 55.0, "offLevel": 45.0, "gateSma": 0, "dayHour": 0}


def param_space() -> dict:
    return {
        "osc": {"type": "choice", "values": ["rsi", "stoch", "cci", "none"],
                "description": "oscillator (none = only the SMA gate, i.e. a plain SMA core)"},
        "len": {"type": "int", "min": 5, "max": 150, "log": True, "description": "oscillator length in candles"},
        "smooth": {"type": "int", "min": 1, "max": 20, "log": True,
                   "description": "EMA smoothing of the oscillator in candles (1 = none)"},
        "onLevel": {"type": "float", "min": 45, "max": 75, "description": "buy when the oscillator reaches this"},
        "offLevel": {"type": "float", "min": 20, "max": 60, "description": "sell when it falls to this"},
        "gateSma": {"type": "int", "min": 0, "max": 250, "zero": True,
                    "description": "also require close above this SMA (0 = off)"},
        "dayHour": {"type": "int", "min": 0, "max": 23,
                    "description": "on 1h candles only: UTC hour at which the daily candles close (decision hour)"},
    }


def valid_params(p) -> str | None:
    if float(p["offLevel"]) > float(p["onLevel"]):
        return "offLevel must be <= onLevel"
    if p["osc"] == "none" and int(p["gateSma"]) <= 0:
        return "osc none needs a gateSma"
    return None


def warmup(p: dict) -> int:
    return max(int(p["len"]) + int(p["smooth"]) * 3, int(p["gateSma"]))


def oscillator(df: pd.DataFrame, osc: str, n: int, smooth: int) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    if osc == "rsi":
        o = ind.rsi(c, n)
    elif osc == "stoch":
        hi = ind.rolling_max(df["high"].to_numpy(np.float64), n)
        lo = ind.rolling_min(df["low"].to_numpy(np.float64), n)
        rng = hi - lo
        with np.errstate(invalid="ignore", divide="ignore"):
            o = np.where(rng > 0, (c - lo) / rng * 100.0, 50.0)
        o[~np.isfinite(hi)] = np.nan
    elif osc == "cci":
        tp = (df["high"].to_numpy(np.float64) + df["low"].to_numpy(np.float64) + c) / 3.0
        m = ind.sma(tp, n)
        md = np.full(len(tp), np.nan)
        if len(tp) >= n:
            w = np.lib.stride_tricks.sliding_window_view(tp, n)
            md[n - 1:] = np.abs(w - w.mean(axis=1, keepdims=True)).mean(axis=1)
        with np.errstate(invalid="ignore", divide="ignore"):
            cci = np.where(md > 0, (tp - m) / (0.015 * md), 0.0)
        cci[~np.isfinite(m)] = np.nan
        o = np.clip(50.0 + cci / 4.0, 0.0, 100.0)
    elif osc == "none":
        return np.where(np.isfinite(c), 100.0, np.nan)
    else:
        raise ValueError(f"unknown osc {osc!r}")
    if smooth > 1:
        o = ind.ema(o, smooth)
    return o


def regime(df: pd.DataFrame, p: dict) -> np.ndarray:
    """1/0 position per candle of ``df`` (NaN until defined)."""
    o = oscillator(df, p["osc"], int(p["len"]), int(p["smooth"]))
    on, off = float(p["onLevel"]), float(p["offLevel"])
    c = df["close"].to_numpy(np.float64)
    g = int(p["gateSma"])
    gate = np.ones(len(c))
    if g > 0:
        sm = ind.sma(c, g)
        gate = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
    out = np.full(len(c), np.nan)
    state = None
    for i in range(len(c)):
        v, gt = o[i], gate[i]
        if v != v or gt != gt:
            continue
        if state is None:
            state = 1.0 if v >= (on + off) / 2 else 0.0
        elif state == 1.0 and v <= off:
            state = 0.0
        elif state == 0.0 and v >= on:
            state = 1.0
        out[i] = state * gt
    return out


def daily_candles(df: pd.DataFrame, hour: int) -> tuple[pd.DataFrame, np.ndarray]:
    """Daily candles opening at ``hour`` UTC built from 1h candles, plus each one's last-hour timestamp.
    Only complete days (data reaches the last hour) are kept."""
    ts = np.asarray(df.index, dtype=np.int64)
    if len(ts) == 0:
        return df.iloc[:0], np.zeros(0, dtype=np.int64)
    key = (ts - hour * H_MS) // D_MS
    g = df.groupby(key, sort=True)
    out = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    k = out.index.to_numpy(np.int64)
    last = k * D_MS + hour * H_MS + 23 * H_MS
    keep = last <= ts[-1]
    out = out[keep]
    out.index = pd.Index(k[keep] * D_MS + hour * H_MS, name="ts")
    return out, last[keep]


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    mw = max_weight(spec)
    if spec.get("interval") != "1h":
        return frame(df.index, {m: regime(df, p) * mw})
    idx = np.asarray(df.index, dtype=np.int64)
    d, last = daily_candles(df, int(p["dayHour"]) % 24)
    w = regime(d, p) if len(d) else np.zeros(0)
    out = np.full(len(idx), np.nan)
    pos = np.searchsorted(idx, last, side="left")
    ok = (pos < len(idx)) & np.isfinite(w)
    out[pos[ok]] = w[ok] * mw
    return frame(idx, {m: out})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    daily = iv == "1h"
    biv = "1d" if daily else iv
    names = {"rsi": "relative strength index (RSI: share of up-moves in recent moves)",
             "stoch": "stochastic oscillator (where the close sits between the recent high and low)",
             "cci": "commodity channel index (distance of the price from its average, in typical deviations)"}
    steps = []
    if p["osc"] != "none":
        steps += [f"It measures the momentum of {mk} with the {names[p['osc']]} over "
                  f"{bars_text(p['len'], biv)}" + (f", smoothed over {bars_text(p['smooth'], biv)}."
                                                   if int(p["smooth"]) > 1 else "."),
                  f"It buys when that reading reaches {float(p['onLevel']):.0f} (of 100) and sells when it drops to "
                  f"{float(p['offLevel']):.0f}; in between it keeps what it has."]
    if int(p["gateSma"]) > 0:
        steps.append(f"It only holds while the price is above its average over {bars_text(p['gateSma'], biv)}.")
    if daily:
        steps.append(f"It decides once a day at {int(p['dayHour']):02d}:00 UTC on daily candles closing then.")
    return {
        "summary": f"Holds {mk} while a slow momentum oscillator says up-moves dominate, euros otherwise.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long, steady trends: the oscillator stays high through the bull and drops in a lasting fall.",
        "whenItLoses": "Choppy sideways markets and sharp V-shaped rebounds: it sells low and buys back higher.",
    }
