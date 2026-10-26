"""floor_wrap_a07 v1 (agent-07): any fleet lead with a permanent minimum position (core-satellite).

A real-money owner rarely goes 100 % to cash on a trend signal. This wrapper keeps ``floor`` of the money in the
coins all the time and lets the wrapped lead (``inner``, frozen params) steer only the rest:

    weight = maxWeight x (floor / n + (1 - floor) x inner weight)        per market, n = number of markets

``floor`` 0 reproduces the lead exactly; ``floor`` 1 would be buy and hold (capped at 0.8). The inner family runs on
the same candles and interval as this spec, so wrapping ``hourshift_a14`` (on 1h) gives the close-hour check of a
floored lead, and wrapping ``placebo_timing`` gives its luck line at the same floor.

Rows where the inner lead has not decided (warm-up, or hours between daily decisions of hourshift/phase_shift) stay
NaN, so the position is left alone there; in a decided row a NaN cell counts as an inner weight of 0.
``inner`` is not in the param space (like hourshift_a14): sweeps keep the default and the registry treats it as a
non-numeric knob, so a different lead is a different spec.
"""
from __future__ import annotations

import numpy as np

from . import get_family
from ._base import frame, market_names, max_weight, normalize_spec, pct, risk_steps, union_index

NAME = "floor_wrap_a07"
VERSION = 1
TITLE = "Any lead with a permanent minimum position"
BOT_READY = False
MULTI_MARKET = True

DEFAULT_INNER = {"family": "alt_froth", "params": {"band": 0.05, "lookback": 120, "minOut": 0, "threshold": 0.1,
                                                 "trendSma": 0}}


def default_params() -> dict:
    return {"floor": 0.3, "inner": DEFAULT_INNER}


def param_space() -> dict:
    return {
        "floor": {"type": "float", "min": 0.0, "max": 0.8, "zero": True,
                  "description": "share of the money that always stays in the coins; the lead steers the rest"},
    }


def valid_params(p: dict) -> str | None:
    inner = p.get("inner")
    if not isinstance(inner, dict) or not isinstance(inner.get("family"), str):
        return "inner must be {'family': name, 'params': {...}}"
    if inner["family"] == NAME:
        return "inner cannot be floor_wrap_a07 itself"
    try:
        fam = get_family(inner["family"])
    except Exception:
        return f"unknown inner family {inner.get('family')!r}"
    if fam.anchored:
        return "anchored (DCA-style) inner families are not supported"
    return fam.validate({"params": dict(inner.get("params") or {})})


def _inner(spec: dict) -> tuple:
    inner = spec["params"].get("inner") or DEFAULT_INNER
    fam = get_family(inner["family"])
    s = {"family": inner["family"], "markets": list(spec.get("markets") or []), "interval": spec.get("interval"),
         "params": dict(inner.get("params") or {}), "risk": {"maxWeight": 1.0}}
    for k in ("universe", "execution"):
        if k in spec:
            s[k] = spec[k]
    return fam, normalize_spec(s, fam)


def warmup(p: dict) -> int:
    inner = p.get("inner") or DEFAULT_INNER
    fam = get_family(inner["family"])
    return int(fam.warmup({**fam.default_params(), **(inner.get("params") or {})}) or 0)


def required_markets(spec: dict) -> list[str]:
    fam, inner = _inner(spec)
    return fam.markets_needed(inner)


def targets(candles, spec, start_time=None):
    floor = float(spec["params"].get("floor", 0.0))
    mw = max_weight(spec)
    markets = list(spec["markets"])
    fam, inner = _inner(spec)
    w = fam.targets(candles, inner)
    idx = union_index(candles, markets)
    out = {m: np.full(len(idx), np.nan) for m in markets}
    if w is None or len(w) == 0:
        return frame(idx, out)
    w = w.reindex(idx)
    v = np.column_stack([w[m].to_numpy(np.float64) if m in w.columns else np.full(len(idx), np.nan)
                         for m in markets])
    decided = np.isfinite(v).any(axis=1)
    v = np.clip(np.nan_to_num(v, nan=0.0), 0.0, 1.0)
    tot = v.sum(axis=1, keepdims=True)
    v = np.where(tot > 1.0, v / np.maximum(tot, 1e-12), v)
    n = len(markets)
    res = mw * (floor / n + (1.0 - floor) * v)
    res[~decided] = np.nan
    for j, m in enumerate(markets):
        out[m] = res[:, j]
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
    f = float(p.get("floor", 0.0))
    return {
        "summary": f"The fleet strategy '{name}' on {mk}, but {pct(f)} of the money always stays in the coins.",
        "howItWorks": [f"{pct(f)} of the money is always invested in {mk} (split equally), whatever the signals say.",
                       f"The other {pct(1 - f)} follows the fleet strategy '{name}' with fixed settings:",
                       *inner_steps] + risk_steps(spec),
        "whenItWins": (wins + " " if wins else "") + "The permanent part catches rallies the signal misses.",
        "whenItLoses": (loses + " " if loses else "") + "The permanent part rides every crash down.",
    }
