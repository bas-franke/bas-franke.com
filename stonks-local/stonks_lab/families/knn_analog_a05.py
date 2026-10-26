"""knn_analog_a05 v1 (agent-05): online k-nearest-neighbour analog forecasting ("history rhymes").

At every bar t it describes the market by a small feature vector, finds the k past bars whose features were most
similar, and looks at what happened *after* those analogs:

- features (each scaled by the trailing volatility of log returns over ``volLen`` bars, so calm and wild eras are
  comparable): log return over look/4, look and 3*look bars; with ``features = "ret_trend"`` also the log distance to
  SMA(3*look) and the log ratio of short to long volatility;
- features are standardised by the mean / sd of all *past* feature rows (expanding, no look-ahead);
- candidate analogs are bars s whose forward window is already over at t (s + horizon <= t), so their forward
  return log(close[s+horizon]/close[s]) is known at t;
- forecast z = (mean forward return of the k nearest analogs - mean forward return of all candidates)
  / (sd of all candidates / sqrt(k)): how unusual the analogs' outcome is, in standard errors;
- hold while z > ``thr`` (enter) and until z < ``thr - band`` (exit); optional SMA core combined with "and" (hold only
  when both agree) or "or" (hold when either says hold).

Needs ``minHist`` candidate rows before the first decision. Single market.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "knn_analog_a05"
VERSION = 1
TITLE = "Nearest-neighbour analog forecast"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"horizon": 10, "k": 30, "look": 20, "volLen": 60, "features": "ret_trend", "thr": 0.0, "band": 0.0,
            "minHist": 300, "coreSma": 0, "combine": "and"}


def param_space() -> dict:
    return {
        "horizon": {"type": "int", "min": 2, "max": 90, "log": True,
                    "description": "forward window (candles) whose outcome the analogs vote on"},
        "k": {"type": "int", "min": 5, "max": 200, "log": True, "description": "number of nearest analogs"},
        "look": {"type": "int", "min": 4, "max": 60, "log": True,
                 "description": "middle return lookback; the short one is look/4, the long one 3*look"},
        "volLen": {"type": "int", "min": 20, "max": 250, "log": True,
                   "description": "candles in the volatility used to scale the features"},
        "features": {"type": "choice", "values": ["ret", "ret_trend"],
                     "description": "returns only, or returns plus SMA distance and volatility ratio"},
        "thr": {"type": "float", "min": -3.0, "max": 2.0,
                "description": "hold while the analogs' forward return is this many standard errors above normal"},
        "band": {"type": "float", "min": 0.0, "max": 2.0,
                 "description": "hysteresis: exit only when the forecast falls band below thr"},
        "minHist": {"type": "int", "min": 150, "max": 1000, "log": True,
                    "description": "past analog candidates needed before the first decision"},
        "coreSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                    "description": "optional SMA trend core (0 = off)"},
        "combine": {"type": "choice", "values": ["and", "or"],
                    "description": "with a core: hold when both agree (and) or when either says hold (or)"},
    }


def valid_params(p) -> str | None:
    if int(p["k"]) * 3 > int(p["minHist"]):
        return "minHist must be at least 3*k"
    return None


def warmup(p: dict) -> int:
    return 3 * int(p["look"]) + int(p["volLen"]) + int(p["horizon"]) + int(p["minHist"])


def features(c: np.ndarray, p: dict) -> np.ndarray:
    n = len(c)
    lr = np.full(n, np.nan)
    lr[1:] = np.log(c[1:] / c[:-1])
    vl = int(p["volLen"])
    vol = np.full(n, np.nan)
    if n > vl:
        vol[vl:] = ind.std_pop(lr[1:], vl)[vl - 1:]
    look = int(p["look"])

    def ret(k):
        x = np.full(n, np.nan)
        if n > k:
            x[k:] = np.log(c[k:] / c[:-k])
        return x

    cols = []
    for k in (max(1, look // 4), look, 3 * look):
        with np.errstate(divide="ignore", invalid="ignore"):
            cols.append(ret(k) / (vol * np.sqrt(k)))
    if p["features"] == "ret_trend":
        sm = ind.sma(c, 3 * look)
        sv = np.full(n, np.nan)
        sl = max(5, look // 2)
        if n > sl:
            sv[sl:] = ind.std_pop(lr[1:], sl)[sl - 1:]
        with np.errstate(divide="ignore", invalid="ignore"):
            cols.append(np.log(c / sm) / (vol * np.sqrt(3 * look)))
            cols.append(np.log(sv / vol))
    return np.column_stack(cols)


def forecast_z(c: np.ndarray, p: dict) -> np.ndarray:
    """z-score of the k nearest analogs' forward return at every bar (NaN until enough history)."""
    n = len(c)
    H, K, mh = int(p["horizon"]), int(p["k"]), int(p["minHist"])
    f = features(c, p)
    fwd = np.full(n, np.nan)
    if n > H:
        fwd[:-H] = np.log(c[H:] / c[:-H])
    ok = np.isfinite(f).all(axis=1)
    out = np.full(n, np.nan)
    for t in range(n):
        if not ok[t] or t - H < 0:
            continue
        cand = np.flatnonzero(ok[: t - H + 1])
        if len(cand) < mh:
            continue
        X = f[cand]
        mu, sd = X.mean(axis=0), X.std(axis=0) + 1e-12
        d = (((X - f[t]) / sd) ** 2).sum(axis=1)
        nn = cand[np.argpartition(d, K - 1)[:K]] if K < len(cand) else cand
        y = fwd[cand]
        s_all = y.std()
        if not s_all > 0:
            continue
        out[t] = (fwd[nn].mean() - y.mean()) / (s_all / np.sqrt(len(nn)))
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    z = forecast_z(c, p)
    thr, band = float(p["thr"]), float(p["band"])
    sig = np.full(len(c), np.nan)
    s = 0.0
    for i in range(len(c)):
        if not np.isfinite(z[i]):
            continue
        if s == 0.0 and z[i] > thr:
            s = 1.0
        elif s == 1.0 and z[i] < thr - band:
            s = 0.0
        sig[i] = s
    core_len = int(p.get("coreSma") or 0)
    if core_len > 0:
        sm = ind.sma(c, core_len)
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
        both = np.isfinite(core) & np.isfinite(sig)
        comb = np.minimum(sig, core) if p["combine"] == "and" else np.maximum(sig, core)
        sig = np.where(both, comb, np.nan)
    w = np.where(np.isfinite(c), sig * max_weight(spec), np.nan)
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    look = int(p["look"])
    steps = [
        f"After every {iv} candle it summarises {mk}'s recent path: the returns over the last "
        f"{bars_text(max(1, look // 4), iv)}, {bars_text(look, iv)} and {bars_text(3 * look, iv)}"
        + (", how far the price is from its average and whether volatility is rising" if p["features"] == "ret_trend"
           else "") + ", all measured relative to how volatile the coin has been.",
        f"It searches the coin's own past for the {p['k']} moments that looked most alike and checks what the price "
        f"did in the {bars_text(int(p['horizon']), iv)} after each of them (only moments whose outcome is already known).",
        f"When those look-alikes went up clearly more than usual (score above {p['thr']}) it holds {mk}; when the "
        f"score drops below {float(p['thr']) - float(p['band']):.2f} it sells to euros.",
    ]
    if p.get("coreSma"):
        steps.append(("It holds only when the price is also above" if p["combine"] == "and" else
                      "It also holds whenever the price is above")
                     + f" its {bars_text(int(p['coreSma']), iv)} average.")
    return {
        "summary": f"Holds {mk} when similar-looking moments in its own history were usually followed by gains.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "If market patterns repeat: the analogs of a healthy rally keep it invested and the analogs of a "
                      "breakdown take it out early.",
        "whenItLoses": "When history does not rhyme: crypto has only a few cycles, so the analogs are few and noisy, and "
                       "every false switch costs fees.",
    }
