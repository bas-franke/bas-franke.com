"""macd_tp v1: MACD trend with a built-in profit exit and an optional pullback re-entry.

Core: hold while the MACD line is above its signal line (like macd_trend). Two optional exits bank a run before the
trend turns:

- ``tpPct``: sell when the close is this fraction above the close at which the position was (re)entered.
- ``stretchPct``: sell when the close is this fraction above the slow EMA (the price is over-extended).

After such a profit exit the strategy is "locked": it stays in euros until either the MACD turns off (then a fresh
MACD cross is needed, like the engine's takeProfit lockout) or, with ``pullbackPct`` > 0, the close falls this
fraction below the exit close while the MACD is still on, which buys back in. A fresh entry while already stretched
is skipped (it goes straight to locked). All decisions use closes up to the decision bar only. Unlike macd_trend, slow
may reach 600 candles so 12h/4h bars can use the same wall-clock spans as a daily MACD.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "macd_tp"
VERSION = 1
TITLE = "MACD trend with profit taking"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"fast": 12, "slow": 182, "signal": 30, "tpPct": 0.6, "stretchPct": 0.0, "pullbackPct": 0.0}


def param_space() -> dict:
    return {
        "fast": {"type": "int", "min": 2, "max": 120, "log": True, "description": "fast EMA length"},
        "slow": {"type": "int", "min": 10, "max": 600, "log": True, "description": "slow EMA length"},
        "signal": {"type": "int", "min": 2, "max": 150, "log": True, "description": "signal EMA length"},
        "tpPct": {"type": "float", "min": 0.05, "max": 2.0, "log": True, "zero": True,
                  "description": "sell when the close is this fraction above the entry close (0 = off)"},
        "stretchPct": {"type": "float", "min": 0.05, "max": 2.0, "log": True, "zero": True,
                       "description": "sell when the close is this fraction above the slow EMA (0 = off)"},
        "pullbackPct": {"type": "float", "min": 0.02, "max": 0.5, "log": True, "zero": True,
                        "description": "after a profit exit, buy back when the close is this fraction under the exit "
                                       "close and the MACD is still on (0 = wait for a fresh MACD cross)"},
    }


def valid_params(p: dict) -> str | None:
    if p["fast"] >= p["slow"]:
        return "fast must be shorter than slow"
    if p.get("pullbackPct") and not (p.get("tpPct") or p.get("stretchPct")):
        return "pullbackPct needs tpPct or stretchPct"
    return None


def warmup(p: dict) -> int:
    return int(p["slow"]) + int(p["signal"]) - 2


_OUT, _IN, _LOCKED = 0, 1, 2


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    line, sig, _ = ind.macd(c, p["fast"], p["slow"], p["signal"])
    slow_ema = ind.ema(c, p["slow"])
    tp = float(p.get("tpPct") or 0.0)
    st = float(p.get("stretchPct") or 0.0)
    pb = float(p.get("pullbackPct") or 0.0)
    mw = max_weight(spec)
    valid = np.isfinite(line) & np.isfinite(sig) & np.isfinite(slow_ema)
    on_arr = valid & (line > sig)
    n = len(c)
    w = np.full(n, np.nan)
    state, ref = _OUT, 0.0
    for t in range(n):
        if not valid[t]:
            continue
        ct = c[t]
        stretched = st > 0 and ct >= slow_ema[t] * (1.0 + st)
        if not on_arr[t]:
            state = _OUT
        elif state == _OUT:
            if stretched:
                state, ref = _LOCKED, ct
            else:
                state, ref = _IN, ct
        elif state == _IN:
            if (tp > 0 and ct >= ref * (1.0 + tp)) or stretched:
                state, ref = _LOCKED, ct
        elif state == _LOCKED:
            if pb > 0 and ct <= ref * (1.0 - pb) and not stretched:
                state, ref = _IN, ct
        w[t] = mw if state == _IN else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = [
        f"After every {iv} candle it computes the MACD line: the {bars_text(p['fast'], iv)} average price minus the "
        f"{bars_text(p['slow'], iv)} average (both exponential), and smooths it over {bars_text(p['signal'], iv)} "
        "into a signal line.",
        f"While the MACD line is above its signal line, momentum is up and it holds {mk}; otherwise it holds euros.",
    ]
    if p.get("tpPct"):
        steps.append(f"Profit taking: once the price has closed {pct(p['tpPct'])} above where it bought, it sells "
                     "everything, even though momentum is still up.")
    if p.get("stretchPct"):
        steps.append(f"It also sells when the price runs {pct(p['stretchPct'])} above the long average (an "
                     "over-extended rally), and does not buy while the price is that stretched.")
    if p.get("tpPct") or p.get("stretchPct"):
        if p.get("pullbackPct"):
            steps.append(f"After such a profit sale it buys back if the price falls {pct(p['pullbackPct'])} below "
                         "where it sold while momentum is still up; if momentum turns down first, it waits for the "
                         "next up-turn.")
        else:
            steps.append("After a profit sale it waits until momentum has turned down and up again before buying.")
    return {
        "summary": f"A slow momentum strategy on {mk} that also cashes in after big rallies, because sharp run-ups "
                   "often give back much of their gain.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Trending markets with blow-off rallies that reverse: it banks the spike and avoids the drop.",
        "whenItLoses": "Long, steady bull runs (it sells early and may sit out the rest) and sideways markets "
                       "where momentum flips often.",
    }
