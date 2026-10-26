"""rs_gate v1 (agent-12): trade only the spec's markets (BTC-EUR and/or ETH-EUR), gated by relative strength.

Why: under eval v2 the best results are top-10 momentum rotations, but they trade alts. This family asks whether the
same cross-sectional signal helps if you only ever hold BTC/ETH: hold a market while its `lookback` return ranks
in the top `maxRank` of the top-10 universe (it is leading the market), optionally only while that return is
positive (absMom) and the close is above its own SMA(ownSma). Otherwise euros.

Rank at bar t = 1 + number of universe coins whose `lookback` return (on their own candles, as of t) is strictly
higher. Coins without enough history are left out; with fewer than 3 ranked coins nothing is decided (NaN).
Each spec market gets an equal slice maxWeight / len(markets). Decisions use candles up to and including t only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "rs_gate"
VERSION = 1
TITLE = "Relative-strength gate"
BOT_READY = False
MULTI_MARKET = True
UNIVERSE = ["BTC-EUR", "ETH-EUR", "XRP-EUR", "BNB-EUR", "SOL-EUR", "DOGE-EUR", "ADA-EUR", "TRX-EUR", "LINK-EUR",
            "AVAX-EUR"]
MIN_RANKED = 3


def default_params() -> dict:
    return {"lookback": 20, "maxRank": 3, "absMom": True, "ownSma": 0}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 2, "max": 400, "log": True,
                     "description": "candles over which every coin's return is measured and ranked"},
        "maxRank": {"type": "int", "min": 1, "max": 9,
                    "description": "hold while the market ranks at least this high among the top 10"},
        "absMom": {"type": "bool", "description": "also require the market's own return to be positive"},
        "ownSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                   "description": "also require the close above this SMA of its own (0 = off)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["lookback"]), int(p.get("ownSma") or 0) - 1)


def required_markets(spec: dict) -> list[str]:
    return list(UNIVERSE)


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("rs_gate needs at least one market")
    lb, max_rank, own_n = int(p["lookback"]), int(p["maxRank"]), int(p.get("ownSma") or 0)
    idx = union_index(candles, markets)
    n = len(idx)
    universe = list(dict.fromkeys(UNIVERSE + markets))
    rets = {}
    for m in universe:
        if m not in candles or len(candles[m]) == 0:
            continue
        df = candles[m]
        rets[m] = _asof(df, ind.rolling_return(df["close"].to_numpy(np.float64), lb), idx)
    R = np.vstack(list(rets.values()))
    ranked = np.isfinite(R).sum(axis=0)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        r = rets[m]
        with np.errstate(invalid="ignore"):
            higher = np.nansum(R > r[None, :], axis=0)
        on = (higher + 1) <= max_rank
        if p.get("absMom"):
            on &= r > 0
        ok = np.isfinite(r) & (ranked >= MIN_RANKED)
        if own_n:
            c = candles[m]["close"].to_numpy(np.float64)
            s = ind.sma(c, own_n)
            above = _asof(candles[m], np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan), idx)
            ok &= np.isfinite(above)
            on &= above == 1.0
        cols[m] = np.where(ok, np.where(on, each, 0.0), np.nan)
    W = np.column_stack([cols[m] for m in markets])
    dec = ~np.isnan(W).all(axis=1)
    first = int(np.argmax(dec)) if dec.any() else n
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    n = len(spec.get("markets") or []) or 1
    steps = [
        f"After every {iv} candle it measures the return of each of the top-10 coins over the last "
        f"{bars_text(p['lookback'], iv)} and ranks them.",
        f"It holds {mk} only while it ranks among the best {p['maxRank']} of those coins, i.e. while it is "
        "outperforming most of the market; otherwise it sits in euros. It never buys the other coins.",
    ]
    if p.get("absMom"):
        steps.append("It also requires that return to be positive, so it never holds a coin that is merely falling "
                     "less than the rest.")
    if p.get("ownSma"):
        steps.append(f"Extra filter: the price must be above its {bars_text(p['ownSma'], iv)} average.")
    if n > 1:
        steps.append(f"Each of the {n} coins gets an equal {pct(1 / n)} slice and follows its own rank.")
    return {
        "summary": f"Holds {mk} only while it is one of the strongest coins of the top 10 (relative strength).",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Phases where money flows into the big coins first and they lead the market.",
        "whenItLoses": "Alt seasons, when smaller coins lead and the big ones lag even though they rise too.",
    }
