"""time_window v1: calendar seasonality. Hold the market only during a fixed window of the week (consecutive UTC
weekdays) and of the day (consecutive UTC hours), optionally only while the close is above an SMA.

The decision at the close of bar t sets the position for bar t+1 (SPEC §2), so the weight at bar t is
"is the *next* bar's open time inside the window". That only uses the clock, never future prices."""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import _INTERVAL_MIN, frame, market_names, max_weight, risk_steps, single_market

NAME = "time_window"
VERSION = 1
TITLE = "Time-of-week / time-of-day window"
BOT_READY = False
MULTI_MARKET = False

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def default_params() -> dict:
    return {"dayStart": 0, "dayCount": 7, "hourStart": 0, "hourCount": 24, "trendSma": 0}


def param_space() -> dict:
    return {
        "dayStart": {"type": "int", "min": 0, "max": 6, "description": "first UTC weekday to hold (0 = Monday)"},
        "dayCount": {"type": "int", "min": 1, "max": 7,
                     "description": "number of consecutive weekdays to hold (7 = every day)"},
        "hourStart": {"type": "int", "min": 0, "max": 23, "description": "first UTC hour of the day to hold"},
        "hourCount": {"type": "int", "min": 1, "max": 24,
                      "description": "number of consecutive hours to hold (24 = all day)"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                     "description": "only hold while the close is above this SMA (0 = no filter)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["dayCount"]) >= 7 and int(p["hourCount"]) >= 24 and int(p.get("trendSma") or 0) == 0:
        return "every day, every hour, no filter is just buy and hold"
    return None


def warmup(p: dict) -> int:
    t = int(p.get("trendSma") or 0)
    return t - 1 if t > 0 else 0


def _step_ms(index: np.ndarray, interval: str | None) -> int:
    if interval in _INTERVAL_MIN:
        return _INTERVAL_MIN[interval] * 60_000
    if len(index) > 1:
        return int(np.median(np.diff(index)))
    return 3_600_000


def in_window(ts_ms: np.ndarray, p: dict) -> np.ndarray:
    """True where the UTC time ``ts_ms`` lies in the day/hour window."""
    ts = np.asarray(ts_ms, dtype=np.int64)
    days = ts // 86_400_000
    weekday = (days + 3) % 7              # 1970-01-01 was a Thursday (Mon = 0)
    hour = (ts % 86_400_000) // 3_600_000
    dc, hc = int(p["dayCount"]), int(p["hourCount"])
    day_ok = np.ones(len(ts), bool) if dc >= 7 else ((weekday - int(p["dayStart"])) % 7) < dc
    hour_ok = np.ones(len(ts), bool) if hc >= 24 else ((hour - int(p["hourStart"])) % 24) < hc
    return day_ok & hour_ok


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    idx = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    nxt = idx + _step_ms(idx, spec.get("interval"))
    on = in_window(nxt, p)
    t = int(p.get("trendSma") or 0)
    if t > 0:
        s = ind.sma(c, t)
        on = on & (c > np.nan_to_num(s, nan=np.inf))
    w = np.where(on, max_weight(spec), 0.0)
    first = warmup(p)
    if first > 0:
        w[: min(first, n)] = np.nan
    return frame(idx, {m: w})


def _window_text(p: dict) -> str:
    dc, hc = int(p["dayCount"]), int(p["hourCount"])
    if dc >= 7:
        days = "every day"
    elif dc == 1:
        days = f"on {DAYS[int(p['dayStart'])]}s"
    else:
        days = f"from {DAYS[int(p['dayStart'])]} through {DAYS[(int(p['dayStart']) + dc - 1) % 7]}"
    if hc >= 24:
        hours = "all day"
    else:
        h0 = int(p["hourStart"])
        hours = f"from {h0:02d}:00 to {(h0 + hc) % 24:02d}:00 UTC"
    return f"{days}, {hours}"


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    steps = [
        f"It only holds {mk} during a fixed slice of the calendar: {_window_text(p)}.",
        "Just before the window opens it buys; when the window closes it sells everything and waits in euros.",
        "The idea: if crypto tends to rise on some days or hours and drift on others, holding only the good "
        "slice keeps most of the gains with less time exposed.",
    ]
    if int(p.get("trendSma") or 0) > 0:
        steps.insert(1, f"Inside the window it only holds while the price is above its {int(p['trendSma'])}-candle "
                        "average; in a downtrend it stays in euros.")
    return {
        "summary": f"Holds {mk} only {_window_text(p)} and sits in euros the rest of the time.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "When returns really cluster in that slice of the week or day and the pattern persists.",
        "whenItLoses": "When the calendar pattern was noise: every window costs a round trip of fees, and big "
                       "moves outside the window are missed.",
    }
