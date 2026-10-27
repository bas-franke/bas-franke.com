"""mtf_guard_a24 v1 (agent-24): a lead on one time frame, a crash guard on another, traded on the finest one.

The spec interval is the trading (finest) interval, e.g. 15m. Both other time frames are built inside the family from
those candles, and only *completed* candles count:

- the lead (``inner``, any single-market family with frozen params) runs on ``leadTf`` candles (e.g. 1d) and sets
  the long-term position;
- the guard watches ``guardTf`` candles (e.g. the 15m candles themselves, or 1h): when the close falls more than
  ``guardDrop`` below the highest close of the last ``guardLook`` guard candles, it cuts ``guardCut`` of the
  position at once and buys nothing back for ``guardHold`` guard candles; after that the lead's target applies again.

So a daily trend strategy keeps tracking the long term, while a sudden intraday crash sells it (or half of it) within
minutes; or the other way round (lead on 15m, guard on 1d). The position moves in ``step`` slices (1 = at once),
at most one slice every ``every`` trading bars. ``inner`` is not in the param space (like step_wrap_a24).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ..data import INTERVAL_MS, resample
from . import get_family
from ._base import bars_text, frame, market_names, max_weight, normalize_spec, pct, risk_steps, single_market

NAME = "mtf_guard_a24"
VERSION = 1
TITLE = "Long-term lead with a fast crash guard"
BOT_READY = False
MULTI_MARKET = False

TFS = ["same", "5m", "15m", "1h", "4h", "12h", "1d", "1W"]
DEFAULT_INNER = {"family": "ema_cross", "params": {"fast": 12, "slow": 48}}


def default_params() -> dict:
    return {"leadTf": "1d", "guardTf": "same", "guardLook": 24, "guardDrop": 0.06, "guardCut": 1.0,
            "guardHold": 24, "step": 1.0, "every": 1, "inner": DEFAULT_INNER}


def param_space() -> dict:
    return {
        "leadTf": {"type": "choice", "values": TFS, "description": "time frame the lead strategy runs on"},
        "guardTf": {"type": "choice", "values": TFS, "description": "time frame the crash guard watches"},
        "guardLook": {"type": "int", "min": 3, "max": 240, "log": True, "zero": True,
                      "description": "guard window in guard candles (0 = no guard)"},
        "guardDrop": {"type": "float", "min": 0.01, "max": 0.3, "log": True,
                      "description": "fall from the window's highest close that trips the guard"},
        "guardCut": {"type": "choice", "values": [0.5, 1.0], "description": "share of the position the guard sells"},
        "guardHold": {"type": "int", "min": 1, "max": 240, "log": True,
                      "description": "guard candles to stay cut after the guard trips"},
        "step": {"type": "choice", "values": [0.1, 0.2, 0.5, 1.0], "description": "slice per move (1 = at once)"},
        "every": {"type": "int", "min": 1, "max": 24, "log": True, "description": "at most one slice every N bars"},
    }


def valid_params(p: dict) -> str | None:
    inner = p.get("inner")
    if not isinstance(inner, dict) or not isinstance(inner.get("family"), str):
        return "inner must be {'family': name, 'params': {...}}"
    if inner["family"] in (NAME, "step_wrap_a24", "floor_wrap_a07"):
        return "inner cannot be a wrapper"
    try:
        fam = get_family(inner["family"])
    except Exception:
        return f"unknown inner family {inner.get('family')!r}"
    if fam.anchored:
        return "anchored (DCA-style) inner families are not supported"
    return fam.validate({"params": dict(inner.get("params") or {})})


def _tf(tf: str, interval: str | None) -> str:
    """'same' or anything finer than / not a multiple of the trading interval means the trading interval itself."""
    if tf == "same" or interval not in INTERVAL_MS:
        return interval
    a, b = INTERVAL_MS[tf], INTERVAL_MS[interval]
    return tf if a >= b and a % b == 0 else interval


def _bars(df, interval, tf):
    return df if tf == interval else resample(df, interval, tf)


def _on_fast(fast_ts: np.ndarray, slow_ts: np.ndarray, slow_vals: np.ndarray, slow_ms: int, fast_ms: int):
    """Value of the last slow candle that has closed by the close of each fast bar (NaN before the first)."""
    known = slow_ts + slow_ms                 # time the slow candle closes
    k = np.searchsorted(known, fast_ts + fast_ms, side="right") - 1
    out = np.full(len(fast_ts), np.nan)
    ok = k >= 0
    out[ok] = slow_vals[k[ok]]
    return out


def mixed_timeframes(spec: dict) -> bool:
    """For the dashboard's "mixed" bucket: true when the lead or an active guard uses another candle size."""
    p, iv = {**default_params(), **(spec.get("params") or {})}, spec.get("interval")
    return _tf(p["leadTf"], iv) != iv or (int(p.get("guardLook") or 0) > 0 and _tf(p["guardTf"], iv) != iv)


