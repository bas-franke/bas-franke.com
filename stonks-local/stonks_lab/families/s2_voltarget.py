"""s2_voltarget: stay invested, and size the book by recent daily volatility."""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "s2_voltarget"
VERSION = 1
TITLE = "Volatility size"
BOT_READY = False
MULTI_MARKET = False
DAY_MS = 86_400_000


def default_params() -> dict:
    return {"stepDays": 16, "lookDays": 25, "k": 0.048, "floor": 0.3, "cap": 0.9}


def param_space() -> dict:
    return {
        "stepDays": {"type": "int", "min": 10, "max": 20, "description": "days between size changes"},
        "lookDays": {"type": "int", "min": 20, "max": 40, "description": "days of daily returns in the volatility"},
        "k": {"type": "float", "min": 0.02, "max": 0.08, "description": "size equals this divided by the volatility"},
        "floor": {"type": "float", "min": 0.2, "max": 0.5, "description": "smallest size"},
        "cap": {"type": "float", "min": 0.6, "max": 0.95, "description": "largest size"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["floor"]) >= float(p["cap"]):
        return "the floor must sit under the cap"
    return None


def warmup(p: dict) -> int:
    return int(p["lookDays"]) + int(p["stepDays"])


def _bar_ms(ts: np.ndarray) -> int:
    if ts.shape[0] < 2:
        return DAY_MS
    gaps = np.diff(ts.astype(np.int64, copy=False))
    gaps = gaps[gaps > 0]
    return DAY_MS if gaps.size == 0 else int(np.median(gaps))


def _daily_returns(ts, close):
    empty_r = np.empty(0, dtype=np.float64)
    empty_i = np.empty(0, dtype=np.int64)
    n = int(ts.shape[0])
    if n < 2:
        return empty_r, empty_i, empty_i
    bar_ms = _bar_ms(ts)
    day = ts // DAY_MS
    idx = np.flatnonzero((ts + bar_ms) >= (day + 1) * DAY_MS)
    if idx.size < 2:
        return empty_r, empty_i, empty_i
    d_close = close[idx]
    d_day = day[idx]
    span = d_day[1:] - d_day[:-1]
    ok = (span == 1) & np.isfinite(d_close[1:]) & np.isfinite(d_close[:-1]) & (d_close[1:] > 0) & (d_close[:-1] > 0)
    return d_close[1:][ok] / d_close[:-1][ok] - 1.0, d_day[1:][ok].astype(np.int64, copy=False), idx[1:][ok].astype(np.int64, copy=False)


def _weights(df, step_days: int, look_days: int, k: float, floor: float, cap: float) -> np.ndarray:
    close = np.asarray(df["close"], dtype=np.float64)
    ts = np.asarray(df.index, dtype=np.int64)
    n = int(close.shape[0])
    out = np.full(n, cap, dtype=np.float64)
    if n == 0:
        return out
    day = ts // DAY_MS
    rets, end_day, at = _daily_returns(ts, close)
    if rets.size == 0:
        return out
    completes = (ts + _bar_ms(ts)) >= (day + 1) * DAY_MS
    weight = cap
    last = None
    for i in np.flatnonzero(completes):
        d = int(day[i])
        if last is not None and d - last < step_days:
            continue
        hi = int(np.searchsorted(at, i, side="right"))
        if hi <= 0 or int(end_day[hi - 1]) != d:
            continue
        lo = int(np.searchsorted(end_day[:hi], d - look_days + 1, side="left"))
        if hi - lo != look_days:
            continue
        sd = float(np.std(rets[lo:hi], ddof=1))
        weight = cap if not np.isfinite(sd) or sd <= 1e-12 else float(np.clip(k / sd, floor, cap))
        last = d
        out[i:] = weight
    return out


def targets(candles, spec, start_time=None):
    del start_time
    m, df = single_market(candles, spec)
    p = spec["params"]
    w = _weights(df, int(p["stepDays"]), int(p["lookDays"]), float(p["k"]), float(p["floor"]), float(p["cap"]))
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, mk = spec["params"], market_names(spec)
    return {
        "summary": (
            f"Stays invested in {mk}. Every {int(p['stepDays'])} days the size is {p['k']} divided by the "
            f"volatility of the last {int(p['lookDays'])} daily returns, held between {pct(p['floor'])} and {pct(p['cap'])}."
        ),
        "howItWorks": [
            "A daily return is one completed UTC day's close divided by the previous day's close.",
            f"Every {int(p['stepDays'])} days the size is reset. Between those days it holds the last size.",
            "A wild market gets the small size. A quiet market, including a flat stretch, gets the large size.",
            "The book never goes flat. Until a full window exists it holds the large size.",
        ] + risk_steps(spec),
        "whenItWins": "A grind that stays quiet, so the book sits near the large size, and a crash that is wild enough to cut the size.",
        "whenItLoses": "A quiet rise that then trends hard: the size was large into the turn, and a wild bull market is held too small.",
    }
