"""xs_volmom v1 (agent-20): cross-sectional momentum with volatility management.

Builds on xs_reversal mode=momentum (top10 1d, the only eval-v2 spec above 0, ~92 % exposure but a 44 % median
fold drawdown). Hypothesis: the excess return comes from holding the leaders, the drawdown from holding them at
full size into crashes, so scale the book down when realised volatility is high (volatility-managed momentum).

- Closes are aligned to the union index (missing bar = previous close, NaN before listing).
- Momentum of a market at bar t: close[t-skip] / close[t-skip-lookback] - 1.
- Volatility of a market at bar t: the standard deviation of its last ``volLen`` one-bar log returns.
- Rebalance bars: the first warm bar and every bar that starts a new block of ``hold`` candles (by timestamp).
  Between rebalances the weights stay fixed (no daily resizing churn).
- At a rebalance the markets with a finite momentum and volatility are ranked by ``rank``: ``return`` (plain
  momentum) or ``sharpe`` (momentum / volatility). With ``absMom`` only markets with a positive momentum are
  eligible (a slot without one stays cash). The best ``count`` are held.
- ``weighting``: ``equal`` (1/count each) or ``invvol`` (1/vol, normalised to the filled slots' share).
- ``targetVol`` > 0 (annualised, e.g. 0.8 = 80 %): the whole book is scaled by min(1, targetVol / v), v = the
  annualised volatility of the chosen weighted basket over the last ``volLen`` bars.

Everything at bar t uses closes up to and including t (no look-ahead).
"""
from __future__ import annotations

import numpy as np

from ._base import aligned_close, bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "xs_volmom"
VERSION = 1
TITLE = "Volatility-managed momentum rotation"
BOT_READY = False
MULTI_MARKET = True

YEAR_MS = 365 * 86_400_000


