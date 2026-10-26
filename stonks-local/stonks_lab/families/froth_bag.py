"""froth_bag v1 (agent-22): parameter bagging of froth_dip, so the strategy IS the plateau instead of its luckiest peak.

Validation of the froth_dip BTC 12h lead (findings #435-#440) showed a broad plateau (90 % of random +-40 % neighbours
beat buy and hold) whose single best spec is selection: two exits carry ~40 % of it and one alt more or less in the
pool moves it by 10-15 points. Bagging is the standard fix: run `members` froth_dip copies whose nine numeric knobs
are each multiplied by a fixed pseudo-random factor in [1 - spread, 1 + spread] (member 0 = the centre itself) and
hold the AVERAGE of their positions, rounded to `step`. Exits and re-entries are then spread over time instead of
hanging on one SMA crossing or one froth threshold.

The member factors depend only on (member number, knob name, spread), never on data, so the spec is deterministic
and a decision at bar t uses what froth_dip uses: candles up to t.
"""
from __future__ import annotations

import random

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from . import froth_dip as fd

NAME = "froth_bag"
VERSION = 1
TITLE = "Bagged trend core, panic buys and froth exits"
BOT_READY = False
MULTI_MARKET = True
KNOBS = ["coreSma", "rsiPeriod", "rsiBelow", "breadthMin", "sellAbove", "maxHold", "frothLook", "frothThr",
         "frothBand"]
INTS = {"coreSma", "rsiPeriod", "maxHold", "frothLook"}


def default_params() -> dict:
    return {**fd.default_params(), "spread": 0.3, "members": 12, "step": 0.25}


def param_space() -> dict:
    return {
        **fd.param_space(),
        "spread": {"type": "float", "min": 0.0, "max": 0.6,
                   "description": "each member's knobs are the centre times a fixed factor in [1-spread, 1+spread]"},
        "members": {"type": "int", "min": 1, "max": 40,
                    "description": "number of froth_dip copies whose positions are averaged (1 = plain froth_dip)"},
        "step": {"type": "choice", "values": [0.0, 0.1, 0.2, 0.25, 0.34, 0.5],
                 "description": "round the averaged position to this step (0 = no rounding) to avoid tiny trades"},
    }


def valid_params(p: dict) -> str | None:
    return fd.valid_params(p)


def _factor(k: int, knob: str, spread: float) -> float:
    if k == 0 or spread <= 0:
        return 1.0
    return 1.0 + spread * (2.0 * random.Random(f"froth_bag:{k}:{knob}").random() - 1.0)


def member_params(p: dict) -> list[dict]:
    """The members' froth_dip params (deterministic; clamped into froth_dip's space and made valid)."""
    space = fd.param_space()
    out = []
    for k in range(max(1, int(p.get("members") or 1))):
        q = {}
        for knob in KNOBS:
            v = float(p[knob])
            if knob in ("coreSma", "maxHold", "frothThr") and v == 0:
                q[knob] = 0 if knob != "frothThr" else 0.0   # 0 = switched off stays off
                continue
            x = v * _factor(k, knob, float(p.get("spread") or 0.0))
            lo, hi = space[knob]["min"], space[knob]["max"]
            x = min(max(x, lo), hi)
            q[knob] = int(round(x)) if knob in INTS else round(x, 4)
        q["frothBand"] = min(q["frothBand"], q["frothThr"])
        if q["rsiBelow"] >= q["sellAbove"]:
            q["rsiBelow"] = q["sellAbove"] - 1.0
        out.append(q)
    return out


def warmup(p: dict) -> int:
    return max(fd.warmup(q) for q in member_params(p))


def required_markets(spec: dict) -> list[str]:
    return fd.required_markets(spec)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    mats = []
    for q in member_params(p):
        t = fd.targets(candles, {**spec, "params": q}).reindex(idx)
        mats.append(t[markets].to_numpy(np.float64))
    stack = np.stack(mats)                       # members x bars x markets
    good = np.isfinite(stack).all(axis=(0, 2))
    avg = np.where(good[:, None], np.nanmean(np.where(np.isfinite(stack), stack, 0.0), axis=0), np.nan)
    each = max_weight(spec) / len(markets)
    step = float(p.get("step") or 0.0)
    if step > 0:
        frac = avg / each
        avg = np.minimum(np.round(frac / step) * step, 1.0) * each
    W = avg
    first = int(np.argmax(good)) if good.any() else len(idx)
    W[:first] = np.nan
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k, n = len(spec.get("markets") or []), max(1, int(p.get("members") or 1))
    share = f" ({100 / k:.0f} % of the money per coin at most)" if k > 1 else ""
    sp = float(p.get("spread") or 0)
    core_n = int(p.get("coreSma") or 0)
    steps = [
        f"It runs {n} slightly different copies of one rule set and holds the average of their positions{share}"
        + (f", rounded to steps of {pct(float(p['step']))}." if float(p.get('step') or 0) else "."),
        (f"Each copy's settings are the ones below, each one moved by up to {pct(sp)} up or down, so no single "
         "threshold or average length decides everything." if sp > 0 and n > 1 else
         "All copies use the same settings."),
        (f"A copy holds {mk} while the price is above its {bars_text(core_n, iv)} average (the trend core)."
         if core_n else f"A copy holds {mk} by default."),
        f"It also buys after a market-wide panic: when at least {pct(p['breadthMin'])} of eleven coins that already "
        f"traded in 2019 have an RSI over {bars_text(p['rsiPeriod'], iv)} under {float(p['rsiBelow']):g}; it ends "
        f"that dip purchase when the coin's RSI passes {float(p['sellAbove']):g}"
        + (f" or after {bars_text(p['maxHold'], iv)}." if int(p.get('maxHold') or 0) else "."),
    ]
    if float(p.get("frothThr") or 0) > 0:
        steps.append(
            f"A copy sells and waits in euros while nine old altcoins have beaten Bitcoin by more than "
            f"{pct(np.expm1(float(p['frothThr'])))} over {bars_text(p['frothLook'], iv)} (an alt-season frenzy), "
            f"until that lead is back under {pct(np.expm1(float(p['frothThr']) - float(p['frothBand'])))}.")
    return {
        "summary": f"Averages {n} variants of a trend core with panic buys and alt-froth exits on {mk}, "
                   "so it steps in and out gradually.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets with sharp market-wide dips that recover, and alt-season tops followed by "
                      "crashes; it depends less on one lucky exit than a single rule set.",
        "whenItLoses": "Choppy markets around the average (several small trades), panics that keep falling, and "
                       "bull runs led by altcoins (it is partly in euros).",
    }
