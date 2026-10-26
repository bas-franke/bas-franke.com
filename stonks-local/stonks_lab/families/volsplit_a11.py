"""volsplit_a11 v1 (agent-11): trend measured on the busy hours only (volume-split momentum, hourly candles).

Market-structure idea (Gervais-Kaniel "high-volume return premium", liquidity provision): a price move that happens
on heavy volume is informed flow and tends to persist; a move that happens in quiet, thin hours is mostly drift that
liquidity providers fade later. Every hour is labelled by its EUR volume relative to the median hourly EUR volume of
the previous ``volLook`` days: ``busy`` when it trades at least ``hiMult`` times that median, ``quiet`` when at most
1x. The signal, summed over the last ``lookback`` days of hourly log returns:

    signal = sum(returns of busy hours) - loWeight * sum(returns of quiet hours)

``mode="plain"`` replaces it with the plain sum of all hourly returns (= the ``lookback``-day log return): the
built-in ablation, so a paired run with the same knobs shows what the volume split adds.

It decides once per day, at the close of the hour ending at ``decideHour`` UTC, holds while the signal is above
``enter`` and sells once it drops under ``enter - gap``. Optional daily SMA core (``trendSma`` days on the decision
closes): "and" = filter, "or" = either keeps it in. Made for 1h candles (works on 15m-2h). Decisions at bar t use
candles up to and including bar t (the volume median uses earlier bars only).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..data import INTERVAL_MS
from ._base import frame, market_names, max_weight, risk_steps, single_market

NAME = "volsplit_a11"
VERSION = 1
TITLE = "Busy-hour trend (volume-split momentum)"
BOT_READY = False
MULTI_MARKET = False

DAY_MS = 86_400_000
HOUR_MS = 3_600_000


def default_params() -> dict:
    return {"mode": "split", "lookback": 20, "volLook": 30, "hiMult": 1.5, "loWeight": 1.0, "enter": 0.0,
            "gap": 0.0, "trendSma": 0, "combine": "and", "decideHour": 0}


def param_space() -> dict:
    return {
        "mode": {"type": "choice", "values": ["split", "plain"],
                 "description": "split = busy-hour returns minus loWeight x quiet-hour returns; plain = all hours "
                                "(ablation: the plain lookback-day return)"},
        "lookback": {"type": "int", "min": 3, "max": 200, "log": True,
                     "description": "days over which the hourly returns are summed"},
        "volLook": {"type": "int", "min": 5, "max": 120, "log": True,
                    "description": "days of hourly EUR volume whose median defines a normal hour"},
        "hiMult": {"type": "float", "min": 1.0, "max": 4.0, "log": True,
                   "description": "an hour is busy when its EUR volume is at least this times the median"},
        "loWeight": {"type": "float", "min": 0.0, "max": 2.0,
                     "description": "weight of the quiet-hour (volume <= median) returns subtracted from the signal"},
        "enter": {"type": "float", "min": -0.2, "max": 0.2,
                  "description": "hold while the signal (log return) is above this"},
        "gap": {"type": "float", "min": 0.0, "max": 0.2,
                "description": "hysteresis: sell only when the signal falls under enter minus this"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                     "description": "daily SMA core in days combined with the signal (0 = off)"},
        "combine": {"type": "choice", "values": ["and", "or"],
                    "description": "and = need both signal and close > SMA; or = either one is enough"},
        "decideHour": {"type": "int", "min": 0, "max": 23,
                       "description": "UTC hour (candle close) at which the daily decision is made"},
    }


def warmup(p: dict) -> int:
    return 24 * (max(int(p["lookback"]) + int(p["volLook"]), int(p["trendSma"] or 0)) + 2)


def _bar_ms(index: np.ndarray, interval: str | None) -> int:
    if interval in INTERVAL_MS:
        return int(INTERVAL_MS[interval])
    if len(index) > 1:
        return int(np.median(np.diff(index)))
    return HOUR_MS


def signal_values(df, p: dict, interval: str | None) -> tuple[np.ndarray, np.ndarray]:
    """(signal at every decision bar, NaN elsewhere; decision mask)."""
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    bar_ms = _bar_ms(ts, interval)
    per_day = max(1, DAY_MS // bar_ms)
    r = np.zeros(n)
    r[1:] = np.log(c[1:] / c[:-1])
    r[~np.isfinite(r)] = 0.0
    if p["mode"] == "plain":
        x = r
    else:
        v = df["volume"].to_numpy(np.float64) * c
        vl = int(p["volLook"]) * per_day
        med = pd.Series(v).rolling(vl, min_periods=max(2, vl // 2)).median().shift(1).to_numpy()
        with np.errstate(invalid="ignore", divide="ignore"):
            rel = v / med
        ok = np.isfinite(rel)
        busy = ok & (rel >= float(p["hiMult"]))
        quiet = ok & (rel <= 1.0)
        x = np.where(busy, r, 0.0) - float(p["loWeight"]) * np.where(quiet, r, 0.0)
        x[:1] = 0.0
        first = np.argmax(ok) if ok.any() else n          # first bar with a volume baseline
    cs = np.concatenate([[0.0], np.cumsum(x)])
    span = int(p["lookback"]) * DAY_MS
    dec = ((ts + bar_ms) % DAY_MS) == (int(p["decideHour"]) % 24) * HOUR_MS
    j = np.searchsorted(ts, ts + bar_ms - span, side="left")
    out = np.full(n, np.nan)
    idx = np.nonzero(dec)[0]
    full = ts[idx] + bar_ms - span >= ts[0]
    if p["mode"] != "plain":
        full &= j[idx] >= first
    idx = idx[full]
    out[idx] = cs[idx + 1] - cs[j[idx]]
    return out, dec


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    sig, dec = signal_values(df, p, spec.get("interval"))
    ts_len = int(p["trendSma"] or 0)
    sma = np.full(n, np.nan)
    if ts_len:
        di = np.nonzero(dec)[0]
        dc = c[di]
        if len(dc) >= ts_len:
            cs = np.concatenate([[0.0], np.cumsum(dc)])
            sma[di[ts_len - 1:]] = (cs[ts_len:] - cs[:-ts_len]) / ts_len
    hi, lo = float(p["enter"]), float(p["enter"]) - float(p["gap"])
    both = p["combine"] == "and"
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    state, cur = False, np.nan
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
    hi, lo = float(p["enter"]), float(p["enter"]) - float(p["gap"])
    lb, h = int(p["lookback"]), int(p["decideHour"]) % 24
    if p["mode"] == "plain":
        first = f"Every day at {h:02d}:00 UTC it looks at how much {mk} rose or fell over the last {lb} days."
    else:
        first = (f"Every day at {h:02d}:00 UTC it adds up {mk}'s hourly moves of the last {lb} days, but only of the "
                 f"busy hours (at least {float(p['hiMult']):.1f}x the normal hourly euro volume of the last "
                 f"{int(p['volLook'])} days), and subtracts {float(p['loWeight']):.1f}x the moves of the quiet hours.")
    steps = [first, f"It is in while that sum is above {hi:+.1%} and sells once it drops under {lo:+.1%}."]
    t = int(p["trendSma"] or 0)
    if t:
        steps.append(f"It also needs the price above its {t}-day average; under it, it stays in euros."
                     if p["combine"] == "and" else f"It is also in whenever the price is above its {t}-day average.")
    return {
        "summary": f"Holds {mk} while the price climbs in the hours with heavy trading, ignoring quiet-hour drift.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Rallies driven by real buying volume; quiet-hour drift that later fades no longer fools it.",
        "whenItLoses": "Choppy markets where busy hours swing both ways: it then trades like a laggy trend filter.",
    }
