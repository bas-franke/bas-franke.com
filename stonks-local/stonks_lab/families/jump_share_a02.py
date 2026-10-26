"""jump_share_a02 v1 (agent-02): hold BTC/ETH while price variance comes in jumps, step aside while it is diffusive.

Realized-variance decomposition on hourly candles (Barndorff-Nielsen & Shephard): over each 24-hour day,

    RV = sum r_h^2                      (all variance)
    BV = pi/2 * sum |r_h| |r_(h-1)|      (bipower variation: the continuous, hour-to-hour clustered part)
    jump share s = max(RV - BV, 0) / RV  (share of the day's variance that came as isolated jumps)

Unrecorded study (agent-02, 1h 2019-03..2025-10, pre-holdout): the jumpLen-day mean of s, ranked against its own
trailing year, orders the forward month. Lowest third (variance arriving as sustained, clustered hour-after-hour
moves) BTC +1.7 %/30 d vs +5.0 % top third (L14, hi-lo > 0 in 7/7 years); ETH -1.8 % vs +8.3 % (L30, 6/7 years). The
plain level of realized volatility does not order returns (3/7 years), so this is not a vol filter.

Rule (one decision per day at the close of the hour ending at decideHour UTC):
- J_t = mean of the last jumpLen daily jump shares, rank_t = percentile of J_t among the last rankLen daily values
  (expanding until rankLen days exist, at least 60).
- in while rank_t > exitRank; after leaving, back in once rank_t > enterRank (enterRank >= exitRank: hysteresis).
- out = offWeight of maxWeight stays held (0 = all euros).
- lagDays > 0 (placebo): the rank from lagDays decisions earlier, same on/off structure but stale timing.
- optional daily SMA core (trendSma days on the decision closes): "or" = the core also keeps it in; "and" = needs
  both. mode "hold" ablation: no jump gate at all (core or plain hold) for paired comparisons.
Made for 1h candles (works on 15m-4h). Decisions at bar t use candles up to and including bar t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..data import INTERVAL_MS
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "jump_share_a02"
VERSION = 1
TITLE = "Jump-share gate (hold while volatility comes in isolated jumps)"
BOT_READY = False
MULTI_MARKET = False

DAY_MS = 86_400_000
HOUR_MS = 3_600_000


def default_params() -> dict:
    return {"mode": "jump", "jumpLen": 30, "rankLen": 365, "exitRank": 0.33, "enterRank": 0.4, "offWeight": 0.0,
            "trendSma": 0, "combine": "or", "decideHour": 0, "lagDays": 0}


def param_space() -> dict:
    return {
        "mode": {"type": "choice", "values": ["jump", "hold"],
                 "description": "jump = jump-share gate; hold = ablation without the gate (plain hold or the SMA core)"},
        "jumpLen": {"type": "int", "min": 5, "max": 120, "log": True,
                    "description": "days over which the daily jump share is averaged"},
        "rankLen": {"type": "int", "min": 90, "max": 1000, "log": True,
                    "description": "days of history the averaged jump share is ranked against"},
        "exitRank": {"type": "float", "min": 0.0, "max": 0.7,
                     "description": "step aside when the jump-share rank falls to this percentile or below"},
        "enterRank": {"type": "float", "min": 0.0, "max": 0.9,
                      "description": "buy back once the rank rises above this percentile (>= exitRank)"},
        "offWeight": {"type": "float", "min": 0.0, "max": 0.8,
                      "description": "share of maxWeight kept while stepped aside (0 = all euros)"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                     "description": "daily SMA core in days combined with the gate (0 = off)"},
        "combine": {"type": "choice", "values": ["or", "and"],
                    "description": "or = the SMA core also keeps it in; and = needs both gate and close > SMA"},
        "decideHour": {"type": "int", "min": 0, "max": 23,
                       "description": "UTC hour (candle close) at which the daily decision is made"},
        "lagDays": {"type": "int", "min": 0, "max": 400, "zero": True,
                    "description": "placebo: use the jump-share rank from this many days earlier (0 = real signal; "
                                   "60-400 = a stale signal with the same on/off structure, for luck checks)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["enterRank"]) < float(p["exitRank"]):
        return "enterRank must be >= exitRank"
    return None


def warmup(p: dict) -> int:
    return 24 * (max(int(p["jumpLen"]) + 60 + int(p.get("lagDays", 0) or 0), int(p["trendSma"] or 0)) + 2)


def _bar_ms(index: np.ndarray, interval: str | None) -> int:
    if interval in INTERVAL_MS:
        return int(INTERVAL_MS[interval])
    if len(index) > 1:
        return int(np.median(np.diff(index)))
    return HOUR_MS


def daily_jump_share(ts: np.ndarray, c: np.ndarray, bar_ms: int, dec_idx: np.ndarray) -> np.ndarray:
    """Jump share of the 24 h ending at each decision bar (NaN when the day has too few bars or no variance)."""
    n = len(c)
    r = np.zeros(n)
    with np.errstate(invalid="ignore", divide="ignore"):
        r[1:] = np.log(c[1:] / c[:-1])
    r[~np.isfinite(r)] = 0.0
    adj = np.zeros(n, dtype=bool)
    adj[1:] = np.diff(ts) == bar_ms                       # bar i follows bar i-1 directly
    r = np.where(adj, r, 0.0)                              # no return across a gap
    a = np.abs(r)
    pair = np.zeros(n)
    pair[1:] = np.where(adj[1:] & adj[:-1], a[1:] * a[:-1], 0.0)
    cr = np.concatenate([[0.0], np.cumsum(r * r)])
    cp = np.concatenate([[0.0], np.cumsum(pair)])
    cn = np.concatenate([[0], np.cumsum(adj.astype(np.int64))])
    cpn = np.concatenate([[0], np.cumsum(np.r_[False, adj[1:] & adj[:-1]].astype(np.int64))])
    j = np.searchsorted(ts, ts[dec_idx] + bar_ms - DAY_MS, side="left")   # first bar of the 24 h window
    e = dec_idx + 1
    rv = cr[e] - cr[j]
    nret = cn[e] - cn[j]
    # pairs need both returns inside the window: pair at bar k uses r[k-1], so start at j+1
    j1 = np.minimum(j + 1, e)
    pv = cp[e] - cp[j1]
    npair = cpn[e] - cpn[j1]
    per_day = max(2, DAY_MS // bar_ms)
    out = np.full(len(dec_idx), np.nan)
    ok = (nret >= 0.75 * per_day) & (npair >= 1) & (rv > 0)
    bv = np.where(ok, np.pi / 2 * pv * np.maximum(nret, 1) / np.maximum(npair, 1), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        s = np.clip((rv - bv) / rv, 0.0, 1.0)
    out[ok] = s[ok]
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    bar_ms = _bar_ms(ts, spec.get("interval"))
    # decision bar = the first bar closing at or after decideHour each UTC day (exactly that hour on aligned 1h data)
    key = (ts + bar_ms - (int(p["decideHour"]) % 24) * HOUR_MS) // DAY_MS
    dec = np.zeros(n, dtype=bool)
    dec[1:] = key[1:] > key[:-1]
    di = np.nonzero(dec)[0]
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    if len(di) == 0:
        return frame(df.index, {m: w})
    jump = p["mode"] == "jump"
    if jump:
        s = pd.Series(daily_jump_share(ts, c, bar_ms, di))
        L, R = int(p["jumpLen"]), int(p["rankLen"])
        J = s.rolling(L, min_periods=max(2, int(0.8 * L))).mean()
        rk = J.rolling(R, min_periods=min(R, 60)).rank(pct=True).shift(int(p.get("lagDays", 0) or 0)).to_numpy()
    else:
        rk = np.ones(len(di))
    t = int(p["trendSma"] or 0)
    core = np.full(len(di), np.nan)
    if t:
        dc = c[di]
        sm = pd.Series(dc).rolling(t, min_periods=t).mean().to_numpy()
        core = np.where(np.isfinite(sm), (dc > sm).astype(float), np.nan)
    lo, hi = float(p["exitRank"]), float(p["enterRank"])
    off = float(p["offWeight"]) * mw
    both = p["combine"] == "and"
    state, cur, k = None, np.nan, 0
    for i in range(n):
        if k < len(di) and di[k] == i:
            x = rk[k]
            cv = core[k]
            if np.isfinite(x) and (not t or np.isfinite(cv)):
                if not jump:
                    on = bool(cv) if t else True
                else:
                    if state is None:
                        state = x > hi
                    elif state and x <= lo:
                        state = False
                    elif not state and x > hi:
                        state = True
                    if t:
                        on = (state and cv > 0) if both else (state or cv > 0)
                    else:
                        on = state
                cur = mw if on else off
            k += 1
        w[i] = cur
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    h = int(p["decideHour"]) % 24
    t = int(p["trendSma"] or 0)
    if p["mode"] == "hold":
        steps = [f"Control version without the jump gate: it {'follows the ' + str(t) + '-day average' if t else 'just holds ' + mk}."]
    else:
        steps = [
            f"Every day at {h:02d}:00 UTC it splits the last 24 hours of {mk}'s hourly price moves into isolated "
            f"jumps (one big hour between calm ones) and steady, clustered movement (big hour after big hour).",
            f"It averages the jump share over {int(p['jumpLen'])} days and ranks it against the last "
            f"{int(p['rankLen'])} days.",
            f"It holds while that rank is above {float(p['exitRank']):.0%} and steps aside when it falls to it or below "
            f"(steady grinding moves, typical of sell-offs); it buys back once the rank rises above "
            f"{float(p['enterRank']):.0%}.",
        ]
        if float(p["offWeight"]) > 0:
            steps.append(f"While stepped aside it keeps {float(p['offWeight']):.0%} of the position.")
        if t:
            steps.append(f"It also needs the price above its {t}-day average." if p["combine"] == "and"
                         else f"It also stays in whenever the price is above its {t}-day average.")
    return {
        "summary": f"Holds {mk} except in stretches where the price moves in steady, hour-after-hour waves.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Grinding sell-offs with persistent hourly pressure: it is in euros for them.",
        "whenItLoses": "Steady, persistent rallies look the same as grinding sell-offs: it can sit those out.",
    }
