"""mfi_core v1 (agent-06, dip lane): SMA trend core plus panic buys triggered by the Money Flow Index.

The fleet's no-hindsight BTC lead is "trend core + RSI panic dip" (core_dip). The Money Flow Index is a volume-weighted
RSI: it sums typical price x volume over the up-bars and the down-bars of the last ``oscLen`` candles. A low MFI means
the selling came with heavy turnover (capitulation), a low RSI alone can be a slow, thin drift. ``osc`` switches the
trigger between "mfi" and "rsi" so the two can be compared knob for knob (same core, same exits).

- A dip trade starts when osc(oscLen) < ``below``; it ends when osc > ``sellAbove`` or after ``maxHold`` candles.
- Besides dip trades the market is held while its close is above SMA(``coreSma``) (0 = dips only).
Decisions at bar t use candles up to and including bar t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "mfi_core"
VERSION = 1
TITLE = "Trend core plus money-flow panic buys"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"osc": "mfi", "oscLen": 14, "below": 25.0, "sellAbove": 75.0, "maxHold": 90, "coreSma": 130}


def param_space() -> dict:
    return {
        "osc": {"type": "choice", "values": ["mfi", "rsi"],
                "description": "panic oscillator: money flow index (volume-weighted) or plain RSI"},
        "oscLen": {"type": "int", "min": 3, "max": 50, "description": "oscillator length in candles"},
        "below": {"type": "float", "min": 5, "max": 45, "description": "a dip trade starts under this level"},
        "sellAbove": {"type": "float", "min": 40, "max": 95, "description": "a dip trade ends over this level"},
        "maxHold": {"type": "int", "min": 2, "max": 400, "zero": True, "log": True,
                    "description": "a dip trade ends after this many candles at the latest (0 = no limit)"},
        "coreSma": {"type": "int", "min": 10, "max": 600, "zero": True, "log": True,
                    "description": "also hold while the close is above this SMA (0 = dips only)"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["below"]) < float(p["sellAbove"]) else "below must be under sellAbove"


def warmup(p: dict) -> int:
    c = int(p.get("coreSma") or 0)
    return max(int(p["oscLen"]) + 1, c - 1 if c > 0 else 0)


def mfi(high, low, close, volume, n: int) -> np.ndarray:
    """Money Flow Index over n candles (NaN for the first n); 50 when no volume traded in the window."""
    tp = (np.asarray(high, float) + np.asarray(low, float) + np.asarray(close, float)) / 3.0
    flow = tp * np.nan_to_num(np.asarray(volume, float), nan=0.0)
    d = np.diff(tp, prepend=np.nan)
    pos = np.where(d > 0, flow, 0.0)
    neg = np.where(d < 0, flow, 0.0)
    pos[0] = neg[0] = 0.0
    cp, cn = np.cumsum(pos), np.cumsum(neg)
    out = np.full(len(tp), np.nan)
    if len(tp) <= n:
        return out
    sp = cp[n:] - cp[:-n]
    sn = cn[n:] - cn[:-n]
    tot = sp + sn
    with np.errstate(divide="ignore", invalid="ignore"):
        v = np.where(tot > 0, 100.0 * sp / tot, 50.0)
    out[n:] = v
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    k = int(p["oscLen"])
    if p["osc"] == "mfi":
        o = mfi(df["high"].to_numpy(np.float64), df["low"].to_numpy(np.float64), c,
                df["volume"].to_numpy(np.float64), k)
    else:
        o = ind.rsi(c, k)
    cn = int(p.get("coreSma") or 0)
    if cn:
        s = ind.sma(c, cn)
        core = np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan)
    else:
        core = np.zeros(n)
    below, sell, mh = float(p["below"]), float(p["sellAbove"]), int(p.get("maxHold") or 0)
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    ol, corel = o.tolist(), core.tolist()
    inside, held = False, 0
    start = warmup(p)
    for i in range(n):
        if i < start or not (np.isfinite(ol[i]) and np.isfinite(corel[i])):
            continue
        if not inside:
            if ol[i] < below:
                inside, held = True, 0
        else:
            held += 1
            if ol[i] > sell or (mh and held >= mh):
                inside = False
        w[i] = mw if (inside or corel[i] == 1.0) else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    name = "money flow index (a volume-weighted RSI)" if p["osc"] == "mfi" else "RSI"
    steps = [
        f"After every {iv} candle it computes the {name} of {mk} over {bars_text(int(p['oscLen']), iv)}: a 0-100 "
        "score of how one-sided the recent selling or buying was"
        + (", weighted by how much money changed hands." if p["osc"] == "mfi" else "."),
        f"When it drops under {float(p['below']):g} (a panic sell-off) it buys and keeps that dip purchase until the "
        f"score climbs over {float(p['sellAbove']):g}"
        + (f", or {bars_text(int(p['maxHold']), iv)} at most." if int(p.get('maxHold') or 0) else "."),
    ]
    if int(p.get("coreSma") or 0):
        steps.append(f"Besides dips it holds whenever the price is above its {bars_text(int(p['coreSma']), iv)} "
                     "average, so it rides uptrends too.")
    return {
        "summary": f"Holds {mk} in uptrends and buys heavy-volume panic sell-offs for a few weeks to months.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets (trend core) and sharp, high-volume crashes that recover within weeks.",
        "whenItLoses": "Long bear markets with repeated capitulations: each dip buy rides the next leg down.",
    }
