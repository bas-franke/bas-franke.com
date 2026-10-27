"""vortex_trend v1: Vortex indicator (VI+ / VI-) trend following with a hysteresis band.

VM+ = |high[i] - low[i-1]|, VM- = |low[i] - high[i-1]|, TR = true range; VI+/- = sum(VM+/-, n) / sum(TR, n).
It buys when VI+ exceeds VI- by more than ``band`` (and the close is above the optional trend SMA) and sells when
VI- exceeds VI+ by more than ``band``.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "vortex_trend"
VERSION = 1
TITLE = "Vortex trend"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"n": 14, "band": 0.02, "trendSma": 0}


def param_space() -> dict:
    return {
        "n": {"type": "int", "min": 5, "max": 120, "log": True, "description": "vortex look-back in candles"},
        "band": {"type": "float", "min": 0.0, "max": 0.3,
                 "description": "VI+ minus VI- needed to buy (and VI- minus VI+ to sell)"},
        "trendSma": {"type": "int", "min": 10, "max": 600, "log": True, "zero": True,
                     "description": "only buy while the close is above this SMA (0 = off)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["n"]), int(p["trendSma"] or 0) - 1)


def _rolling_sum(x: np.ndarray, n: int) -> np.ndarray:
    """Sum of x[i-n+1..i]; NaN anywhere in the window gives NaN."""
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        cs = np.concatenate([[0.0], np.cumsum(x)])
        out[n - 1:] = cs[n:] - cs[:-n]
    return out


def vortex(high, low, close, n: int) -> tuple[np.ndarray, np.ndarray]:
    h, l, c = (np.asarray(a, np.float64) for a in (high, low, close))
    ph, pl, pc = ind.shift(h, 1), ind.shift(l, 1), ind.shift(c, 1)
    vmp, vmm = np.abs(h - pl), np.abs(l - ph)
    tr = np.fmax(h - l, np.fmax(np.abs(h - pc), np.abs(l - pc)))
    # bar 0 has no previous bar: sum over bars 1.. only, so the first value is at index n
    sp, sm, st = (np.concatenate([[np.nan], _rolling_sum(a[1:], n)]) for a in (vmp, vmm, tr))
    with np.errstate(invalid="ignore", divide="ignore"):
        vip = np.where(st > 0, sp / st, np.nan)
        vim = np.where(st > 0, sm / st, np.nan)
    return vip, vim


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    vip, vim = vortex(df["high"].to_numpy(np.float64), df["low"].to_numpy(np.float64), c, int(p["n"]))
    tsma = int(p["trendSma"] or 0)
    gate = ind.sma(c, tsma) if tsma else np.full(len(c), -np.inf)
    band, mw = float(p["band"]), max_weight(spec)
    w = np.full(len(c), np.nan)
    held = False
    for i in range(len(c)):
        if not np.isfinite(vip[i]) or (tsma and not np.isfinite(gate[i])):
            continue
        d = vip[i] - vim[i]
        if held and -d > band:
            held = False
        elif not held and d > band and c[i] > gate[i]:
            held = True
        w[i] = mw if held else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    gate = (f", but only while the close is above its {bars_text(int(p['trendSma']), iv)} average"
            if p.get("trendSma") else "")
    return {
        "summary": f"Follows {mk}'s trend with the Vortex indicator: it holds while upward moves dominate the "
                   "candles and sits in euros when downward moves take over.",
        "howItWorks": [
            f"After every {iv} candle it adds up, over {bars_text(int(p['n']), iv)}, how far each high reached "
            "above the previous low (upward pull) and each low below the previous high (downward pull), both "
            "relative to the total range.",
            f"It buys when the upward pull beats the downward pull by more than {p['band']:.2f}{gate}.",
            f"It sells everything when the downward pull beats the upward pull by more than {p['band']:.2f}.",
            *risk_steps(spec),
        ],
        "whenItWins": "Clean directional moves with wide candles in one direction.",
        "whenItLoses": "Choppy, overlapping candles where the two pulls keep crossing.",
    }
