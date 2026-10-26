"""weekend_hour_a21 v1 (agent-21): weekend_shock with the weekend window moved by whole hours (close-hour check).

``weekend_shock`` (findings #428/#429) holds BTC/ETH and sells for ``outDays`` days after the coin fell
``dropMin`` or more over the weekend, measured on native daily candles: Saturday 00:00 -> Monday 00:00 UTC. Finding
#505 showed that daily rules tuned on the 00:00 UTC close are inflated by sampling luck. This family rebuilds the rule
on 1h candles with the window END (the decision time) at Monday 00:00 UTC + ``shift`` hours (shift -24..+24; -2 =
Sunday 22:00, the CME futures re-open) and the window START ``spanH`` hours earlier (48 = the native rule).

* ``mode="weekend"``: the shock test runs once a week, at the window end.
* ``mode="rolling"``: the control. The same ``spanH``-hour return is tested every day at the same hour of day.

While out it re-checks once a day at the same hour of day; with ``regain`` it buys back early once that daily close
is back at or above the window-start close. A new shock while out restarts the clock. Between daily decisions the
last decision is held. Decisions use closes up to and including the deciding bar only.
"""
from __future__ import annotations

import math

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "weekend_hour_a21"
VERSION = 1
TITLE = "Weekend shock exit at any hour"
BOT_READY = False
MULTI_MARKET = False

DAY_MS = 86_400_000
H_MS = 3_600_000
MONDAY0 = 4 * DAY_MS   # 1970-01-05 00:00 UTC was a Monday


def default_params() -> dict:
    return {"mode": "weekend", "dropMin": 0.06, "outDays": 7, "regain": False, "shift": 0, "spanH": 48}


def param_space() -> dict:
    return {
        "mode": {"type": "choice", "values": ["weekend", "rolling"],
                 "description": "test the window once a week (ending Monday 00:00 + shift) or every day (control)"},
        "dropMin": {"type": "float", "min": 0.02, "max": 0.25, "log": True,
                    "description": "sell when the window return is at or below minus this"},
        "outDays": {"type": "int", "min": 1, "max": 60, "log": True,
                    "description": "days it stays in euros after a shock"},
        "regain": {"type": "bool",
                   "description": "buy back early once a daily check sees the price back at the window-start close"},
        "shift": {"type": "int", "min": -24, "max": 24,
                  "description": "hours the window end moves from Monday 00:00 UTC (-2 = Sunday 22:00)"},
        "spanH": {"type": "int", "min": 12, "max": 96,
                  "description": "window length in hours (48 = Saturday 00:00 -> Monday 00:00 when shift is 0)"},
    }


def warmup(p: dict) -> int:
    return int(p["spanH"]) + 2


def shock_weights(ts: np.ndarray, c: np.ndarray, p: dict, mw: float = 1.0, bar_ms: int = H_MS) -> np.ndarray:
    n = len(c)
    w = np.full(n, np.nan)
    if n == 0:
        return w
    shift_ms = int(p["shift"]) * H_MS
    span_ms = int(p["spanH"]) * H_MS
    if bar_ms >= DAY_MS:                     # daily candles: whole-day shift and span (1h is the intended use)
        shift_ms = int(round(shift_ms / DAY_MS)) * DAY_MS
        span_ms = max(1, int(round(span_ms / DAY_MS))) * DAY_MS
    close_t = ts + bar_ms
    daily = ((close_t - shift_ms) % DAY_MS) == 0
    weekly = ((close_t - shift_ms - MONDAY0) % (7 * DAY_MS)) == 0
    test = weekly if p["mode"] == "weekend" else daily
    pos = {int(t): i for i, t in enumerate(close_t)}
    drop = float(p["dropMin"])
    out_ms = int(p["outDays"]) * DAY_MS
    regain = bool(p["regain"])
    until = -1
    ref = math.inf
    cur = np.nan
    started = False
    for i in range(n):
        if not daily[i]:
            w[i] = cur
            continue
        j = pos.get(int(close_t[i]) - span_ms)
        if j is None and not started:
            w[i] = cur
            continue
        started = True
        t = int(close_t[i])
        if test[i] and j is not None and c[i] > 0 and c[j] > 0 and math.log(c[i] / c[j]) <= -drop:
            until = t + out_ms
            ref = c[j]
        elif t < until and regain and c[i] >= ref:
            until = -1
        cur = 0.0 if t < until else mw
        w[i] = cur
    return w


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    ts = df.index.to_numpy(np.int64)
    bar_ms = int(np.median(np.diff(ts))) if len(ts) > 1 else H_MS
    return frame(df.index, {m: shock_weights(ts, c, spec["params"], max_weight(spec), bar_ms)})


def _when(shift: int) -> str:
    t = 7 * 24 + int(shift)                      # hours after Monday 00:00 of the previous week
    days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    return f"{days[(t // 24) % 7]} {t % 24:02d}:00 UTC"


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    end = _when(int(p["shift"]))
    start = _when(int(p["shift"]) - int(p["spanH"]))
    if p["mode"] == "weekend":
        sig = (f"Every week at {end} it compares {mk}'s price with the price at {start}. A fall of "
               f"{pct(p['dropMin'])} or more over that weekend window is a shock.")
    else:
        sig = (f"Every day at {int(p['shift']) % 24:02d}:00 UTC it compares {mk}'s price with the price "
               f"{p['spanH']} hours earlier. A fall of {pct(p['dropMin'])} or more is a shock.")
    steps = [f"It holds {mk} by default.", sig,
             f"After a shock it sells everything and waits in euros for {p['outDays']} days."]
    if p["regain"]:
        steps.append("It buys back earlier if a daily check finds the price back where the window started.")
    return {
        "summary": f"Holds {mk}, but steps aside for a few days after a sharp weekend drop.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Crashes that start with a sharp weekend drop and keep sliding for days.",
        "whenItLoses": "Sharp drops that bounce straight back (it sells low and buys back higher).",
    }
