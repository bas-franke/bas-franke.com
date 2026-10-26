"""ma_band v1 (agent-17, long lane): long moving-average trend filter with a fee-aware hysteresis band.

Hold the market while it trades above a long moving average, but only switch when the close clears the average by
a band: buy when close > MA * (1 + enterBand), sell when close < MA * (1 - exitBand). The band stops the filter from
flipping in and out (and paying fees) while the price chops around the average. Optional slope gate: only buy while
the average itself is higher than ``slopeBars`` candles ago. Decisions at bar t use closes up to and including bar t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "ma_band"
VERSION = 1
TITLE = "Moving-average band trend filter"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"maType": "sma", "length": 150, "enterBand": 0.03, "exitBand": 0.03, "slopeBars": 0}


def param_space() -> dict:
    return {
        "maType": {"type": "choice", "values": ["sma", "ema"], "description": "kind of moving average"},
        "length": {"type": "int", "min": 10, "max": 600, "log": True,
                   "description": "candles in the moving average"},
        "enterBand": {"type": "float", "min": 0.005, "max": 0.2, "log": True, "zero": True,
                      "description": "buy when the close is this fraction above the average"},
        "exitBand": {"type": "float", "min": 0.005, "max": 0.3, "log": True, "zero": True,
                     "description": "sell when the close is this fraction below the average"},
        "slopeBars": {"type": "int", "min": 2, "max": 200, "log": True, "zero": True,
                      "description": "only buy while the average is higher than this many candles ago (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["slopeBars"]) >= int(p["length"]) * 2:
        return "slopeBars should be shorter than twice the average"
    return None


def warmup(p: dict) -> int:
    return int(p["length"]) + int(p["slopeBars"])


def _ma(c: np.ndarray, p: dict) -> np.ndarray:
    n = int(p["length"])
    if p["maType"] == "ema":
        m = ind.ema(c, n)
        m = np.asarray(m, dtype=np.float64).copy()
        m[: min(n - 1, len(m))] = np.nan  # let the EMA settle for one length before it counts
        return m
    return ind.sma(c, n)


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    ma = _ma(c, p)
    up = 1.0 + float(p["enterBand"] or 0.0)
    dn = 1.0 - float(p["exitBand"] or 0.0)
    sb = int(p["slopeBars"] or 0)
    slope_ok = np.ones(n, dtype=bool)
    defined = np.isfinite(ma)
    if sb:
        prev = np.full(n, np.nan)
        prev[sb:] = ma[:-sb]
        slope_ok = np.nan_to_num(ma - prev, nan=-1.0) > 0
        defined = defined & np.isfinite(prev)
    w = np.full(n, np.nan)
    mw = max_weight(spec)
    held = False
    for i in range(n):
        if not defined[i]:
            continue
        if held:
            if c[i] < ma[i] * dn:
                held = False
        elif c[i] > ma[i] * up and slope_ok[i]:
            held = True
        w[i] = mw if held else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    kind = "simple" if p["maType"] == "sma" else "exponential"
    eb, xb, sb = float(p["enterBand"] or 0), float(p["exitBand"] or 0), int(p["slopeBars"] or 0)
    steps = [
        f"After every {iv} candle it compares {mk}'s close with its {kind} moving average over "
        f"{bars_text(int(p['length']), iv)}.",
        f"It buys once the close is more than {pct(eb)} above that average"
        + (f" and the average is higher than {bars_text(sb, iv)} ago." if sb else "."),
        f"It sells everything once the close falls more than {pct(xb)} below the average, and then waits in euros.",
        "The gap between the buy and sell lines keeps it from trading back and forth while the price hovers around "
        "the average.",
    ]
    return {
        "summary": f"A slow trend filter on {mk}: in while the price is clearly above its long average, in euros "
                   "while it is clearly below.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bear markets, which it mostly sits out, and long bull runs, which it mostly holds.",
        "whenItLoses": "Sharp V-shaped recoveries (it buys back late and higher) and long sideways ranges around "
                       "the average.",
    }
