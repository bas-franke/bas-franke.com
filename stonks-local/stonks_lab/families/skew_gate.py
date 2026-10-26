"""skew_gate v1 (agent-02): hold BTC/ETH by default, step aside while recent daily returns are strongly
right-skewed (a lottery-like rally of a few huge up days), optionally combined with an MA core.

Unrecorded study (1d pre-holdout 2019-25, fwd 30d rank IC by year): 90-day return skewness was negative in 5/7 years
on BTC and 6/7 on ETH; the most negatively skewed quintile had the best forward month (BTC +9 %, highest quintile 0 %).

- sk_t = sample skewness of the last skewLen log returns (up to and including bar t).
- gate: in while sk_t < exitSkew; after leaving, back in once sk_t < enterSkew (enterSkew <= exitSkew: hysteresis).
- combine: "none" = gate only; "and" = gate AND close > SMA(coreLen); "or" = gate OR close > SMA(coreLen).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "skew_gate"
VERSION = 1
TITLE = "Hold, step aside while returns are lottery-skewed"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"skewLen": 90, "exitSkew": 1.0, "enterSkew": 0.5, "combine": "none", "coreLen": 130}


def param_space() -> dict:
    return {
        "skewLen": {"type": "int", "min": 15, "max": 400, "log": True,
                    "description": "candles of log returns the skewness is measured over"},
        "exitSkew": {"type": "float", "min": -0.5, "max": 3.0,
                     "description": "step aside when the skewness rises above this"},
        "enterSkew": {"type": "float", "min": -1.5, "max": 3.0,
                      "description": "buy back once the skewness falls below this (<= exitSkew)"},
        "combine": {"type": "choice", "values": ["none", "and", "or"],
                    "description": "none = skew gate only; and/or = combined with close above SMA(coreLen)"},
        "coreLen": {"type": "int", "min": 10, "max": 400, "log": True,
                    "description": "SMA length of the optional trend core"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["enterSkew"]) > float(p["exitSkew"]):
        return "enterSkew must be <= exitSkew"
    return None


def warmup(p: dict) -> int:
    return max(int(p["skewLen"]) + 1, int(p["coreLen"]) if p["combine"] != "none" else 0)


def rolling_skew(close: np.ndarray, n: int) -> np.ndarray:
    r = pd.Series(np.log(np.asarray(close, dtype=np.float64))).diff()
    return r.rolling(n, min_periods=n).skew().to_numpy(np.float64)


def gate_weights(sk: np.ndarray, exit_s: float, enter_s: float) -> np.ndarray:
    out = np.full(len(sk), np.nan)
    held = None
    for i, s in enumerate(sk):
        if not np.isfinite(s):
            continue
        if held is None:
            held = s < exit_s
        elif held and s >= exit_s:
            held = False
        elif not held and s < enter_s:
            held = True
        out[i] = 1.0 if held else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    g = gate_weights(rolling_skew(c, int(p["skewLen"])), float(p["exitSkew"]), float(p["enterSkew"]))
    if p["combine"] != "none":
        sm = ind.sma(c, int(p["coreLen"]))
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
        ok = np.isfinite(g) & np.isfinite(core)
        on = np.minimum(g, core) if p["combine"] == "and" else np.maximum(g, core)
        g = np.where(ok, on, np.nan)
    return frame(df.index, {m: g * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    steps = [f"It measures how lopsided the price moves of the last {bars_text(p['skewLen'], iv)} were: a few huge "
             f"up days among many small ones is 'right-skewed', like a lottery ticket.",
             f"It holds {mk} by default and steps aside when that skewness rises above {p['exitSkew']:.2f}; it buys "
             f"back once it falls below {p['enterSkew']:.2f}."]
    if p["combine"] == "and":
        steps.append(f"It also holds only while the price is above its average over {bars_text(p['coreLen'], iv)}.")
    elif p["combine"] == "or":
        steps.append(f"While the price is above its average over {bars_text(p['coreLen'], iv)} it holds anyway.")
    return {
        "summary": f"Holds {mk}, but steps aside while the rally is driven by a few spiky up days.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Spiky, euphoric rallies that give back their gains: it is out before the fall.",
        "whenItLoses": "Bull markets that keep going with big up days: it sits out the best part.",
    }
