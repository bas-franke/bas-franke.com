"""aroon_trend v1: Aroon up/down trend entries with hysteresis and an optional SMA trend gate.

Aroon up = 100 * (n - bars since the highest high of the last n+1 bars) / n, Aroon down the same for the lowest low
(ties count as the most recent bar). It buys when Aroon up is at least ``enterUp`` and leads Aroon down by at least
``spread``; it sells when Aroon down leads Aroon up by at least ``exitSpread``; in between it keeps what it has.
"""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as _windows

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "aroon_trend"
VERSION = 1
TITLE = "Aroon trend"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"n": 25, "enterUp": 70.0, "spread": 30.0, "exitSpread": 20.0, "trendSma": 0}


def param_space() -> dict:
    return {
        "n": {"type": "int", "min": 5, "max": 200, "log": True, "description": "Aroon look-back in candles"},
        "enterUp": {"type": "float", "min": 50.0, "max": 100.0, "description": "minimum Aroon up to buy"},
        "spread": {"type": "float", "min": 0.0, "max": 100.0, "description": "Aroon up minus down needed to buy"},
        "exitSpread": {"type": "float", "min": 0.0, "max": 100.0,
                       "description": "Aroon down minus up that triggers a sell"},
        "trendSma": {"type": "int", "min": 10, "max": 600, "log": True, "zero": True,
                     "description": "only buy while the close is above this SMA (0 = off)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["n"]), int(p["trendSma"] or 0) - 1)


def aroon(high, low, n: int) -> tuple[np.ndarray, np.ndarray]:
    """(up, down) in 0..100; NaN for the first n bars."""
    h, l = np.asarray(high, np.float64), np.asarray(low, np.float64)
    up, dn = np.full(len(h), np.nan), np.full(len(h), np.nan)
    if len(h) <= n:
        return up, dn
    wh, wl = _windows(h, n + 1), _windows(l, n + 1)
    since_hi = np.argmax(wh[:, ::-1], axis=1)  # argmax of the reversed window = most recent extreme
    since_lo = np.argmin(wl[:, ::-1], axis=1)
    up[n:] = 100.0 * (n - since_hi) / n
    dn[n:] = 100.0 * (n - since_lo) / n
    return up, dn


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    up, dn = aroon(df["high"].to_numpy(np.float64), df["low"].to_numpy(np.float64), int(p["n"]))
    tsma = int(p["trendSma"] or 0)
    gate = ind.sma(c, tsma) if tsma else np.full(len(c), -np.inf)
    mw = max_weight(spec)
    w = np.full(len(c), np.nan)
    held = False
    for i in range(len(c)):
        if not np.isfinite(up[i]) or (tsma and not np.isfinite(gate[i])):
            continue
        if held and dn[i] - up[i] >= p["exitSpread"]:
            held = False
        elif not held and up[i] >= p["enterUp"] and up[i] - dn[i] >= p["spread"] and c[i] > gate[i]:
            held = True
        w[i] = mw if held else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    gate = (f" and only while the close is above its {bars_text(int(p['trendSma']), iv)} average"
            if p.get("trendSma") else "")
    return {
        "summary": f"Buys {mk} when it keeps making fresh highs (Aroon up strong) and sells when fresh lows take over.",
        "howItWorks": [
            f"After every {iv} candle it checks how recently the highest high and the lowest low of the last "
            f"{bars_text(int(p['n']), iv)} happened (Aroon up / Aroon down, 100 = this candle).",
            f"It buys when Aroon up is at least {p['enterUp']:.0f} and ahead of Aroon down by {p['spread']:.0f}{gate}.",
            f"It sells everything when Aroon down gets ahead of Aroon up by {p['exitSpread']:.0f}; in between it "
            "keeps what it has.",
            *risk_steps(spec),
        ],
        "whenItWins": "Markets that grind to new highs again and again.",
        "whenItLoses": "Sideways ranges where highs and lows alternate, causing late entries and exits.",
    }
