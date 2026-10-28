"""sl_quarter v1: add a quarter on each new high. The stop only rises, and a stop bar does not buy.

A new high is a close above the highest close of the previous n bars. The current bar is not part of
that high. While the trade is open the peak only rises. A close at or under the peak times one minus
the drop sells everything and forgets the peak. No lookahead.
"""
from __future__ import annotations

import math

import numpy as np

from stonks_lab import indicators as ind

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "sl_quarter"
VERSION = 1
TITLE = "Quarter on new highs"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"n": 480, "drop": 0.2}


def param_space() -> dict:
    return {
        "n": {"type": "int", "min": 8, "max": 2000, "log": True, "description": "new-high lookback in candles"},
        "drop": {"type": "float", "min": 0.05, "max": 0.6, "description": "sell everything after this drop from the peak"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(p["n"]) + 1


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    n, drop = int(p["n"]), float(p["drop"])
    close = df["close"].to_numpy(np.float64)
    hrefs = ind.prior_max(close, n)
    out = np.full(len(close), np.nan)
    units = 0
    peak = 0.0
    active = False
    band = 1.0 - drop
    mw = max_weight(spec)
    for i in range(len(close)):
        px, href = close[i], hrefs[i]
        if not (math.isfinite(px) and math.isfinite(href) and px > 0.0):
            continue
        if active and px <= peak * band:
            active = False
            units = 0
            peak = 0.0
            out[i] = 0.0
            continue
        if px > href and units < 4:
            if not active:
                active = True
                peak = px
            units += 1
            if px > peak:
                peak = px
        elif active and px > peak:
            peak = px
        out[i] = units * 0.25 * mw
    return frame(df.index, {m: out})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": (
            f"Buys {mk} a quarter at a time on each new high, and sells all of it once the close falls "
            f"{pct(p['drop'])} from the highest close since the buys started."
        ),
        "howItWorks": [
            f"A new high is a close above the highest close of the previous {bars_text(int(p['n']), iv)}. "
            "The current candle is not counted in that high.",
            "The first new high buys a quarter of the account. Each later new high buys another quarter, up to the whole account.",
            f"While that trade is open, the stop sits {pct(p['drop'])} under the highest close since it started, "
            "and that stop only moves up. A close at or under the stop sells everything. That candle does not buy back. "
            "The next buy waits for a later new high.",
        ] + risk_steps(spec),
        "whenItWins": "A long climb that keeps making new highs, so the account fills up and stays invested, then a drop large enough to sell before the rest of the fall.",
        "whenItLoses": "A run of new highs that each fail by the drop, so it buys quarters and sells them lower. A short coin with a steep fall can do this in a hurry.",
    }
