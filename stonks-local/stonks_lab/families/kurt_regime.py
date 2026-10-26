"""kurt_regime: the shape of recent returns as a regime filter (agent-06).

A signal study on BTC-EUR 1d (2019-2026) found the rolling excess kurtosis of daily log returns sorts the next
30 days: lowest quintile (a calm, even grind; kurt30 < ~0.1) averaged -3.4 % forward, highest (a recent outsized
move; kurt30 > ~3.3) +6.9 %, and the top-minus-bottom spread was positive in 6 of 8 calendar years. On ETH the bad
cell is a calm grind *below* a long SMA (-11..-22 % forward 30 days). Kurtosis is scale-free, so it does not
measure volatility; it measures whether recent returns came as one shock (capitulation, squeeze) or as a steady
drift.

- kurt = sample excess kurtosis of the last ``kurtLen`` daily-bar log returns (closes up to and including bar t).
- mode ``gate``: hold while kurt >= kurtMin.
- mode ``or_sma``: hold while the close is above SMA(smaLen) OR kurt >= kurtMin (a trend core that stays in after
  shocks below its average).
- mode ``and_sma``: hold while the close is above SMA(smaLen) AND kurt >= kurtMin (a trend core that steps aside in
  calm grinds).
- ``minHold``: once bought, keep the position at least this many bars (0 = off), so the window edge of a shock
  doesn't flip it back and forth.

Every market is decided on its own candles and gets maxWeight / len(markets) while held.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "kurt_regime"
VERSION = 1
TITLE = "Return-kurtosis regime"
BOT_READY = False
MULTI_MARKET = True

MODES = ["gate", "or_sma", "and_sma"]


def default_params() -> dict:
    return {"kurtLen": 30, "kurtMin": 0.5, "mode": "or_sma", "smaLen": 150, "minHold": 0}


def param_space() -> dict:
    return {
        "kurtLen": {"type": "int", "min": 10, "max": 250, "log": True,
                    "description": "candles of returns the kurtosis is measured over"},
        "kurtMin": {"type": "float", "min": -1.0, "max": 12.0,
                    "description": "excess kurtosis at or above which returns count as 'shock' (hold) rather than 'calm grind'"},
        "mode": {"type": "choice", "values": MODES,
                 "description": "gate = kurtosis alone; or_sma = above SMA or shock; and_sma = above SMA and shock"},
        "smaLen": {"type": "int", "min": 20, "max": 400, "log": True,
                   "description": "trend average for the or_sma/and_sma modes"},
        "minHold": {"type": "int", "min": 1, "max": 90, "log": True, "zero": True,
                    "description": "keep a new position at least this many candles (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if p.get("mode") not in MODES:
        return f"mode must be one of {MODES}"
    return None


def warmup(p: dict) -> int:
    w = int(p["kurtLen"])
    if p.get("mode") != "gate":
        w = max(w, int(p["smaLen"]) - 1)
    return w


def _held(c: np.ndarray, p: dict) -> np.ndarray:
    r = pd.Series(np.log(c)).diff()
    n = int(p["kurtLen"])
    k = r.rolling(n, min_periods=n).kurt().to_numpy(np.float64)
    mode = p.get("mode", "gate")
    shock = k >= float(p["kurtMin"])
    if mode == "gate":
        ok = np.isfinite(k)
        sig = shock
    else:
        s = ind.sma(c, int(p["smaLen"]))
        ok = np.isfinite(k) & np.isfinite(s) & np.isfinite(c)
        above = c > s
        sig = (above | shock) if mode == "or_sma" else (above & shock)
    mh = int(p.get("minHold") or 0)
    out = np.full(len(c), np.nan)
    inside, held = False, 0
    for i in range(len(c)):
        if not ok[i]:
            continue
        if inside:
            held += 1
            if not sig[i] and held >= mh:
                inside = False
        elif sig[i]:
            inside, held = True, 0
        out[i] = 1.0 if inside else 0.0
    return out


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    cols = [_asof(candles[m], _held(candles[m]["close"].to_numpy(np.float64), p), idx) * each for m in markets]
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    mode = p.get("mode", "gate")
    look = bars_text(p["kurtLen"], iv)
    shock = (f"the price moves of the last {look} were 'lumpy' (one or a few outsized moves rather than an even "
             f"drift; excess kurtosis {float(p['kurtMin']):.1f} or more)")
    avg = f"its average of the last {bars_text(p['smaLen'], iv)}"
    if mode == "gate":
        rule = f"It holds {mk} while {shock}, and is in cash during calm, even-paced stretches."
    elif mode == "or_sma":
        rule = f"It holds {mk} while the price is above {avg}, and also below it as long as {shock}."
    else:
        rule = f"It holds {mk} only while the price is above {avg} and {shock}."
    steps = [rule + (f" ({100 / k:.0f} % of the money per coin.)" if k > 1 else "")]
    mh = int(p.get("minHold") or 0)
    if mh:
        steps.append(f"After buying it keeps the position at least {bars_text(mh, iv)}.")
    steps.append("Otherwise it keeps what it has.")
    return {
        "summary": f"Uses how 'lumpy' recent price moves of {mk} were: calm, steady drifts are treated as a warning.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Rebounds after a crash day or a sharp squeeze, and slow bleeds it can step out of.",
        "whenItLoses": "Steady, calm bull runs (it may sit them out) and crashes that keep coming in many small steps.",
    }
