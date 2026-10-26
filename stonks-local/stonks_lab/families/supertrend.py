"""supertrend v1 (agent-19, risk lane): ATR-ratchet trend flip (the classic "supertrend"), long only.

While in the market a stop line trails under the price at ``basis - exitMult * ATR`` and only ever moves up; a close
below it sells. While in euros an entry line hangs over the price at ``basis + entryMult * ATR`` and only ever moves
down; a close above it buys. ``basis`` is the candle's (high+low)/2 or its close. Unlike a moving-average filter the
exit distance scales with volatility and ratchets, so it gives a calm uptrend room and tightens nothing in a crash
except through the ATR. Optional slow SMA gate: only buy while the close is above it. Decisions at bar t use candles
up to and including bar t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "supertrend"
VERSION = 1
TITLE = "Supertrend (ATR ratchet trend)"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"atrLen": 14, "entryMult": 3.0, "exitMult": 3.0, "basis": "hl2", "trendSma": 0}


def param_space() -> dict:
    return {
        "atrLen": {"type": "int", "min": 3, "max": 200, "log": True,
                   "description": "candles in the average true range (volatility unit)"},
        "entryMult": {"type": "float", "min": 0.3, "max": 10.0, "log": True,
                      "description": "buy when the close rises above the lowest basis + this many ATRs since the exit"},
        "exitMult": {"type": "float", "min": 0.5, "max": 12.0, "log": True,
                     "description": "sell when the close falls under the highest basis - this many ATRs since entry"},
        "basis": {"type": "choice", "values": ["hl2", "close"],
                  "description": "price the lines hang from: candle mid (high+low)/2 or close"},
        "trendSma": {"type": "int", "min": 10, "max": 600, "log": True, "zero": True,
                     "description": "only buy while the close is above this SMA (0 = off)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["atrLen"]), int(p["trendSma"] or 0))


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    h = df["high"].to_numpy(np.float64)
    lo = df["low"].to_numpy(np.float64)
    n = len(c)
    a = ind.atr(h, lo, c, int(p["atrLen"]))
    base = (h + lo) / 2.0 if p["basis"] == "hl2" else c
    ts = int(p["trendSma"] or 0)
    gate = ind.sma(c, ts) if ts else np.zeros(n)
    em, xm = float(p["entryMult"]), float(p["exitMult"])
    w = np.full(n, np.nan)
    mw = max_weight(spec)
    held = False
    line = np.nan          # stop line while held, entry line while flat
    for i in range(n):
        if not (np.isfinite(a[i]) and np.isfinite(gate[i])):
            continue
        if held:
            line = max(line, base[i] - xm * a[i])
            if c[i] < line:
                held = False
                line = base[i] + em * a[i]
        else:
            cand = base[i] + em * a[i]
            line = cand if not np.isfinite(line) else min(line, cand)
            if c[i] > line and (not ts or c[i] > gate[i]):
                held = True
                line = base[i] - xm * a[i]
        w[i] = mw if held else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    b = "the candle's midpoint" if p["basis"] == "hl2" else "the close"
    ts = int(p["trendSma"] or 0)
    steps = [
        f"After every {iv} candle it measures {mk}'s typical candle range (average true range over "
        f"{bars_text(int(p['atrLen']), iv)}).",
        f"While holding, a stop line trails {float(p['exitMult']):g} ranges under {b}; it only ever moves up. A close "
        "under it sells everything.",
        f"While in euros, a buy line hangs {float(p['entryMult']):g} ranges over {b}; it only ever moves down. A close "
        "over it buys" + (f", but only while the price is above its {bars_text(ts, iv)} average." if ts else "."),
    ]
    return {
        "summary": f"A volatility-scaled trailing trend on {mk}: in while the price stays above a rising stop line, "
                   "out after it breaks, back in when it breaks a falling buy line.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long steady trends (it rides them with a stop that leaves room) and long bear markets (sold early).",
        "whenItLoses": "Choppy markets that cross the lines often (fees, buying high and selling low) and sudden "
                       "crashes that gap through the stop.",
    }
