"""ivr_gate_a06 v1 (agent-06): hold BTC/ETH, step aside while hourly moves cancel out within the day (low intraday
variance ratio).

Intraday variance ratio from hourly log returns over the last ``lookback`` days:

    VR = mean over hours of r_H^2  /  (H * mean over hours of r_1^2)

with r_1 the 1-hour and r_H the (overlapping) ``horizon``-hour log return. VR > 1: hourly moves keep going in the same
direction within the day (intraday trending, one-sided flow); VR < 1: they reverse (choppy, two-sided market).

Unrecorded study (pre-holdout 2019-03..2025-09, decided daily): the 30-day VR(24h/1h) rank-correlates positively with
the next 30 days' return in 5/7 years on BTC and 6/7 on ETH (IC up to +0.3..+0.5), while the daily-bar VR (#327,
vr_switch) and the intraday path efficiency (#473) did not. Hypothesis: choppy intraday markets precede weak months.

Signal at each daily decision: VR's percentile rank among the last ``rankLen`` daily values (past and current only).
``side="high"`` steps aside when the rank falls under ``exitRank`` and buys back above ``enterRank``;
``side="low"`` is the mirror (ablation). Optional daily SMA core on the decision closes ("and" = filter, "or" =
either keeps it in). Decides once per day at the close of the hour that ends at ``decideHour`` UTC (built-in
close-hour check). Made for 1h candles (any intraday bar works; horizon is in bars).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..data import INTERVAL_MS
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "ivr_gate_a06"
VERSION = 1
TITLE = "Hold, step aside while the intraday market is choppy (low variance ratio)"
BOT_READY = False
MULTI_MARKET = False

DAY_MS = 86_400_000
HOUR_MS = 3_600_000


def default_params() -> dict:
    return {"horizon": 24, "lookback": 30, "rankLen": 365, "exitRank": 0.3, "enterRank": 0.4, "side": "high",
            "trendSma": 0, "combine": "and", "decideHour": 0}


def param_space() -> dict:
    return {
        "horizon": {"type": "int", "min": 2, "max": 96, "log": True,
                    "description": "bars of the long return compared with 1-bar returns (24 on 1h = one day)"},
        "lookback": {"type": "int", "min": 5, "max": 180, "log": True,
                     "description": "days of bars the variance ratio is measured over"},
        "rankLen": {"type": "int", "min": 60, "max": 730, "log": True,
                    "description": "days of past daily values the current value is ranked against"},
        "exitRank": {"type": "float", "min": 0.05, "max": 0.6,
                     "description": "step aside when the percentile rank falls below this"},
        "enterRank": {"type": "float", "min": 0.05, "max": 0.8,
                      "description": "buy back once the rank rises above this (>= exitRank)"},
        "side": {"type": "choice", "values": ["high", "low"],
                 "description": "high = hold while intraday moves persist (VR high); low = mirror (ablation)"},
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
    """(decision bar indices, variance ratio at each of them; NaN until a full lookback exists)."""
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    bar_ms = _bar_ms(ts, interval)
    H = int(p["horizon"])
    lc = np.log(c)
    r1 = np.zeros(n)
    rh = np.zeros(n)
    ok1 = np.zeros(n, dtype=bool)
    okh = np.zeros(n, dtype=bool)
    if n > 1:
        r1[1:] = lc[1:] - lc[:-1]
        ok1[1:] = True
    if n > H:
        rh[H:] = lc[H:] - lc[:-H]
        okh[H:] = True
    ok1 &= np.isfinite(r1)
    okh &= np.isfinite(rh)
    r1[~ok1] = 0.0
    rh[~okh] = 0.0
    cs1 = np.concatenate([[0.0], np.cumsum(r1 * r1)])
    csh = np.concatenate([[0.0], np.cumsum(rh * rh)])
    cn1 = np.concatenate([[0], np.cumsum(ok1)])
    cnh = np.concatenate([[0], np.cumsum(okh)])
    span = int(p["lookback"]) * DAY_MS
    if bar_ms >= DAY_MS:     # daily or coarser bars: decide on every bar (decideHour needs intraday bars)
        dec = np.ones(n, dtype=bool)
    else:
        dec = ((ts + bar_ms) % DAY_MS) == (int(p["decideHour"]) % 24) * HOUR_MS
    idx = np.nonzero(dec)[0]
    j = np.searchsorted(ts, ts[idx] + bar_ms - span, side="left")
    full = ts[idx] + bar_ms - span >= ts[0]
    n1 = cn1[idx + 1] - cn1[j]
    nh = cnh[idx + 1] - cnh[j]
    v1 = (cs1[idx + 1] - cs1[j]) / np.maximum(n1, 1)
    vh = (csh[idx + 1] - csh[j]) / np.maximum(nh, 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        vr = vh / (H * v1)
    vr = np.where(full & (n1 > H) & (nh > 0) & (v1 > 0), vr, np.nan)
    return idx, vr


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    idx, sig = daily_signal(df, p, spec.get("interval"))
    if p.get("side", "high") == "low":
        sig = -sig
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
    # hold the last decision between decision bars (re-emitted every bar, so missed limits retry)
    w = pd.Series(w).ffill().to_numpy()
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p = spec["params"]
    mk = market_names(spec)
    hi = p.get("side", "high") == "high"
    steps = [f"Once a day at {int(p['decideHour']):02d}:00 UTC it measures, over the last {p['lookback']} days, whether "
             f"hourly price moves kept going the same way within {p['horizon']} hours or cancelled each other out "
             "(the intraday variance ratio).",
             f"It compares that with the last {p['rankLen']} days. While it holds {mk} and the value drops into the "
             f"lowest {p['exitRank'] * 100:.0f} % of that range "
             + ("(a choppy market where moves keep reversing)" if hi else "(an unusually one-sided market)")
             + ", it sells.",
             f"It buys back once the value is above the {p['enterRank'] * 100:.0f} % mark again."]
    if p.get("trendSma"):
        if p["combine"] == "and":
            steps.append(f"It also holds only while the price is above its {p['trendSma']}-day average.")
        else:
            steps.append(f"While the price is above its {p['trendSma']}-day average it holds anyway.")
    return {
        "summary": f"Holds {mk}, but steps aside while the market is choppy within the day."
        if hi else f"Holds {mk}, but steps aside while hourly moves are unusually one-sided.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Months that follow choppy, two-sided trading, if they tend to be weak.",
        "whenItLoses": "Rallies that start from a choppy market: it is out when they begin.",
    }
