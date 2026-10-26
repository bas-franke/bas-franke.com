"""pyramid_core v1 (agent-09): an SMA trend core that is entered in pieces and only grows as the trend proves itself.

A plain "hold above the SMA" core pays its full size on every false cross. Here a new trend is entered with a first
tranche (``first`` of the position); each further tranche is bought only once the close has risen another ``step``
above the price of the previous add (pyramiding into strength), up to ``tranches`` adds in total (full size). Everything
is sold when the close falls under the SMA by ``exitBand``; a new entry needs the close above the SMA by ``enterBand``.
``first = 1`` is the plain SMA core (the control). Decisions at bar t use candles up to and including bar t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "pyramid_core"
VERSION = 1
TITLE = "Pyramiding trend core"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"coreLen": 130, "first": 0.34, "tranches": 3, "step": 0.08, "enterBand": 0.0, "exitBand": 0.0}


def param_space() -> dict:
    return {
        "coreLen": {"type": "int", "min": 10, "max": 600, "log": True,
                    "description": "trend core: SMA length in candles"},
        "first": {"type": "float", "min": 0.1, "max": 1.0,
                  "description": "share of the full position bought when the trend starts"},
        "tranches": {"type": "int", "min": 2, "max": 6,
                     "description": "number of buys (first + adds) that make up the full position"},
        "step": {"type": "float", "min": 0.01, "max": 0.4, "log": True,
                 "description": "rise of the close above the previous buy's close needed for the next add"},
        "enterBand": {"type": "float", "min": 0.0, "max": 0.1,
                      "description": "new entries need the close this far above the SMA"},
        "exitBand": {"type": "float", "min": 0.0, "max": 0.1,
                     "description": "sell everything when the close falls this far under the SMA"},
    }


def warmup(p: dict) -> int:
    return int(p["coreLen"])


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    sma = ind.sma(c, int(p["coreLen"]))
    first, k = float(p["first"]), int(p["tranches"])
    add = (1.0 - first) / (k - 1) if k > 1 else 0.0
    step, eb, xb = float(p["step"]), float(p["enterBand"]), float(p["exitBand"])
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    size, last = 0.0, 0.0
    for i in range(n):
        s = sma[i]
        if not (np.isfinite(s) and np.isfinite(c[i])):
            continue
        if size > 0:
            if c[i] < s * (1 - xb):
                size = 0.0
            elif size < 1.0 - 1e-9 and c[i] >= last * (1 + step):
                size = min(1.0, size + add)
                last = c[i]
        elif c[i] > s * (1 + eb):
            size, last = first, c[i]
        w[i] = mw * size
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    L = bars_text(int(p["coreLen"]), iv)
    first, k = float(p["first"]), int(p["tranches"])
    steps = [f"When {mk} closes above its {L} average it buys {pct(first)} of the full position."]
    if first < 1:
        steps.append(f"Every time the close rises another {pct(float(p['step']))} above its last buy it adds "
                     f"{pct((1 - first) / (k - 1))}, up to the full position after {k} buys.")
    steps.append("It sells everything when the close drops under the average"
                 + (f" by more than {pct(float(p['exitBand']))}." if float(p["exitBand"]) else "."))
    return {
        "summary": f"Rides {mk}'s trend but starts small and only adds as the rally proves itself.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Choppy markets with many false trend starts: they cost only the small first tranche.",
        "whenItLoses": "Fast V-shaped bull runs, where it is only partly invested during the best weeks.",
    }
