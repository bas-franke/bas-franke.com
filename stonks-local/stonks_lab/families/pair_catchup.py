"""pair_catchup v1 (agent-17): buy the laggard of BTC/ETH right after the other one jumped ahead.

Diagnostic behind it (agent-17, 2019-2025 pre-holdout): when BTC outruns ETH by a top-1 % margin on one 15m candle,
ETH gains ~+0.3-0.4 % more over the next 45 min - 3 h than on an average candle (5m/15m/1h all show it; the reverse
direction, ETH ahead, shows nothing). That is just above Bitvavo's 0.30 % maker round trip, so it can only work as
a few short trades on top of a holding, never on its own; hence the optional trend core.

Per spec (one traded market, ETH-EUR or BTC-EUR; the leader is the other one, loaded as a required market):
- gap at t = ln(leader[t]/leader[t-lag]) - ln(market[t]/market[t-lag])   (closes up to t only)
- Catch-up trade: when gap >= ``gapPct`` / 100 (and, with ``leaderUp``, the leader itself rose over those bars),
  hold the market for ``hold`` candles (a new signal restarts the clock).
- Core (``coreSma`` > 0): additionally hold whenever the market's close is above its SMA(coreSma) candles.
Weight = maxWeight while core or a catch-up trade is on, else 0.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps

NAME = "pair_catchup"
VERSION = 1
TITLE = "BTC/ETH catch-up"
BOT_READY = False
MULTI_MARKET = False


def _leader(market: str) -> str:
    return "ETH-EUR" if market.upper().startswith("BTC") else "BTC-EUR"


def default_params() -> dict:
    return {"lag": 1, "gapPct": 0.8, "hold": 8, "leaderUp": True, "coreSma": 0}


def param_space() -> dict:
    return {
        "lag": {"type": "int", "min": 1, "max": 12, "description": "candles over which the two coins' moves are compared"},
        "gapPct": {"type": "float", "min": 0.2, "max": 4.0, "log": True,
                   "description": "buy when the leader outran this coin by at least this many percent"},
        "hold": {"type": "int", "min": 1, "max": 96, "log": True, "description": "candles a catch-up trade is held"},
        "leaderUp": {"type": "bool", "description": "only when the leader itself went up (not just fell less)"},
        "coreSma": {"type": "int", "min": 20, "max": 50000, "zero": True, "log": True,
                    "description": "also hold while the close is above this SMA (0 = catch-up trades only)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["lag"]), int(p.get("coreSma") or 0) - 1)


def required_markets(spec: dict) -> list[str]:
    ms = spec.get("markets") or []
    return [_leader(ms[0])] if len(ms) == 1 else []


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if len(markets) != 1:
        raise ValueError("pair_catchup trades exactly one market")
    m = markets[0]
    df = candles[m]
    idx = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    ld = candles[_leader(m)]
    lc = pd.Series(ld["close"].to_numpy(np.float64), index=np.asarray(ld.index, dtype=np.int64))
    lc = lc[lc.index <= idx[-1]] if len(idx) else lc
    L = lc.reindex(np.union1d(lc.index.to_numpy(), idx)).ffill().reindex(idx).to_numpy(np.float64)
    n, lag = len(c), int(p["lag"])
    gap = np.full(n, np.nan)
    lret = np.full(n, np.nan)
    if n > lag:
        with np.errstate(divide="ignore", invalid="ignore"):
            lret[lag:] = np.log(L[lag:] / L[:-lag])
            gap[lag:] = lret[lag:] - np.log(c[lag:] / c[:-lag])
    sig = np.nan_to_num(gap, nan=-1.0) >= float(p["gapPct"]) / 100.0
    if p.get("leaderUp"):
        sig &= np.nan_to_num(lret, nan=-1.0) > 0
    cs = int(p.get("coreSma") or 0)
    core = None
    if cs > 0:
        s = ind.sma(c, cs)
        core = np.where(np.isfinite(s), c > s, False)
    hold = int(p["hold"])
    out = np.full(n, np.nan)
    first = warmup(p)
    left = 0
    for t in range(first, n):
        if left > 0:
            left -= 1
        if sig[t]:
            left = hold
        on = left > 0 or (core is not None and core[t])
        out[t] = 1.0 if on else 0.0
    return frame(idx, {m: out * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    m = (spec.get("markets") or ["ETH-EUR"])[0]
    lead = _leader(m).split("-")[0]
    steps = [
        f"It watches {lead} and {market_names(spec)}: when {lead} gained at least {float(p['gapPct']):.2g} % more than "
        f"{market_names(spec)} over {bars_text(p['lag'], iv)}"
        + (f" (and {lead} itself rose)" if p.get("leaderUp") else "")
        + f", it buys {market_names(spec)}, expecting it to catch up.",
        f"Each catch-up trade is held for {bars_text(p['hold'], iv)}.",
    ]
    if int(p.get("coreSma") or 0):
        steps.append(f"Besides those trades it simply holds while the price is above its "
                     f"{bars_text(p['coreSma'], iv)} average.")
    return {
        "summary": f"Buys {market_names(spec)} when {lead} has just jumped ahead of it, betting on a quick catch-up.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Fast markets where one coin moves first and the other follows within hours.",
        "whenItLoses": "When the gap is news about one coin only (it never closes) and in quiet markets, where the "
                       "catch-up is smaller than the fees.",
    }
