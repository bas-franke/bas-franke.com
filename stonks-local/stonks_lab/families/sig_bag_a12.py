"""sig_bag_a12 v2 (agent-12): combine TWO different step-aside signals on one coin: average, AND or OR.

leader_bag_a17 (#623/#624) found no diversification bonus because every BTC/ETH-only leader it bagged makes the
same bet (long above a trend line, out in bears). This family asks the question for signals that do NOT share a
trend line, e.g. alt_froth (sell while the 2019 alt pool outruns BTC = cross-asset froth, daily) and ivr_gate_a06
(sell while hourly moves keep reversing = intraday chop, hourly data). If their exits come at different times,
holding their average should beat the average member (and AND/OR show which way they disagree).

Members are given as params ``a`` and ``b`` = {"family": name, "params": {...}} (frozen, not in the param space, like
hourshift_a14's ``inner``). Both run on the spec's own candles and interval; a daily family on 1h is wrapped with
hourshift_a14. Each member's last decision is carried forward (its NaN rows = "leave the position alone"); the bag
decides only once both have decided and emits a row when a member decides or its combined weight changes.

``mode``: ``avg`` = wA * a + (1 - wA) * b; ``and`` = min (in only while both are in); ``or`` = max (in while either
is in); ``a`` / ``b`` = that member alone through the same plumbing (paired controls).
A decision at bar t uses only what the members use (candles up to t).
"""
from __future__ import annotations

import numpy as np

from . import get_family
from ._base import frame, market_names, max_weight, normalize_spec, risk_steps, union_index

NAME = "sig_bag_a12"
VERSION = 2
INVALID_BELOW_VERSION = 2       # v1 never retried a missed limit order (emitted only weight changes)
TITLE = "Two different step-aside signals combined"
BOT_READY = False
MULTI_MARKET = False

ALT_FROTH_H00 = {"family": "hourshift_a14",
                 "params": {"hour": "00", "period": "24",
                            "inner": {"family": "alt_froth",
                                      "params": {"lookback": 120, "threshold": 0.1, "band": 0.05, "minOut": 0,
                                                 "trendSma": 0}}}}
IVR_CENTRE = {"family": "ivr_gate_a06",
              "params": {"horizon": 48, "lookback": 30, "rankLen": 365, "exitRank": 0.2, "enterRank": 0.3,
                         "side": "high", "trendSma": 0, "combine": "and", "decideHour": 0}}
MODES = ["avg", "and", "or", "a", "b"]


def default_params() -> dict:
    return {"mode": "avg", "wA": 0.5, "a": ALT_FROTH_H00, "b": IVR_CENTRE}


def param_space() -> dict:
    return {
        "mode": {"type": "choice", "values": MODES,
                 "description": "avg = weighted average of the two positions; and = in only while both are in; "
                                "or = in while either is in; a / b = one member alone (control)"},
        "wA": {"type": "float", "min": 0.1, "max": 0.9,
               "description": "share of member a in avg mode (b gets the rest)"},
    }


def _member_spec(m) -> tuple:
    if not isinstance(m, dict) or not isinstance(m.get("family"), str):
        raise ValueError("a member must be {'family': name, 'params': {...}}")
    fam = get_family(m["family"])
    return fam, dict(m.get("params") or {})


def valid_params(p: dict) -> str | None:
    for key in ("a", "b"):
        try:
            fam, params = _member_spec(p.get(key))
        except Exception as e:  # unknown family or bad shape
            return f"member {key}: {e}"
        if fam.name == NAME:
            return f"member {key} cannot be sig_bag_a12 itself"
        if fam.anchored:
            return f"member {key}: anchored (DCA-style) families are not supported"
        err = fam.validate({"params": params})
        if err:
            return f"member {key}: {err}"
    return None


def warmup(p: dict) -> int:
    w = 0
    for key in ("a", "b"):
        fam, params = _member_spec(p.get(key) or default_params()[key])
        w = max(w, int(fam.warmup({**fam.default_params(), **params}) or 0))
    return w


