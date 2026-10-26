"""session_flow v1 (agent-09): who is buying, and when? A daily trend signal built from hourly candles.

Instead of the plain price trend it looks at *part* of each day or at the shape of the hourly candles:

* ``signal="session"``: the log returns earned only during one UTC session (``sessStart`` for ``sessLen`` hours,
  e.g. 14-21 UTC = US trading hours), summed over the last ``lookback`` days. The idea: if one group of traders
  (US hours: ETF/institutional flow) keeps pushing the price up while the rest of the day is noise, their session's
  running return is a cleaner trend than the full-day return.
* ``signal="clv"``: intraday money flow (a Chaikin-style ratio) over the last ``lookback`` days of hourly candles in the
  session: sum(volume x close location) / sum(volume), where close location = ((c - l) - (h - c)) / (h - l) is +1 when
  an hour closes at its high and -1 at its low. Persistent closes near the highs = accumulation.

It decides once per day, at the close of the session's last hour, holds while the signal is above ``enter`` and sells
when it drops under ``enter - gap`` (hysteresis). Optional daily SMA core (``trendSma`` days, measured on the
decision-hour closes) combined with ``combine``: "and" = filter, "or" = either one keeps it in.

Made for 1h candles (works on 15m-2h). Decisions at bar t use candles up to and including bar t.
"""
from __future__ import annotations

import numpy as np

from ..data import INTERVAL_MS
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "session_flow"
VERSION = 1
TITLE = "Trading-session flow (hourly)"
BOT_READY = False
MULTI_MARKET = False

DAY_MS = 86_400_000
HOUR_MS = 3_600_000


def default_params() -> dict:
    return {"signal": "session", "sessStart": 14, "sessLen": 7, "lookback": 30, "enter": 0.0, "gap": 0.0,
            "trendSma": 0, "combine": "and"}


def param_space() -> dict:
    return {
        "signal": {"type": "choice", "values": ["session", "clv"],
                   "description": "session = summed log return of the session hours; clv = volume-weighted close "
                                  "location of the session's hourly candles (Chaikin money flow)"},
        "sessStart": {"type": "int", "min": 0, "max": 23, "description": "first UTC hour of the session"},
        "sessLen": {"type": "int", "min": 1, "max": 24, "description": "session length in hours (24 = whole day)"},
        "lookback": {"type": "int", "min": 3, "max": 300, "log": True,
                     "description": "days over which the session signal is summed"},
        "enter": {"type": "float", "min": -0.3, "max": 0.3,
                  "description": "hold while the signal is above this (log return for session, -1..1 for clv)"},
        "gap": {"type": "float", "min": 0.0, "max": 0.3,
                "description": "hysteresis: sell only when the signal falls under enter minus this"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                     "description": "daily SMA core in days combined with the signal (0 = off)"},
        "combine": {"type": "choice", "values": ["and", "or"],
                    "description": "and = need both signal and close > SMA; or = either one is enough"},
    }


def warmup(p: dict) -> int:
    return 24 * (max(int(p["lookback"]), int(p["trendSma"] or 0)) + 2)


def _bar_ms(index: np.ndarray, interval: str | None) -> int:
    if interval in INTERVAL_MS:
        return int(INTERVAL_MS[interval])
    if len(index) > 1:
        return int(np.median(np.diff(index)))
    return HOUR_MS


