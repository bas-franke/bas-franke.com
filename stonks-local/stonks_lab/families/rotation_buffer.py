"""rotation_buffer v1 (agent-10): top-K momentum rotation with a rank buffer, skip window and drift sizing.

Built to attack rotation_momentum's fee drag (~430 trades/yr on top10 1d, finding #67):

- Momentum of each market at bar t: close[t-skip] / close[t-skip-lookback] - 1 on closes aligned to the union index
  (a missing bar carries the previous close; NaN before listing). ``skip`` leaves out the most recent candles
  (classic 12-1 momentum avoids short-term reversal).
- Ranking: markets with a finite momentum, by momentum desc, ties by market name asc (rank 1 = best).
- Holdings: a held market stays while its rank <= ``keepRank`` and its momentum > 0. Free slots (``top`` minus the
  kept ones) are filled with the best-ranked non-held markets that have momentum > 0 and rank <= ``top``.
- Sizing ``equal``: every held market gets maxWeight/top (the executor then rebalances drift > 2 % of equity).
  Sizing ``drift``: a virtual portfolio of ``top`` sleeves is simulated from the closes (no fees): a held sleeve
  grows with its coin, an exiting sleeve turns into virtual cash, entrants split the virtual cash equally over the
  free slots. Target = sleeve value / virtual equity * maxWeight, so held coins are left to run instead of being
  trimmed back to equal weight every few bars.

All state comes from candles up to and including bar t (no look-ahead).
"""
from __future__ import annotations

import numpy as np

from ._base import aligned_close, bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "rotation_buffer"
VERSION = 1
TITLE = "Momentum rotation with rank buffer"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"lookback": 14, "skip": 0, "top": 4, "keepRank": 6, "sizing": "drift"}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 2, "max": 400, "log": True,
                     "description": "candles over which the momentum (return) is measured"},
        "skip": {"type": "int", "min": 1, "max": 60, "zero": True, "log": True,
                 "description": "leave out the most recent candles from the momentum window (0 = none)"},
        "top": {"type": "int", "min": 1, "max": 6, "description": "how many coins to hold at most"},
        "keepRank": {"type": "int", "min": 1, "max": 10,
                     "description": "a held coin is kept while it ranks this high or better (>= top: a buffer)"},
        "sizing": {"type": "choice", "values": ["equal", "drift"],
                   "description": "equal: rebalance to equal shares; drift: let held coins run, only resize on swaps"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["top"]) < 1:
        return "top must be at least 1"
    if int(p["keepRank"]) < int(p["top"]):
        return "keepRank must be at least top"
    return None


def warmup(p: dict) -> int:
    return int(p["lookback"]) + int(p.get("skip") or 0)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    lb, skip, top, keep = int(p["lookback"]), int(p.get("skip") or 0), int(p["top"]), int(p["keepRank"])
    drift = p.get("sizing", "drift") == "drift"
    idx = union_index(candles, markets)
    n, M = len(idx), len(markets)
    C = np.vstack([aligned_close(candles, m, idx) for m in markets])  # (M, n)
    mom = np.full((M, n), np.nan)
    span = lb + skip
    if n > span:
        # mom[t] = C[t-skip] / C[t-skip-lb] - 1
        a = C[:, : n - span]
        b = C[:, lb: n - skip]
        with np.errstate(invalid="ignore", divide="ignore"):
            mom[:, span:] = b / a - 1.0
    warm = np.isfinite(mom).any(axis=0)
    first = int(np.argmax(warm)) if warm.any() else n
    mw = max_weight(spec)
    W = np.full((n, M), np.nan)
    name_rank = np.argsort(np.argsort(np.array(markets)))
    held: set[int] = set()
    sleeve = np.zeros(M)  # virtual value per held market (drift sizing)
    cash = 1.0
    for t in range(first, n):
        if drift and t > first and held:
            for j in held:
                c0, c1 = C[j, t - 1], C[j, t]
                if np.isfinite(c0) and np.isfinite(c1) and c0 > 0:
                    sleeve[j] *= c1 / c0
        col = mom[:, t]
        fin = np.flatnonzero(np.isfinite(col))
        order = sorted(fin.tolist(), key=lambda j: (-col[j], name_rank[j]))
        rank = {j: r + 1 for r, j in enumerate(order)}
        kept = {j for j in held if j in rank and rank[j] <= keep and col[j] > 0}
        for j in held - kept:
            cash += sleeve[j]
            sleeve[j] = 0.0
        new = []
        for j in order:
            if len(kept) + len(new) >= top or rank[j] > top:
                break
            if j not in kept and col[j] > 0:
                new.append(j)
        if new:
            free = top - len(kept)
            for j in new:
                sleeve[j] = cash / free
            cash -= sleeve[new].sum()
        held = kept | set(new)
        row = np.zeros(M)
        if held:
            if drift:
                eq = cash + sleeve.sum()
                for j in held:
                    row[j] = mw * sleeve[j] / eq if eq > 0 else 0.0
            else:
                for j in held:
                    row[j] = mw / top
        W[t] = row
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    top, keep = int(p["top"]), int(p["keepRank"])
    skip = int(p.get("skip") or 0)
    window = f"the last {bars_text(p['lookback'], iv)}"
    if skip:
        window += f", leaving out the most recent {bars_text(skip, iv)}"
    steps = [
        f"After every {iv} candle it ranks {mk} by how much each rose over {window}.",
        f"It buys the best {top} that actually went up, with an equal share each ({100 / top:.0f} %).",
        f"A coin it holds is only sold when it drops below place {keep} in the ranking or stops rising; this buffer "
        "keeps it from swapping coins back and forth over small differences.",
    ]
    if p.get("sizing", "drift") == "drift":
        steps.append("Winners are left to run: it does not trim a rising coin back to an equal share; money is only "
                     "moved when a coin is swapped out.")
    return {
        "summary": "Holds the few fastest-rising coins and only swaps one out when it clearly falls behind, to save "
                   "fees.",
        "howItWorks": steps + ["Coins that fell over the window are never held; their share stays in euros."]
        + risk_steps(spec),
        "whenItWins": "Bull markets where a handful of coins lead for weeks at a time.",
        "whenItLoses": "Sharp reversals and choppy markets: it holds last month's winners as they turn, and a "
                       "crash hits all coins at once.",
    }
