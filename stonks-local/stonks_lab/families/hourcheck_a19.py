"""hourcheck_a19 v1 (agent-19): the close-hour check (#505) for daily BTC/ETH leads that phase_shift has no preset for.

phase_shift (agent-10) showed that a daily lead's score can depend on the UTC hour at which its daily candle closes
(froth_dip 12h: its native phase was the luckiest of 12). It covers the froth/dip leaders; this family runs the same
check on three other BTC/ETH-only daily leads with frozen params:

- ``wick_pressure``: wick_pressure ETH 1d b32ea0f175 (+9.5; candle-shape signal, so the candle boundary matters most);
- ``beta_shift``: beta_shift BTC+ETH 1d 9cbdcbe10d (BTC SMA130 core, all-in ETH while ETH > SMA100, keep 50 %);
- ``duo_core``: duo_core BTC+ETH 1d d61ce6cfc7 (BTC core_dip pair panic + SMA58, ETH macd_days 12/182/35).

On 1h candles it builds daily candles that open at ``hour`` UTC (phase_shift.daily_candles), runs the preset on them
as interval 1d, and puts each decision at the close of that day's last hourly candle; between decisions the targets
are NaN (position left alone). ``hour`` 0 = the native 1d candle. Run on 1h with execution timeoutBars 24.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import get_family
from ._base import frame, market_names, max_weight, normalize_spec, risk_steps, union_index
from .phase_shift import daily_candles

NAME = "hourcheck_a19"
VERSION = 1
TITLE = "Daily BTC/ETH lead with a shifted daily close (close-hour check)"
BOT_READY = False
MULTI_MARKET = True

H_MS = 3_600_000

PRESETS = {
    "wick_pressure": ("wick_pressure", {"combine": "or", "coreLen": 0, "exitAbove": 0, "look": 63,
                                        "reenter": -0.0382, "scope": "own"}),
    "beta_shift": ("beta_shift", {"coreSma": 130, "ethShare": 1, "heat": "eth_sma", "heatLen": 100, "heatThr": 0,
                                  "offWeight": 0.5}),
    "duo_core": ("duo_core", {"btcShare": 0.5, "coreSma": 58, "fastDays": 12, "maxHold": 86, "rsiBelow": 37.3,
                              "rsiPeriod": 25, "sellAbove": 44.6, "signalDays": 35, "slowDays": 182}),
}


def default_params() -> dict:
    return {"preset": "wick_pressure", "hour": 0}


def param_space() -> dict:
    return {
        "preset": {"type": "choice", "values": list(PRESETS),
                   "description": "which BTC/ETH daily lead runs (its params are frozen)"},
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
    daily = {}
    for m in fam.markets_needed(inner):
        if m in candles:
            daily[m], _ = daily_candles(candles[m], hour, 24)
    out = {m: np.full(len(idx), np.nan) for m in markets}
    if not daily or markets[0] not in daily or len(daily[markets[0]]) == 0:
        return frame(idx, out)
    # every market must cover the same days: cut to the days all of them have finished
    last_common = min(int(d.index[-1]) for d in daily.values() if len(d))
    daily = {m: d[d.index <= last_common] for m, d in daily.items()}
    w = fam.targets(daily, inner)
    if len(w) == 0:
        return frame(idx, out)
    dts = np.asarray(w.index, dtype=np.int64) + 23 * H_MS   # close of the day's last hourly candle
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
        inner_ex = fam.explain(inner)
        inner_steps = list(inner_ex.get("howItWorks") or [])[:4]
        wins, loses = inner_ex.get("whenItWins", ""), inner_ex.get("whenItLoses", "")
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
