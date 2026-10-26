"""skipmom_a19 v1 (agent-19): time-series momentum that SKIPS the most recent candles.

Idea (equity "12-1" momentum): the return of the last few weeks tends to reverse while the return before it tends to
continue, so classic momentum is measured from N candles ago up to S candles ago, skipping the latest S. Applied as a
time-series (own-coin) trend rule on BTC/ETH: hold while that older return is positive.

Per coin, at the bar close t (closes up to and including t only):
- m_t = ln(close[t - skip] / close[t - look])          (skip = 0 is plain N-bar momentum, the paired control)
- state: buy when m_t > band, sell when m_t < -band, otherwise unchanged (band = 0: sign of m_t).
weight = maxWeight / len(markets) while in, else 0. NaN before ``look`` candles of the coin.
"""
from __future__ import annotations

import numpy as np

from ._base import aligned_close, bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "skipmom_a19"
VERSION = 1
TITLE = "Skip-recent momentum (12-1 style)"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"look": 120, "skip": 14, "band": 0.0}


def param_space() -> dict:
    return {
        "look": {"type": "int", "min": 10, "max": 500, "log": True,
                 "description": "momentum is measured from this many candles ago"},
        "skip": {"type": "int", "min": 1, "max": 120, "zero": True, "log": True,
                 "description": "... up to this many candles ago (the most recent ones are skipped; 0 = none)"},
        "band": {"type": "float", "min": 0.0, "max": 0.2, "zero": True,
                 "description": "hysteresis: buy above +band log return, sell below -band"},
    }


def valid_params(p: dict) -> str | None:
    return None if int(p["skip"]) < int(p["look"]) else "skip must be smaller than look"


def warmup(p: dict) -> int:
    return int(p["look"]) + 1


def skip_momentum(close: np.ndarray, look: int, skip: int) -> np.ndarray:
    c = np.asarray(close, dtype=np.float64)
    out = np.full(len(c), np.nan)
    if len(c) > look:
        with np.errstate(divide="ignore", invalid="ignore"):
            out[look:] = np.log(c[look - skip:len(c) - skip] / c[:len(c) - look])
    return out


def hysteresis(m: np.ndarray, band: float) -> np.ndarray:
    out = np.full(len(m), np.nan)
    state = 0.0
    for i, x in enumerate(m):
        if not np.isfinite(x):
            continue
        if x > band:
            state = 1.0
        elif x < -band:
            state = 0.0
        out[i] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("skipmom_a19 needs at least one market")
    idx = union_index(candles, markets)
    look, skip, band = int(p["look"]), int(p.get("skip") or 0), float(p.get("band") or 0.0)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        sig = hysteresis(skip_momentum(c, look, skip), band)
        ok = np.isfinite(sig) & np.isfinite(c)
        cols[m] = np.where(ok, sig * each, np.nan)
    df = frame(idx, cols)
    if len(markets) > 1:
        any_ok = df.notna().any(axis=1).to_numpy()
        df = df.fillna(0.0)
        df[~any_ok] = np.nan
    return df


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    skip = int(p.get("skip") or 0)
    window = (f"from {bars_text(p['look'], iv)} ago up to {bars_text(skip, iv)} ago, ignoring the most recent "
              f"{bars_text(skip, iv)}") if skip else f"over the last {bars_text(p['look'], iv)}"
    band = float(p.get("band") or 0.0)
    rule = (f"It buys when that move is up by more than {pct(band)} and sells when it is down by more than "
            f"{pct(band)}." if band else "It holds while that move is up and sells while it is down.")
    steps = [f"After every {iv} candle it measures the price change {window}.", rule]
    if len(spec.get("markets") or []) > 1:
        steps.append(f"Each coin decides on its own; the money is split evenly between {mk}.")
    return {
        "summary": f"Holds {mk} while the medium-term trend, measured without the latest weeks, is up; euros otherwise.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Long trends with short counter-moves: a sharp recent dip or spike does not flip the signal.",
        "whenItLoses": "Sudden crashes (it reacts late, by design) and sideways markets where the older return keeps "
                       "changing sign.",
    }
