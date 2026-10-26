"""month_turn v1 (agent-07): turn-of-month / day-of-month calendar.

Hypothesis: salaries and scheduled DCA buys (monthly savings plans) land around the turn of the month, so crypto
might rise more on the last days of a month and the first days of the next (the equity "turn-of-month" effect).

A calendar window is ``length`` UTC days starting ``offset`` days from the first day of a month (offset -3 = the
third-last day of the previous month). ``mode=in`` holds only inside the window; ``mode=out`` holds every day except
inside it (step aside in a weak slice). Optional ``trendSma``: only hold while the close is above that SMA.

The decision at the close of bar t sets the position for bar t+1 (SPEC section 2), so the weight at bar t is "is the
*next* bar's open time inside the window": it only uses the clock, never future prices.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import _INTERVAL_MIN, frame, market_names, max_weight, risk_steps, single_market

NAME = "month_turn"
VERSION = 1
TITLE = "Turn-of-month calendar"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"mode": "in", "offset": -2, "length": 5, "trendSma": 0}


def param_space() -> dict:
    return {
        "mode": {"type": "choice", "values": ["in", "out"],
                 "description": "in = hold only inside the window; out = hold every day except inside it"},
        "offset": {"type": "int", "min": -10, "max": 20,
                   "description": "window start in days from the 1st of the month (-2 = second-last day before)"},
        "length": {"type": "int", "min": 1, "max": 15, "description": "window length in days"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                     "description": "only hold while the close is above this SMA (0 = no filter)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["offset"]) + int(p["length"]) > 28 or int(p["offset"]) < -10:
        return "window must fit inside one month"
    return None


def warmup(p: dict) -> int:
    t = int(p.get("trendSma") or 0)
    return t - 1 if t > 0 else 0


def _step_ms(index: np.ndarray, interval: str | None) -> int:
    if interval in _INTERVAL_MIN:
        return _INTERVAL_MIN[interval] * 60_000
    if len(index) > 1:
        return int(np.median(np.diff(index)))
    return 86_400_000


def in_window(ts_ms: np.ndarray, offset: int, length: int) -> np.ndarray:
    """True where the UTC day of ``ts_ms`` lies ``offset``..``offset+length-1`` days from a month's 1st."""
    t = pd.to_datetime(np.asarray(ts_ms, dtype=np.int64), unit="ms", utc=True)
    k = t.day.to_numpy() - 1                      # days since this month's 1st (0-based)
    dim = t.days_in_month.to_numpy()
    kneg = k - dim                                # days relative to next month's 1st (negative)
    lo, hi = int(offset), int(offset) + int(length)
    return ((k >= lo) & (k < hi)) | ((kneg >= lo) & (kneg < hi))


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    idx = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    nxt = idx + _step_ms(idx, spec.get("interval"))
    win = in_window(nxt, int(p["offset"]), int(p["length"]))
    on = win if p["mode"] == "in" else ~win
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
    o, ln = int(p["offset"]), int(p["length"])
    def day(k):
        if k < 0:
            return f"{-k} day{'s' if k < -1 else ''} before the 1st"
        return f"day {k + 1} of the month"
    return f"from {day(o)} for {ln} day{'s' if ln > 1 else ''}"


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    wt = _window_text(p)
    if p["mode"] == "in":
        steps = [f"It only holds {mk} in a fixed slice around the turn of the month: {wt} (UTC).",
                 "Just before the slice opens it buys; when it closes it sells everything and waits in euros."]
        summary = f"Holds {mk} only {wt} each month and sits in euros the rest of the time."
    else:
        steps = [f"It holds {mk} every day except a fixed slice of each month: {wt} (UTC).",
                 "It sells just before that slice and buys back when it ends."]
        summary = f"Holds {mk} except {wt} each month."
    steps.append("The idea: salaries and monthly savings plans buy around the turn of the month, which might lift "
                 "prices on those days.")
    if int(p.get("trendSma") or 0) > 0:
        steps.insert(1, f"It only holds while the price is above its {int(p['trendSma'])}-candle average.")
    return {
        "summary": summary,
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "When monthly money flows really cluster on those days and the pattern persists.",
        "whenItLoses": "When the calendar pattern is noise: every month costs a round trip of fees, and big moves "
                       "on the other days are missed.",
    }
