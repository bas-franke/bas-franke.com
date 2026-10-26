"""dmi_core v1 (agent-05): Wilder's directional movement (DMI/ADX) as a trend state machine with strength gates.

Plain trend filters (close vs SMA, EMA crosses) get whipsawed in sideways chop and re-enter late after V-shaped
recoveries. Wilder's DMI separates direction (+DI vs -DI) from trend strength (ADX). This family:

- enters when +DI > -DI + diBand and ADX >= entryAdx (entryAdx 0 = any strength)
- exits only when -DI > +DI + diBand and ADX >= exitAdx (a weak, low-ADX downturn is treated as chop and held)

Everything uses Wilder smoothing over dmiLen candles of the market's own high/low/close, up to and including bar t.
Each market gets maxWeight/len(markets) while held.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "dmi_core"
VERSION = 1
TITLE = "Directional movement trend with strength-gated exits"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"dmiLen": 14, "entryAdx": 0.0, "exitAdx": 20.0, "diBand": 0.0}


def param_space() -> dict:
    return {
        "dmiLen": {"type": "int", "min": 5, "max": 120, "log": True,
                   "description": "Wilder smoothing length of +DI, -DI and ADX in candles"},
        "entryAdx": {"type": "float", "min": 5, "max": 45, "zero": True,
                     "description": "buy only when the ADX trend strength is at least this (0 = any)"},
        "exitAdx": {"type": "float", "min": 5, "max": 45, "zero": True,
                    "description": "sell only when the downtrend's ADX is at least this (0 = on any -DI cross)"},
        "diBand": {"type": "float", "min": 0, "max": 10,
                   "description": "one DI line must lead the other by this many points to count"},
    }


def warmup(p: dict) -> int:
    return 2 * int(p["dmiLen"])


def _rma(x: np.ndarray, n: int, start: int) -> np.ndarray:
    """Wilder smoothing seeded with the mean of x[start:start+n]; NaN before start+n-1."""
    out = np.full(len(x), np.nan)
    if start + n > len(x):
        return out
    prev = float(np.mean(x[start:start + n]))
    out[start + n - 1] = prev
    vals = x.tolist()
    for i in range(start + n, len(x)):
        prev = (prev * (n - 1) + vals[i]) / n
        out[i] = prev
    return out


def dmi(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int):
    """(+DI, -DI, ADX) per Wilder; bar 0 has no move, so the smoothing starts at bar 1."""
    h, l, c = (np.asarray(a, dtype=np.float64) for a in (high, low, close))
    up = np.r_[0.0, h[1:] - h[:-1]]
    dn = np.r_[0.0, l[:-1] - l[1:]]
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    pc = np.r_[c[0], c[:-1]]
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    atr, sp, sm = _rma(tr, n, 1), _rma(pdm, n, 1), _rma(mdm, n, 1)
    with np.errstate(divide="ignore", invalid="ignore"):
        pdi = np.where(atr > 0, 100 * sp / atr, 0.0)
        mdi = np.where(atr > 0, 100 * sm / atr, 0.0)
        s = pdi + mdi
        dx = np.where(s > 0, 100 * np.abs(pdi - mdi) / s, 0.0)
    pdi[~np.isfinite(atr)] = np.nan
    mdi[~np.isfinite(atr)] = np.nan
    adx = _rma(np.nan_to_num(dx), n, n) if len(c) >= 2 * n else np.full(len(c), np.nan)
    return pdi, mdi, adx


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _weights(df: pd.DataFrame, p: dict) -> np.ndarray:
    pdi, mdi, adx = dmi(df["high"].to_numpy(), df["low"].to_numpy(), df["close"].to_numpy(), int(p["dmiLen"]))
    band, ea, xa = float(p["diBand"]), float(p.get("entryAdx") or 0), float(p.get("exitAdx") or 0)
    n = len(pdi)
    w = np.full(n, np.nan)
    ok = np.isfinite(pdi) & np.isfinite(mdi) & np.isfinite(adx)
    held = False
    for i in range(n):
        if not ok[i]:
            continue
        if not held:
            if pdi[i] > mdi[i] + band and adx[i] >= ea:
                held = True
        elif mdi[i] > pdi[i] + band and adx[i] >= xa:
            held = False
        w[i] = 1.0 if held else 0.0
    return w


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    W = np.column_stack([_asof(candles[m], _weights(candles[m], p), idx) * each for m in markets]) \
        if markets else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    ea, xa, band = float(p.get("entryAdx") or 0), float(p.get("exitAdx") or 0), float(p["diBand"])
    lead = f" by more than {band:g} points" if band else ""
    steps = [
        f"After every {iv} candle it measures, over about {bars_text(p['dmiLen'], iv)}, how much of the price "
        "range came from pushes up (+DI) versus pushes down (-DI), and how strong the trend is overall (ADX, 0-100).",
        f"It buys {mk} when the up-pushes lead{lead}"
        + (f" and the trend strength is at least {ea:g}." if ea else "."),
        f"It sells when the down-pushes lead{lead}"
        + (f" and the trend strength is at least {xa:g}; a weak dip without a strong downtrend is held through."
           if xa else "."),
    ]
    return {
        "summary": f"Rides uptrends in {mk} and only sells when a real, strong downtrend shows up.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long uptrends with shallow, choppy pullbacks that would shake out a moving-average filter.",
        "whenItLoses": "Sudden crashes (the strength measure needs time to rise, so it sells late) and slow "
                       "grinding bears with low trend strength.",
    }
