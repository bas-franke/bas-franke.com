"""halving_cycle v1 (agent-15, invent lane): the bitcoin "4-year cycle" as a calendar.

Bitcoin's block reward halves every 210,000 blocks (roughly every 4 years); the dates are fixed by the protocol and
known well in advance, so a calendar of them is no look-ahead. Crypto folklore says bull markets run in the 12-18
months after a halving, a bear market follows, and prices recover in the year before the next halving.

The family holds each market (equal split of maxWeight) while the bar is inside a "hold window":

- months since the latest halving in [holdFrom, holdTo), or
- within preMonths before the next (scheduled) halving (0 = off),

optionally only while the close is above SMA(trendSma) inside the window. Outside the window it is in euros, unless
offSma > 0: then it also holds while the close is above SMA(offSma) (a slower trend filter for the off-season).
"""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index, aligned_close

NAME = "halving_cycle"
VERSION = 1
TITLE = "Bitcoin halving cycle calendar"
BOT_READY = False
MULTI_MARKET = True

# Block-reward halvings (UTC dates). 2028 is the protocol's projected date (~210k blocks after 2024-04-20).
HALVINGS = ["2012-11-28", "2016-07-09", "2020-05-11", "2024-04-20", "2028-04-15", "2032-04-01"]
_HALVING_MS = np.array([int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
                        for d in HALVINGS], dtype=np.int64)
_MONTH_MS = 30.4375 * 86_400_000


def default_params() -> dict:
    return {"holdFrom": 0.0, "holdTo": 18.0, "preMonths": 12.0, "trendSma": 0, "offSma": 0}


def param_space() -> dict:
    return {
        "holdFrom": {"type": "float", "min": 0.0, "max": 30.0,
                     "description": "start holding this many months after a halving"},
        "holdTo": {"type": "float", "min": 6.0, "max": 42.0,
                   "description": "stop holding this many months after a halving"},
        "preMonths": {"type": "float", "min": 1.0, "max": 24.0, "zero": True,
                      "description": "also hold during the last this-many months before the next halving (0 = off)"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                     "description": "inside the hold window, only hold while the close is above this SMA (0 = off)"},
        "offSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                   "description": "outside the hold window, still hold while the close is above this SMA "
                                  "(0 = euros outside the window)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["holdTo"]) < float(p["holdFrom"]) + 2.0:
        return "holdTo must be at least 2 months after holdFrom"
    return None


def warmup(p: dict) -> int:
    return max(int(p.get("trendSma") or 0), int(p.get("offSma") or 0), 1) - 1


def cycle_months(ts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(months since the latest halving, months until the next one) for each timestamp (ms)."""
    ts = np.asarray(ts, dtype=np.int64)
    k = np.searchsorted(_HALVING_MS, ts, side="right") - 1
    k = np.clip(k, 0, len(_HALVING_MS) - 2)
    since = (ts - _HALVING_MS[k]) / _MONTH_MS
    until = (_HALVING_MS[k + 1] - ts) / _MONTH_MS
    return since, until


def in_window(ts: np.ndarray, p: dict) -> np.ndarray:
    since, until = cycle_months(ts)
    w = (since >= float(p["holdFrom"])) & (since < float(p["holdTo"]))
    pre = float(p.get("preMonths") or 0)
    if pre > 0:
        w |= until <= pre
    return w


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    win = in_window(idx, p)
    t_n, o_n = int(p.get("trendSma") or 0), int(p.get("offSma") or 0)
    each = max_weight(spec) / len(markets)
    W = np.empty((n, len(markets)))
    for j, m in enumerate(markets):
        c = aligned_close(candles, m, idx)
        defined = np.isfinite(c)
        hold_in = np.ones(n, dtype=bool)
        if t_n:
            s = ind.sma(c, t_n)
            defined &= np.isfinite(s)
            hold_in = c > s
        hold_out = np.zeros(n, dtype=bool)
        if o_n:
            s2 = ind.sma(c, o_n)
            defined &= np.isfinite(s2)
            hold_out = c > s2
        hold = np.where(win, hold_in, hold_out)
        W[:, j] = np.where(defined, hold * each, np.nan)
    ok = np.isfinite(W).all(axis=1)
    first = int(np.argmax(ok)) if ok.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def _m(x: float) -> str:
    return f"{float(x):.0f}" if abs(float(x) - round(float(x))) < 0.05 else f"{float(x):.1f}"


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    k = len(spec.get("markets") or [])
    steps = [
        "Bitcoin's block reward halves about every four years on a schedule fixed in its code "
        f"({', '.join(HALVINGS[1:4])}, next around April 2028).",
        f"It holds {mk} from {_m(p['holdFrom'])} to {_m(p['holdTo'])} months after each halving, the window in "
        "which past bull markets peaked.",
    ]
    if float(p.get("preMonths") or 0):
        steps.append(f"It also holds in the last {_m(p['preMonths'])} months before the next halving, when prices "
                     "have tended to recover.")
    if int(p.get("trendSma") or 0):
        steps.append(f"Inside those windows it only holds while the price is above its {bars_text(p['trendSma'], iv)} "
                     "average.")
    if int(p.get("offSma") or 0):
        steps.append(f"Outside the windows it still holds while the price is above its {bars_text(p['offSma'], iv)} "
                     "average; otherwise it waits in euros.")
    else:
        steps.append("Outside the windows it waits in euros.")
    if k > 1:
        steps.append(f"Each coin gets {100 / k:.0f} % of the money.")
    return {
        "summary": f"Holds {mk} in the months of the four-year halving cycle that were bullish in the past, euros "
                   "otherwise.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "When the market keeps following the four-year rhythm of 2016-2025: bull years after a "
                      "halving, a bear year after the peak.",
        "whenItLoses": "When the cycle shifts or breaks (it is based on only a few past cycles): it can sit in euros "
                       "through a rally or hold through a crash inside its window.",
    }
