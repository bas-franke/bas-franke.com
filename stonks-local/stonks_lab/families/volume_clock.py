"""volume_clock v1 (agent-09): a moving-average trend core that runs on a *turnover clock* instead of a calendar.

A plain SMA core averages the last N days. Here the window is "the most recent stretch of candles in which N typical
days' worth of EUR turnover changed hands": the averaging window ends at the current bar and reaches back until the
summed EUR turnover (volume x close) reaches ``lenDays`` x the trailing median daily turnover (median over the last
``normDays`` days, measured up to this bar). In busy markets (crashes, blow-off tops) the window gets short, so the
average catches up quickly and the exit comes sooner; in quiet drifts it stretches out (up to ``maxMult`` x lenDays)
and the core sits through dull chop. ``minFrac`` caps how short it can get.

``clock="time"`` is the control: a plain ``lenDays`` SMA (same bands), so paired runs isolate the clock.
``weight="volume"`` uses the turnover-weighted average price of the window (a rolling VWAP) instead of the mean close.

Hold while close > avg x (1 + enterBand); sell when close < avg x (1 - exitBand). Decisions at bar t use candles up to
and including bar t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..data import INTERVAL_MS
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "volume_clock"
VERSION = 1
TITLE = "Turnover-clock trend core"
BOT_READY = False
MULTI_MARKET = False
ANCHORED = False

DAY_MS = 86_400_000


def default_params() -> dict:
    return {"clock": "volume", "lenDays": 100, "weight": "equal", "minFrac": 0.25, "maxMult": 3.0,
            "normDays": 365, "enterBand": 0.0, "exitBand": 0.0}


def param_space() -> dict:
    return {
        "clock": {"type": "choice", "values": ["volume", "time"],
                  "description": "volume = window measured in EUR turnover; time = plain SMA of lenDays (control)"},
        "lenDays": {"type": "int", "min": 10, "max": 400, "log": True,
                    "description": "window length in typical days of turnover (or calendar days for clock=time)"},
        "weight": {"type": "choice", "values": ["equal", "volume"],
                   "description": "equal = mean close of the window; volume = turnover-weighted price (VWAP)"},
        "minFrac": {"type": "float", "min": 0.05, "max": 1.0,
                    "description": "shortest allowed window as a fraction of lenDays"},
        "maxMult": {"type": "float", "min": 1.0, "max": 8.0,
                    "description": "longest allowed window as a multiple of lenDays"},
        "normDays": {"type": "int", "min": 60, "max": 730, "log": True,
                     "description": "days of trailing turnover whose median defines a 'typical day'"},
        "enterBand": {"type": "float", "min": 0.0, "max": 0.1, "zero": True,
                      "description": "buy only when the close is this far above the average"},
        "exitBand": {"type": "float", "min": 0.0, "max": 0.1, "zero": True,
                     "description": "sell only when the close is this far below the average"},
    }


def valid_params(p) -> str | None:
    if float(p["minFrac"]) > float(p["maxMult"]):
        return "minFrac must be <= maxMult"
    return None


def _bars_per_day(interval: str | None, index: np.ndarray) -> float:
    if interval in INTERVAL_MS:
        return DAY_MS / float(INTERVAL_MS[interval])
    if len(index) > 1:
        return DAY_MS / float(np.median(np.diff(index)))
    return 1.0


def warmup(p: dict) -> int:
    # in daily bars; the engine treats it as a lower bound only (targets are NaN until windows are full)
    return int(max(int(p["normDays"]) // 2, int(p["lenDays"])) + 1)


def averages(df: pd.DataFrame, p: dict, interval: str | None) -> np.ndarray:
    """The clock average at every bar (NaN while undecided)."""
    c = df["close"].to_numpy(np.float64)
    v = np.nan_to_num(df["volume"].to_numpy(np.float64) * c, nan=0.0, posinf=0.0, neginf=0.0)
    n = len(c)
    bpd = _bars_per_day(interval, np.asarray(df.index, dtype=np.int64))
    L = max(1, int(round(int(p["lenDays"]) * bpd)))
    out = np.full(n, np.nan)
    if n == 0:
        return out
    t = np.arange(n)
    if p["clock"] == "time":
        j = t - L + 1
        ok = j >= 0
    else:
        nb = max(2, int(round(int(p["normDays"]) * bpd)))
        # median turnover per bar over the trailing window (causal), needs half the window
        norm = pd.Series(v).rolling(nb, min_periods=max(2, nb // 2)).median().to_numpy()
        P = np.concatenate([[0.0], np.cumsum(v)])
        need = L * norm
        tgt = P[t + 1] - need
        with np.errstate(invalid="ignore"):
            j = np.searchsorted(P, np.where(np.isfinite(tgt), tgt, -np.inf), side="right") - 1
        lo_b = max(1, int(round(L * float(p["minFrac"]))))
        hi_b = max(lo_b, int(round(L * float(p["maxMult"]))))
        reached = (j >= 0) & (P[t + 1] - P[np.clip(j, 0, n)] >= need)
        ok = np.isfinite(norm) & (norm > 0) & reached
        j = np.minimum(j, t - lo_b + 1)          # at least lo_b bars
        j = np.maximum(j, t - hi_b + 1)          # at most hi_b bars
        ok &= j >= 0
    j = np.clip(j, 0, n - 1)
    if p["weight"] == "volume":
        Pv = np.concatenate([[0.0], np.cumsum(v)])
        Pcv = np.concatenate([[0.0], np.cumsum(v * c)])
        den = Pv[t + 1] - Pv[j]
        with np.errstate(invalid="ignore", divide="ignore"):
            avg = np.where(den > 0, (Pcv[t + 1] - Pcv[j]) / den, np.nan)
    else:
        Pc = np.concatenate([[0.0], np.cumsum(c)])
        avg = (Pc[t + 1] - Pc[j]) / (t - j + 1)
    out[ok] = avg[ok]
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    avg = averages(df, p, spec.get("interval"))
    up, dn = 1.0 + float(p["enterBand"] or 0.0), 1.0 - float(p["exitBand"] or 0.0)
    mw = max_weight(spec)
    w = np.full(len(c), np.nan)
    state = False
    for i in range(len(c)):
        a = avg[i]
        if not np.isfinite(a):
            continue
        state = c[i] >= a * dn if state else c[i] > a * up
        w[i] = mw if state else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    n = int(p["lenDays"])
    avg = "average price weighted by euro volume" if p["weight"] == "volume" else "average closing price"
    if p["clock"] == "time":
        first = f"It follows the {avg} of {mk} over the last {n} days (a plain moving average; the control version)."
    else:
        first = (f"It follows the {avg} of {mk} over a window measured in trading activity, not days: the window "
                 f"reaches back until {n} typical days' worth of euro turnover has traded (a 'typical day' is the "
                 f"median of the last {int(p['normDays'])} days).")
    steps = [first]
    if p["clock"] != "time":
        steps.append(f"Busy markets shorten the window (down to {float(p['minFrac']) * n:.0f} days), so it reacts fast "
                     f"in crashes; quiet markets stretch it (up to {float(p['maxMult']) * n:.0f} days), so it sits "
                     "through dull chop.")
    eb, xb = float(p["enterBand"] or 0), float(p["exitBand"] or 0)
    steps.append(f"It buys when the price closes {eb:.1%} or more above that average and sells when it closes "
                 f"{xb:.1%} or more below it.")
    return {
        "summary": f"A trend filter for {mk} whose moving average speeds up when trading gets busy.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Crashes and blow-off tops that come with heavy volume: it gets out sooner than a calendar "
                      "average would.",
        "whenItLoses": "Volume spikes on the way up (breakouts) also shorten the window, and quiet bear drifts stretch "
                       "it, so it can sell late in slow declines.",
    }
