"""volvol_gate v1 (agent-10): a trend core that steps aside when the volatility regime turns unusual.

vol_target (#23 #38 #73 #80) scales the position by the LEVEL of realized volatility, which mostly just holds less;
vol_panic_core buys on a vol spike. Nobody has used the volatility *regime relative to its own history* as an exit:
is the coin's volatility (or the volatility of its volatility) in the top tail of the last rankLen candles?

- rv_t = population std of the last volLen one-bar log returns;
- measure "vol": x_t = rv_t; measure "volvol": x_t = population std over vvLen bars of the changes in ln(rv);
- rank_t = share of the last rankLen values of x that are <= x_t (percentile rank, includes bar t);
- the coin is "stormy" while rank_t > pctMax; with downOnly it is stormy only while also below its close of
  volLen bars ago (a storm in a rally is allowed).
Hold while the trend core is on (close above SMA(coreLen), coreLen 0 = always on) and the coin is not stormy.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "volvol_gate"
VERSION = 1
TITLE = "Trend core with a volatility-regime exit"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"coreLen": 130, "measure": "volvol", "volLen": 14, "vvLen": 30, "rankLen": 365, "pctMax": 0.9,
            "downOnly": True}


def param_space() -> dict:
    return {
        "coreLen": {"type": "int", "min": 10, "max": 600, "zero": True, "log": True,
                    "description": "hold while the close is above this SMA (0 = no core: always on unless stormy)"},
        "measure": {"type": "choice", "values": ["vol", "volvol"],
                    "description": "vol: realized volatility; volvol: how much that volatility itself swings"},
        "volLen": {"type": "int", "min": 3, "max": 120, "log": True,
                   "description": "candles in the realized volatility"},
        "vvLen": {"type": "int", "min": 5, "max": 200, "log": True,
                  "description": "volvol: candles over which the swings of the volatility are measured"},
        "rankLen": {"type": "int", "min": 50, "max": 1500, "log": True,
                    "description": "candles of history the current value is ranked against"},
        "pctMax": {"type": "float", "min": 0.5, "max": 0.99,
                   "description": "stormy when the current value ranks above this share of that history"},
        "downOnly": {"type": "bool", "description": "only stormy while the price is also below its level volLen ago"},
    }


def warmup(p: dict) -> int:
    w = int(p["volLen"]) + int(p["rankLen"]) + (int(p["vvLen"]) if p["measure"] == "volvol" else 0)
    return max(w, int(p.get("coreLen") or 0))


def storm_flags(close: np.ndarray, p: dict) -> np.ndarray:
    c = np.asarray(close, dtype=np.float64)
    lr = np.full(len(c), np.nan)
    lr[1:] = np.log(c[1:] / c[:-1])
    k = int(p["volLen"])
    rv = ind.std_pop(lr, k)
    if p["measure"] == "volvol":
        with np.errstate(invalid="ignore", divide="ignore"):
            lrv = np.log(np.where(rv > 0, rv, np.nan))
        d = np.full(len(c), np.nan)
        d[1:] = lrv[1:] - lrv[:-1]
        x = ind.std_pop(d, int(p["vvLen"]))
    else:
        x = rv
    L = int(p["rankLen"])
    rank = pd.Series(x).rolling(L, min_periods=L).rank(pct=True).to_numpy(np.float64)
    storm = rank > float(p["pctMax"])
    if p.get("downOnly"):
        past = np.full(len(c), np.nan)
        past[k:] = c[:-k]
        with np.errstate(invalid="ignore"):
            storm = storm & (c < past)
        ok = np.isfinite(rank) & np.isfinite(past)
    else:
        ok = np.isfinite(rank)
    return np.where(ok, storm.astype(np.float64), np.nan)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    storm = storm_flags(c, p)
    n = int(p.get("coreLen") or 0)
    if n > 0:
        sm = ind.sma(c, n)
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
    else:
        core = np.ones(len(c))
    ok = np.isfinite(storm) & np.isfinite(core)
    on = np.where(ok, ((core == 1) & (storm == 0)).astype(np.float64), np.nan)
    return frame(df.index, {m: on * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    what = ("how wildly the price swings" if p["measure"] == "vol"
            else f"how unstable those swings are (the swings of the volatility over {bars_text(p['vvLen'], iv)})")
    steps = [f"After every {iv} candle it measures {what}, using price moves over {bars_text(p['volLen'], iv)}.",
             f"It compares that number with the last {bars_text(p['rankLen'], iv)}: if it is higher than "
             f"{pct(p['pctMax'])} of them, the market counts as stormy"
             + (" (only while the price is also lower than it was at the start of that window)." if p.get("downOnly")
                else ".")]
    n = int(p.get("coreLen") or 0)
    if n:
        steps.append(f"It holds {mk} while the price is above its average over {bars_text(n, iv)} and the market is "
                     "not stormy; otherwise it keeps euros.")
    else:
        steps.append(f"It holds {mk} unless the market is stormy.")
    return {
        "summary": f"Holds {mk} in uptrends but steps aside when volatility turns unusually wild.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Crashes that start with a burst of erratic volatility while the price is still above trend.",
        "whenItLoses": "Volatile rallies and quick shake-outs: it sells into the storm and buys back higher.",
    }
