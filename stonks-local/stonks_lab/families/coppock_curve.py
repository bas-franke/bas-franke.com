"""coppock_curve v1: Coppock curve bottom-turn entries (a slow, long-horizon momentum oscillator).

Coppock = WMA(ROC(rocLong) + ROC(rocShort), wma) with ROC(k) = close / close[i-k] - 1 (in %).
It buys when the curve turns up (rises bar on bar) from below ``buyBelow``. exit "cross": sell when the curve drops
below zero; exit "turn": sell when the curve turns down while above ``sellAbove``.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "coppock_curve"
VERSION = 1
TITLE = "Coppock curve"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"rocLong": 14, "rocShort": 11, "wma": 10, "buyBelow": 0.0, "exit": "cross", "sellAbove": 20.0}


def param_space() -> dict:
    return {
        "rocLong": {"type": "int", "min": 3, "max": 400, "log": True, "description": "long rate-of-change length"},
        "rocShort": {"type": "int", "min": 2, "max": 300, "log": True, "description": "short rate-of-change length"},
        "wma": {"type": "int", "min": 2, "max": 200, "log": True, "description": "weighted average length"},
        "buyBelow": {"type": "float", "min": -50.0, "max": 50.0,
                     "description": "only buy turns that start below this curve level (%)"},
        "exit": {"type": "choice", "values": ["cross", "turn"],
                 "description": "sell when the curve crosses below zero, or turns down above sellAbove"},
        "sellAbove": {"type": "float", "min": 0.0, "max": 200.0,
                      "description": "exit 'turn': only sell turns that start above this level (%)"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["rocShort"] < p["rocLong"] else "rocShort must be shorter than rocLong"


def warmup(p: dict) -> int:
    return int(p["rocLong"]) + int(p["wma"])


def wma(x, n: int) -> np.ndarray:
    """Linearly weighted moving average (weights 1..n, newest heaviest); NaN in the window gives NaN."""
    x = np.asarray(x, np.float64)
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        wts = np.arange(1, n + 1, dtype=np.float64)
        out[n - 1:] = np.convolve(x, wts[::-1], mode="valid") / wts.sum()
    return out


def coppock(close, roc_long: int, roc_short: int, n: int) -> np.ndarray:
    s = 100.0 * (ind.rolling_return(close, roc_long) + ind.rolling_return(close, roc_short))
    return wma(s, n)


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    cc = coppock(df["close"].to_numpy(np.float64), int(p["rocLong"]), int(p["rocShort"]), int(p["wma"]))
    prev = ind.shift(cc, 1)
    mw = max_weight(spec)
    w = np.full(len(cc), np.nan)
    held = False
    for i in range(len(cc)):
        if not (np.isfinite(cc[i]) and np.isfinite(prev[i])):
            continue
        if held:
            if p["exit"] == "cross" and cc[i] < 0:
                held = False
            elif p["exit"] == "turn" and cc[i] < prev[i] and prev[i] > p["sellAbove"]:
                held = False
        elif cc[i] > prev[i] and prev[i] < p["buyBelow"]:
            held = True
        w[i] = mw if held else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    exit_text = ("It sells everything when the curve drops below zero." if p["exit"] == "cross" else
                 f"It sells everything when the curve turns down from above {p['sellAbove']:.0f}.")
    return {
        "summary": f"A slow bottom-picker for {mk}: it buys when long-term momentum stops falling and starts to "
                   "turn up, and holds through the recovery.",
        "howItWorks": [
            f"After every {iv} candle it adds {mk}'s % change over {bars_text(int(p['rocLong']), iv)} and over "
            f"{bars_text(int(p['rocShort']), iv)}, and smooths that with a weighted average of "
            f"{bars_text(int(p['wma']), iv)} (the Coppock curve).",
            f"It buys when the curve rises again after being below {p['buyBelow']:.0f}.",
            exit_text,
            *risk_steps(spec),
        ],
        "whenItWins": "After deep bear markets: it gets in early in the recovery and stays in for the bull run.",
        "whenItLoses": "False bottoms: the curve can turn up mid-decline and then fall again.",
    }
