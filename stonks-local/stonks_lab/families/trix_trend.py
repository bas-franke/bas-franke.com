"""trix_trend v1: TRIX (rate of change of a triple-smoothed EMA) trend following.

E3 = EMA(EMA(EMA(close, n), n), n); TRIX = 100 * (E3[i] / E3[i-1] - 1); signal = EMA(TRIX, signal).
mode "zero": long while TRIX > 0; mode "signal": long while TRIX > signal; mode "both": long while both hold.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "trix_trend"
VERSION = 1
TITLE = "TRIX trend"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"n": 15, "signal": 9, "mode": "signal"}


def param_space() -> dict:
    return {
        "n": {"type": "int", "min": 3, "max": 120, "log": True, "description": "EMA length (applied three times)"},
        "signal": {"type": "int", "min": 2, "max": 60, "log": True, "description": "signal EMA of the TRIX line"},
        "mode": {"type": "choice", "values": ["zero", "signal", "both"],
                 "description": "long while TRIX > 0, TRIX > signal, or both"},
    }


def warmup(p: dict) -> int:
    return 3 * (int(p["n"]) - 1) + 1 + int(p["signal"]) - 1


def trix(close, n: int, signal: int) -> tuple[np.ndarray, np.ndarray]:
    e3 = ind.ema(ind.ema(ind.ema(close, n), n), n)
    with np.errstate(invalid="ignore", divide="ignore"):
        t = 100.0 * (e3 / ind.shift(e3, 1) - 1.0)
    return t, ind.ema(t, signal)


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    t, s = trix(df["close"].to_numpy(np.float64), int(p["n"]), int(p["signal"]))
    mode = p["mode"]
    if mode == "zero":
        on, ok = t > 0, np.isfinite(t)
    elif mode == "signal":
        on, ok = t > s, np.isfinite(t) & np.isfinite(s)
    else:
        on, ok = (t > 0) & (t > s), np.isfinite(t) & np.isfinite(s)
    w = np.where(on, max_weight(spec), 0.0)
    w[~ok] = np.nan
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    rule = {"zero": "the TRIX line is above zero (the smoothed price is rising)",
            "signal": f"the TRIX line is above its own {bars_text(int(p['signal']), iv)} average (momentum is "
                      "picking up)",
            "both": "the TRIX line is above zero and above its own average"}[p["mode"]]
    return {
        "summary": f"Holds {mk} while a heavily smoothed price trend is pointing up and sits in euros otherwise.",
        "howItWorks": [
            f"After every {iv} candle it smooths the closing price three times with a "
            f"{bars_text(int(p['n']), iv)} exponential average, which filters out most noise.",
            "TRIX is the percentage change of that smoothed price from one candle to the next.",
            f"It holds {mk} while {rule}, and sells everything when that stops being true.",
            *risk_steps(spec),
        ],
        "whenItWins": "Long trends: the triple smoothing ignores small pullbacks and keeps it invested.",
        "whenItLoses": "Sharp reversals: the smoothing reacts late and gives back part of the gain.",
    }
