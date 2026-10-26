"""asym_core: trend core with a fast entry average and a slow exit average (agent-13).

Every SMA/EMA core on BTC/ETH 1d loses the steady bull folds (2023-05..2024-02: -22 log-pts vs hold, finding #324)
because it re-enters late, while it earns its keep by stepping aside in long bears. This family separates the two
decisions:

- Enter (buy) when the close is above MA(enterLen): a short average, so it is back in early after a dip.
- Exit (sell) only when the close is exitBand below MA(exitLen): a long average, so it only leaves in real bears.
- While the close is below the exit level it never buys, even if the short average would allow it.

Every market is decided on its own candles and gets maxWeight / len(markets) while held. A decision at bar t uses
closes up to and including t only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "asym_core"
VERSION = 1
TITLE = "Fast-in, slow-out trend core"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"maType": "sma", "enterLen": 30, "exitLen": 150, "exitBand": 0.0}


def param_space() -> dict:
    return {
        "maType": {"type": "choice", "values": ["sma", "ema"], "description": "kind of moving average"},
        "enterLen": {"type": "int", "min": 5, "max": 300, "log": True,
                     "description": "buy when the close is above this (short) average"},
        "exitLen": {"type": "int", "min": 20, "max": 600, "log": True,
                    "description": "sell when the close is exitBand below this (long) average"},
        "exitBand": {"type": "float", "min": 0.01, "max": 0.3, "log": True, "zero": True,
                     "description": "how far under the long average the close must be to sell (0 = just under)"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return max(int(p["enterLen"]), int(p["exitLen"])) - 1


def _ma(c: np.ndarray, n: int, kind: str) -> np.ndarray:
    if kind == "ema":
        e = ind.ema(c, n)
        e = np.asarray(e, dtype=np.float64).copy()
        e[: n - 1] = np.nan          # same definition window as the SMA
        return e
    return ind.sma(c, n)


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _held(c: np.ndarray, p: dict) -> np.ndarray:
    kind = p.get("maType", "sma")
    fast = _ma(c, int(p["enterLen"]), kind)
    slow = _ma(c, int(p["exitLen"]), kind)
    band = float(p.get("exitBand") or 0.0)
    out = np.full(len(c), np.nan)
    inside = False
    for i, (x, f, s) in enumerate(zip(c.tolist(), fast.tolist(), slow.tolist())):
        if not (np.isfinite(x) and np.isfinite(f) and np.isfinite(s)):
            continue
        below_exit = x < s * (1.0 - band)
        if inside:
            if below_exit:
                inside = False
        elif x > f and not below_exit:
            inside = True
        out[i] = 1.0 if inside else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    cols = [_asof(candles[m], _held(candles[m]["close"].to_numpy(np.float64), p), idx) * each for m in markets]
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    kind = "exponential " if p.get("maType") == "ema" else ""
    band = float(p.get("exitBand") or 0)
    steps = [
        f"Buy: it buys {mk} as soon as the price is above its {kind}average of the last "
        f"{bars_text(p['enterLen'], iv)}" + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        f"Sell: it only sells once the price is "
        + (f"{pct(band)} or more below" if band > 0 else "below")
        + f" its {kind}average of the last {bars_text(p['exitLen'], iv)}, and does not buy again while it stays there.",
        "Otherwise it keeps what it has.",
    ]
    return {
        "summary": f"Gets back into {mk} quickly after dips but only sells in a real downtrend.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets with sharp dips (it is back in early) and long bear markets (it steps aside).",
        "whenItLoses": "Choppy markets around the long average, and crashes that start far above it (it sells late).",
    }