def warmup(p: dict) -> int:
    inner = p.get("inner") or DEFAULT_INNER
    fam = get_family(inner["family"])
    return int(fam.warmup({**fam.default_params(), **(inner.get("params") or {})}) or 0)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    iv = spec.get("interval") or "1d"
    fast_ms = INTERVAL_MS[iv]
    ts = np.asarray(df.index, dtype=np.int64)
    inner = p.get("inner") or DEFAULT_INNER
    fam = get_family(inner["family"])
    ltf = _tf(p["leadTf"], iv)
    lead_df = _bars(df, iv, ltf)
    ispec = normalize_spec({"family": inner["family"], "markets": [m], "interval": ltf,
                            "params": dict(inner.get("params") or {}), "risk": {"maxWeight": 1.0},
                            "execution": spec.get("execution")}, fam)
    lw = fam.targets({m: lead_df}, ispec)
    lv = np.clip(lw[m].reindex(lead_df.index).to_numpy(np.float64), 0.0, 1.0) if len(lw) else np.full(len(lead_df), np.nan)
    if ltf == iv:
        lead = lv
    else:
        lead = _on_fast(ts, np.asarray(lead_df.index, dtype=np.int64), lv, INTERVAL_MS[ltf], fast_ms)
    decided = np.isfinite(lead)
    # a NaN lead after the first decision means "no change": carry the last decided target
    first = int(np.argmax(decided)) if decided.any() else len(lead)
    lead_ff = lead.copy()
    if first < len(lead):
        s = lead_ff[first:]
        idx = np.where(np.isfinite(s), np.arange(len(s)), 0)
        np.maximum.accumulate(idx, out=idx)
        lead_ff[first:] = s[idx]
    decided = np.zeros(len(lead), dtype=bool)
    decided[first:] = True

    cap = np.ones(len(ts))
    look = int(p.get("guardLook") or 0)
    if look > 0:
        gtf = _tf(p["guardTf"], iv)
        gdf = _bars(df, iv, gtf)
        gc = gdf["close"].to_numpy(np.float64)
        with np.errstate(invalid="ignore"):
            hi = ind.rolling_max(gc, look)
            trip = np.isfinite(hi) & (gc < hi * (1.0 - float(p["guardDrop"])))
        hold = max(1, int(p["guardHold"]))
        # cut while any trip happened within the last `hold` guard candles (this one included)
        since = np.convolve(trip.astype(np.float64), np.ones(hold), mode="full")[: len(trip)] > 0
        gv = since.astype(np.float64)
        on = gv if gtf == iv else _on_fast(ts, np.asarray(gdf.index, dtype=np.int64), gv, INTERVAL_MS[gtf], fast_ms)
        cap = np.where(np.nan_to_num(on) > 0, 1.0 - float(p["guardCut"]), 1.0)

    goal = np.where(decided, np.minimum(lead_ff, cap), np.nan)
    st = float(p["step"])
    if st >= 1.0:
        w = np.where(decided, goal, np.nan)
    else:
        w = _relimit(goal, decided, cap < 1.0, st, int(p["every"]))
    return frame(df.index, {m: w * max_weight(spec)})


def _relimit(goal, decided, guard_now, step, every):
    """Slice walk toward the goal where cuts by the guard happen at once and buys go slice by slice."""
    out = np.full(len(goal), np.nan)
    w, last = 0.0, -10 ** 12
    gl, dl, gn = goal.tolist(), decided.tolist(), guard_now.tolist()
    for i in range(len(goal)):
        if not dl[i]:
            continue
        g = gl[i]
        if gn[i] and w > g:
            w, last = g, i
        elif abs(g - w) > 1e-9 and i - last >= every:
            d = g - w
            w = w + (step if d > step else -step if d < -step else d)
            w = 0.0 if w < 1e-9 else w
            last = i
        out[i] = w
    return out


def explain(spec) -> dict:
    p = spec["params"]
    iv = spec.get("interval")
    inner = p.get("inner") or DEFAULT_INNER
    name = inner.get("family", "?")
    ltf, gtf = _tf(p["leadTf"], iv), _tf(p["guardTf"], iv)
    try:
        fam = get_family(name)
        s = normalize_spec({"family": name, "markets": list(spec.get("markets") or []), "interval": ltf,
                            "params": dict(inner.get("params") or {})}, fam)
        ex = fam.explain(s)
        inner_steps = list(ex.get("howItWorks") or [])[:3]
    except Exception:  # pragma: no cover - explanation must never break publishing
        inner_steps = []
    mk = market_names(spec)
    steps = [f"The long-term decision comes from the fleet strategy '{name}' on {ltf} candles:", *inner_steps]
    look = int(p.get("guardLook") or 0)
    if look:
        cut = "sells everything" if float(p["guardCut"]) >= 1 else f"sells {pct(float(p['guardCut']))} of the position"
        steps.append(f"Crash guard on {gtf} candles: when {mk} falls more than {pct(float(p['guardDrop']))} below "
                     f"its highest close of the last {bars_text(look, gtf)}, it {cut} right away and buys nothing "
                     f"back for {bars_text(int(p['guardHold']), gtf)}.")
    st = float(p["step"])
    if st < 1:
        steps.append(f"Other moves are made in slices of {pct(st)} of the portfolio, at most one per "
                     f"{bars_text(int(p['every']), iv)}.")
    steps += risk_steps(spec)
    return {
        "summary": f"'{name}' on {ltf} candles for the long term, with a {gtf} crash guard on {mk}.",
        "howItWorks": steps,
        "whenItWins": "Trending markets with sudden crashes: the lead rides the trend, the guard steps aside early.",
        "whenItLoses": "Sharp dips that recover at once (it sells low and waits out the rebound).",
    }
