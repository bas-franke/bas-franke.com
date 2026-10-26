"""vol_panic_core v1 (agent-21): a trend core plus a time-boxed panic buy, where "panic" is a realized-volatility
spike on a falling price instead of an RSI level.

breadth_dip / core_dip / core_rebound (findings #212-#254) showed that a BTC SMA core needs a panic buy held for
weeks to catch the V-recoveries the SMA re-enters late, but RSI-based panics from BTC/ETH alone hinge on 3-5
specific days (#254). This family asks whether a volatility definition of panic is broader:

- per coin, rv(n) = population std of the last n one-bar log returns;
- the coin "panics" on a bar where rv(volShort) >= volRatio * rv(volLong) AND its return over the last dropLook
  bars is at most -dropMin (and below 0): volatility explodes while the price falls;
- source "own": the traded coin's own panic; "both": BTC-EUR and ETH-EUR panic on the same bar; "any": either.

On a panic bar a market that is not in a panic trade buys and holds for holdBars candles (a later panic bar inside
the trade does not extend it). Independently the market is held while its trend core is on: close above its
SMA/EMA(coreLen) with a hysteresis band (on above MA*(1+coreBand), off below MA*(1-coreBand), else unchanged;
coreLen 0 = no core). Every market gets maxWeight / len(markets) while held. Other markets are aligned as of the
bar time (latest candle at or before it): a decision at bar t uses nothing after t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "vol_panic_core"
VERSION = 1
TITLE = "Trend core + volatility-panic buy"
BOT_READY = False
MULTI_MARKET = True
PAIR = ["BTC-EUR", "ETH-EUR"]


def default_params() -> dict:
    return {"coreType": "sma", "coreLen": 130, "coreBand": 0.0, "source": "both", "volShort": 5, "volLong": 90,
            "volRatio": 2.0, "dropLook": 7, "dropMin": 0.1, "holdBars": 90}


def param_space() -> dict:
    return {
        "coreType": {"type": "choice", "values": ["sma", "ema"], "description": "trend core average: SMA or EMA"},
        "coreLen": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                    "description": "hold while the close is above this average (0 = no trend core)"},
        "coreBand": {"type": "float", "min": 0.0, "max": 0.05,
                     "description": "hysteresis around the average (0.02 = on above +2 %, off below -2 %)"},
        "source": {"type": "choice", "values": ["own", "both", "any"],
                   "description": "whose panic counts: the traded coin's own, BTC and ETH both, or either"},
        "volShort": {"type": "int", "min": 2, "max": 60, "log": True,
                     "description": "candles in the short-term realized volatility"},
        "volLong": {"type": "int", "min": 20, "max": 500, "log": True,
                    "description": "candles in the usual (long-term) realized volatility"},
        "volRatio": {"type": "float", "min": 1.0, "max": 4.0,
                     "description": "panic when short-term volatility is at least this multiple of the usual"},
        "dropLook": {"type": "int", "min": 1, "max": 60, "log": True,
                     "description": "candles over which the price fall is measured"},
        "dropMin": {"type": "float", "min": 0.0, "max": 0.4,
                    "description": "panic only when the price fell at least this much over dropLook candles"},
        "holdBars": {"type": "int", "min": 2, "max": 500, "log": True,
                     "description": "candles a panic buy is held"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["volLong"]) < 2 * int(p["volShort"]):
        return "volLong must be at least twice volShort"
    return None


def warmup(p: dict) -> int:
    c = int(p.get("coreLen") or 0)
    return max(int(p["volLong"]), int(p["dropLook"]), c - 1 if c > 0 else 0)


def required_markets(spec: dict) -> list[str]:
    src = (spec.get("params") or {}).get("source", "both")
    out = list(spec.get("markets") or [])
    return out + [m for m in (PAIR if src in ("both", "any") else []) if m not in out]


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def panic_flags(close: np.ndarray, p: dict) -> np.ndarray:
    """1.0 on panic bars, 0.0 otherwise, NaN while undefined; on the coin's own bars."""
    c = np.asarray(close, dtype=np.float64)
    lr = np.full(len(c), np.nan)
    lr[1:] = np.log(c[1:] / c[:-1])
    rs = ind.std_pop(lr, int(p["volShort"]))
    rl = ind.std_pop(lr, int(p["volLong"]))
    k = int(p["dropLook"])
    ret = np.full(len(c), np.nan)
    if len(c) > k:
        ret[k:] = c[k:] / c[:-k] - 1.0
    ok = np.isfinite(rs) & np.isfinite(rl) & np.isfinite(ret)
    with np.errstate(invalid="ignore", divide="ignore"):
        hit = (rs >= float(p["volRatio"]) * rl) & (rl > 0) & (ret < 0) & (ret <= -float(p["dropMin"]))
    return np.where(ok, hit.astype(np.float64), np.nan)


