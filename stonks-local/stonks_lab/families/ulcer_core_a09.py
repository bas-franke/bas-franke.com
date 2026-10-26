"""ulcer_core_a09 v1 (agent-09): SMA trend core plus buys after long, deep pain (high Ulcer Index).

Signal study behind it (agent-09, unrecorded, 1d pre-holdout, forward 30 d): when the Ulcer Index (root mean square
of the % drawdown from the running ``look``-day high, over the last ``look`` days) is in the top 20 % of its own
trailing year, BTC gains +5.1 / +6.9 % (look 60/120) vs +3.1 / +3.6 % on all days, ETH +7.0 / +7.9 % vs +3.7 / +4.3 %.
Unlike a plain drawdown depth it also measures how LONG the market has been under water (on ETH the part of the
Ulcer Index not explained by depth still ranked forward returns in 6/7 years). An SMA core sits in euros exactly
then; this family buys back into that pain for a fixed time.

- ui_t = sqrt(mean over ``look`` bars of (close / rolling-``look`` max - 1)^2); rank_t = share of the last
  ``rankLen`` bars with ui <= ui_t (trailing, inclusive of today).
- pain trigger: rank_t >= ``rankMin`` -> hold for ``holdBars`` bars (re-triggers extend it).
- hold while close > SMA(``coreSma``) OR inside a pain window. ``coreSma`` 0 = pain buys only (cash base).
- ``dayHour`` (only on 1h candles): daily candles closing at that UTC hour, one decision a day (close-hour check,
  finding #505); ignored on other intervals.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from .osc_core_a09 import daily_candles
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "ulcer_core_a09"
VERSION = 1
TITLE = "Trend core plus buys after long, deep drawdowns (Ulcer Index)"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"look": 60, "rankLen": 365, "rankMin": 0.8, "holdBars": 30, "coreSma": 130, "dayHour": 0}


def param_space() -> dict:
    return {
        "look": {"type": "int", "min": 14, "max": 250, "log": True,
                 "description": "window of the Ulcer Index (running high and averaging) in candles"},
        "rankLen": {"type": "int", "min": 90, "max": 730, "log": True,
                    "description": "trailing window in which today's Ulcer Index is ranked"},
        "rankMin": {"type": "float", "min": 0.5, "max": 0.99,
                    "description": "buy when the Ulcer Index is at least this high a share of its trailing range"},
        "holdBars": {"type": "int", "min": 5, "max": 150, "log": True,
                     "description": "candles a pain buy is held"},
        "coreSma": {"type": "int", "min": 0, "max": 250, "zero": True,
                    "description": "SMA trend core (0 = no core, pain buys only)"},
        "dayHour": {"type": "int", "min": 0, "max": 23,
                    "description": "on 1h candles only: UTC hour at which the daily candles close (decision hour)"},
    }


def warmup(p: dict) -> int:
    return max(2 * int(p["look"]) + int(p["rankLen"]) // 3, int(p["coreSma"]))


def ulcer(c: np.ndarray, look: int) -> np.ndarray:
    hi = ind.rolling_max(c, look)
    dd2 = (c / hi - 1.0) ** 2
    return np.sqrt(ind.sma(dd2, look))


def trailing_rank(x: np.ndarray, n: int) -> np.ndarray:
    """Share of the last n values (incl. today) that are <= today; NaN until n/3 finite values exist."""
    s = pd.Series(x)
    r = s.rolling(n, min_periods=max(10, n // 3)).rank(pct=False)
    cnt = s.rolling(n, min_periods=max(10, n // 3)).count()
    return (r / cnt).to_numpy(np.float64)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    mw = max_weight(spec)
    if spec.get("interval") != "1h":
        return frame(df.index, {m: weights(df["close"].to_numpy(np.float64), p) * mw})
    idx = np.asarray(df.index, dtype=np.int64)
    d, last = daily_candles(df, int(p.get("dayHour", 0)) % 24)
    w = weights(d["close"].to_numpy(np.float64), p) if len(d) else np.zeros(0)
    out = np.full(len(idx), np.nan)
    pos = np.searchsorted(idx, last, side="left")
    ok = (pos < len(idx)) & np.isfinite(w)
    out[pos[ok]] = w[ok] * mw
    return frame(idx, {m: out})


def weights(c: np.ndarray, p: dict) -> np.ndarray:
    ui = ulcer(c, int(p["look"]))
    rk = trailing_rank(ui, int(p["rankLen"]))
    hold = int(p["holdBars"])
    rmin = float(p["rankMin"])
    pain = np.full(len(c), np.nan)
    left = 0
    for i in range(len(c)):
        r = rk[i]
        if r != r:
            continue
        if r >= rmin and ui[i] > 0:
            left = hold
        pain[i] = 1.0 if left > 0 else 0.0
        if left > 0:
            left -= 1
    g = int(p["coreSma"])
    if g > 0:
        sm = ind.sma(c, g)
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
        w = np.fmax(core, pain)
        w[~np.isfinite(core) | ~np.isfinite(pain)] = np.nan
    else:
        w = pain
    return w


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    steps = []
    if int(p["coreSma"]) > 0:
        steps.append(f"It holds {mk} while the price is above its average over {bars_text(p['coreSma'], iv)}.")
    steps += [f"It measures how deep and how long {mk} has been under its high of the last "
              f"{bars_text(p['look'], iv)} (the Ulcer Index).",
              f"When that pain is in the top {100 - float(p['rankMin']) * 100:.0f} % of the last "
              f"{bars_text(p['rankLen'], iv)}, it buys and holds for {bars_text(p['holdBars'], iv)}."]
    return {
        "summary": f"Follows the trend of {mk}, and also buys after long, deep drawdowns for a fixed time.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bear markets that end in a long grind down: it is back in before the trend line turns up.",
        "whenItLoses": "Drawdowns that keep going (2018, 2022): the pain buys catch falling prices.",
    }
