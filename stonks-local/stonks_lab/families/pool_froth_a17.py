"""pool_froth_a17 v1 (agent-17): alt_froth measured on a POINT-IN-TIME altcoin pool instead of the fixed 2019 pool.

alt_froth (agent-01) is the fleet's most robust BTC/ETH signal: hold, but step aside while old altcoins outrun BTC
(alt-season blow-offs before tops). Its pool is fixed: nine alts already listed on Bitvavo in 2019. That pool is
free of hindsight in coin choice but ages: by 2024 the speculation had moved to coins that did not exist in 2019
(SOL, DOGE, AVAX, ...). This family asks whether the mechanism survives a pool a trader could have picked at the
time, i.e. whether "alts outrun BTC" is the signal or the nine 2019 coins are.

Pool at bar t (``pool``):
- "y2019": the nine alt_froth coins, always (paired control; reproduces alt_froth).
- "pit":   the alts (not BTC/ETH) among the ``universe`` coins with the largest trailing 90-day EUR turnover on
           Bitvavo, counting only coins in the CoinMarketCap top 15 (no stablecoins) of the latest January/July
           snapshot before that day (``universe.pit_eligible``), from the 28-coin point-in-time pool.
- "young": as "pit" but only coins first listed on Bitvavo after 2019 (none of the 2019 coins): an out-of-pool test.
- ``cohortLag`` > 0 (v2): pit/young use the members of ``cohortLag`` days earlier (a cohort that ages, as the 2019
  pool did), still only while those coins trade.

Signal: mean ``lookback``-candle log return of the pool members minus BTC's. Sell everything when it is above
``threshold``; buy back once it is below ``threshold - band``. While fewer than ``minPool`` members have a return
(e.g. "young" before 2021) the market is not frothy: it holds. Every traded market gets maxWeight / len(markets).
Survivorship caveat: the 28-coin pool only has coins Bitvavo still lists (delisted EOS/BSV/DASH/XMR are missing).
A decision at bar t uses candles up to t only; membership uses turnover of the days before t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import universe as uni
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from .alt_froth import OLD_ALTS

NAME = "pool_froth_a17"
VERSION = 2                    # v2: cohortLag (0 = v1 behaviour)
TITLE = "Altcoin froth exit, point-in-time pool"
BOT_READY = False
MULTI_MARKET = True
_DAY = 86_400_000
LISTED_2019 = ("ADA", "BCH", "BTC", "ETC", "ETH", "LINK", "LTC", "MIOTA", "NEO", "TRX", "XLM", "XRP", "XTZ")
PIT_ALL = [f"{b}-EUR" for b in sorted(uni.PIT_POOL)]


def default_params() -> dict:
    return {"lookback": 120, "threshold": 0.1, "band": 0.05, "pool": "pit", "universe": 10, "minPool": 3,
            "cohortLag": 0}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 10, "max": 400, "log": True,
                     "description": "candles over which the pool's return is compared with BTC's"},
        "threshold": {"type": "float", "min": 0.0, "max": 1.0,
                      "description": "sell when the alt pool beats BTC by more than this log return"},
        "band": {"type": "float", "min": 0.0, "max": 0.5,
                 "description": "buy back once the lead is under threshold minus this"},
        "pool": {"type": "choice", "values": ["y2019", "pit", "young"],
                 "description": "fixed 2019 alts, point-in-time alts, or point-in-time alts listed after 2019"},
        "universe": {"type": "int", "min": 4, "max": 28,
                     "description": "pit/young: rank this many eligible coins by trailing 90 d EUR turnover"},
        "minPool": {"type": "int", "min": 1, "max": 6,
                    "description": "fewer pool members than this with a return: not frothy (hold)"},
        "cohortLag": {"type": "int", "min": 90, "max": 1500, "zero": True,
                      "description": "pit/young: use the pool members of this many days ago (an aging cohort, "
                                     "like the fixed 2019 pool); 0 = today's members"},
    }


def warmup(p: dict) -> int:
    return int(p["lookback"])


def _pool_markets(p: dict) -> list[str]:
    if p.get("pool") == "y2019":
        return list(OLD_ALTS)
    alts = [m for m in PIT_ALL if m not in ("BTC-EUR", "ETH-EUR")]
    if p.get("pool") == "young":
        alts = [m for m in alts if m.split("-")[0] not in LISTED_2019]
    return alts


def required_markets(spec: dict) -> list[str]:
    p = {**default_params(), **(spec.get("params") or {})}
    need = ["BTC-EUR"] + (list(OLD_ALTS) if p.get("pool") == "y2019" else PIT_ALL)
    return list(dict.fromkeys(list(spec["markets"]) + need))


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def _logret(df: pd.DataFrame, n: int) -> np.ndarray:
    c = np.log(df["close"].to_numpy(np.float64))
    out = np.full(len(c), np.nan)
    if len(c) > n:
        out[n:] = c[n:] - c[:-n]
    return out


def _turnover_days(df: pd.DataFrame, days: np.ndarray) -> np.ndarray:
    """EUR turnover per UTC day on ``days`` (day open ms) from df's own candles; NaN before the first candle."""
    t = np.asarray(df.index, dtype=np.int64)
    v = df["volume"].to_numpy(np.float64) * df["close"].to_numpy(np.float64)
    s = pd.Series(v, index=(t // _DAY) * _DAY).groupby(level=0).sum()
    out = s.reindex(days).to_numpy(np.float64)
    out = np.where(np.isnan(out), 0.0, out)
    out[days < (t[0] // _DAY) * _DAY] = np.nan
    return out


def _members(candles: dict, p: dict, idx: np.ndarray, names: list[str]) -> np.ndarray:
    """Bool [bars, names]: pool member at that bar (y2019: always; else point-in-time turnover rank)."""
    if p.get("pool") == "y2019":
        return np.ones((len(idx), len(names)), dtype=bool)
    ranked = [m for m in PIT_ALL if m in candles and len(candles[m])]
    if not ranked:
        return np.zeros((len(idx), len(names)), dtype=bool)
    lag = int(p.get("cohortLag") or 0) * _DAY
    d0 = (int(idx.min()) // _DAY) * _DAY - 100 * _DAY - lag
    days = np.arange(d0, (int(idx.max()) // _DAY) * _DAY + _DAY, _DAY, dtype=np.int64)
    vol = pd.DataFrame({m: _turnover_days(candles[m], days) for m in ranked}, index=days)
    trailing = vol.rolling(90, min_periods=90).sum().shift(1)          # days before only
    trailing = trailing.where(uni.pit_eligible(days, ranked))
    rank = trailing.rank(axis=1, ascending=False, method="first")
    member_day = ((rank <= int(p["universe"])) & trailing.notna())
    pos = np.searchsorted(days, (idx // _DAY) * _DAY - lag, side="right") - 1
    out = np.zeros((len(idx), len(names)), dtype=bool)
    for j, m in enumerate(names):
        if m in member_day.columns:
            out[:, j] = np.where(pos >= 0, member_day[m].to_numpy(bool)[np.maximum(pos, 0)], False)
    return out


def spread(candles: dict, p: dict, idx: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(pool mean log return minus BTC's, member count with a return) on idx."""
    n = len(idx)
    names = [m for m in _pool_markets(p) if m in candles and len(candles[m])]
    mem = _members(candles, p, idx, names)
    tot, cnt = np.zeros(n), np.zeros(n)
    lb = int(p["lookback"])
    for j, m in enumerate(names):
        r = _asof(candles[m], _logret(candles[m], lb), idx)
        use = mem[:, j] & np.isfinite(r)
        tot += np.where(use, r, 0.0)
        cnt += use
    if "BTC-EUR" not in candles or not len(candles["BTC-EUR"]):
        return np.full(n, np.nan), cnt
    btc = _asof(candles["BTC-EUR"], _logret(candles["BTC-EUR"], lb), idx)
    alt = np.divide(tot, cnt, out=np.full(n, np.nan), where=cnt > 0)
    return alt - btc, cnt


def targets(candles, spec, start_time=None):
    p = {**default_params(), **spec["params"]}
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    sp, cnt = spread(candles, p, idx)
    btc_ok = np.isfinite(_asof(candles["BTC-EUR"], _logret(candles["BTC-EUR"], int(p["lookback"])), idx)) \
        if "BTC-EUR" in candles and len(candles["BTC-EUR"]) else np.zeros(n, dtype=bool)
    thr, band, min_pool = float(p["threshold"]), float(p["band"]), int(p["minPool"])
    state = np.full(n, np.nan)
    out_ = False
    for i in range(n):
        if not btc_ok[i]:
            continue
        s = sp[i] if cnt[i] >= min_pool else np.nan
        if not np.isfinite(s):
            out_ = False                      # pool too small: not frothy, hold
        elif out_:
            if s < thr - band:
                out_ = False
        elif s > thr:
            out_ = True
        state[i] = 0.0 if out_ else 1.0
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        listed = _asof(candles[m], np.ones(len(candles[m])), idx)
        cols[m] = state * listed * each
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
    who = {
        "y2019": "nine altcoins that were already trading on Bitvavo in 2019 (XRP, ADA, LINK, TRX, LTC, BCH, XLM, "
                 "XTZ, IOTA)",
        "pit": f"the altcoins among the {int(p['universe'])} biggest coins of that moment (CoinMarketCap top 15 of "
               "the latest half-year snapshot, ranked by euro trading volume over the previous 90 days)",
        "young": f"the altcoins listed after 2019 among the {int(p['universe'])} biggest coins of that moment "
                 "(CoinMarketCap top 15, ranked by euro trading volume over the previous 90 days)",
    }[p["pool"]]
    if p["pool"] != "y2019" and int(p.get("cohortLag") or 0):
        who = who.replace("of that moment", f"of {bars_text(int(p['cohortLag']), '1d')} earlier")
    steps = [
        f"It holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "") + " by default.",
        f"After every {iv} candle it compares the average return over {bars_text(p['lookback'], iv)} of {who} "
        "with Bitcoin's.",
        f"When those altcoins are ahead of Bitcoin by more than {pct(np.expm1(float(p['threshold'])))}, the market "
        "is in an alt-season frenzy: it sells everything and waits in euros.",
        f"It buys back once their lead has shrunk below {pct(np.expm1(float(p['threshold']) - float(p['band'])))}.",
        f"With fewer than {int(p['minPool'])} such altcoins it just holds.",
    ]
    return {
        "summary": f"Holds {mk}, but sells while the altcoins of the day pump far ahead of Bitcoin.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Speculative blow-offs where altcoins run ahead of Bitcoin just before a crash.",
        "whenItLoses": "Broad bull markets where altcoins lead for months and keep rising.",
    }
