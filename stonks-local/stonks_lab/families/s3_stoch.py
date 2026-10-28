"""s3_stoch: all in until a Stochastic RSI top rolls over, then buy the turn up."""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names, max_weight, risk_steps, single_market
from ._ta import compute

NAME = "s3_stoch"
VERSION = 1
TITLE = "Stochastic RSI"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"lengthDays": 75, "smoothDays": 7, "high": -0.15, "fall": 0.70, "wash": -0.40, "rise": 0.40}


def param_space() -> dict:
    return {
        "lengthDays": {"type": "int", "min": 20, "max": 120, "description": "days in the Stochastic RSI"},
        "smoothDays": {"type": "int", "min": 2, "max": 20, "description": "days of smoothing"},
        "high": {"type": "float", "min": -0.5, "max": 0.5, "description": "how high a swing must have been before a fall counts"},
        "fall": {"type": "float", "min": 0.3, "max": 1.2, "description": "how far the reading must fall from that peak"},
        "wash": {"type": "float", "min": -1.2, "max": -0.1, "description": "how low the reading must go before a buy"},
        "rise": {"type": "float", "min": 0.15, "max": 0.8, "description": "how far it must turn up from that low"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["fall"]) <= 0 or float(p["rise"]) <= 0:
        return "the fall and the rise must be positive"
    return None


def warmup(p: dict) -> int:
    return int(p["lengthDays"]) + int(p["smoothDays"])


def _bars(df, days: float) -> int:
    step = float(np.median(np.diff(np.asarray(df.index, dtype=np.int64))))
    return max(8, int(round(days * DAY_MS / max(step, 1.0))))


def _smooth(x, span: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if span <= 1:
        ok = np.isfinite(x)
        out[ok] = x[ok]
        return out
    alpha = 2.0 / (span + 1.0)
    prev = np.nan
    for i, v in enumerate(x.tolist()):
        if v != v:
            out[i] = prev
            continue
        prev = v if prev != prev else alpha * v + (1.0 - alpha) * prev
        out[i] = prev
    return out


def _weights(df, p) -> np.ndarray:
    x = _smooth(compute("stochrsi", df, _bars(df, p["lengthDays"])), _bars(df, p["smoothDays"]))
    high, fall, wash, rise = float(p["high"]), float(p["fall"]), float(p["wash"]), float(p["rise"])
    w = np.zeros(len(x), dtype=np.float64)
    held = False
    started = False
    peak = -1e9
    trough = 1e9
    for i, v in enumerate(x.tolist()):
        if v != v:
            continue
        if not started:
            started = True
            held = True
            peak = trough = v
            w[i] = 1.0
            continue
        if held:
            if v >= peak:
                peak = v
            elif peak >= high and v <= peak - fall:
                held = False
                trough = v
        else:
            if v <= trough:
                trough = v
            elif trough <= wash and v >= trough + rise:
                held = True
                peak = v
        if held:
            w[i] = 1.0
    return w


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    return frame(df.index, {m: _weights(df, spec["params"]) * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"All in or all out on {mk}. Sells when a {int(p['lengthDays'])}-day Stochastic RSI that reached "
            f"{p['high']} falls {p['fall']}, and buys again after a low of {p['wash']} turns up by {p['rise']}."
        ),
        "howItWorks": [
            f"The reading is Stochastic RSI over {int(p['lengthDays'])} days, smoothed for {int(p['smoothDays'])} days. The day count is that market's own bars.",
            "The book starts all in once the reading exists.",
            f"A top is a swing that reached at least {p['high']} and then falls {p['fall']} from that peak. That sells the whole position, including a small top.",
            f"The buy waits until the reading has been down to {p['wash']} and has risen {p['rise']} from that trough.",
        ] + risk_steps(spec),
        "whenItWins": "Rises that roll over cleanly, so the sale lands as the top turns, and the next buy waits for a real turn up.",
        "whenItLoses": "A reading that falls the required distance and then the coin keeps rising, so the book is in cash for the rest of the move.",
    }
