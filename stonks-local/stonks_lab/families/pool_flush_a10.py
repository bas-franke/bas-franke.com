"""pool_flush_a10 v1 (agent-10): a daily trend core plus an HOURLY flush buy triggered by the 2019 alt pool.

Signal study (finding, wave 7, pre-holdout 1h 2019-2025): when the equal-weight 2019 alt pool (XRP ADA LINK TRX LTC
BCH XLM XTZ MIOTA, the alt_froth pool: no hindsight in coin choice) falls in its worst 0.5 % of 24-hour moves,
BTC beats its yearly mean by +2.5 % over the next 24 h (6/6 years) and ETH by +3.9 %; BTC's own worst 24 h gives
+2.1 / +2.3 %. The bounce is fast (mostly within 1-3 days), which daily panic families (holding 30-100 days) can't
isolate. This family trades it on 1h candles:

- core: hold while the last completed UTC day's close (the 23:00 hourly candle) is above the SMA of the last
  ``coreDays`` daily closes (0 = no core). The core changes at most once a day.
- flush: at the hourly close where the ``source`` return over ``flushHours`` hours FIRST falls to ``-dropMin`` (log) or
  below (an edge: staying below does not re-trigger), it buys and holds for ``holdHours`` hours (a new flush inside a
  trade does not extend it). ``source`` "pool" = mean
  log return of the alt pool (at least 3 coins with data), "own" = the traded coin's own return (the ablation twin).
- held (maxWeight) while core or flush is on, else cash. A target is emitted on every bar.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "pool_flush_a10"
VERSION = 1
TITLE = "Daily trend core + hourly alt-pool flush buy"
BOT_READY = False
MULTI_MARKET = False

H_MS = 3_600_000
POOL = ["XRP-EUR", "ADA-EUR", "LINK-EUR", "TRX-EUR", "LTC-EUR", "BCH-EUR", "XLM-EUR", "XTZ-EUR", "MIOTA-EUR"]
MIN_POOL = 3


def default_params() -> dict:
    return {"coreDays": 130, "source": "pool", "flushHours": 24, "dropMin": 0.15, "holdHours": 48}


def param_space() -> dict:
    return {
        "coreDays": {"type": "int", "min": 20, "max": 400, "zero": True, "log": True,
                     "description": "hold while the daily close is above its average over this many days (0 = off)"},
        "source": {"type": "choice", "values": ["pool", "own"],
                   "description": "whose crash triggers the buy: the 2019 alt pool or the traded coin itself"},
        "flushHours": {"type": "int", "min": 3, "max": 96, "log": True,
                       "description": "hours over which the crash is measured"},
        "dropMin": {"type": "float", "min": 0.03, "max": 0.4,
                    "description": "buy when the source fell at least this much (log return) over flushHours"},
        "holdHours": {"type": "int", "min": 2, "max": 2000, "log": True,
                      "description": "hours a flush buy is held"},
    }


def warmup(p: dict) -> int:
    return max(24 * (int(p.get("coreDays") or 0) + 1), int(p["flushHours"]))


def required_markets(spec: dict) -> list[str]:
    ms = list(spec.get("markets") or [])
    if (spec.get("params") or {}).get("source", "pool") == "pool":
        ms += [m for m in POOL if m not in ms]
    return ms


def _past_logret(df: pd.DataFrame, idx: np.ndarray, hours: int) -> np.ndarray:
    """log(close as of t / close as of t - hours) on idx, using only candles at or before each time."""
    t = np.asarray(df.index, dtype=np.int64)
    c = np.log(df["close"].to_numpy(np.float64))
    now = np.searchsorted(t, idx, side="right") - 1
    then = np.searchsorted(t, idx - hours * H_MS, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = (now >= 0) & (then >= 0) & (idx - t[np.clip(now, 0, None)] <= 3 * H_MS)  # stale (delisted) coin = no data
    out[ok] = c[now[ok]] - c[then[ok]]
    return out


def daily_core(df: pd.DataFrame, days: int) -> np.ndarray:
    """Core state per hourly bar: last completed day's close (23:00 candle) above the SMA of ``days`` such closes."""
    ts = np.asarray(df.index, dtype=np.int64)
    n = len(ts)
    if days <= 0:
        return np.zeros(n, dtype=bool)
    close = df["close"].to_numpy(np.float64)
    eod = np.flatnonzero((ts // H_MS) % 24 == 23)
    dc = pd.Series(close[eod])
    sma = dc.rolling(days, min_periods=days).mean().to_numpy()
    on_eod = np.where(np.isfinite(sma), dc.to_numpy() > sma, np.nan)
    state = np.full(n, np.nan)
    state[eod] = on_eod
    state = pd.Series(state).ffill().to_numpy()
    return np.nan_to_num(state, nan=0.0) > 0.5


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    idx = np.asarray(df.index, dtype=np.int64)
    n = len(idx)
    fh, drop, hold = int(p["flushHours"]), float(p["dropMin"]), int(p["holdHours"])
    if p["source"] == "pool":
        tot, cnt = np.zeros(n), np.zeros(n)
        for a in POOL:
            if a not in candles:
                continue
            r = _past_logret(candles[a], idx, fh)
            ok = np.isfinite(r)
            tot[ok] += r[ok]
            cnt[ok] += 1
        sig = np.divide(tot, cnt, out=np.full(n, np.nan), where=cnt >= MIN_POOL)
    else:
        sig = _past_logret(df, idx, fh)
    core = daily_core(df, int(p.get("coreDays") or 0))
    below = np.isfinite(sig) & (sig <= -drop)
    fresh = below & ~np.concatenate([[False], below[:-1]])   # the crash first crosses the line (edge, not level)
    flush = np.zeros(n, dtype=bool)
    until = -1
    for i in range(n):
        if idx[i] <= until:
            flush[i] = True
        elif fresh[i]:
            until = idx[i] + (hold - 1) * H_MS
            flush[i] = True
    w = np.where(core | flush, max_weight(spec), 0.0)
    ready = max(24 * (int(p.get("coreDays") or 0) + 1), fh)
    start = int(np.searchsorted(idx, idx[0] + ready * H_MS)) if n else 0
    w[:start] = np.nan
    return frame(idx, {m: w})


def explain(spec) -> dict:
    p = spec["params"]
    mk = market_names(spec)
    who = ("the 2019 altcoins (XRP, ADA, LINK, TRX, LTC, BCH, XLM, XTZ, IOTA) on average" if p["source"] == "pool"
           else f"{mk} itself")
    steps = [f"Every hour it checks how far {who} fell over the last {int(p['flushHours'])} hours.",
             f"If that fall is at least {pct(p['dropMin'])}, it buys {mk} and keeps it for "
             f"{int(p['holdHours'])} hours, betting on a quick rebound after a crash."]
    if int(p.get("coreDays") or 0):
        steps.append(f"Besides those crash buys it holds {mk} whenever the last daily close is above its average "
                     f"over {int(p['coreDays'])} days (checked once a day at midnight UTC).")
    return {
        "summary": f"Holds {mk} in uptrends and buys sharp market-wide crashes for a short rebound.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets (the trend core) and violent crashes that bounce within hours or days.",
        "whenItLoses": "Crashes that keep falling after the buy, and choppy markets around the average.",
    }
