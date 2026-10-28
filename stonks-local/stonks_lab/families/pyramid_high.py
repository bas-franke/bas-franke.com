"""pyramid_high v1: add a quarter of the account on each new high, and sell all of it after a drop from the peak.

A new high is a close above the highest close of the previous n bars. The current bar is not part of
that high. The peak is the highest close since this pyramid opened. No lookahead.
"""
from __future__ import annotations

import math

import numpy as np

from stonks_lab import indicators as ind

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "pyramid_high"
VERSION = 1
TITLE = "Pyramid into highs"
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
    hi = ind.prior_max(close, n)
    w = np.full(len(close), np.nan)
    units = 0
    active = False
    peak = 0.0
    prev_high = False
    band = 1.0 - drop
    mw = max_weight(spec)
    for i in range(len(close)):
        px, href = close[i], hi[i]
        if not (math.isfinite(px) and math.isfinite(href)):
            prev_high = False
            continue
        is_high = px > href
        if active and px <= peak * band:
            active = False
            units = 0
            peak = 0.0
        elif active and px > peak:
            peak = px
        if is_high and units < 4:
            if not active:
                active = True
                peak = px
            units += 1
            if px > peak:
                peak = px
        w[i] = units * 0.25 * mw
        prev_high = is_high
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": f"Adds to {mk} on each new high, a quarter of the account at a time, and sells all of it after a drop.",
        "howItWorks": [
            f"A new high is a close above the highest close of the previous {bars_text(int(p['n']), iv)}. "
            "The current hour is not counted in that high.",
            "Each new high buys another quarter of the account, up to the whole account. "
            "The peak is the highest close since this run of buys started.",
            f"A close {pct(p['drop'])} under that peak sells everything. The next new high starts again at a quarter.",
        ] + risk_steps(spec),
        "whenItWins": "A climb that keeps making new highs, so the account fills up and stays invested, and a drop large enough to sell before the rest of the fall.",
        "whenItLoses": "A series of new highs that each fail by the drop amount, so it buys quarters and sells them lower.",
    }
