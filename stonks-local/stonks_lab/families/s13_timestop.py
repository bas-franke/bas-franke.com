"""s13_timestop: the frozen main strategy with a time stop on its crash buys.

A buy or add that the main strategy makes while the coin is ``deep`` under its best close of the last ``deep_days`` days
is a crash buy, meant to bounce fast. If price has not been ``gain`` above that buy within ``hours`` hours, the buy is
taken back (an add back to the size before it) and the size stays capped there until the main strategy goes flat. Every
other position, every ride included, is left alone.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import frame, market_names
from ._s13_core import trimmed

NAME = "s13_timestop"
VERSION = 1
TITLE = "Crash buy time stop"
BOT_READY = False
MULTI_MARKET = False

_HOUR = 3_600_000


def default_params() -> dict:
    return {"hours": 6.0, "gain": 0.05, "deep": 0.3, "deep_days": 10.0}


def param_space() -> dict:
    return {
        "hours": {"type": "float", "min": 1.0, "max": 48.0, "step": 1.0, "label": "Hours a crash buy gets to bounce"},
        "gain": {"type": "float", "min": 0.01, "max": 0.2, "step": 0.01, "label": "Gain that counts as a bounce"},
        "deep": {"type": "float", "min": 0.1, "max": 0.6, "step": 0.05, "label": "Fall under the recent best that makes a crash buy"},
        "deep_days": {"type": "float", "min": 2.0, "max": 30.0, "step": 1.0, "label": "Days of the recent best"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(float(p["deep_days"]) * 96)


def _trim(df, core, p) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    step = max(float(np.median(np.diff(ts))), 1.0) if n > 1 else 900_000.0
    per_hour = _HOUR / step
    limit = max(1, int(round(float(p["hours"]) * per_hour)))
    up = 1.0 + float(p["gain"])
    nd = max(2, int(round(float(p["deep_days"]) * 24 * per_hour)))
    line = (pd.Series(c).rolling(nd, min_periods=1).max().to_numpy() * (1.0 - float(p["deep"]))).tolist()
    mult = np.ones(n)
    cap = np.inf                # size allowed until the main strategy is flat again
    clock = -1                  # bar of the crash buy being watched (-1 = none)
    buy = base = prev = 0.0
    stopped = False
    for i, (px, w) in enumerate(zip(c.tolist(), core.tolist())):
        if w <= 0.0:
            cap, clock, stopped, prev = np.inf, -1, False, 0.0
            continue
        if w > prev and not stopped:
            clock, buy, base = (i, px, prev) if px <= line[i] else (-1, 0.0, 0.0)
        if clock >= 0:
            if px >= buy * up:
                clock = -1
            elif i - clock >= limit:
                stopped, clock, cap = True, -1, base
        if w > cap:
            mult[i] = cap / w
        prev = w
    return mult


def targets(candles, spec, start_time=None):
    del start_time
    m, df, w = trimmed(candles, spec, _trim)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (f"Bitcoin bull, cycle check on {mk}, with one addition: a buy made in a crash must bounce within "
                    f"{p['hours']:g} hours or it is sold again."),
        "howItWorks": [
            "The main strategy decides every buy and sale. This layer can only make a position smaller.",
            f"A buy or add counts as a crash buy when the coin is {float(p['deep']) * 100:.0f} % or more under its best "
            f"close of the last {p['deep_days']:g} days.",
            f"If price has not been {float(p['gain']) * 100:.0f} % above that buy within {p['hours']:g} hours, the buy is "
            "sold. An add goes back to the size before it.",
            "The size stays capped there until the main strategy goes flat and buys again.",
            "All other positions, rides included, are untouched.",
        ],
        "whenItWins": "Crashes with a second leg, like March 2020 and May 2021: the dip ladder buys the first leg, and this sells it before the next one.",
        "whenItLoses": "Crash buys that sit still for a few hours and then bounce late: the bounce is missed.",
        "vsBuyHold": "Holds the same as the main strategy nearly all the time, and less for a few days after a failed crash buy.",
    }
