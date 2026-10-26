"""core_dip v1 (agent-05): SMA trend core plus a time-limited capitulation buy, from BTC/ETH signals only.

breadth_dip's best BTC spec (fb22b4d56d) works because it combines two things: an SMA core that holds uptrends,
and a panic buy (most of the top 10 RSI-oversold at once) that is held for up to ~3 months, which catches the
V-shaped recoveries the SMA re-enters late. Its breadth list is today's top 10 (survivorship). This family keeps the
mechanism but takes the panic signal from BTC/ETH only:

- scope "own":  a market's dip trade starts when its own RSI(rsiPeriod) < rsiBelow
- scope "pair": starts when BTC's and ETH's RSI are both < rsiBelow (both are loaded even for a BTC-only spec)
- scope "btc":  starts when BTC's RSI < rsiBelow

A dip trade ends when the market's own RSI rises over sellAbove, or after maxHold candles (0 = no limit). Besides dip
trades a market is held while its close is above its SMA(coreSma) (0 = no core). Each market gets maxWeight/len(markets)
while held. Decisions at bar t use candles up to and including bar t (other markets aligned as of t).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "core_dip"
VERSION = 1
TITLE = "Trend core plus capitulation buys"
BOT_READY = False
MULTI_MARKET = True
PAIR = ["BTC-EUR", "ETH-EUR"]


def default_params() -> dict:
    return {"rsiPeriod": 12, "rsiBelow": 30, "sellAbove": 80, "maxHold": 90, "coreSma": 130, "scope": "own"}


def param_space() -> dict:
    return {
        "rsiPeriod": {"type": "int", "min": 2, "max": 50, "description": "RSI length in candles"},
        "rsiBelow": {"type": "float", "min": 10, "max": 45,
                     "description": "a dip trade starts when the RSI (see scope) is under this"},
        "sellAbove": {"type": "float", "min": 40, "max": 95,
                      "description": "a dip trade ends when the market's own RSI rises over this"},
        "maxHold": {"type": "int", "min": 2, "max": 500, "zero": True, "log": True,
                    "description": "a dip trade ends after this many candles at the latest (0 = no limit)"},
        "coreSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                    "description": "also hold while the close is above this SMA (0 = dips only)"},
        "scope": {"type": "choice", "values": ["own", "pair", "btc"],
                  "description": "whose RSI starts a dip trade: the market's own, BTC and ETH both, or BTC's"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["rsiBelow"]) < float(p["sellAbove"]) else "rsiBelow must be below sellAbove"


def warmup(p: dict) -> int:
    c = int(p.get("coreSma") or 0)
    return max(int(p["rsiPeriod"]), c - 1 if c > 0 else 0)


def required_markets(spec: dict) -> list[str]:
    scope = (spec.get("params") or {}).get("scope", "own")
    extra = PAIR if scope == "pair" else ["BTC-EUR"] if scope == "btc" else []
    out = list(spec.get("markets") or [])
    return out + [m for m in extra if m not in out]


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _rsi(candles, m, p, idx):
    return _asof(candles[m], ind.rsi(candles[m]["close"].to_numpy(np.float64), int(p["rsiPeriod"])), idx)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    scope = p.get("scope", "own")
    idx = union_index(candles, markets)
    n = len(idx)
    below = float(p["rsiBelow"])
    shared = None
    if scope in ("pair", "btc"):
        trig = PAIR if scope == "pair" else ["BTC-EUR"]
        rs = [_rsi(candles, m, p, idx) for m in trig]
        defined = np.all([np.isfinite(r) for r in rs], axis=0)
        hit = np.all([np.nan_to_num(r, nan=100.0) < below for r in rs], axis=0)
        shared = np.where(defined, hit.astype(np.float64), np.nan)
    core_n, max_hold = int(p.get("coreSma") or 0), int(p.get("maxHold") or 0)
    sell_above = float(p["sellAbove"])
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        r = _rsi(candles, m, p, idx)
        if shared is None:
            start = np.where(np.isfinite(r), (r < below).astype(np.float64), np.nan)
        else:
            start = shared
        if core_n:
            s = ind.sma(c, core_n)
            core = _asof(df, np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan), idx)
        else:
            core = np.zeros(n)
        w = np.full(n, np.nan)
        ok = (np.isfinite(start) & np.isfinite(r) & np.isfinite(core)).tolist()
        startl, rl, corel = start.tolist(), r.tolist(), core.tolist()
        inside, held = False, 0
        for i in range(n):
            if not ok[i]:
                continue
            if not inside:
                if startl[i] == 1.0:
                    inside, held = True, 0
            else:
                held += 1
                if rl[i] > sell_above or (max_hold and held >= max_hold):
                    inside = False
            w[i] = each if (inside or corel[i] == 1.0) else 0.0
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
    scope = p.get("scope", "own")
    who = {"own": "the coin's own RSI", "pair": "the RSI of both BTC and ETH",
           "btc": "BTC's RSI"}[scope]
    steps = [
        f"After every {iv} candle it computes the RSI over {bars_text(p['rsiPeriod'], iv)}: a 0-100 score of how "
        "hard the price has been falling or rising lately.",
        f"When {who} drops under {float(p['rsiBelow']):g}, the market is in a panic sell-off: it buys {mk}"
        + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        f"It keeps that dip purchase until the coin's own RSI climbs over {float(p['sellAbove']):g}"
        + (f", or {bars_text(p['maxHold'], iv)} at most." if int(p.get('maxHold') or 0) else "."),
    ]
    if int(p.get("coreSma") or 0):
        steps.append(f"Besides dips it holds the coin whenever its price is above its "
                     f"{bars_text(p['coreSma'], iv)} average, so it rides uptrends too.")
    return {
        "summary": f"Holds {mk} in uptrends and buys panic sell-offs, holding those for a few weeks to months.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets (the trend core holds) and sharp crashes that recover within weeks to months "
                      "(the dip buy is in before the trend core re-enters).",
        "whenItLoses": "Long bear markets where one panic follows another: each dip buy rides the next leg down "
                       "until its time limit.",
    }
