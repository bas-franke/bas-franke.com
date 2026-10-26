"""regret_core v1 (agent-02): a moving-average core with a "regret" re-entry anchored on the last exit price.

Findings #324/#373: MA cores lose to holding BTC mainly through whipsaw in bull/recovery folds: they sell a dip under
the average and buy back only when the price is above the (lagging) average again, often well above where they
sold. This family caps that cost: after an exit at price P it buys back as soon as the close is back above
P x (1 + regretPct), even while the price is still under the average ("selling was a mistake").

- core_t = close above MA(coreLen) (SMA or EMA); a core exit needs close < MA x (1 - exitBand).
- After any exit at close P (the anchor), while under the MA: buy back when close >= P x (1 + regretPct).
- A regret position held under the MA is sold when close < P x (1 - regretStop) (P = the anchor it re-entered on);
  that sale sets a new anchor.
- At most maxRegrets regret re-entries per stretch under the MA; after that only the core can buy back.
  regretPct 0 = off (plain MA core with exit band).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "regret_core"
VERSION = 1
TITLE = "Trend core with regret re-entry at the last exit price"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"coreLen": 130, "maType": "sma", "exitBand": 0.0, "regretPct": 0.02, "regretStop": 0.05,
            "maxRegrets": 2}


def param_space() -> dict:
    return {
        "coreLen": {"type": "int", "min": 10, "max": 600, "log": True,
                    "description": "length of the moving average the core holds above"},
        "maType": {"type": "choice", "values": ["sma", "ema"], "description": "simple or exponential average"},
        "exitBand": {"type": "float", "min": 0.0, "max": 0.1,
                     "description": "the core sells only below MA x (1 - exitBand)"},
        "regretPct": {"type": "float", "min": 0.0, "max": 0.2, "zero": True,
                      "description": "buy back under the MA once the close is this far above the last exit price "
                                     "(0 = no regret re-entry)"},
        "regretStop": {"type": "float", "min": 0.01, "max": 0.3,
                       "description": "a regret position under the MA is sold this far below its anchor"},
        "maxRegrets": {"type": "int", "min": 1, "max": 6,
                       "description": "regret re-entries allowed per stretch under the MA"},
    }


def warmup(p: dict) -> int:
    return int(p["coreLen"])


def regret_weights(c: np.ndarray, ma: np.ndarray, p: dict) -> np.ndarray:
    n = len(c)
    out = np.full(n, np.nan)
    band, rp, rs = float(p["exitBand"]), float(p.get("regretPct") or 0.0), float(p["regretStop"])
    kmax = int(p["maxRegrets"])
    held = regret = False
    anchor = np.nan   # close of the last exit
    used = 0          # regret re-entries in the current stretch under the MA
    for i in range(n):
        if not (np.isfinite(c[i]) and np.isfinite(ma[i])):
            continue
        above = c[i] > ma[i]
        if above:
            used = 0
        if held:
            if above:
                regret = False
            elif regret:
                if c[i] < anchor * (1.0 - rs):
                    held, regret, anchor = False, False, c[i]
            elif c[i] < ma[i] * (1.0 - band):
                held, anchor = False, c[i]
        else:
            if above:
                held, regret = True, False
            elif rp > 0 and np.isfinite(anchor) and used < kmax and c[i] >= anchor * (1.0 + rp):
                held, regret = True, True
                used += 1
        out[i] = 1.0 if held else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    n = int(p["coreLen"])
    ma = ind.ema(c, n) if p["maType"] == "ema" else ind.sma(c, n)
    w = regret_weights(c, ma, p)
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    avg = "exponential" if p["maType"] == "ema" else "simple"
    steps = [f"It holds {mk} while the price is above its {avg} average over {bars_text(p['coreLen'], iv)}"
             + (f" and sells only when it falls {pct(p['exitBand'])} below it." if p["exitBand"] else
                " and sells when it closes below it.")]
    rp = float(p.get("regretPct") or 0)
    if rp:
        steps.append(f"After selling it remembers the sale price. If the price climbs back {pct(rp)} above that "
                     f"price it buys back at once, even under the average: the sale was a mistake.")
        steps.append(f"Such a buy-back is sold again {pct(p['regretStop'])} under the old sale price, and at most "
                     f"{int(p['maxRegrets'])} buy-backs are made before the price is back above the average.")
    return {
        "summary": f"Holds {mk} in uptrends and buys back quickly when a sale turns out to be a false alarm.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets with sharp dips under the average that recover fast: it is back in near "
                      "its sale price instead of waiting for the average.",
        "whenItLoses": "Bear-market bounces: it buys back a bounce and is stopped out again, paying fees twice.",
    }
