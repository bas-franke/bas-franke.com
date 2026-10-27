"""step_wrap_a24 v1 (agent-24): any lead, but bought and sold in slices (e.g. 10 % of the portfolio per step).

The wrapped lead (``inner``, frozen params, same markets and interval) still decides where it wants to be; this
wrapper only moves the real position toward that target by at most ``step`` of the portfolio per move, at most one
move every ``every`` bars. ``step`` 1 with ``every`` 1 reproduces the lead. Drawdown guards as in ind_ladder_a24:
below SMA(trendSma), or more than ddMax under the ddLook-bar high, the goal becomes 0 (scale out slice by slice, or
all at once with ``guardExit``).

Rows where the lead has not decided stay NaN until the first decision; after it, an undecided lead row holds the
current weight. ``inner`` is not in the param space (like floor_wrap_a07): a different lead is a different spec.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import _step, get_family
from ._base import aligned_close, bars_text, frame, market_names, max_weight, normalize_spec, pct, risk_steps, union_index

NAME = "step_wrap_a24"
VERSION = 1
TITLE = "Any lead, bought and sold in slices"
BOT_READY = False
MULTI_MARKET = True

DEFAULT_INNER = {"family": "ema_cross", "params": {}}


def default_params() -> dict:
    return {"step": 0.1, "every": 1, "trendSma": 0, "ddLook": 0, "ddMax": 0.2, "guardExit": False,
            "inner": DEFAULT_INNER}


def param_space() -> dict:
    return {
        "step": {"type": "choice", "values": [0.05, 0.1, 0.2, 0.25, 0.5, 1.0],
                 "description": "slice of the portfolio bought or sold per move"},
        "every": {"type": "int", "min": 1, "max": 48, "log": True, "description": "at most one move every this many bars"},
        "trendSma": {"type": "int", "min": 20, "max": 400, "log": True, "zero": True,
                     "description": "below SMA(trendSma) buy nothing and scale out (0 = off)"},
        "ddLook": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                   "description": "drawdown guard window in bars (0 = off)"},
        "ddMax": {"type": "float", "min": 0.05, "max": 0.5, "description": "drawdown from the ddLook-bar high that trips the guard"},
        "guardExit": {"type": "bool", "description": "a tripped guard sells everything at once instead of slice by slice"},
    }


def valid_params(p: dict) -> str | None:
    inner = p.get("inner")
    if not isinstance(inner, dict) or not isinstance(inner.get("family"), str):
        return "inner must be {'family': name, 'params': {...}}"
    if inner["family"] == NAME:
        return "inner cannot be step_wrap_a24 itself"
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
    return max(int(fam.warmup({**fam.default_params(), **(inner.get("params") or {})}) or 0),
               int(p.get("trendSma") or 0), int(p.get("ddLook") or 0))


def required_markets(spec: dict) -> list[str]:
    fam, inner = _inner(spec)
    return fam.markets_needed(inner)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    mw = max_weight(spec)
    markets = list(spec["markets"])
    fam, inner = _inner(spec)
    if fam.multi_market or len(markets) == 1:
        w = fam.targets(candles, inner)
    else:  # a single-market lead runs on each market alone, with an equal share of the money
        w = pd.concat([fam.targets(candles, {**inner, "markets": [m]})[[m]] / len(markets) for m in markets], axis=1)
    idx = union_index(candles, markets)
    out = {m: np.full(len(idx), np.nan) for m in markets}
    if w is None or len(w) == 0:
        return frame(idx, out)
    w = w.reindex(idx)
    v = np.column_stack([w[m].to_numpy(np.float64) if m in w.columns else np.full(len(idx), np.nan)
                         for m in markets])
    decided = np.isfinite(v).any(axis=1)
    v = np.where(decided[:, None], np.clip(np.nan_to_num(v, nan=0.0), 0.0, 1.0), np.nan)
    tot = np.nansum(v, axis=1, keepdims=True)
    v = np.where(tot > 1.0, v / np.maximum(tot, 1e-12), v)
    step, every = float(p["step"]), int(p["every"])
    for j, m in enumerate(markets):
        c = aligned_close(candles, m, idx)
        g = _step.guard_mask(c, int(p.get("trendSma") or 0), int(p.get("ddLook") or 0), float(p.get("ddMax") or 0))
        out[m] = _step.walk(v[:, j], decided, step, every, g,
                            bool(p.get("guardExit"))) * mw
    return frame(idx, out)


def explain(spec) -> dict:
    p = spec["params"]
    iv = spec.get("interval")
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
    st, every = float(p["step"]), int(p["every"])
    pace = "per candle" if every == 1 else f"at most once every {bars_text(every, iv)}"
    steps = [f"The fleet strategy '{name}' decides how much of {mk} it wants (fixed settings):", *inner_steps,
             f"Instead of jumping there at once, it buys or sells {pct(st)} of the portfolio {pace} until it gets there."]
    out = "everything at once" if p.get("guardExit") else f"{pct(st)} per step"
    if int(p.get("trendSma") or 0):
        steps.append(f"Below its {bars_text(int(p['trendSma']), iv)} average it buys nothing and sells {out}.")
    if int(p.get("ddLook") or 0):
        steps.append(f"When the price is more than {pct(float(p['ddMax']))} under its "
                     f"{bars_text(int(p['ddLook']), iv)} high it buys nothing and sells {out}.")
    steps += risk_steps(spec)
    return {
        "summary": f"The fleet strategy '{name}' on {mk}, bought and sold in {pct(st)} slices.",
        "howItWorks": steps,
        "whenItWins": (wins + " " if wins else "") + "Scaling in and out also softens badly timed signals.",
        "whenItLoses": (loses + " " if loses else "") + "Fast moves are only partly caught.",
    }
