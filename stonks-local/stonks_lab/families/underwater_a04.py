"""underwater_a04 v1 (agent-04): SMA trend core plus buys while most of the past year's turnover is under water.

On-chain analysts watch "percent of supply in loss": when most coins last changed hands above today's price, recent
buyers are under water and capitulating, and forward returns have been high. We have no on-chain data, but every
Bitvavo candle says how many euros changed hands at roughly what price. This family uses the share of the trailing
``look`` candles' EUR turnover that traded above today's close (a "turnover in loss" proxy). Unlike cost_basis (the
MEAN entry price) it is a distribution statistic, and unlike a drawdown depth or the Ulcer Index it weights each
past day by how much traded then.

Signal study (agent-04, unrecorded, 1d pre-holdout 2019-2025, fwd 30 d within-year rank IC): the share correlates
0.88-0.98 with the drawdown from the ``look``-day high. On BTC with look 365 the part NOT explained by drawdown
ranked forward returns in 5/6 years (+.21..+.46, 2024 -.05); on ETH it flips (2025 -.55). ``weighting = "equal"``
counts days instead of euros: the paired ablation that tells whether the volume weighting adds anything.

- su_t = sum(turnover_i * [typical_i > close_t]) / sum(turnover_i) over the last ``look`` candles (i <= t),
  turnover_i = volume_i * typical_i (equal: 1), typical = (high + low + close) / 3.
- trigger: su_t >= ``suMin`` -> hold for ``holdBars`` candles (re-triggers extend it).
- hold while close > SMA(``coreSma``) OR inside a trigger window. ``coreSma`` 0 = underwater buys only.
- ``dayHour`` (only on 1h candles): daily candles closing at that UTC hour, one decision a day (close-hour check,
  finding #505); ignored on other intervals.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from .osc_core_a09 import daily_candles
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "underwater_a04"
VERSION = 1
TITLE = "Trend core plus buys while most recent turnover is under water"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"look": 365, "suMin": 0.8, "holdBars": 30, "weighting": "volume", "coreSma": 130, "dayHour": 0}


def param_space() -> dict:
    return {
        "look": {"type": "int", "min": 30, "max": 730, "log": True,
                 "description": "candles of past turnover compared with today's close"},
        "suMin": {"type": "float", "min": 0.5, "max": 0.99,
                  "description": "buy when at least this share of that turnover traded above today's close"},
        "holdBars": {"type": "int", "min": 1, "max": 150, "log": True,
                     "description": "candles an underwater buy is held (re-triggers extend it)"},
        "weighting": {"type": "choice", "values": ["volume", "equal"],
                      "description": "volume: weight past candles by EUR turnover; equal: count candles (ablation)"},
        "coreSma": {"type": "int", "min": 0, "max": 250, "zero": True,
                    "description": "SMA trend core (0 = no core, underwater buys only)"},
        "dayHour": {"type": "int", "min": 0, "max": 23,
                    "description": "on 1h candles only: UTC hour at which the daily candles close (decision hour)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["look"]), int(p["coreSma"]))


def underwater_share(df, look: int, weighting: str) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    tp = ((df["high"] + df["low"] + df["close"]) / 3.0).to_numpy(np.float64)
    if weighting == "volume":
        w = df["volume"].to_numpy(np.float64) * tp
    else:
        w = np.ones(len(c))
    w = np.where(np.isfinite(w), w, 0.0)
    out = np.full(len(c), np.nan)
    for t in range(look - 1, len(c)):
        ww = w[t - look + 1:t + 1]
        tot = ww.sum()
        if tot > 0:
            out[t] = ww[tp[t - look + 1:t + 1] > c[t]].sum() / tot
    return out


def weights(df, p: dict) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    su = underwater_share(df, int(p["look"]), str(p.get("weighting", "volume")))
    hold, smin = int(p["holdBars"]), float(p["suMin"])
    buy = np.full(len(c), np.nan)
    left = 0
    for i in range(len(c)):
        s = su[i]
        if s != s:
            continue
        if s >= smin:
            left = hold
        buy[i] = 1.0 if left > 0 else 0.0
        if left > 0:
            left -= 1
    g = int(p["coreSma"])
    if g > 0:
        sm = ind.sma(c, g)
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
        w = np.fmax(core, buy)
        w[~np.isfinite(core) | ~np.isfinite(buy)] = np.nan
        return w
    return buy


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    mw = max_weight(spec)
    if spec.get("interval") != "1h":
        return frame(df.index, {m: weights(df, p) * mw})
    idx = np.asarray(df.index, dtype=np.int64)
    d, last = daily_candles(df, int(p.get("dayHour", 0)) % 24)
    w = weights(d, p) if len(d) else np.zeros(0)
    out = np.full(len(idx), np.nan)
    pos = np.searchsorted(idx, last, side="left")
    ok = (pos < len(idx)) & np.isfinite(w)
    out[pos[ok]] = w[ok] * mw
    return frame(idx, {m: out})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    what = "euros traded" if p.get("weighting", "volume") == "volume" else "days"
    steps = []
    if int(p["coreSma"]) > 0:
        steps.append(f"It holds {mk} while the price is above its average over {bars_text(p['coreSma'], iv)}.")
    steps += [f"Every day it checks which share of the {what} of the last {bars_text(p['look'], iv)} traded above "
              f"today's price, i.e. how many recent buyers are under water.",
              f"When that share is at least {float(p['suMin']) * 100:.0f} %, it buys and holds for "
              f"{bars_text(p['holdBars'], iv)}."]
    return {
        "summary": f"Follows the trend of {mk}, and also buys when most recent buyers are sitting on a loss.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bear markets that end in capitulation: it is back in before the trend line turns up.",
        "whenItLoses": "Long bear markets (2022): the underwater buys catch falling prices again and again.",
    }
