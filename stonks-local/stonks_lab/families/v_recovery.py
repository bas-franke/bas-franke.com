"""v_recovery v1 (agent-07): SMA trend core plus a *confirmed* rebound buy after a crash, BTC/ETH signals only.

The breadth_dip finding (#213) is that an SMA core alone loses to buy and hold because it re-enters V-shaped
recoveries late, and a panic buy (bought at the bottom) fixes that, but only with the top-10 breadth signal (which has
survivorship). core_dip/core_rebound (buy BTC/ETH oversold RSI) are fragile peaks (#246, #254) because they hinge on
which 3-5 panic days get bought. This family waits for the bounce instead of guessing the bottom:

- crash:  the lowest close of the last ``lowLook`` candles is at least ``ddMin`` below the highest close of the last
          ``hiLook`` candles (a real crash happened recently);
- bounce: the close is at least ``bounceMin`` above that low (the recovery has started).

When both hold (``source`` "own": on the market itself; "pair": on BTC and ETH at once) a rebound trade starts and is
held for ``holdBars`` candles; with ``stopAtLow`` it ends early when the close falls back under the low it bounced
from (a failed recovery). Besides rebound trades a market is held while its close is above its SMA(coreSma)
(0 = no core). Each market gets maxWeight/len(markets) while held. A decision at bar t uses closes up to bar t only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import aligned_close, bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "v_recovery"
VERSION = 1
TITLE = "Trend core plus confirmed crash rebounds"
BOT_READY = False
MULTI_MARKET = True
PAIR = ["BTC-EUR", "ETH-EUR"]


def default_params() -> dict:
    return {"coreSma": 130, "hiLook": 90, "lowLook": 20, "ddMin": 0.3, "bounceMin": 0.15, "holdBars": 60,
            "stopAtLow": True, "source": "own"}


def param_space() -> dict:
    return {
        "coreSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                    "description": "also hold while the close is above this SMA (0 = rebound trades only)"},
        "hiLook": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "candles in the recent high the crash is measured from"},
        "lowLook": {"type": "int", "min": 2, "max": 120, "log": True,
                    "description": "candles in the recent low the crash depth and the bounce are measured at"},
        "ddMin": {"type": "float", "min": 0.08, "max": 0.6,
                  "description": "the recent low must be at least this far below the recent high (0.3 = 30 %)"},
        "bounceMin": {"type": "float", "min": 0.02, "max": 0.5,
                      "description": "a rebound trade starts once the close is this far above the recent low"},
        "holdBars": {"type": "int", "min": 2, "max": 500, "log": True,
                     "description": "candles a rebound trade is held"},
        "stopAtLow": {"type": "bool", "description": "end a rebound trade when the close falls under its low again"},
        "source": {"type": "choice", "values": ["own", "pair"],
                   "description": "whose crash + bounce starts a trade: the market's own, or BTC and ETH both"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["lowLook"]) > int(p["hiLook"]):
        return "lowLook must not exceed hiLook"
    return None


def warmup(p: dict) -> int:
    c = int(p.get("coreSma") or 0)
    return max(int(p["hiLook"]) - 1, c - 1 if c > 0 else 0)


def required_markets(spec: dict) -> list[str]:
    out = list(spec.get("markets") or [])
    if (spec.get("params") or {}).get("source", "own") == "pair":
        out += [m for m in PAIR if m not in out]
    return out


def _signal(c: np.ndarray, p: dict) -> tuple[np.ndarray, np.ndarray]:
    """(start signal 1/0/NaN, recent low) per bar, from closes up to that bar."""
    s = pd.Series(c)
    hi = s.rolling(int(p["hiLook"]), min_periods=int(p["hiLook"])).max().to_numpy()
    lo = s.rolling(int(p["lowLook"]), min_periods=int(p["lowLook"])).min().to_numpy()
    with np.errstate(invalid="ignore", divide="ignore"):
        hit = (lo <= hi * (1.0 - float(p["ddMin"]))) & (c >= lo * (1.0 + float(p["bounceMin"])))
    sig = np.where(np.isfinite(hi) & np.isfinite(lo) & np.isfinite(c), hit.astype(np.float64), np.nan)
    return sig, lo


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    shared = None
    if p.get("source", "own") == "pair":
        sigs = [_signal(aligned_close(candles, m, idx), p)[0] for m in PAIR]
        defined = np.all([np.isfinite(x) for x in sigs], axis=0)
        hit = np.all([np.nan_to_num(x, nan=0.0) == 1.0 for x in sigs], axis=0)
        shared = np.where(defined, hit.astype(np.float64), np.nan)
    core_n, hold = int(p.get("coreSma") or 0), int(p["holdBars"])
    stop = bool(p.get("stopAtLow", True))
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        own, lo = _signal(c, p)
        start = own if shared is None else shared
        if core_n:
            s = pd.Series(c).rolling(core_n, min_periods=core_n).mean().to_numpy()
            core = np.where(np.isfinite(s) & np.isfinite(c), (c > s).astype(np.float64), np.nan)
        else:
            core = np.where(np.isfinite(c), 0.0, np.nan)
        w = np.full(n, np.nan)
        ok = (np.isfinite(start) & np.isfinite(core) & np.isfinite(lo)).tolist()
        startl, corel, cl, lol = start.tolist(), core.tolist(), c.tolist(), lo.tolist()
        inside, held, floor = False, 0, 0.0
        for i in range(n):
            if not ok[i]:
                continue
            if inside:
                held += 1
                if held >= hold or (stop and cl[i] < floor):
                    inside = False
            if not inside and startl[i] == 1.0:
                inside, held, floor = True, 0, lol[i]
            w[i] = each if (inside or corel[i] == 1.0) else 0.0
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
    who = "both BTC and ETH" if p.get("source", "own") == "pair" else "the coin itself"
    steps = [
        f"It watches for a crash: the lowest close of the last {bars_text(p['lowLook'], iv)} at least "
        f"{pct(float(p['ddMin']))} below the highest close of the last {bars_text(p['hiLook'], iv)}.",
        f"It does not buy the bottom. It waits until the price has bounced {pct(float(p['bounceMin']))} off that "
        f"low (on {who}) and then buys {mk}" + (f" ({100 / k:.0f} % of the money per coin)." if k > 1 else "."),
        f"It keeps that rebound purchase for {bars_text(p['holdBars'], iv)}"
        + (", or sells earlier if the price falls back under the low it bounced from." if p.get("stopAtLow", True)
           else "."),
    ]
    if int(p.get("coreSma") or 0):
        steps.append(f"Besides rebounds it holds the coin whenever its price is above its "
                     f"{bars_text(p['coreSma'], iv)} average, so it rides uptrends too.")
    return {
        "summary": f"Holds {mk} in uptrends and buys confirmed rebounds after crashes, before the trend average "
                   "turns up again.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "V-shaped recoveries after sharp crashes (it is back in weeks before a slow average re-enters) "
                      "and long bull markets.",
        "whenItLoses": "Dead-cat bounces in long bear markets: it buys a bounce that rolls over, and sideways "
                       "markets where the trend core whipsaws.",
    }