def _specs(spec: dict) -> list:
    p = spec["params"]
    out = []
    for key in ("a", "b"):
        fam, params = _member_spec(p.get(key) or default_params()[key])
        s = normalize_spec({"family": fam.name, "markets": list(spec.get("markets") or []),
                            "interval": spec.get("interval"), "params": params,
                            "risk": {"maxWeight": 1.0}}, fam)
        out.append((fam, s))
    return out


def required_markets(spec: dict) -> list[str]:
    ms: list[str] = []
    for fam, s in _specs(spec):
        for m in fam.markets_needed(s):
            if m not in ms:
                ms.append(m)
    return ms


def _held(fam, s, candles, idx, market) -> tuple:
    """The member's weight at every bar (its last decision carried forward, NaN before its first decision) and the
    bars where it decided."""
    t = fam.targets(candles, s)
    col = t[market].reindex(idx).to_numpy(np.float64) if market in t.columns else np.full(len(idx), np.nan)
    v = np.full(len(idx), np.nan)
    last = np.nan
    for i, x in enumerate(col):
        if np.isfinite(x):
            last = x
        v[i] = last
    return v, np.isfinite(col)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    market = markets[0]
    idx = union_index(candles, [market])
    (fa, sa), (fb, sb) = _specs(spec)
    a, da = _held(fa, sa, candles, idx, market)
    b, db = _held(fb, sb, candles, idx, market)
    mode = p.get("mode", "avg")
    wa = float(p.get("wA", 0.5))
    with np.errstate(invalid="ignore"):
        if mode == "avg":
            v = wa * a + (1.0 - wa) * b
        elif mode == "and":
            v = np.minimum(a, b)
        elif mode == "or":
            v = np.maximum(a, b)
        elif mode == "a":
            v = a + 0.0 * b
        else:
            v = b + 0.0 * a
    v = np.clip(v, 0.0, 1.0) * max_weight(spec)
    # emit a row when a member decides (re-asserting the target, so a missed limit order is retried like the
    # member itself would) or when the combined weight changes; NaN rows in between = keep the position
    out = np.full(len(idx), np.nan)
    prev = np.nan
    for i, x in enumerate(v):
        if np.isfinite(x) and (da[i] or db[i] or not (np.isfinite(prev) and abs(x - prev) < 1e-12)):
            out[i] = x
        if np.isfinite(x):
            prev = x
    return frame(idx, {market: out})


def _name(m) -> str:
    try:
        if m["family"] == "hourshift_a14":
            return f"{m['params']['inner']['family']} (daily close {m['params']['hour']}:00 UTC)"
        return m["family"]
    except Exception:  # pragma: no cover
        return "?"


def explain(spec) -> dict:
    p = spec["params"]
    na, nb = _name(p.get("a") or ALT_FROTH_H00), _name(p.get("b") or IVR_CENTRE)
    mode = p.get("mode", "avg")
    wa = float(p.get("wA", 0.5))
    how = {"avg": f"It holds {wa:.0%} of what the first strategy holds plus {1 - wa:.0%} of what the second holds, "
                  "so one strategy's exit only sells part of the position.",
           "and": "It holds the coin only while both strategies hold it: either one's exit sells everything.",
           "or": "It holds the coin while at least one strategy holds it: it sells only when both are out.",
           "a": "Control run: it simply follows the first strategy.",
           "b": "Control run: it simply follows the second strategy."}[mode]
    return {
        "summary": f"Combines two different reasons to step out of {market_names(spec)}: {na} and {nb}.",
        "howItWorks": [f"First strategy: {na}, with fixed settings.", f"Second strategy: {nb}, with fixed settings.",
                       how] + risk_steps(spec),
        "whenItWins": "When the two strategies are wrong at different times, so a bad exit of one is diluted.",
        "whenItLoses": "When both step out of a rising market, or when they agree anyway (then it is just one "
                       "strategy with extra trades).",
    }
