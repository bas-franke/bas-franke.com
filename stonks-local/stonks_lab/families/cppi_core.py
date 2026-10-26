"""cppi_core v1 (agent-07): CPPI / TIPP drawdown-budget sizing on BTC/ETH.

Every exit tried so far is a price signal (SMA, MACD, stops, breadth). This family sizes from the strategy's own
equity instead: constant proportion portfolio insurance (CPPI) with a ratcheting floor (TIPP).

Per market sleeve (equal split over the spec's markets), at each bar close from the anchor on:
- paper equity E follows the coin with the weight held over the last bar (close to close), minus an estimated
  0.2 % fee on every weight change (the real backtest charges real fees; E only drives the sizing);
- floor F = floorPct * peak(E) (ratchet) or floorPct * E at the (re)start (no ratchet);
- target weight = clip(mult * (E - F) / E, 0, 1): full while the cushion is big, scaled down as the strategy's own
  drawdown eats the cushion, 0 once E touches the floor;
- the weight only moves when the target differs from the current weight by at least minStep (or hits 0/1);
- out (weight 0): the floor restarts at floorPct * E (fresh cushion) when the close is above SMA(resetSma)
  (resetMode sma), after resetBars candles in cash (time), or the first of the two (either).
Decisions use candles up to and including bar t only. ANCHORED: the paper equity starts at the backtest start.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import (aligned_close, anchor_index, bars_text, frame, market_names, max_weight, pct, risk_steps,
                    union_index)

NAME = "cppi_core"
VERSION = 1
TITLE = "Drawdown-budget sizing (CPPI)"
BOT_READY = False
MULTI_MARKET = True
ANCHORED = True

PAPER_FEE = 0.002


def default_params() -> dict:
    return {"mult": 5.0, "floorPct": 0.75, "ratchet": True, "resetMode": "sma", "resetSma": 100, "resetBars": 60,
            "minStep": 0.1, "outBelow": 0.2}


def param_space() -> dict:
    return {
        "mult": {"type": "float", "min": 1.0, "max": 20.0, "log": True,
                 "description": "multiplier: weight = mult x cushion share (higher = stays fully in longer)"},
        "floorPct": {"type": "float", "min": 0.4, "max": 0.95,
                     "description": "floor as a share of the peak (or start) paper equity"},
        "ratchet": {"type": "bool", "description": "the floor rises with every new equity high (TIPP)"},
        "resetMode": {"type": "choice", "values": ["sma", "time", "either"],
                      "description": "when to restart with a fresh cushion after being fully out"},
        "resetSma": {"type": "int", "min": 10, "max": 400, "log": True,
                     "description": "sma/either reset: restart once the close is above this SMA"},
        "resetBars": {"type": "int", "min": 3, "max": 400, "log": True,
                      "description": "time/either reset: restart after this many candles in cash"},
        "minStep": {"type": "float", "min": 0.02, "max": 0.5, "zero": True,
                    "description": "only rebalance when the target moved at least this much (0 = always)"},
        "outBelow": {"type": "float", "min": 0.02, "max": 0.6,
                     "description": "sell everything once the target weight falls under this"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["mult"]) * (1.0 - float(p["floorPct"])) < max(0.5, float(p.get("outBelow") or 0) + 0.1):
        return "mult x (1 - floorPct) too small: it would start less than half invested or out at once"
    return None


def warmup(p: dict) -> int:
    return int(p["resetSma"]) - 1 if p["resetMode"] in ("sma", "either") else 1


def sleeve(c: np.ndarray, p: dict, first: int) -> np.ndarray:
    """Weights 0..1 of one market's CPPI sleeve, NaN before ``first``/while the close is undefined."""
    n = len(c)
    w = np.full(n, np.nan)
    mult, fp, ratchet = float(p["mult"]), float(p["floorPct"]), bool(p["ratchet"])
    mode, rb, step = p["resetMode"], int(p["resetBars"]), float(p.get("minStep") or 0.0)
    ob = float(p.get("outBelow") or 0.0)
    use_sma = mode in ("sma", "either")
    sm = ind.sma(c, int(p["resetSma"])) if use_sma else np.full(n, np.nan)
    cl, sl = c.tolist(), sm.tolist()
    started = False
    eq = peak = floor = 1.0
    cur, out_bar, prev = 0.0, 0, 0.0

    def target(e, f):
        t = min(1.0, max(0.0, mult * (e - f) / e)) if e > 0 else 0.0
        return 0.0 if t < ob else (1.0 if t > 1.0 - 1e-9 else t)

    for i in range(max(first, 0), n):
        x = cl[i]
        if x != x:
            continue
        if use_sma and sl[i] != sl[i]:
            continue
        if not started:
            started, eq, peak, floor, prev = True, 1.0, 1.0, fp, x
            cur = target(eq, floor)
            w[i] = cur
            continue
        eq *= 1.0 + cur * (x / prev - 1.0)
        prev = x
        if ratchet and eq > peak:
            peak, floor = eq, fp * eq
        if cur <= 0.0:
            reset = False
            if mode in ("sma", "either") and x > sl[i]:
                reset = True
            if mode in ("time", "either") and i - out_bar >= rb:
                reset = True
            if reset:
                peak, floor = eq, fp * eq
                new = target(eq, floor)
                eq -= PAPER_FEE * new * eq
                cur = new
            w[i] = cur
            continue
        t = target(eq, floor)
        if t <= 0.0 or t >= 1.0 or abs(t - cur) >= step:
            eq -= PAPER_FEE * abs(t - cur) * eq
            if t <= 0.0:
                out_bar = i
            cur = t
        w[i] = cur
    return w


