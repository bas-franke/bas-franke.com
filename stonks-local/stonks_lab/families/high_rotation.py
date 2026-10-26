"""high_rotation v1 (agent-08): rotate into the coins trading closest to their own N-candle high.

"52-week-high momentum": instead of ranking by return over a look-back (rotation_momentum), every coin gets
prox = close / max(close over the last `window` candles, this one included), 1.0 = at a new high. Coins are ranked
by prox (desc; ties: `window` return desc, then market name), only coins with prox >= `minProx` are eligible
(0 = no floor), and the best `top` get maxWeight/top each; unused slots stay cash. With regimeSma > 0 everything
is cash unless BTC-EUR closes above its SMA(regimeSma) at that bar (same gate as rotation_momentum).

A coin is rankable once it has `window` candles of its own. Rows before the first rankable bar (and before the
regime SMA is defined, if used) are NaN. Decisions at bar t use closes up to t only.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index
from .rotation_blend import _regime

NAME = "high_rotation"
VERSION = 1
TITLE = "Near-the-high rotation"
BOT_READY = False
MULTI_MARKET = True
REGIME_MARKET = "BTC-EUR"


def default_params() -> dict:
    return {"window": 60, "top": 3, "minProx": 0.8, "regimeSma": 50}


def param_space() -> dict:
    return {
        "window": {"type": "int", "min": 5, "max": 500, "log": True,
                   "description": "candles in each coin's recent high"},
        "top": {"type": "int", "min": 1, "max": 10, "description": "how many of the coins nearest their high to hold"},
        "minProx": {"type": "float", "min": 0.5, "max": 0.99, "zero": True,
                    "description": "only hold a coin trading at least this fraction of its recent high (0 = off)"},
        "regimeSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                      "description": "only hold coins while BTC is above this SMA (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    return None if int(p["top"]) >= 1 else "top must be at least 1"


def warmup(p: dict) -> int:
    r = int(p.get("regimeSma") or 0)
    return max(int(p["window"]) - 1, r - 1 if r > 0 else 0)


def required_markets(spec: dict) -> list[str]:
    return [REGIME_MARKET] if int((spec.get("params") or {}).get("regimeSma") or 0) > 0 else []


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    window, top = int(p["window"]), int(p["top"])
    min_prox, regime_n = float(p.get("minProx") or 0.0), int(p.get("regimeSma") or 0)
    idx = union_index(candles, markets)
    n, M = len(idx), len(markets)
    prox = np.full((M, n), np.nan)
    ret = np.full((M, n), np.nan)
    for j, m in enumerate(markets):
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        pos = np.searchsorted(idx, np.asarray(df.index, dtype=np.int64))
        prox[j, pos] = c / ind.rolling_max(c, window)
        if len(c) > window - 1:
            r = np.full(len(c), np.nan)
            r[window - 1:] = c[window - 1:] / c[: len(c) - window + 1] - 1.0
            ret[j, pos] = r
    ready = np.isfinite(prox)
    warm = ready.any(axis=0)
    regime_ok = np.ones(n, dtype=bool)
    if regime_n > 0:
        regime_ok, reg_warm = _regime(candles, idx, regime_n)
        warm &= reg_warm
    first = int(np.argmax(warm)) if warm.any() else n
    each = max_weight(spec) / top
    W = np.zeros((n, M))
    W[:first] = np.nan
    name_rank = np.argsort(np.argsort(np.array(markets)))
    for t in range(first, n):
        if not regime_ok[t]:
            continue
        cand = [j for j in np.flatnonzero(ready[:, t]) if prox[j, t] >= min_prox]
        if not cand:
            continue
        cand.sort(key=lambda j: (-prox[j, t], -(ret[j, t] if np.isfinite(ret[j, t]) else -np.inf), name_rank[j]))
        W[t, cand[:top]] = each
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    top = int(p["top"])
    steps = [
        f"After every {iv} candle it compares each of {mk} with its own highest price of the last "
        f"{bars_text(p['window'], iv)}.",
        f"It holds the {top} coin{'s' if top > 1 else ''} trading closest to that high (a new high is best), each "
        f"with an equal share ({100 / top:.0f} % each).",
    ]
    if float(p.get("minProx") or 0) > 0:
        steps.append(f"A coin more than {100 * (1 - float(p['minProx'])):.0f} % below its high is never held; "
                     "its share stays in euros.")
    else:
        steps.append("If fewer coins qualify, the unused shares stay in euros.")
    if int(p.get("regimeSma") or 0) > 0:
        steps.append(f"Market filter: it only holds coins while bitcoin is above its "
                     f"{bars_text(p['regimeSma'], iv)} average price; otherwise everything goes to euros.")
    return {
        "summary": "Holds the coins that are breaking out to (or sitting near) their recent highs, and steps into "
                   "euros when bitcoin's trend breaks.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets where leading coins keep making new highs for weeks.",
        "whenItLoses": "False breakouts and sharp reversals right after a new high; switching between coins costs "
                       "fees.",
    }