def default_params() -> dict:
    return {"lookback": 17, "skip": 0, "hold": 4, "count": 4, "rank": "return", "weighting": "equal",
            "volLen": 30, "targetVol": 0.0, "absMom": False}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 3, "max": 120, "log": True,
                     "description": "candles over which each coin's return is measured for the ranking"},
        "skip": {"type": "int", "min": 1, "max": 10, "zero": True,
                 "description": "leave out the most recent candles from the momentum window (0 = none)"},
        "hold": {"type": "int", "min": 1, "max": 30, "log": True,
                 "description": "candles between rebalances"},
        "count": {"type": "int", "min": 1, "max": 6, "description": "how many coins to hold"},
        "rank": {"type": "choice", "values": ["return", "sharpe"],
                 "description": "rank by plain return or by return divided by volatility"},
        "weighting": {"type": "choice", "values": ["equal", "invvol"],
                      "description": "equal shares, or shares inversely proportional to each coin's volatility"},
        "volLen": {"type": "int", "min": 7, "max": 120, "log": True,
                   "description": "candles of returns in the volatility estimates"},
        "targetVol": {"type": "float", "min": 0.3, "max": 1.5, "zero": True,
                      "description": "annualised volatility the whole book is scaled down to (0 = off)"},
        "absMom": {"type": "bool", "description": "only hold coins whose own momentum is positive (else cash)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["count"]) < 1 or int(p["hold"]) < 1 or int(p["lookback"]) < 1 or int(p["volLen"]) < 2:
        return "count, hold, lookback must be >= 1 and volLen >= 2"
    return None


def warmup(p: dict) -> int:
    return max(int(p["lookback"]) + int(p.get("skip") or 0), int(p["volLen"]))


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    lb, skip, hold, count = int(p["lookback"]), int(p.get("skip") or 0), int(p["hold"]), int(p["count"])
    vl = int(p["volLen"])
    tv = float(p.get("targetVol") or 0.0)
    sharpe = p.get("rank", "return") == "sharpe"
    invvol = p.get("weighting", "equal") == "invvol"
    absm = bool(p.get("absMom"))
    idx = union_index(candles, markets)
    n, M = len(idx), len(markets)
    W = np.full((n, M), np.nan)
    if n == 0:
        return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})
    C = np.vstack([aligned_close(candles, m, idx) for m in markets])  # (M, n)
    ret = np.full((M, n), np.nan)
    span = lb + skip
    if n > span:
        with np.errstate(invalid="ignore", divide="ignore"):
            ret[:, span:] = C[:, lb:n - skip] / C[:, :n - span] - 1.0
    lr = np.full((M, n), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        lr[:, 1:] = np.log(C[:, 1:] / C[:, :-1])
    vol = np.full((M, n), np.nan)
    if n > vl:
        # rolling std over the last vl returns (bars t-vl+1..t); NaN when any return in the window is missing
        from numpy.lib.stride_tricks import sliding_window_view
        win = sliding_window_view(lr, vl, axis=1)  # (M, n-vl+1, vl), window ending at bar vl-1+i
        sd = win.std(axis=2, ddof=1)
        vol[:, vl - 1:] = sd
    warm = (np.isfinite(ret) & np.isfinite(vol)).any(axis=0)
    first = int(np.argmax(warm)) if warm.any() else n
    step = int(np.median(np.diff(idx))) if n > 1 else 1
    block = idx // max(1, step * hold)
    ann = np.sqrt(YEAR_MS / max(1, step))
    mw = max_weight(spec)
    name_rank = np.argsort(np.argsort(np.array(markets)))
    row = np.zeros(M)
    for t in range(first, n):
        if t == first or block[t] != block[t - 1]:
            r, v = ret[:, t], vol[:, t]
            cand = [j for j in range(M) if np.isfinite(r[j]) and np.isfinite(v[j]) and v[j] > 0]
            if absm:
                cand = [j for j in cand if r[j] > 0]
            key = (lambda j: (-(r[j] / v[j]), name_rank[j])) if sharpe else (lambda j: (-r[j], name_rank[j]))
            cand.sort(key=key)
            held = cand[:count]
            row = np.zeros(M)
            if held:
                if invvol:
                    iv = np.array([1.0 / v[j] for j in held])
                    share = len(held) / count
                    w = iv / iv.sum() * share
                else:
                    w = np.full(len(held), 1.0 / count)
                if tv > 0:
                    lo = max(1, t - vl + 1)
                    seg = lr[np.array(held), lo:t + 1]
                    seg = np.where(np.isfinite(seg), seg, 0.0)
                    port = (w[:, None] * seg).sum(axis=0) / max(w.sum(), 1e-12)
                    pv = float(np.std(port, ddof=1)) * ann if port.size > 1 else 0.0
                    if pv > 0:
                        w = w * min(1.0, tv / pv)
                for k, j in enumerate(held):
                    row[j] = w[k] * mw
        W[t] = row
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    count = int(p["count"])
    skip = int(p.get("skip") or 0)
    tv = float(p.get("targetVol") or 0.0)
    rank_txt = ("how much each rose" if p.get("rank", "return") == "return"
                else "how much each rose per unit of its own volatility (a smooth rise beats a wild one)")
    steps = [
        f"Every {bars_text(p['hold'], iv)} it ranks {mk} by {rank_txt} over the last "
        f"{bars_text(p['lookback'], iv)}" + (f", ignoring the most recent {bars_text(skip, iv)}." if skip else "."),
        f"It buys the {count} best-ranked coin{'s' if count > 1 else ''} and keeps them until the next ranking, "
        + ("with equal shares." if p.get("weighting", "equal") == "equal"
           else "giving calmer coins a bigger share (shares inversely proportional to volatility)."),
    ]
    if p.get("absMom"):
        steps.append("A coin is only bought when its own price rose over that window; otherwise its share waits in "
                     "euros.")
    if tv > 0:
        steps.append(f"When the chosen coins together swing more than {tv * 100:.0f} % a year (measured over the "
                     f"last {bars_text(p['volLen'], iv)}), it holds proportionally less and keeps the rest in euros.")
    return {
        "summary": "Holds the coins that led the others recently, and holds less of them when markets get wild.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Markets where a few coins keep outrunning the rest for weeks, with calm trends.",
        "whenItLoses": "Sharp reversals where yesterday's leaders fall hardest, and violent bull runs where the "
                       "volatility cap keeps it partly in cash.",
    }
