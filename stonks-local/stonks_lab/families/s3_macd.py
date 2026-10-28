"""s3_macd: all in while a 30-day MACD is positive, sell only after a real stretch."""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s3_macd"
VERSION = 1
TITLE = "MACD stretch"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"days": 30, "stretch": 0.7}


def param_space() -> dict:
    return {
        "days": {"type": "int", "min": 10, "max": 60, "description": "days in the MACD"},
        "stretch": {"type": "float", "min": 0.0, "max": 1.2, "description": "how high the histogram must have been before a cross under zero sells"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(p["days"]) * 3


def _bars(df, days: float) -> int:
    ts = np.asarray(df.index, np.int64)
    step = float(np.median(np.diff(ts[: min(len(ts), 48)])))
    return max(2, int(round(float(days) * DAY_MS / max(step, 1.0))))


def _weights(df, days, level) -> np.ndarray:
    reading = compute("macd", df, _bars(df, days))
    w = np.zeros(len(reading), dtype=np.float64)
    held = False
    peak = -1e9
    prev = np.nan
    for i, v in enumerate(reading):
        if v != v:
            prev = np.nan
            continue
        if not held:
            if v > 0.0 and not (prev > 0.0):
                held = True
                peak = float(v)
        else:
            if v > peak:
                peak = float(v)
            if prev > 0.0 and v <= 0.0 and peak >= level:
                held = False
                peak = -1e9
        if held:
            w[i] = 1.0
        prev = float(v)
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    return frame(df.index, {m: _weights(df, float(p["days"]), float(p["stretch"])) * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"All in on {mk} while the {int(p['days'])}-day MACD is positive. "
            f"Sells the whole position when it crosses under zero after reaching {p['stretch']}."
        ),
        "howItWorks": [
            f"The length is {int(p['days'])} calendar days, measured in that market's own bars.",
            "The book buys when the histogram crosses above zero.",
            f"A cross under zero sells only if that swing reached {p['stretch']}. A weaker cross is not a top, so the book stays in.",
            "After a real sale the next cross above zero buys the whole position again.",
        ] + risk_steps(spec),
        "whenItWins": "A push that gets stretched and then rolls through zero, so the sale is the top turning, not a small dip.",
        "whenItLoses": "A cross under zero that was a pause, and the coin resumes higher while the book waits for the next cross up.",
    }
