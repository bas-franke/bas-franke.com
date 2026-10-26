"""alt_froth v1: hold BTC/ETH, step aside while old altcoins pump far ahead of BTC (agent-01).

Signal ("froth"): the average log return over `lookback` candles of a fixed pool of altcoins that were already listed
on Bitvavo in 2019 (XRP ADA LINK TRX LTC BCH XLM XTZ MIOTA: no hindsight in the coin list), minus BTC's log return
over the same candles. When old alts outrun BTC by more than `threshold` (an alt-season blow-off), the strategy sells
and waits until the spread is back under `threshold - band`, and at least `minOut` candles have passed. Otherwise it
holds every traded market with an equal slice of maxWeight. An optional `trendSma` also exits while the market is
under its own SMA (0 = off).

Signal study (agent-01, 1d 2019-2026, gross): BTC's next-30-day return averaged -18..-32 %/yr annualised after the old
alts led BTC over 60-90 days, against +59..+70 %/yr otherwise. Other markets are aligned "as of" the bar time, so a
decision at bar t uses nothing after t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "alt_froth"
VERSION = 1
TITLE = "Altcoin froth exit"
BOT_READY = False
MULTI_MARKET = True
OLD_ALTS = ["XRP-EUR", "ADA-EUR", "LINK-EUR", "TRX-EUR", "LTC-EUR", "BCH-EUR", "XLM-EUR", "XTZ-EUR", "MIOTA-EUR"]
MIN_POOL = 3


def default_params() -> dict:
    return {"lookback": 90, "threshold": 0.25, "band": 0.1, "minOut": 0, "trendSma": 0}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 5, "max": 400, "log": True,
                     "description": "candles over which the old alts' return is compared with BTC's"},
        "threshold": {"type": "float", "min": 0.0, "max": 1.0,
                      "description": "sell when the old alts beat BTC by more than this log return"},
        "band": {"type": "float", "min": 0.0, "max": 0.5,
                 "description": "buy back once the lead is under threshold minus this"},
        "minOut": {"type": "int", "min": 1, "max": 400, "zero": True, "log": True,
                   "description": "stay out at least this many candles after a froth exit (0 = no minimum)"},
        "trendSma": {"type": "int", "min": 10, "max": 600, "zero": True, "log": True,
                     "description": "also stay out while the market is under this SMA (0 = off)"},
    }


def warmup(p: dict) -> int:
    t = int(p.get("trendSma") or 0)
    return max(int(p["lookback"]), t - 1 if t else 0)


def required_markets(spec: dict) -> list[str]:
    return ["BTC-EUR", *OLD_ALTS]


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _logret(df: pd.DataFrame, n: int) -> np.ndarray:
    c = np.log(df["close"].to_numpy(np.float64))
    out = np.full(len(c), np.nan)
    if len(c) > n:
        out[n:] = c[n:] - c[:-n]
    return out


def froth(candles: dict, lookback: int, idx: np.ndarray) -> np.ndarray:
    """Mean lookback log return of the old-alt pool minus BTC's, on idx; NaN while < MIN_POOL alts or no BTC."""
    n = len(idx)
    tot, cnt = np.zeros(n), np.zeros(n)
    for m in OLD_ALTS:
        if m not in candles or len(candles[m]) == 0:
            continue
        r = _asof(candles[m], _logret(candles[m], lookback), idx)
        tot += np.nan_to_num(r, nan=0.0)
        cnt += np.isfinite(r)
    if "BTC-EUR" not in candles or len(candles["BTC-EUR"]) == 0:
        return np.full(n, np.nan)
    btc = _asof(candles["BTC-EUR"], _logret(candles["BTC-EUR"], lookback), idx)
    alt = np.divide(tot, cnt, out=np.full(n, np.nan), where=cnt >= MIN_POOL)
    return alt - btc


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    sp = froth(candles, int(p["lookback"]), idx)
    thr, band = float(p["threshold"]), float(p["band"])
    min_out, tsma = int(p.get("minOut") or 0), int(p.get("trendSma") or 0)
    each = max_weight(spec) / len(markets)
    # one shared froth state (the signal is market-wide)
    state = np.full(n, np.nan)
    out_, since = False, 0
    for i, s in enumerate(sp.tolist()):
        if not np.isfinite(s):
            continue
        if out_:
            since += 1
            if s < thr - band and since >= min_out:
                out_ = False
        elif s > thr:
            out_, since = True, 0
        state[i] = 0.0 if out_ else 1.0
    cols = {}
    for m in markets:
        df = candles[m]
        if tsma:
            c = df["close"].to_numpy(np.float64)
            s = ind.sma(c, tsma)
            tr = _asof(df, np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan), idx)
        else:
            tr = _asof(df, np.ones(len(df)), idx)
        cols[m] = state * tr * each
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
        f"It holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "") + " by default.",
        f"After every {iv} candle it compares the return over {bars_text(p['lookback'], iv)} of nine altcoins that "
        "were already trading in 2019 (XRP, ADA, LINK, TRX, LTC, BCH, XLM, XTZ, IOTA) with Bitcoin's.",
        f"When those old altcoins are ahead of Bitcoin by more than {pct(np.expm1(float(p['threshold'])))}, the "
        "market is in an alt-season frenzy that usually ends badly: it sells everything and waits in euros.",
        f"It buys back once their lead has shrunk below {pct(np.expm1(float(p['threshold']) - float(p['band'])))}"
        + (f" and at least {bars_text(p['minOut'], iv)} have passed." if int(p.get('minOut') or 0) else "."),
    ]
    if int(p.get("trendSma") or 0):
        steps.append(f"It also stays out of a coin while its price is under its {bars_text(p['trendSma'], iv)} "
                     "average.")
    return {
        "summary": f"Holds {mk}, but sells while old altcoins pump far ahead of Bitcoin (a sign of a frothy top).",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Speculative blow-offs where altcoins run ahead of Bitcoin just before a crash (2021-style tops).",
        "whenItLoses": "Healthy broad bull markets where altcoins lead for months and keep rising; it then misses "
                       "part of the gains while waiting in euros.",
    }
