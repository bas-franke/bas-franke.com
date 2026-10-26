"""anchored_open: hold while the price is above the opening price of calendar periods (agent-14).

Traders watch the "weekly open", "monthly open", "quarterly open" and "yearly open" as support/resistance. This family
turns those anchors into a trend signal. For every chosen period (week, month, quarter, year, UTC calendar) the anchor
is either the open of the *current* period (the first bar's open of this week/month/...) or the open of the *previous*
period. A period votes "up" while the close is above its anchor. The coin is held while at least ``minVotes`` periods
vote up; with a hysteresis ``band`` a period only turns up above anchor*(1+band) and down below anchor*(1-band).

Unlike a moving average the look-back grows within a period and resets at its start, so the signal is a momentum
measured from fixed calendar dates. The first (partial) period in the data has no known anchor: undecided (NaN).
Every market is decided on its own candles and gets maxWeight / len(markets) while held. A decision at bar t uses the
candles up to and including t only (the current period's open is the open of a bar at or before t).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "anchored_open"
VERSION = 1
TITLE = "Calendar-open trend (weekly / monthly / quarterly / yearly open)"
BOT_READY = False
MULTI_MARKET = True

PERIODS = ("week", "month", "quarter", "year")
_WORD = {"week": "week", "month": "month", "quarter": "quarter", "year": "year"}


def default_params() -> dict:
    return {"useWeek": False, "useMonth": True, "useQuarter": True, "useYear": False,
            "anchor": "current", "minVotes": 1, "band": 0.0}


def param_space() -> dict:
    return {
        "useWeek": {"type": "bool", "description": "let the weekly open vote"},
        "useMonth": {"type": "bool", "description": "let the monthly open vote"},
        "useQuarter": {"type": "bool", "description": "let the quarterly open vote"},
        "useYear": {"type": "bool", "description": "let the yearly open vote"},
        "anchor": {"type": "choice", "values": ["current", "previous"],
                   "description": "compare with the open of the current period or of the previous one"},
        "minVotes": {"type": "int", "min": 1, "max": 4,
                     "description": "hold while at least this many chosen periods have the close above their open"},
        "band": {"type": "float", "min": 0.005, "max": 0.1, "log": True, "zero": True,
                 "description": "hysteresis: a period turns up above open*(1+band), down below open*(1-band)"},
    }


def _used(p: dict) -> list[str]:
    return [k for k in PERIODS if p.get("use" + k.capitalize())]


def valid_params(p: dict) -> str | None:
    n = len(_used(p))
    if n == 0:
        return "choose at least one period"
    if int(p["minVotes"]) > n:
        return "minVotes is larger than the number of chosen periods"
    return None


def warmup(p: dict) -> int:
    return 0          # data dependent: undecided until every chosen anchor is known


def _period_ids(ts: np.ndarray, period: str) -> np.ndarray:
    d = pd.to_datetime(np.asarray(ts, dtype=np.int64), unit="ms", utc=True)
    if period == "week":
        days = np.asarray(ts, dtype=np.int64) // 86_400_000
        return (days + 3) // 7                         # 1970-01-01 was a Thursday: weeks start on Monday
    y = d.year.to_numpy().astype(np.int64)
    m = d.month.to_numpy().astype(np.int64)
    if period == "month":
        return y * 12 + m - 1
    if period == "quarter":
        return y * 4 + (m - 1) // 3
    return y


def _anchors(ts: np.ndarray, opens: np.ndarray, period: str, which: str) -> np.ndarray:
    """Per bar: open of the current (or previous) period; NaN while unknown. The first period is partial: skipped."""
    pid = _period_ids(ts, period)
    n = len(pid)
    out = np.full(n, np.nan)
    if n == 0:
        return out
    starts = np.flatnonzero(np.r_[True, pid[1:] != pid[:-1]])
    first_open = {}
    for k, s in enumerate(starts):
        if k == 0:
            continue                                  # partial first period: its real open is not in the data
        first_open[int(pid[s])] = float(opens[s])
    bounds = list(starts) + [n]
    for k in range(len(starts)):
        s, e = bounds[k], bounds[k + 1]
        cur = int(pid[s])
        if which == "current":
            out[s:e] = first_open.get(cur, np.nan)
        else:
            if k >= 1:
                out[s:e] = first_open.get(int(pid[bounds[k - 1]]), np.nan)
    return out


def _held(df: pd.DataFrame, p: dict) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    o = df["open"].to_numpy(np.float64)
    band = float(p.get("band") or 0.0)
    need = int(p["minVotes"])
    used = _used(p)
    A = np.column_stack([_anchors(ts, o, per, p["anchor"]) for per in used])
    state = np.zeros(len(used), dtype=bool)
    out = np.full(len(c), np.nan)
    for i in range(len(c)):
        a = A[i]
        if not np.isfinite(c[i]) or not np.isfinite(a).all():
            continue
        up = c[i] > a * (1.0 + band)
        dn = c[i] < a * (1.0 - band)
        state = np.where(up, True, np.where(dn, False, state))
        out[i] = 1.0 if int(state.sum()) >= need else 0.0
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
    cols = [_asof(candles[m], _held(candles[m], p), idx) * each for m in markets]
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p = spec["params"]
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    used = _used(p)
    which = "this" if p.get("anchor") == "current" else "last"
    names = ", ".join(f"{which} {_WORD[u]}'s opening price" for u in used)
    need = int(p["minVotes"])
    band = float(p.get("band") or 0)
    rule = ("above " + names) if need == len(used) and len(used) == 1 else \
        (f"above at least {need} of: {names}")
    steps = [
        f"It looks at {names} (UTC calendar).",
        f"Buy/hold: it holds {mk} while the price is {rule}"
        + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        "Sell: it sells once fewer of those opening prices are below the price"
        + (f"; with a {pct(band)} band a level only counts as broken when the price is {pct(band)} past it." if band
           else "."),
    ]
    return {
        "summary": f"Holds {mk} while the price is above the {'/'.join(used)}ly opening price, otherwise euros.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long trends: the price stays above the month/quarter open and it rides along.",
        "whenItLoses": "Choppy months where the price crosses its opening price back and forth, and sharp drops early "
                       "in a period (the anchor is still high).",
    }
