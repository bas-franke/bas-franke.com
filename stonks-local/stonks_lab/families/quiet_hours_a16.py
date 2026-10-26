"""quiet_hours_a16 v1 (agent-16): close-hour check (#505) for quiet_core_a16.

Runs quiet_core_a16 on daily candles built from 1h candles that open at ``hour`` UTC (phase_shift.daily_candles),
deciding once a day at the close of that day's last hourly candle; targets are NaN between decisions. ``hour`` 0
reproduces the native 1d candle. Run on 1h with execution timeoutBars 24.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import quiet_core_a16 as qc
from .phase_shift import H_MS, daily_candles
from ._base import frame, max_weight, normalize_spec, single_market

NAME = "quiet_hours_a16"
VERSION = 1
TITLE = "Calm-hold trend core on daily candles closing at a chosen UTC hour"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {**qc.default_params(), "hour": 0}


def param_space() -> dict:
    return {**qc.param_space(),
            "hour": {"type": "int", "min": 0, "max": 23,
                     "description": "UTC hour at which each daily candle opens and the previous one closes"}}


def valid_params(p: dict) -> str | None:
    return qc.valid_params(p)


def warmup(p: dict) -> int:
    return 24 * (qc.warmup(p) + 2)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    d, _ = daily_candles(df, int(p["hour"]), 24)
    inner = {k: v for k, v in p.items() if k != "hour"}
    w = qc.targets({m: d}, {**spec, "params": inner, "interval": "1d"})
    idx = np.asarray(df.index, dtype=np.int64)
    out = np.full(len(idx), np.nan)
    if len(w):
        dts = np.asarray(w.index, dtype=np.int64) + 23 * H_MS
        pos = np.searchsorted(idx, dts, side="left")
        ok = pos < len(idx)
        out[pos[ok]] = w[m].to_numpy(np.float64)[ok]
    return frame(idx, {m: out})


def explain(spec) -> dict:
    p = spec["params"]
    inner = qc.explain({**spec, "params": {k: v for k, v in p.items() if k != "hour"}, "interval": "1d"})
    inner["howItWorks"] = [f"It works on daily candles that close at {int(p['hour']):02d}:00 UTC and decides once a "
                           "day at that hour.", *inner["howItWorks"]]
    return inner
