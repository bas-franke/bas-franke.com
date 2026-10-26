"""core_trend v1 (agent-04, invent lane): a permanent core position plus a trend-timed satellite.

Why: eval v2 scores the MEAN log excess over buy and hold across the folds (minus the best one) and half the median
drawdown. Pure trend filters sit in cash when a bull fold starts and lose 50-150 log-pct to buy and hold there
(findings #119, #43, #78), which the mean no longer forgives. Holding a fixed core share all the time caps that miss;
the trend signal decides only the rest. In a bear market only the core is exposed, so the drawdown shrinks to roughly
core x the coin's drawdown.

Per market (each market in spec.markets gets an equal slot of maxWeight), decided at each bar's close:

- trend signal, one of
  - ``sma`` / ``ema``: on while close > MA(length) * (1 + band), off once close < MA(length) * (1 - band)
    (band = 0: plain above/below);
  - ``macd``: MACD with slow = length, fast = max(2, round(length / 15)), signal = max(2, round(length / 5)) (the
    proportions of the lab's best daily ETH MACD, 12/182/35); on while (line - signal) / close > band, off once it
    is < -band.
- core: ``core`` share of the slot is held always, optionally only while the close is above SMA(coreSma) (a slow
  "deep bear" switch; 0 = always).
- weight = slot * (core_on * core + signal_on * (1 - core)).

core = 0 is a plain trend filter (with the MA/MACD rules above), core = 1 would be buy and hold (not allowed: max 0.8).
Missing bars carry the previous close; markets without history yet get weight 0 (NaN before the first warm bar).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import (aligned_close, bars_text, frame, market_names, max_weight, pct, risk_steps, union_index)

NAME = "core_trend"
VERSION = 1
TITLE = "Core position plus trend satellite"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"core": 0.5, "signal": "sma", "length": 100, "band": 0.0, "coreSma": 0}


def param_space() -> dict:
    return {
        "core": {"type": "float", "min": 0.1, "max": 0.8,
                 "description": "share of each market's slot that is always held (the rest follows the trend)"},
        "signal": {"type": "choice", "values": ["sma", "ema", "macd"],
                   "description": "trend signal for the satellite: price vs SMA/EMA, or a slow MACD"},
        "length": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "candles in the moving average (sma/ema) or the MACD slow EMA (macd)"},
        "band": {"type": "float", "min": 0.002, "max": 0.1, "log": True, "zero": True,
                 "description": "hysteresis: sma/ema fraction around the average, macd histogram as a fraction of "
                                "the price (0 = off)"},
        "coreSma": {"type": "int", "min": 50, "max": 1000, "log": True, "zero": True,
                    "description": "only hold the core while the close is above this SMA (0 = always hold it)"},
    }


def valid_params(p: dict) -> str | None:
    if p["signal"] == "macd" and float(p["band"] or 0) > 0.03:
        return "macd band is a histogram/price fraction; keep it <= 0.03"
    return None


def _macd_lengths(n: int) -> tuple[int, int, int]:
    return max(2, int(round(n / 15))), n, max(2, int(round(n / 5)))


def warmup(p: dict) -> int:
    n = int(p["length"])
    w = n * 2 if p["signal"] == "macd" else n
    return max(w, int(p["coreSma"] or 0))


def _signal(c: np.ndarray, p: dict) -> np.ndarray:
    """1.0 on / 0.0 off / NaN undefined, with hysteresis; c may start with NaN (not listed yet)."""
    n = len(c)
    out = np.full(n, np.nan)
    ok = np.isfinite(c)
    if not ok.any():
        return out
    s0 = int(np.argmax(ok))
    x = c[s0:]
    L = int(p["length"])
    band = float(p["band"] or 0.0)
    if p["signal"] == "macd":
        f, sl, sg = _macd_lengths(L)
        line = np.asarray(ind.ema(x, f), dtype=np.float64) - np.asarray(ind.ema(x, sl), dtype=np.float64)
        sig = np.asarray(ind.ema(line, sg), dtype=np.float64)
        val = (line - sig) / x
        val[: min(len(val), sl + sg)] = np.nan  # let the slow EMAs settle
        up_th, dn_th = band, -band
    else:
        if p["signal"] == "ema":
            ma = np.asarray(ind.ema(x, L), dtype=np.float64).copy()
            ma[: min(L - 1, len(ma))] = np.nan
        else:
            ma = np.asarray(ind.sma(x, L), dtype=np.float64)
        val = x / ma - 1.0
        up_th, dn_th = band, -band
    held = False
    for i in range(len(x)):
        v = val[i]
        if not np.isfinite(v):
            continue
        if held:
            if v < dn_th or (band == 0 and v <= 0):
                held = False
        elif v > up_th:
            held = True
        out[s0 + i] = 1.0 if held else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    slot = max_weight(spec) / len(markets)
    core = float(p["core"])
    cs = int(p["coreSma"] or 0)
    cols = {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        sig = _signal(c, p)
        if cs:
            ok = np.isfinite(c)
            core_on = np.full(len(c), np.nan)
            if ok.any():
                s0 = int(np.argmax(ok))
                ma = np.asarray(ind.sma(c[s0:], cs), dtype=np.float64)
                core_on[s0:] = np.where(np.isfinite(ma), (c[s0:] > ma).astype(np.float64), np.nan)
        else:
            core_on = np.where(np.isfinite(c), 1.0, np.nan)
        w = slot * (core_on * core + sig * (1.0 - core))
        cols[m] = w
    W = np.column_stack([cols[m] for m in markets])
    # a market not yet listed / not warm holds nothing, but only once some market has a decision
    any_dec = np.isfinite(W).any(axis=1)
    W = np.where(np.isnan(W) & any_dec[:, None], 0.0, W)
    return frame(idx, {m: W[:, k] for k, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    core, L, band, cs = float(p["core"]), int(p["length"]), float(p["band"] or 0), int(p["coreSma"] or 0)
    if p["signal"] == "macd":
        f, sl, sg = _macd_lengths(L)
        sig_txt = (f"a slow MACD (fast {bars_text(f, iv)}, slow {bars_text(sl, iv)}, signal {bars_text(sg, iv)}) "
                   "is above its signal line" + (f" by more than {pct(band)} of the price" if band else ""))
    else:
        kind = "simple" if p["signal"] == "sma" else "exponential"
        sig_txt = (f"the close is above its {kind} moving average over {bars_text(L, iv)}"
                   + (f" by more than {pct(band)} (it only sells again {pct(band)} below it)" if band else ""))
    steps = [
        f"It always keeps {pct(core)} of the money for {mk} invested: the core"
        + (f", except while the price is below its {bars_text(cs, iv)} average (a deep bear market)." if cs else "."),
        f"The other {pct(1 - core)} is only invested while {sig_txt}; otherwise that part waits in euros.",
        "So in a rising market it is (almost) fully invested, and in a falling market only the core is at risk.",
    ]
    if len(spec.get("markets") or []) > 1:
        steps.append("Each coin gets an equal share of the money and is handled on its own.")
    return {
        "summary": f"Part buy-and-hold, part trend following on {mk}: a fixed core is always held, the rest only "
                   "while the trend is up.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bear markets (only the core falls) and bull markets that start suddenly (the core is "
                      "already in).",
        "whenItLoses": "Choppy sideways markets, where the satellite buys high and sells low, and strong bull runs, "
                       "where any time out of the market costs return.",
    }
