"""rebalance_band: always invested, equal weights, rebalanced only on drift or schedule (agent-14).

The classic "rebalancing premium" question for a BTC + ETH portfolio: does selling the coin that ran up and buying
the one that lagged (volatility harvesting on the ETH/BTC ratio) beat simply buying 50/50 and holding?

The family keeps a virtual, fee-free portfolio that starts equal-weighted (maxWeight / len(markets) each) at the first
bar where every market has a close. Between rebalances the holdings drift with the prices and the target weights it
emits are those drifted weights, so the engine does not trade. It resets the weights to equal when

- ``band`` > 0 and some coin's share of the invested money differs from 1/len(markets) by more than ``band``
  (absolute, e.g. 0.1 = rebalance when a 50/50 portfolio drifted to 60/40), or
- ``everyBars`` > 0 and that many bars passed since the last rebalance.

With both 0 it never rebalances (= buy and hold). A decision at bar t uses closes up to and including t only.
Note: the engine skips trades smaller than max(EUR 5, 2 % of equity), so bands under ~0.02 behave like 0.02.
"""
from __future__ import annotations

import numpy as np

from ._base import aligned_close, bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "rebalance_band"
VERSION = 1
TITLE = "Equal-weight rebalancing (drift band or schedule)"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"band": 0.1, "everyBars": 0}


def param_space() -> dict:
    return {
        "band": {"type": "float", "min": 0.02, "max": 0.4, "log": True, "zero": True,
                 "description": "rebalance when a coin's share drifts this far from equal (0 = never on drift)"},
        "everyBars": {"type": "int", "min": 1, "max": 400, "log": True, "zero": True,
                      "description": "also rebalance every this many candles (0 = no schedule)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p.get("band") or 0) <= 0 and int(p.get("everyBars") or 0) <= 0:
        return "set band or everyBars (both 0 is buy and hold)"
    return None


def warmup(p: dict) -> int:
    return 0


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if len(markets) < 2:
        raise ValueError("rebalance_band needs at least two markets")
    idx = union_index(candles, markets)
    n, k = len(idx), len(markets)
    mw = max_weight(spec)
    C = np.column_stack([aligned_close(candles, m, idx) for m in markets])
    band = float(p.get("band") or 0.0)
    every = int(p.get("everyBars") or 0)
    W = np.full((n, k), np.nan)
    eq = 1.0 / k
    units = None
    last = 0
    for i in range(n):
        c = C[i]
        if not np.isfinite(c).all():
            continue
        if units is None:
            units = eq / c
            last = i
        val = units * c
        share = val / val.sum()
        if (band > 0 and np.abs(share - eq).max() > band) or (every > 0 and i - last >= every):
            units = (val.sum() * eq) / c
            share = np.full(k, eq)
            last = i
        W[i] = share * mw
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    band = float(p.get("band") or 0)
    every = int(p.get("everyBars") or 0)
    rules = []
    if band > 0:
        rules.append(f"as soon as one coin's share is more than {pct(band)} away from {100 / k:.0f} %")
    if every > 0:
        rules.append(f"every {bars_text(every, iv)}")
    return {
        "summary": f"Always fully invested in {mk}, split equally; it moves money from the coin that ran up to the "
                   f"one that lagged {' or '.join(rules)}.",
        "howItWorks": [
            f"Start: it buys {mk} for equal amounts ({100 / k:.0f} % each).",
            "In between it lets the shares drift with the prices and does nothing.",
            f"Rebalance: {' or '.join(rules)}, it sells some of the coin that is over its share and buys the other "
            "back to equal amounts.",
        ] + risk_steps(spec),
        "whenItWins": "When the coins take turns: the one that ran ahead falls back and the laggard catches up.",
        "whenItLoses": "When one coin keeps beating the other for years: it keeps buying the loser (ETH vs BTC "
                       "2022-25), and it is never out of the market in a crash.",
    }
