"""s3_rsi: all in on RSI, sell when a high reading rolls over, buy the turn up."""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s3_rsi"
VERSION = 1
TITLE = "RSI rollover"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"length": 168, "arm": 0.35, "giveback": 0.55, "rebound": 0.60}


def param_space() -> dict:
    return {
        "length": {"type": "int", "min": 14, "max": 400, "description": "bars in the RSI"},
        "arm": {"type": "float", "min": 0.1, "max": 1.0, "description": "how high the reading must have been before a fall counts"},
        "giveback": {"type": "float", "min": 0.2, "max": 1.2, "description": "how far it must fall from that peak"},
        "rebound": {"type": "float", "min": 0.15, "max": 1.0, "description": "how far it must turn up from the trough"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(p["length"])


def _weights(df, n, arm, giveback, rebound) -> np.ndarray:
    x = compute("rsi", df, int(n))
    w = np.zeros(len(x), dtype=np.float64)
    state = 0.0
    started = False
    peak = -1e9
    trough = 1e9
    for i, v in enumerate(x.tolist()):
        if v != v:
            w[i] = 0.0 if not started else state
            continue
        if not started:
            started = True
            peak = trough = v
            state = 1.0 if v > 0.0 else 0.0
            w[i] = state
            continue
        if state >= 1.0:
            if v > peak:
                peak = v
            if peak >= arm and v <= peak - giveback:
                state = 0.0
                trough = v
                peak = v
        else:
            if v < trough:
                trough = v
            if v >= trough + rebound:
                state = 1.0
                peak = v
                trough = v
        w[i] = state
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, p["length"], float(p["arm"]), float(p["giveback"]), float(p["rebound"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"All in or all out on {mk}. Sells when a {int(p['length'])}-bar RSI that reached {p['arm']} "
            f"falls {p['giveback']}, and buys again when the reading turns up {p['rebound']} from the trough."
        ),
        "howItWorks": [
            f"The RSI length is {int(p['length'])} bars of that market, so an hourly coin and a daily coin do not share the same number of days.",
            "Once the reading exists, the book is all in while it is positive.",
            f"A top is a peak at or above {p['arm']} that then falls by {p['giveback']}. That sells the whole position.",
            f"The book stays in cash until the reading rises {p['rebound']} from the trough after the sale.",
        ] + risk_steps(spec),
        "whenItWins": "A top whose RSI rolls over by the required distance, so the sale is the turn and not a one-bar twitch.",
        "whenItLoses": "A rollover that sells a pause inside a larger rise, and the buy waits for a turn that comes late.",
    }
