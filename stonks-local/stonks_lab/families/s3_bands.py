"""s3_bands: all in above the middle of a Bollinger band, sell the fall back through it."""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s3_bands"
VERSION = 1
TITLE = "Bollinger fail"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"hours": 1080, "top": 0.8, "reclaim": 0.7}


def param_space() -> dict:
    return {
        "hours": {"type": "int", "min": 168, "max": 2160, "description": "hours in the band"},
        "top": {"type": "float", "min": 0.4, "max": 1.2, "description": "how far toward the upper band a push must get before a fall sells"},
        "reclaim": {"type": "float", "min": 0.2, "max": 1.2, "description": "how far below the middle the reading must go before a buy"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return max(2, int(p["hours"]) // 24)


def _bars(df, hours: int) -> int:
    ts = np.asarray(df.index, dtype=np.int64)
    if len(ts) < 2:
        return max(2, int(hours))
    step = float(np.median(np.diff(ts)))
    if step <= 0:
        step = 3_600_000.0
    return max(2, int(round(float(hours) * 3_600_000.0 / step)))


def _position(reading, top, reclaim) -> np.ndarray:
    w = np.zeros(len(reading), dtype=np.float64)
    held = False
    armed = False
    dipped = True
    prev = np.nan
    for i, value in enumerate(reading):
        if value != value:
            prev = value
            continue
        if not held:
            if value <= -reclaim:
                dipped = True
            reclaiming = value > 0.0 and (prev != prev or prev <= 0.0)
            if dipped and reclaiming:
                held = True
                armed = value >= top
                dipped = False
        else:
            if value >= top:
                armed = True
            if armed and value <= 0.0 and (prev != prev or prev > 0.0):
                held = False
                armed = False
                dipped = value <= -reclaim
        if held:
            w[i] = 1.0
        prev = value
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    reading = compute("bbands", df, _bars(df, int(p["hours"])))
    w = _position(reading, float(p["top"]), float(p["reclaim"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"All in on {mk} above the middle of a {int(p['hours'])}-hour Bollinger band. "
            f"Sells when a push that reached {p['top']} of the way to the upper band falls back through the middle."
        ),
        "howItWorks": [
            "Zero is the middle of the band and one is the upper band. The length is hours of that market's own bars.",
            f"A push that gets to {p['top']} arms the sale. A dip that never got that far is held.",
            "The sale is the close back through the middle.",
            f"The next buy waits until the reading has been {p['reclaim']} below the middle and then closes back above it.",
        ] + risk_steps(spec),
        "whenItWins": "A push toward the top of the band that fails and falls back through the middle, including a push that never closed outside the band.",
        "whenItLoses": "A fall through the middle that was a pause, so the book is flat for the rest of a rise it had already armed.",
    }
