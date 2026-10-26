"""hmm_regime v1 (agent-14): an online two-state hidden Markov model on the coin's own returns.

Nobody in the fleet has tried a statistical regime *model* (all regimes so far are hand-made thresholds). This family
fits a two-state Gaussian hidden Markov model (states differ in mean and variance of the bar's log return, with
sticky transitions) by EM (Baum-Welch) on past data only, and holds the coin while the filtered probability of the
"bull" state is high.

- x_t = ln(close_t / close_{t-retBars}) / retBars (retBars > 1 smooths; the model then sees overlapping returns).
- Fit window: the last ``fitLen`` returns ending at bar t ("rolling") or every return since the data start
  ("expanding"). The model is refitted at the first bar with ``fitLen`` returns and then every ``refit`` bars
  (counted from that first fit, so truncating the data at the end never changes earlier fits). Each fit warm-starts
  from the previous one (first fit: a fixed calm/stormy start), ``iters`` EM steps, variances floored at 5 % of the
  window variance.
- Between refits the last fitted model is run forward one bar at a time (the filter: P(state_t | x up to t)),
  which uses bar t's return only.
- "bull" = the state with the higher mean (label "mean") or the lower variance (label "lowvol").
- Hold (maxWeight) once P(bull) >= enter, sell once it falls under exit (exit <= enter: hysteresis).
Every market in the spec is modelled on its own candles and gets maxWeight / len(markets) while held.
A decision at bar t uses candles up to and including t only.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "hmm_regime"
VERSION = 1
TITLE = "Hidden Markov regime filter (two-state model of returns)"
BOT_READY = False
MULTI_MARKET = True

_LOG2PI = math.log(2.0 * math.pi)


def default_params() -> dict:
    return {"fitLen": 500, "fitMode": "rolling", "refit": 20, "retBars": 1, "label": "mean",
            "enter": 0.6, "exit": 0.4, "iters": 10}


def param_space() -> dict:
    return {
        "fitLen": {"type": "int", "min": 120, "max": 1500, "log": True,
                   "description": "returns in the fit window (and the first fit's minimum history)"},
        "fitMode": {"type": "choice", "values": ["rolling", "expanding"],
                    "description": "fit on the last fitLen returns, or on every return since the data start"},
        "refit": {"type": "int", "min": 5, "max": 120, "log": True,
                  "description": "refit the model every this many candles; in between it only filters"},
        "retBars": {"type": "int", "min": 1, "max": 10,
                    "description": "model the average log return over this many candles (1 = one-candle returns)"},
        "label": {"type": "choice", "values": ["mean", "lowvol"],
                  "description": "which state counts as bull: the higher-mean state or the calmer state"},
        "enter": {"type": "float", "min": 0.3, "max": 0.95,
                  "description": "buy once the filtered bull probability is at least this"},
        "exit": {"type": "float", "min": 0.05, "max": 0.9,
                 "description": "sell once the filtered bull probability falls under this"},
        "iters": {"type": "int", "min": 3, "max": 30,
                  "description": "EM steps per refit (warm-started from the previous fit)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["exit"]) > float(p["enter"]):
        return "exit must be <= enter"
    return None


def warmup(p: dict) -> int:
    return int(p["fitLen"]) + int(p["retBars"])


# --------------------------------------------------------------------------------------------- HMM core

def _emis(x: np.ndarray, mu, var) -> tuple[np.ndarray, np.ndarray]:
    b0 = np.exp(-0.5 * (_LOG2PI + math.log(var[0]) + (x - mu[0]) ** 2 / var[0]))
    b1 = np.exp(-0.5 * (_LOG2PI + math.log(var[1]) + (x - mu[1]) ** 2 / var[1]))
    return np.maximum(b0, 1e-300), np.maximum(b1, 1e-300)


def _forward(b0, b1, A, pi):
    n = len(b0)
    a0 = np.empty(n)
    a1 = np.empty(n)
    c = np.empty(n)
    a00, a01, a10, a11 = A
    p0, p1 = pi[0] * b0[0], pi[1] * b1[0]
    s = p0 + p1
    a0[0], a1[0], c[0] = p0 / s, p1 / s, s
    f0, f1 = a0[0], a1[0]
    B0 = b0.tolist()
    B1 = b1.tolist()
    for t in range(1, n):
        p0 = (f0 * a00 + f1 * a10) * B0[t]
        p1 = (f0 * a01 + f1 * a11) * B1[t]
        s = p0 + p1
        f0, f1 = p0 / s, p1 / s
        a0[t], a1[t], c[t] = f0, f1, s
    return a0, a1, c


def _backward(b0, b1, A, c):
    n = len(b0)
    be0 = np.empty(n)
    be1 = np.empty(n)
    be0[-1] = be1[-1] = 1.0
    a00, a01, a10, a11 = A
    B0 = b0.tolist()
    B1 = b1.tolist()
    C = c.tolist()
    g0 = g1 = 1.0
    for t in range(n - 2, -1, -1):
        u0 = B0[t + 1] * g0
        u1 = B1[t + 1] * g1
        k = C[t + 1]
        g0 = (a00 * u0 + a01 * u1) / k
        g1 = (a10 * u0 + a11 * u1) / k
        be0[t], be1[t] = g0, g1
    return be0, be1


def _fit(x: np.ndarray, model, iters: int):
    """EM on x from ``model`` = (mu, var, A, pi); returns the new model and the filtered P(state 0/1) at the end."""
    mu, var, A, pi = model
    vfloor = max(float(np.var(x)) * 0.05, 1e-12)
    for _ in range(iters):
        b0, b1 = _emis(x, mu, var)
        a0, a1, c = _forward(b0, b1, A, pi)
        be0, be1 = _backward(b0, b1, A, c)
        g0 = a0 * be0
        g1 = a1 * be1
        s = g0 + g1
        g0, g1 = g0 / s, g1 / s
        # expected transitions
        k = c[1:]
        x00 = float(np.sum(a0[:-1] * A[0] * b0[1:] * be0[1:] / k))
        x01 = float(np.sum(a0[:-1] * A[1] * b1[1:] * be1[1:] / k))
        x10 = float(np.sum(a1[:-1] * A[2] * b0[1:] * be0[1:] / k))
        x11 = float(np.sum(a1[:-1] * A[3] * b1[1:] * be1[1:] / k))
        r0, r1 = x00 + x01, x10 + x11
        if r0 > 0 and r1 > 0:
            A = (max(x00 / r0, 1e-6), max(x01 / r0, 1e-6), max(x10 / r1, 1e-6), max(x11 / r1, 1e-6))
            A = (A[0] / (A[0] + A[1]), A[1] / (A[0] + A[1]), A[2] / (A[2] + A[3]), A[3] / (A[2] + A[3]))
        w0, w1 = float(g0.sum()), float(g1.sum())
        if w0 > 1e-9 and w1 > 1e-9:
            m0, m1 = float(np.dot(g0, x) / w0), float(np.dot(g1, x) / w1)
            v0 = float(np.dot(g0, (x - m0) ** 2) / w0)
            v1 = float(np.dot(g1, (x - m1) ** 2) / w1)
            mu, var = (m0, m1), (max(v0, vfloor), max(v1, vfloor))
        pi = (min(max(float(g0[0]), 1e-6), 1 - 1e-6), 0.0)
        pi = (pi[0], 1.0 - pi[0])
    b0, b1 = _emis(x, mu, var)
    a0, a1, _ = _forward(b0, b1, A, pi)
    return (mu, var, A, pi), (float(a0[-1]), float(a1[-1]))


def _start_model(x: np.ndarray):
    m = float(np.mean(x))
    v = max(float(np.var(x)), 1e-12)
    return ((m + 0.1 * math.sqrt(v), m - 0.1 * math.sqrt(v)), (0.5 * v, 2.0 * v),
            (0.95, 0.05, 0.05, 0.95), (0.5, 0.5))


def bull_prob(close: np.ndarray, p: dict) -> np.ndarray:
    """Filtered P(bull) per bar (NaN before the first fit). Uses only closes up to each bar."""
    n = len(close)
    k = int(p["retBars"])
    fit_len, refit, iters = int(p["fitLen"]), int(p["refit"]), int(p["iters"])
    expanding = p["fitMode"] == "expanding"
    lc = np.log(close)
    x = np.full(n, np.nan)
    if n > k:
        x[k:] = (lc[k:] - lc[:-k]) / k
    out = np.full(n, np.nan)
    finite = np.isfinite(x)
    if not finite.any():
        return out
    first = int(np.argmax(finite))            # first bar with a return
    # bars with a NaN return after the first one (missing closes) are skipped by the filter
    model = None
    filt = None
    first_fit = first + fit_len - 1
    for i in range(first_fit, n):
        if (i - first_fit) % refit == 0:
            lo = first if expanding else i - fit_len + 1
            xs = x[lo:i + 1]
            xs = xs[np.isfinite(xs)]
            if len(xs) < 20:
                continue
            start = model if model is not None else _start_model(xs)
            model, filt = _fit(xs, start, iters * (3 if model is None else 1))
        elif model is not None and np.isfinite(x[i]):
            mu, var, A, _ = model
            q0 = filt[0] * A[0] + filt[1] * A[2]
            q1 = filt[0] * A[1] + filt[1] * A[3]
            e0 = q0 * math.exp(-0.5 * (math.log(var[0]) + (x[i] - mu[0]) ** 2 / var[0]))
            e1 = q1 * math.exp(-0.5 * (math.log(var[1]) + (x[i] - mu[1]) ** 2 / var[1]))
            s = e0 + e1
            filt = (e0 / s, e1 / s) if s > 0 else (q0, q1)
        if model is None:
            continue
        mu, var, _, _ = model
        if p["label"] == "mean":
            bull = 0 if mu[0] >= mu[1] else 1
        else:
            bull = 0 if var[0] <= var[1] else 1
        out[i] = filt[bull]
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    mw = max_weight(spec) / len(markets)
    enter, exit_ = float(p["enter"]), float(p["exit"])
    cols = {}
    for m in markets:
        df = candles[m]
        own = bull_prob(df["close"].to_numpy(np.float64), p)
        w = np.full(len(own), np.nan)
        held = False
        for i, q in enumerate(own):
            if not np.isfinite(q):
                continue
            if held and q < exit_:
                held = False
            elif not held and q >= enter:
                held = True
            w[i] = mw if held else 0.0
        s = np.asarray(df.index, dtype=np.int64)
        cols[m] = pd.Series(w, index=s).reindex(idx).ffill().to_numpy(np.float64)
    return frame(idx, cols)


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    k = int(p["retBars"])
    ret = "each candle's return" if k == 1 else f"the average return over {bars_text(k, iv)}"
    win = (f"the last {bars_text(int(p['fitLen']), iv)}" if p["fitMode"] == "rolling"
           else "all history so far")
    bull = "the state with the higher average return" if p["label"] == "mean" else "the calmer state"
    steps = [
        f"It models {mk} as switching between two hidden market states that differ in the average size and "
        f"spread of {ret}, and that tend to persist.",
        f"Every {bars_text(int(p['refit']), iv)} it re-estimates that model from {win} (statistics only, no future "
        "data); in between it updates, candle by candle, how likely it is that the market is now in each state.",
        f"The 'bull' state is {bull}. It buys once the bull probability reaches {pct(float(p['enter']))} and sells "
        f"once it drops under {pct(float(p['exit']))}.",
    ]
    return {
        "summary": f"A statistical regime switch on {mk}: in while a two-state model of recent returns says the "
                   "calm/rising state is likely, out when it says the stormy/falling state took over.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bear markets with a clear change in return behaviour (it steps aside after the regime "
                      "shifts) and long calm bull runs.",
        "whenItLoses": "Fast V-shaped recoveries and volatile bull runs: the model needs several candles of evidence "
                       "before it changes its mind, and a volatile rally can look like the stormy state.",
    }
