"""kalman_core_a04 v1 (agent-04): a Kalman-filter trend core with a volatility-adaptive gain.

Every trend core in the fleet so far uses a fixed-length line (SMA/EMA/KAMA/regression). This family estimates the
trend with a local linear trend model on log price (state = level and slope per candle), filtered by a Kalman filter:

- measurement noise R_t: variance of 1-candle log returns, over ``volShort`` candles when ``adaptive`` (else over
  ``volLong``)
- slope noise Q_t = s2Long_t / span^4 (s2Long = variance over ``volLong`` candles); with a fixed R this is the
  Hodrick-Prescott / integrated-random-walk trend with a smoothing horizon of about ``span`` candles.
- adaptive: when short-term volatility jumps above its long-run level (a panic or a blow-off), R grows relative to Q,
  the gain drops and the filter treats the move as noise: it neither sells into a one-week crash nor chases a spike.
  adaptive=False is the fixed-gain ablation.

Signal (per market): t = slope / sqrt(P_slope), in when t > zIn, out when t < zOut (hysteresis, zOut <= zIn). There
is no "close above the line" signal: a local linear trend has no lag in a steady trend, so the filtered level sits on
the price and the residual is pure noise.

Several markets: each is gated on its own; its budget is 1/M (``equal``) or proportional to 1/volatility
(``invvol``, risk parity over the markets that have data). Uninvested budget stays in euros.
"""
from __future__ import annotations

import numpy as np

from ._base import aligned_close, bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "kalman_core_a04"
VERSION = 1
TITLE = "Kalman-filter trend core with a volatility-adaptive gain"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"span": 40, "zIn": 0.5, "zOut": 0.0, "adaptive": True, "volShort": 14, "volLong": 180,
            "weighting": "equal"}


