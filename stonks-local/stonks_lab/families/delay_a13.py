"""delay_a13 v1 (agent-13): the signal-decay check for ANY lead: act ``delay`` candles after it decides.

The close-hour check (#505, hourshift_a14) moves the decision by hours inside a day; the bar-size check (#655) changes
the sampling. This wrapper asks a third question: how fast does the lead's edge decay if every trade happens
``delay`` candles late? A slow, real edge (a trend regime, a froth season) should lose a little per day of delay;
a lead whose score comes from lucky timing of a few switches collapses after one or two candles.

    "params": {"delay": "2", "inner": {"family": "alt_froth", "params": {...the lead's params...}}}

It runs the inner family with its frozen params on the same candles and interval, then shifts every target
``delay`` candles later (the weight decided at bar t is the target at bar t + delay). No look-ahead: a later bar
only ever sees an older decision. ``delay`` is a string choice so 1 vs 2 are never near-duplicates; ``inner`` is not
in the param space (a different lead = a different spec, as in hourshift_a14). Delay "0" reproduces the inner lead.
Never a live strategy: it only measures how much the lead's timing matters.
"""
from __future__ import annotations

import numpy as np

from . import get_family
from ._base import frame, market_names, max_weight, normalize_spec, risk_steps, union_index

NAME = "delay_a13"
VERSION = 1
TITLE = "Any lead acting a few candles late"
BOT_READY = False
MULTI_MARKET = True

DELAYS = ["0", "1", "2", "3", "5", "7", "10", "14", "21", "30"]
# multi-market so the default also runs on BTC+ETH and coin lists (generic contract/look-ahead tests)
DEFAULT_INNER = {"family": "upday_share", "params": {"look": 60, "enter": 0.55, "exit": 0.5, "coreLen": 130,
                                                    "combine": "or", "scope": "own"}}


def default_params() -> dict:
    return {"delay": "1", "inner": DEFAULT_INNER}


def param_space() -> dict:
    return {
        "delay": {"type": "choice", "values": DELAYS,
                  "description": "candles between the lead's decision and the trade (0 = the lead itself)"},
    }


def valid_params(p: dict) -> str | None:
    if str(p.get("delay")) not in DELAYS:
        return f"delay must be one of {DELAYS}"
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
        return "inner cannot be delay_a13 itself"
    return fam.validate({"params": dict(inner.get("params") or {})})


def _inner(spec: dict) -> tuple:
    p = spec["params"]
    inner = p.get("inner") or DEFAULT_INNER
    fam = get_family(inner["family"])
    s = normalize_spec({"family": inner["family"], "markets": list(spec.get("markets") or []),
                        "interval": spec.get("interval") or "1d", "params": dict(inner.get("params") or {}),
                        "risk": {"maxWeight": max_weight(spec)}}, fam)
    return fam, s


def warmup(p: dict) -> int:
    inner = p.get("inner") or DEFAULT_INNER
    fam = get_family(inner["family"])
    return int(fam.warmup({**fam.default_params(), **(inner.get("params") or {})})) + int(p.get("delay", 0))


def required_markets(spec: dict) -> list[str]:
    fam, inner = _inner(spec)
    return fam.markets_needed(inner)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    d = int(p["delay"])
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    fam, inner = _inner(spec)
    w = fam.targets(candles, inner)
    w = w.reindex(idx)  # the traded markets' bars; the inner family decides on the same bars
    out = {}
    for m in markets:
        col = w[m].to_numpy(np.float64) if m in w.columns else np.full(len(idx), np.nan)
        shifted = np.full(len(idx), np.nan)
        if d == 0:
            shifted[:] = col
        elif d < len(idx):
            shifted[d:] = col[:-d]
        out[m] = shifted
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
    d = int(p["delay"])
    mk = market_names(spec)
    return {
        "summary": f"The fleet strategy '{name}' on {mk}, but every trade happens {d} candle(s) after it decides.",
        "howItWorks": [f"It runs the fleet strategy '{name}' on {mk} with fixed settings.",
                       f"Each buy or sell is placed {d} candle(s) after the strategy decided it (a robustness test "
                       "of how much its timing matters).", *inner_steps] + risk_steps(spec),
        "whenItWins": wins or "Same as the strategy it wraps, if its edge is slow enough to survive the delay.",
        "whenItLoses": (loses + " " if loses else "") + "Plus whatever the delay costs: late exits in crashes, late "
                       "entries in rebounds.",
    }
