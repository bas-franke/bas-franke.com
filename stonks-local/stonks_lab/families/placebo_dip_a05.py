"""placebo_dip_a05 v1 (agent-05): SMA trend core plus RANDOM dip buys: the null benchmark for "core + panic dip".

Not a strategy. The fleet's most validated BTC lead (core_dip, breadth_dip, froth_dip, vol_panic...) is an SMA core
plus a few short "panic" holds while the price is below the SMA. This family keeps the core and replaces the panic
signal by chance, at a chosen rate and holding time, so the question "does the panic signal pick better moments than
random buys below the SMA?" gets a distribution to compare with:

- hold while close > SMA(coreSma) (the core), OR while a random dip spell is running;
- a dip spell can only start on a bar where the close is at or below the SMA; it starts with probability 1/meanGap
  per such bar (on average one start per meanGap below-core bars) and lasts a geometric number of bars with mean
  meanLen (it may run on after the price recovers above the SMA, like a real dip trade);
- two uniform draws per bar from numpy's PCG64 generator seeded with ``seed``, taken in bar order, never looking at
  prices (only the core gate does), so a truncated history gives the same prefix and there is no look-ahead.

Single market.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "placebo_dip_a05"
VERSION = 1
TITLE = "Trend core plus random dip buys (null benchmark)"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"seed": 1, "coreSma": 45, "meanGap": 80, "meanLen": 20}


def param_space() -> dict:
    return {
        "seed": {"type": "int", "min": 1, "max": 1_000_000_000, "log": True,
                 "description": "random seed: each seed is one random set of dip buys"},
        "coreSma": {"type": "int", "min": 10, "max": 400, "log": True,
                    "description": "hold while the close is above this SMA"},
        "meanGap": {"type": "int", "min": 5, "max": 1000, "log": True,
                    "description": "average number of below-SMA candles between random dip buys"},
        "meanLen": {"type": "int", "min": 1, "max": 200, "log": True,
                    "description": "average number of candles a random dip hold lasts"},
    }


def warmup(p: dict) -> int:
    return int(p["coreSma"])


def dip_state(below: np.ndarray, seed: int, mean_gap: float, mean_len: float) -> np.ndarray:
    """1 while a random dip spell runs. ``below`` (bool) marks bars where a spell may start."""
    n = len(below)
    u = np.random.Generator(np.random.PCG64(int(seed))).random((n, 2))
    p_start, p_end = 1.0 / max(float(mean_gap), 1.0), 1.0 / max(float(mean_len), 1.0)
    out = np.zeros(n)
    s = 0.0
    for i in range(n):
        if s == 1.0 and u[i, 1] < p_end:
            s = 0.0
        elif s == 0.0 and below[i] and u[i, 0] < p_start:
            s = 1.0
        out[i] = s
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    sm = ind.sma(c, int(p["coreSma"]))
    ok = np.isfinite(sm) & np.isfinite(c)
    below = ok & (c <= sm)
    st = dip_state(below, int(p["seed"]), float(p["meanGap"]), float(p["meanLen"]))
    w = np.where(ok, np.maximum((c > sm).astype(np.float64), st), np.nan) * max_weight(spec)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": f"Trend core on {mk} plus dip buys at random moments: a luck benchmark, never a strategy to trade.",
        "howItWorks": [
            f"It holds {mk} while the price is above its {bars_text(int(p['coreSma']), iv)} average.",
            f"Below that average it buys at random moments (on average once every {bars_text(int(p['meanGap']), iv)} "
            f"spent below it) and holds each random buy for about {bars_text(int(p['meanLen']), iv)} "
            f"(random seed {p['seed']}).",
            "The random buys ignore the price: comparing many seeds with a real dip signal shows how much of that "
            "signal's score could be luck.",
            *risk_steps(spec),
        ],
        "whenItWins": "Only by luck: when its random dip buys happen to land on the bottoms.",
        "whenItLoses": "Whenever its random buys land in the middle of a decline.",
    }