def param_space() -> dict:
    return {
        "span": {"type": "int", "min": 5, "max": 250, "log": True,
                 "description": "smoothing horizon of the filtered trend in candles (slope noise = 1/span^4)"},
        "zIn": {"type": "float", "min": -1.0, "max": 4.0,
                "description": "buy when the slope t-stat (slope in standard errors) rises above this"},
        "zOut": {"type": "float", "min": -3.0, "max": 3.0,
                 "description": "sell when the slope t-stat falls below this (at most zIn)"},
        "adaptive": {"type": "bool",
                     "description": "measurement noise from short-term volatility (panics count as noise)"},
        "volShort": {"type": "int", "min": 3, "max": 60, "log": True,
                     "description": "candles in the short-term volatility (adaptive measurement noise)"},
        "volLong": {"type": "int", "min": 30, "max": 400, "log": True,
                    "description": "candles in the long-run volatility (trend noise and fixed measurement noise)"},
        "weighting": {"type": "choice", "values": ["equal", "invvol"],
                      "description": "budget per market with several markets: equal split or inverse volatility"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["zOut"]) > float(p["zIn"]):
        return "zOut must be at most zIn"
    if int(p["volShort"]) >= int(p["volLong"]):
        return "volShort must be shorter than volLong"
    return None


def warmup(p: dict) -> int:
    return int(p["volLong"]) + int(p["span"]) + 1


def _rolling_var(r: np.ndarray, n: int) -> np.ndarray:
    """population variance of r over the last n values (NaN in r = not yet listed); defined once n finite values."""
    out = np.full(len(r), np.nan)
    ok = np.isfinite(r)
    x = np.where(ok, r, 0.0)
    c1 = np.concatenate([[0.0], np.cumsum(x)])
    c2 = np.concatenate([[0.0], np.cumsum(x * x)])
    cn = np.concatenate([[0], np.cumsum(ok.astype(np.int64))])
    if len(r) >= n:
        s1 = c1[n:] - c1[:-n]
        s2 = c2[n:] - c2[:-n]
        k = cn[n:] - cn[:-n]
        m = s1 / n
        v = np.maximum(s2 / n - m * m, 0.0)
        out[n - 1:] = np.where(k == n, v, np.nan)
    return out


def kalman_signal(close: np.ndarray, p: dict) -> np.ndarray:
    """Slope t-stat series, NaN until the filter has run ``span`` candles."""
    n = len(close)
    span, vl, vs = int(p["span"]), int(p["volLong"]), int(p["volShort"])
    with np.errstate(invalid="ignore", divide="ignore"):
        z = np.log(close)
    r = np.full(n, np.nan)
    if n > 1:
        r[1:] = z[1:] - z[:-1]
    s2l = _rolling_var(r, vl)
    s2r = _rolling_var(r, vs) if p["adaptive"] else s2l
    floor = 1e-12
    qf = 1.0 / float(span) ** 4
    out = np.full(n, np.nan)
    started = -1
    lv = sl = 0.0
    p00 = p01 = p11 = 0.0
    for i in range(n):
        zi, a, b = z[i], s2l[i], s2r[i]
        if not (np.isfinite(zi) and np.isfinite(a) and np.isfinite(b)):
            if started >= 0:
                raise ValueError("gap in the inputs after the filter started")
            continue
        a, b = max(a, floor), max(b, floor)
        if started < 0:
            started = i
            lv, sl = zi, 0.0
            p00, p01, p11 = 100.0 * a, 0.0, 100.0 * a * qf * span * span
            continue
        # predict: F = [[1,1],[0,1]], Q = diag(0, qf*a)
        lv = lv + sl
        n00 = p00 + 2 * p01 + p11
        n01 = p01 + p11
        n11 = p11 + qf * a
        # update with measurement zi, noise b
        s = n00 + b
        k0, k1 = n00 / s, n01 / s
        y = zi - lv
        lv += k0 * y
        sl += k1 * y
        p00 = n00 - k0 * n00
        p01 = n01 - k0 * n01
        p11 = n11 - k1 * n01
        if i - started >= span:
            out[i] = sl / np.sqrt(max(p11, floor * 1e-6))
    return out


def gate(sig: np.ndarray, z_in: float, z_out: float) -> np.ndarray:
    out = np.full(len(sig), np.nan)
    state = None
    for i, v in enumerate(sig.tolist()):
        if v != v:
            continue
        if state is None:
            state = 1.0 if v > z_in else 0.0
        elif state == 1.0 and v < z_out:
            state = 0.0
        elif state == 0.0 and v > z_in:
            state = 1.0
        out[i] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    mw = max_weight(spec)
    on, vol = {}, {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        on[m] = gate(kalman_signal(c, p), float(p["zIn"]), float(p["zOut"]))
        r = np.full(len(c), np.nan)
        if len(c) > 1:
            with np.errstate(invalid="ignore", divide="ignore"):
                r[1:] = np.log(c[1:] / c[:-1])
        vol[m] = np.sqrt(_rolling_var(r, int(p["volLong"])))
    cols = {}
    if len(markets) == 1 or p["weighting"] == "equal":
        for m in markets:
            cols[m] = on[m] * (mw / len(markets))
    else:
        inv = {m: np.where(np.isfinite(on[m]) & (vol[m] > 0), 1.0 / vol[m], np.nan) for m in markets}
        tot = np.zeros(len(idx))
        for m in markets:
            tot += np.where(np.isfinite(inv[m]), inv[m], 0.0)
        for m in markets:
            with np.errstate(invalid="ignore", divide="ignore"):
                share = np.where(np.isfinite(inv[m]), inv[m] / tot, np.nan)
            w = on[m] * share * mw
            # a decided market whose volatility is undefined cannot happen (gate needs volLong); keep NaN safe
            cols[m] = w
        # before every market is decided the frame stays NaN only where that market is undecided
    df = frame(idx, cols)
    decided = df.notna().any(axis=1).to_numpy()
    if decided.any():
        first = int(np.argmax(decided))
        df.iloc[first:] = df.iloc[first:].fillna(0.0)
    return df


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    span = int(p["span"])
    steps = [f"It estimates the trend of {mk} with a Kalman filter: a running guess of the price level and its "
             f"daily slope that smooths over roughly {bars_text(span, iv)}."]
    if p["adaptive"]:
        steps.append(f"When the last {bars_text(int(p['volShort']), iv)} are much more volatile than usual, the "
                     "filter trusts each new price less, so a short panic or spike barely moves its trend estimate.")
    steps.append(f"It buys when the estimated slope is clearly positive (more than {p['zIn']:.2f} standard "
                 f"errors above zero) and sells when it falls below {p['zOut']:.2f} standard errors.")
    if len(spec.get("markets") or []) > 1:
        steps.append("Each coin gets its own part of the money: "
                     + ("an equal share." if p["weighting"] == "equal" else
                        "the calmer coin gets the bigger share (inverse volatility)."))
    return {
        "summary": f"Holds {mk} while a noise-aware trend estimate points up; short volatility bursts are treated as "
                   "noise.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long trends interrupted by brief crashes or spikes that reverse within days.",
        "whenItLoses": "Crashes that keep going: treating the first drop as noise sells later and lower.",
    }
