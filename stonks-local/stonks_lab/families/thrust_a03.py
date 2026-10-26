"""thrust_a03: SMA trend core plus volatility-scaled price thrusts (agent-03).

A *thrust* is a fast surge: the n-candle log return is more than k times what the coin's own recent volatility
would allow (sigma of single-candle log returns over the volLen candles before the run, scaled by sqrt(n)). The idea comes from an
unrecorded pre-holdout study (BTC/ETH 1d, 2019-03..2025-10, fwd 30 d return minus the year's drift): on ETH a 1-3 day
thrust that starts *below* SMA200 was followed by +8..+14 % (4-5 of 5-6 years positive), one that starts *above* it
by -5..-11 % (0-1 of 5 years); BTC thrusts were mildly positive in both regimes (+3..+5 %).

- Core: held while the close is above SMA(coreSma); coreSma 0 = always held (plain hold as the base).
- buyBelow: a thrust whose run started below the SMA (close at candle t-n under its SMA) buys early and holds for
  holdBars candles (a new thrust restarts the clock), whatever the core says.
- sellAbove: a thrust whose run started above the SMA steps out for outBars candles (exhaustion), unless an early
  re-entry trade is active.

Every market is decided on its own candles and gets maxWeight / len(markets) while held. Decisions at bar t use
closes up to and including t only. The target is re-emitted at every bar.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "thrust_a03"
VERSION = 1
TITLE = "Trend core + volatility thrusts"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"coreSma": 200, "n": 3, "k": 2.0, "volLen": 90, "buyBelow": True, "holdBars": 30,
            "sellAbove": False, "outBars": 30}


def param_space() -> dict:
    return {
        "coreSma": {"type": "int", "min": 20, "max": 400, "log": True, "zero": True,
                    "description": "trend core: hold while the close is above this SMA (0 = always hold)"},
        "n": {"type": "int", "min": 1, "max": 10,
              "description": "thrust length: return over this many candles"},
        "k": {"type": "float", "min": 1.5, "max": 4.0,
              "description": "thrust size: the n-candle return must exceed k x sigma x sqrt(n)"},
        "volLen": {"type": "int", "min": 20, "max": 365, "log": True,
                   "description": "candles of single-candle log returns behind sigma"},
        "buyBelow": {"type": "bool", "description": "a thrust that starts below the SMA buys early"},
        "holdBars": {"type": "int", "min": 3, "max": 200, "log": True,
                     "description": "candles an early re-entry is held (a new thrust restarts the clock)"},
        "sellAbove": {"type": "bool", "description": "a thrust that starts above the SMA steps out (exhaustion)"},
        "outBars": {"type": "int", "min": 3, "max": 200, "log": True,
                    "description": "candles the exhaustion step-out lasts"},
    }


def valid_params(p: dict) -> str | None:
    if not p.get("buyBelow") and not p.get("sellAbove"):
        return "buyBelow or sellAbove must be on"
    if int(p.get("coreSma") or 0) == 0 and p.get("buyBelow") and not p.get("sellAbove"):
        return "without a core (coreSma 0) only sellAbove changes anything"
    return None


def warmup(p: dict) -> int:
    return max(int(p.get("coreSma") or 0) - 1, int(p["volLen"]) + int(p["n"]))


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def thrust_z(c: np.ndarray, n: int, vol_len: int) -> np.ndarray:
    lc = np.log(c)
    r = pd.Series(lc).diff()
    sig = r.rolling(vol_len, min_periods=vol_len).std().shift(n).to_numpy()   # volatility before the run
    move = lc - pd.Series(lc).shift(n).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        return move / (sig * np.sqrt(n))


def _held(c: np.ndarray, p: dict) -> np.ndarray:
    n_bars = len(c)
    core_n = int(p.get("coreSma") or 0)
    n, k = int(p["n"]), float(p["k"])
    z = thrust_z(c, n, int(p["volLen"]))
    if core_n > 0:
        s = ind.sma(c, core_n)
        core_ok = np.isfinite(s)
        above = np.where(core_ok, c > s, False)
    else:
        core_ok = np.ones(n_bars, dtype=bool)
        above = np.ones(n_bars, dtype=bool)
    buy, sell = bool(p.get("buyBelow")), bool(p.get("sellAbove"))
    hold_n, out_n = int(p["holdBars"]), int(p["outBars"])
    out = np.full(n_bars, np.nan)
    reb_until = out_until = -1      # active while i < *_until
    for i in range(n_bars):
        if not (core_ok[i] and np.isfinite(z[i]) and i - n >= 0 and core_ok[i - n]):
            continue
        if z[i] > k:
            if above[i - n]:
                if sell:
                    out_until = i + out_n
            elif buy:
                reb_until = i + hold_n
        if i < reb_until:
            out[i] = 1.0
        elif above[i] and i >= out_until:
            out[i] = 1.0
        else:
            out[i] = 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    cols = []
    for m in markets:
        df = candles[m]
        h = _held(df["close"].to_numpy(np.float64), p)
        cols.append(_asof(df, h, idx) * each)
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k_mk = len(spec.get("markets") or [])
    core_n = int(p.get("coreSma") or 0)
    thrust = (f"a thrust is a surge over {bars_text(p['n'], iv)} that is more than {float(p['k']):.1f} times as big "
              f"as the coin's usual move (measured over the last {bars_text(p['volLen'], iv)})")
    steps = []
    if core_n:
        steps.append(f"Trend core: it holds {mk} while the price is above its {bars_text(core_n, iv)} average"
                     + (f", {100 / k_mk:.0f} % of the money per coin." if k_mk > 1 else "."))
    else:
        steps.append(f"Base: it holds {mk}" + (f", {100 / k_mk:.0f} % of the money per coin." if k_mk > 1 else "."))
    steps.append(f"It watches for thrusts: {thrust}.")
    if p.get("buyBelow") and core_n:
        steps.append(f"A thrust that starts below the average buys back early and holds for "
                     f"{bars_text(p['holdBars'], iv)} (a new thrust restarts the clock), before the average turns up.")
    if p.get("sellAbove"):
        steps.append(f"A thrust that starts above the average is treated as exhaustion: it steps out for "
                     f"{bars_text(p['outBars'], iv)}.")
    steps.append("Otherwise it holds euros.")
    return {
        "summary": f"Rides {mk} uptrends and reacts to unusually fast price surges"
                   + (": early re-entry after a bear-market surge" if p.get("buyBelow") and core_n else "")
                   + ("; steps out after a surge in an uptrend" if p.get("sellAbove") else "") + ".",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Sharp V-shaped turns out of a bear market, and blow-off spikes that fade.",
        "whenItLoses": "Bear-market rallies that fail (it buys them) and bull legs that keep surging (it sells them).",
    }
