"""placebo_timing v1 (agent-05): RANDOM in/out timing with a chosen exposure and holding time: a null benchmark.

Not a strategy. It answers "what score does pure luck get on these folds?". The fleet ranks hundreds of variants per
cell and keeps the best, so a lead has to beat the *best of many random timings* with the same exposure and trade
count, not just buy and hold. This family produces those random timings, reproducibly:

- a two-state Markov chain (in / out) driven by numpy's PCG64 generator seeded with ``seed``: while in, each bar
  leaves with probability 1/``meanIn``; while out, each bar re-enters with probability 1/``meanOut`` (geometric spells
  with mean lengths meanIn / meanOut bars, long-run exposure meanIn / (meanIn + meanOut));
- optional SMA core (``coreSma`` > 0): hold only while the random state is "in" AND the close is above SMA(coreSma),
  the null for "does an overlay on an SMA core beat randomly thinning it?".

The random draws never look at prices, so there is no look-ahead; draws are taken in bar order, so a truncated
history gives the same prefix. Single market.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "placebo_timing"
VERSION = 1
TITLE = "Random timing placebo (null benchmark)"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"seed": 1, "meanIn": 60, "meanOut": 30, "coreSma": 0}


def param_space() -> dict:
    return {
        "seed": {"type": "int", "min": 1, "max": 1_000_000_000, "log": True,
                 "description": "random seed: each seed is one random timing path"},
        "meanIn": {"type": "int", "min": 3, "max": 500, "log": True,
                   "description": "average number of candles a random holding spell lasts"},
        "meanOut": {"type": "int", "min": 2, "max": 500, "log": True,
                    "description": "average number of candles a random cash spell lasts"},
        "coreSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                    "description": "also require the close above this SMA (0 = random timing alone)"},
    }


def warmup(p: dict) -> int:
    return max(1, int(p.get("coreSma") or 0))


def random_state(n: int, seed: int, mean_in: float, mean_out: float) -> np.ndarray:
    """In/out (1/0) path of length n; starts in. Uses one uniform draw per bar, in bar order."""
    u = np.random.Generator(np.random.PCG64(int(seed))).random(n)
    p_leave, p_enter = 1.0 / max(float(mean_in), 1.0), 1.0 / max(float(mean_out), 1.0)
    out = np.empty(n)
    s = 1.0
    for i in range(n):
        if i > 0:
            if s == 1.0 and u[i] < p_leave:
                s = 0.0
            elif s == 0.0 and u[i] < p_enter:
                s = 1.0
        out[i] = s
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    st = random_state(len(c), int(p["seed"]), float(p["meanIn"]), float(p["meanOut"]))
    core_len = int(p.get("coreSma") or 0)
    if core_len > 0:
        sm = ind.sma(c, core_len)
        ok = np.isfinite(sm)
        w = np.where(ok, ((st == 1) & (c > sm)).astype(np.float64), np.nan)
    else:
        w = st.copy()
    w = np.where(np.isfinite(c), w * max_weight(spec), np.nan)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    exp = float(p["meanIn"]) / (float(p["meanIn"]) + float(p["meanOut"]))
    steps = [
        "This is a placebo, not a trading idea: it buys and sells at random moments, ignoring the price.",
        f"Holding spells last {bars_text(int(p['meanIn']), iv)} on average and cash spells "
        f"{bars_text(int(p['meanOut']), iv)}, so it holds {mk} about {pct(exp)} of the time (random seed {p['seed']}).",
    ]
    if p.get("coreSma"):
        steps.append(f"On top of that it only holds while the price is above its {bars_text(int(p['coreSma']), iv)} "
                     "average, to measure what randomly thinning a trend core scores.")
    return {
        "summary": f"Random in/out timing on {mk}: a luck benchmark for the research, never a strategy to trade.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Only by luck: when its random cash spells happen to fall on crashes.",
        "whenItLoses": "Whenever luck runs out; any score it gets shows how much of a real strategy's score could be "
                       "chance.",
    }
