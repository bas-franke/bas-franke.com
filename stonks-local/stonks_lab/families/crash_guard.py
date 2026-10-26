"""crash_guard v1 (agent-08, regime lane): invested by default, out only during deep crashes.

Why: under eval v2 every trend filter loses the big bull folds (ETH +879 % in 2020-21) by being in cash at the wrong
time (findings #124, #137). Trend filters exit on every dip under their average. This family flips the default: each
coin is held unless it is in a real crash, and it gets back in quickly.

Per coin (decided at the bar's close, candles up to and including that bar only):
- OUT when the close is at least ``ddMin`` below its highest close of the last ``ddLook`` candles AND (if ``sma`` > 0)
  below SMA(sma);
- back IN when the close beats the highest close of the previous ``reEntry`` candles (a short breakout: the crash has
  turned) and the drawdown condition no longer holds.

Every market in spec.markets has an equal slot of maxWeight / (number of markets with enough history at that bar);
coins without enough history get 0.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "crash_guard"
VERSION = 1
TITLE = "Crash guard"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"ddLook": 90, "ddMin": 0.25, "sma": 50, "reEntry": 10}


def param_space() -> dict:
    return {
        "ddLook": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "candles in the recent high the drop is measured from"},
        "ddMin": {"type": "float", "min": 0.05, "max": 0.6, "log": True,
                  "description": "sell when the close is this fraction below that high"},
        "sma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                "description": "sell only while the close is also under this SMA (0 = off)"},
        "reEntry": {"type": "int", "min": 2, "max": 100, "log": True,
                    "description": "buy back when the close beats the highest close of this many previous candles"},
    }


def warmup(p: dict) -> int:
    return max(int(p["ddLook"]), int(p.get("sma") or 0), int(p["reEntry"]) + 1)


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(ts, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def coin_state(c: np.ndarray, p: dict) -> np.ndarray:
    """1.0 in, 0.0 out, NaN before warm-up."""
    n = len(c)
    hi = ind.rolling_max(c, int(p["ddLook"]))
    crash = c <= hi * (1.0 - float(p["ddMin"]))
    sn = int(p.get("sma") or 0)
    if sn:
        s = ind.sma(c, sn)
        crash = crash & (c < s)
    brk = ind.prior_max(c, int(p["reEntry"]))
    out = np.full(n, np.nan)
    start = min(warmup(p), n)
    state = 1.0
    for t in range(start, n):
        if state == 1.0:
            if crash[t]:
                state = 0.0
        elif c[t] > brk[t] and not crash[t]:
            state = 1.0
        out[t] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    F = np.column_stack([_asof(candles[m], coin_state(candles[m]["close"].to_numpy(np.float64), p), idx)
                         for m in markets])
    ndef = np.isfinite(F).sum(axis=1)
    slot = np.divide(max_weight(spec), ndef, out=np.zeros(n), where=ndef > 0)
    W = np.nan_to_num(F, nan=0.0) * slot[:, None]
    first = int(np.argmax(ndef > 0)) if (ndef > 0).any() else n
    W[:first] = np.nan
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    k = len(spec.get("markets") or [])
    cond = f"its price is {pct(p['ddMin'])} or more below its highest close of the last {bars_text(p['ddLook'], iv)}"
    if int(p.get("sma") or 0):
        cond += f" and under its {bars_text(p['sma'], iv)} average"
    steps = [
        f"It normally holds {mk}" + (f", each with an equal share ({100 / k:.0f} %) of the money." if k > 1 else "."),
        f"It sells a coin only in a real crash: when {cond}.",
        f"It buys the coin back as soon as the close beats the highest close of the previous "
        f"{bars_text(p['reEntry'], iv)} and the crash condition no longer holds.",
    ]
    return {
        "summary": f"Stays invested in {mk} almost all the time and steps into euros only during deep crashes, "
                   "buying back on the first short breakout.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bear markets that keep falling after the first big drop (like 2018 or 2022).",
        "whenItLoses": "Sharp crashes that recover at once: it sells near the bottom and buys back higher.",
    }
