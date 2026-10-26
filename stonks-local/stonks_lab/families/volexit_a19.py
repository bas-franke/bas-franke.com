"""volexit_a19 v1 (agent-19): SMA trend core whose exit needs HEAVY selling (turnover-confirmed breakdown).

Idea: most whipsaw sales of an SMA core happen on quiet dips just under the average; real breakdowns (2018, 2021-22,
2022 FTX) came with heavy EUR turnover. So the core buys like a plain SMA core but sells only when the close is under
the average AND the recent turnover is high versus its own past (volume confirms the breakdown). ``maxBelow`` is a
fail-safe: after that many candles under the average it sells anyway (quiet grinding bears). volMult 0 = plain core
(the paired control).

Per coin, at the bar close t (candles up to and including t only):
- turnover_i = close_i * volume_i (EUR); recent_t = mean of turnover over the last ``volLook`` candles (incl. t);
  base_t = median of turnover over the ``baseLook`` candles before those; ratio_t = recent_t / base_t.
- close > SMA(coreLen): in (and the below-counter resets).
- close <= SMA: while in, sell when ratio_t >= volMult, or after ``maxBelow`` candles under the average (0 = never).
  Once out it stays out until the close is above the average again.
weight = maxWeight / len(markets) while in, else 0.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "volexit_a19"
VERSION = 1
TITLE = "Trend core that sells only on heavy-volume breakdowns"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"coreLen": 100, "volLook": 7, "baseLook": 90, "volMult": 1.3, "maxBelow": 0}


def param_space() -> dict:
    return {
        "coreLen": {"type": "int", "min": 10, "max": 400, "log": True, "description": "SMA core length in candles"},
        "volLook": {"type": "int", "min": 1, "max": 60, "log": True,
                    "description": "recent turnover = mean over this many candles"},
        "baseLook": {"type": "int", "min": 20, "max": 365, "log": True,
                     "description": "normal turnover = median over this many candles before the recent window"},
        "volMult": {"type": "float", "min": 0.5, "max": 3.0, "zero": True,
                    "description": "sell under the average only when recent turnover >= this x normal (0 = plain core)"},
        "maxBelow": {"type": "int", "min": 3, "max": 120, "zero": True, "log": True,
                     "description": "sell anyway after this many candles under the average (0 = never)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["coreLen"]), int(p["volLook"]) + int(p["baseLook"]))


def turnover_ratio(close: np.ndarray, volume: np.ndarray, vol_look: int, base_look: int) -> np.ndarray:
    t = pd.Series(np.asarray(close, dtype=np.float64) * np.asarray(volume, dtype=np.float64))
    recent = t.rolling(vol_look, min_periods=vol_look).mean()
    base = t.shift(vol_look).rolling(base_look, min_periods=base_look).median()
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.array((recent / base).to_numpy(np.float64), copy=True)
    r[~np.isfinite(r)] = np.nan
    return r


def run_state(close, sma, ratio, vol_mult: float, max_below: int) -> np.ndarray:
    out = np.full(len(close), np.nan)
    state, below = 0.0, 0
    for i in range(len(close)):
        c, s, r = close[i], sma[i], ratio[i]
        if not (np.isfinite(c) and np.isfinite(s)) or (vol_mult > 0 and not np.isfinite(r)):
            continue
        if c > s:
            state, below = 1.0, 0
        else:
            below += 1
            if state == 1.0 and ((vol_mult <= 0 or r >= vol_mult) or (max_below > 0 and below >= max_below)):
                state = 0.0
        out[i] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("volexit_a19 needs at least one market")
    idx = union_index(candles, markets)
    core, vl, bl = int(p["coreLen"]), int(p["volLook"]), int(p["baseLook"])
    vm, mb = float(p.get("volMult") or 0.0), int(p.get("maxBelow") or 0)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        own = np.asarray(df.index, dtype=np.int64)
        c = df["close"].to_numpy(np.float64)
        v = df["volume"].to_numpy(np.float64)
        sig = run_state(c, ind.sma(c, core), turnover_ratio(c, v, vl, bl), vm, mb)
        cols[m] = pd.Series(sig * each, index=own).reindex(idx).to_numpy(np.float64)
    out = frame(idx, cols)
    if len(markets) > 1:
        any_ok = out.notna().any(axis=1).to_numpy()
        out = out.ffill().fillna(0.0)
        out[~any_ok] = np.nan
    return out


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    vm, mb = float(p.get("volMult") or 0.0), int(p.get("maxBelow") or 0)
    steps = [f"After every {iv} candle it compares the close with its {bars_text(p['coreLen'], iv)} average and buys "
             f"when the price is above it."]
    if vm > 0:
        steps.append(f"Under the average it sells only when the euro turnover of the last {bars_text(p['volLook'], iv)} "
                     f"is at least {vm:.1f} times the usual level (median of the {bars_text(p['baseLook'], iv)} "
                     f"before): a breakdown on heavy selling. Quiet dips under the average are sat out.")
    else:
        steps.append("It sells as soon as the price closes under the average (plain trend core).")
    if mb:
        steps.append(f"After {bars_text(mb, iv)} under the average it sells anyway.")
    if len(spec.get("markets") or []) > 1:
        steps.append(f"Each coin decides on its own; the money is split evenly between {mk}.")
    return {
        "summary": f"Holds {mk} in uptrends and sells only when a drop under the trend comes with heavy trading.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Bull markets with quiet pullbacks under the average, which a plain trend core would sell.",
        "whenItLoses": "Slow, quiet bear markets (it sells late) and crashes on thin weekend volume.",
    }
