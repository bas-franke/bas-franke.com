"""amihud_gate v1 (agent-17): hold by default, step aside while the market's Amihud illiquidity is at an extreme.

Amihud illiquidity per candle = |log return| / EUR turnover (volume x close): how far the price moves per euro
traded. Low = heavy churn (lots of euros barely move the price, e.g. distribution into a crowd), high = thin market
(small flows move the price, e.g. after everybody has left). A pre-holdout study (agent-17, wave 6) found that
within each year the 30-day mean's lowest trailing-percentile days were followed by ~3 % weaker 30-day returns on
BTC/ETH 1d in 5/7 years, while across years low illiquidity coincides with bull markets (year clustering, cf. #366).

- a_t = log(mean of illiquidity over the last ``look`` candles up to and including t);
- pct_t = share of the previous ``rankLen`` values of a below a_t (trailing percentile, 0..1, no look-ahead);
- ``side`` "low": sell when pct_t <= ``exitAt``, buy back when pct_t >= ``reenter`` (heavy churn = step aside);
  ``side`` "high": the mirror, using 1 - pct_t (thin market = step aside), as the ablation/control;
- optional SMA core (``coreLen``, 0 = off) with ``combine``: "and" = hold only when both say so, "or" = when either;
- ``scope``: "own" = each coin's own candles, "btc" = BTC-EUR's candles for every coin.

Multi-market: each market gets maxWeight / len(markets).
"""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "amihud_gate"
VERSION = 1
TITLE = "Amihud illiquidity gate"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"look": 30, "rankLen": 365, "side": "low", "exitAt": 0.15, "reenter": 0.35, "coreLen": 0,
            "combine": "and", "scope": "own"}


def param_space() -> dict:
    return {
        "look": {"type": "int", "min": 3, "max": 200, "log": True,
                 "description": "average the illiquidity (|return| / euro turnover) over this many candles"},
        "rankLen": {"type": "int", "min": 60, "max": 1000, "log": True,
                    "description": "rank today's illiquidity against this many previous candles (trailing percentile)"},
        "side": {"type": "choice", "values": ["low", "high"],
                 "description": "low = step aside in heavy churn (low illiquidity), high = step aside in thin markets"},
        "exitAt": {"type": "float", "min": 0.02, "max": 0.5,
                   "description": "sell when the (side-adjusted) percentile falls to this"},
        "reenter": {"type": "float", "min": 0.05, "max": 0.9,
                    "description": "buy back when it rises to this (at least exitAt)"},
        "coreLen": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                    "description": "SMA core length combined with the gate (0 = off)"},
        "combine": {"type": "choice", "values": ["and", "or"],
                    "description": "and = hold only when gate and SMA agree, or = hold when either is bullish"},
        "scope": {"type": "choice", "values": ["own", "btc"],
                  "description": "own = each coin's own candles, btc = BTC-EUR's candles for every coin"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["reenter"]) >= float(p["exitAt"]) else "reenter must be at least exitAt"


def warmup(p: dict) -> int:
    return max(int(p["look"]) + int(p["rankLen"]), int(p.get("coreLen") or 0))


def required_markets(spec: dict) -> list[str]:
    ms = list(spec.get("markets") or [])
    scope = (spec.get("params") or {}).get("scope", "own")
    return ms + (["BTC-EUR"] if scope == "btc" and "BTC-EUR" not in ms else [])


def illiquidity(df) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    v = df["volume"].to_numpy(np.float64)
    r = np.full(len(c), np.nan)
    if len(c) > 1:
        with np.errstate(divide="ignore", invalid="ignore"):
            r[1:] = np.abs(np.log(c[1:] / c[:-1]))
    turn = v * c
    with np.errstate(divide="ignore", invalid="ignore"):
        x = np.where(turn > 0, r / turn, np.nan)
    return np.where(np.isfinite(x), x, np.nan)


