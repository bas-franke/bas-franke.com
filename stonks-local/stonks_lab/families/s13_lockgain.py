"""s13_lockgain: Bitcoin bull, cycle check with a gain lock.

The layer follows the main strategy's own results (its core equity, worked out from its weights and the closes, before
this layer). Each time that equity makes a new best of the last ``days`` days, it notes the run behind it: the log rise
from the low of those days. Once a run of at least ``gain`` has given back ``share`` of its rise, every target is
``keep`` times its usual size, until the equity is at a new ``days``-day best again. Runs smaller than ``gain`` never
trim, so ordinary bull rides stay whole.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import frame, market_names
from ._s13_core import trimmed

NAME = "s13_lockgain"
VERSION = 1
TITLE = "Gain lock"
BOT_READY = False
MULTI_MARKET = False

_DAY = 86_400_000


def default_params() -> dict:
    return {"days": 30.0, "gain": 0.5, "share": 0.4, "keep": 0.5}


def param_space() -> dict:
    return {
        "days": {"type": "float", "min": 5.0, "max": 120.0, "label": "Days a run is measured over"},
        "gain": {"type": "float", "min": 0.1, "max": 1.5, "label": "Log rise that counts as a big run"},
        "share": {"type": "float", "min": 0.1, "max": 0.9, "label": "Share of the rise given back that locks"},
        "keep": {"type": "float", "min": 0.0, "max": 1.0, "label": "Share of the size kept while locked"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return 0


def _trim(df, core, p) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    w = np.nan_to_num(np.asarray(core, dtype=np.float64))
    n = len(c)
    m = np.ones(n)
    if n < 3:
        return m
    ts = np.asarray(df.index, dtype=np.int64)
    nb = max(2, int(round(float(p["days"]) * _DAY / max(float(np.median(np.diff(ts))), 1.0))))
    gain, share, keep = float(p["gain"]), float(p["share"]), float(p["keep"])
    r = np.zeros(n)
    r[1:] = c[1:] / c[:-1] - 1.0
    eq = np.cumsum(np.log1p(np.r_[0.0, w[:-1]] * r))        # the weight set at the last close earns this bar's move
    s = pd.Series(eq)
    lo = s.rolling(nb, min_periods=1).min().tolist()
    hi = s.rolling(nb, min_periods=1).max().tolist()
    best = run = 0.0
    locked = False
    for i, e in enumerate(eq.tolist()):
        if e >= hi[i]:
            best, run, locked = e, e - lo[i], False
        elif not locked and run >= gain and best - e >= share * run:
            locked = True
        if locked:
            m[i] = keep
    return m


def targets(candles, spec, start_time=None):
    del start_time
    m, df, w = trimmed(candles, spec, _trim)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    gain = (np.exp(float(p["gain"])) - 1) * 100
    return {
        "summary": (f"Bitcoin bull, cycle check on {mk}, cut to {float(p['keep']) * 100:.0f} % of its size after a big run "
                    "of gains starts to slip away."),
        "howItWorks": [
            "The main strategy decides every entry and exit, and the layer can only make positions smaller.",
            f"At each new {p['days']:g}-day best of the main strategy's own results, the layer notes how far they rose over those days.",
            f"If that rise was at least {gain:.0f} % and {float(p['share']) * 100:.0f} % of it (in log terms) has been given back, the lock closes.",
            f"While locked, every position is {float(p['keep']) * 100:.0f} % of its usual size, dip buys included.",
            f"The lock opens at the next {p['days']:g}-day best.",
        ],
        "whenItWins": "A crash right after a strong run: the dips bought in the fall are half size.",
        "whenItLoses": "A fast rebound right after a big giveback, which it rides at half size. It adds nothing in slow bleeds, or in crashes with no big run before them.",
        "vsBuyHold": "Holds what the main strategy holds, and half of that for the weeks after a big run slips.",
    }
