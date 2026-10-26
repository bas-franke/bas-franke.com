"""kelly_core v1 (agent-07): fractional-Kelly sizing from trailing return estimates.

Kelly's growth-optimal fraction for one asset is mu / sigma^2 (mean log return over its variance). This family
sizes each coin with a fraction of that, from trailing windows:

- r_t = ln(close_t / close_t-1);
- mu_t = mean of r over the last muLen candles, var_t = population variance of r over the last volLen candles;
- target_t = clip(frac * mu_t / var_t, 0, 1) (long only, no leverage);
- the weight only moves when the target differs by at least minStep from the current weight (or hits 0 or 1).

Unlike vol_target (size = targetVol / vol behind a binary momentum filter) the size is continuous in the trend's
strength per unit of risk: strong calm uptrends get full size, weak or choppy ones a little, downtrends nothing.
Multi-market: equal split, each coin its own sleeve. Decisions use candles up to and including bar t only.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "kelly_core"
VERSION = 1
TITLE = "Fractional-Kelly sizing"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"muLen": 90, "volLen": 60, "frac": 0.5, "minStep": 0.1}


def param_space() -> dict:
    return {
        "muLen": {"type": "int", "min": 10, "max": 400, "log": True,
                  "description": "candles over which the average return (trend strength) is measured"},
        "volLen": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "candles over which the return variance (risk) is measured"},
        "frac": {"type": "float", "min": 0.1, "max": 4.0, "log": True,
                 "description": "fraction of the Kelly bet (1 = full Kelly, capped at 100 % invested)"},
        "minStep": {"type": "float", "min": 0.02, "max": 0.5, "zero": True,
                    "description": "only rebalance when the target moved at least this much (0 = always)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["muLen"]), int(p["volLen"]))


def kelly_target(c: np.ndarray, p: dict) -> np.ndarray:
    """Unsmoothed target 0..1 per bar, NaN while undefined."""
    c = np.asarray(c, dtype=np.float64)
    r = np.full(len(c), np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        r[1:] = np.log(c[1:] / c[:-1])
    mu = ind.sma(r, int(p["muLen"]))
    sd = ind.std_pop(r, int(p["volLen"]))
    with np.errstate(divide="ignore", invalid="ignore"):
        t = float(p["frac"]) * mu / (sd * sd)
    t = np.where(np.isfinite(mu) & np.isfinite(sd), np.clip(np.nan_to_num(t, nan=0.0, posinf=1.0, neginf=0.0), 0, 1),
                 np.nan)
    return t


def sleeve(c: np.ndarray, p: dict) -> np.ndarray:
    t = kelly_target(c, p)
    step = float(p.get("minStep") or 0.0)
    w = np.full(len(t), np.nan)
    cur = None
    for i, x in enumerate(t.tolist()):
        if x != x:
            continue
        if cur is None or x <= 0.0 or x >= 1.0 or abs(x - cur) >= step:
            cur = x
        w[i] = cur
    return w


def targets(candles, spec, start_time=None):
    p = spec["params"]
    ms = list(spec["markets"])
    idx = union_index(candles, ms)
    k, mw = len(ms), max_weight(spec)
    return frame(idx, {m: sleeve(aligned_close(candles, m, idx), p) * (mw / k) for m in ms})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    steps = []
    if len(spec.get("markets") or []) > 1:
        steps.append(f"The money is split equally over {mk}; each part is sized on its own.")
    steps += [
        f"It measures the coin's average daily-bar return over {bars_text(p['muLen'], iv)} (how strong the trend "
        f"is) and how much the returns swing over {bars_text(p['volLen'], iv)} (the risk).",
        f"It invests {float(p['frac']):.2f} times the trend strength divided by the risk (the Kelly bet), at most "
        "100 % and nothing while the average return is negative.",
    ]
    if float(p.get("minStep") or 0) > 0:
        steps.append(f"It only trades when that amount moved by at least {pct(p['minStep'])} of the money.")
    return {
        "summary": f"Sizes {mk} by trend strength per unit of risk: full in calm uptrends, little in choppy ones, "
                   "nothing in downtrends.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Steady, low-volatility bull runs and long bear markets (it is out once the average turns).",
        "whenItLoses": "Violent rallies right after a crash: the trailing average is still negative, so it misses them.",
    }
