"""persist_core v1 (agent-10): an SMA trend core whose crosses must persist for N closes before it acts.

SMA cores lose most of their money to whipsaws: one close under the line sells, the next close above buys back
higher (findings #92, #324). The fleet's hysteresis so far is a DISTANCE band (ma_band, asym_core, mayer_band). This
family uses TIME instead: a cross only counts once it has held for several consecutive closes.

- above_t = close_t > SMA(smaLen)_t
- out -> in after ``enterBars`` consecutive closes above; in -> out after ``exitBars`` consecutive closes below.
enterBars = exitBars = 1 is the plain SMA core (the ablation). The first decision follows the plain rule.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "persist_core"
VERSION = 1
TITLE = "SMA trend core with time-confirmed crosses"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"smaLen": 130, "enterBars": 3, "exitBars": 3}


def param_space() -> dict:
    return {
        "smaLen": {"type": "int", "min": 10, "max": 600, "log": True,
                   "description": "length of the simple moving average (candles)"},
        "enterBars": {"type": "int", "min": 1, "max": 30, "log": True,
                      "description": "buy only after this many closes in a row above the average"},
        "exitBars": {"type": "int", "min": 1, "max": 30, "log": True,
                     "description": "sell only after this many closes in a row below the average"},
    }


def warmup(p: dict) -> int:
    return int(p["smaLen"])


def persist_state(above: np.ndarray, enter: int, exit_: int) -> np.ndarray:
    """1/0 position from a 1/0/NaN 'above' series with run-length confirmation; NaN until above is defined."""
    out = np.full(len(above), np.nan)
    state = None
    run_up = run_dn = 0
    for i, a in enumerate(above.tolist()):
        if a != a:
            continue
        if a >= 0.5:
            run_up, run_dn = run_up + 1, 0
        else:
            run_up, run_dn = 0, run_dn + 1
        if state is None:
            state = 1.0 if a >= 0.5 else 0.0
        elif state == 1.0 and run_dn >= exit_:
            state = 0.0
        elif state == 0.0 and run_up >= enter:
            state = 1.0
        out[i] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    sm = ind.sma(c, int(p["smaLen"]))
    above = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
    on = persist_state(above, int(p["enterBars"]), int(p["exitBars"]))
    return frame(df.index, {m: on * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    e, x = int(p["enterBars"]), int(p["exitBars"])
    steps = [f"It follows the trend of {mk} with its average price over {bars_text(p['smaLen'], iv)}.",
             f"It buys only after {e} close{'s' if e > 1 else ''} in a row above that average.",
             f"It sells only after {x} close{'s' if x > 1 else ''} in a row below it, so a single dip under the "
             "line does not shake it out."]
    return {
        "summary": f"Holds {mk} in uptrends, but only acts on a trend change once it has lasted a few candles.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Choppy markets around the average: it ignores one-candle crosses that would cost fees and "
                      "a worse re-entry.",
        "whenItLoses": "Sharp crashes and V-shaped rebounds: waiting for confirmation sells lower and buys higher.",
    }
