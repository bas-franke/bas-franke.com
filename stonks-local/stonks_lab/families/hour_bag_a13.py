"""hour_bag_a13 v2 (agent-13): a daily fleet leader split into k tranches that decide at k different UTC hours.

phase_shift (agent-10) showed that a daily leader's score moves by several points with the hour at which its daily
candle closes: part of every 1d result is decision-hour luck. Fund managers fight the same "rebalance timing luck"
with tranching (overlapping portfolios). This family does that: the money is split into ``phases`` equal tranches;
tranche j runs the frozen preset (one of phase_shift's presets) on daily candles that close at
``offset + j * 24 / phases`` UTC, so the position steps in 1/k slices over the day instead of all at once.

On 1h candles. The combined target is the mean of the tranches' latest decisions, emitted at every tranche's
decision hour (NaN = leave the position alone in between) once every tranche has decided. It must be re-emitted at
every decision, not only when it changes: a post-only limit that misses is cancelled after its timeout and would
otherwise never be retried (v1 did that and lost ~25 score points). Decisions use candles up to and including the decision bar only.
"""
from __future__ import annotations

import numpy as np

from ._base import frame, market_names, risk_steps, union_index
from .phase_shift import PRESETS, required_markets as _ps_required, targets as _ps_targets, warmup as _ps_warmup

NAME = "hour_bag_a13"
VERSION = 2
TITLE = "Daily leader in hour tranches"
BOT_READY = False
MULTI_MARKET = True

PHASES = [2, 3, 4, 6, 8, 12, 24]


def default_params() -> dict:
    return {"preset": "sma130", "phases": 4, "offset": 0}


def param_space() -> dict:
    return {
        "preset": {"type": "choice", "values": list(PRESETS),
                   "description": "which fleet leader runs in every tranche (its params are frozen)"},
        "phases": {"type": "choice", "values": PHASES,
                   "description": "number of tranches; tranche j decides at offset + j*24/phases UTC"},
        "offset": {"type": "int", "min": 0, "max": 23,
                   "description": "UTC hour of the first tranche's daily close"},
    }


def hours(p: dict) -> list[int]:
    k = int(p["phases"])
    step = 24 // k
    return sorted({(int(p["offset"]) + j * step) % 24 for j in range(k)})


def warmup(p: dict) -> int:
    return _ps_warmup({"preset": p["preset"], "hour": 0}) + 24


def required_markets(spec: dict) -> list[str]:
    return _ps_required({**spec, "params": {"preset": spec["params"]["preset"], "hour": 0}})


def _ffill(a: np.ndarray) -> np.ndarray:
    ok = np.isfinite(a)
    pos = np.where(ok, np.arange(len(a)), -1)
    np.maximum.accumulate(pos, out=pos)
    out = np.where(pos >= 0, a[np.maximum(pos, 0)], np.nan)
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    hs = hours(p)
    acc = {m: np.zeros(len(idx)) for m in markets}
    decided = np.zeros(len(idx), dtype=bool)
    for h in hs:
        sub = {**spec, "params": {"preset": p["preset"], "hour": h}}
        w = _ps_targets(candles, sub).reindex(idx)
        decided |= np.isfinite(w.to_numpy(np.float64)).any(axis=1)
        for m in markets:
            acc[m] = acc[m] + _ffill(w[m].to_numpy(np.float64))   # NaN until this tranche's first decision
    out = {}
    for m in markets:
        avg = acc[m] / len(hs)
        out[m] = np.where(decided, avg, np.nan)
    return frame(idx, out)


def explain(spec) -> dict:
    p = spec["params"]
    name, _ = PRESETS[p["preset"]]
    hs = hours(p)
    mk = market_names(spec)
    hrs = ", ".join(f"{h:02d}:00" for h in hs)
    steps = [f"It splits the money into {len(hs)} equal parts and runs the fleet strategy '{name}' on {mk} in each "
             "part with fixed settings, on daily candles.",
             f"Each part's day closes at a different hour ({hrs} UTC), so a buy or sell happens in {len(hs)} slices "
             "spread over the day instead of all at once.",
             "The position is the average of the parts' latest decisions."]
    return {
        "summary": f"The daily strategy '{name}' on {mk}, split into {len(hs)} parts that decide at different hours.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Same markets as the daily strategy it wraps, without depending on one lucky decision hour.",
        "whenItLoses": "Same as the daily strategy it wraps; slicing removes hour luck, it does not add an edge.",
    }
