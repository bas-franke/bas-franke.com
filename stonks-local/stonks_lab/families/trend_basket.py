"""trend_basket v1 (agent-08, invent lane): graded multi-length trend filter over a basket of coins.

Single-length trend filters on one coin are cliffs (findings #31, #79, #108): which side of 2-3 big turns a length
lands on decides the score. This family spreads the bet twice:

- over lengths: each coin gets ``count`` votes, one per SMA length base, base*mult, base*mult^2, ...; a vote is "up"
  while the close is above that SMA. The coin's weight is its slot * (up votes / count).
- over coins: every market in spec.markets (e.g. the top 10) gets an equal slot of maxWeight / (number of markets
  that already have enough history at that bar). Coins without enough history get 0.

Optional ``btcSma``: all slots go to cash while BTC-EUR closes under its own SMA(btcSma).
All decisions use candles up to and including the bar; other markets are aligned "as of" the bar time.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "trend_basket"
VERSION = 1
TITLE = "Trend basket"
BOT_READY = False
MULTI_MARKET = True
BTC = "BTC-EUR"


def default_params() -> dict:
    return {"base": 20, "mult": 2.0, "count": 3, "btcSma": 0}


def param_space() -> dict:
    return {
        "base": {"type": "int", "min": 5, "max": 200, "log": True,
                 "description": "shortest moving-average length in candles"},
        "mult": {"type": "float", "min": 1.3, "max": 3.0,
                 "description": "each next average is this many times longer"},
        "count": {"type": "int", "min": 1, "max": 4, "description": "number of averages that vote per coin"},
        "btcSma": {"type": "int", "min": 20, "max": 400, "zero": True, "log": True,
                   "description": "hold nothing while bitcoin closes under this SMA (0 = off)"},
    }


def lengths(p: dict) -> list[int]:
    return [max(2, int(round(p["base"] * p["mult"] ** k))) for k in range(int(p["count"]))]


def valid_params(p: dict) -> str | None:
    if lengths(p)[-1] > 400:
        return "longest average over 400 candles"
    return None


def warmup(p: dict) -> int:
    return max(lengths(p)[-1], int(p.get("btcSma") or 0))


def required_markets(spec: dict) -> list[str]:
    p = {**default_params(), **(spec.get("params") or {})}
    return [BTC] if int(p.get("btcSma") or 0) else []


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    ts = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(ts, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    ls = lengths(p)
    frac = {}
    for m in markets:
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        votes = np.zeros(len(c))
        defined = np.ones(len(c), dtype=bool)
        for L in ls:
            s = ind.sma(c, L)
            defined &= np.isfinite(s)
            votes += np.where(np.isfinite(s) & (c > s), 1.0, 0.0)
        f = np.where(defined, votes / len(ls), np.nan)
        frac[m] = _asof(df, f, idx)
    F = np.column_stack([frac[m] for m in markets])
    ndef = np.isfinite(F).sum(axis=1)
    gate = np.ones(n)
    bn = int(p.get("btcSma") or 0)
    if bn:
        b = candles[BTC]["close"].to_numpy(np.float64)
        s = ind.sma(b, bn)
        g = np.where(np.isfinite(s), (b > s).astype(np.float64), np.nan)
        gate = _asof(candles[BTC], g, idx)
    slot = np.divide(max_weight(spec), ndef, out=np.zeros(n), where=ndef > 0)
    W = np.nan_to_num(F, nan=0.0) * slot[:, None] * gate[:, None]
    undecided = (ndef == 0) | ~np.isfinite(gate)
    W[undecided] = np.nan
    first = int(np.argmax(~undecided)) if (~undecided).any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    k = len(spec.get("markets") or [])
    ls = lengths(p)
    avg = ", ".join(bars_text(L, iv) for L in ls)
    steps = [
        f"After every {iv} candle it compares each coin ({mk}) with {len(ls)} moving average"
        f"{'s' if len(ls) > 1 else ''} of its own price: {avg}.",
        "Each average the price is above is one vote for 'this coin is trending up'.",
        (f"Every coin has an equal share of the money ({100 / k:.0f} % when all have enough history); it holds "
         "the part of that share that matches its up votes and keeps the rest in euros." if k > 1 else
         "It holds the part of the money that matches the up votes and keeps the rest in euros."),
    ]
    if int(p.get("btcSma") or 0):
        steps.append(f"While bitcoin is below its {bars_text(p['btcSma'], iv)} average it holds nothing at all.")
    return {
        "summary": f"Holds each of {mk} in proportion to how many of its trend lines point up, so it is fully in "
                   "during broad rallies and steps into euros coin by coin as trends break.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Broad, long rallies and long bear markets: it rides the winners and sits out most of a crash.",
        "whenItLoses": "Choppy sideways markets and sharp V-shaped recoveries, where it sells low and buys back "
                       "higher; it also lags the first weeks of every new rally.",
    }
