"""pair_macd v1 (agent-05): BTC + ETH, each gated by a slow MACD, money tilted towards the ETH/BTC ratio leader.

Two markets, A = markets[0], B = markets[1] (normally BTC-EUR, ETH-EUR). At bar t (closes up to t only, B aligned
"as of" t):

1. Gate per coin: on while MACD(fast, slow) of its own closes > the signal EMA(signal) of that line (the macd_trend
   rule; the slow ETH 1d setting 12/~180/30 is the fleet's strongest single-coin trend signal).
2. Leader from r = B / A: B leads while EMA(r, ratioFast) > EMA(r, ratioSlow), else A (ratioFast = 1 uses r).
3. Weights (times maxWeight): both on -> leader 0.5 + 0.5 * tilt, other 0.5 - 0.5 * tilt; one on -> ``solo``;
   none -> cash.

Why: in pair_band the ETH/BTC tilt was worth ~7 score points while its SMA band gate added little (finding #151);
the slow MACD is a better exit on ETH (findings #101, #109).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, max_weight, pct, risk_steps, union_index

NAME = "pair_macd"
VERSION = 1
TITLE = "BTC/ETH pair with MACD gates and ratio tilt"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"fast": 12, "slow": 180, "signal": 30, "ratioFast": 10, "ratioSlow": 50, "tilt": 0.5, "solo": 1.0}


def param_space() -> dict:
    return {
        "fast": {"type": "int", "min": 2, "max": 60, "log": True, "description": "fast EMA of the MACD"},
        "slow": {"type": "int", "min": 20, "max": 500, "log": True, "description": "slow EMA of the MACD"},
        "signal": {"type": "int", "min": 3, "max": 80, "log": True, "description": "signal EMA of the MACD line"},
        "ratioFast": {"type": "int", "min": 1, "max": 100, "log": True,
                      "description": "fast EMA of the ETH/BTC ratio (1 = the ratio itself)"},
        "ratioSlow": {"type": "int", "min": 3, "max": 400, "log": True,
                      "description": "slow EMA of the ETH/BTC ratio"},
        "tilt": {"type": "float", "min": 0.0, "max": 1.0,
                 "description": "extra share for the ratio leader when both coins trend (0 = 50/50, 1 = all)"},
        "solo": {"type": "choice", "values": [0.5, 1.0],
                 "description": "money for the one coin still trending when the other is off"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["fast"]) >= int(p["slow"]):
        return "fast must be shorter than slow"
    if int(p["ratioFast"]) >= int(p["ratioSlow"]):
        return "ratioFast must be shorter than ratioSlow"
    return None


def warmup(p: dict) -> int:
    return max(int(p["slow"]) + int(p["signal"]) - 2, int(p["ratioSlow"]) - 1)


def gate(c: np.ndarray, p: dict) -> np.ndarray:
    line, sig, _ = ind.macd(c, int(p["fast"]), int(p["slow"]), int(p["signal"]))
    return np.where(np.isfinite(line) & np.isfinite(sig), (line > sig).astype(float), np.nan)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if len(markets) != 2:
        raise ValueError(f"pair_macd trades exactly two markets, got {markets}")
    a_m, b_m = markets
    idx = union_index(candles, markets)
    a, b = aligned_close(candles, a_m, idx), aligned_close(candles, b_m, idx)
    ga, gb = gate(a, p), gate(b, p)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = b / a
    rf = r if int(p["ratioFast"]) == 1 else ind.ema(r, int(p["ratioFast"]))
    rs = ind.ema(r, int(p["ratioSlow"]))
    warm = np.isfinite(ga) & np.isfinite(gb) & np.isfinite(rf) & np.isfinite(rs)
    b_leads = rf > rs
    mw, tilt, solo = max_weight(spec), float(p["tilt"]), float(p["solo"])
    hi, lo = 0.5 + 0.5 * tilt, 0.5 - 0.5 * tilt
    on_a, on_b = ga == 1.0, gb == 1.0
    both = on_a & on_b
    wa = np.where(both, np.where(b_leads, lo, hi), np.where(on_a, solo, 0.0))
    wb = np.where(both, np.where(b_leads, hi, lo), np.where(on_b, solo, 0.0))
    return frame(idx, {a_m: np.where(warm, wa * mw, np.nan), b_m: np.where(warm, wb * mw, np.nan)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    a, b = [m.split("-")[0] for m in spec.get("markets") or ["BTC-EUR", "ETH-EUR"]]
    tilt = float(p["tilt"])
    steps = [
        f"After every {iv} candle it computes a MACD for {a} and for {b}: the {bars_text(p['fast'], iv)} average price "
        f"minus the {bars_text(p['slow'], iv)} average, compared with its own {bars_text(p['signal'], iv)} average. "
        "A coin counts as trending while its MACD line is above that signal line.",
        f"It also watches the {b}/{a} price ratio (fast average over {bars_text(p['ratioFast'], iv)} versus slow over "
        f"{bars_text(p['ratioSlow'], iv)}) to see which coin is currently the stronger one.",
        f"With both coins trending it holds {pct(0.5 + 0.5 * tilt)} in the stronger one and "
        f"{pct(0.5 - 0.5 * tilt)} in the other.",
        ("With only one coin trending, all the money goes into that coin." if float(p["solo"]) >= 1 else
         "With only one coin trending, it holds half the money in that coin and half in euros."),
        "With neither trending, everything is in euros.",
    ]
    return {
        "summary": f"Holds {a} and {b} while their momentum is up, leaning towards whichever is gaining on the other, "
                   "and moves to euros when both lose momentum.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Long bull markets where one of the two clearly leads, followed by long declines it can sit out.",
        "whenItLoses": "Sideways markets where momentum and the leader keep flipping, each flip costing fees.",
    }
