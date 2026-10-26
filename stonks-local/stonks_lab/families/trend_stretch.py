"""trend_stretch v1 (agent-12): slow MACD trend core with a volatility-scaled blow-off exit.

Per market: hold while MACD(fast, slow) > signal. When the close is stretched far above its own long EMA,
measured in units of the coin's recent volatility, z = ln(close / EMA(stretchLen)) / (sigma_bar * sqrt(stretchLen))
>= exitZ, sell and stay out ("locked") until:
  rearm = "cross": the MACD line has dropped to/below its signal line at least once (then the next cross up buys);
  rearm = "calm":  the stretch has fallen back under exitZ / 2 (re-buy if MACD is still above signal).
The idea behind it: the fixed +60 % take profit that lifted macd_trend ETH 1d banks parabolic runs; scaling the
threshold by each coin's own volatility might carry that to calmer coins such as BTC.
Multi-market: every market gets an equal slice; with concentrate=True the slices of markets that are out go to the
ones that are in (each capped at maxWeight). Decisions use closes up to and including bar t only.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps

NAME = "trend_stretch"
VERSION = 1
TITLE = "Trend with stretch exit"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"fast": 12, "slow": 182, "signal": 30, "stretchLen": 50, "volLen": 90, "exitZ": 1.1,
            "rearm": "cross", "concentrate": False}


def param_space() -> dict:
    return {
        "fast": {"type": "int", "min": 2, "max": 60, "log": True, "description": "fast EMA length of the MACD"},
        "slow": {"type": "int", "min": 20, "max": 400, "log": True, "description": "slow EMA length of the MACD"},
        "signal": {"type": "int", "min": 2, "max": 60, "log": True, "description": "signal EMA length"},
        "stretchLen": {"type": "int", "min": 10, "max": 300, "log": True, "zero": True,
                       "description": "EMA the stretch is measured from (0 = no stretch exit, plain MACD)"},
        "volLen": {"type": "int", "min": 20, "max": 365, "log": True,
                   "description": "candles of log returns in the volatility estimate"},
        "exitZ": {"type": "float", "min": 0.5, "max": 2.0,
                  "description": "sell when the stretch reaches this many volatility units"},
        "rearm": {"type": "choice", "values": ["cross", "calm"],
                  "description": "after a stretch exit: wait for a MACD recross (cross) or for the stretch to halve (calm)"},
        "concentrate": {"type": "bool", "description": "give the slices of markets that are out to the ones that are in"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["fast"] < p["slow"] else "fast must be shorter than slow"


def warmup(p: dict) -> int:
    return max(int(p["slow"]) + int(p["signal"]) - 2, int(p["stretchLen"] or 0), int(p["volLen"]) + 1)


def stretch(close: np.ndarray, stretch_len: int, vol_len: int) -> np.ndarray:
    """ln(close / EMA(stretch_len)) in units of sigma_bar(vol_len) * sqrt(stretch_len); NaN while warming up."""
    lr = np.full(len(close), np.nan)
    lr[1:] = np.log(close[1:] / close[:-1])
    sig = pd.Series(lr).rolling(vol_len, min_periods=vol_len).std(ddof=0).to_numpy()
    e = ind.ema(close, stretch_len)
    with np.errstate(divide="ignore", invalid="ignore"):
        z = np.log(close / e) / (sig * math.sqrt(stretch_len))
    return z


def state(close: np.ndarray, p: dict) -> np.ndarray:
    """1.0 = hold, 0.0 = out, NaN = undecided (warm-up). Path-dependent lock after a stretch exit."""
    line, sig, _ = ind.macd(close, int(p["fast"]), int(p["slow"]), int(p["signal"]))
    on = line > sig
    ok = np.isfinite(line) & np.isfinite(sig)
    n = len(close)
    out = np.full(n, np.nan)
    sl = int(p.get("stretchLen") or 0)
    if not sl:
        out[ok] = on[ok].astype(np.float64)
        return out
    z = stretch(close, sl, int(p["volLen"]))
    ok &= np.isfinite(z)
    ez = float(p["exitZ"])
    calm = p.get("rearm") == "calm"
    locked = False
    for t in range(n):
        if not ok[t]:
            continue
        if locked:
            if calm:
                if z[t] < ez / 2:
                    locked = False
            elif not on[t]:
                locked = False
        if not locked and on[t] and z[t] >= ez:
            locked = True
        out[t] = 1.0 if (on[t] and not locked) else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("trend_stretch needs at least one market")
    mw = max_weight(spec)
    series, index = {}, None
    for m in markets:
        df = candles[m]
        idx = np.asarray(df.index, dtype=np.int64)
        series[m] = pd.Series(state(df["close"].to_numpy(np.float64), p), index=idx)
        index = idx if index is None else np.union1d(index, idx)
    S = np.column_stack([s.reindex(index).ffill().to_numpy(np.float64) for s in series.values()])
    # Undecided until at least one market is warm; a coin that is not listed / not warm yet holds nothing.
    bad = np.isnan(S).all(axis=1)
    S = np.nan_to_num(S, nan=0.0)
    if p.get("concentrate"):
        k = S.sum(axis=1)
        W = S * (mw / np.maximum(k, 1.0))[:, None]
    else:
        W = S * (mw / len(markets))
    first = int(np.argmax(~bad)) if (~bad).any() else len(bad)
    W[:first, :] = np.nan
    return frame(index, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    n = len(spec.get("markets") or []) or 1
    steps = [
        f"After every {iv} candle it computes the MACD line of {mk}: the {bars_text(p['fast'], iv)} average price "
        f"minus the {bars_text(p['slow'], iv)} average, and its {bars_text(p['signal'], iv)} signal line.",
        "It holds while the MACD line is above its signal line (momentum building) and sits in euros otherwise.",
    ]
    if p.get("stretchLen"):
        again = ("the MACD line has dipped under its signal line and crossed back up" if p.get("rearm") != "calm"
                 else "the stretch has cooled to half that level")
        steps.append(
            f"Blow-off exit: it measures how far the price is above its {bars_text(p['stretchLen'], iv)} average, in "
            f"units of the coin's own recent volatility. At {p['exitZ']:.1f} units it sells the rally and stays out "
            f"until {again}.")
    if n > 1:
        if p.get("concentrate"):
            steps.append(f"Each of the {n} coins follows its own signal; the money is split equally over the coins "
                         "that are currently in.")
        else:
            steps.append(f"Each of the {n} coins gets an equal {pct(1 / n)} slice and follows its own signal.")
    return {
        "summary": f"A slow momentum strategy on {mk} that sells parabolic rallies: it rides the months-long trend "
                   "but takes profit when the price runs unusually far above its average.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long trends that end in sharp blow-off rallies and reversals: it banks the spike.",
        "whenItLoses": "Steady runaway bull markets: it sells early and waits for a recross while prices keep rising.",
    }
