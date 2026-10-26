"""optrep_a12 v1 (agent-12): synthetic call replication (option-based portfolio insurance).

Instead of a yes/no trend signal, hold the coin in the amount a trader would hold to replicate a rolling call
option on it (Black-Scholes delta, rate 0). The payoff is convex: when the coin rises after the option was struck
the delta goes to 1 (fully invested), when it falls it goes to 0 (euros), with a smooth, vol-aware ramp in between
and a fresh start at every roll. Per market, on its own candles:

- the calendar is cut into periods of ``tenor`` bars counted from the epoch (bar number = ts // bar length), so the
  roll dates never depend on where the data or a fold starts (not anchored);
- ``ladders`` = L staggered tranches: tranche i rolls ``i * tenor / L`` bars later than tranche 0, which removes the
  luck of one roll date; the weight is the tranches' average;
- at a tranche's first bar of a period the strike is set: K = ``strike`` x close;
- every bar: sigma = std of the last ``volLen`` log returns x ``volMult`` (per bar), tau = bars left in the period
  (tenor .. 1), d1 = (ln(S/K) + sigma^2 tau / 2) / (sigma sqrt(tau)), delta = N(d1);
- weight = floorWeight + (1 - floorWeight) x mean delta, rounded to multiples of ``step`` (fewer fee-paying
  rebalances).

A tranche is undecided until its first roll inside the data. A decision at bar t uses candles up to and including
bar t. Multi-market: maxWeight / len(markets) each.
"""
from __future__ import annotations

import math

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "optrep_a12"
VERSION = 1
TITLE = "Synthetic call replication (portfolio insurance)"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"tenor": 90, "strike": 1.0, "volLen": 30, "volMult": 1.0, "ladders": 3, "floorWeight": 0.0,
            "step": 0.1}


