"""pnl_exit_a18 v1 (agent-18): SMA trend core whose exit depends on how the open trade is doing.

Trend cores on BTC/ETH lose the bull folds mostly by selling in mid-bull corrections and buying back higher, while
they earn their keep by stepping aside in long bears (findings #324, #566). A fixed slow exit (asym_core) also keeps
the bad trades open longer. This family makes the exit speed a function of the open trade's result, the classic
"cut losers, let winners run":

- Enter when the close is above SMA(enterLen).
- While the trade has not (yet) gained ``gain`` since its entry close, it exits like the plain core: close under
  SMA(enterLen).
- Once the trade is a winner (its gain since the entry close is >= ``gain``; with ``state`` "peak" the best close
  since entry counts, so a winner stays a winner), it exits only when the close is under SMA(winLen), a slower
  average.
- After an exit it buys again as soon as the close is above SMA(enterLen): a fresh trade, judged from its own entry.

winLen == enterLen is the plain SMA core (the paired baseline). Every market is decided on its own candles and gets
maxWeight / len(markets) while held. A decision at bar t uses closes up to and including t only; the entry close is
the close of the bar on which the buy was decided.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "pnl_exit_a18"
VERSION = 1
TITLE = "Trend core that lets winning trades run"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"enterLen": 60, "winLen": 180, "gain": 0.25, "state": "peak"}


def param_space() -> dict:
    return {
        "enterLen": {"type": "int", "min": 5, "max": 300, "log": True,
                     "description": "buy above this SMA; trades that are not yet winners sell below it"},
        "winLen": {"type": "int", "min": 5, "max": 600, "log": True,
                   "description": "winning trades only sell below this (slower) SMA"},
        "gain": {"type": "float", "min": 0.02, "max": 2.0, "log": True, "zero": True,
                 "description": "gain since the entry close that makes a trade a winner (0 = every trade)"},
        "state": {"type": "choice", "values": ["peak", "current"],
                  "description": "peak: the best close since entry counts (once a winner, always a winner); "
                                 "current: only today's gain counts"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["winLen"]) < int(p["enterLen"]):
        return "winLen must be >= enterLen"
    return None


def warmup(p: dict) -> int:
    return max(int(p["enterLen"]), int(p["winLen"])) - 1


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def held(c: np.ndarray, p: dict) -> np.ndarray:
    fast = ind.sma(c, int(p["enterLen"]))
    slow = ind.sma(c, int(p["winLen"]))
    g = float(p.get("gain") or 0.0)
    peak_mode = p.get("state", "peak") == "peak"
    out = np.full(len(c), np.nan)
    inside, entry, best = False, 0.0, 0.0
    for i, (x, f, s) in enumerate(zip(c.tolist(), fast.tolist(), slow.tolist())):
        if not (np.isfinite(x) and np.isfinite(f) and np.isfinite(s)):
            continue
        if inside:
            best = max(best, x)
            ref = best if peak_mode else x
            winner = ref >= entry * (1.0 + g)
            if x < (s if winner else f):
                inside = False
        elif x > f:
            inside, entry, best = True, x, x
        out[i] = 1.0 if inside else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    cols = [_asof(candles[m], held(candles[m]["close"].to_numpy(np.float64), p), idx) * each for m in markets]
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    g = float(p.get("gain") or 0)
    peak = p.get("state", "peak") == "peak"
    steps = [
        f"Buy: it buys {mk} when the price is above its average of the last {bars_text(p['enterLen'], iv)}"
        + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        f"A trade that has not gained {pct(g)} yet is sold as soon as the price drops below that same average.",
        f"Once a trade is up {pct(g)} or more"
        + (" at any point since buying" if peak else " (counted from today's price)")
        + f", it is only sold when the price falls below the slower average of the last "
        f"{bars_text(p['winLen'], iv)}.",
        "After a sale it buys again when the price is back above the first average.",
    ]
    return {
        "summary": f"Trend-following on {mk} that cuts losing trades quickly and gives winning trades more room.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bull runs with sharp mid-run corrections: a winning trade sits them out instead of selling.",
        "whenItLoses": "Tops after a big run (the slow exit gives back more) and choppy markets near the first average.",
    }