def core_flags(close: np.ndarray, p: dict) -> np.ndarray:
    c = np.asarray(close, dtype=np.float64)
    n = int(p.get("coreLen") or 0)
    if n <= 0:
        return np.zeros(len(c))
    ma = ind.ema(c, n) if p.get("coreType", "sma") == "ema" else ind.sma(c, n)
    band = float(p.get("coreBand") or 0.0)
    out = np.full(len(c), np.nan)
    state = None
    for i, (x, m) in enumerate(zip(c.tolist(), ma.tolist())):
        if not np.isfinite(m):
            continue
        if state is None:
            state = x > m
        elif x > m * (1 + band):
            state = True
        elif x < m * (1 - band):
            state = False
        out[i] = 1.0 if state else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    src = p.get("source", "both")
    idx = union_index(candles, markets)
    n = len(idx)
    shared = None
    if src in ("both", "any"):
        fs = [_asof(candles[m], panic_flags(candles[m]["close"].to_numpy(np.float64), p), idx) for m in PAIR]
        defined = np.all([np.isfinite(f) for f in fs], axis=0)
        hits = [np.nan_to_num(f, nan=0.0) == 1.0 for f in fs]
        hit = np.all(hits, axis=0) if src == "both" else np.any(hits, axis=0)
        shared = np.where(defined, hit.astype(np.float64), np.nan)
    hold = int(p["holdBars"])
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        c = candles[m]["close"].to_numpy(np.float64)
        start = shared if shared is not None else _asof(candles[m], panic_flags(c, p), idx)
        core = _asof(candles[m], core_flags(c, p), idx)
        w = np.full(n, np.nan)
        ok = (np.isfinite(start) & np.isfinite(core)).tolist()
        sl, cl = start.tolist(), core.tolist()
        inside, held = False, 0
        for i in range(n):
            if not ok[i]:
                continue
            if not inside:
                if sl[i] == 1.0:
                    inside, held = True, 0
            else:
                held += 1
                if held >= hold:
                    inside = False
            w[i] = each if (inside or cl[i] == 1.0) else 0.0
        cols[m] = w
    W = np.column_stack([cols[m] for m in markets])
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    src = p.get("source", "both")
    who = {"own": "the coin itself", "both": "both BTC and ETH", "any": "BTC or ETH"}[src]
    steps = [
        f"After every {iv} candle it measures how wildly the price moved over the last "
        f"{bars_text(p['volShort'], iv)} and compares that with the usual swings over {bars_text(p['volLong'], iv)}.",
        f"A panic is when {who} swing at least {float(p['volRatio']):g} times as hard as usual while the price fell "
        f"at least {pct(p['dropMin'])} over {bars_text(p['dropLook'], iv)}: then it buys {mk}"
        + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        f"It keeps that panic purchase for {bars_text(p['holdBars'], iv)}, whatever happens.",
    ]
    if int(p.get("coreLen") or 0):
        kind = "exponential " if p.get("coreType") == "ema" else ""
        band = float(p.get("coreBand") or 0)
        steps.append(f"Besides panics it holds the coin whenever its price is above its {kind}average over "
                     f"{bars_text(p['coreLen'], iv)}"
                     + (f" (it switches only when the price is {pct(band)} past the average)." if band else "."))
    return {
        "summary": f"Holds {mk} in uptrends and buys volatility panics, holding those for a fixed time.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets (the trend core holds) and violent crashes that recover within the holding "
                      "time, before the trend core would buy back in.",
        "whenItLoses": "Slow bear markets where a volatile drop is followed by more falling: the panic buy rides "
                       "the next leg down until its time is up.",
    }