def param_space() -> dict:
    return {
        "tenor": {"type": "int", "min": 10, "max": 400, "log": True,
                  "description": "life of each replicated call option in candles (it is re-struck when it expires)"},
        "strike": {"type": "float", "min": 0.7, "max": 1.3,
                   "description": "strike as a multiple of the price at the roll (<1 in the money, >1 out of the money)"},
        "volLen": {"type": "int", "min": 5, "max": 200, "log": True,
                   "description": "candles of log returns behind the volatility estimate"},
        "volMult": {"type": "float", "min": 0.3, "max": 3.0, "log": True,
                    "description": "multiplier on the measured volatility (higher = smoother, more middling delta)"},
        "ladders": {"type": "int", "min": 1, "max": 12,
                    "description": "staggered option tranches with different roll dates, averaged"},
        "floorWeight": {"type": "float", "min": 0.05, "max": 0.6, "zero": True,
                        "description": "share always held, the option replication sizes the rest"},
        "step": {"type": "float", "min": 0.02, "max": 0.34,
                 "description": "round the weight to multiples of this (fewer small rebalances)"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["ladders"]) > int(p["tenor"]):
        return "ladders must not exceed tenor"
    return None


def warmup(p: dict) -> int:
    return int(p["volLen"]) + int(p["tenor"]) + 1


def _ncdf(x: np.ndarray) -> np.ndarray:
    out = np.full(x.shape, np.nan)
    ok = np.isfinite(x)
    erf = np.frompyfunc(math.erf, 1, 1)
    out[ok] = 0.5 * (1.0 + erf(x[ok] / math.sqrt(2.0)).astype(np.float64))
    return out


def _bar_ms(idx: np.ndarray) -> int:
    if len(idx) < 2:
        return 86_400_000
    d = np.diff(idx)
    return int(np.median(d[d > 0])) if (d > 0).any() else 86_400_000


def _rolling_std(r: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(r), np.nan)
    if len(r) < n or n < 2:
        return out
    cs = np.concatenate([[0.0], np.cumsum(r)])
    cs2 = np.concatenate([[0.0], np.cumsum(r * r)])
    s = cs[n:] - cs[:-n]
    s2 = cs2[n:] - cs2[:-n]
    var = np.maximum(s2 / n - (s / n) ** 2, 0.0) * n / (n - 1)
    out[n - 1:] = np.sqrt(var)
    return out


def weights(ts: np.ndarray, c: np.ndarray, p: dict, bar_ms: int) -> np.ndarray:
    """Target weight 0..1 per bar of one market (NaN = undecided)."""
    n = len(c)
    tenor, L = int(p["tenor"]), int(p["ladders"])
    k = float(p["strike"])
    vol_len = int(p["volLen"])
    vm = float(p["volMult"])
    floor = float(p.get("floorWeight") or 0.0)
    step = float(p["step"])
    r = np.full(n, np.nan)
    if n > 1:
        with np.errstate(divide="ignore", invalid="ignore"):
            r[1:] = np.log(c[1:] / c[:-1])
    # std over the last volLen returns (r[0] is NaN, so the first value lands at bar volLen)
    sig = np.full(n, np.nan)
    if n > 1:
        sig[1:] = _rolling_std(np.where(np.isfinite(r[1:]), r[1:], 0.0), vol_len)
    sig = np.maximum(sig * vm, 1e-6)
    g = (np.asarray(ts, dtype=np.int64) // int(bar_ms)).astype(np.int64)
    deltas = np.full((L, n), np.nan)
    for i in range(L):
        off = int(round(i * tenor / L))
        period = (g - off) // tenor
        pos = (g - off) - period * tenor          # 0 .. tenor-1 inside the period
        K = np.nan
        prev = None
        for t in range(n):
            if prev is not None and period[t] != prev:
                K = k * c[t]                      # struck at this close (first bar of a new period in the data)
            prev = period[t]
            if K != K or not np.isfinite(sig[t]) or not (c[t] > 0):
                continue
            tau = float(tenor - pos[t])
            sd = sig[t] * math.sqrt(tau)
            deltas[i, t] = (math.log(c[t] / K) + 0.5 * sd * sd) / sd
    d = _ncdf(deltas.ravel()).reshape(L, n)
    ok = np.isfinite(d).all(axis=0)
    out = np.full(n, np.nan)
    m = d[:, ok].mean(axis=0)
    w = floor + (1.0 - floor) * m
    w = np.clip(np.floor(w / step + 0.5) * step, 0.0, 1.0)
    out[ok] = w
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
        raise ValueError("optrep_a12 needs at least one market")
    idx = union_index(candles, markets)
    bar_ms = _bar_ms(idx)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        mi = np.asarray(df.index, dtype=np.int64)
        w = weights(mi, df["close"].to_numpy(np.float64), p, bar_ms)
        cols[m] = _asof(mi, w, idx) * each
    out = frame(idx, cols)
    if len(markets) > 1:
        any_ok = out.notna().any(axis=1).to_numpy()
        out = out.fillna(0.0)
        out[~any_ok] = np.nan
    return out


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    k = float(p["strike"])
    where = "at the price of that day" if abs(k - 1.0) < 1e-9 else (
        f"{pct(abs(k - 1.0))} {'above' if k > 1 else 'below'} the price of that day")
    steps = [
        f"It pretends to own a call option on {mk} that lasts {bars_text(p['tenor'], iv)} and pays off above a "
        f"strike set {where}; when the option expires a new one is started.",
        "It holds the amount of the coin that would copy that option's value (its delta): almost everything after "
        "the coin rose well above the strike, almost nothing after it fell well below, and a gradual amount in "
        "between that depends on the recent volatility "
        f"({bars_text(p['volLen'], iv)}) and on how long the option still runs.",
    ]
    if int(p["ladders"]) > 1:
        steps.append(f"It runs {int(p['ladders'])} such options with staggered start dates and averages them, so no "
                     "single start date decides.")
    fl = float(p.get("floorWeight") or 0.0)
    if fl > 0:
        steps.append(f"It always keeps {pct(fl)} of the slot in the coin; the option sizes the rest.")
    steps.append(f"The holding is rounded to steps of {pct(float(p['step']))} so it does not trade on tiny changes.")
    if len(spec.get("markets") or []) > 1:
        steps.append(f"Each of {mk} is handled on its own with an equal share of the money.")
    steps += risk_steps(spec)
    return {
        "summary": f"Sizes {mk} like a rolling call option: more of the coin as it climbs above the recent "
                   "starting price, less as it falls below, limiting losses in crashes.",
        "howItWorks": steps,
        "whenItWins": "Long rallies (it ends up fully invested) and deep crashes (it ends up mostly in euros).",
        "whenItLoses": "Choppy markets around the strike: it buys after rises and sells after falls, paying fees and "
                       "losing a little each swing (the cost of the insurance).",
    }
