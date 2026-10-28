"""froth_grid_a21 v1 (agent-21): alt_froth with NO tuned knobs: hold the average position of a fixed 25-cell grid.

alt_froth (hold BTC/ETH, step aside while the 2019 alt pool outruns BTC) is the fleet's most transferable signal, but
its live spec (lookback 120 d, threshold 0.10) was picked on the v2 folds and turned out to be the worst cell of its
own grid in the unscored 2019-12..2020-10 window (finding #822). This family removes the choice: it runs the
froth rule for every cell of a grid fixed in advance (lookback 60/90/120/150/180 days x threshold 0.05/0.10/0.15/0.20/
0.25, band 0.05 each) and holds the average of the 25 in/out states. Nothing is fitted to data.

Knobs that only change the trading mechanics, not the signal:
- ``step``: round the averaged position to this step (0 = hold the exact average, 1 = majority vote of the grid).
- ``pool``: "y2019" = alt_froth's nine 2019 alts; "y2019_11" adds ETC and NEO (the other two alts listed on Bitvavo
  by 2019), to test whether the nine-coin choice matters.

Lookbacks are in days and converted to candles of the spec's interval. A decision at bar t uses candles up to t
only (other markets aligned "as of" the bar time, as in alt_froth).
"""
from __future__ import annotations

import numpy as np

from ..data import INTERVAL_MS
from ._base import frame, market_names, max_weight, risk_steps, union_index
from .alt_froth import OLD_ALTS, _asof, _logret

NAME = "froth_grid_a21"
VERSION = 1
TITLE = "Altcoin froth exit, whole-grid average (no tuned knobs)"
BOT_READY = False
MULTI_MARKET = True
LOOKBACK_DAYS = (60, 90, 120, 150, 180)
THRESHOLDS = (0.05, 0.10, 0.15, 0.20, 0.25)
BAND = 0.05
MIN_POOL = 3
POOLS = {"y2019": list(OLD_ALTS), "y2019_11": [*OLD_ALTS, "ETC-EUR", "NEO-EUR"]}
_DAY = 86_400_000


def default_params() -> dict:
    return {"step": 0.0, "pool": "y2019"}


def param_space() -> dict:
    return {
        "step": {"type": "choice", "values": [0.0, 0.2, 0.5, 1.0],
                 "description": "round the grid-average position to this step (0 = exact average, 1 = majority vote)"},
        "pool": {"type": "choice", "values": list(POOLS),
                 "description": "alt pool: the nine 2019 alts of alt_froth, or all eleven alts listed by 2019"},
    }


def _bars(days: int, interval: str) -> int:
    return max(1, int(round(days * _DAY / INTERVAL_MS[interval])))


def warmup(p: dict, interval: str = "1d") -> int:
    return _bars(max(LOOKBACK_DAYS), interval)


def required_markets(spec: dict) -> list[str]:
    return ["BTC-EUR", *POOLS[spec["params"].get("pool", "y2019")]]


def spread(candles: dict, pool: list[str], n: int, idx: np.ndarray) -> np.ndarray:
    """Mean n-candle log return of the pool minus BTC's, on idx; NaN while < MIN_POOL alts have one or no BTC."""
    tot, cnt = np.zeros(len(idx)), np.zeros(len(idx))
    for m in pool:
        if m not in candles or len(candles[m]) == 0:
            continue
        r = _asof(candles[m], _logret(candles[m], n), idx)
        tot += np.nan_to_num(r, nan=0.0)
        cnt += np.isfinite(r)
    if "BTC-EUR" not in candles or len(candles["BTC-EUR"]) == 0:
        return np.full(len(idx), np.nan)
    btc = _asof(candles["BTC-EUR"], _logret(candles["BTC-EUR"], n), idx)
    return np.divide(tot, cnt, out=np.full(len(idx), np.nan), where=cnt >= MIN_POOL) - btc


def grid_position(candles: dict, pool: list[str], idx: np.ndarray, interval: str) -> np.ndarray:
    """Share (0..1) of the 25 grid cells that hold at each bar; NaN until every cell has decided."""
    acc = np.zeros(len(idx))
    ready = np.ones(len(idx), dtype=bool)
    for days in LOOKBACK_DAYS:
        sp = spread(candles, pool, _bars(days, interval), idx)
        ready &= np.isfinite(sp)
        for thr in THRESHOLDS:
            out_ = False
            st = np.zeros(len(idx))
            for i, s in enumerate(sp.tolist()):
                if np.isfinite(s):
                    if out_ and s < thr - BAND:
                        out_ = False
                    elif not out_ and s > thr:
                        out_ = True
                st[i] = 0.0 if out_ else 1.0
            acc += st
    pos = acc / (len(LOOKBACK_DAYS) * len(THRESHOLDS))
    pos[~ready] = np.nan
    return pos


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    pos = grid_position(candles, POOLS[p.get("pool", "y2019")], idx, spec["interval"])
    step = float(p.get("step") or 0.0)
    if step > 0:
        pos = np.where(np.isfinite(pos), np.clip(np.floor(pos / step + 0.5) * step, 0.0, 1.0), np.nan)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        listed = _asof(candles[m], np.ones(len(candles[m])), idx)
        cols[m] = pos * listed * each
    W = np.column_stack([cols[m] for m in markets])
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else len(idx)
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p = spec["params"]
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    pool = "eleven altcoins that were already trading in 2019 (XRP, ADA, LINK, TRX, LTC, BCH, XLM, XTZ, IOTA, ETC, NEO)" \
        if p.get("pool") == "y2019_11" else \
        "nine altcoins that were already trading in 2019 (XRP, ADA, LINK, TRX, LTC, BCH, XLM, XTZ, IOTA)"
    step = float(p.get("step") or 0.0)
    size = ("It holds the share of the 25 rules that say 'stay in' (for example 80 % of the money when 20 of 25 do)."
            if step == 0 else
            "It holds BTC fully when most of the 25 rules say 'stay in' and sells when most say 'get out'."
            if step >= 1 else
            f"It holds the share of the 25 rules that say 'stay in', rounded to steps of {step * 100:.0f} %.")
    return {
        "summary": f"Holds {mk}, and scales out as more of 25 fixed 'old altcoins pump ahead of Bitcoin' rules fire.",
        "howItWorks": [
            f"By default it holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
            f"Every day it compares the return of {pool} with Bitcoin's over 60, 90, 120, 150 and 180 days.",
            "For each of those five periods it runs five sell rules: get out when the altcoins are ahead by more than "
            "5, 11, 16, 22 or 28 %, and come back once their lead falls 5 % below that line.",
            "None of these 25 settings is tuned; they are a fixed grid chosen in advance.",
            size,
        ] + risk_steps(spec),
        "whenItWins": "Altcoin-season blow-offs before crashes (2021, late 2024): most rules fire together and it "
                      "is mostly in euros when the top breaks.",
        "whenItLoses": "Early bull markets where altcoins bounce harder than Bitcoin (2020): some rules sell too "
                       "soon, and a BTC-led crash with quiet altcoins (2022, 2026) it simply rides like holding.",
    }
