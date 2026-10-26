"""macd_smooth v1: a committee of MACD trend voters on scaled spans, to test whether a MACD edge is a plateau or a cliff.

Each voter is a plain macd_trend (hold while MACD line > signal line). The voters use the centre spans
(fast, slow, signal) scaled by ``spread``: with ``voters=3`` all three spans are scaled jointly by 1/spread, 1 and
spread; with ``voters=9`` slow and signal are scaled independently (3 x 3 grid, fast fixed). ``mode=avg`` holds the
share of voters that are on (rounded down to whole thirds/ninths), ``mode=majority`` holds fully when more than half
are on. spread = 1 is a single MACD. Unlike macd_trend, slow may reach 600 candles so 12h/6h bars can use the
same wall-clock spans as a daily MACD.
"""
from __future__ import annotations

import math

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "macd_smooth"
VERSION = 1
TITLE = "Smoothed MACD committee"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"fast": 12, "slow": 180, "signal": 30, "spread": 1.3, "voters": 3, "mode": "avg"}


def param_space() -> dict:
    return {
        "fast": {"type": "int", "min": 2, "max": 120, "log": True, "description": "centre fast EMA length"},
        "slow": {"type": "int", "min": 10, "max": 600, "log": True, "description": "centre slow EMA length"},
        "signal": {"type": "int", "min": 2, "max": 150, "log": True, "description": "centre signal EMA length"},
        "spread": {"type": "float", "min": 1.0, "max": 2.0,
                   "description": "voters use the spans times 1/spread, 1 and spread (1 = a single MACD)"},
        "voters": {"type": "choice", "values": [3, 9],
                   "description": "3: all spans scaled together; 9: slow x signal grid with the fast span fixed"},
        "mode": {"type": "choice", "values": ["avg", "majority"],
                 "description": "avg: hold the share of voters that are on; majority: all in when most are on"},
    }


def _scales(spread: float) -> list[float]:
    return [1.0 / spread, 1.0, spread] if spread > 1.0 else [1.0]


def _voters(p: dict) -> list[tuple[int, int, int]]:
    f, s, g, sc = int(p["fast"]), int(p["slow"]), int(p["signal"]), _scales(float(p["spread"]))
    out = []
    if int(p["voters"]) == 3:
        for k in sc:
            out.append((max(2, round(f * k)), max(3, round(s * k)), max(2, round(g * k))))
    else:
        for ks in sc:
            for kg in sc:
                out.append((f, max(3, round(s * ks)), max(2, round(g * kg))))
    return out


def valid_params(p: dict) -> str | None:
    for f, s, _ in _voters(p):
        if f >= s:
            return "every voter's fast span must be shorter than its slow span (lower fast or spread)"
    return None


def warmup(p: dict) -> int:
    return max(s + g - 2 for _, s, g in _voters(p))


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    vs = _voters(p)
    on = np.zeros(len(c))
    ok = np.ones(len(c), dtype=bool)
    for f, s, g in vs:
        line, sig, _ = ind.macd(c, f, s, g)
        ok &= np.isfinite(line) & np.isfinite(sig)
        on += (line > sig).astype(np.float64)
    n = len(vs)
    if p["mode"] == "majority":
        share = (on * 2 > n).astype(np.float64)
    else:
        share = np.floor(on * 3.0 / n + 1e-9) / 3.0 if n == 9 else on / n
    w = share * max_weight(spec)
    w[~ok] = np.nan
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    vs = _voters(p)
    sp = float(p["spread"])
    if len(vs) == 1:
        committee = (f"It uses one MACD: the {bars_text(p['fast'], iv)} average minus the {bars_text(p['slow'], iv)} "
                     f"average, smoothed over {bars_text(p['signal'], iv)} for the signal line.")
    else:
        committee = (f"It runs {len(vs)} MACD 'voters' around a centre of {bars_text(p['fast'], iv)} fast, "
                     f"{bars_text(p['slow'], iv)} slow and {bars_text(p['signal'], iv)} signal, with the spans "
                     f"stretched or shrunk by up to {sp:.2f}x, so no single setting decides on its own.")
    if p["mode"] == "majority" or len(vs) == 1:
        rule = f"When {'most voters see' if len(vs) > 1 else 'the MACD line is above its signal line, it sees'} " \
               f"rising momentum, it holds {mk} fully; otherwise it holds euros."
    else:
        rule = (f"It holds a share of the money in {mk} equal to the share of voters that see rising momentum "
                f"(in steps of a third), and keeps the rest in euros.")
    return {
        "summary": f"A slow momentum strategy on {mk} that asks several MACD settings at once, so the decision does "
                   "not hinge on one lucky parameter choice.",
        "howItWorks": [
            committee,
            "A voter sees rising momentum when its MACD line (fast minus slow exponential average) is above its own "
            "smoothed signal line.",
            rule,
        ] + risk_steps(spec),
        "whenItWins": "Long trending moves that every speed of the committee agrees on, such as a multi-month bull or "
                      "bear market.",
        "whenItLoses": "Choppy sideways years, where the voters flip in and out and each change costs fees, and sharp "
                       "V-shaped reversals that the slow averages see late.",
    }