def session_mask(ts: np.ndarray, start: int, length: int) -> np.ndarray:
    """True for bars whose open hour (UTC) lies in [start, start + length) mod 24."""
    h = (np.asarray(ts, dtype=np.int64) // HOUR_MS) % 24
    return ((h - int(start)) % 24) < int(length)


def decision_bars(ts: np.ndarray, start: int, length: int, bar_ms: int) -> np.ndarray:
    """Bars whose close is the session's end (the last bar starting inside the session)."""
    ts = np.asarray(ts, dtype=np.int64)
    end_ms = ((int(start) + int(length)) % 24) * HOUR_MS
    close_tod = (ts + bar_ms) % DAY_MS
    return close_tod == end_ms


def signal_values(df, p: dict, interval: str | None) -> tuple[np.ndarray, np.ndarray]:
    """(signal at every decision bar or NaN elsewhere, decision mask)."""
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    bar_ms = _bar_ms(ts, interval)
    sess = session_mask(ts, p["sessStart"], p["sessLen"])
    dec = decision_bars(ts, p["sessStart"], p["sessLen"], bar_ms)
    if p["signal"] == "session":
        r = np.zeros(n)
        r[1:] = np.log(c[1:] / c[:-1])
        r = np.where(sess & np.isfinite(r), r, 0.0)
        num = np.concatenate([[0.0], np.cumsum(r)])
        den = None
    else:
        h = df["high"].to_numpy(np.float64)
        lo = df["low"].to_numpy(np.float64)
        v = df["volume"].to_numpy(np.float64) * c
        rng = h - lo
        with np.errstate(invalid="ignore", divide="ignore"):
            clv = np.where(rng > 0, ((c - lo) - (h - c)) / rng, 0.0)
        mf = np.where(sess & np.isfinite(clv) & np.isfinite(v), clv * v, 0.0)
        vv = np.where(sess & np.isfinite(v), v, 0.0)
        num = np.concatenate([[0.0], np.cumsum(mf)])
        den = np.concatenate([[0.0], np.cumsum(vv)])
    span = int(p["lookback"]) * DAY_MS
    # window of bars with open time in (t_close - span, t_close]: indices [j, i]
    j = np.searchsorted(ts, ts + bar_ms - span, side="left")
    out = np.full(n, np.nan)
    idx = np.nonzero(dec)[0]
    full = ts[idx] + bar_ms - span >= ts[0]          # the whole window is covered by data
    idx = idx[full]
    jj = j[idx]
    s = num[idx + 1] - num[jj]
    if den is not None:
        d = den[idx + 1] - den[jj]
        with np.errstate(invalid="ignore", divide="ignore"):
            s = np.where(d > 0, s / d, 0.0)
    out[idx] = s
    return out, dec


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    sig, dec = signal_values(df, p, spec.get("interval"))
    ts_len = int(p["trendSma"] or 0)
    # daily SMA on the decision-bar closes (one close per day)
    sma = np.full(n, np.nan)
    if ts_len:
        di = np.nonzero(dec)[0]
        dc = c[di]
        if len(dc) >= ts_len:
            cs = np.concatenate([[0.0], np.cumsum(dc)])
            vals = (cs[ts_len:] - cs[:-ts_len]) / ts_len
            sma[di[ts_len - 1:]] = vals
    hi, lo = float(p["enter"]), float(p["enter"]) - float(p["gap"])
    both = p["combine"] == "and"
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    state = False
    cur = np.nan
    for i in range(n):
        if dec[i] and np.isfinite(sig[i]) and (not ts_len or np.isfinite(sma[i])):
            state = sig[i] >= lo if state else sig[i] > hi
            if ts_len:
                core = c[i] > sma[i]
                on = (state and core) if both else (state or core)
            else:
                on = state
            cur = mw if on else 0.0
        w[i] = cur
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    a, ln = int(p["sessStart"]), int(p["sessLen"])
    sess = "the whole day" if ln >= 24 else f"{a:02d}:00-{(a + ln) % 24:02d}:00 UTC"
    hi, lo = float(p["enter"]), float(p["enter"]) - float(p["gap"])
    if p["signal"] == "session":
        first = (f"Every day at the end of the {sess} session it adds up how much {mk} rose or fell during only those "
                 f"hours over the last {int(p['lookback'])} days.")
        rule = f"It is in while that sum is above {hi:+.1%} and sells once it drops under {lo:+.1%}."
    else:
        first = (f"Every day at the end of the {sess} session it checks where {mk}'s hourly candles in those hours "
                 f"closed within their range over the last {int(p['lookback'])} days, weighted by euro volume "
                 "(+1 = always at the high, -1 = always at the low).")
        rule = f"It is in while that money-flow score is above {hi:+.2f} and sells once it drops under {lo:+.2f}."
    steps = [first, rule]
    t = int(p["trendSma"] or 0)
    if t:
        if p["combine"] == "and":
            steps.append(f"It also needs the price above its {t}-day average; under it, it stays in euros.")
        else:
            steps.append(f"It is also in whenever the price is above its {t}-day average.")
    return {
        "summary": f"Holds {mk} while the traders of one part of the day ({sess}) keep pushing the price up.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Trends carried by one group of buyers (for example US-hours flow) that the full-day price "
                      "shows only later.",
        "whenItLoses": "When the session's moves are just noise: it then trades like a slow, laggy trend filter.",
    }
