"""duo_core v1 (agent-18, ensemble lane): BTC and ETH each run the lab's best single-coin rule for that coin.

Why: under eval v2 the best BTC-only rule is core_dip with a BTC+ETH RSI panic (an SMA core plus a time-limited
capitulation buy, -3.9 vs BTC hold ~-17) and the best ETH-only rules are slow day-length MACDs (macd_days
12/182/35, about -9..-12 vs ETH hold ~-25). Both are edges on one coin that do not transfer to the other. This family
splits the money: a ``btcShare`` slot of maxWeight follows core_dip on BTC-EUR, the rest follows macd_days on
ETH-EUR. The two rules are only loosely correlated, so the pair should have a smaller drawdown than either alone; it
is benchmarked against the 50/50 BTC+ETH hold.

BTC leg (core_dip, scope "pair"): a dip trade starts when BTC's and ETH's RSI(rsiPeriod) are both under rsiBelow and
lasts until BTC's RSI rises over sellAbove or maxHold candles pass; besides that BTC is held while its close is above
SMA(coreSma).
ETH leg (macd_days, band 0): ETH is held while its MACD line (fastDays/slowDays EMAs) is above its signal line
(signalDays EMA). Lengths in days are converted to candles for the interval.

Both legs only use candles up to and including bar t (the other coin aligned as of t). The spec's markets must be
exactly BTC-EUR and ETH-EUR.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import core_dip, macd_days
from ._base import frame, max_weight, pct, risk_steps, union_index

NAME = "duo_core"
VERSION = 1
TITLE = "BTC dip core + ETH slow MACD"
BOT_READY = False
MULTI_MARKET = True
PAIR = ["BTC-EUR", "ETH-EUR"]


def default_params() -> dict:
    return {"btcShare": 0.5, "rsiPeriod": 25, "rsiBelow": 37.3, "sellAbove": 44.6, "maxHold": 86, "coreSma": 58,
            "fastDays": 12, "slowDays": 182, "signalDays": 35}


def param_space() -> dict:
    return {
        "btcShare": {"type": "float", "min": 0.2, "max": 0.8, "description": "share of the money for the BTC leg"},
        "rsiPeriod": {"type": "int", "min": 5, "max": 50, "description": "BTC leg: RSI length in candles"},
        "rsiBelow": {"type": "float", "min": 20, "max": 45,
                     "description": "BTC leg: dip trade starts when BTC's and ETH's RSI are both under this"},
        "sellAbove": {"type": "float", "min": 35, "max": 90,
                      "description": "BTC leg: dip trade ends when BTC's RSI rises over this"},
        "maxHold": {"type": "int", "min": 5, "max": 300, "log": True,
                    "description": "BTC leg: dip trade ends after this many candles"},
        "coreSma": {"type": "int", "min": 20, "max": 400, "log": True,
                    "description": "BTC leg: hold BTC while its close is above this SMA"},
        "fastDays": {"type": "int", "min": 3, "max": 40, "description": "ETH leg: fast MACD EMA in days"},
        "slowDays": {"type": "int", "min": 60, "max": 400, "log": True,
                     "description": "ETH leg: slow MACD EMA in days"},
        "signalDays": {"type": "int", "min": 5, "max": 90, "description": "ETH leg: MACD signal EMA in days"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["rsiBelow"]) >= float(p["sellAbove"]):
        return "rsiBelow must be below sellAbove"
    if int(p["fastDays"]) >= int(p["slowDays"]):
        return "fastDays must be below slowDays"
    return None


def warmup(p: dict) -> int:
    return max(int(p["rsiPeriod"]), int(p["coreSma"]) - 1)


def required_markets(spec: dict) -> list[str]:
    return list(PAIR)


def _btc_spec(spec: dict) -> dict:
    p = spec["params"]
    return {"family": "core_dip", "interval": spec.get("interval"), "markets": ["BTC-EUR"],
            "params": {"rsiPeriod": int(p["rsiPeriod"]), "rsiBelow": float(p["rsiBelow"]),
                       "sellAbove": float(p["sellAbove"]), "maxHold": int(p["maxHold"]),
                       "coreSma": int(p["coreSma"]), "scope": "pair"},
            "risk": {"maxWeight": 1.0}}


def _asof(index_from: np.ndarray, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    pos = np.searchsorted(index_from, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    markets = list(spec["markets"])
    if sorted(markets) != sorted(PAIR):
        raise ValueError(f"duo_core trades exactly BTC-EUR and ETH-EUR, got {markets}")
    p = spec["params"]
    idx = union_index(candles, PAIR)
    b = core_dip.targets(candles, _btc_spec(spec))
    btc = _asof(np.asarray(b.index, dtype=np.int64), b["BTC-EUR"].to_numpy(np.float64), idx)
    edf = candles["ETH-EUR"]
    mp = {"fastDays": int(p["fastDays"]), "slowDays": int(p["slowDays"]), "signalDays": int(p["signalDays"]),
          "band": 0.0, "requirePositive": False}
    eth = _asof(np.asarray(edf.index, dtype=np.int64),
                macd_days.state(edf["close"].to_numpy(np.float64), mp, spec.get("interval")), idx)
    mw = max_weight(spec)
    share = float(p["btcShare"])
    W = np.column_stack([btc * share * mw, eth * (1.0 - share) * mw])
    bad = ~np.isfinite(W).all(axis=1)
    W[bad] = np.nan
    good = ~bad
    first = int(np.argmax(good)) if good.any() else len(idx)
    W[:first] = np.nan
    out = {"BTC-EUR": W[:, 0], "ETH-EUR": W[:, 1]}
    return frame(idx, {m: out[m] for m in markets})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    share = float(p["btcShare"])
    b = core_dip.explain(_btc_spec(spec))
    steps = [f"The money is split: {pct(share)} follows a rule for BTC, {pct(1 - share)} a rule for ETH."]
    steps += ["BTC: " + s for s in b["howItWorks"] if not s.startswith("Risk")]
    steps.append(f"ETH: after every {iv} candle it compares the {p['fastDays']}-day and {p['slowDays']}-day average "
                 f"ETH price (MACD) with its {p['signalDays']}-day smoothing; it holds ETH while the MACD is above it.")
    return {
        "summary": "Holds BTC in uptrends and after joint BTC+ETH sell-offs, and ETH while its slow MACD trend is up.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets (both legs hold) and V-shaped crashes for BTC; long ETH bear markets (the slow "
                      "MACD is out).",
        "whenItLoses": "Choppy sideways years: the BTC dip buys and the ETH MACD crossings both whipsaw, and fast "
                       "rallies out of a bottom find the ETH leg still in cash.",
    }
