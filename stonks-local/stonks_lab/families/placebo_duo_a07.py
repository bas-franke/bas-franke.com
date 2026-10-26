"""placebo_duo_a07 v1 (agent-07): the luck line for MULTI-market leads (BTC+ETH): random in/out timing.

placebo_timing (agent-05) is single-market, so BTC+ETH leads (alt_froth, froth_dip, beta_shift, turnover_panic,
duo_core on BTC-EUR + ETH-EUR) had no random null at matched exposure. This family is that null. Not a strategy.

- ``mode`` "joint": one random in/out path (placebo_timing.random_state, PCG64 seeded with ``seed``) moves all
  markets together, each held at maxWeight / n while in (like a lead whose signal exits both coins at once);
- ``mode`` "independent": every market gets its own path (seed + 7919 x k for the k-th market), each worth
  maxWeight / n while in, cash otherwise.
Spells are geometric with means ``meanIn`` / ``meanOut`` bars (exposure ~ meanIn / (meanIn + meanOut)). The draws
never look at prices and are taken in bar order, so there is no look-ahead.
"""
from __future__ import annotations

import numpy as np

from ._base import aligned_close, bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from .placebo_timing import random_state

NAME = "placebo_duo_a07"
VERSION = 1
TITLE = "Random timing placebo for several coins (null benchmark)"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"seed": 1, "meanIn": 120, "meanOut": 30, "mode": "joint"}


def param_space() -> dict:
    return {
        "seed": {"type": "int", "min": 1, "max": 1_000_000_000, "log": True,
                 "description": "random seed: each seed is one random timing path"},
        "meanIn": {"type": "int", "min": 3, "max": 500, "log": True,
                   "description": "average number of candles a random holding spell lasts"},
        "meanOut": {"type": "int", "min": 2, "max": 500, "log": True,
                    "description": "average number of candles a random cash spell lasts"},
        "mode": {"type": "choice", "values": ["joint", "independent"],
                 "description": "one random path for all coins, or one per coin"},
    }


def warmup(p: dict) -> int:
    return 1


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(markets)
    mw = max_weight(spec)
    out = {}
    for k, m in enumerate(markets):
        seed = int(p["seed"]) + (7919 * k if p.get("mode") == "independent" else 0)
        st = random_state(len(idx), seed, float(p["meanIn"]), float(p["meanOut"]))
        c = aligned_close(candles, m, idx)
        out[m] = np.where(np.isfinite(c), st * mw / n, 0.0)
    return frame(idx, out)


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    exp = float(p["meanIn"]) / (float(p["meanIn"]) + float(p["meanOut"]))
    together = ("all coins are bought and sold together" if p.get("mode") != "independent"
                else "every coin gets its own random timing")
    return {
        "summary": f"Random in/out timing on {mk}: a luck benchmark for the research, never a strategy to trade.",
        "howItWorks": [
            "This is a placebo, not a trading idea: it buys and sells at random moments, ignoring the price.",
            f"Holding spells last {bars_text(int(p['meanIn']), iv)} on average and cash spells "
            f"{bars_text(int(p['meanOut']), iv)}, so it is invested about {pct(exp)} of the time (seed {p['seed']}); "
            f"{together}, each with an equal share of the money.",
            *risk_steps(spec)],
        "whenItWins": "Only by luck: when its random cash spells happen to fall on crashes.",
        "whenItLoses": "Whenever luck runs out; its scores show how much of a real strategy's score could be chance.",
    }
