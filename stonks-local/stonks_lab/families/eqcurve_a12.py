"""eqcurve_a12 v1 (agent-12): equity-curve filter / strategy selection between an SMA core and buy and hold.

Every SMA core on BTC/ETH loses to holding mainly through whipsaw in bull and recovery folds (#373, #453), and wins
in bears. Instead of tuning the core's own signal, this family watches how the core has been *doing* and only trusts
it while it works. Per market, on its own candles:

- core s_t = 1 while close_t > SMA(coreLen)_t, else 0 (the "shadow" strategy, traded on paper);
- shadow log return g_t = s_{t-1} * ln(c_t / c_{t-1}) - 0.0025 * |s_t - s_{t-1}| (a taker fee per switch),
  hold log return h_t = ln(c_t / c_{t-1}); E = cumulative g, H = cumulative h;
- mode "filter": the core is trusted while E_t >= SMA(E, eqLen)_t - margin (the classic equity-curve filter);
- mode "select": the core is trusted once its last-eqLen-bar log return beats hold's by more than margin and
  distrusted once it trails hold's by more than margin (hysteresis; starts distrusted);
- trusted: position = s_t; not trusted: ``fallback`` ("hold" = fully invested, "cash" = out).

Only differences of E/H over windows are used, so the result does not depend on where the data starts (not
anchored). A decision at bar t uses candles up to and including bar t. Multi-market: maxWeight / len(markets) each.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "eqcurve_a12"
VERSION = 1
TITLE = "Equity-curve filter on a trend core"
BOT_READY = False
MULTI_MARKET = True
FEE = 0.0025


def default_params() -> dict:
    return {"coreLen": 100, "eqLen": 60, "mode": "select", "margin": 0.0, "fallback": "hold"}


def param_space() -> dict:
    return {
        "coreLen": {"type": "int", "min": 10, "max": 400, "log": True,
                    "description": "candles in the SMA of the shadow trend core (hold while close > SMA)"},
        "eqLen": {"type": "int", "min": 5, "max": 500, "log": True,
                  "description": "filter: SMA length of the core's equity curve; select: comparison window vs hold"},
        "mode": {"type": "choice", "values": ["filter", "select"],
                 "description": "filter = trust the core while its equity is above its own average; select = while "
                                "it beat buy and hold over the window"},
        "margin": {"type": "float", "min": 0.01, "max": 0.4, "log": True, "zero": True,
                   "description": "log-return margin (filter: allowed shortfall under the average; select: "
                                  "hysteresis band around zero)"},
        "fallback": {"type": "choice", "values": ["hold", "cash"],
                     "description": "position while the core is not trusted: fully invested or out"},
    }


def warmup(p: dict) -> int:
    return int(p["coreLen"]) + int(p["eqLen"]) + 1


def _asof(src_index: np.ndarray, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    pos = np.searchsorted(src_index, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = values[pos[ok]]
    return out


def weights(c: np.ndarray, p: dict) -> np.ndarray:
    """Target weight 0..1 per bar of one market's closes (NaN = undecided)."""
    n = len(c)
    core_len, eq_len = int(p["coreLen"]), int(p["eqLen"])
    margin = float(p.get("margin") or 0.0)
    fb = 1.0 if p.get("fallback", "hold") == "hold" else 0.0
    sm = ind.sma(c, core_len)
    s = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
    r = np.zeros(n)
    if n > 1:
        with np.errstate(divide="ignore", invalid="ignore"):
            r[1:] = np.log(c[1:] / c[:-1])
    r = np.where(np.isfinite(r), r, 0.0)
    s_prev = np.full(n, np.nan)
    s_prev[1:] = s[:-1]
    g = np.where(np.isfinite(s_prev), s_prev * r - FEE * np.abs(s - s_prev), np.nan)
    first = np.argmax(np.isfinite(g)) if np.isfinite(g).any() else n
    E = np.full(n, np.nan)
    H = np.full(n, np.nan)
    if first < n:
        E[first:] = np.cumsum(g[first:])
        H[first:] = np.cumsum(r[first:])
    out = np.full(n, np.nan)
    if p.get("mode", "select") == "filter":
        em = ind.sma(E, eq_len)
        ok = np.isfinite(em) & np.isfinite(E) & np.isfinite(s)
        trust = E >= em - margin - 1e-12
        out[ok] = np.where(trust[ok], s[ok], fb)
        return out
    dE = np.full(n, np.nan)
    dH = np.full(n, np.nan)
    dE[eq_len:] = E[eq_len:] - E[:-eq_len]
    dH[eq_len:] = H[eq_len:] - H[:-eq_len]
    d = dE - dH
    trusted = False
    for i in range(n):
        if not (np.isfinite(d[i]) and np.isfinite(s[i])):
            continue
        if trusted and d[i] < -margin - 1e-12:
            trusted = False
        elif not trusted and d[i] > margin + 1e-12:
            trusted = True
        out[i] = s[i] if trusted else fb
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("eqcurve_a12 needs at least one market")
    idx = union_index(candles, markets)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        mi = np.asarray(df.index, dtype=np.int64)
        w = weights(df["close"].to_numpy(np.float64), p)
        cols[m] = _asof(mi, w, idx) * each
    out = frame(idx, cols)
    if len(markets) > 1:
        any_ok = out.notna().any(axis=1).to_numpy()
        out = out.fillna(0.0)
        out[~any_ok] = np.nan
    return out


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    fb = "stays fully invested" if p.get("fallback", "hold") == "hold" else "waits in euros"
    m = float(p.get("margin") or 0.0)
    steps = [
        f"In the background it runs a simple trend rule on paper: own {mk} while the close is above its "
        f"{bars_text(p['coreLen'], iv)} average, otherwise euros, fees included.",
    ]
    if p.get("mode", "select") == "filter":
        steps.append(f"It follows that rule for real only while the rule's own paper results are above their "
                     f"{bars_text(p['eqLen'], iv)} average" + (f" (or less than {pct(m)} under it)." if m else "."))
    else:
        steps.append(f"It follows that rule for real once it beat simply holding over the last "
                     f"{bars_text(p['eqLen'], iv)}" + (f" by more than {pct(m)}" if m else "")
                     + ", and stops following it once it trailed holding" + (f" by more than {pct(m)}." if m else "."))
    steps.append(f"While it does not trust the rule it {fb}.")
    if len(spec.get("markets") or []) > 1:
        steps.append(f"Each of {mk} is handled on its own with an equal share of the money.")
    return {
        "summary": f"A trend rule on {mk} that is only followed while it has recently been working; otherwise it "
                   f"{fb}.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Long trends after choppy spells: the trend rule is switched off in the chop and back on once "
                      "it starts beating holding again (e.g. at the start of a bear market's slide).",
        "whenItLoses": "Sudden regime changes: the rule's track record lags, so it trusts the rule a little late "
                       "into a crash and keeps trusting it a little too long into a recovery.",
    }
