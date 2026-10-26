"""reg_trend v1 (agent-03, trend lane): linear-regression trend quality on one coin.

Moving-average crosses react to the level of the price; this family looks at the *shape* of the recent path.
Over the last ``regLen`` candles it fits a straight line to log(close) and reads two numbers:
- slope: the fitted growth per year (annualised from the candle length),
- R2: how much of the path that line explains (1 = a clean, steady trend; ~0 = noise).

Rules (decided at a bar's close, using closes up to and including that bar only):
- enter (weight = maxWeight) when slope >= enterSlope and R2 >= r2Min;
- exit (weight 0) when slope < exitSlope (exitSlope <= enterSlope gives hysteresis),
  or, if ``stopBand`` > 0, when the close falls more than stopBand below the fitted line's value at this bar.
"""
from __future__ import annotations

import numpy as np

from ..data import INTERVAL_MS
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "reg_trend"
VERSION = 1
TITLE = "Regression trend quality"
BOT_READY = False
MULTI_MARKET = False

_MS_PER_YEAR = 365.25 * 86400 * 1000


def default_params() -> dict:
    return {"regLen": 60, "enterSlope": 0.3, "exitSlope": 0.0, "r2Min": 0.3, "stopBand": 0.0}


def param_space() -> dict:
    return {
        "regLen": {"type": "int", "min": 5, "max": 400, "log": True,
                   "description": "candles in the straight-line fit of the log price"},
        "enterSlope": {"type": "float", "min": -0.5, "max": 3.0,
                       "description": "buy when the fitted line rises at least this much per year (0.5 = +50 %/yr in log terms)"},
        "exitSlope": {"type": "float", "min": -2.0, "max": 1.5,
                      "description": "sell when the fitted yearly slope drops under this"},
        "r2Min": {"type": "float", "min": 0.05, "max": 0.95, "zero": True,
                  "description": "only buy while the line explains at least this share of the path (0 = off)"},
        "stopBand": {"type": "float", "min": 0.02, "max": 0.4, "log": True, "zero": True,
                     "description": "also sell when the close is this fraction below the fitted line (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if p["exitSlope"] > p["enterSlope"]:
        return "exitSlope must not exceed enterSlope"
    return None


def warmup(p: dict) -> int:
    return int(p["regLen"])


def rolling_fit(y: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per bar t (t >= n-1): slope per candle, R2 and fitted value at t of an OLS line through y[t-n+1..t]."""
    m = len(y)
    slope = np.full(m, np.nan)
    r2 = np.full(m, np.nan)
    fit = np.full(m, np.nan)
    if m < n or n < 3:
        return slope, r2, fit
    x = np.arange(n, dtype=np.float64)
    xm = x.mean()
    sxx = ((x - xm) ** 2).sum()
    win = np.lib.stride_tricks.sliding_window_view(y, n)        # (m-n+1, n), row i ends at bar i+n-1
    ym = win.mean(axis=1)
    sxy = (win * (x - xm)).sum(axis=1)
    b = sxy / sxx
    syy = ((win - ym[:, None]) ** 2).sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        rr = np.where(syy > 0, (b * sxy) / np.where(syy > 0, syy, 1.0), 0.0)
    slope[n - 1:] = b
    r2[n - 1:] = np.clip(rr, 0.0, 1.0)
    fit[n - 1:] = ym + b * (x[-1] - xm)
    return slope, r2, fit


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    reg_len = int(p["regLen"])
    bar_ms = float(INTERVAL_MS.get(spec.get("interval") or "1d", 86400000))
    per_year = _MS_PER_YEAR / bar_ms
    y = np.log(c)
    b, r2, fit = rolling_fit(y, reg_len)
    ann = b * per_year
    enter, exit_ = float(p["enterSlope"]), float(p["exitSlope"])
    r2_min = float(p.get("r2Min") or 0.0)
    band = float(p.get("stopBand") or 0.0)
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    start = min(warmup(p), n)
    state = 0.0
    for t in range(start, n):
        if np.isnan(ann[t]):
            continue
        if state == 0.0:
            if ann[t] >= enter and (r2_min <= 0 or r2[t] >= r2_min):
                if not (band > 0 and y[t] < fit[t] + np.log(1 - band)):
                    state = mw
        else:
            if ann[t] < exit_ or (band > 0 and y[t] < fit[t] + np.log(1 - band)):
                state = 0.0
        w[t] = state
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = [
        f"Every candle it draws the best straight line through {mk}'s (log) price over the last "
        f"{bars_text(p['regLen'], iv)} and measures how steep the line is and how neatly the price follows it.",
    ]
    r2 = float(p.get("r2Min") or 0.0)
    cond = f"the line rises at least {pct(float(p['enterSlope']))} per year"
    if r2:
        cond += f" and explains at least {round(r2 * 100)} % of the price path (a clean trend, not noise)"
    steps.append(f"It buys when {cond}.")
    steps.append(f"It sells when the line's slope drops below {pct(float(p['exitSlope']))} per year.")
    if p.get("stopBand"):
        steps.append(f"It also sells when the price falls more than {pct(float(p['stopBand']))} below the line.")
    return {
        "summary": f"A trend follower on {mk} that only buys steady, clean uptrends (a steep straight-line fit that "
                   "the price actually follows) and steps aside when the trend flattens.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long, orderly bull runs; it is in euros for most of slow, grinding bear markets.",
        "whenItLoses": "Sudden crashes (the fitted line reacts late) and V-shaped recoveries it re-enters late.",
    }
