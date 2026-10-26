"""macd_trend v1: long while MACD > signal (and, with requirePositive, MACD > 0), otherwise cash."""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "macd_trend"
VERSION = 1
TITLE = "MACD trend"
BOT_READY = True
MULTI_MARKET = False


def default_params() -> dict:
    return {"fast": 12, "slow": 26, "signal": 9, "requirePositive": False}


def param_space() -> dict:
    return {
        "fast": {"type": "int", "min": 2, "max": 60, "log": True, "description": "fast EMA length"},
        "slow": {"type": "int", "min": 5, "max": 200, "log": True, "description": "slow EMA length"},
        "signal": {"type": "int", "min": 2, "max": 50, "log": True, "description": "signal EMA length"},
        "requirePositive": {"type": "bool", "description": "only hold while the MACD line is above zero"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["fast"] < p["slow"] else "fast must be shorter than slow"


def warmup(p: dict) -> int:
    return int(p["slow"]) + int(p["signal"]) - 2


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    line, sig, _ = ind.macd(c, p["fast"], p["slow"], p["signal"])
    on = line > sig
    if p.get("requirePositive"):
        on &= line > 0
    w = np.where(on, max_weight(spec), 0.0)
    w[~(np.isfinite(line) & np.isfinite(sig))] = np.nan
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = [
        f"After every {iv} candle it computes the MACD line: the {bars_text(p['fast'], iv)} average price minus the "
        f"{bars_text(p['slow'], iv)} average (both exponential).",
        f"It also smooths the MACD line itself over {bars_text(p['signal'], iv)}: the signal line.",
        f"When the MACD line is above its signal line, momentum is up: it holds {mk}. Otherwise it holds euros.",
    ]
    if p.get("requirePositive"):
        steps.append("Extra filter: it only holds while the MACD line is above zero, i.e. the short-term average is "
                     "above the long-term one.")
    return {
        "summary": f"A momentum strategy on {mk}: it holds while upward momentum is building and sits in euros "
                   "when momentum fades.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Clear trending moves where momentum keeps building for a while.",
        "whenItLoses": "Sideways or whipsawing prices, where momentum flips often and each flip costs fees.",
    }
