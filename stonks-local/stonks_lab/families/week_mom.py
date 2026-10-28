"""week_mom v1: long when the lookback return is above a hurdle, and only reconsider that once a week.

The decision hours are the first hour the return exists, and every `every` bars from the start of the
file. Between those hours the weight is frozen. Bar i uses only closes through i.
"""
from __future__ import annotations

import numpy as np

from stonks_lab import indicators as ind

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "week_mom"
VERSION = 1
TITLE = "Weekly return"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"lag": 672, "thr": 0.08, "every": 168}


def param_space() -> dict:
    return {
        "lag": {"type": "int", "min": 2, "max": 4000, "log": True, "description": "return lookback in candles"},
        "thr": {"type": "float", "min": 0.0, "max": 0.5, "description": "minimum return required to stay long"},
        "every": {"type": "int", "min": 1, "max": 2000, "description": "hours between decisions"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return int(p["lag"])


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    lag, thr, every = int(p["lag"]), float(p["thr"]), int(p["every"])
    close = df["close"].to_numpy(np.float64)
    prev = ind.shift(close, lag)
    raw = np.full(len(close), np.nan)
    ok = np.isfinite(close) & np.isfinite(prev) & (prev > 0.0)
    raw[ok] = np.where(close[ok] / prev[ok] - 1.0 > thr, 1.0, 0.0)
    finite = np.isfinite(raw)
    out = np.full(len(close), np.nan)
    if finite.any():
        first = int(np.argmax(finite))
        weekly = np.zeros(len(close), dtype=bool)
        weekly[:: max(every, 1)] = True
        weekly[first] = True
        idx = np.flatnonzero(finite & weekly)
        pos = np.arange(len(close))
        k = np.searchsorted(idx, pos, side="right") - 1
        valid = k >= 0
        out[valid] = raw[idx[k[valid]]]
    mw = max_weight(spec)
    w = np.where(np.isfinite(out), np.where(out >= 0.5, mw, 0.0), np.nan)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": f"Holds {mk} when its recent return clears a hurdle, and only checks that once a week.",
        "howItWorks": [
            f"The return is the close now divided by the close {bars_text(int(p['lag']), iv)} ago, minus one.",
            f"It buys the whole account when that return is above {pct(p['thr'])}, and sells everything when it is not.",
            f"It only makes that choice on the first hour the return exists, and then every "
            f"{bars_text(int(p['every']), iv)} from the start of the file. In between, it holds the last choice.",
        ] + risk_steps(spec),
        "whenItWins": "A rise that lasts longer than the lookback, and a decline that stays negative so the account sits in euros.",
        "whenItLoses": "A sharp week that reverses before the next check, and a climb that never quite clears the hurdle.",
    }