def targets(candles, spec, start_time=None):
    p = spec["params"]
    ms = list(spec["markets"])
    idx = union_index(candles, ms)
    first = max(anchor_index(idx, start_time), warmup(p))
    k = len(ms)
    mw = max_weight(spec)
    cols = {}
    for m in ms:
        c = aligned_close(candles, m, idx)
        cols[m] = sleeve(c, p, first) * (mw / k)
    return frame(idx, cols)


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    steps = []
    if k > 1:
        steps.append(f"The money is split equally over {mk}; each part runs the rule below on its own.")
    steps.append(f"It starts fully invested in {mk} and keeps a running score of its own paper value.")
    steps.append(f"It sets a safety floor at {pct(p['floorPct'])} of "
                 + ("the highest value it has reached so far (the floor only moves up)." if p["ratchet"]
                    else "its starting value."))
    steps.append(f"The amount in coins is {float(p['mult']):.1f} times the cushion above that floor: it stays fully "
                 "invested while it is well above the floor and sells step by step as its own losses eat the "
                 f"cushion; once that amount would be under {pct(p['outBelow'])} it sells the rest.")
    if float(p.get("minStep") or 0) > 0:
        steps.append(f"It only trades when the target amount moved by at least {pct(p['minStep'])} of the money.")
    if p["resetMode"] == "sma":
        steps.append(f"Once out, it starts over with a fresh cushion when the price is back above its average over "
                     f"{bars_text(p['resetSma'], iv)}.")
    elif p["resetMode"] == "time":
        steps.append(f"Once out, it starts over with a fresh cushion after {bars_text(p['resetBars'], iv)} in euros.")
    else:
        steps.append(f"Once out, it starts over when the price is back above its {bars_text(p['resetSma'], iv)} "
                     f"average or after {bars_text(p['resetBars'], iv)} in euros, whichever comes first.")
    return {
        "summary": f"Holds {mk} but sells gradually as its own drawdown grows, to cap the loss from its last high.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long, deep crashes: it is mostly in euros before the bottom while holding loses half.",
        "whenItLoses": "Sharp dips inside a bull market: it sells near the low and only buys back after the reset.",
    }
