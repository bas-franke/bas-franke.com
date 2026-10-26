"""pair_band v1 (agent-05, regime lane): BTC + ETH with a per-coin trend gate (hysteresis band) and an ETH/BTC tilt.

Two markets, base A = markets[0], other B = markets[1] (normally BTC-EUR, ETH-EUR). At bar t (closes up to t only,
B aligned "as of" t):

1. Trend gate per coin, with hysteresis: state turns on when close > MA * (1 + band) (and, if slopeBars > 0, the MA
   is higher than slopeBars candles ago), off when close < MA * (1 - band); in between it keeps its state.
   MA = SMA or EMA(close, ma) of the coin's own closes.
2. Leader from the ratio r = B / A: B leads while EMA(r, ratioFast) > EMA(r, ratioSlow), else A leads
   (ratioFast = 1 uses r itself).
3. Weights (times maxWeight):
   - both on:  leader 0.5 + 0.5 * tilt, the other 0.5 - 0.5 * tilt (tilt 0 = 50/50, 1 = all in the leader);
   - one on:   that coin gets ``solo`` (0.5 = its own half only, 1.0 = all the money);
   - none on:  cash.

Why: the ETH/BTC ratio switch beats 50/50 holding by +2.5..+8 %/fold but keeps 20-35 % drawdowns (finding #36), and a
plain per-coin SMA cash filter whipsaws away the edge (#47). A band gate trades much less around the average.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, max_weight, pct, risk_steps, union_index

NAME = "pair_band"
VERSION = 1
TITLE = "BTC/ETH pair with trend band and ratio tilt"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"ma": 150, "maType": "sma", "band": 0.03, "slopeBars": 0, "ratioFast": 10, "ratioSlow": 50,
            "tilt": 0.5, "solo": 1.0}


def param_space() -> dict:
    return {
        "ma": {"type": "int", "min": 10, "max": 600, "log": True,
               "description": "length of each coin's trend average in candles"},
        "maType": {"type": "choice", "values": ["sma", "ema"], "description": "simple or exponential trend average"},
        "band": {"type": "float", "min": 0.0, "max": 0.15,
                 "description": "buy above average*(1+band), sell below average*(1-band)"},
        "slopeBars": {"type": "int", "min": 2, "max": 120, "zero": True, "log": True,
                      "description": "only switch a coin on while its average is higher than this many candles ago"},
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
    return None if int(p["ratioFast"]) < int(p["ratioSlow"]) else "ratioFast must be shorter than ratioSlow"


def warmup(p: dict) -> int:
    return max(int(p["ma"]) - 1 + int(p.get("slopeBars") or 0), int(p["ratioSlow"]) - 1)


def gate_states(c: np.ndarray, p: dict) -> np.ndarray:
    n, band, slope = int(p["ma"]), float(p["band"]), int(p.get("slopeBars") or 0)
    m = ind.sma(c, n) if p["maType"] == "sma" else ind.ema(c, n)
    prev = np.full(m.shape, np.nan)
    if slope > 0:
        prev[slope:] = m[:-slope]
    out = np.full(c.shape, np.nan)
    st = 0.0
    for i in range(len(c)):
        if not (np.isfinite(m[i]) and np.isfinite(c[i])) or (slope > 0 and not np.isfinite(prev[i])):
            continue
        if st == 0.0:
            if c[i] > m[i] * (1 + band) and (slope == 0 or m[i] > prev[i]):
                st = 1.0
        elif c[i] < m[i] * (1 - band):
            st = 0.0
        out[i] = st
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if len(markets) != 2:
        raise ValueError(f"pair_band trades exactly two markets, got {markets}")
    a_m, b_m = markets
    idx = union_index(candles, markets)
    a, b = aligned_close(candles, a_m, idx), aligned_close(candles, b_m, idx)
    sa, sb = gate_states(a, p), gate_states(b, p)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = b / a
    rf = r if int(p["ratioFast"]) == 1 else ind.ema(r, int(p["ratioFast"]))
    rs = ind.ema(r, int(p["ratioSlow"]))
    warm = np.isfinite(sa) & np.isfinite(sb) & np.isfinite(rf) & np.isfinite(rs)
    b_leads = rf > rs
    mw, tilt, solo = max_weight(spec), float(p["tilt"]), float(p["solo"])
    hi, lo = 0.5 + 0.5 * tilt, 0.5 - 0.5 * tilt
    on_a, on_b = sa == 1.0, sb == 1.0
    both = on_a & on_b
    wa = np.where(both, np.where(b_leads, lo, hi), np.where(on_a, solo, 0.0))
    wb = np.where(both, np.where(b_leads, hi, lo), np.where(on_b, solo, 0.0))
    wa = np.where(warm, wa * mw, np.nan)
    wb = np.where(warm, wb * mw, np.nan)
    return frame(idx, {a_m: wa, b_m: wb})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    a, b = [m.split("-")[0] for m in spec.get("markets") or ["BTC-EUR", "ETH-EUR"]]
    kind = "simple" if p["maType"] == "sma" else "exponential"
    tilt = float(p["tilt"])
    steps = [
        f"After every {iv} candle it checks for {a} and for {b} whether the price is clearly above its {kind} average "
        f"over {bars_text(p['ma'], iv)}: a coin switches on once it closes {pct(p['band'])} above it and off once it "
        f"closes {pct(p['band'])} below it, so small wiggles around the average cause no trades.",
        f"It also watches the {b}/{a} price ratio (fast average over {bars_text(p['ratioFast'], iv)} versus slow over "
        f"{bars_text(p['ratioSlow'], iv)}) to see which of the two is currently the stronger coin.",
        f"With both coins switched on it holds {pct(0.5 + 0.5 * tilt)} in the stronger one and "
        f"{pct(0.5 - 0.5 * tilt)} in the other.",
        ("With only one coin switched on, all the money goes into that coin." if float(p["solo"]) >= 1 else
         "With only one coin switched on, it holds half the money in that coin and half in euros."),
        "With neither switched on, everything is in euros.",
    ]
    if p.get("slopeBars"):
        steps.insert(1, f"A coin only switches on while its average is higher than {bars_text(p['slopeBars'], iv)} ago.")
    return {
        "summary": f"Holds {a} and {b} while they are in an uptrend, leaning towards whichever is gaining on the other, "
                   "and moves to euros when both trends break.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Long bull markets where one of the two clearly leads, followed by long bear markets it can sit out.",
        "whenItLoses": "Sideways years where prices cross their averages back and forth and the leader keeps changing.",
    }
