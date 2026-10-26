"""breadth_era v1 (agent-02): breadth_dip with a choice of breadth list, so the hindsight in its signal can be measured.

breadth_dip counts "how much of the market is oversold" over TODAY's top 10 (SOL/AVAX/DOGE/BNB picked with
hindsight). This family keeps breadth_dip's trading rules exactly and only changes which coins vote:

- ``today``: breadth_dip's list (reproduces breadth_dip 1:1, for paired comparisons).
- ``y2020``: the top 10 a trader could have written down on 2020-01-01 (CoinMarketCap, no stablecoins; EOS and BSV
  have no Bitvavo EUR market, XTZ has no intraday candles, so the next coin LINK fills in):
  BTC ETH XRP BCH LTC BNB XLM TRX ADA LINK. BNB-EUR candles start 2021-08 and joins then.
- ``pit``: the point-in-time universe of ``universe.py`` (``top10_pit``): at every bar the 10 pool coins with the
  largest trailing 90-day EUR turnover on Bitvavo (days strictly before the bar's day, from the 1d candles). Only
  members that have candles at the spec's interval vote (on 12h/6h: no MIOTA/XTZ/LUNA/UNI/SHIB/POL/SUI/HBAR).

A capitulation bar is one where at least ``breadthMin`` of the voting coins (at least 3 with an RSI) have
RSI(rsiPeriod) < rsiBelow. Each traded market that is not in a dip trade buys; the dip trade ends when its own RSI
rises over sellAbove or after maxHold candles. Optional core: also hold while close > SMA(coreSma).
Other markets are read "as of" the bar time, so a decision at bar t uses nothing after t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import data
from .. import indicators as ind
from ..universe import PIT_POOL, pit_daily_members
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "breadth_era"
VERSION = 1
TITLE = "Market-wide dip buying (era breadth list)"
BOT_READY = False
MULTI_MARKET = True
LISTS = {
    "today": ["BTC-EUR", "ETH-EUR", "XRP-EUR", "BNB-EUR", "SOL-EUR", "DOGE-EUR", "ADA-EUR", "TRX-EUR", "LINK-EUR",
              "AVAX-EUR"],
    "y2020": ["BTC-EUR", "ETH-EUR", "XRP-EUR", "BCH-EUR", "LTC-EUR", "BNB-EUR", "XLM-EUR", "TRX-EUR", "ADA-EUR",
              "LINK-EUR"],
}
POOL = sorted(f"{b}-EUR" for b in PIT_POOL)
MIN_BREADTH_COINS = 3
_DAY = 86_400_000


def default_params() -> dict:
    return {"rsiPeriod": 14, "rsiBelow": 30, "breadthMin": 0.6, "sellAbove": 60, "maxHold": 0, "coreSma": 0,
            "breadthList": "y2020"}


def param_space() -> dict:
    return {
        "rsiPeriod": {"type": "int", "min": 2, "max": 50, "description": "RSI length in candles"},
        "rsiBelow": {"type": "float", "min": 10, "max": 45,
                     "description": "a coin counts as oversold while its RSI is under this"},
        "breadthMin": {"type": "float", "min": 0.2, "max": 1.0,
                       "description": "buy when at least this fraction of the voting coins is oversold at once"},
        "sellAbove": {"type": "float", "min": 40, "max": 90,
                      "description": "end the dip trade when the coin's own RSI rises over this"},
        "maxHold": {"type": "int", "min": 2, "max": 500, "zero": True, "log": True,
                    "description": "end the dip trade after this many candles at the latest (0 = no limit)"},
        "coreSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                    "description": "also hold while the coin is above this SMA, dips or not (0 = dips only)"},
        "breadthList": {"type": "choice", "values": ["y2020", "pit", "today"],
                        "description": "voting coins: the 2020-01-01 top 10 (y2020), the point-in-time top 10 by "
                                       "turnover (pit), or today's top 10 (today, hindsight)"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["rsiBelow"]) < float(p["sellAbove"]) else "rsiBelow must be below sellAbove"


def warmup(p: dict) -> int:
    c = int(p.get("coreSma") or 0)
    return max(int(p["rsiPeriod"]), c - 1 if c > 0 else 0)


def _voters(p: dict, interval: str | None) -> list[str]:
    lst = p.get("breadthList", "y2020")
    if lst != "pit":
        return list(LISTS[lst])
    if interval is None:
        return list(POOL)
    return [m for m in POOL if data.candle_path(m, interval).exists()]


def required_markets(spec: dict) -> list[str]:
    p = {**default_params(), **(spec.get("params") or {})}
    return _voters(p, spec.get("interval"))


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """values (on df's own index) as of each time in idx: the latest candle at or before it."""
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _pit_membership(idx: np.ndarray, ms: list[str], daily: dict | None) -> np.ndarray:
    """Bool [bars, ms]: member of the point-in-time top 10 (ranked over the whole pool) on the bar's day."""
    if daily is None:
        daily = {}
        for m in POOL:
            try:
                daily[m] = data.load_candles(m, "1d")
            except FileNotFoundError:
                daily[m] = None
    dm = pit_daily_members(daily)
    out = np.zeros((len(idx), len(ms)), dtype=bool)
    if dm.empty:
        return out
    days = np.asarray(dm.index, dtype=np.int64)
    pos = np.searchsorted(days, (idx // _DAY) * _DAY, side="right") - 1
    ok = pos >= 0
    for j, m in enumerate(ms):
        if m in dm.columns:
            out[ok, j] = dm[m].to_numpy(dtype=bool)[pos[ok]]
    return out


def _capitulation(candles, p, idx, interval=None, daily=None) -> np.ndarray:
    """1.0 on capitulation bars, 0.0 otherwise, NaN while fewer than 3 voting coins have an RSI."""
    n = len(idx)
    ms = [m for m in _voters(p, interval) if m in candles and len(candles[m])]
    member = (_pit_membership(idx, ms, daily) if p.get("breadthList") == "pit"
              else np.ones((n, len(ms)), dtype=bool))
    low, defined = np.zeros(n), np.zeros(n)
    for j, m in enumerate(ms):
        r = ind.rsi(candles[m]["close"].to_numpy(np.float64), int(p["rsiPeriod"]))
        flag = np.where(np.isfinite(r), (r < float(p["rsiBelow"])).astype(np.float64), np.nan)
        f = _asof(candles[m], flag, idx)
        use = member[:, j] & np.isfinite(f)
        low += np.where(use, f, 0.0)
        defined += use
    frac = np.divide(low, defined, out=np.zeros(n), where=defined > 0)
    return np.where(defined >= MIN_BREADTH_COINS, (frac >= float(p["breadthMin"]) - 1e-12).astype(float), np.nan)


def targets(candles, spec, start_time=None, daily=None):
    p = {**default_params(), **spec["params"]}
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    cap = _capitulation(candles, p, idx, spec.get("interval"), daily)
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
    p, iv = {**default_params(), **spec["params"]}, spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    who = {"y2020": "the ten biggest coins of January 2020 (BTC, ETH, XRP, BCH, LTC, BNB, XLM, TRX, ADA, LINK)",
           "pit": "the ten coins with the most euro trading volume on Bitvavo over the previous 90 days",
           "today": "today's ten biggest coins"}[p["breadthList"]]
    steps = [
        f"After every {iv} candle it computes the RSI over {bars_text(p['rsiPeriod'], iv)} for {who}: a 0-100 "
        "score of how hard each price has been falling or rising lately.",
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
        "summary": f"Buys {mk} when most of the big coins are oversold at once and sells after the rebound.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Sharp market-wide sell-offs that bounce back within days or weeks.",
        "whenItLoses": "Long bear markets where panic is followed by more panic, and bull runs without deep "
                       "market-wide dips (it sits in euros unless the trend core is on).",
    }
