"""rskew_gate_a14 v1 (agent-14): hold BTC/ETH while the INTRADAY realized skewness is not unusually negative.

Realized skewness (Amaya et al. 2015) is measured from the intraday bar returns of the last ``lookback`` days:

    RSK = sqrt(N) * sum(r^3) / sum(r^2)^1.5        (r = log return of every bar in the window, N = bars)

It is negative when the window's big intraday moves were down-moves (liquidation cascades, flash dumps) and positive
when they were up-moves (squeezes). Unrecorded pre-holdout study (BTC/ETH 5m 2019-2025, fwd 10/30 d rank IC by
year): 30-day 5m RSK was positively related to the next month (BTC +0.22, 6/7 years; ETH +0.15, 4/6) and the sign
held after removing the plain 30-day return, i.e. it is not momentum in disguise.

Once per day, at the close of the bar ending at ``decideHour`` UTC, the RSK is ranked against its own last
``rankLen`` daily values (trailing percentile, no look-ahead). It holds while that percentile is above ``exitPct``
and, once out, buys back when it is above ``exitPct + gap`` (hysteresis).

``source="daily"`` is the built-in ablation: the same statistic from the daily close-to-close returns of the
lookback (what skew_gate measures), ranked the same way, so a paired run shows what intraday sampling adds.
Optional daily SMA core (``trendSma`` days of decision closes): "and" = filter, "or" = either keeps it in.
Made for 5m candles (works on 1m-4h). A decision at bar t uses bars up to and including t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..data import INTERVAL_MS
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "rskew_gate_a14"
VERSION = 1
TITLE = "Intraday realized-skew gate"
BOT_READY = False
MULTI_MARKET = False

DAY_MS = 86_400_000
HOUR_MS = 3_600_000


def default_params() -> dict:
    return {"source": "intraday", "lookback": 30, "rankLen": 180, "exitPct": 0.2, "gap": 0.0,
            "trendSma": 0, "combine": "or", "decideHour": 0}


def param_space() -> dict:
    return {
        "source": {"type": "choice", "values": ["intraday", "daily"],
                   "description": "intraday = skewness of every bar's return; daily = of daily close-to-close "
                                  "returns (ablation)"},
        "lookback": {"type": "int", "min": 5, "max": 120, "log": True,
                     "description": "days of returns the realized skewness is measured over"},
        "rankLen": {"type": "int", "min": 60, "max": 730, "log": True,
                    "description": "days of past skewness values the current one is ranked against"},
        "exitPct": {"type": "float", "min": 0.05, "max": 0.6,
                    "description": "sell when the skewness ranks in the lowest this share of the rank window"},
        "gap": {"type": "float", "min": 0.0, "max": 0.3,
                "description": "hysteresis: once out, buy back only above exitPct + gap"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                     "description": "daily SMA core in days combined with the gate (0 = off)"},
        "combine": {"type": "choice", "values": ["and", "or"],
                    "description": "and = need both gate and close > SMA; or = either one is enough"},
        "decideHour": {"type": "int", "min": 0, "max": 23,
                       "description": "UTC hour (candle close) at which the daily decision is made"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["exitPct"]) + float(p["gap"]) > 0.8:
        return "exitPct + gap must be at most 0.8"
    return None


def _bar_ms(index: np.ndarray, interval: str | None) -> int:
    if interval in INTERVAL_MS:
        return int(INTERVAL_MS[interval])
    if len(index) > 1:
        return int(np.median(np.diff(index)))
    return HOUR_MS


def decision_mask(ts: np.ndarray, bar_ms: int, hour: int) -> np.ndarray:
    if bar_ms >= DAY_MS:
        return np.ones(len(ts), bool)
    return ((ts + bar_ms) % DAY_MS) == (hour % 24) * HOUR_MS


def realized_skew(df, p: dict, interval: str | None) -> tuple[np.ndarray, np.ndarray]:
    """(RSK at decision bars with a full window, NaN elsewhere; indices of all decision bars)."""
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    bar_ms = _bar_ms(ts, interval)
    dec = np.nonzero(decision_mask(ts, bar_ms, int(p["decideHour"])))[0]
    out = np.full(n, np.nan)
    if len(dec) < 2:
        return out, dec
    span = int(p["lookback"]) * DAY_MS
    if p["source"] == "daily":
        dc = c[dec]
        r = np.zeros(len(dec))
        r[1:] = np.log(dc[1:] / dc[:-1])
        L = int(p["lookback"])
        s2 = pd.Series(r ** 2).rolling(L, min_periods=L).sum().to_numpy()
        s3 = pd.Series(r ** 3).rolling(L, min_periods=L).sum().to_numpy()
        with np.errstate(invalid="ignore", divide="ignore"):
            v = np.sqrt(L) * s3 / s2 ** 1.5
        v[:L] = np.nan                     # first return (r[0]) is not a real return
        out[dec] = np.round(v, 9)
        return out, dec
    r = np.zeros(n)
    r[1:] = np.log(c[1:] / c[:-1])
    r[~np.isfinite(r)] = 0.0
    c2 = np.concatenate([[0.0], np.cumsum(r ** 2)])
    c3 = np.concatenate([[0.0], np.cumsum(r ** 3)])
    # window = bars whose return ends inside (t_close - span, t_close]; bar i's return covers close[i-1]->close[i]
    j = np.searchsorted(ts, ts[dec] + bar_ms - span, side="left")
    j = np.maximum(j, 1)
    full = ts[dec] + bar_ms - span >= ts[0] + bar_ms
    s2 = c2[dec + 1] - c2[j]
    s3 = c3[dec + 1] - c3[j]
    nb = (dec + 1 - j).astype(np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        v = np.sqrt(nb) * s3 / s2 ** 1.5
    v[~full | (nb < 2)] = np.nan
    out[dec] = np.round(v, 9)              # float noise must not decide ties in the rank
    return out, dec


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    rsk, dec = realized_skew(df, p, spec.get("interval"))
    x = rsk[dec]
    rl = int(p["rankLen"])
    pct = pd.Series(x).rolling(rl, min_periods=max(20, rl // 2)).rank(pct=True).to_numpy()
    t_len = int(p["trendSma"] or 0)
    dc = c[dec]
    sma = pd.Series(dc).rolling(t_len, min_periods=t_len).mean().to_numpy() if t_len else None
    lo, hi = float(p["exitPct"]), float(p["exitPct"]) + float(p["gap"])
    both = p["combine"] == "and"
    mw = max_weight(spec)
    wd = np.full(len(dec), np.nan)
    state = None
    for k in range(len(dec)):
        q = pct[k]
        if not np.isfinite(q) or (t_len and not np.isfinite(sma[k])):
            continue
        if state is None:
            state = q > lo
        elif state:
            state = q > lo
        else:
            state = q > hi
        on = state
        if t_len:
            core = dc[k] > sma[k]
            on = (state and core) if both else (state or core)
        wd[k] = mw if on else 0.0
    w = np.full(n, np.nan)
    w[dec] = wd
    w = pd.Series(w).ffill().to_numpy()
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    h = int(p["decideHour"]) % 24
    lb, rl = int(p["lookback"]), int(p["rankLen"])
    lo, hi = float(p["exitPct"]), float(p["exitPct"]) + float(p["gap"])
    what = "every intraday candle's" if p["source"] == "intraday" else "the daily"
    steps = [f"Every day at {h:02d}:00 UTC it measures how lopsided {mk}'s {what} price moves of the last {lb} days "
             f"were: are the biggest moves sudden drops (negative skew) or sudden jumps (positive skew)?",
             f"It compares that number with its own values of the last {rl} days. It holds {mk} unless the moves are "
             f"more drop-heavy than on {lo:.0%} of those days; then it sells, and it buys back once that share is "
             f"above {hi:.0%} again."]
    t = int(p["trendSma"] or 0)
    if t:
        steps.append(f"It also needs the price above its {t}-day average; under it, it stays in euros."
                     if p["combine"] == "and" else f"It is also in whenever the price is above its {t}-day average.")
    return {
        "summary": f"Holds {mk}, but steps aside while the market keeps falling in sudden intraday drops.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Sell-offs that come as a string of liquidation cascades: it is out before the worst.",
        "whenItLoses": "Sharp one-off dumps inside a bull market: it sells and misses the rebound.",
    }
