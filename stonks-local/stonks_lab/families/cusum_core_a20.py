"""cusum_core_a20 v1 (agent-20): a CUSUM change-point trend core (Page's test on volatility-scaled returns).

Every trend core in the fleet compares the price with a LINE (SMA, EMA, Donchian, Kalman level). A CUSUM detector
asks a different question: has the drift of the returns CHANGED? It accumulates evidence one bar at a time and
fires once the evidence is strong enough, then starts counting from zero. Quiet chop adds nothing (each bar loses
the allowance ``k``), a run of strong up-days fires quickly whatever the price level.

At the close of bar t (only candles up to t):
- z_t = ln(close_t / close_{t-1}) / sigma_{t-1}, sigma = population std of the log returns over ``volLen`` bars
  ending at t-1 (scale-free, so the thresholds mean the same on BTC and ETH, 1d and 12h).
- up_t = max(0, up_{t-1} + z_t - k), dn_t = max(0, dn_{t-1} - z_t - k).
- out -> in when up_t >= hIn; in -> out when dn_t >= hOut. After a switch both sums restart at 0.
  The first decided bar starts out of the market.
- ``coreSma`` > 0 combines it with a plain close-vs-SMA core: ``combine`` "or" holds when either says hold (the
  CUSUM as a fast re-entry / hold-through for the SMA core), "and" only when both do. coreSma 0 = CUSUM alone.
weight = maxWeight while held.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "cusum_core_a20"
VERSION = 1
TITLE = "CUSUM change-point trend core"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"volLen": 60, "k": 0.25, "hIn": 3.0, "hOut": 3.0, "coreSma": 0, "combine": "or"}


def param_space() -> dict:
    return {
        "volLen": {"type": "int", "min": 10, "max": 365, "log": True,
                   "description": "candles of returns used to measure normal volatility"},
        "k": {"type": "float", "min": 0.0, "max": 1.0,
              "description": "allowance per candle in standard deviations (drift ignored as noise)"},
        "hIn": {"type": "float", "min": 0.5, "max": 15.0, "log": True,
                "description": "evidence (summed standardised up-moves) needed to buy"},
        "hOut": {"type": "float", "min": 0.5, "max": 15.0, "log": True,
                 "description": "evidence (summed standardised down-moves) needed to sell"},
        "coreSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                    "description": "optional SMA trend core combined with the CUSUM (0 = off)"},
        "combine": {"type": "choice", "values": ["or", "and"],
                    "description": "how the CUSUM state and the SMA core are combined"},
    }


def warmup(p: dict) -> int:
    return max(int(p["volLen"]) + 1, int(p["coreSma"]))


def cusum_state(close: np.ndarray, vol_len: int, k: float, h_in: float, h_out: float) -> np.ndarray:
    c = np.asarray(close, dtype=np.float64)
    n = len(c)
    out = np.full(n, np.nan)
    if n < 2:
        return out
    r = np.full(n, np.nan)
    r[1:] = np.log(c[1:] / c[:-1])
    sd = ind.std_pop(r, vol_len)               # std over vol_len returns ending at t (NaN where incomplete)
    sd_prev = np.full(n, np.nan)
    sd_prev[1:] = sd[:-1]
    state = None
    up = dn = 0.0
    for i in range(n):
        s, x = sd_prev[i], r[i]
        if not (s == s and x == x) or s <= 0:
            if state is not None:
                out[i] = state
            continue
        z = x / s
        if state is None:
            state = 0.0
        up = max(0.0, up + z - k)
        dn = max(0.0, dn - z - k)
        if state == 0.0 and up >= h_in:
            state, up, dn = 1.0, 0.0, 0.0
        elif state == 1.0 and dn >= h_out:
            state, up, dn = 0.0, 0.0, 0.0
        out[i] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    on = cusum_state(c, int(p["volLen"]), float(p["k"]), float(p["hIn"]), float(p["hOut"]))
    if int(p["coreSma"]) > 0:
        sm = ind.sma(c, int(p["coreSma"]))
        core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
        both = np.isfinite(core) & np.isfinite(on)
        comb = np.full(len(c), np.nan)
        if p["combine"] == "or":
            comb[both] = np.maximum(core[both], on[both])
        else:
            comb[both] = np.minimum(core[both], on[both])
        on = comb
    return frame(df.index, {m: on * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    steps = [f"It measures how much {mk} normally moves per candle over the last {bars_text(p['volLen'], iv)}.",
             f"Every candle it adds the move (in those normal-move units, minus an allowance of {p['k']:.2f}) to an "
             "'up' tally and a 'down' tally; a tally never goes below zero, so sideways noise fades away.",
             f"It buys once the up tally reaches {p['hIn']:.1f} and sells once the down tally reaches "
             f"{p['hOut']:.1f}; after each switch both tallies restart at zero."]
    if int(p["coreSma"]) > 0:
        word = "either" if p["combine"] == "or" else "both"
        steps.append(f"It also checks whether the price is above its average over "
                     f"{bars_text(p['coreSma'], iv)} and holds only while {word} of the two says hold.")
    return {
        "summary": f"Holds {mk} after a statistically clear run of up-moves, sells after a clear run of down-moves.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Sharp trend changes: a strong rally or sell-off is detected within days, without waiting "
                      "for a slow average to turn.",
        "whenItLoses": "Choppy markets with alternating strong days: tallies fill on noise and it trades back and "
                       "forth paying fees.",
    }
