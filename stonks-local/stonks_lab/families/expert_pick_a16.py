"""expert_pick_a16 v1 (agent-16): online expert selection over a bank of SMA trend cores.

Idea ("follow the leader" / strategy momentum): nobody knows the right SMA length in advance, and the fleet's
findings show the best length differs by coin and era. Instead of fixing it, keep a bank of experts and, after every
candle, follow the one(s) whose own fee-net paper return over the last ``window`` candles was best.

- experts: ``n`` SMA cores with lengths spaced geometrically from ``minLen`` to ``maxLen`` (each one: hold while the
  close is above its SMA), plus buy and hold when ``withHold`` is on;
- paper return of expert e at bar t: sum over the last ``window`` bars of pos_e(s-1) * logret(s) minus
  ``paperFee`` (0.25 % taker) for every switch of pos_e: everything uses closes up to and including bar t;
- the strategy holds the AVERAGE position of the ``topK`` best experts (ties broken towards the longer SMA), so
  topK 1 = follow the single leader, larger topK = a committee of the recent best.

Multi-market: each market gets maxWeight / len(markets), with its own experts.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "expert_pick_a16"
VERSION = 1
TITLE = "Follow the best SMA expert"
BOT_READY = False
MULTI_MARKET = True
ANCHORED = False


def default_params() -> dict:
    return {"n": 6, "minLen": 20, "maxLen": 200, "window": 180, "topK": 1, "withHold": True, "paperFee": 0.0025}


def param_space() -> dict:
    return {
        "n": {"type": "int", "min": 2, "max": 12, "description": "number of SMA experts in the bank"},
        "minLen": {"type": "int", "min": 5, "max": 80, "log": True, "description": "shortest SMA length"},
        "maxLen": {"type": "int", "min": 60, "max": 300, "log": True, "description": "longest SMA length"},
        "window": {"type": "int", "min": 20, "max": 400, "log": True,
                   "description": "candles of paper performance used to rank the experts"},
        "topK": {"type": "int", "min": 1, "max": 6, "description": "hold the average position of the best K experts"},
        "withHold": {"type": "bool", "description": "buy and hold is one of the experts"},
        "paperFee": {"type": "float", "min": 0.0, "max": 0.01,
                     "description": "fee charged per switch in the experts' paper returns"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["minLen"]) >= int(p["maxLen"]):
        return "minLen must be below maxLen"
    if int(p["topK"]) > int(p["n"]) + (1 if p.get("withHold") else 0):
        return "topK must be at most the number of experts"
    return None


def warmup(p: dict) -> int:
    return int(p["maxLen"]) + int(p["window"]) + 1


def lengths(p: dict) -> list[int]:
    n, lo, hi = int(p["n"]), int(p["minLen"]), int(p["maxLen"])
    if n == 1:
        return [hi]
    out = np.unique(np.round(np.geomspace(lo, hi, n)).astype(int))
    return [int(x) for x in out]


def expert_positions(c: np.ndarray, p: dict) -> np.ndarray:
    """(bars, experts) 0/1 positions, NaN while an expert's SMA is undecided."""
    cols = []
    for L in lengths(p):
        sm = ind.sma(c, L)
        cols.append(np.where(np.isfinite(sm) & np.isfinite(c), (c > sm).astype(np.float64), np.nan))
    if p.get("withHold", True):
        cols.append(np.where(np.isfinite(c), 1.0, np.nan))
    return np.column_stack(cols)


def paper_scores(c: np.ndarray, pos: np.ndarray, window: int, fee: float) -> np.ndarray:
    """Trailing fee-net log return of every expert, as known at each bar's close (NaN until a full window)."""
    T, E = pos.shape
    r = np.full(T, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        r[1:] = np.log(c[1:] / c[:-1])
    prev = np.vstack([np.full((1, E), np.nan), pos[:-1]])       # pos at s-1 earns r(s)
    prev2 = np.vstack([np.full((2, E), np.nan), pos[:-2]])      # switch made at s-1
    gain = prev * r[:, None] - fee * np.abs(prev - prev2)
    valid = np.isfinite(gain)
    g = np.where(valid, gain, 0.0)
    cs = np.vstack([np.zeros((1, E)), np.cumsum(g, axis=0)])
    cv = np.vstack([np.zeros((1, E)), np.cumsum(valid, axis=0)])
    out = np.full((T, E), np.nan)
    if T > window:
        s = cs[window + 1:] - cs[1:T - window + 1]
        k = cv[window + 1:] - cv[1:T - window + 1]
        out[window:] = np.where(k == window, s, np.nan)
    return out


def pick(pos: np.ndarray, score: np.ndarray, top_k: int) -> np.ndarray:
    T, E = pos.shape
    w = np.full(T, np.nan)
    tie = np.arange(E) * 1e-12                                   # later experts (longer SMA, then hold) win ties
    for t in range(T):
        sc, ps = score[t], pos[t]
        if not (np.isfinite(sc).all() and np.isfinite(ps).all()):
            continue
        best = np.argsort(-(sc + tie), kind="stable")[:top_k]
        w[t] = float(ps[best].mean())
    return w


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("expert_pick_a16 needs at least one market")
    idx = union_index(candles, markets)
    each = max_weight(spec) / len(markets)
    window, fee, top_k = int(p["window"]), float(p.get("paperFee", 0.0025)), int(p["topK"])
    cols = {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        pos = expert_positions(c, p)
        w = pick(pos, paper_scores(c, pos, window, fee), top_k)
        cols[m] = w * each
    df = frame(idx, cols)
    if len(markets) > 1:
        any_ok = df.notna().any(axis=1).to_numpy()
        df = df.fillna(0.0)
        df[~any_ok] = np.nan
    return df


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    ls = ", ".join(str(x) for x in lengths(p))
    k = int(p["topK"])
    steps = [
        f"It runs a bank of simple trend rules on paper: hold while the price is above its average over {ls} "
        f"{iv} candles" + (", plus plain buy and hold." if p.get("withHold", True) else "."),
        f"After every {iv} candle it scores each rule by what it would have earned over the last "
        f"{bars_text(p['window'], iv)}, after a {float(p.get('paperFee', 0.0025)) * 100:.2f} % fee per switch.",
        ("It then copies the position of the best-scoring rule." if k == 1 else
         f"It then holds the average position of the {k} best-scoring rules."),
    ]
    if len(spec.get("markets") or []) > 1:
        steps.append(f"The money is split evenly between {mk}, each with its own rules.")
    return {
        "summary": f"Trades {mk} by following whichever trend rule (average length) worked best recently.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Long stretches where one trend speed keeps fitting the market, e.g. a slow trend in a long "
                      "bull or a fast one in a sharp bear.",
        "whenItLoses": "Regime changes: the recent winner is often the rule that fits the market that just ended, "
                       "so it switches late and pays for it.",
    }
