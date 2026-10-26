"""hour_check_a21 v1 (agent-21): decision-hour (close-hour) check for BTC/ETH-only leads that phase_shift lacks.

Same mechanics as ``phase_shift`` (agent-10, finding #505/#506), whose ``daily_candles`` it reuses: on 1h candles it
builds daily candles that open at ``hour`` UTC, runs one frozen fleet lead on them as interval 1d and places each
day's decision at the close of that day's last hourly candle (NaN in between: the position is left alone). ``hour``
0 reproduces the native 1d candle. The presets are BTC/ETH-only leads that were never hour-checked:

- ``duo``: duo_core d61ce6cfc7 (BTC+ETH 1d, -10.3; #405 'broad plateau')
- ``flow_committee``: flow_committee 12f0f04b7b (ETH 1d, -10.4; #178 plateau)
- ``beta_shift``: beta_shift 9cbdcbe10d (BTC+ETH 1d, -6.0; #450 plateau)
- ``bag_split``: leader_bag_a17 32c757dc76 (BTC+ETH 1d, +8.3; core_dip + powerlaw_band BTC half, wick_pressure ETH)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import get_family
from ._base import frame, market_names, max_weight, normalize_spec, risk_steps, union_index
from .phase_shift import daily_candles

NAME = "hour_check_a21"
VERSION = 1
TITLE = "BTC/ETH lead with a shifted daily close"
BOT_READY = False
MULTI_MARKET = True

H_MS = 3_600_000

PRESETS = {
    "duo": ("duo_core", {"btcShare": 0.5, "coreSma": 58, "fastDays": 12, "maxHold": 86, "rsiBelow": 37.3,
                         "rsiPeriod": 25, "sellAbove": 44.6, "signalDays": 35, "slowDays": 182}),
    "flow_committee": ("flow_committee", {"macdFast": 12, "macdSignal": 40, "macdSlow": 182, "mode": "any",
                                          "obvFast": 22, "obvSlow": 23, "smaLen": 198}),
    "beta_shift": ("beta_shift", {"coreSma": 130, "ethShare": 1, "heat": "eth_sma", "heatLen": 100, "heatThr": 0,
                                  "offWeight": 0.5}),
    "bag_split": ("leader_bag_a17", {"beta": False, "duo": False, "panic": False, "split": True}),
}


def default_params() -> dict:
    return {"preset": "duo", "hour": 0}


def param_space() -> dict:
    return {
        "preset": {"type": "choice", "values": list(PRESETS),
                   "description": "which BTC/ETH lead runs (its params are frozen)"},
        "hour": {"type": "int", "min": 0, "max": 23,
                 "description": "UTC hour at which each daily candle opens and the previous one closes"},
    }


def _inner(spec: dict) -> tuple:
    name, params = PRESETS[spec["params"]["preset"]]
    fam = get_family(name)
    inner = normalize_spec({"family": name, "markets": list(spec.get("markets") or []), "interval": "1d",
                            "params": dict(params), "risk": {"maxWeight": max_weight(spec)}}, fam)
    return fam, inner


def warmup(p: dict) -> int:
    name, params = PRESETS[p["preset"]]
    fam = get_family(name)
    return 24 * (int(fam.warmup({**fam.default_params(), **params})) + 2)


def required_markets(spec: dict) -> list[str]:
    fam, inner = _inner(spec)
    return fam.markets_needed(inner)


def targets(candles, spec, start_time=None):
    hour = int(spec["params"]["hour"])
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    fam, inner = _inner(spec)
    daily, decide_at = {}, None
    for m in fam.markets_needed(inner):
        if m not in candles:
            continue
        d, last = daily_candles(candles[m], hour, 24)
        daily[m] = d
        if m == markets[0]:
            decide_at = last
    out = {m: np.full(len(idx), np.nan) for m in markets}
    if decide_at is None:
        return frame(idx, out)
    w = fam.targets(daily, inner)
    if len(w) == 0:
        return frame(idx, out)
    dts = np.asarray(w.index, dtype=np.int64) + 23 * H_MS
    pos = np.searchsorted(idx, dts, side="left")
    ok = pos < len(idx)
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
    except Exception:  # pragma: no cover - explanation must never break publishing
        inner_steps, wins, loses = [], "", ""
    mk = market_names(spec)
    steps = [f"It runs the fleet strategy '{name}' on {mk} with fixed settings, on daily candles.",
             f"Its days start and end at {int(p['hour']):02d}:00 UTC instead of midnight, so it decides once a day "
             "at that hour.", *inner_steps]
    return {
        "summary": f"The daily strategy '{name}' on {mk}, deciding at {int(p['hour']):02d}:00 UTC each day.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": wins or "Same as the daily strategy it wraps.",
        "whenItLoses": loses or "Same as the daily strategy it wraps; plus luck in the hour it decides.",
    }
