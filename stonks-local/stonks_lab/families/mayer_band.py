"""mayer_band v1: valuation-band allocation (a "smart DCA"): hold more when the price is cheap against its long
average, less when it is stretched, optionally nothing below a crash line.

At bar i with r = close / SMA(close, sma) (the "Mayer multiple" for sma = 200 on 1d):

1. raw = richWeight + (1 - richWeight) * clip((rich - r) / (rich - cheap), 0, 1): weight 1 at r <= cheap, richWeight
   at r >= rich, linear in between.
2. If crashBelow > 0 and r < crashBelow: raw = 0 (the trend has broken; don't keep averaging into a crash).
3. Hysteresis: the held level L only moves when |raw - L| >= step; it then becomes raw rounded to a multiple of step
   (L starts at that rounding of the first raw). A crash-line exit sets L = 0 at once.

weight = maxWeight * L. Bars before SMA is defined are NaN.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "mayer_band"
VERSION = 1
TITLE = "Valuation band (Mayer multiple)"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"sma": 200, "cheap": 0.9, "rich": 2.0, "richWeight": 0.0, "crashBelow": 0.0, "step": 0.1}


def param_space() -> dict:
    return {
        "sma": {"type": "int", "min": 20, "max": 600, "log": True,
                "description": "candles in the long average the price is compared with"},
        "cheap": {"type": "float", "min": 0.5, "max": 1.3,
                  "description": "price / average at or below which it holds the full position"},
        "rich": {"type": "float", "min": 1.05, "max": 4.0, "log": True,
                 "description": "price / average at or above which it holds only richWeight"},
        "richWeight": {"type": "float", "min": 0.0, "max": 0.8,
                       "description": "part of the money still invested when the price is rich"},
        "crashBelow": {"type": "float", "min": 0.5, "max": 1.1, "zero": True,
                       "description": "sell everything while price / average is below this (0 = never)"},
        "step": {"type": "choice", "values": [0.05, 0.1, 0.2, 0.25, 0.5],
                 "description": "the position only changes when the target moves by this much (fewer trades)"},
    }


def valid_params(p: dict) -> str | None:
    if not p["cheap"] < p["rich"]:
        return "cheap must be below rich"
    cb = float(p.get("crashBelow") or 0)
    if cb > 0 and not cb < p["rich"]:
        return "crashBelow must be below rich"
    return None


def warmup(p: dict) -> int:
    return int(p["sma"]) - 1


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    s = ind.sma(c, int(p["sma"]))
    n = len(c)
    w = np.full(n, np.nan)
    first = warmup(p)
    if first < n:
        r = c[first:] / s[first:]
        cheap, rich, rw = float(p["cheap"]), float(p["rich"]), float(p["richWeight"])
        raw = rw + (1.0 - rw) * np.clip((rich - r) / (rich - cheap), 0.0, 1.0)
        cb = float(p.get("crashBelow") or 0)
        if cb > 0:
            raw = np.where(r < cb, 0.0, raw)
        step = float(p["step"])
        out = np.empty(len(raw))
        level = None
        for k, x in enumerate(raw.tolist()):
            if level is None or x == 0.0 or abs(x - level) >= step - 1e-12:
                level = min(1.0, round(x / step) * step) if x > 0 else 0.0
            out[k] = level
        w[first:] = max_weight(spec) * out
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    avg = bars_text(p["sma"], iv)
    steps = [
        f"After every {iv} candle it compares the price of {mk} with its average over {avg}.",
        f"When the price is at or below {p['cheap']:g}x that average ({mk} is cheap) it is fully invested; at "
        f"{p['rich']:g}x or more (stretched) it keeps only {pct(p['richWeight'])} invested; in between it scales "
        "linearly, so it buys as the price falls back and sells into strong rallies.",
        f"It only trades when its target moves by {pct(p['step'])} or more, which keeps the number of trades low.",
    ]
    cb = float(p.get("crashBelow") or 0)
    if cb > 0:
        steps.insert(2, f"When the price falls under {cb:g}x the average the trend has broken: it sells everything "
                        "and waits until the price is back above that line.")
    return {
        "summary": f"Holds more {mk} when it is cheap compared with its long-term average and less when it is "
                   "far above it, like a disciplined savings plan that buys low and trims high.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Cycles that overshoot and come back: it is fully in after corrections and banks gains near "
                      "blow-off tops.",
        "whenItLoses": "Long, steady bull runs far above the average (it is only partly invested) and, without the "
                       "crash line, bear markets where cheap keeps getting cheaper.",
    }
