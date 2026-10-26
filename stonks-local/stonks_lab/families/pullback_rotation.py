"""pullback_rotation v1 (agent-03): momentum rotation that buys its leaders only on a short pullback.

rotation_momentum buys the `top` coins with the best `lookback` return the moment they lead. Momentum winners in
crypto often spike, so the buy lands on a local high (whenItLoses of rotation_momentum). Here the momentum ranking
only defines a *pool*; a coin is bought when it is in the pool and its short RSI shows a pullback:

- At every bar t each market with a candle at t and `lookback` earlier candles of its own gets ret = close /
  close[-lookback] - 1. Markets with ret > 0 are ranked (desc, ties by market name); the best `pool` form the pool.
- Held coins stay held while they are in the pool (a rank buffer when pool > top); a coin that leaves the pool, or
  any coin while the BTC gate is off, is sold.
- Free slots (at most `top` coins are held) are filled with pool coins whose RSI(rsiPeriod) on their own closes is
  below `rsiBelow`, best return first. rsiBelow = 100 means "no pullback needed": with pool = top this is exactly
  rotation_momentum.
- Every held coin gets maxWeight/top; unused slots stay cash.
- regimeSma > 0: everything is cash unless BTC-EUR has a candle at t with close > SMA(regimeSma) (rotation_momentum's
  gate).

A market without a candle at t (not listed yet, gap) is not ranked at t, so a held coin with a gap is sold, like
rotation_momentum. Rows before the first warm bar are NaN. Decisions at bar t use candles up to t only.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "pullback_rotation"
VERSION = 1
TITLE = "Momentum rotation, bought on pullbacks"
BOT_READY = False
MULTI_MARKET = True
REGIME_MARKET = "BTC-EUR"


def default_params() -> dict:
    return {"lookback": 20, "top": 3, "pool": 4, "rsiPeriod": 3, "rsiBelow": 50.0, "regimeSma": 50}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 3, "max": 200, "log": True,
                     "description": "candles over which each coin's return is measured for the ranking"},
        "top": {"type": "int", "min": 1, "max": 6, "description": "most coins held at once (maxWeight/top each)"},
        "pool": {"type": "int", "min": 1, "max": 10,
                 "description": "a coin can be bought and stays held while it ranks in the best `pool` (>= top)"},
        "rsiPeriod": {"type": "int", "min": 2, "max": 14, "description": "RSI length of the pullback signal"},
        "rsiBelow": {"type": "float", "min": 10.0, "max": 100.0,
                     "description": "buy a pool coin only while its RSI is under this (100 = buy at once)"},
        "regimeSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                      "description": "only hold coins while BTC is above this SMA (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["top"]) < 1:
        return "top must be at least 1"
    if int(p["pool"]) < int(p["top"]):
        return "pool must be at least top"
    return None


def warmup(p: dict) -> int:
    r = int(p.get("regimeSma") or 0)
    return max(int(p["lookback"]), int(p["rsiPeriod"]), r - 1 if r > 0 else 0)


def required_markets(spec: dict) -> list[str]:
    return [REGIME_MARKET] if int((spec.get("params") or {}).get("regimeSma") or 0) > 0 else []


def _place(idx, df, values):
    out = np.full(len(idx), np.nan)
    pos = np.searchsorted(idx, np.asarray(df.index, dtype=np.int64))
    out[pos] = values
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    lookback, top, pool = int(p["lookback"]), int(p["top"]), int(p["pool"])
    rsi_n, rsi_below, regime_n = int(p["rsiPeriod"]), float(p["rsiBelow"]), int(p.get("regimeSma") or 0)
    idx = union_index(candles, markets)
    n, M = len(idx), len(markets)
    rets = np.full((M, n), np.nan)
    rsis = np.full((M, n), np.nan)
    for j, m in enumerate(markets):
        c = candles[m]["close"].to_numpy(np.float64)
        rets[j] = _place(idx, candles[m], ind.rolling_return(c, lookback))
        rsis[j] = _place(idx, candles[m], ind.rsi(c, rsi_n))
    warm = np.isfinite(rets).any(axis=0)
    regime_ok = np.ones(n, dtype=bool)
    if regime_n > 0:
        if REGIME_MARKET not in candles:
            raise KeyError(f"pullback_rotation with regimeSma needs {REGIME_MARKET} candles")
        b = candles[REGIME_MARKET]
        bc = b["close"].to_numpy(np.float64)
        bs = ind.sma(bc, regime_n)
        bts = np.asarray(b.index, dtype=np.int64)
        bpos = np.searchsorted(idx, bts)
        inside = bpos < n
        bpos, bc, bs, bts = bpos[inside], bc[inside], bs[inside], bts[inside]
        match = idx[bpos] == bts
        reg_warm = np.zeros(n, dtype=bool)
        regime_ok = np.zeros(n, dtype=bool)
        reg_warm[bpos[match]] = np.isfinite(bs[match])
        regime_ok[bpos[match]] = np.isfinite(bs[match]) & (bc[match] > bs[match])
        warm &= np.maximum.accumulate(reg_warm)
    first = int(np.argmax(warm)) if warm.any() else n
    each = max_weight(spec) / top
    W = np.zeros((n, M))
    W[:first] = np.nan
    name_rank = np.argsort(np.argsort(np.array(markets)))
    held: set[int] = set()
    for t in range(first, n):
        if not regime_ok[t]:
            held = set()
            continue
        col = rets[:, t]
        ranked = sorted((j for j in range(M) if np.isfinite(col[j]) and col[j] > 0),
                        key=lambda j: (-col[j], name_rank[j]))
        in_pool = ranked[:pool]
        pool_set = set(in_pool)
        held = {j for j in held if j in pool_set}
        for j in in_pool:                       # best return first
            if len(held) >= top:
                break
            if j in held:
                continue
            r = rsis[j, t]
            if rsi_below >= 100 or (np.isfinite(r) and r < rsi_below):
                held.add(j)
        for j in held:
            W[t, j] = each
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    top, pool, below = int(p["top"]), int(p["pool"]), float(p["rsiBelow"])
    steps = [
        f"After every {iv} candle it ranks {mk} by how much they rose over the last {bars_text(p['lookback'], iv)}; "
        f"the best {pool} that actually rose are its shortlist.",
    ]
    if below >= 100:
        steps.append(f"It buys shortlisted coins straight away, at most {top} at a time ({100 / top:.0f} % of the "
                     "money each).")
    else:
        steps.append(f"It does not chase them: it buys a shortlisted coin only after a short pullback, when its "
                     f"{p['rsiPeriod']}-candle RSI is under {below:.0f}, at most {top} coins at a time "
                     f"({100 / top:.0f} % of the money each).")
    steps.append("A coin is sold once it drops off the shortlist; unused slots stay in euros.")
    if int(p.get("regimeSma") or 0) > 0:
        steps.append(f"Market filter: it only holds coins while bitcoin is above its {bars_text(p['regimeSma'], iv)} "
                     "average price; otherwise everything goes to euros.")
    return {
        "summary": "Picks the coins with the strongest recent rise, but buys them on a short dip instead of at the "
                   "top; steps into euros when bitcoin is in a downtrend.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets with a few leading coins that rise in waves, pausing for a day or two in between.",
        "whenItLoses": "Straight-up rallies that never pull back (it stays in euros) and leaders that keep falling "
                       "after the dip it bought.",
    }
