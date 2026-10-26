"""turtle_skip_a18 v1 (agent-18): Donchian breakout with the Turtle traders' "skip after a winner" rule.

The Turtles' System 1 (20-day breakout, 10-day exit) ignored a breakout when the previous breakout signal, taken or
not, would have been a winning trade; they believed false breakouts cluster after real ones and real ones follow a
run of losers. A skipped breakout is still followed on paper, and the next signal can only come after its paper exit.
To avoid missing a big move they kept a failsafe: a longer (55-day) breakout was always taken.

Per market, at each bar close:

- breakout signal: close above the highest high of the previous ``entry`` candles, while no paper trade is open;
  the paper trade enters at that close and exits when a close falls under the lowest low of the previous ``exit``
  candles. It is a winner when its exit close is above its entry close.
- with ``skip`` on, the signal is only traded when the previous paper trade was not a winner (or there was none);
  ``skip`` off is the plain Donchian breakout (control).
- failsafe (``failsafe`` > 0): while flat, a close above the highest high of the previous ``failsafe`` candles buys
  even when the shorter signal was skipped.
- a position is sold when a close falls under the ``exit``-candle low.

maxWeight / len(markets) per held market. Decisions use candles up to and including the bar.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "turtle_skip_a18"
VERSION = 1
TITLE = "Turtle breakout that skips the signal after a winner"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"entry": 20, "exit": 10, "skip": True, "failsafe": 55}


def param_space() -> dict:
    return {
        "entry": {"type": "int", "min": 3, "max": 400, "log": True,
                  "description": "breakout: close above the high of this many previous candles"},
        "exit": {"type": "int", "min": 2, "max": 300, "log": True,
                 "description": "sell (and end the paper trade) when the close is under the low of this many candles"},
        "skip": {"type": "bool", "description": "skip a breakout when the previous breakout was a winner"},
        "failsafe": {"type": "int", "min": 5, "max": 800, "log": True, "zero": True,
                     "description": "always buy a breakout of this many candles while flat (0 = no failsafe)"},
    }


def valid_params(p: dict) -> str | None:
    fs = int(p.get("failsafe") or 0)
    if fs and fs <= int(p["entry"]):
        return "failsafe must be longer than entry (or 0)"
    return None


def warmup(p: dict) -> int:
    return max(int(p["entry"]), int(p["exit"]), int(p.get("failsafe") or 0))


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def held(df: pd.DataFrame, p: dict) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    h = df["high"].to_numpy(np.float64)
    lo = ind.prior_min(df["low"].to_numpy(np.float64), int(p["exit"]))
    hi = ind.prior_max(h, int(p["entry"]))
    fs = int(p.get("failsafe") or 0)
    hf = ind.prior_max(h, fs) if fs else np.full(len(c), np.inf)
    skip = bool(p.get("skip"))
    n = len(c)
    out = np.full(n, np.nan)
    first = warmup(p)
    inside = paper = False
    paper_entry = 0.0
    last_win = None
    for i in range(first, n):
        x = c[i]
        if not (np.isfinite(x) and np.isfinite(hi[i]) and np.isfinite(lo[i])):
            continue
        # exits first (the paper trade and the position share the same exit channel)
        if paper and x < lo[i]:
            paper = False
            last_win = x > paper_entry
        if inside and x < lo[i]:
            inside = False
        if not paper and x > hi[i]:
            paper, paper_entry = True, x
            if not inside and not (skip and last_win):
                inside = True
        if not inside and fs and x > hf[i]:
            inside = True
        out[i] = 1.0 if inside else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    cols = [_asof(candles[m], held(candles[m], p), idx) * each for m in markets]
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    fs = int(p.get("failsafe") or 0)
    steps = [
        f"Breakout: a close above the highest price of the previous {bars_text(p['entry'], iv)} is a buy signal for "
        f"{mk}.",
        f"It sells when a close falls below the lowest price of the previous {bars_text(p['exit'], iv)}.",
    ]
    if p.get("skip"):
        steps.append("It skips a buy signal when the previous signal (taken or not) would have ended in profit, "
                     "the old Turtle traders' rule; skipped signals are still followed on paper.")
    if fs:
        steps.append(f"Failsafe: while out, a close above the high of the previous {bars_text(fs, iv)} always buys.")
    return {
        "summary": f"A Turtle-style breakout strategy on {mk}"
                   + (" that skips the breakout after a winning one." if p.get("skip") else "."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Strong trends that start after a few failed breakouts.",
        "whenItLoses": "A real trend that starts right after a winning breakout (until the failsafe buys), "
                       "and choppy ranges.",
    }
