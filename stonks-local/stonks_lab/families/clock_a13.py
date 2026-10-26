"""clock_a13 v1 (agent-13): close-hour check for BTC/ETH leaders that phase_shift has no preset for.

Same mechanics as agent-10's phase_shift (whose candle builder it reuses): on 1h candles it builds daily (or 12h)
candles that open at ``hour`` UTC, runs a frozen fleet lead on them and places each decision at the close of that
candle's last hourly bar. Hour 0 is the native candle. Finding #505: leads tuned on the 00:00 UTC close are inflated
by ~4-10 points, so every 1d/12h lead should be quoted at its median hour, not at 00:00.

Presets (the published BTC/ETH-only leads that had no decision-hour test yet):
- ``wick_eth``: wick_pressure ETH 1d b32ea0f175 (look 63, exit 0, re-enter -0.038)
- ``beta_shift``: beta_shift BTC+ETH 1d 054028844c (BTC SMA130 core, all-in ETH while ETH > SMA100)
- ``ratio_btc``: ratio_gate BTC 1d 36326bc74a (SMA130 core OR rising BTC/ETH ratio 10/365)
- ``duo``: duo_core BTC+ETH 1d d61ce6cfc7 (BTC core_dip + ETH macd_days)
- ``era12``: breadth_era BTC 12h 8f38ac11ec (y2020 breadth panic + SMA220 core), 12h candles at h and h+12
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import get_family
from ._base import frame, market_names, max_weight, normalize_spec, risk_steps, union_index
from .phase_shift import H_MS, daily_candles

NAME = "clock_a13"
VERSION = 1
TITLE = "Fleet lead with a shifted candle close"
BOT_READY = False
MULTI_MARKET = True

PRESETS = {
    "wick_eth": ("wick_pressure", {"combine": "or", "coreLen": 0, "exitAbove": 0, "look": 63, "reenter": -0.0382,
                                   "scope": "own"}),
    "beta_shift": ("beta_shift", {"coreSma": 130, "ethShare": 1, "heat": "eth_sma", "heatLen": 100, "heatThr": 0,
                                  "offWeight": 0}),
    "ratio_btc": ("ratio_gate", {"band": 0, "combine": "or", "coreLen": 130, "ratioFast": 10, "ratioSlow": 365}),
    "duo": ("duo_core", {"btcShare": 0.5, "coreSma": 58, "fastDays": 12, "maxHold": 86, "rsiBelow": 37.3,
                         "rsiPeriod": 25, "sellAbove": 44.6, "signalDays": 35, "slowDays": 182}),
    "era12": ("breadth_era", {"breadthList": "y2020", "breadthMin": 0.8579, "coreSma": 220, "maxHold": 194,
                              "rsiBelow": 36.5239, "rsiPeriod": 20, "sellAbove": 85.6804}),
}
PERIOD = {"era12": 12}


def period_hours(preset: str) -> int:
    return PERIOD.get(preset, 24)


def default_params() -> dict:
    return {"preset": "ratio_btc", "hour": 0}


def param_space() -> dict:
    return {
        "preset": {"type": "choice", "values": list(PRESETS),
                   "description": "which fleet lead runs (its params are frozen)"},
        "hour": {"type": "int", "min": 0, "max": 23,
                 "description": "UTC hour at which each candle opens and the previous one closes"},
    }


def _inner(spec: dict) -> tuple:
    name, params = PRESETS[spec["params"]["preset"]]
    fam = get_family(name)
    iv = "12h" if period_hours(spec["params"]["preset"]) == 12 else "1d"
    inner = normalize_spec({"family": name, "markets": list(spec.get("markets") or []), "interval": iv,
                            "params": dict(params), "risk": {"maxWeight": max_weight(spec)}}, fam)
    return fam, inner


def warmup(p: dict) -> int:
    name, params = PRESETS[p["preset"]]
    fam = get_family(name)
    return period_hours(p["preset"]) * (int(fam.warmup({**fam.default_params(), **params})) + 2)


def required_markets(spec: dict) -> list[str]:
    fam, inner = _inner(spec)
    try:
        return fam.markets_needed(inner)
    except ValueError:      # the preset does not take these markets: targets() raises it again
        return list(spec.get("markets") or [])


def targets(candles, spec, start_time=None):
    p = spec["params"]
    hour = int(p["hour"])
    period = period_hours(p["preset"])
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    fam, inner = _inner(spec)
    shifted = {}
    for m in fam.markets_needed(inner):
        if m in candles:
            shifted[m] = daily_candles(candles[m], hour, period)[0]
    out = {m: np.full(len(idx), np.nan) for m in markets}
    w = fam.targets(shifted, inner)
    if len(w) == 0:
        return frame(idx, out)
    # the candle opening at D is complete (and decided) at the close of its last hourly bar, D + (period-1)h
    dts = np.asarray(w.index, dtype=np.int64) + (period - 1) * H_MS
    pos = np.searchsorted(idx, dts, side="left")
    ok = pos < len(idx)   # a missing hourly bar moves the decision to the next bar, as in phase_shift
    for m in markets:
        col = w[m].to_numpy(np.float64) if m in w.columns else np.zeros(len(w))
        out[m][pos[ok]] = col[ok]
    return frame(idx, out)


def explain(spec) -> dict:
    p = spec["params"]
    name, _ = PRESETS[p["preset"]]
    try:
        fam, inner = _inner(spec)
        ex = fam.explain(inner)
        inner_steps = list(ex.get("howItWorks") or [])[:4]
        wins, loses = ex.get("whenItWins", ""), ex.get("whenItLoses", "")
    except Exception:  # pragma: no cover - an explanation must never break publishing
        inner_steps, wins, loses = [], "", ""
    mk = market_names(spec)
    h = int(p["hour"])
    when = (f"Its days start and end at {h:02d}:00 UTC instead of midnight, so it decides once a day at that hour."
            if period_hours(p["preset"]) == 24 else
            f"Its 12-hour candles start at {h % 12:02d}:00 and {h % 12 + 12:02d}:00 UTC instead of 00:00 and 12:00.")
    return {
        "summary": f"The fleet strategy '{name}' on {mk}, deciding at a shifted hour ({h:02d}:00 UTC).",
        "howItWorks": [f"It runs the fleet strategy '{name}' on {mk} with fixed settings.", when, *inner_steps]
        + risk_steps(spec),
        "whenItWins": wins or "Same as the strategy it wraps.",
        "whenItLoses": loses or "Same as the strategy it wraps, plus luck in the hour it decides.",
    }
