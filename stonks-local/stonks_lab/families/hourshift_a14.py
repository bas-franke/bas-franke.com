"""hourshift_a14 v1 (agent-14): the close-hour check (#505) for ANY daily/12h spec, without presets.

phase_shift (agent-10) and its copies (hour_check_a21, hourcheck_a19, wick_hours_a22, ...) each freeze a short list of
leads as presets, so every new lead needs a new family. This one takes the lead itself as a param:

    "params": {"hour": "07", "period": "24",
               "inner": {"family": "powerlaw_band", "params": {...the lead's params...}}}

On 1h candles it builds candles of ``period`` hours (24 = daily, 12 = 12h) that open at ``hour`` UTC (open = first
hour, high/low = extremes, close = last hour, volume = sum), runs the inner family on them as interval 1d (or 12h)
with the lead's frozen params, and places each decision at the close of that candle's last hourly bar. Between
decisions the targets are NaN (position left alone), so it trades at most once per candle like the original.
``hour`` "00" reproduces the native candles. A candle counts only once the data reaches its last hour.

``hour`` is a string choice ("00".."23") so neighbouring hours are never near-duplicates (an int hour 20 vs 21 is
within the registry's 5 % tolerance). ``inner`` is not in the param space: check_space ignores it, sweeps keep the
default, and the registry treats it as a non-numeric knob (a different lead = a different spec).
Run on 1h with execution ``{"timeoutBars": 24}`` (12 for period 12) so a missed limit stays active for one candle,
as on native 1d/12h bars. Extra markets the inner family needs (alt pools) are requested via required_markets.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import get_family
from ._base import frame, market_names, max_weight, normalize_spec, risk_steps, union_index

NAME = "hourshift_a14"
VERSION = 1
TITLE = "Any daily lead with a shifted daily close"
BOT_READY = False
MULTI_MARKET = True

H_MS = 3_600_000
HOURS = [f"{h:02d}" for h in range(24)]
DEFAULT_INNER = {"family": "stale_trend", "params": {"coreLen": 130, "hiLook": 60, "staleBars": 0}}


def default_params() -> dict:
    return {"hour": "00", "period": "24", "inner": DEFAULT_INNER}


def param_space() -> dict:
    return {
        "hour": {"type": "choice", "values": HOURS,
                 "description": "UTC hour at which each candle opens and the previous one closes"},
        "period": {"type": "choice", "values": ["24", "12"],
                   "description": "candle length in hours the inner lead runs on (24 = 1d, 12 = 12h)"},
    }


def valid_params(p: dict) -> str | None:
    inner = p.get("inner")
    if not isinstance(inner, dict) or not isinstance(inner.get("family"), str):
        return "inner must be {'family': name, 'params': {...}}"
    try:
        fam = get_family(inner["family"])
    except Exception:
        return f"unknown inner family {inner.get('family')!r}"
    if fam.anchored:
        return "anchored (DCA-style) inner families are not supported"
    if inner["family"] == NAME:
        return "inner cannot be hourshift_a14 itself"
    return fam.validate({"params": dict(inner.get("params") or {})})


def _inner(spec: dict) -> tuple:
    p = spec["params"]
    inner = p.get("inner") or DEFAULT_INNER
    fam = get_family(inner["family"])
    iv = "12h" if str(p.get("period", "24")) == "12" else "1d"
    s = normalize_spec({"family": inner["family"], "markets": list(spec.get("markets") or []), "interval": iv,
                        "params": dict(inner.get("params") or {}), "risk": {"maxWeight": max_weight(spec)}}, fam)
    return fam, s


def warmup(p: dict) -> int:
    inner = p.get("inner") or DEFAULT_INNER
    fam = get_family(inner["family"])
    per = 12 if str(p.get("period", "24")) == "12" else 24
    return per * (int(fam.warmup({**fam.default_params(), **(inner.get("params") or {})})) + 2)


def required_markets(spec: dict) -> list[str]:
    fam, inner = _inner(spec)
    return fam.markets_needed(inner)


def shifted_candles(df: pd.DataFrame, hour: int, period: int = 24) -> tuple[pd.DataFrame, np.ndarray]:
    """Candles of ``period`` hours opening at ``hour`` UTC built from 1h candles, plus each one's last-hour start time.
    Only candles whose last hour is in the data are kept (an unfinished candle is never used)."""
    ts = np.asarray(df.index, dtype=np.int64)
    if len(ts) == 0:
        return df.iloc[:0], np.zeros(0, dtype=np.int64)
    p_ms = period * H_MS
    hour = hour % period
    key = (ts - hour * H_MS) // p_ms
    g = df.groupby(key, sort=True)
    out = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                        "close": g["close"].last(), "volume": g["volume"].sum()})
    k = out.index.to_numpy(np.int64)
    last_hour = k * p_ms + hour * H_MS + (period - 1) * H_MS
    keep = last_hour <= ts[-1]
    out = out[keep]
    out.index = pd.Index(k[keep] * p_ms + hour * H_MS, name="ts")
    return out, last_hour[keep]


def targets(candles, spec, start_time=None):
    p = spec["params"]
    hour = int(p["hour"])
    period = 12 if str(p["period"]) == "12" else 24
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    fam, inner = _inner(spec)
    shifted = {}
    for m in fam.markets_needed(inner):
        if m in candles:
            shifted[m], _ = shifted_candles(candles[m], hour, period)
    out = {m: np.full(len(idx), np.nan) for m in markets}
    if markets[0] not in shifted or len(shifted[markets[0]]) == 0:
        return frame(idx, out)
    w = fam.targets(shifted, inner)
    if len(w) == 0:
        return frame(idx, out)
    # the decision of the candle opening at D is known at the close of its last hourly bar (opening D + period-1 h)
    dts = np.asarray(w.index, dtype=np.int64) + (period - 1) * H_MS
    pos = np.searchsorted(idx, dts, side="left")
    ok = pos < len(idx)                        # a missing hourly bar moves the decision to the next one
    for m in markets:
        col = w[m].to_numpy(np.float64) if m in w.columns else np.zeros(len(w))
        out[m][pos[ok]] = col[ok]
    return frame(idx, out)


def explain(spec) -> dict:
    p = spec["params"]
    inner = p.get("inner") or DEFAULT_INNER
    name = inner.get("family", "?")
    try:
        fam, s = _inner(spec)
        ex = fam.explain(s)
        inner_steps = list(ex.get("howItWorks") or [])[:4]
        wins, loses = ex.get("whenItWins", ""), ex.get("whenItLoses", "")
    except Exception:  # pragma: no cover - explanation must never break publishing
        inner_steps, wins, loses = [], "", ""
    mk = market_names(spec)
    h = int(p["hour"])
    if str(p["period"]) == "12":
        when = (f"Its 12-hour candles start at {h % 12:02d}:00 and {h % 12 + 12:02d}:00 UTC instead of 00:00 and "
                "12:00, so it decides twice a day at those hours.")
    else:
        when = f"Its days start and end at {h:02d}:00 UTC instead of midnight, so it decides once a day at that hour."
    return {
        "summary": f"The fleet strategy '{name}' on {mk}, deciding at {h:02d}:00 UTC.",
        "howItWorks": [f"It runs the fleet strategy '{name}' on {mk} with fixed settings.", when, *inner_steps]
                      + risk_steps(spec),
        "whenItWins": wins or "Same as the strategy it wraps.",
        "whenItLoses": loses or "Same as the strategy it wraps; plus luck in the hour it decides.",
    }
