"""placebo_duo_a22 v1 (agent-22): RANDOM in/out timing on several markets at once: a null benchmark for multi-market
specs (BTC+ETH leads), the multi-market twin of agent-05's placebo_timing.

Not a strategy. It answers "what score does pure luck get on a BTC+ETH spec with this exposure?".

- ``mode = common``: one two-state Markov chain (in / out, geometric spells with mean lengths meanIn / meanOut bars,
  numpy PCG64 seeded with ``seed``) switches every market together, the null for market-wide signals (alt froth,
  breadth panic) that move BTC and ETH at the same time;
- ``mode = independent``: each market gets its own chain (seed + 7919 x market position), the null for per-coin
  signals.

Each market's weight while "in" is maxWeight / number of markets (the equal split buy and hold uses too). The draws
never look at prices, so there is no look-ahead; draws are taken in bar order on the union index of the markets,
so a truncated history gives the same prefix.
"""
from __future__ import annotations

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index, aligned_close
from .placebo_timing import random_state

NAME = "placebo_duo_a22"
VERSION = 1
TITLE = "Random timing placebo on several markets (null benchmark)"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"seed": 1, "meanIn": 60, "meanOut": 30, "mode": "common"}


def param_space() -> dict:
    return {
        "seed": {"type": "int", "min": 1, "max": 1_000_000_000, "log": True,
                 "description": "random seed: each seed is one random timing path"},
        "meanIn": {"type": "int", "min": 3, "max": 500, "log": True,
                   "description": "average number of candles a random holding spell lasts"},
        "meanOut": {"type": "int", "min": 2, "max": 500, "log": True,
                    "description": "average number of candles a random cash spell lasts"},
        "mode": {"type": "choice", "values": ["common", "independent"],
                 "description": "one random path for all markets (common) or one per market (independent)"},
    }


def warmup(p: dict) -> int:
    return 1


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    seed, mi, mo = int(p["seed"]), float(p["meanIn"]), float(p["meanOut"])
    common = random_state(n, seed, mi, mo)
    cols = {}
    for j, m in enumerate(markets):
        st = common if p.get("mode", "common") == "common" else random_state(n, seed + 7919 * j, mi, mo)
        c = aligned_close(candles, m, idx)
        cols[m] = np.where(np.isfinite(c), st * each, np.nan)
    W = np.column_stack([cols[m] for m in markets])
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    exp = float(p["meanIn"]) / (float(p["meanIn"]) + float(p["meanOut"]))
    how = "all coins together" if p.get("mode", "common") == "common" else "each coin on its own random path"
    return {
        "summary": f"Random in/out timing on {mk}: a luck benchmark for the research, never a strategy to trade.",
        "howItWorks": [
            "This is a placebo, not a trading idea: it buys and sells at random moments, ignoring the price.",
            f"It switches {how}; holding spells last {bars_text(int(p['meanIn']), iv)} on average and cash spells "
            f"{bars_text(int(p['meanOut']), iv)}, so it holds about {pct(exp)} of the time (random seed {p['seed']}).",
            "While holding it splits the money equally over the coins, like the buy-and-hold benchmark.",
            *risk_steps(spec),
        ],
        "whenItWins": "Only by luck: when its random cash spells happen to fall on crashes.",
        "whenItLoses": "Whenever luck runs out; its scores show how much of a real multi-coin strategy's score could be "
                       "chance.",
    }
