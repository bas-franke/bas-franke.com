"""quad_bend v1 (agent-19, risk lane): the bend (curvature) of the recent price path as a trend / step-aside signal.

Every bar t fits a parabola  ln(close) = a + b*x + c*x^2  through the last ``fitLen`` closes (x scaled to -0.5..0.5,
closes up to and including bar t only). The quadratic coefficient c says whether the path is bending up
(accelerating, c > 0) or bending over (decelerating / rounding top, c < 0). It is made scale-free by dividing by the
window's daily-return standard deviation times sqrt(fitLen):  bend = c / (sigma * sqrt(fitLen)), so a threshold means
the same on BTC and ETH and at every window length (a random walk gives |bend| of order 1).

Pre-holdout signal study (agent-19, BTC/ETH 1d 2019-2025, forward 30 days): the "bubble" reading (high positive bend
= parabolic blow-off = sell) is wrong; high bend was followed by *higher* returns (top decile with positive 60d
momentum: BTC +7.4 % vs +3.6 % for all positive-momentum days). A strongly negative bend (rounding over) was followed
by weak returns in every momentum tercile on ETH 60d and in 2 of 3 on BTC.

Modes (state with hysteresis: on when bend >= bendIn, off when bend < bendOut):
- ``gate``: hold while the bend state is on.
- ``or_sma``: hold while the close is above SMA(smaLen) OR the bend state is on.
- ``and_sma``: hold only while the close is above SMA(smaLen) AND the bend state is on.
``minHold`` keeps a new position at least that many bars. Each market is decided on its own candles and gets
maxWeight / len(markets) while held.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "quad_bend"
VERSION = 1
TITLE = "Price-path bend (curvature)"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"fitLen": 60, "mode": "gate", "bendIn": -0.5, "bendOut": -1.0, "smaLen": 130, "minHold": 0}


def param_space() -> dict:
    return {
        "fitLen": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "candles in the parabola fitted through the log price"},
        "mode": {"type": "choice", "values": ["gate", "or_sma", "and_sma"],
                 "description": "gate: bend alone; or_sma: above SMA or bend on; and_sma: above SMA and bend on"},
        "bendIn": {"type": "float", "min": -2.0, "max": 1.5,
                   "description": "bend state switches on at or above this (vol-scaled curvature)"},
        "bendOut": {"type": "float", "min": -3.0, "max": 1.0,
                    "description": "bend state switches off below this (<= bendIn)"},
        "smaLen": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "SMA core length for or_sma / and_sma"},
        "minHold": {"type": "int", "min": 1, "max": 60, "zero": True, "log": True,
                    "description": "keep a new position at least this many candles (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["bendOut"]) > float(p["bendIn"]):
        return "bendOut must not exceed bendIn"
    return None


def warmup(p: dict) -> int:
    n = int(p["fitLen"])
    if p.get("mode", "gate") != "gate":
        n = max(n, int(p["smaLen"]))
    return n


def bend_series(close: np.ndarray, n: int) -> np.ndarray:
    """Vol-scaled quadratic coefficient of ln(close) over the last n bars, at every bar t >= n-1 (NaN before)."""
    y = np.log(np.asarray(close, dtype=np.float64))
    m = len(y)
    out = np.full(m, np.nan)
    if n < 4 or m < n:
        return out
    x = (np.arange(n, dtype=np.float64) - (n - 1) / 2.0) / n
    X = np.vstack([np.ones(n), x, x * x]).T
    P = np.linalg.pinv(X)                                   # (3, n)
    W = np.lib.stride_tricks.sliding_window_view(y, n)      # row i ends at bar i+n-1
    c = W @ P[2]
    r = np.diff(W, axis=1)
    sd = r.std(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = np.where(sd > 0, c / (sd * np.sqrt(n)), 0.0)
    out[n - 1:] = z
    return out


def _held(close: np.ndarray, p: dict) -> np.ndarray:
    n = len(close)
    out = np.full(n, np.nan)
    bend = bend_series(close, int(p["fitLen"]))
    mode = p.get("mode", "gate")
    sma = ind.sma(close, int(p["smaLen"])) if mode != "gate" else None
    b_in, b_out = float(p["bendIn"]), float(p["bendOut"])
    min_hold = int(p.get("minHold") or 0)
    on = False
    held = False
    age = 0
    for t in range(n):
        if np.isnan(bend[t]) or (sma is not None and np.isnan(sma[t])):
            continue
        if on:
            if bend[t] < b_out:
                on = False
        elif bend[t] >= b_in:
            on = True
        if mode == "gate":
            want = on
        elif mode == "or_sma":
            want = on or close[t] > sma[t]
        else:
            want = on and close[t] > sma[t]
        if held and not want and min_hold and age < min_hold:
            want = True
        if want and not held:
            age = 0
        held = want
        age += 1
        out[t] = 1.0 if held else 0.0
    return out


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    cols = [_asof(candles[m], _held(candles[m]["close"].to_numpy(np.float64), p), idx) * each for m in markets]
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    mode = p.get("mode", "gate")
    look = bars_text(p["fitLen"], iv)
    bend = (f"the price path of the last {look} is not bending over (a curved line through the log price; it "
            f"switches off when the bend drops under {float(p['bendOut']):.2f} and back on at "
            f"{float(p['bendIn']):.2f} or more)")
    avg = f"its average of the last {bars_text(p['smaLen'], iv)}"
    if mode == "gate":
        rule = f"It holds {mk} while {bend}, and is in cash while the rise is rounding over or a fall is speeding up."
    elif mode == "or_sma":
        rule = f"It holds {mk} while the price is above {avg}, and also below it as long as {bend}."
    else:
        rule = f"It holds {mk} only while the price is above {avg} and {bend}."
    steps = [rule + (f" ({100 / k:.0f} % of the money per coin.)" if k > 1 else "")]
    mh = int(p.get("minHold") or 0)
    if mh:
        steps.append(f"After buying it keeps the position at least {bars_text(mh, iv)}.")
    return {
        "summary": f"Watches whether the price curve of {mk} is speeding up or rounding over, and steps aside when "
                   "it bends down.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Rounded tops and slow roll-overs, which it leaves before a moving average would.",
        "whenItLoses": "Sharp V-shaped dips inside bull runs (the curve bends down briefly) and sudden crashes from "
                       "a still-accelerating rally.",
    }
