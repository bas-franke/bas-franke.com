"""ta_trend v1: long while a TAAPI-style indicator is bullish, flat while it is bearish.

The reading comes from ``_ta.compute`` (TAAPI names and length ratios, scaled the same way as the indicator
ladder). It buys when the reading reaches ``+thr`` and sells when it falls to ``-thr``. With ``thr`` at 0 that
is a zero-line cross. Bar i uses only bars up to i.
"""
from __future__ import annotations

import numpy as np

from . import _ta
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "ta_trend"
VERSION = 1
TITLE = "Slow indicator trend"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"indicator": "macd", "n": 600, "thr": 0.0}


def param_space() -> dict:
    return {
        "indicator": {"type": "choice", "values": list(_ta.ALL), "description": "which TAAPI-style indicator"},
        "n": {"type": "int", "min": 8, "max": 2000, "log": True, "description": "main length in candles"},
        "thr": {"type": "float", "min": 0.0, "max": 0.9,
                "description": "buy at or above +thr, sell at or below -thr, on the scaled reading"},
    }


def valid_params(p: dict) -> str | None:
    if p["indicator"] not in _ta.ALL:
        return f"unknown indicator {p['indicator']}"
    return None


def warmup(p: dict) -> int:
    return _ta.warmup(p["indicator"], int(p["n"]))


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    x = _ta.compute(p["indicator"], df, int(p["n"]))
    thr = float(p["thr"])
    w = np.full(len(x), np.nan)
    state, started = 0.0, False
    mw = max_weight(spec)
    for i in range(len(x)):
        v = x[i]
        if v != v:
            continue
        if not started:
            state, started = (1.0 if v >= thr else 0.0), True
        elif state < 0.5 and v >= thr:
            state = 1.0
        elif state >= 0.5 and v <= -thr:
            state = 0.0
        w[i] = mw if state >= 0.5 else 0.0
    return frame(df.index, {m: w})


def _lengths(n: int) -> tuple[int, int]:
    slow = max(n + 1, round(n * 26 / 12))
    sig = max(2, round(n * 9 / 12))
    return slow, sig


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    name = _ta.LABEL.get(p["indicator"], p["indicator"])
    n = int(p["n"])
    thr = float(p["thr"])
    band = (f"It buys when that reading reaches +{thr:g} and sells when it falls to -{thr:g}."
            if thr else "It buys when that reading is above zero and sells when it falls under zero.")
    if p["indicator"] == "macd":
        slow, sig = _lengths(n)
        how = [
            f"After every {iv} candle it builds a MACD on the close. The fast average is the last "
            f"{bars_text(n, iv)}. The slow average is the last {bars_text(slow, iv)}. "
            f"A signal line is the average of their gap over {bars_text(sig, iv)}.",
            "The histogram is that gap minus the signal line, divided by the recent daily range so a quiet "
            "coin and a wild one use the same zero line.",
            band + " The whole account, or none of it.",
        ]
        summary = f"Holds {mk} while its slow MACD histogram is positive, and sits in euros when it is not."
    elif p["indicator"] == "aroon":
        how = [
            f"After every {iv} candle it looks back {bars_text(n + 1, iv)} and asks how recently the highest high "
            "and the lowest low happened.",
            "A high that just happened, with the low far behind it, pushes the reading toward +1. "
            "A low that just happened pushes it toward -1.",
            band + " The whole account, or none of it.",
        ]
        summary = f"Holds {mk} while recent highs are winning, and sits in euros while recent lows are."
    elif p["indicator"] == "dmi":
        how = [
            f"After every {iv} candle it looks at the last {bars_text(n, iv)} and adds up the hours that made "
            "a higher high against the hours that made a lower low.",
            "The reading is how far those up-moves lead the down-moves, scaled so it sits on the same -1 to +1 "
            "range as the other indicators.",
            band + " The whole account, or none of it.",
        ]
        summary = f"Holds {mk} while up-moves lead down-moves, and sits in euros when they do not."
    else:
        how = [
            f"After every {iv} candle it computes {name} over {bars_text(n, iv)}, scaled to about -1 to +1.",
            band + " The whole account, or none of it.",
        ]
        summary = f"Holds {mk} while {name} is bullish and sits in euros while it is bearish."
    return {
        "summary": summary,
        "howItWorks": how + risk_steps(spec),
        "whenItWins": "A long rise that lasts longer than the indicator, and a long decline it can sit out.",
        "whenItLoses": "A deep dip that heals before the slow reading turns down, or a rise it sells too early.",
    }
