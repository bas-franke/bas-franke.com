"""corr_regime v1 (agent-20): exit only on market-wide (correlated) sell-offs, hold through coin-specific dips.

Signal at bar t (candles up to and including t):
- ``corr`` = rolling correlation of BTC-EUR and ETH-EUR log returns over ``corrLen`` candles;
- ``falling`` = the traded coin's return over ``retLen`` candles is negative (``scope`` "own"), or both BTC and ETH
  returns are negative (``scope`` "both").
It holds the coin unless ``falling`` AND ``corr >= corrMin``. Idea: a drop that moves BTC and ETH in lock-step is
market-wide de-risking, which tends to persist (time-series momentum); a drop with low correlation is coin-specific
noise that tends to recover, so it is held through. ``corrMin = -1`` disables the correlation condition and turns
the family into plain time-series momentum (the built-in ablation). Optional ``hold`` hysteresis: after an exit it
stays out at least ``minOut`` candles.

Multi-market: every market gets maxWeight / len(markets).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import aligned_close, bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "corr_regime"
VERSION = 1
TITLE = "Correlated sell-off exit"
BOT_READY = False
MULTI_MARKET = True
PAIR = ["BTC-EUR", "ETH-EUR"]


def default_params() -> dict:
    return {"corrLen": 30, "corrMin": 0.8, "retLen": 60, "scope": "own", "minOut": 0}


def param_space() -> dict:
    return {
        "corrLen": {"type": "int", "min": 10, "max": 400, "log": True,
                    "description": "candles over which the BTC/ETH return correlation is measured"},
        "corrMin": {"type": "float", "min": -1.0, "max": 0.98,
                    "description": "only exit on a drop while the correlation is at least this (-1 = always)"},
        "retLen": {"type": "int", "min": 5, "max": 400, "log": True,
                   "description": "candles of the trend return that has to be negative for an exit"},
        "scope": {"type": "choice", "values": ["own", "both"],
                  "description": "own = the traded coin is falling; both = BTC and ETH are both falling"},
        "minOut": {"type": "int", "min": 1, "max": 200, "log": True, "zero": True,
                   "description": "after an exit stay out at least this many candles (0 = off)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["corrLen"]) + 1, int(p["retLen"]))


def required_markets(spec: dict) -> list[str]:
    out = list(spec.get("markets") or [])
    return out + [m for m in PAIR if m not in out]


def _ret(c: np.ndarray, k: int) -> np.ndarray:
    out = np.full(len(c), np.nan)
    if len(c) > k:
        with np.errstate(invalid="ignore", divide="ignore"):
            out[k:] = c[k:] / c[:-k] - 1.0
    return out


def rolling_corr(a: np.ndarray, b: np.ndarray, n: int) -> np.ndarray:
    la = pd.Series(np.log(a)).diff()
    lb = pd.Series(np.log(b)).diff()
    return la.rolling(n, min_periods=n).corr(lb).to_numpy(np.float64)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("corr_regime needs at least one market")
    idx = union_index(candles, markets)
    n = len(idx)
    btc, eth = (aligned_close(candles, m, idx) for m in PAIR)
    corr = rolling_corr(btc, eth, int(p["corrLen"]))
    k = int(p["retLen"])
    rb, re = _ret(btc, k), _ret(eth, k)
    cmin = float(p["corrMin"])
    min_out = int(p.get("minOut") or 0)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        own = _ret(c, k)
        if p["scope"] == "both":
            ok = np.isfinite(rb) & np.isfinite(re)
            fall = (rb < 0) & (re < 0)
        else:
            ok = np.isfinite(own)
            fall = own < 0
        ok = ok & (np.isfinite(corr) | (cmin <= -1.0))
        with np.errstate(invalid="ignore"):
            exit_ = fall & ((cmin <= -1.0) | (corr >= cmin))
        w = np.full(n, np.nan)
        out_for = 0
        for i in range(n):
            if not ok[i]:
                continue
            if exit_[i]:
                out_for = min_out
                w[i] = 0.0
            elif out_for > 0:
                out_for -= 1
                w[i] = 0.0
            else:
                w[i] = each
        cols[m] = w
    W = np.column_stack([cols[m] for m in markets])
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    cmin = float(p["corrMin"])
    who = "it" if p["scope"] == "own" else "both Bitcoin and Ether"
    steps = [f"After every {iv} candle it checks whether {who} fell over the last {bars_text(int(p['retLen']), iv)}."]
    if cmin > -1.0:
        steps.append(f"It also measures how closely Bitcoin and Ether moved together over the last "
                     f"{bars_text(int(p['corrLen']), iv)} (correlation of their daily moves).")
        steps.append(f"It sells {mk} only when the price fell AND the two moved in lock-step (correlation at least "
                     f"{cmin:.2f}): a market-wide sell-off. A drop of one coin on its own is held through.")
    else:
        steps.append(f"It sells {mk} whenever the price fell over that period and buys back once it is up again.")
    if int(p.get("minOut") or 0):
        steps.append(f"After a sale it stays out at least {bars_text(int(p['minOut']), iv)}.")
    return {
        "summary": f"Holds {mk} and steps out only during sell-offs that hit Bitcoin and Ether together.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long market-wide bear phases (it exits) with coin-specific dips in between (it holds through).",
        "whenItLoses": "Sharp V-shaped market crashes (it sells near the low and buys back higher) and coin-specific "
                       "collapses it decides to hold.",
    }
