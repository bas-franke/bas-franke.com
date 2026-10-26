"""pit_breadth_dip v1 (agent-12): breadth_dip with a point-in-time breadth list (no hindsight in the signal).

breadth_dip measures "the whole market is oversold" over TODAY's top 10 (SOL/AVAX/DOGE/BNB picked with hindsight).
This family measures it over the coins that were big AT THAT TIME: the point-in-time pool of ``universe.PIT_POOL``
(every coin that was a CoinMarketCap top-15 coin at a year start 2019-2026 and has Bitvavo EUR candles), of which at
every bar only the ``universe`` coins with the largest trailing EUR turnover count.

- Turnover of a pool market at bar t = sum of close*volume over the ``volLook`` bars BEFORE t (strictly), needing
  ``volLook`` bars of its own history. The ``universe`` largest are the members at t (ties by name).
- A capitulation bar: at least 3 members have an RSI(rsiPeriod), and at least ``breadthMin`` of those have an RSI
  under ``rsiBelow``.
- pool="pit14" is the same over the 14 pool coins that have intraday candles (BTC ETH XRP BNB SOL DOGE ADA TRX LINK
  AVAX BCH LTC XLM DOT; missing LUNA UNI MIOTA XTZ SHIB POL SUI HBAR), so the family also runs on 6h/12h.
- pool="top10" uses breadth_dip's fixed today's-top-10 list instead (all with RSI count, no turnover filter), so the
  two can be compared 1:1 inside this family; it reproduces breadth_dip.
- Trading rules are breadth_dip's: on a capitulation bar each traded market not yet in a dip trade buys; the dip trade
  ends when the market's own RSI rises over sellAbove or after maxHold candles; optional core: also hold while the
  close is above SMA(coreSma). Each market gets maxWeight/len(markets) while held.

pool "pit" needs every pool coin's candles, which exist for 1d and 1W only; use "pit14" on 6h/12h. Everything at bar t uses candles up to and
including t (turnover: before t).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ..universe import PIT_POOL
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "pit_breadth_dip"
VERSION = 1
TITLE = "Market-wide dip buying (point-in-time breadth)"
BOT_READY = False
MULTI_MARKET = True
POOL = sorted(f"{b}-EUR" for b in PIT_POOL)
# the PIT pool coins that also have 6h/12h candles (the others only have 1d/1W): pool "pit14" for intraday bars
POOL14 = ["ADA-EUR", "AVAX-EUR", "BCH-EUR", "BNB-EUR", "BTC-EUR", "DOGE-EUR", "DOT-EUR", "ETH-EUR", "LINK-EUR",
          "LTC-EUR", "SOL-EUR", "TRX-EUR", "XLM-EUR", "XRP-EUR"]
TODAY_TOP10 = ["BTC-EUR", "ETH-EUR", "XRP-EUR", "BNB-EUR", "SOL-EUR", "DOGE-EUR", "ADA-EUR", "TRX-EUR",
               "LINK-EUR", "AVAX-EUR"]
MIN_BREADTH_COINS = 3


def default_params() -> dict:
    return {"rsiPeriod": 14, "rsiBelow": 30, "breadthMin": 0.6, "sellAbove": 60, "maxHold": 0, "coreSma": 0,
            "pool": "pit", "universe": 10, "volLook": 90}


def param_space() -> dict:
    return {
        "rsiPeriod": {"type": "int", "min": 2, "max": 50, "description": "RSI length in candles"},
        "rsiBelow": {"type": "float", "min": 10, "max": 45,
                     "description": "a coin counts as oversold while its RSI is under this"},
        "breadthMin": {"type": "float", "min": 0.2, "max": 1.0,
                       "description": "buy when at least this fraction of the big coins is oversold at once"},
        "sellAbove": {"type": "float", "min": 40, "max": 90,
                      "description": "end the dip trade when the coin's own RSI rises over this"},
        "maxHold": {"type": "int", "min": 2, "max": 500, "zero": True, "log": True,
                    "description": "end the dip trade after this many candles at the latest (0 = no limit)"},
        "coreSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                    "description": "also hold while the coin is above this SMA, dips or not (0 = dips only)"},
        "pool": {"type": "choice", "values": ["pit", "pit14", "top10"],
                 "description": "breadth list: point-in-time top coins by turnover from the 22-coin pool (pit, 1d/1W "
                                "only) or from its 14 coins with intraday candles (pit14), or today's top 10 (top10)"},
        "universe": {"type": "int", "min": 3, "max": 22,
                     "description": "pit: how many of the largest-turnover pool coins count for the breadth"},
        "volLook": {"type": "int", "min": 5, "max": 400, "log": True,
                    "description": "pit: candles over which the turnover (close x volume) is summed"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["rsiBelow"]) < float(p["sellAbove"]) else "rsiBelow must be below sellAbove"


def warmup(p: dict) -> int:
    c = int(p.get("coreSma") or 0)
    return max(int(p["rsiPeriod"]), c - 1 if c > 0 else 0)


def _breadth_markets(p: dict) -> list[str]:
    return {"top10": TODAY_TOP10, "pit14": POOL14}.get(p.get("pool", "pit"), POOL)[:]


def required_markets(spec: dict) -> list[str]:
    p = {**default_params(), **(spec.get("params") or {})}
    return list(dict.fromkeys(list(spec["markets"]) + _breadth_markets(p)))


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """values (on df's own index) as of each time in idx: the latest candle at or before it."""
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _turnover_on(df: pd.DataFrame, idx: np.ndarray) -> np.ndarray:
    """EUR turnover of df's own candles placed on idx: the candle at exactly that time, 0 for a missing bar after
    listing, NaN before the first candle."""
    t = np.asarray(df.index, dtype=np.int64)
    v = (df["volume"].to_numpy(np.float64) * df["close"].to_numpy(np.float64))
    out = np.zeros(len(idx))
    pos = np.searchsorted(t, idx, side="left")
    hit = (pos < len(t)) & (t[np.minimum(pos, len(t) - 1)] == idx)
    out[hit] = v[pos[hit]]
    out[idx < t[0]] = np.nan
    return out


def _members(candles, markets: list[str], idx: np.ndarray, p: dict) -> np.ndarray:
    """Bool [bars, markets]: in the point-in-time breadth list at that bar (turnover of the bars before it)."""
    look, n_univ = int(p["volLook"]), int(p["universe"])
    vol = pd.DataFrame({m: _turnover_on(candles[m], idx) for m in markets})
    trailing = vol.rolling(look, min_periods=look).sum().shift(1)
    rank = trailing.rank(axis=1, ascending=False, method="first")
    return ((rank <= n_univ) & trailing.notna()).to_numpy(bool)


def _capitulation(candles, p, idx) -> np.ndarray:
    """1.0 on capitulation bars, 0.0 otherwise, NaN while fewer than 3 listed coins have an RSI."""
    n = len(idx)
    ms = [m for m in _breadth_markets(p) if m in candles and len(candles[m])]
    if not ms:
        return np.full(n, np.nan)
    if p.get("pool", "pit") != "top10":
        member = _members(candles, ms, idx, p)
    else:
        member = np.ones((n, len(ms)), dtype=bool)
    low, defined = np.zeros(n), np.zeros(n)
    for j, m in enumerate(ms):
        r = ind.rsi(candles[m]["close"].to_numpy(np.float64), int(p["rsiPeriod"]))
        flag = np.where(np.isfinite(r), (r < float(p["rsiBelow"])).astype(np.float64), np.nan)
        f = _asof(candles[m], flag, idx)
        use = member[:, j] & np.isfinite(f)
        low += np.where(use, f, 0.0)
        defined += use
    frac = np.divide(low, defined, out=np.zeros(n), where=defined > 0)
    cap = (frac >= float(p["breadthMin"]) - 1e-12).astype(float)
    if p.get("pool", "pit") != "top10":
        # the turnover ranking needs volLook bars; before that the list is undecided, not "no capitulation"
        warm = np.zeros(n, dtype=bool)
        warm[min(int(p["volLook"]), n):] = True
        cap = np.where(warm, cap, np.nan)
    return np.where(defined >= MIN_BREADTH_COINS, cap, np.nan)


def targets(candles, spec, start_time=None):
    p = {**default_params(), **spec["params"]}
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
    p, iv = {**default_params(), **spec["params"]}, spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    if p.get("pool", "pit") != "top10":
        who = (f"the {int(p['universe'])} coins with the most euro trading volume over the previous "
               f"{bars_text(p['volLook'], iv)} (picked from the coins that were among the biggest at the time, "
               "so no hindsight about which coins later survived)")
    else:
        who = "today's ten biggest coins"
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
        "summary": f"Buys {mk} when most of the biggest coins of the moment are oversold at once and sells after "
                   "the rebound.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Sharp market-wide sell-offs that bounce back within days or weeks.",
        "whenItLoses": "Long bear markets where panic is followed by more panic, and bull runs without deep "
                       "market-wide dips (it sits in euros unless the trend core is on).",
    }
