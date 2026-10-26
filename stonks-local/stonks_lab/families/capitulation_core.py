"""capitulation_core v1 (agent-18): SMA trend core plus a time-limited buy after a capitulation sell-off.

Why: the only single-coin specs that beat buy and hold under eval v2 (core_dip, breadth_dip, core_rebound) combine
an SMA core with a panic buy held for weeks to months; their panic signal is an oscillator (RSI). This family tests a
different, classic capitulation signal: a deep drawdown from the recent high that comes with a spike in EUR turnover
(forced sellers). No top-10 list is used (no survivorship).

Per market, decided at the close of bar t (candles up to and including t only):

- drawdown: close[t] / highest close of the last ``ddLook`` candles - 1 <= -ddMin
- volume spike (volMult > 0): EUR turnover (volume x close) of bar t >= volMult x the mean turnover of the
  ``volLen`` candles before t (volMult = 0: drawdown alone)
- trigger by ``scope``: "own" = the market itself; "pair" = BTC and ETH both in drawdown and at least one of them
  spiking; "btc" = BTC's condition
- a dip trade starts on a trigger and lasts ``maxHold`` candles (a new trigger restarts the clock)
- besides dip trades the market is held while its close is above SMA(coreSma) (0 = dips only)

Each market gets maxWeight / len(markets) while held.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "capitulation_core"
VERSION = 1
TITLE = "Trend core plus capitulation-volume buys"
BOT_READY = False
MULTI_MARKET = True
PAIR = ["BTC-EUR", "ETH-EUR"]


def default_params() -> dict:
    return {"ddLook": 30, "ddMin": 0.25, "volLen": 30, "volMult": 2.0, "maxHold": 60, "coreSma": 130,
            "scope": "own"}


def param_space() -> dict:
    return {
        "ddLook": {"type": "int", "min": 5, "max": 400, "log": True,
                   "description": "candles in the recent high the drawdown is measured from"},
        "ddMin": {"type": "float", "min": 0.05, "max": 0.6, "log": True,
                  "description": "a capitulation needs the close at least this fraction under the recent high"},
        "volLen": {"type": "int", "min": 5, "max": 200, "log": True,
                   "description": "candles in the average EUR turnover a spike is compared with"},
        "volMult": {"type": "float", "min": 1.2, "max": 6.0, "log": True, "zero": True,
                    "description": "turnover must be this multiple of its average (0 = drawdown alone)"},
        "maxHold": {"type": "int", "min": 2, "max": 500, "log": True,
                    "description": "a dip trade is held this many candles"},
        "coreSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                    "description": "also hold while the close is above this SMA (0 = dips only)"},
        "scope": {"type": "choice", "values": ["own", "pair", "btc"],
                  "description": "whose capitulation starts a dip trade: the coin's own, BTC and ETH together, BTC's"},
    }


def warmup(p: dict) -> int:
    c = int(p.get("coreSma") or 0)
    v = int(p["volLen"]) if float(p.get("volMult") or 0) > 0 else 0
    return max(int(p["ddLook"]) - 1, v, c - 1 if c > 0 else 0)


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


def _conditions(df: pd.DataFrame, p: dict) -> tuple[np.ndarray, np.ndarray]:
    """(drawdown hit, volume spike) per bar of df as 1.0/0.0, NaN while undefined."""
    c = df["close"].to_numpy(np.float64)
    hi = ind.rolling_max(c, int(p["ddLook"]))
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = np.where(np.isfinite(hi), (c / hi - 1.0 <= -float(p["ddMin"])).astype(np.float64), np.nan)
    mult = float(p.get("volMult") or 0)
    if mult <= 0:
        return dd, np.where(np.isfinite(dd), 1.0, np.nan)
    turn = df["volume"].to_numpy(np.float64) * c
    avg = ind.shift(ind.sma(turn, int(p["volLen"])), 1)
    with np.errstate(invalid="ignore"):
        sp = np.where(np.isfinite(avg), (turn >= mult * avg).astype(np.float64), np.nan)
    return dd, sp


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    scope = p.get("scope", "own")
    idx = union_index(candles, markets)
    n = len(idx)
    shared = None
    if scope in ("pair", "btc"):
        trig = PAIR if scope == "pair" else ["BTC-EUR"]
        dds, sps = [], []
        for m in trig:
            dd, sp = _conditions(candles[m], p)
            dds.append(_asof(candles[m], dd, idx))
            sps.append(_asof(candles[m], sp, idx))
        defined = np.all([np.isfinite(a) for a in dds + sps], axis=0)
        hit = np.all([a == 1.0 for a in dds], axis=0) & np.any([a == 1.0 for a in sps], axis=0)
        shared = np.where(defined, hit.astype(np.float64), np.nan)
    core_n, max_hold = int(p.get("coreSma") or 0), int(p["maxHold"])
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        if shared is None:
            dd, sp = _conditions(df, p)
            start = np.where(np.isfinite(dd) & np.isfinite(sp), ((dd == 1.0) & (sp == 1.0)).astype(np.float64),
                             np.nan)
            start = _asof(df, start, idx)
        else:
            start = shared
        if core_n:
            s = ind.sma(c, core_n)
            core = _asof(df, np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan), idx)
        else:
            core = np.where(np.isfinite(start), 0.0, np.nan)
        w = np.full(n, np.nan)
        ok = (np.isfinite(start) & np.isfinite(core)).tolist()
        startl, corel = start.tolist(), core.tolist()
        left = 0
        for i in range(n):
            if not ok[i]:
                continue
            if startl[i] == 1.0:
                left = max_hold
            inside = left > 0
            w[i] = each if (inside or corel[i] == 1.0) else 0.0
            if left > 0:
                left -= 1
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
    who = {"own": "the coin itself", "pair": "BTC and ETH together", "btc": "BTC"}[scope]
    vol = (f" on a day of panic selling: EUR turnover at least {float(p['volMult']):g} times its average of the last "
           f"{bars_text(p['volLen'], iv)}" if float(p.get("volMult") or 0) > 0 else "")
    steps = [
        f"After every {iv} candle it checks whether {who} closed at least {pct(p['ddMin'])} under the highest close "
        f"of the last {bars_text(p['ddLook'], iv)}{vol}.",
        f"That is treated as a capitulation: it buys {mk}"
        + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "")
        + f" and keeps the purchase for {bars_text(p['maxHold'], iv)}.",
    ]
    if int(p.get("coreSma") or 0):
        steps.append(f"Besides those buys it holds the coin whenever its price is above its "
                     f"{bars_text(p['coreSma'], iv)} average, so it rides uptrends too.")
    return {
        "summary": f"Holds {mk} in uptrends and buys capitulation sell-offs (deep drop on heavy volume), "
                   "holding them for a fixed time.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets (the trend core holds) and sharp crashes that bottom on a burst of forced selling "
                      "and recover within the holding time.",
        "whenItLoses": "Slow bear markets with several heavy-volume legs down: each capitulation buy rides the next "
                       "drop until its time is up.",
    }
