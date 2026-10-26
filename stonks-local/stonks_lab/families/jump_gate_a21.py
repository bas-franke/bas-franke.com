"""jump_gate_a21 v1 (agent-21): hold BTC/ETH, step aside while price moves are smooth and continuous (low jump share).

Realized-volatility idea (Barndorff-Nielsen & Shephard bipower variation). From hourly log returns r over the last
``lookback`` days:

    RV = sum r_t^2                         total variance
    BV = pi/2 * sum |r_t| |r_{t-1}|        variance of the continuous part (robust to isolated jumps)
    jump share J = 1 - BV / RV             share of the variance that came from isolated hourly spikes

Unrecorded study (pre-holdout 2019-06..2025-09, 1h -> daily, trailing-365d rank terciles): when the 30-day jump
share is in its LOW tercile (variance from steady, persistent hourly moves, i.e. a grinding sell-off or melt) the next
30 days were weak: ETH +1.0 % vs +6.7/+5.7 % in the other terciles, hi-minus-lo positive in 5/6 years; BTC 4/6.

Signal at each daily decision: J's percentile rank among the last ``rankLen`` daily values (past and current only).
Step aside when the rank falls under ``exitRank``; buy back once it rises above ``enterRank`` (>= exitRank).

``mode="vol"`` is the ablation: the same rank rule on minus the realized variance (so 'low rank' = high volatility),
to show whether J only proxies plain volatility. Optional daily SMA core on the decision closes ("and" = filter,
"or" = either keeps it in, "none" = gate on plain holding). It decides once per day at the close of the hour that
ends at ``decideHour`` UTC (built-in close-hour check). Made for 1h candles.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..data import INTERVAL_MS
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "jump_gate_a21"
VERSION = 1
TITLE = "Hold, step aside while moves are smooth (low jump share)"
BOT_READY = False
MULTI_MARKET = False

DAY_MS = 86_400_000
HOUR_MS = 3_600_000


def default_params() -> dict:
    return {"mode": "jump", "lookback": 30, "rankLen": 365, "exitRank": 0.33, "enterRank": 0.4,
            "trendSma": 0, "combine": "and", "decideHour": 0}


def param_space() -> dict:
    return {
        "mode": {"type": "choice", "values": ["jump", "vol"],
                 "description": "jump = jump share 1 - BV/RV; vol = minus realized variance (ablation)"},
        "lookback": {"type": "int", "min": 5, "max": 120, "log": True,
                     "description": "days of hourly returns the jump share is measured over"},
        "rankLen": {"type": "int", "min": 60, "max": 730, "log": True,
                    "description": "days of past daily values the current value is ranked against"},
        "exitRank": {"type": "float", "min": 0.05, "max": 0.6,
                     "description": "step aside when the percentile rank falls below this"},
        "enterRank": {"type": "float", "min": 0.05, "max": 0.8,
                      "description": "buy back once the rank rises above this (>= exitRank)"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                     "description": "daily SMA core in days (0 = off, plain holding is the base)"},
        "combine": {"type": "choice", "values": ["and", "or"],
                    "description": "and = need gate and close > SMA; or = either one keeps it in"},
        "decideHour": {"type": "int", "min": 0, "max": 23,
                       "description": "UTC hour (candle close) at which the daily decision is made"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["enterRank"]) < float(p["exitRank"]):
        return "enterRank must be >= exitRank"
    return None


def warmup(p: dict) -> int:
    return 24 * (int(p["lookback"]) + max(int(p["rankLen"]) // 3, int(p["trendSma"] or 0)) + 2)


def _bar_ms(index: np.ndarray, interval: str | None) -> int:
    if interval in INTERVAL_MS:
        return int(INTERVAL_MS[interval])
    if len(index) > 1:
        return int(np.median(np.diff(index)))
    return HOUR_MS


def daily_signal(df, p: dict, interval: str | None) -> tuple[np.ndarray, np.ndarray]:
    """(decision bar indices, raw signal at each of them; NaN until a full lookback exists)."""
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    bar_ms = _bar_ms(ts, interval)
    r = np.zeros(n)
    if n > 1:
        r[1:] = np.log(c[1:] / c[:-1])
    r[~np.isfinite(r)] = 0.0
    a = np.abs(r)
    bp = np.zeros(n)
    bp[1:] = a[1:] * a[:-1]
    cs_rv = np.concatenate([[0.0], np.cumsum(r * r)])
    cs_bp = np.concatenate([[0.0], np.cumsum(bp)])
    span = int(p["lookback"]) * DAY_MS
    dec = ((ts + bar_ms) % DAY_MS) == (int(p["decideHour"]) % 24) * HOUR_MS
    idx = np.nonzero(dec)[0]
    j = np.searchsorted(ts, ts[idx] + bar_ms - span, side="left")
    full = ts[idx] + bar_ms - span >= ts[0]
    j = np.maximum(j, 2)  # first bipower term needs two returns
    rv = cs_rv[idx + 1] - cs_rv[j]
    bv = (cs_bp[idx + 1] - cs_bp[j]) * np.pi / 2
    with np.errstate(invalid="ignore", divide="ignore"):
        sig = 1.0 - bv / rv if p["mode"] == "jump" else -rv
    sig = np.where(full & (rv > 0), sig, np.nan)
    return idx, sig


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    idx, sig = daily_signal(df, p, spec.get("interval"))
    rl = int(p["rankLen"])
    rank = pd.Series(sig).rolling(rl, min_periods=max(20, rl // 3)).rank(pct=True).to_numpy()
    ts_len = int(p["trendSma"] or 0)
    sma = np.full(len(idx), np.nan)
    if ts_len and len(idx) >= ts_len:
        sma = pd.Series(c[idx]).rolling(ts_len).mean().to_numpy()
    lo, hi = float(p["exitRank"]), float(p["enterRank"])
    both = p["combine"] == "and"
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    state = None
    for k, i in enumerate(idx):
        if not np.isfinite(rank[k]) or (ts_len and not np.isfinite(sma[k])):
            continue
        if state is None:
            state = rank[k] >= lo
        elif state and rank[k] < lo:
            state = False
        elif not state and rank[k] > hi:
            state = True
        if ts_len:
            core = c[i] > sma[k]
            on = (state and core) if both else (state or core)
        else:
            on = state
        w[i] = mw if on else 0.0
    # hold the last decision between decision bars
    w = pd.Series(w).ffill().to_numpy()
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p = spec["params"]
    mk = market_names(spec)
    what = ("how much of the last {lb} days' hourly price movement came from a few sudden jumps rather than steady, "
            "continuous moves" if p["mode"] == "jump" else "how volatile the last {lb} days were (hourly moves)")
    steps = [f"Once a day at {int(p['decideHour']):02d}:00 UTC it measures " + what.format(lb=p["lookback"]) + ".",
             f"It compares that with the last {p['rankLen']} days. While it holds {mk} and the value drops into the "
             f"lowest {p['exitRank'] * 100:.0f} % of that range"
             + (" (smooth, persistent moves: a grinding sell-off or melt)" if p["mode"] == "jump" else
                " (unusually high volatility)") + ", it sells.",
             f"It buys back once the value is above the {p['enterRank'] * 100:.0f} % mark again."]
    if p.get("trendSma"):
        if p["combine"] == "and":
            steps.append(f"It also holds only while the price is above its {p['trendSma']}-day average.")
        else:
            steps.append(f"While the price is above its {p['trendSma']}-day average it holds anyway.")
    return {
        "summary": f"Holds {mk}, but steps aside while the price moves in a smooth, persistent way.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long grinding sell-offs, where the price falls hour after hour without sharp spikes.",
        "whenItLoses": "Steady rallies that also look smooth: it can step out of a healthy uptrend.",
    }
