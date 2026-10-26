"""wick_pressure v1 (agent-16): hold by default, step aside while upper wicks dominate (selling into every rise).

Per candle, wick imbalance = (upper wick - lower wick) / (high - low), with upper wick = high - max(open, close)
and lower wick = min(open, close) - low (0 for a flat candle). Its mean over ``look`` candles is high when rallies keep
getting sold off inside the candle (rejection), low when dips keep getting bought. A pre-holdout study (agent-16,
wave 5) found the 60-day mean's top quintile followed by -1..-7 % 30-day returns on BTC/ETH 1d.

- pressure_t = mean wick imbalance of the last ``look`` candles up to and including t;
- state (starts invested once warm): sell when pressure_t >= ``exitAbove``, buy back when pressure_t <= ``reenter``
  (``reenter`` <= ``exitAbove``: hysteresis);
- optional SMA core (``coreLen``, 0 = off) with ``combine``: "and" = hold only when both say so, "or" = when either;
- ``scope``: "own" = each coin's own candles, "btc" = BTC-EUR's candles for every coin.

Multi-market: each market gets maxWeight / len(markets).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "wick_pressure"
VERSION = 1
TITLE = "Wick pressure exit"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"look": 60, "exitAbove": 0.0, "reenter": -0.04, "coreLen": 0, "combine": "and", "scope": "own"}


def param_space() -> dict:
    return {
        "look": {"type": "int", "min": 10, "max": 300, "log": True,
                 "description": "average the wick imbalance over this many candles"},
        "exitAbove": {"type": "float", "min": -0.08, "max": 0.12,
                      "description": "sell when the mean (upper - lower wick) / range reaches this"},
        "reenter": {"type": "float", "min": -0.2, "max": 0.1,
                    "description": "buy back when it falls to this (at most exitAbove)"},
        "coreLen": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                    "description": "SMA core length combined with the wick signal (0 = off)"},
        "combine": {"type": "choice", "values": ["and", "or"],
                    "description": "and = hold only when wicks and SMA agree, or = hold when either is bullish"},
        "scope": {"type": "choice", "values": ["own", "btc"],
                  "description": "own = each coin's own candles, btc = BTC-EUR's candles for every coin"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["reenter"]) <= float(p["exitAbove"]) else "reenter must be at most exitAbove"


def warmup(p: dict) -> int:
    return max(int(p["look"]), int(p.get("coreLen") or 0))


def required_markets(spec: dict) -> list[str]:
    ms = list(spec.get("markets") or [])
    scope = (spec.get("params") or {}).get("scope", "own")
    return ms + (["BTC-EUR"] if scope == "btc" and "BTC-EUR" not in ms else [])


def imbalance(df) -> np.ndarray:
    o, h, l, c = (df[k].to_numpy(np.float64) for k in ("open", "high", "low", "close"))
    rng = h - l
    up = h - np.maximum(o, c)
    dn = np.minimum(o, c) - l
    with np.errstate(divide="ignore", invalid="ignore"):
        x = np.where(rng > 0, (up - dn) / rng, 0.0)
    return np.where(np.isfinite(c), x, np.nan)


def pressure(df, look: int) -> np.ndarray:
    return ind.sma(imbalance(df), look)


def hysteresis(pr: np.ndarray, exit_above: float, reenter: float) -> np.ndarray:
    out = np.full(len(pr), np.nan)
    state = 1.0
    for i, x in enumerate(pr):
        if not np.isfinite(x):
            continue
        if state == 1.0 and x >= exit_above - 1e-12:
            state = 0.0
        elif state == 0.0 and x <= reenter + 1e-12:
            state = 1.0
        out[i] = state
    return out


def _asof(src_index: np.ndarray, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    """values on src_index, taken as of each ts in idx (last src bar with ts <= t); NaN before the first."""
    pos = np.searchsorted(src_index, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = values[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("wick_pressure needs at least one market")
    scope = p.get("scope", "own")
    if scope == "btc" and "BTC-EUR" not in candles:
        raise KeyError("wick_pressure scope=btc needs BTC-EUR candles")
    idx = union_index(candles, markets)
    look, ex, re_ = int(p["look"]), float(p["exitAbove"]), float(p["reenter"])
    core_len, combine = int(p.get("coreLen") or 0), p.get("combine", "and")
    each = max_weight(spec) / len(markets)
    btc_sig = None
    if scope == "btc":
        b = candles["BTC-EUR"]
        btc_sig = _asof(np.asarray(b.index, dtype=np.int64), hysteresis(pressure(b, look), ex, re_), idx)
    cols = {}
    for m in markets:
        df = candles[m]
        mi = np.asarray(df.index, dtype=np.int64)
        c = _asof(mi, df["close"].to_numpy(np.float64), idx)
        sig = btc_sig if btc_sig is not None else _asof(mi, hysteresis(pressure(df, look), ex, re_), idx)
        if core_len > 0:
            sm = _asof(mi, ind.sma(df["close"].to_numpy(np.float64), core_len), idx)
            core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
            ok = np.isfinite(sig) & np.isfinite(core)
            on = (sig == 1) & (core == 1) if combine == "and" else (sig == 1) | (core == 1)
        else:
            ok = np.isfinite(sig)
            on = sig == 1
        ok &= np.isfinite(c)
        cols[m] = np.where(ok, on.astype(np.float64) * each, np.nan)
    out = frame(idx, cols)
    if len(markets) > 1:
        any_ok = out.notna().any(axis=1).to_numpy()
        out = out.fillna(0.0)
        out[~any_ok] = np.nan
    return out


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    who = "Bitcoin's" if p.get("scope") == "btc" else "the coin's own"
    steps = [
        f"After every {iv} candle it measures, over the last {bars_text(p['look'], iv)} ({who} candles), whether the "
        "upper wicks (prices reached but sold back down) are longer than the lower wicks (dips bought back up).",
        f"It holds {mk} by default and sells when the average imbalance reaches {p['exitAbove']:+.2f} of the "
        f"candle range (rallies keep getting rejected); it buys back once it falls to {p['reenter']:+.2f}.",
    ]
    if p.get("coreLen"):
        both = p.get("combine") == "and"
        steps.append(f"It combines that with a trend core: the price above its {bars_text(p['coreLen'], iv)} average "
                     f"({'both must agree' if both else 'either one is enough'}).")
    if len(spec.get("markets") or []) > 1:
        steps.append(f"The money is split evenly between {mk}.")
    return {
        "summary": f"Holds {mk}, but steps into euros while rallies keep being sold off within the candle "
                   "(long upper wicks).",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Distribution phases near tops, where every push higher is sold: it is out before the drop.",
        "whenItLoses": "Volatile bull markets with long wicks both ways: it sells and buys back higher.",
    }
