"""expiry_skip v1 (agent-18, invent lane): hold the coin, but sit in euros around the monthly options expiry.

Why: crypto options and futures (Deribit, CME) expire on the last Friday of every month, the quarterly ones (March,
June, September, December) being the biggest. An unrecorded 1d study (2019-03..2025-10, before the holdout) found
ETH-EUR falling on the days just before that Friday (days -4..-2: -47/-30/-27 bp a day vs +14 on average) and rising
after it (days +1..+3), BTC much weaker. Hedging/pinning flows are a plausible cause. This family keeps the coin
(so it keeps the bull-fold return, unlike trend filters) and only steps out for a few days each month.

At the close of bar t it decides the position for the next bar, so it looks at the UTC date of the next bar's open:
let F be the last Friday of the nearest month end (this month's or next month's, whichever is closer in days) and
r = (that date - F) in days. The coin is held unless outStart <= r <= outEnd (with quarterlyOnly only around the
March/June/September/December expiries). Optional trendSma: only hold while the close is above SMA(trendSma).
Only the clock and closes up to t are used.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import _INTERVAL_MIN, frame, market_names, max_weight, risk_steps, single_market

NAME = "expiry_skip"
VERSION = 1
TITLE = "Hold, skip the days around the monthly options expiry"
BOT_READY = False
MULTI_MARKET = False

DAY = 86_400_000


def default_params() -> dict:
    return {"outStart": -4, "outEnd": -2, "quarterlyOnly": False, "trendSma": 0}


def param_space() -> dict:
    return {
        "outStart": {"type": "int", "min": -7, "max": 3,
                     "description": "first day (relative to the last Friday of the month, 0 = that Friday) in euros"},
        "outEnd": {"type": "int", "min": -6, "max": 4,
                   "description": "last day (relative to the expiry Friday) in euros"},
        "quarterlyOnly": {"type": "bool", "description": "only step out around the March/June/September/December "
                                                         "(quarterly) expiries"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                     "description": "only hold while the close is above this SMA (0 = no filter)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["outStart"]) > int(p["outEnd"]):
        return "outStart must not be after outEnd"
    return None


def warmup(p: dict) -> int:
    t = int(p.get("trendSma") or 0)
    return t - 1 if t > 0 else 0


def _step_ms(index: np.ndarray, interval: str | None) -> int:
    if interval in _INTERVAL_MIN:
        return _INTERVAL_MIN[interval] * 60_000
    if len(index) > 1:
        return int(np.median(np.diff(index)))
    return DAY


def _last_friday(month_end: pd.DatetimeIndex) -> pd.DatetimeIndex:
    return month_end - pd.to_timedelta((month_end.day_of_week - 4) % 7, unit="D")


def expiry_offset(ts_ms: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(days from the nearest last-Friday-of-month, whether that expiry is quarterly) for UTC times ``ts_ms``."""
    ts = np.asarray(ts_ms, dtype=np.int64)
    if len(ts) == 0:
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=bool)
    d = pd.to_datetime((ts // DAY) * DAY, unit="ms")
    f1 = _last_friday(d + pd.offsets.MonthEnd(0))
    f2 = _last_friday(d + pd.offsets.MonthEnd(1))
    f0 = _last_friday(d - pd.offsets.MonthEnd(1))
    r0 = np.asarray((d - f0).days, dtype=np.int64)
    r1 = np.asarray((d - f1).days, dtype=np.int64)
    r2 = np.asarray((d - f2).days, dtype=np.int64)
    R = np.column_stack([r0, r1, r2])
    k = np.argmin(np.abs(R), axis=1)
    rel = R[np.arange(len(ts)), k]
    months = np.column_stack([np.asarray(f0.month), np.asarray(f1.month), np.asarray(f2.month)])
    quarterly = months[np.arange(len(ts)), k] % 3 == 0
    return rel, quarterly


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    idx = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    rel, quarterly = expiry_offset(idx + _step_ms(idx, spec.get("interval")))
    out = (rel >= int(p["outStart"])) & (rel <= int(p["outEnd"]))
    if bool(p.get("quarterlyOnly")):
        out &= quarterly
    on = ~out
    t = int(p.get("trendSma") or 0)
    if t > 0:
        s = ind.sma(c, t)
        on = on & (c > np.nan_to_num(s, nan=np.inf))
    w = np.where(on, max_weight(spec), 0.0)
    first = warmup(p)
    if first > 0:
        w[: min(first, n)] = np.nan
    return frame(idx, {m: w})


def _days(k: int) -> str:
    if k == 0:
        return "the expiry Friday"
    return f"{abs(k)} day{'s' if abs(k) != 1 else ''} {'before' if k < 0 else 'after'} it"


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    which = "quarterly (March, June, September, December)" if p.get("quarterlyOnly") else "monthly"
    steps = [
        f"Crypto options and futures expire on the last Friday of each month. Around each {which} expiry it sells "
        f"{mk} and waits in euros from {_days(int(p['outStart']))} through {_days(int(p['outEnd']))} (UTC days).",
        f"The rest of the time it holds {mk}.",
        "The idea: hedging and pinning around big expiries pushes prices down beforehand and the pressure lifts "
        "afterwards, so stepping aside for a few days dodges that dip while keeping the long-run gains.",
    ]
    if int(p.get("trendSma") or 0) > 0:
        steps.insert(1, f"It also only holds while the price is above its {int(p['trendSma'])}-candle average.")
    return {
        "summary": f"Holds {mk}, but sits in euros for a few days around each {which} options expiry.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "When the pre-expiry weakness repeats: each skip saves a few percent for one round trip of fees.",
        "whenItLoses": "When the calendar pattern was noise or rallies happen in the skipped days; every skip costs a "
                       "round trip of fees and the full drawdown of holding remains.",
    }
