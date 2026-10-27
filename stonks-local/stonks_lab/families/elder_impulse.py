"""elder_impulse v1: Elder impulse system (EMA slope + MACD histogram slope) as a long/cash switch.

green = EMA(emaN) rising and MACD histogram rising -> long; red = both falling -> cash; blue (mixed) -> ``blue``:
"hold" keeps the previous weight, "half" holds half of maxWeight, "cash" sells.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "elder_impulse"
VERSION = 1
TITLE = "Elder impulse"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"emaN": 13, "fast": 12, "slow": 26, "signal": 9, "blue": "hold"}


def param_space() -> dict:
    return {
        "emaN": {"type": "int", "min": 3, "max": 200, "log": True, "description": "trend EMA length"},
        "fast": {"type": "int", "min": 2, "max": 60, "log": True, "description": "MACD fast EMA"},
        "slow": {"type": "int", "min": 5, "max": 200, "log": True, "description": "MACD slow EMA"},
        "signal": {"type": "int", "min": 2, "max": 50, "log": True, "description": "MACD signal EMA"},
        "blue": {"type": "choice", "values": ["hold", "half", "cash"],
                 "description": "what to do on mixed (blue) bars"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["fast"] < p["slow"] else "fast must be shorter than slow"


def warmup(p: dict) -> int:
    return max(int(p["emaN"]), int(p["slow"]) + int(p["signal"]) - 1)


def impulse(close, ema_n: int, fast: int, slow: int, signal: int) -> np.ndarray:
    """+1 green, -1 red, 0 blue, NaN before both slopes are defined."""
    e = ind.ema(close, ema_n)
    line, sig, hist = ind.macd(close, fast, slow, signal)
    de, dh = e - ind.shift(e, 1), hist - ind.shift(hist, 1)
    out = np.where((de > 0) & (dh > 0), 1.0, np.where((de < 0) & (dh < 0), -1.0, 0.0))
    out[~(np.isfinite(de) & np.isfinite(dh))] = np.nan
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    imp = impulse(df["close"].to_numpy(np.float64), int(p["emaN"]), int(p["fast"]), int(p["slow"]),
                  int(p["signal"]))
    mw, blue = max_weight(spec), p["blue"]
    w = np.full(len(imp), np.nan)
    cur = 0.0
    for i, v in enumerate(imp):
        if not np.isfinite(v):
            continue
        if v > 0:
            cur = mw
        elif v < 0:
            cur = 0.0
        elif blue == "half":
            cur = mw / 2
        elif blue == "cash":
            cur = 0.0
        w[i] = cur
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    blue = {"hold": "it keeps whatever it holds", "half": "it holds half a position",
            "cash": "it sells and waits in euros"}[p["blue"]]
    return {
        "summary": f"Holds {mk} only while both trend and momentum are pushing up (Elder's 'green' impulse).",
        "howItWorks": [
            f"After every {iv} candle it checks whether the {bars_text(int(p['emaN']), iv)} exponential average "
            "is rising, and whether the MACD histogram "
            f"({p['fast']}/{p['slow']}/{p['signal']}) is rising.",
            "Both rising (green): it buys a full position. Both falling (red): it sells everything.",
            f"Mixed (blue): {blue}.",
            *risk_steps(spec),
        ],
        "whenItWins": "Strong impulsive rallies where trend and momentum agree.",
        "whenItLoses": "Slow, choppy markets that flip between green and red, paying fees each time.",
    }
