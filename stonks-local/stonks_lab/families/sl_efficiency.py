"""sl_efficiency v1: add a quarter when the climb is efficient and price is above its average.

Kaufman efficiency is the absolute move over n bars divided by the sum of absolute bar-to-bar
changes. The stop sits a trail under the highest close since the first add and only rises.
No lookahead.
"""
from __future__ import annotations

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "sl_efficiency"
VERSION = 1
TITLE = "Efficient climb"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"n": 48, "efficiencyMin": 0.25, "trailPct": 0.2, "step": 0.25, "minBarsBetweenAdds": 24}


def param_space() -> dict:
    return {
        "n": {"type": "int", "min": 8, "max": 1000, "log": True, "description": "efficiency and average length"},
        "efficiencyMin": {"type": "float", "min": 0.05, "max": 0.9, "description": "minimum Kaufman efficiency to add"},
        "trailPct": {"type": "float", "min": 0.05, "max": 0.5, "description": "stop this far under the peak close"},
        "step": {"type": "float", "min": 0.05, "max": 1.0, "description": "size of each add, as a share of the account"},
        "minBarsBetweenAdds": {"type": "int", "min": 1, "max": 500, "description": "candles that must pass between adds"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["step"]) <= 0:
        return "step must be above 0"
    return None


def warmup(p: dict) -> int:
    return int(p["n"]) + 1


def _efficiency(close: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    m = len(close)
    er = np.full(m, np.nan)
    sma = np.full(m, np.nan)
    if m <= n or n < 1:
        return er, sma
    delta = np.abs(np.diff(close))
    cum_delta = np.cumsum(delta)
    path = cum_delta[n - 1 :].copy()
    if path.size > 1:
        path[1:] -= cum_delta[: m - n - 1]
    net = np.abs(close[n:] - close[:-n])
    with np.errstate(divide="ignore", invalid="ignore"):
        er[n:] = np.where(path > 0.0, net / path, 0.0)
    cum = np.cumsum(close)
    sma[n - 1] = cum[n - 1] / n
    if m > n:
        sma[n:] = (cum[n:] - cum[:-n]) / n
    return er, sma


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    n = int(p["n"])
    thresh = float(p["efficiencyMin"])
    trail = float(p["trailPct"])
    step = float(p["step"])
    gap = int(p["minBarsBetweenAdds"])
    c = df["close"].to_numpy(np.float64)
    length = c.shape[0]
    w = np.full(length, np.nan)
    if length <= n:
        return frame(df.index, {m: w})
    er, sma = _efficiency(c, n)
    keep = 1.0 - trail
    weight = 0.0
    in_trade = False
    peak = 0.0
    stop = 0.0
    last_add = -10**9
    mw = max_weight(spec)
    for i in range(n, length):
        px = c[i]
        if not np.isfinite(px):
            in_trade = False
            weight = 0.0
            w[i] = 0.0
            continue
        if in_trade and px < stop:
            in_trade = False
            weight = 0.0
            w[i] = 0.0
            continue
        qualifies = bool(np.isfinite(er[i]) and np.isfinite(sma[i]) and er[i] > thresh and px > sma[i])
        if in_trade:
            if px > peak:
                peak = px
                lifted = peak * keep
                if lifted > stop:
                    stop = lifted
            if qualifies and weight < 1.0 - 1e-12 and (i - last_add) >= gap:
                weight = min(1.0, weight + step)
                last_add = i
        elif qualifies:
            in_trade = True
            weight = min(1.0, step)
            peak = px
            stop = peak * keep
            last_add = i
        w[i] = weight * mw
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": (
            f"Adds to {mk} in steps when the recent move is a clean climb and the price is above its average, "
            f"and sells if the close falls {pct(p['trailPct'])} from the peak."
        ),
        "howItWorks": [
            f"Efficiency over the last {bars_text(int(p['n']), iv)} is how far the price travelled in a straight line, "
            "divided by the sum of every up and down step along the way. A straight climb scores near 1. A chop scores near 0.",
            f"A candle qualifies when that score is above {float(p['efficiencyMin']):.2f} and the close is above "
            f"the average of those same candles. The first one buys {pct(p['step'])} of the account. "
            f"Later ones add the same amount, at most once every {bars_text(int(p['minBarsBetweenAdds']), iv)}, up to the whole account.",
            f"The stop sits {pct(p['trailPct'])} under the highest close since the first add, and it only moves up. "
            "A close under the stop sells everything. The next buy has to qualify again.",
        ] + risk_steps(spec),
        "whenItWins": "A steady climb that stays above its average, so the adds fill in and the stop stays well under the price.",
        "whenItLoses": "A climb that looks clean, then gives back the trail. A coin that keeps doing that pays the fees and ends behind holding.",
    }