def level(df, look: int) -> np.ndarray:
    """log of the trailing mean illiquidity (NaN-tolerant: needs at least half the window)."""
    x = illiquidity(df)
    n = len(x)
    out = np.full(n, np.nan)
    if n < look:
        return out
    w = sliding_window_view(x, look)
    cnt = np.isfinite(w).sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        m = np.nansum(w, axis=1) / np.maximum(cnt, 1)
        lv = np.where((cnt >= max(1, look // 2)) & (m > 0), np.log(m), np.nan)
    out[look - 1:] = lv
    return out


def percentile(a: np.ndarray, rank_len: int) -> np.ndarray:
    """share of the previous ``rank_len`` values strictly below a_t; NaN unless all of them and a_t are finite."""
    n = len(a)
    out = np.full(n, np.nan)
    if n <= rank_len:
        return out
    w = sliding_window_view(a, rank_len + 1)          # row j covers a[j .. j+rank_len], last = current
    prev, cur = w[:, :-1], w[:, -1:]
    ok = np.isfinite(prev).all(axis=1) & np.isfinite(cur[:, 0])
    pct = (prev < cur).mean(axis=1)
    out[rank_len:] = np.where(ok, pct, np.nan)
    return out


def hysteresis(q: np.ndarray, exit_at: float, reenter: float) -> np.ndarray:
    out = np.full(len(q), np.nan)
    state = 1.0
    for i, x in enumerate(q):
        if not np.isfinite(x):
            continue
        if state == 1.0 and x <= exit_at + 1e-12:
            state = 0.0
        elif state == 0.0 and x >= reenter - 1e-12:
            state = 1.0
        out[i] = state
    return out


def gate(df, p: dict) -> np.ndarray:
    pct = percentile(level(df, int(p["look"])), int(p["rankLen"]))
    q = pct if p.get("side", "low") == "low" else 1.0 - pct
    return hysteresis(q, float(p["exitAt"]), float(p["reenter"]))


def _asof(src_index: np.ndarray, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    pos = np.searchsorted(src_index, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = values[pos[ok]]
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("amihud_gate needs at least one market")
    scope = p.get("scope", "own")
    if scope == "btc" and "BTC-EUR" not in candles:
        raise KeyError("amihud_gate scope=btc needs BTC-EUR candles")
    idx = union_index(candles, markets)
    core_len, combine = int(p.get("coreLen") or 0), p.get("combine", "and")
    each = max_weight(spec) / len(markets)
    btc_sig = None
    if scope == "btc":
        b = candles["BTC-EUR"]
        btc_sig = _asof(np.asarray(b.index, dtype=np.int64), gate(b, p), idx)
    cols = {}
    for m in markets:
        df = candles[m]
        mi = np.asarray(df.index, dtype=np.int64)
        c = _asof(mi, df["close"].to_numpy(np.float64), idx)
        sig = btc_sig if btc_sig is not None else _asof(mi, gate(df, p), idx)
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
    low = p.get("side", "low") == "low"
    what = ("unusually heavy trading that barely moves the price (churn)" if low
            else "an unusually thin market where small trades move the price a lot")
    steps = [
        f"After every {iv} candle it measures, over the last {bars_text(p['look'], iv)} ({who} candles), how far the "
        "price moves per euro traded (Amihud illiquidity), and ranks that against the previous "
        f"{bars_text(p['rankLen'], iv)}.",
        f"It holds {mk} by default and sells during {what}: when that rank reaches the most extreme "
        f"{float(p['exitAt']) * 100:.0f} %; it buys back once the rank is back past {float(p['reenter']) * 100:.0f} %.",
    ]
    if p.get("coreLen"):
        both = p.get("combine") == "and"
        steps.append(f"It combines that with a trend core: the price above its {bars_text(p['coreLen'], iv)} average "
                     f"({'both must agree' if both else 'either one is enough'}).")
    if len(spec.get("markets") or []) > 1:
        steps.append(f"The money is split evenly between {mk}.")
    return {
        "summary": f"Holds {mk}, but steps into euros during {what}.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Tops where a crowd churns large volumes without progress: it is out before the drop."
                      if low else "Slow bleeds in deserted markets: it is out while nobody is buying.",
        "whenItLoses": "Bull runs, which bring heavy volume too: it steps out and buys back higher.",
    }
