"""vacation_core_a13 v1 (agent-13): an SMA trend core whose exits are time-boxed ("a vacation, not a retirement").

Findings #324/#373/#453: SMA cores lose to holding BTC/ETH mainly because their out-days cost money in 5 of 6 years
(the next 30 days under an SMA130 still average +2.6 %/+2.9 %); they only win the long 2022 bear. Price-based re-entry
fixes (regret_core, trough_reentry, asym_core) did not help. This family re-enters on TIME instead:

- in -> out: the close falls below SMA(coreLen) while the core is "armed" (it is armed after any close above the SMA);
- out -> in: the close is back above the SMA (normal re-entry, armed), OR the position has been out for ``vacation``
  candles (forced re-entry, disarmed);
- while disarmed it sells again only on a deeper break: a close below the last exit close x (1 - ``reExit``); a close
  above the SMA re-arms it.
- ``vacation`` 0 = off: the plain SMA core (the paired ablation).

So a long bear is sold in steps (each new leg ``reExit`` lower), while an ordinary dip under the average costs at most
``vacation`` candles of missed upside. Multi-market: each market runs its own state with maxWeight / len(markets).
Decisions use closes up to and including bar t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "vacation_core_a13"
VERSION = 1
TITLE = "SMA core with time-boxed exits"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"coreLen": 130, "vacation": 20, "reExit": 0.1}


def param_space() -> dict:
    return {
        "coreLen": {"type": "int", "min": 20, "max": 300, "log": True,
                    "description": "SMA length of the trend core"},
        "vacation": {"type": "int", "min": 3, "max": 120, "zero": True, "log": True,
                     "description": "candles after an exit when it buys back anyway (0 = never: plain SMA core)"},
        "reExit": {"type": "float", "min": 0.0, "max": 0.4,
                   "description": "after a forced buy-back, sell again only below the last exit price minus this"},
    }


def warmup(p: dict) -> int:
    return int(p["coreLen"])


def vacation_state(close: np.ndarray, core_len: int, vacation: int, re_exit: float) -> np.ndarray:
    c = np.asarray(close, dtype=np.float64)
    sm = ind.sma(c, core_len)
    out = np.full(len(c), np.nan)
    state, armed, out_days, last_exit = 1.0, True, 0, np.nan
    started = False
    for t in range(len(c)):
        if not (np.isfinite(sm[t]) and np.isfinite(c[t])):
            continue
        above = c[t] > sm[t]
        if not started:  # first decision: plain core
            started, state, armed = True, (1.0 if above else 0.0), True
            if not above:
                out_days, last_exit = 0, c[t]
            out[t] = state
            continue
        if state == 1.0:
            if above:
                armed = True
            deeper = np.isfinite(last_exit) and c[t] < last_exit * (1.0 - re_exit)
            if (armed and not above) or (not armed and deeper):
                state, out_days, last_exit = 0.0, 0, c[t]
        else:
            out_days += 1
            if above:
                state, armed = 1.0, True
            elif vacation > 0 and out_days >= vacation:
                state, armed = 1.0, False
        out[t] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("vacation_core_a13 needs at least one market")
    idx = union_index(candles, markets)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        st = vacation_state(c, int(p["coreLen"]), int(p["vacation"]), float(p["reExit"]))
        cols[m] = np.where(np.isfinite(st), st * each, np.nan)
    df = frame(idx, cols)
    if len(markets) > 1:
        any_ok = df.notna().any(axis=1).to_numpy()
        df = df.fillna(0.0)
        df[~any_ok] = np.nan
    return df


def explain(spec) -> dict:
    p = spec["params"]
    L, V, k = int(p["coreLen"]), int(p["vacation"]), float(p["reExit"])
    iv = spec.get("interval", "1d")
    steps = [
        f"Hold {market_names(spec)} while the close is above its {bars_text(L, iv)} average; sell when it closes below.",
    ]
    if V > 0:
        steps += [
            f"After a sale it buys back anyway after {bars_text(V, iv)}, even if the price is still under the average.",
            f"After such a forced buy-back it only sells again if the price closes {pct(k)} below where it last sold; "
            "a close back above the average restores the normal rule.",
        ]
    else:
        steps += ["It buys back when the close is above the average again (plain trend core)."]
    return {
        "summary": f"Trend core on {market_names(spec)} that never sits out longer than "
                   f"{bars_text(V, iv) if V else 'the trend says'} unless the price keeps falling.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Short dips under the average that recover quickly (it does not wait for the lagging average), "
                      "and long bear markets that fall in clear steps.",
        "whenItLoses": "Slow grinding declines that hover just above each new sell level, and sharp V-recoveries "
                       "before the vacation ends are still re-entered late.",
    }
