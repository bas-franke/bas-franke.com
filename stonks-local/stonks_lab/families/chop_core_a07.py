"""chop_core_a07 v1 (agent-07): an SMA trend core that stops trading while it is being whipsawed.

SMA cores lose most to whipsaws, and the worst out-days sit just under the line (#453): days spent in cash in a
choppy market still average a gain. This family measures choppiness with the core's own recent behaviour: the number
of times the close crossed the average in the last ``lookback`` candles. While that count is at least ``maxCross``
the market is "choppy" and the core stops acting:

- mode "hold": fully invested while choppy (out-days in chop cost money, so stay in);
- mode "freeze": keep the position it had when the chop started (no new trades until the crosses thin out).

Otherwise it is the plain core (in above the SMA, out below). maxCross above what ``lookback`` allows never
triggers, i.e. the plain core. Everything uses closes up to the current bar.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "chop_core_a07"
VERSION = 1
TITLE = "SMA trend core that pauses in whipsaw clusters"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"smaLen": 58, "lookback": 30, "maxCross": 4, "mode": "hold"}


def param_space() -> dict:
    return {
        "smaLen": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "length of the simple moving average (candles)"},
        "lookback": {"type": "int", "min": 5, "max": 120, "log": True,
                     "description": "window (candles) in which crosses of the average are counted"},
        "maxCross": {"type": "int", "min": 2, "max": 12,
                     "description": "this many crosses or more in the window = choppy market"},
        "mode": {"type": "choice", "values": ["hold", "freeze"],
                 "description": "while choppy: hold fully, or freeze the current position"},
    }


def warmup(p: dict) -> int:
    return int(p["smaLen"]) + int(p["lookback"])


def chop_weights(above: np.ndarray, lookback: int, max_cross: int, mode: str) -> np.ndarray:
    n = len(above)
    defined = np.isfinite(above)
    a = np.where(defined, above, 0.0)
    prev = np.r_[np.nan, above[:-1]]
    cross = (defined & np.isfinite(prev) & (above != prev)).astype(np.float64)
    cs = np.cumsum(cross)
    cnt = cs - np.r_[np.zeros(lookback), cs[:-lookback]] if n > lookback else cs
    out = np.full(n, np.nan)
    state = None
    for i in range(n):
        if not defined[i]:
            continue
        core = 1.0 if a[i] >= 0.5 else 0.0
        if cnt[i] >= max_cross:
            if mode == "hold":
                state = 1.0
            elif state is None:
                state = core
        else:
            state = core
        out[i] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    sm = ind.sma(c, int(p["smaLen"]))
    above = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
    w = chop_weights(above, int(p["lookback"]), int(p["maxCross"]), p["mode"])
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = int(p["maxCross"])
    act = "stays fully invested" if p["mode"] == "hold" else "keeps whatever position it has and makes no trades"
    steps = [f"It holds {mk} while the price closes above its average over {bars_text(p['smaLen'], iv)} and "
             "sits in euros below it.",
             f"It counts how often the price crossed that average in the last {bars_text(p['lookback'], iv)}.",
             f"With {k} or more crosses the market is going sideways, and it {act} until the crossing calms down."]
    return {
        "summary": f"Follows the trend of {mk}, but stops flipping in and out when the market goes sideways.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Sideways markets around the average, where a plain trend rule pays fees for every flip and "
                      "sells the dips that later recover.",
        "whenItLoses": "A choppy top that turns into a crash: it is still holding when the real fall starts.",
    }
