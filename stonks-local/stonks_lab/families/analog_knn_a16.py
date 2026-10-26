"""analog_knn_a16 v1 (agent-16): k-nearest-neighbour analog forecasting ("what happened after days like today?").

Idea: chartists say "this looks like 2019 again". Make that literal and honest: describe every candle by a few
scale-free features, find the ``k`` past candles that looked most like today, and hold while their average forward
return was good.

- features at bar t (``feats``):
    "mom"     : log returns over 5, 20 and 60 candles;
    "mom_vol" : those three plus log(20-candle vol / 120-candle vol);
    "trend"   : log(close / SMA 50), log(close / SMA 200) and the 20-candle log return;
- every feature is z-scored with its expanding mean/std up to bar t (no future data);
- the library holds every earlier bar s whose forward return is already known at t (s + ``horizon`` <= t) and at
  least ``minLib`` such bars must exist; ``memory`` > 0 keeps only the most recent ``memory`` of them;
- forecast_t = mean forward ``horizon``-candle log return of the ``k`` nearest library bars (Euclidean distance),
  minus the mean forward return of the whole library when ``relative`` is on (then it measures "better than usual");
- hold when forecast >= ``enter``, sell when it drops below ``exit`` (hysteresis, exit <= enter).

Multi-market: each market gets maxWeight / len(markets) with its own library.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "analog_knn_a16"
VERSION = 1
TITLE = "Analog days (nearest neighbours)"
BOT_READY = False
MULTI_MARKET = True
ANCHORED = False

LONGEST = {"mom": 60, "mom_vol": 120, "trend": 200}


def default_params() -> dict:
    return {"k": 30, "horizon": 20, "feats": "mom_vol", "minLib": 250, "memory": 0, "relative": True,
            "enter": 0.0, "exit": 0.0}


def param_space() -> dict:
    return {
        "k": {"type": "int", "min": 3, "max": 150, "log": True, "description": "number of most similar past candles"},
        "horizon": {"type": "int", "min": 3, "max": 90, "log": True,
                    "description": "forward return horizon (candles) looked at after each similar candle"},
        "feats": {"type": "choice", "values": ["mom", "mom_vol", "trend"], "description": "how a candle is described"},
        "minLib": {"type": "int", "min": 100, "max": 500, "log": True,
                   "description": "past candles with a known outcome needed before it decides"},
        "memory": {"type": "int", "min": 200, "max": 2000, "zero": True, "log": True,
                   "description": "only search the most recent N past candles (0 = all history)"},
        "relative": {"type": "bool", "description": "compare the neighbours' outcome with the average outcome"},
        "enter": {"type": "float", "min": -0.05, "max": 0.05, "description": "buy when the forecast is at least this"},
        "exit": {"type": "float", "min": -0.08, "max": 0.05, "description": "sell when the forecast is below this"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["exit"]) > float(p["enter"]):
        return "exit must be at most enter"
    if int(p.get("memory") or 0) and int(p["memory"]) < int(p["minLib"]):
        return "memory must be at least minLib"
    if int(p["minLib"]) < int(p["k"]) * 2:
        return "minLib must be at least 2 x k"
    return None


def warmup(p: dict) -> int:
    return LONGEST[p.get("feats", "mom_vol")] + int(p["minLib"]) + int(p["horizon"]) + 1


def lag_ret(lc: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(lc), np.nan)
    out[n:] = lc[n:] - lc[:-n]
    return out


def features(c: np.ndarray, kind: str) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        lc = np.log(c)
        if kind in ("mom", "mom_vol"):
            cols = [lag_ret(lc, 5), lag_ret(lc, 20), lag_ret(lc, 60)]
            if kind == "mom_vol":
                r1 = lag_ret(lc, 1)
                cols.append(np.log(ind.std_pop(r1, 20) / ind.std_pop(r1, 120)))
        elif kind == "trend":
            cols = [lc - np.log(ind.sma(c, 50)), lc - np.log(ind.sma(c, 200)), lag_ret(lc, 20)]
        else:
            raise ValueError(f"unknown feats {kind!r}")
    X = np.column_stack(cols)
    X[~np.isfinite(X)] = np.nan
    return X


def forecast(c: np.ndarray, p: dict) -> np.ndarray:
    k, H, min_lib = int(p["k"]), int(p["horizon"]), int(p["minLib"])
    memory, relative = int(p.get("memory") or 0), bool(p.get("relative", True))
    X = features(c, p.get("feats", "mom_vol"))
    T = len(c)
    with np.errstate(divide="ignore", invalid="ignore"):
        lc = np.log(c)
    fwd = np.full(T, np.nan)
    fwd[:T - H] = lc[H:] - lc[:T - H]                       # outcome of bar s, known from bar s + H on
    ok = np.isfinite(X).all(axis=1)
    # expanding mean/std of the features (only rows decided so far)
    Xz = np.where(ok[:, None], X, 0.0)
    n = np.cumsum(ok)
    s1 = np.cumsum(Xz, axis=0)
    s2 = np.cumsum(Xz * Xz, axis=0)
    out = np.full(T, np.nan)
    for t in range(T):
        if not ok[t] or n[t] < 2:
            continue
        last = t - H                                        # newest library bar with a known outcome
        if last < 0:
            continue
        lib = np.flatnonzero(ok[: last + 1] & np.isfinite(fwd[: last + 1]))
        if memory > 0:
            lib = lib[-memory:]
        if len(lib) < min_lib:
            continue
        mu = s1[t] / n[t]
        sd = np.sqrt(np.maximum(s2[t] / n[t] - mu * mu, 1e-18))
        d = (((X[lib] - X[t]) / sd) ** 2).sum(axis=1)
        nn = np.argpartition(d, k - 1)[:k] if k < len(lib) else np.arange(len(lib))
        f = float(fwd[lib[nn]].mean())
        if relative:
            f -= float(fwd[lib].mean())
        out[t] = f
    return out


def hysteresis(sig: np.ndarray, enter: float, exit_: float) -> np.ndarray:
    out = np.full(len(sig), np.nan)
    state = 0.0
    for i, s in enumerate(sig):
        if not np.isfinite(s):
            continue
        if state == 0.0 and s >= enter:
            state = 1.0
        elif state == 1.0 and s < exit_:
            state = 0.0
        out[i] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("analog_knn_a16 needs at least one market")
    idx = union_index(candles, markets)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        cols[m] = hysteresis(forecast(c, p), float(p["enter"]), float(p["exit"])) * each
    df = frame(idx, cols)
    if len(markets) > 1:
        any_ok = df.notna().any(axis=1).to_numpy()
        df = df.fillna(0.0)
        df[~any_ok] = np.nan
    return df


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    what = {"mom": "its returns over the last 5, 20 and 60 candles",
            "mom_vol": "its returns over the last 5, 20 and 60 candles and whether volatility is rising or falling",
            "trend": "how far the price sits above or below its 50- and 200-candle averages and its 20-candle return"}
    rel = " compared with what usually followed any candle" if p.get("relative", True) else ""
    steps = [
        f"After every {iv} candle it describes the market by {what[p.get('feats', 'mom_vol')]}.",
        f"It looks up the {p['k']} past candles that looked most alike"
        + (f" within the last {bars_text(p['memory'], iv)}" if int(p.get("memory") or 0) else "")
        + f" and checks how the price moved over the {bars_text(p['horizon'], iv)} after each of them{rel}.",
        f"It holds while that average outcome is at least {pct(p['enter'])} and sells when it drops below "
        f"{pct(p['exit'])}.",
    ]
    if len(spec.get("markets") or []) > 1:
        steps.append(f"The money is split evenly between {mk}.")
    return {
        "summary": f"Holds {mk} when the most similar moments in its own history were followed by gains.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Markets that repeat their own patterns, e.g. a rally that looks like earlier rallies that kept "
                      "going.",
        "whenItLoses": "New kinds of market the history has never seen, and noisy patterns where the nearest "
                       "neighbours are similar only by chance.",
    }
