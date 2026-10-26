"""sweep_exit_a18 v1 (agent-18): hold BTC/ETH (optionally only above an SMA core), but step aside for a while after
a "low sweep": a candle whose low takes out the lowest low of the previous N candles.

Market-structure idea: stops cluster just under recent swing lows. A candle that runs those stops (new N-bar low)
and still closes back above the old low is read by chart traders as a bullish "spring"/"turtle soup"; the
unrecorded study (1d pre-holdout 2019-03..2025-10, fwd 30 d vs the year's average) says the opposite. In an uptrend
(close > SMA100) a failed breakdown under the 10-day low was followed by a weaker month in 7/7 years on BTC
(mean -7.6 pts) and 6/7 on ETH (-12 pts), weaker than plain new lows: the first crack in a trend.

- event at bar t: low_t < min(low[t-N .. t-1]); mode "failed" also needs close_t > that old low, "any" doesn't.
- gateLen > 0: the event only counts while close_t > SMA(gateLen) (sweeps inside an uptrend).
- after an event the strategy is out for outBars candles (a new event restarts the clock).
- coreLen > 0: outside sweep windows hold only while close > SMA(coreLen); 0 = hold.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "sweep_exit_a18"
VERSION = 1
TITLE = "Hold, step aside after a sweep of the recent lows"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"lowLen": 10, "mode": "failed", "gateLen": 100, "outBars": 20, "coreLen": 0}


def param_space() -> dict:
    return {
        "lowLen": {"type": "int", "min": 3, "max": 120, "log": True,
                   "description": "a sweep is a low under the lowest low of this many previous candles"},
        "mode": {"type": "choice", "values": ["failed", "any"],
                 "description": "failed = the candle closes back above the old low; any = every new low counts"},
        "gateLen": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                    "description": "sweeps count only while the close is above this SMA (0 = always)"},
        "outBars": {"type": "int", "min": 1, "max": 120, "log": True,
                    "description": "candles spent in cash after a sweep"},
        "coreLen": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                    "description": "otherwise hold only while the close is above this SMA (0 = always hold)"},
    }


def warmup(p: dict) -> int:
    return max(int(p["lowLen"]) + 1, int(p["gateLen"]), int(p["coreLen"]))


def sweep_events(low: np.ndarray, close: np.ndarray, n: int, mode: str) -> np.ndarray:
    """Boolean per bar (NaN-free): bar t sweeps the lowest low of bars t-n..t-1. Uses data up to bar t only."""
    prior = ind.prior_min(low, n)
    ev = np.isfinite(prior) & (low < prior)
    if mode == "failed":
        ev &= close > prior
    return ev


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    lo = df["low"].to_numpy(np.float64)
    n, out_bars = int(p["lowLen"]), int(p["outBars"])
    ev = sweep_events(lo, c, n, str(p["mode"]))
    ready = np.zeros(len(c), bool)
    ready[n:] = True
    g_len = int(p["gateLen"])
    if g_len > 0:
        g = ind.sma(c, g_len)
        ev &= np.isfinite(g) & (c > g)
        ready &= np.isfinite(g)
    base = np.ones(len(c))
    k_len = int(p["coreLen"])
    if k_len > 0:
        k = ind.sma(c, k_len)
        base = np.where(np.isfinite(k), (c > k).astype(np.float64), np.nan)
        ready &= np.isfinite(k)
    w = np.full(len(c), np.nan)
    left = 0
    for i in range(len(c)):
        if ev[i]:
            left = out_bars
        if ready[i]:
            w[i] = 0.0 if left > 0 else base[i]
        if left > 0:
            left -= 1
    return frame(df.index, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    kind = ("dips under the lowest low of the previous " + bars_text(p["lowLen"], iv) + " and still closes back above it"
            if p["mode"] == "failed" else "dips under the lowest low of the previous " + bars_text(p["lowLen"], iv))
    steps = [f"It holds {mk}" + (f" while the price is above its average over {bars_text(p['coreLen'], iv)}"
                                if int(p["coreLen"]) > 0 else "") + ".",
             f"When a candle {kind}, it sells and stays in euros for {bars_text(p['outBars'], iv)}: running the stops "
             f"under recent lows is often the first crack in a rally."]
    if int(p["gateLen"]) > 0:
        steps.append(f"Only sweeps while the price is above its average over {bars_text(p['gateLen'], iv)} count.")
    return {
        "summary": f"Holds {mk}, but steps aside for a while after the price sweeps its recent lows.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Rallies that crack: the first stop-run under recent lows comes before a bigger fall.",
        "whenItLoses": "Healthy bull markets with sharp shake-outs: it sells the dip and misses the rebound.",
    }
