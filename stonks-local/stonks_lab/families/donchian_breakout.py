"""donchian_breakout v1: buy when the close breaks above the highest high of the previous `entry` candles, exit when
the close falls below the lowest low of the previous `exit` candles (in/out state carried from bar to bar)."""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "donchian_breakout"
VERSION = 1
TITLE = "Donchian breakout"
BOT_READY = True
MULTI_MARKET = False


def default_params() -> dict:
    return {"entry": 20, "exit": 10}


def param_space() -> dict:
    return {
        "entry": {"type": "int", "min": 3, "max": 300, "log": True,
                  "description": "buy when the close beats the high of this many previous candles"},
        "exit": {"type": "int", "min": 2, "max": 200, "log": True,
                 "description": "sell when the close falls under the low of this many previous candles"},
    }


def warmup(p: dict) -> int:
    return max(int(p["entry"]), int(p["exit"]))


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    hi = ind.prior_max(df["high"].to_numpy(np.float64), p["entry"])
    lo = ind.prior_min(df["low"].to_numpy(np.float64), p["exit"])
    n = len(c)
    w = np.full(n, np.nan)
    first = warmup(p)
    mw = max_weight(spec)
    if first < n:
        cl, hl, ll = c.tolist(), hi.tolist(), lo.tolist()
        out = [0.0] * (n - first)
        inside = False
        for k, i in enumerate(range(first, n)):
            if not inside:
                if cl[i] > hl[i]:
                    inside = True
            elif cl[i] < ll[i]:
                inside = False
            out[k] = mw if inside else 0.0
        w[first:] = out
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": f"A breakout strategy on {mk}: it buys when the price closes at a new high for the period and "
                   "sells when it closes at a new low.",
        "howItWorks": [
            f"After every {iv} candle it looks at the highest price of the previous {bars_text(p['entry'], iv)}.",
            "If the candle closes above that high, a breakout is under way: it buys.",
            f"It keeps holding until a candle closes below the lowest price of the previous "
            f"{bars_text(p['exit'], iv)}, then sells everything.",
            *risk_steps(spec),
        ],
        "whenItWins": "Strong breakouts that keep running, like the start of a bull market.",
        "whenItLoses": "False breakouts in a range: it buys at the top of the range and sells at the bottom.",
    }
