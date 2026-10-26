"""rotation_momentum v1: hold the `top` markets with the best `lookback` return, maxWeight/top each.

Identical to `rotation` in stonks/backend/src/strategies/families.ts. On every timestamp t of the union of the
markets' candles: for each market in spec.markets with a candle at t and at least `lookback` earlier candles in its
own series, ret = close[idx]/close[idx-lookback] - 1. Markets with ret > 0 are ranked by ret (desc; ties by market
name asc) and the best `top` get maxWeight/top each (unused slots stay cash). With regimeSma > 0 everything is cash
unless BTC-EUR has a candle at t with close > SMA(regimeSma) of its own closes.

Rows before the first "warm" bar (regime SMA defined if used, and some market with `lookback` history) are NaN.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "rotation_momentum"
VERSION = 1
TITLE = "Momentum rotation"
BOT_READY = True
MULTI_MARKET = True
REGIME_MARKET = "BTC-EUR"


def default_params() -> dict:
    return {"lookback": 30, "top": 3, "regimeSma": 0}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 2, "max": 1000, "log": True,
                     "description": "candles over which the return is measured"},
        "top": {"type": "int", "min": 1, "max": 10, "description": "how many of the best coins to hold"},
        "regimeSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                      "description": "only hold coins while BTC is above this SMA (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    return None if int(p["top"]) >= 1 else "top must be at least 1"


def warmup(p: dict) -> int:
    r = int(p.get("regimeSma") or 0)
    return max(int(p["lookback"]), r - 1 if r > 0 else 0)


def required_markets(spec: dict) -> list[str]:
    return [REGIME_MARKET] if int((spec.get("params") or {}).get("regimeSma") or 0) > 0 else []


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    lookback, top, regime_n = int(p["lookback"]), int(p["top"]), int(p.get("regimeSma") or 0)
    idx = union_index(candles, markets)
    n = len(idx)
    # Per-market lookback return on its own series, placed on the union index (NaN where it has no candle).
    rets = np.full((len(markets), n), np.nan)
    for j, m in enumerate(markets):
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        r = ind.rolling_return(c, lookback)
        pos = np.searchsorted(idx, np.asarray(df.index, dtype=np.int64))
        rets[j, pos] = r
    warm = np.isfinite(rets).any(axis=0)
    regime_ok = np.ones(n, dtype=bool)
    if regime_n > 0:
        if REGIME_MARKET not in candles:
            raise KeyError(f"rotation_momentum with regimeSma needs {REGIME_MARKET} candles")
        b = candles[REGIME_MARKET]
        bc = b["close"].to_numpy(np.float64)
        bs = ind.sma(bc, regime_n)
        bpos = np.searchsorted(idx, np.asarray(b.index, dtype=np.int64))
        inside = (bpos < n)
        bpos, bc, bs = bpos[inside], bc[inside], bs[inside]
        match = idx[bpos] == np.asarray(b.index, dtype=np.int64)[inside]
        reg_warm = np.zeros(n, dtype=bool)
        regime_ok = np.zeros(n, dtype=bool)
        reg_warm[bpos[match]] = np.isfinite(bs[match])
        regime_ok[bpos[match]] = np.isfinite(bs[match]) & (bc[match] > bs[match])
        # Warm once the regime SMA has been defined at least once (later BTC gaps count as "not ok": cash).
        warm &= np.maximum.accumulate(reg_warm)
    first = int(np.argmax(warm)) if warm.any() else n
    mw = max_weight(spec)
    each = mw / top
    W = np.zeros((n, len(markets)))
    W[:first] = np.nan
    # Rank: return desc, then market name asc.
    order_names = np.argsort(np.argsort(np.array(markets)))  # rank of each market's name
    pos_ret = np.where(np.isfinite(rets) & (rets > 0), rets, -np.inf)  # (M, n)
    for t in range(first, n):
        if not regime_ok[t]:
            continue
        col = pos_ret[:, t]
        cand = np.flatnonzero(col > -np.inf)
        if len(cand) == 0:
            continue
        if len(cand) > top:
            cand = sorted(cand.tolist(), key=lambda j: (-col[j], order_names[j]))[:top]
        W[t, cand] = each
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    top = int(p["top"])
    steps = [
        f"After every {iv} candle it measures how much each of {mk} rose or fell over the last "
        f"{bars_text(p['lookback'], iv)}.",
        f"It holds the {top} best performer{'s' if top > 1 else ''}, each with an equal share of the money "
        f"({100 / top:.0f} % each), as long as they actually went up.",
        "Coins that fell over that period are never held; their share stays in euros. If nothing rose, it is "
        "fully in euros.",
    ]
    if int(p.get("regimeSma") or 0) > 0:
        steps.append(f"Market filter: it only holds coins while bitcoin is above its {bars_text(p['regimeSma'], iv)} "
                     "average price; otherwise everything goes to euros.")
    return {
        "summary": "Rotates into the coins that are rising the fastest right now and steps into euros when nothing "
                   "is rising.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Strong bull markets where a few coins lead for weeks at a time.",
        "whenItLoses": "Sudden reversals: it buys yesterday's winners just as they turn, and switching costs fees.",
    }
