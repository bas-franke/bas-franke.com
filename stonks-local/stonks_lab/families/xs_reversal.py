"""xs_reversal v1 (agent-07): cross-sectional short-term reversal across the chosen markets, rebalanced on a schedule.

Tests the "buy last week's laggards" idea that rotation_momentum never covers (it always buys the leaders):

- Closes are aligned to the union index (a missing bar carries the previous close; NaN before listing).
- Return of each market at bar t: close[t] / close[t-lookback] - 1.
- Rebalance bars: the first warm bar and every bar whose timestamp starts a new block of ``hold`` candles
  (block = ts // (candle length * hold), candle length = the median spacing of the union index), so the schedule
  only depends on time, not on where the data starts.
- At a rebalance bar the markets with a finite return are ranked: ``mode=reversal`` ascending (worst first),
  ``mode=momentum`` descending (best first); ties by market name. The first ``count`` eligible ones are held with
  maxWeight/count each until the next rebalance. With ``trendSma`` > 0 a market is only eligible while its close is
  above its own SMA(trendSma), and a held market is sold at once when it closes below that SMA (its slot stays cash
  until the next rebalance).

Everything at bar t uses closes up to and including t (no look-ahead).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "xs_reversal"
VERSION = 1
TITLE = "Cross-sectional reversal"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"lookback": 7, "hold": 7, "count": 3, "trendSma": 0, "mode": "reversal"}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 1, "max": 200, "log": True,
                     "description": "candles over which each coin's return is measured for the ranking"},
        "hold": {"type": "int", "min": 1, "max": 100, "log": True,
                 "description": "candles between rebalances (the picks are kept that long)"},
        "count": {"type": "int", "min": 1, "max": 5, "description": "how many coins to hold"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                     "description": "only hold a coin while its close is above this SMA of its own (0 = off)"},
        "mode": {"type": "choice", "values": ["reversal", "momentum"],
                 "description": "reversal: buy the coins that fell the most; momentum: buy the ones that rose most"},
    }


def valid_params(p: dict) -> str | None:
    return None if int(p["count"]) >= 1 and int(p["hold"]) >= 1 else "count and hold must be at least 1"


def warmup(p: dict) -> int:
    s = int(p.get("trendSma") or 0)
    return max(int(p["lookback"]), s - 1 if s > 0 else 0)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    lb, hold, count = int(p["lookback"]), int(p["hold"]), int(p["count"])
    sma_n = int(p.get("trendSma") or 0)
    rev = p.get("mode", "reversal") == "reversal"
    idx = union_index(candles, markets)
    n, M = len(idx), len(markets)
    W = np.full((n, M), np.nan)
    if n == 0:
        return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})
    C = np.vstack([aligned_close(candles, m, idx) for m in markets])  # (M, n)
    ret = np.full((M, n), np.nan)
    if n > lb:
        with np.errstate(invalid="ignore", divide="ignore"):
            ret[:, lb:] = C[:, lb:] / C[:, :-lb] - 1.0
    ok = np.ones((M, n), dtype=bool)
    warm = np.isfinite(ret).any(axis=0)
    if sma_n > 0:
        S = np.vstack([ind.sma(C[j], sma_n) if np.isfinite(C[j]).any() else np.full(n, np.nan) for j in range(M)])
        with np.errstate(invalid="ignore"):
            ok = np.isfinite(S) & (C > S)
        warm &= np.isfinite(S).any(axis=0)
    first = int(np.argmax(warm)) if warm.any() else n
    step = int(np.median(np.diff(idx))) if n > 1 else 1
    block = idx // max(1, step * hold)
    mw = max_weight(spec)
    each = mw / count
    name_rank = np.argsort(np.argsort(np.array(markets)))
    held: list[int] = []
    for t in range(first, n):
        if t == first or block[t] != block[t - 1]:
            col = ret[:, t]
            cand = [j for j in np.flatnonzero(np.isfinite(col)).tolist() if ok[j, t]]
            cand.sort(key=lambda j: ((col[j] if rev else -col[j]), name_rank[j]))
            held = cand[:count]
        else:
            held = [j for j in held if ok[j, t]]
        row = np.zeros(M)
        for j in held:
            row[j] = each
        W[t] = row
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    count = int(p["count"])
    rev = p.get("mode", "reversal") == "reversal"
    steps = [
        f"Every {bars_text(p['hold'], iv)} it ranks {mk} by how much each moved over the last "
        f"{bars_text(p['lookback'], iv)}.",
        (f"It buys the {count} coin{'s' if count > 1 else ''} that fell the most (or rose the least), betting that "
         "short-term losers bounce back," if rev else
         f"It buys the {count} coin{'s' if count > 1 else ''} that rose the most, betting that leaders keep leading,")
        + f" with an equal share each ({100 / count:.0f} %), and keeps them until the next ranking.",
    ]
    if int(p.get("trendSma") or 0) > 0:
        steps.append(f"Safety filter: a coin is only bought while it is above its {bars_text(p['trendSma'], iv)} "
                     "average price, and sold at once when it closes below it; that share then waits in euros.")
    return {
        "summary": ("Buys the coins that lagged the others recently and swaps them on a fixed schedule."
                    if rev else "Buys the coins that led the others recently and swaps them on a fixed schedule."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": ("Choppy markets where coins take turns: a laggard catches up with the pack."
                       if rev else "Markets where a few coins keep outrunning the rest for weeks."),
        "whenItLoses": ("Crashes and coin-specific bad news: the coin that fell the most often keeps falling."
                        if rev else "Sharp reversals where yesterday's leaders fall hardest."),
    }
