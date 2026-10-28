"""s3_fisher: all in on a Fisher rise, sell when a high reading hooks through zero."""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s3_fisher"
VERSION = 1
TITLE = "Fisher hook"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"days": 40, "height": 0.60, "reentry": -0.65}


def param_space() -> dict:
    return {
        "days": {"type": "int", "min": 10, "max": 80, "description": "days in the Fisher transform"},
        "height": {"type": "float", "min": 0.2, "max": 1.2, "description": "how high the swing must have peaked before a hook sells"},
        "reentry": {"type": "float", "min": -1.2, "max": -0.2, "description": "how low the reading must go before a turn up buys"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(p["days"]) * 2


def _bars(df, days: float) -> int:
    idx = np.asarray(df.index, np.int64)
    step = float(np.median(np.diff(idx[: min(len(idx), 300)])))
    per = max(1.0, round(DAY_MS / max(step, 1.0)))
    return max(5, int(round(float(days) * per)))


def _weights(df, days, height, re_level) -> np.ndarray:
    x = compute("fisher", df, _bars(df, days))
    w = np.zeros(len(x), dtype=np.float64)
    pos = 0.0
    prev = np.nan
    peak = -9.0
    trough = 9.0
    for i, v in enumerate(x):
        if not np.isfinite(v):
            pos = 0.0
            prev = np.nan
            peak = -9.0
            trough = 9.0
            w[i] = 0.0
            continue
        if pos >= 1.0:
            if v > peak:
                peak = v
            if np.isfinite(prev) and prev > 0.0 and v <= 0.0 and peak >= height:
                pos = 0.0
                peak = -9.0
                trough = v
        if pos < 1.0:
            if v < trough:
                trough = v
            if trough <= re_level and np.isfinite(prev) and prev <= 0.0 and v > 0.0:
                pos = 1.0
                peak = v
                trough = v
        w[i] = pos
        prev = v
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, float(p["days"]), float(p["height"]), float(p["reentry"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"All in or all out on {mk}. Sells when a {int(p['days'])}-day Fisher swing that peaked at "
            f"{p['height']} hooks down through zero, and buys again only after the reading turns up from {p['reentry']}."
        ),
        "howItWorks": [
            f"The Fisher transform uses {int(p['days'])} days of that market's own bars.",
            "The book stays flat until the reading has been at or under the re-entry level and then crosses up through zero.",
            f"Once in, a dip whose swing never reached {p['height']} is held.",
            "The sale is the hook: the swing peaked at that height and the reading then crosses down through zero.",
        ] + risk_steps(spec),
        "whenItWins": "A rise whose Fisher reading gets high and then turns through zero, which is a top starting to fall.",
        "whenItLoses": "A hook that sells a pause, and the next buy waits for a deep low that arrives after the coin has already turned.",
    }
