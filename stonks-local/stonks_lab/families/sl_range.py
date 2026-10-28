"""sl_range v1: buy half when price is high in its range, the other half when that range is also quiet.

Up means the close is at least upFrac of the way from the n-bar low to the n-bar high.
Stable means that range width divided by the close is below its own median.
The stop is the highest n-bar low since entry, and it only rises. No lookahead.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "sl_range"
VERSION = 1
TITLE = "High in a quiet range"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"n": 480, "upFrac": 0.7, "stableBars": 200}


def param_space() -> dict:
    return {
        "n": {"type": "int", "min": 8, "max": 2000, "log": True, "description": "range length in candles"},
        "upFrac": {"type": "float", "min": 0.5, "max": 0.95, "description": "close must be at least this far up the range"},
        "stableBars": {"type": "int", "min": 5, "max": 1000, "log": True, "description": "median length for a quiet range"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(p["n"]) + int(p["stableBars"])


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    n = int(p["n"])
    up_frac = float(p["upFrac"])
    stable_bars = int(p["stableBars"])
    high = df["high"].to_numpy(np.float64)
    low = df["low"].to_numpy(np.float64)
    close = df["close"].to_numpy(np.float64)
    length = close.shape[0]
    out = np.full(length, np.nan)
    if length == 0 or n < 1 or stable_bars < 1:
        return frame(df.index, {m: out})
    hh = pd.Series(high).rolling(n, min_periods=n).max().to_numpy()
    ll = pd.Series(low).rolling(n, min_periods=n).min().to_numpy()
    width = hh - ll
    rng_pct = np.full(length, np.nan)
    pos = np.isfinite(close) & (close > 0) & np.isfinite(width)
    rng_pct[pos] = width[pos] / close[pos]
    med = pd.Series(rng_pct).rolling(stable_bars, min_periods=stable_bars).median().to_numpy()
    in_trade = False
    full = False
    stop = 0.0
    mw = max_weight(spec)
    half = 0.5 * mw
    whole = mw
    for i in range(length):
        c = close[i]
        lo = ll[i]
        hi = hh[i]
        md = med[i]
        if not (np.isfinite(c) and c > 0.0 and np.isfinite(lo) and np.isfinite(hi) and np.isfinite(md)):
            continue
        span = hi - lo
        up = span > 0.0 and c >= lo + up_frac * span
        rp = rng_pct[i]
        stable = np.isfinite(rp) and rp < md
        if in_trade:
            if lo > stop:
                stop = float(lo)
            if c <= stop:
                out[i] = 0.0
                in_trade = False
                full = False
            elif (not full) and up and stable:
                out[i] = whole
                full = True
            else:
                out[i] = whole if full else half
        elif up:
            out[i] = half
            in_trade = True
            full = False
            stop = float(lo)
        else:
            out[i] = 0.0
    return frame(df.index, {m: out})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": (
            f"Buys half of {mk} when the close is high in its recent range, and the other half only later, "
            "when that range has also gone quiet. The stop is the highest recent low, and it only rises."
        ),
        "howItWorks": [
            f"Look at the last {bars_text(int(p['n']), iv)}. Up means the close is at least {pct(p['upFrac'])} of the way "
            "from that window's lowest low to its highest high.",
            f"Quiet means the width of that range, divided by the close, is below its own median over "
            f"{bars_text(int(p['stableBars']), iv)}. From flat, an up candle buys half. The other half is bought only on a later candle that is still up and also quiet.",
            "The stop is the highest of those window lows since the entry, and it only moves up. A close at or under it sells everything. The next entry starts again at half.",
        ] + risk_steps(spec),
        "whenItWins": "A market that spends time near the top of its range and then tightens, so the second half is bought into a calmer climb, with the rising lows underneath.",
        "whenItLoses": "A high close that is still inside a wide, falling range, so the stop is hit before the quiet add ever happens.",
    }
