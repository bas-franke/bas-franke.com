"""trend_trail v1: long only above an SMA. Sell a drop from the peak, buy back after a bounce, still above the average.

The first bar on which the average exists has no saved low, so a close already above the average buys immediately.
Every later re-entry needs a rise of ``rise`` off the low, and the close still has to be above the average.
A close under the average sells at once, even if the drop from the peak is smaller than ``drop``.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "trend_trail"
VERSION = 1
TITLE = "Trend trail"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"smaLen": 480, "drop": 0.12, "rise": 0.025}


def param_space() -> dict:
    return {
        "smaLen": {"type": "int", "min": 24, "max": 2400, "log": True,
                   "description": "hold only while the close is above this SMA, in candles"},
        "drop": {"type": "float", "min": 0.03, "max": 0.30,
                 "description": "sell when the close falls this far under the peak since buying"},
        "rise": {"type": "float", "min": 0.005, "max": 0.08,
                 "description": "buy back after the close rises this far off the low, still above the SMA"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["rise"]) < float(p["drop"]) else "rise must be smaller than drop"


def warmup(p: dict) -> int:
    return int(p["smaLen"])


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    length = int(p["smaLen"])
    drop, rise = float(p["drop"]), float(p["rise"])
    sma = ind.sma(c, length)
    n = len(c)
    w = np.full(n, np.nan)
    state, peak, trough = 0.0, 0.0, 0.0
    mw = max_weight(spec)
    # The average at index length-1 is the first finite one. The loop starts one bar later, matching the search.
    for i in range(length, n):
        price, avg = float(c[i]), float(sma[i])
        if not (np.isfinite(price) and np.isfinite(avg)):
            continue
        if price < avg:
            state = 0.0
            trough = price
        elif state < 0.5:
            if price < trough:
                trough = price
            # A trough of 0 means no low has been saved yet, so the first close above the average buys.
            if price >= trough * (1.0 + rise):
                state, peak = 1.0, price
        else:
            if price > peak:
                peak = price
            if price <= peak * (1.0 - drop):
                state, trough = 0.0, price
        w[i] = mw if state >= 0.5 else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": (
            f"Holds {mk} while it is above its average, sells a {pct(p['drop'])} drop from the peak, "
            f"and buys back after a {pct(p['rise'])} bounce."
        ),
        "howItWorks": [
            f"After every {iv} candle it compares the close with the average of the last {bars_text(int(p['smaLen']), iv)}.",
            f"A close under that average sells the whole position. Nothing is bought while the close stays under it.",
            (
                f"While the close is above the average, a fall of {pct(p['drop'])} from the highest close since the buy "
                "also sells everything."
            ),
            (
                f"After a sale, it buys back only when the close has risen {pct(p['rise'])} from the low "
                "and is still above the average."
            ),
            *risk_steps(spec),
        ],
        "whenItWins": "Long rises with shallow dips, and long declines it can sit out in euros.",
        "whenItLoses": "A drop just past the trail that immediately recovers: it sells the low and buys back higher.",
    }
