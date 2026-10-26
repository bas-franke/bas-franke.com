"""ha_trend v1 (agent-20, trend lane): Heikin-Ashi candle-colour trend, long only.

Heikin-Ashi ("average bar") candles smooth the price path: haClose = (open+high+low+close)/4 and
haOpen = (previous haOpen + previous haClose)/2. A candle is green when haClose > haOpen. Traders hold through
green runs and step out when red candles appear; unlike a moving average the colour flips quickly after a turn
but rarely in a steady trend.

- optional pre-smoothing: EMA(preSmooth) of open/high/low/close before building the HA candles (0 = off)
- buy after ``enterK`` green HA candles in a row, sell after ``exitK`` red ones in a row
- ``exitStrong``: only count red candles without an upper wick (the "strong bear" candle) towards the exit
- optional slow SMA gate on the raw close: only buy while the close is above it

Each market gets maxWeight/len(markets) while held. Decisions at bar t use candles up to and including bar t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "ha_trend"
VERSION = 1
TITLE = "Heikin-Ashi trend"
BOT_READY = False
MULTI_MARKET = True
ANCHORED = False


def default_params() -> dict:
    return {"preSmooth": 0, "enterK": 2, "exitK": 2, "exitStrong": False, "trendSma": 0}


def param_space() -> dict:
    return {
        "preSmooth": {"type": "int", "min": 2, "max": 60, "log": True, "zero": True,
                      "description": "EMA length applied to open/high/low/close before the Heikin-Ashi candles (0 = off)"},
        "enterK": {"type": "int", "min": 1, "max": 10,
                   "description": "buy after this many green Heikin-Ashi candles in a row"},
        "exitK": {"type": "int", "min": 1, "max": 10,
                  "description": "sell after this many red Heikin-Ashi candles in a row"},
        "exitStrong": {"type": "bool",
                       "description": "only red candles without an upper wick count towards the exit"},
        "trendSma": {"type": "int", "min": 10, "max": 600, "log": True, "zero": True,
                     "description": "only buy while the close is above this SMA (0 = off)"},
    }


def warmup(p: dict) -> int:
    return max(3 * int(p["preSmooth"] or 0), int(p["trendSma"] or 0), int(p["enterK"]) + int(p["exitK"]) + 10)


def heikin_ashi(o, h, l, c):
    """Heikin-Ashi open/high/low/close; NaN until the first bar where all inputs are finite."""
    n = len(c)
    hc = (o + h + l + c) / 4.0
    ho = np.full(n, np.nan)
    ok = np.isfinite(hc)
    if not ok.any():
        return ho, ho.copy(), ho.copy(), np.full(n, np.nan)
    s = int(np.argmax(ok))
    ho[s] = (o[s] + c[s]) / 2.0
    for i in range(s + 1, n):
        ho[i] = (ho[i - 1] + hc[i - 1]) / 2.0
    hh = np.fmax(h, np.fmax(ho, hc))
    hl = np.fmin(l, np.fmin(ho, hc))
    hc = np.where(np.isfinite(ho), hc, np.nan)
    return ho, hh, hl, hc


def _weights(df, p) -> np.ndarray:
    o = df["open"].to_numpy(np.float64)
    h = df["high"].to_numpy(np.float64)
    l = df["low"].to_numpy(np.float64)
    c = df["close"].to_numpy(np.float64)
    ps = int(p["preSmooth"] or 0)
    if ps:
        o, h, l, c2 = ind.ema(o, ps), ind.ema(h, ps), ind.ema(l, ps), ind.ema(c, ps)
    else:
        c2 = c
    ho, hh, hl, hc = heikin_ashi(o, h, l, c2)
    ts = int(p["trendSma"] or 0)
    gate = ind.sma(c, ts) if ts else np.zeros(len(c))
    ek, xk, strong = int(p["enterK"]), int(p["exitK"]), bool(p["exitStrong"])
    n = len(c)
    w = np.full(n, np.nan)
    held = False
    greens = reds = 0
    start = max(warmup(p) - 1, 0)
    for i in range(n):
        if not (np.isfinite(ho[i]) and np.isfinite(hc[i]) and np.isfinite(gate[i])):
            continue
        green = hc[i] > ho[i]
        red = hc[i] < ho[i]
        if red and strong and hh[i] > ho[i] * (1 + 1e-12):
            red = False                     # has an upper wick: not a strong bear candle
        greens = greens + 1 if green else 0
        reds = reds + 1 if red else 0
        if i < start:
            continue
        if held:
            if reds >= xk:
                held = False
        elif greens >= ek and (not ts or c[i] > gate[i]):
            held = True
        w[i] = 1.0 if held else 0.0
    return w


def _asof(df, values, idx):
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
    W = np.column_stack([_asof(candles[m], _weights(candles[m], p), idx) * each for m in markets]) \
        if markets else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    ps, ts = int(p["preSmooth"] or 0), int(p["trendSma"] or 0)
    steps = [
        f"After every {iv} candle it redraws {mk}'s price as 'Heikin-Ashi' candles: each candle's open is the "
        "midpoint of the previous one, its close the average of open, high, low and close"
        + (f", after first smoothing the prices over {bars_text(ps, iv)}." if ps else "."),
        f"It buys after {int(p['enterK'])} rising (green) candles in a row"
        + (f", but only while the price is above its {bars_text(ts, iv)} average." if ts else "."),
        f"It sells after {int(p['exitK'])} falling (red) candles in a row"
        + (" that close without any bounce above their open (no upper wick)." if p["exitStrong"] else "."),
    ]
    return {
        "summary": f"Rides {mk} while its smoothed (Heikin-Ashi) candles stay green and steps aside after a run of red ones.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long trends with few pauses, and long bear markets (it sells after the first red run).",
        "whenItLoses": "Sideways chop, where the candle colour keeps flipping (fees, selling low and buying back higher).",
    }
