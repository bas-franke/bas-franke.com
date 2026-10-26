"""logit_core_a07 v1 (agent-07): an online ridge-logistic classifier over standard trend/dip/volatility features.

The fleet has hand-tuned dozens of single-signal rules (SMA cores, dips, vol gates) and found most of them are luck
once 50+ variants are tried (#475/#476). This family asks the opposite question: if a plain statistical model is
handed the usual features and learns their weights itself, on past data only, does it time BTC/ETH better than
holding?

Features at bar t (log price lc): 1/5/20/60-bar log returns, lc minus log SMA50 and SMA200, log(vol20/vol100) of
1-bar returns, lc minus log 180-bar max close. features="trend" keeps only the 20/60-bar returns and the two SMA
distances. Label of bar t: 1 when lc[t+horizon] > lc[t] (known only at bar t+horizon).

Every ``refit`` bars (a fixed schedule from the first bar, so it never depends on where a test window starts) the
model is refit at bar T on the samples t <= T - horizon (the last ``trainLen`` of them, or all with trainLen = 0),
features standardised with the training mean/std, L2 penalty ``l2`` (intercept unpenalised), Newton/IRLS. Until the
next refit it scores each new bar's features. Position: in when P(up) >= enter, out when P(up) < exit, otherwise
unchanged. NaN until the first fit with at least 150 samples.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "logit_core_a07"
VERSION = 1
TITLE = "Online logistic-regression timing model"
BOT_READY = False
MULTI_MARKET = False

MIN_TRAIN = 150


def default_params() -> dict:
    return {"horizon": 20, "trainLen": 0, "l2": 1.0, "enter": 0.55, "exit": 0.45, "refit": 21, "features": "all"}


def param_space() -> dict:
    return {
        "horizon": {"type": "int", "min": 3, "max": 90, "log": True,
                    "description": "candles ahead the model predicts (up or down)"},
        "trainLen": {"type": "int", "min": 200, "max": 2000, "log": True, "zero": True,
                     "description": "training window in candles (0 = all history so far)"},
        "l2": {"type": "float", "min": 0.01, "max": 100.0, "log": True,
               "description": "ridge penalty on the standardised feature weights"},
        "enter": {"type": "float", "min": 0.45, "max": 0.75,
                  "description": "buy when the predicted chance of a rise is at least this"},
        "exit": {"type": "float", "min": 0.25, "max": 0.6,
                 "description": "sell when the predicted chance of a rise falls below this"},
        "refit": {"type": "int", "min": 5, "max": 90, "log": True,
                  "description": "candles between refits"},
        "features": {"type": "choice", "values": ["all", "trend"],
                     "description": "feature set: all 8 or the 4 trend features"},
    }


def valid_params(p: dict) -> str | None:
    if p["exit"] > p["enter"]:
        return "exit must be <= enter"
    if p["trainLen"] and p["trainLen"] < MIN_TRAIN:
        return f"trainLen must be 0 or >= {MIN_TRAIN}"
    return None


def warmup(p: dict) -> int:
    return 200 + MIN_TRAIN + int(p["horizon"])


def features(c: np.ndarray, which: str = "all") -> np.ndarray:
    lc = np.log(c)
    r1 = lc - ind.shift(lc, 1)

    def ret(n):
        return lc - ind.shift(lc, n)

    cols = [ret(20), ret(60), lc - np.log(ind.sma(c, 50)), lc - np.log(ind.sma(c, 200))]
    if which == "all":
        v20, v100 = ind.std_pop(r1, 20), ind.std_pop(r1, 100)
        with np.errstate(divide="ignore", invalid="ignore"):
            vr = np.log(v20 / v100)
        cols += [r1, ret(5), vr, lc - np.log(ind.rolling_max(c, 180))]
    return np.column_stack(cols)


def fit_logit(X: np.ndarray, y: np.ndarray, l2: float, iters: int = 25) -> np.ndarray:
    """Ridge-logistic weights (intercept first, unpenalised) by Newton/IRLS."""
    n, k = X.shape
    A = np.column_stack([np.ones(n), X])
    w = np.zeros(k + 1)
    pen = np.full(k + 1, l2)
    pen[0] = 1e-4
    for _ in range(iters):
        z = np.clip(A @ w, -30, 30)
        p = 1.0 / (1.0 + np.exp(-z))
        g = A.T @ (p - y) + pen * w
        h = (A * (p * (1 - p))[:, None]).T @ A + np.diag(pen) + 1e-9 * np.eye(k + 1)
        step = np.linalg.solve(h, g)
        w -= step
        if np.max(np.abs(step)) < 1e-8:
            break
    return w


def probabilities(c: np.ndarray, p: dict) -> np.ndarray:
    H, refit, tl = int(p["horizon"]), int(p["refit"]), int(p["trainLen"])
    F = features(c, p["features"])
    lc = np.log(c)
    n = len(c)
    ok = np.isfinite(F).all(axis=1)
    y = np.full(n, np.nan)
    y[:n - H] = (lc[H:] > lc[:n - H]).astype(np.float64)
    prob = np.full(n, np.nan)
    model = None
    for T in range(n):
        if T % refit == 0:
            last = T - H                       # newest sample whose label is known at the close of T
            if last >= 0:
                lo = 0 if tl == 0 else max(0, last - tl + 1)
                idx = np.arange(lo, last + 1)
                idx = idx[ok[idx]]
                if len(idx) >= MIN_TRAIN:
                    X = F[idx]
                    mu, sd = X.mean(axis=0), X.std(axis=0)
                    sd[sd == 0] = 1.0
                    w = fit_logit((X - mu) / sd, y[idx], float(p["l2"]))
                    model = (mu, sd, w)
        if model is not None and ok[T]:
            mu, sd, w = model
            z = w[0] + ((F[T] - mu) / sd) @ w[1:]
            prob[T] = 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))
    return prob


def hysteresis(prob: np.ndarray, enter: float, exit_: float) -> np.ndarray:
    out = np.full(len(prob), np.nan)
    state = None
    for i, q in enumerate(prob.tolist()):
        if q != q:
            if state is not None:
                out[i] = state
            continue
        if state is None:
            state = 1.0 if q >= enter else 0.0
        elif state == 0.0 and q >= enter:
            state = 1.0
        elif state == 1.0 and q < exit_:
            state = 0.0
        out[i] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    on = hysteresis(probabilities(c, p), float(p["enter"]), float(p["exit"]))
    return frame(df.index, {m: on * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    feats = ("recent returns over 1 to 60 candles, the distance to the 50- and 200-candle averages, whether "
             "volatility is rising and how far the price is under its recent high") if p["features"] == "all" else \
        "returns over 20 and 60 candles and the distance to the 50- and 200-candle averages"
    tl = "all history so far" if not p["trainLen"] else f"the last {bars_text(p['trainLen'], iv)}"
    steps = [f"A small statistics model estimates the chance that {mk} is higher {bars_text(p['horizon'], iv)} "
             f"from now, from {feats}.",
             f"It learns how much each of these mattered from {tl}, only from the past, and relearns every "
             f"{bars_text(p['refit'], iv)}.",
             f"It buys when that chance is at least {p['enter']:.0%} and sells when it falls below {p['exit']:.0%}."]
    return {
        "summary": f"Lets a simple self-learning model decide when to hold {mk} and when to sit in euros.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "When the patterns of the recent past (trend, dips, volatility) keep working in the next months.",
        "whenItLoses": "When the market changes character: the model keeps trusting patterns that just stopped "
                       "working, and long bull markets teach it to hold through the next crash.",
    }
