"""vol_len_core v1 (agent-17): SMA trend core whose length is switched by the volatility regime.

The fleet's best BTC/ETH strategies sit on a price-above-SMA core, and every fixed length trades off whipsaw (short)
against late crash exits (long). Volatility-regime exits on a fixed core failed (#382 volvol_gate), and switching
the length by drawdown depth helped ETH only through drawdown (#455 depth_core). This family switches the length
by realized volatility instead:

- vol_t = stdev of log returns over the last ``volLen`` candles; pct_t = share of the previous ``rankLen`` values
  of vol below vol_t (trailing percentile, no look-ahead);
- ``mode`` "hi_fast": follow SMA(``fastLen``) while pct_t >= ``volQ`` (turbulent: get out of crashes early), else
  SMA(``slowLen``) (calm: sit through noise); "hi_slow": the opposite (turbulent: don't get shaken out);
- hold while the close is above the active SMA times (1 + ``band``) once in, buy back above it.

Multi-market: each market gets maxWeight / len(markets).
"""
from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "vol_len_core"
VERSION = 1
TITLE = "Volatility-switched SMA core"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"fastLen": 40, "slowLen": 130, "volLen": 20, "rankLen": 365, "volQ": 0.8, "mode": "hi_fast",
            "band": 0.0}


def param_space() -> dict:
    return {
        "fastLen": {"type": "int", "min": 5, "max": 200, "log": True,
                    "description": "SMA length used in one volatility regime (the shorter one)"},
        "slowLen": {"type": "int", "min": 20, "max": 500, "log": True,
                    "description": "SMA length used in the other regime (at least fastLen)"},
        "volLen": {"type": "int", "min": 5, "max": 120, "log": True,
                   "description": "candles in the realized volatility (stdev of log returns)"},
        "rankLen": {"type": "int", "min": 60, "max": 1000, "log": True,
                    "description": "rank the volatility against this many previous candles"},
        "volQ": {"type": "float", "min": 0.3, "max": 0.97,
                 "description": "volatility percentile from which the market counts as turbulent"},
        "mode": {"type": "choice", "values": ["hi_fast", "hi_slow"],
                 "description": "hi_fast = short SMA when turbulent, hi_slow = long SMA when turbulent"},
        "band": {"type": "float", "min": 0.0, "max": 0.05,
                 "description": "sell only below SMA x (1 - band), buy above SMA x (1 + band)"},
    }


def valid_params(p: dict) -> str | None:
    return None if int(p["fastLen"]) <= int(p["slowLen"]) else "fastLen must be at most slowLen"


def warmup(p: dict) -> int:
    return max(int(p["slowLen"]), int(p["volLen"]) + int(p["rankLen"]) + 1)


def vol_pct(close: np.ndarray, vol_len: int, rank_len: int) -> np.ndarray:
    n = len(close)
    r = np.full(n, np.nan)
    if n > 1:
        with np.errstate(divide="ignore", invalid="ignore"):
            r[1:] = np.log(close[1:] / close[:-1])
    vol = np.full(n, np.nan)
    if n >= vol_len:
        w = sliding_window_view(r, vol_len)
        vol[vol_len - 1:] = np.where(np.isfinite(w).all(axis=1), np.std(w, axis=1, ddof=1) if vol_len > 1 else 0.0,
                                     np.nan)
    out = np.full(n, np.nan)
    if n > rank_len:
        w = sliding_window_view(vol, rank_len + 1)
        prev, cur = w[:, :-1], w[:, -1]
        ok = np.isfinite(prev).all(axis=1) & np.isfinite(cur)
        out[rank_len:] = np.where(ok, (prev < cur[:, None]).mean(axis=1), np.nan)
    return out


def state(close: np.ndarray, p: dict) -> np.ndarray:
    fast = ind.sma(close, int(p["fastLen"]))
    slow = ind.sma(close, int(p["slowLen"]))
    pct = vol_pct(close, int(p["volLen"]), int(p["rankLen"]))
    turb = pct >= float(p["volQ"]) - 1e-12
    use_fast = turb if p.get("mode", "hi_fast") == "hi_fast" else ~turb
    ma = np.where(use_fast, fast, slow)
    band = float(p.get("band") or 0.0)
    out = np.full(len(close), np.nan)
    s = None
    for i in range(len(close)):
        c, m = close[i], ma[i]
        if not (np.isfinite(c) and np.isfinite(m) and np.isfinite(pct[i]) and np.isfinite(slow[i])):
            continue
        if s is None:
            s = 1.0 if c > m else 0.0
        elif s == 1.0 and c < m * (1 - band):
            s = 0.0
        elif s == 0.0 and c > m * (1 + band):
            s = 1.0
        out[i] = s
    return out


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
        raise ValueError("vol_len_core needs at least one market")
    idx = union_index(candles, markets)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        mi = np.asarray(df.index, dtype=np.int64)
        st = _asof(mi, state(df["close"].to_numpy(np.float64), p), idx)
        cols[m] = np.where(np.isfinite(st), st * each, np.nan)
    out = frame(idx, cols)
    if len(markets) > 1:
        any_ok = out.notna().any(axis=1).to_numpy()
        out = out.fillna(0.0)
        out[~any_ok] = np.nan
    return out


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    hi_fast = p.get("mode", "hi_fast") == "hi_fast"
    fast, slow = bars_text(p["fastLen"], iv), bars_text(p["slowLen"], iv)
    steps = [
        f"After every {iv} candle it measures how wild the last {bars_text(p['volLen'], iv)} were and compares that "
        f"with the previous {bars_text(p['rankLen'], iv)}; the top {100 - float(p['volQ']) * 100:.0f} % counts as "
        "turbulent.",
        f"It holds {mk} while the price is above its moving average: the {fast if hi_fast else slow} average when "
        f"turbulent, the {slow if hi_fast else fast} average when calm.",
    ]
    if float(p.get("band") or 0) > 0:
        steps.append(f"It only switches when the price is {float(p['band']) * 100:.1f} % past the average.")
    if len(spec.get("markets") or []) > 1:
        steps.append(f"The money is split evenly between {mk}.")
    return {
        "summary": f"Follows the trend of {mk} with a moving average that gets "
                   f"{'shorter' if hi_fast else 'longer'} when the market turns wild.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Crashes that start with a volatility spike: it leaves early, and calm bull markets it sits through."
                      if hi_fast else "Volatile bull markets: it is not shaken out by big swings.",
        "whenItLoses": "Volatile bull markets with sharp pullbacks: the short average sells and buys back higher."
                       if hi_fast else "Crashes: the long average sells late.",
    }
