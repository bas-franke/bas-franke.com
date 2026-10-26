"""mayer_cycle v1 (agent-10, long lane): size each coin by how stretched its price is versus a long cycle average.

Mayer multiple M = close / SMA(sma) of the coin's own closes (the classic BTC cycle gauge uses the 200-day SMA).
The coin's share of its slot is a straight line in M: full (1.0) at or below ``cheap``, ``floorWeight`` at or above
``rich``, linear in between, rounded down to steps of ``step``. So it holds most when the coin is cheap versus its
cycle average and trims into euphoric rallies (rebalancing back as the multiple changes).

Optional cycle filter ``slopeBars`` (0 = off): only hold while the SMA itself is higher than ``slopeBars`` candles
ago (the long average is rising = bull phase of the cycle); otherwise cash.

Multi-market: every market in spec.markets gets maxWeight / len(markets) times its own share. All values use
closes up to and including bar t (other markets aligned "as of" t, a missing bar carries the previous close).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "mayer_cycle"
VERSION = 1
TITLE = "Cycle valuation sizing (Mayer multiple)"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"sma": 200, "cheap": 0.9, "rich": 2.0, "floorWeight": 0.2, "slopeBars": 0, "step": 0.1}


def param_space() -> dict:
    return {
        "sma": {"type": "int", "min": 30, "max": 400, "log": True,
                "description": "length of the long cycle average in candles"},
        "cheap": {"type": "float", "min": 0.5, "max": 1.2,
                  "description": "price/average multiple at or below which the coin is held in full"},
        "rich": {"type": "float", "min": 1.05, "max": 3.0,
                 "description": "price/average multiple at or above which only floorWeight is held"},
        "floorWeight": {"type": "float", "min": 0.0, "max": 0.8,
                        "description": "share of the slot still held when the price is rich"},
        "slopeBars": {"type": "int", "min": 5, "max": 120, "zero": True, "log": True,
                      "description": "only hold while the average is higher than this many candles ago (0 = off)"},
        "step": {"type": "choice", "values": [0.05, 0.1, 0.2, 0.25, 0.5],
                 "description": "sizes are rounded down to this step so it does not trade on tiny changes"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["cheap"]) < float(p["rich"]) else "cheap must be below rich"


def warmup(p: dict) -> int:
    return int(p["sma"]) - 1 + int(p.get("slopeBars") or 0)


def share(mult: np.ndarray, p: dict) -> np.ndarray:
    """Share of the slot (0..1) for a Mayer multiple, before the step rounding."""
    lo, hi, fl = float(p["cheap"]), float(p["rich"]), float(p["floorWeight"])
    frac = np.clip((hi - mult) / (hi - lo), 0.0, 1.0)
    return fl + (1.0 - fl) * frac


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("mayer_cycle needs at least one market")
    idx = union_index(candles, markets)
    n_sma, slope = int(p["sma"]), int(p.get("slopeBars") or 0)
    step = float(p["step"])
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        s = ind.sma(c, n_sma)  # NaN until n_sma closes (and while NaN closes are inside the window)
        with np.errstate(divide="ignore", invalid="ignore"):
            mult = c / s
        ok = np.isfinite(mult) & (s > 0)
        w = np.floor(share(np.where(ok, mult, 1.0), p) / step + 1e-9) * step
        w = np.minimum(w, 1.0)
        if slope > 0:
            prev = np.full(s.shape, np.nan)
            prev[slope:] = s[:-slope]
            ok &= np.isfinite(prev)
            w = np.where(s > prev, w, 0.0)
        cols[m] = np.where(ok, w * each, np.nan)
    df = frame(idx, cols)
    if len(markets) > 1:
        # A market not yet listed (NaN) holds nothing; a row is only "undecided" when no market is warm yet.
        any_ok = df.notna().any(axis=1).to_numpy()
        df = df.fillna(0.0)
        df[~any_ok] = np.nan
    return df


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = [
        f"After every {iv} candle it divides the price of {mk} by its average over the last "
        f"{bars_text(p['sma'], iv)} (the 'Mayer multiple': 1.0 means the price sits on its long-term average).",
        f"At a multiple of {p['cheap']:.2f} or lower it holds the coin in full; at {p['rich']:.2f} or higher it holds "
        f"only {pct(p['floorWeight'])} of it; in between the size slides down in a straight line. So it buys more "
        "when the coin is cheap compared to its cycle and sells some into overheated rallies.",
        f"Sizes are rounded down to steps of {pct(p['step'])}, so it only rebalances on real moves.",
    ]
    if len(spec.get("markets") or []) > 1:
        steps.append(f"The money is split evenly between {mk}; each coin is sized on its own multiple.")
    if p.get("slopeBars"):
        steps.append(f"Cycle filter: it only holds while the long average is higher than {bars_text(p['slopeBars'], iv)}"
                     " ago (a rising average = bull phase); in a falling cycle everything goes to euros.")
    return {
        "summary": f"Holds {mk} in a size that depends on how far the price is above its long-term average: more when "
                   "cheap, less when overheated" + (", and nothing while the cycle points down." if p.get("slopeBars")
                                                    else "."),
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Big boom-and-bust cycles: it trims near euphoric tops and has bought back cheaper, so the fall "
                      "from the top hurts less than holding.",
        "whenItLoses": "Long, steady bull runs far above the average: it holds a reduced size the whole way up; and "
                       "without the cycle filter it keeps buying all the way down a long bear market.",
    }
