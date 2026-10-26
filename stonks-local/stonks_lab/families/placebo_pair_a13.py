"""placebo_pair_a13 v1 (agent-13): random in/out timing on BTC+ETH, the luck line for two-coin leads.

Not a strategy: a null benchmark like agent-05's single-market placebo_timing (findings #475/#476), for the BTC+ETH
leads (duo_core, beta_shift, turnover_panic, flow_froth), which had no luck line of their own.

Each coin gets an equal slot of maxWeight / number of markets. Its in/out state is a two-state Markov chain (PCG64,
one uniform draw per bar in bar order, so a truncated history gives the same prefix; prices are never read):
while in, each bar leaves with probability 1/meanIn; while out, each bar re-enters with probability 1/meanOut.

- mode ``joint``: one random path for the whole pair (all in or all out together, like a shared regime gate);
- mode ``split``: an independent path per coin (seed, seed + 1, ...), like per-coin rules (duo_core).
"""
from __future__ import annotations

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from .placebo_timing import random_state

NAME = "placebo_pair_a13"
VERSION = 1
TITLE = "Random timing placebo for coin pairs (null benchmark)"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"seed": 1, "meanIn": 90, "meanOut": 30, "mode": "joint"}


def param_space() -> dict:
    return {
        "seed": {"type": "int", "min": 1, "max": 1_000_000_000, "log": True,
                 "description": "random seed: each seed is one random timing path"},
        "meanIn": {"type": "int", "min": 3, "max": 500, "log": True,
                   "description": "average number of candles a random holding spell lasts"},
        "meanOut": {"type": "int", "min": 2, "max": 500, "log": True,
                    "description": "average number of candles a random cash spell lasts"},
        "mode": {"type": "choice", "values": ["joint", "split"],
                 "description": "one random path for all coins (joint) or one per coin (split)"},
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
    cols = {}
    for j, m in enumerate(markets):
        st = random_state(n, seed if p["mode"] == "joint" else seed + j, mi, mo)
        t = np.asarray(candles[m].index, dtype=np.int64)
        listed = idx >= t[0] if len(t) else np.zeros(n, dtype=bool)
        cols[m] = np.where(listed, st * each, 0.0)
    return frame(idx, cols)


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    exp = float(p["meanIn"]) / (float(p["meanIn"]) + float(p["meanOut"]))
    how = ("all coins go in and out together on one random path" if p["mode"] == "joint" else
           "every coin follows its own random path")
    return {
        "summary": f"Random in/out timing on {mk}: a luck benchmark for the research, never a strategy to trade.",
        "howItWorks": [
            "This is a placebo, not a trading idea: it buys and sells at random moments, ignoring the price.",
            f"Each coin gets an equal share of the money; {how}.",
            f"Holding spells last {bars_text(int(p['meanIn']), iv)} on average and cash spells "
            f"{bars_text(int(p['meanOut']), iv)}, so it is invested about {pct(exp)} of the time "
            f"(random seed {p['seed']}).",
            *risk_steps(spec)],
        "whenItWins": "Only by luck: when its random cash spells happen to fall on crashes.",
        "whenItLoses": "Whenever luck runs out; its scores show how much of a real pair strategy's score could be "
                       "chance.",
    }
