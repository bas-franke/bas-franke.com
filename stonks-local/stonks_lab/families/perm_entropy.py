"""perm_entropy v1 (agent-19, trend lane): ordinal-pattern (permutation) entropy as a trend-quality filter.

Permutation entropy (Bandt & Pompe) looks only at the ORDER of consecutive closes: every bar t gives a pattern of the
last ``order`` closes (e.g. order 3: up-up, up-down, ...; 6 patterns). Over the last ``peLen`` bars it counts how
often each pattern occurred and takes the Shannon entropy, normalised to 0..1 (1 = every pattern equally often;
a random walk of prices gives ~0.967 for order 3 because monotone runs are likelier; lower = the path repeats a few
shapes, i.e. it is orderly). It ignores move sizes, so one crash day
does not dominate it (unlike volatility, kurtosis or an R2 fit).

Pre-holdout signal study (agent-19, 1d 2019-2025, forward 30 days): on BTC with order 3 over 60 days, the lowest
entropy quintile was followed by +13.3 % vs -1.7 % for the highest; inside the top 60-day-momentum tercile low-PE
days gave +16.3 % and high-PE days -5.6 % (ETH order 3/120 d: +15.7 vs -6.5). Year-by-year the sign held in about
5 of 7 years on BTC, less on ETH.

Knobs use orderliness = 1 - PE (0 = random, larger = more orderly; v2, so thresholds are not packed into 0.95-0.99).
State "orderly" with hysteresis: on when 1 - PE >= ordIn, off when 1 - PE < ordOut (ordOut <= ordIn).
- ``and_sma``: hold while the close is above SMA(smaLen) AND the path is orderly.
- ``or_sma``: hold while the close is above SMA(smaLen), or while the path is orderly AND the close is above its
  close smaLen bars ago (an orderly rise that has not reached the average yet).
- ``exit``: hold while above SMA(smaLen); a disorderly path (state off) only blocks NEW entries, an open position
  is kept until the close falls under the SMA (entry filter only).
``minHold`` keeps a new position at least that many bars. Each market uses its own candles and gets
maxWeight / len(markets) while held.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "perm_entropy"
VERSION = 2
TITLE = "Permutation-entropy trend quality"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"order": 3, "peLen": 60, "ordIn": 0.03, "ordOut": 0.015, "smaLen": 100, "mode": "and_sma", "minHold": 0}


def param_space() -> dict:
    return {
        "order": {"type": "choice", "values": [3, 4],
                  "description": "closes per ordinal pattern (3 = 6 patterns, 4 = 24 patterns)"},
        "peLen": {"type": "int", "min": 20, "max": 400, "log": True,
                  "description": "candles over which pattern frequencies are counted"},
        "ordIn": {"type": "float", "min": 0.005, "max": 0.15, "log": True, "zero": True,
                  "description": "path counts as orderly once 1 - entropy is at least this (0 = always orderly)"},
        "ordOut": {"type": "float", "min": 0.003, "max": 0.12, "log": True, "zero": True,
                   "description": "orderly state ends once 1 - entropy drops below this (<= ordIn)"},
        "smaLen": {"type": "int", "min": 10, "max": 400, "log": True,
                   "description": "SMA trend core length"},
        "mode": {"type": "choice", "values": ["and_sma", "or_sma", "exit"],
                 "description": "and_sma: SMA and orderly; or_sma: SMA or an orderly rise; exit: orderly only gates entries"},
        "minHold": {"type": "int", "min": 1, "max": 60, "zero": True, "log": True,
                    "description": "keep a new position at least this many candles (0 = off)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["ordOut"]) > float(p["ordIn"]):
        return "ordOut must not exceed ordIn"
    if int(p["peLen"]) < 4 * math.factorial(int(p["order"])):
        return "peLen too short for the number of patterns"
    return None


def warmup(p: dict) -> int:
    return max(int(p["peLen"]) + int(p["order"]) - 1, int(p["smaLen"]))


def perm_entropy(close: np.ndarray, order: int, n: int) -> np.ndarray:
    """Normalised permutation entropy of the ordinal patterns ending at bars t-n+1..t (NaN until enough bars)."""
    x = np.asarray(close, dtype=np.float64)
    m = len(x)
    out = np.full(m, np.nan)
    if m < n + order - 1:
        return out
    W = np.lib.stride_tricks.sliding_window_view(x, order)          # row i = pattern ending at bar i+order-1
    ranks = np.argsort(np.argsort(W, axis=1, kind="stable"), axis=1, kind="stable")
    code = (ranks * (order ** np.arange(order))).sum(axis=1)
    _, inv = np.unique(code, return_inverse=True)
    k = int(inv.max()) + 1
    onehot = np.zeros((len(inv), k))
    onehot[np.arange(len(inv)), inv] = 1.0
    cs = np.vstack([np.zeros((1, k)), np.cumsum(onehot, axis=0)])
    counts = cs[n:] - cs[:-n]                                         # row j = patterns j..j+n-1
    P = counts / n
    with np.errstate(divide="ignore", invalid="ignore"):
        H = -(np.where(P > 0, P * np.log(np.where(P > 0, P, 1.0)), 0.0)).sum(axis=1)
    H /= math.log(math.factorial(order))
    out[order - 1 + n - 1:] = H
    return out


def _held(close: np.ndarray, p: dict) -> np.ndarray:
    n = len(close)
    out = np.full(n, np.nan)
    sma_len = int(p["smaLen"])
    pe = perm_entropy(close, int(p["order"]), int(p["peLen"]))
    sma = ind.sma(close, sma_len)
    o_in, o_out = float(p["ordIn"]), float(p["ordOut"])
    mode = p.get("mode", "and_sma")
    min_hold = int(p.get("minHold") or 0)
    orderly = False
    held = False
    age = 0
    for t in range(n):
        if np.isnan(pe[t]) or np.isnan(sma[t]):
            continue
        if orderly:
            if 1.0 - pe[t] < o_out:
                orderly = False
        elif 1.0 - pe[t] >= o_in:
            orderly = True
        above = close[t] > sma[t]
        if mode == "and_sma":
            want = above and orderly
        elif mode == "or_sma":
            want = above or (orderly and t >= sma_len and close[t] > close[t - sma_len])
        else:
            want = above and (held or orderly)
        if held and not want and min_hold and age < min_hold:
            want = True
        if want and not held:
            age = 0
        held = want
        age += 1
        out[t] = 1.0 if held else 0.0
    return out


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = np.asarray(values, dtype=np.float64)[pos[ok]]
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
    mode = p.get("mode", "and_sma")
    look = bars_text(p["peLen"], iv)
    orderly = (f"the up/down pattern of the last {look} is orderly (the order of every {int(p['order'])} closes in a "
               f"row repeats a few shapes instead of looking random; orderliness {float(p['ordIn']):.3f} or more "
               f"to start, under {float(p['ordOut']):.3f} ends it)")
    avg = f"its average of the last {bars_text(p['smaLen'], iv)}"
    if mode == "and_sma":
        rule = f"It holds {mk} while the price is above {avg} and {orderly}."
    elif mode == "or_sma":
        rule = (f"It holds {mk} while the price is above {avg}, and also below it while {orderly} and the price is "
                f"higher than {bars_text(p['smaLen'], iv)} ago.")
    else:
        rule = (f"It holds {mk} while the price is above {avg}, but only buys when {orderly}; once in, it sells "
                "only when the price drops under the average.")
    steps = [rule + (f" ({100 / k:.0f} % of the money per coin.)" if k > 1 else "")]
    mh = int(p.get("minHold") or 0)
    if mh:
        steps.append(f"After buying it keeps the position at least {bars_text(mh, iv)}.")
    return {
        "summary": f"A trend follower on {mk} that only trusts a trend while the day-to-day ups and downs look "
                   "orderly rather than random.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Steady, orderly rallies, and choppy tops where the pattern turns random before the price "
                      "breaks.",
        "whenItLoses": "Volatile but strong bull legs (they look disorderly) and crashes that start from an orderly "
                       "rise.",
    }
