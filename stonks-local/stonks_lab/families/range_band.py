"""range_band v1: long in the top of the recent high-low range, flat in the bottom.

Bar i uses the high and low of bars i-n+1..i, including i. Between the two lines the previous
position is kept. No lookahead.
"""
from __future__ import annotations

import numpy as np

from stonks_lab import indicators as ind

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "range_band"
VERSION = 1
TITLE = "Range location"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"n": 480, "hi": 0.8, "lo": 0.4}


def param_space() -> dict:
    return {
        "n": {"type": "int", "min": 8, "max": 2000, "log": True, "description": "range length in candles"},
        "hi": {"type": "float", "min": 0.5, "max": 0.95, "description": "buy at or above this fraction of the range"},
        "lo": {"type": "float", "min": 0.05, "max": 0.5, "description": "sell at or below this fraction of the range"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["lo"]) >= float(p["hi"]):
        return "lo must be below hi"
    return None


def warmup(p: dict) -> int:
    return int(p["n"])


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    n, hi, lo = int(p["n"]), float(p["hi"]), float(p["lo"])
    high = df["high"].to_numpy(np.float64)
    low = df["low"].to_numpy(np.float64)
    close = df["close"].to_numpy(np.float64)
    rmin, rmax = ind.rolling_min(low, n), ind.rolling_max(high, n)
    span = rmax - rmin
    pos = np.full(len(close), np.nan)
    ok = np.isfinite(span) & (span > 0.0) & np.isfinite(close) & np.isfinite(rmin)
    pos[ok] = (close[ok] - rmin[ok]) / span[ok]
    w = np.full(len(close), np.nan)
    state = 0.0
    mw = max_weight(spec)
    if n - 1 < len(close):
        for i in range(n - 1, len(close)):
            v = pos[i]
            if v == v:
                if v >= hi:
                    state = 1.0
                elif v <= lo:
                    state = 0.0
            w[i] = mw if state >= 0.5 else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": f"Holds {mk} while price sits in the top of its recent range, and sits in euros in the bottom.",
        "howItWorks": [
            f"After every {iv} candle it looks at the last {bars_text(int(p['n']), iv)} and asks where the close sits "
            "between that window's lowest low and highest high.",
            f"It buys the whole account at or above {pct(p['hi'])} of the way up that range, and sells everything "
            f"at or below {pct(p['lo'])}. Between those two lines it keeps whatever it already holds.",
        ] + risk_steps(spec),
        "whenItWins": "A trend that keeps closing near its own recent highs, and a decline that keeps closing near its lows.",
        "whenItLoses": "A dip that falls through the bottom of the range and then recovers before price is back near the highs.",
    }
