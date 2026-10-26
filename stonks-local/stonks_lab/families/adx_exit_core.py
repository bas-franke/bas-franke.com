"""adx_exit_core v1 (agent-05): SMA trend core whose exits need a strong trend (Wilder ADX).

A plain "hold while close > SMA" core sells on every dip under the average, also in quiet sideways stretches where
the dip is noise and the core then buys back higher. dmi_core (findings #384/#385) showed that requiring ADX trend
strength before an exit helps on ETH. This family isolates that one idea on the common SMA core:

- enter when close > SMA(coreSma)
- exit when close < SMA(coreSma) AND ADX(dmiLen) >= exitAdx (AND -DI > +DI when dirConfirm)
- exitAdx = 0 is exactly the plain SMA core, so paired runs measure the gate alone.
- hardStop (fraction, 0 = off): also exit when the close is this far below the SMA, whatever the ADX (crash guard)

Decisions at bar t use candles up to and including t. Each market gets maxWeight/len(markets) while held.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from .dmi_core import _asof, dmi

NAME = "adx_exit_core"
VERSION = 1
TITLE = "Trend core with strength-confirmed exits"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"coreSma": 100, "dmiLen": 14, "exitAdx": 25.0, "dirConfirm": True, "hardStop": 0.0}


def param_space() -> dict:
    return {
        "coreSma": {"type": "int", "min": 20, "max": 400, "log": True,
                    "description": "hold while the close is above this SMA"},
        "dmiLen": {"type": "int", "min": 5, "max": 60, "log": True,
                   "description": "Wilder smoothing length of the ADX / DI lines"},
        "exitAdx": {"type": "float", "min": 10, "max": 45, "zero": True,
                    "description": "only sell under the SMA when ADX is at least this (0 = plain SMA core)"},
        "dirConfirm": {"type": "bool", "description": "also require -DI above +DI for the exit"},
        "hardStop": {"type": "float", "min": 0.05, "max": 0.4, "zero": True,
                     "description": "always sell when the close is this fraction under the SMA (0 = off)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["coreSma"]), 2 * int(p["dmiLen"]))


def _weights(df, p) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    s = ind.sma(c, int(p["coreSma"]))
    pdi, mdi, adx = dmi(df["high"].to_numpy(), df["low"].to_numpy(), c, int(p["dmiLen"]))
    xa, dc, hs = float(p.get("exitAdx") or 0), bool(p["dirConfirm"]), float(p.get("hardStop") or 0)
    n = len(c)
    w = np.full(n, np.nan)
    ok = np.isfinite(s) & np.isfinite(adx) & np.isfinite(pdi)
    held = False
    for i in range(n):
        if not ok[i]:
            continue
        if not held:
            held = c[i] > s[i]
        elif c[i] < s[i]:
            strong = adx[i] >= xa and (not dc or mdi[i] > pdi[i])
            if xa == 0 or strong or (hs and c[i] < s[i] * (1 - hs)):
                held = False
        w[i] = 1.0 if held else 0.0
    return w


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    W = np.column_stack([_asof(candles[m], _weights(candles[m], p), idx) * each for m in markets]) \
        if markets else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    xa = float(p.get("exitAdx") or 0)
    steps = [f"It buys {mk} when the price closes above its {bars_text(p['coreSma'], iv)} average."]
    if xa:
        steps.append(
            f"A close below the average only sells when the trend strength (ADX over {bars_text(p['dmiLen'], iv)}) "
            f"is at least {xa:g}" + (" and the down-pushes outweigh the up-pushes" if p["dirConfirm"] else "")
            + "; a quiet dip under the average is held through.")
        if float(p.get("hardStop") or 0):
            steps.append(f"It always sells when the price is more than {pct(p['hardStop'])} under the average.")
    else:
        steps.append("It sells when the price closes below the average.")
    return {
        "summary": f"Holds {mk} above its long average and only sells on a strong downtrend.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Uptrends with quiet dips under the average that a plain trend filter would sell and rebuy higher.",
        "whenItLoses": "Fast crashes: trend strength needs time to build, so it can sell later than a plain filter.",
    }
