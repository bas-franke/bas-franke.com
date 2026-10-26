"""grid_ladder v1 (agent-21, reversion lane): a classic spot "grid bot" / price ladder.

The coin weight steps down as the price climbs a ladder of levels and steps up as it falls, around a moving anchor:

1. Anchor A_t = SMA or EMA of the close over ``anchorLen`` candles, or the highest close of the last ``anchorLen``
   candles ("high": the ladder then measures the drawdown from the recent high).
2. Position on the ladder x = ln(close / A). For an average anchor the ladder spans x from +span/2 (top) to -span/2
   (bottom); for the "high" anchor from 0 (top) to -span (bottom). u = (top - x) / span, clipped to 0..1
   (0 = top, 1 = bottom).
3. Grid levels: the ladder is cut into ``levels`` equal steps. Like a grid bot the current level only moves when the
   price crosses a whole step: raw level r = u * levels; the level goes up to floor(r) once r >= level + 1 and down
   to ceil(r) once r <= level - 1 (one step of hysteresis, so it doesn't churn around a level).
4. Weight = wMin + (1 - wMin) * level / levels (times maxWeight): wMin at the top of the ladder, fully invested at
   the bottom.

Decisions at bar t use closes up to and including bar t only.
"""
from __future__ import annotations

import math

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "grid_ladder"
VERSION = 1
TITLE = "Grid ladder (grid bot)"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"anchor": "ema", "anchorLen": 100, "span": 0.4, "levels": 8, "wMin": 0.2}


def param_space() -> dict:
    return {
        "anchor": {"type": "choice", "values": ["sma", "ema", "high"],
                   "description": "centre of the ladder: a moving average, or the recent highest close"},
        "anchorLen": {"type": "int", "min": 5, "max": 600, "log": True,
                      "description": "candles in the anchor (average length or high lookback)"},
        "span": {"type": "float", "min": 0.02, "max": 1.5, "log": True,
                 "description": "height of the whole ladder in log price (0.4 ~ 40 %)"},
        "levels": {"type": "int", "min": 2, "max": 30,
                   "description": "number of grid steps between the top and the bottom of the ladder"},
        "wMin": {"type": "float", "min": 0.0, "max": 0.9,
                 "description": "share held at (or above) the top of the ladder"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["span"]) / int(p["levels"]) < 0.004:
        return "grid steps under 0.4 % are smaller than a fee round trip"
    return None


def warmup(p: dict) -> int:
    return int(p["anchorLen"])


def _anchor(c: np.ndarray, p: dict) -> np.ndarray:
    n = int(p["anchorLen"])
    kind = p["anchor"]
    if kind == "ema":
        a = np.asarray(ind.ema(c, n), dtype=np.float64).copy()
        a[: min(n - 1, len(a))] = np.nan
        return a
    if kind == "high":
        import pandas as pd
        return pd.Series(c).rolling(n, min_periods=n).max().to_numpy(np.float64)
    return np.asarray(ind.sma(c, n), dtype=np.float64)


def ladder_weights(c: np.ndarray, p: dict, mw: float = 1.0) -> np.ndarray:
    a = _anchor(c, p)
    span = float(p["span"])
    L = int(p["levels"])
    wmin = float(p["wMin"])
    top = 0.0 if p["anchor"] == "high" else span / 2.0
    w = np.full(len(c), np.nan)
    lev = None
    for i in range(len(c)):
        if not (np.isfinite(a[i]) and a[i] > 0 and c[i] > 0):
            continue
        x = math.log(c[i] / a[i])
        u = min(1.0, max(0.0, (top - x) / span))
        r = u * L
        if lev is None:
            lev = int(round(r))
        elif r >= lev + 1:
            lev = int(math.floor(r + 1e-12))
        elif r <= lev - 1:
            lev = int(math.ceil(r - 1e-12))
        w[i] = mw * (wmin + (1.0 - wmin) * lev / L)
    return w


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    return frame(df.index, {m: ladder_weights(c, spec["params"], max_weight(spec))})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    L, span, wmin = int(p["levels"]), float(p["span"]), float(p["wMin"])
    step = math.exp(span / L) - 1
    if p["anchor"] == "high":
        centre = f"the highest close of the last {bars_text(int(p['anchorLen']), iv)}"
        where = (f"The top rung is that recent high; the bottom rung is about {pct(1 - math.exp(-span))} below it.")
    else:
        kind = "simple" if p["anchor"] == "sma" else "exponential"
        centre = f"its {kind} moving average over {bars_text(int(p['anchorLen']), iv)}"
        where = (f"The ladder runs from about {pct(math.exp(span / 2) - 1)} above that average (top rung) to about "
                 f"{pct(1 - math.exp(-span / 2))} below it (bottom rung).")
    steps = [
        f"After every {iv} candle it places {mk}'s close on a price ladder of {L} rungs around {centre}; "
        f"rungs are about {pct(step)} apart.",
        where,
        f"Like a grid bot it buys one slice each time the price falls through a rung and sells one slice each time "
        f"it rises through one: {pct(wmin)} of the money stays in the coin at the top of the ladder, all of it at "
        "the bottom.",
        "The rung only changes once the price has crossed a whole step, so it does not trade back and forth "
        "around one level.",
        "Because the ladder follows the anchor, it re-centres itself when the market trends.",
    ]
    return {
        "summary": f"A grid bot on {mk}: buys in steps as the price falls and sells in steps as it rises around "
                   "a moving centre.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Sideways, choppy markets that swing up and down through the rungs again and again.",
        "whenItLoses": "Strong bull runs (it has sold most of its coins on the way up) and long crashes (it is "
                       "fully invested all the way down).",
    }
