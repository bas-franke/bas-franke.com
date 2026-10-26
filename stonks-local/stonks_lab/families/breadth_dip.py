"""breadth_dip v1: buy BTC/ETH when the whole top-10 crypto market is oversold at once (agent-02).

A "capitulation" bar is one where at least breadthMin of the top-10 coins (those with enough history, at least 3)
have an RSI(rsiPeriod) under rsiBelow. On such a bar each traded market that is not yet in a dip trade buys; the dip
trade ends when that market's own RSI climbs over sellAbove, or after maxHold candles (0 = no time limit).

Optional core (coreSma > 0): independent of dips, the market is also held while its close is above its
SMA(coreSma), so the strategy rides uptrends and only adds the market-wide dips of downtrends.

Every market in spec.markets gets maxWeight/len(markets) while held. Other markets are aligned "as of" the bar time
(latest candle at or before it), so a decision at bar t uses nothing after t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "breadth_dip"
VERSION = 1
TITLE = "Market-wide dip buying"
BOT_READY = False
MULTI_MARKET = True
BREADTH_MARKETS = ["BTC-EUR", "ETH-EUR", "XRP-EUR", "BNB-EUR", "SOL-EUR", "DOGE-EUR", "ADA-EUR", "TRX-EUR",
                   "LINK-EUR", "AVAX-EUR"]
MIN_BREADTH_COINS = 3


def default_params() -> dict:
    return {"rsiPeriod": 14, "rsiBelow": 30, "breadthMin": 0.6, "sellAbove": 60, "maxHold": 0, "coreSma": 0}


def param_space() -> dict:
    return {
        "rsiPeriod": {"type": "int", "min": 2, "max": 50, "description": "RSI length in candles"},
        "rsiBelow": {"type": "float", "min": 10, "max": 45,
                     "description": "a coin counts as oversold while its RSI is under this"},
        "breadthMin": {"type": "float", "min": 0.2, "max": 1.0,
                       "description": "buy when at least this fraction of the top 10 is oversold at once"},
        "sellAbove": {"type": "float", "min": 40, "max": 90,
                      "description": "end the dip trade when the coin's own RSI rises over this"},
        "maxHold": {"type": "int", "min": 2, "max": 500, "zero": True, "log": True,
                    "description": "end the dip trade after this many candles at the latest (0 = no limit)"},
        "coreSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                    "description": "also hold while the coin is above this SMA, dips or not (0 = dips only)"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["rsiBelow"]) < float(p["sellAbove"]) else "rsiBelow must be below sellAbove"


def warmup(p: dict) -> int:
    c = int(p.get("coreSma") or 0)
    return max(int(p["rsiPeriod"]), c - 1 if c > 0 else 0)


def required_markets(spec: dict) -> list[str]:
    return list(BREADTH_MARKETS)


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """values (on df's own index) as of each time in idx: the latest candle at or before it."""
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _capitulation(candles, p, idx) -> np.ndarray:
    """1.0 on capitulation bars, 0.0 otherwise, NaN while fewer than 3 coins have an RSI."""
    n = len(idx)
    low, defined = np.zeros(n), np.zeros(n)
    for m in BREADTH_MARKETS:
        if m not in candles or len(candles[m]) == 0:
            continue
        r = ind.rsi(candles[m]["close"].to_numpy(np.float64), int(p["rsiPeriod"]))
        flag = np.where(np.isfinite(r), (r < float(p["rsiBelow"])).astype(np.float64), np.nan)
        f = _asof(candles[m], flag, idx)
        low += np.nan_to_num(f, nan=0.0)
        defined += np.isfinite(f)
    frac = np.divide(low, defined, out=np.zeros(n), where=defined > 0)
    return np.where(defined >= MIN_BREADTH_COINS, (frac >= float(p["breadthMin"]) - 1e-12).astype(float), np.nan)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    cap = _capitulation(candles, p, idx)
    core_n, max_hold = int(p.get("coreSma") or 0), int(p.get("maxHold") or 0)
    sell_above = float(p["sellAbove"])
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        r = _asof(df, ind.rsi(c, int(p["rsiPeriod"])), idx)
        if core_n:
            s = ind.sma(c, core_n)
            core = _asof(df, np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan), idx)
        else:
            core = np.zeros(n)
        w = np.full(n, np.nan)
        ok = np.isfinite(cap) & np.isfinite(r) & np.isfinite(core)
        inside, held = False, 0
        capl, rl, corel, okl = cap.tolist(), r.tolist(), core.tolist(), ok.tolist()
        for i in range(n):
            if not okl[i]:
                continue
            if not inside:
                if capl[i] == 1.0:
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
    steps = [
        f"After every {iv} candle it computes the RSI over {bars_text(p['rsiPeriod'], iv)} for each of the ten "
        "biggest coins: a 0-100 score of how hard each price has been falling or rising lately.",
        f"When at least {pct(p['breadthMin'])} of them have an RSI under {float(p['rsiBelow']):g} at the same "
        f"time, the whole crypto market is in a panic sell-off: it buys {mk}"
        + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        f"It sells that dip purchase once the coin's own RSI climbs over {float(p['sellAbove']):g}"
        + (f", or after {bars_text(p['maxHold'], iv)} at the latest." if int(p.get('maxHold') or 0) else "."),
    ]
    if int(p.get("coreSma") or 0):
        steps.append(f"Besides dips it also holds the coin whenever its price is above its "
                     f"{bars_text(p['coreSma'], iv)} average, so it rides uptrends too.")
    return {
        "summary": f"Buys {mk} when the whole top-10 crypto market is oversold at once and sells after the rebound.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Sharp market-wide sell-offs that bounce back within days or weeks.",
        "whenItLoses": "Long bear markets where panic is followed by more panic, and bull runs without deep "
                       "market-wide dips (it sits in euros unless the trend core is on).",
    }
