"""powerlaw_band v1 (agent-04, reversion lane): position from the coin's distance to its long-run power-law trend.

The "power-law corridor" models log(price) as a straight line in log(days since the coin's genesis block):
log c = a + slope * log(days). This family measures how far the close is from that line, in standard deviations
of the residual, using only candles up to and including the current bar (an expanding fit over every candle since
the series starts):

- x_t = ln(days from genesis to bar t's open time), y_t = ln(close_t).
- slope 0 = fitted: b_t = expanding OLS slope of y on x, residual r_t = y_t - (mean_t(y) - b_t * mean_t(x)) - b_t*x_t,
  sd_t = expanding OLS residual sd. slope > 0 = fixed (e.g. 5.8, the BTC corridor slope published in early 2019):
  r_t = y_t - slope * x_t minus its expanding mean, sd_t = its expanding sd.
- z_t = r_t / sd_t; NaN (no decision) until ``minHist`` candles of history.

Rules at bar t (state persists bar to bar):
- core: in while close >= SMA(close, coreSma) (coreSma 0 = always in, i.e. hold by default);
- rich (richZ > 0): set when z >= richZ, cleared when z < richZ - band; while rich the weight is 0;
- cheap (cheapZ < 0): set when z <= cheapZ, cleared when z > cheapZ + band; while cheap (and not rich) the weight
  is maxWeight even when the core is out.
weight = maxWeight if (core or cheap) and not rich else 0.
Genesis: BTC 2009-01-03, ETH 2015-07-30; any other coin uses one year before its first candle.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "powerlaw_band"
VERSION = 1
TITLE = "Power-law corridor"
BOT_READY = False
MULTI_MARKET = False

_GENESIS = {"BTC": "2009-01-03", "ETH": "2015-07-30"}
_DAY_MS = 86_400_000


def default_params() -> dict:
    return {"slope": 0.0, "minHist": 365, "richZ": 2.0, "cheapZ": 0.0, "band": 0.5, "coreSma": 0}


def param_space() -> dict:
    return {
        "slope": {"type": "float", "min": 2.0, "max": 7.0, "zero": True,
                  "description": "power-law slope of log price on log days since genesis (0 = fit it on the data so far)"},
        "minHist": {"type": "int", "min": 120, "max": 1200, "log": True,
                    "description": "candles of history before the corridor is trusted"},
        "richZ": {"type": "float", "min": 0.3, "max": 4.0, "zero": True,
                  "description": "step aside while the price is this many standard deviations above the line (0 = never)"},
        "cheapZ": {"type": "float", "min": -4.0, "max": -0.3, "zero": True,
                   "description": "hold even below the trend average while the price is this far under the line (0 = off)"},
        "band": {"type": "float", "min": 0.0, "max": 1.5,
                 "description": "hysteresis in standard deviations before a rich/cheap state ends"},
        "coreSma": {"type": "int", "min": 20, "max": 400, "log": True, "zero": True,
                    "description": "outside the rich/cheap zones hold only while the close is above this average (0 = always hold)"},
    }


def valid_params(p: dict) -> str | None:
    if not float(p.get("richZ") or 0) and not float(p.get("cheapZ") or 0):
        return "richZ and cheapZ can't both be off"
    if float(p.get("cheapZ") or 0) and not int(p.get("coreSma") or 0):
        return "cheapZ needs a coreSma (without a core it always holds anyway)"
    return None


def warmup(p: dict) -> int:
    return max(int(p["minHist"]), int(p.get("coreSma") or 0)) - 1


def _genesis_ms(market: str, first_ts: int) -> int:
    g = _GENESIS.get(market.split("-")[0])
    if g is None:
        return int(first_ts) - 365 * _DAY_MS
    return int(pd.Timestamp(g).value // 1_000_000)


def zscores(market: str, index: np.ndarray, close: np.ndarray, slope: float, min_hist: int) -> np.ndarray:
    """Expanding-fit residual z of log close on log days since genesis; NaN before ``min_hist`` candles."""
    idx = np.asarray(index, dtype=np.int64)
    days = np.maximum((idx - _genesis_ms(market, int(idx[0]))) / _DAY_MS, 1.0)
    x, y = np.log(days), np.log(close)
    k = np.arange(1, len(y) + 1, dtype=np.float64)
    if slope > 0:
        r = y - slope * x
        mr = np.cumsum(r) / k
        var = np.cumsum(r * r) / k - mr * mr
        res = r - mr
    else:
        mx, my = np.cumsum(x) / k, np.cumsum(y) / k
        vx = np.cumsum(x * x) / k - mx * mx
        cxy = np.cumsum(x * y) / k - mx * my
        vy = np.cumsum(y * y) / k - my * my
        with np.errstate(divide="ignore", invalid="ignore"):
            b = np.where(vx > 1e-18, cxy / vx, 0.0)
        res = y - (my - b * mx) - b * x
        var = vy - b * cxy
    with np.errstate(divide="ignore", invalid="ignore"):
        z = res / np.sqrt(np.maximum(var, 1e-18))
    z[: max(min_hist, 2) - 1] = np.nan
    return z


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    w = np.full(n, np.nan)
    first = warmup(p)
    if first >= n:
        return frame(df.index, {m: w})
    z = zscores(m, df.index, c, float(p.get("slope") or 0), int(p["minHist"]))
    cs = int(p.get("coreSma") or 0)
    core = (c >= ind.sma(c, cs)) if cs > 0 else np.ones(n, dtype=bool)
    rz, cz, band = float(p.get("richZ") or 0), float(p.get("cheapZ") or 0), float(p["band"])
    mw = max_weight(spec)
    rich = cheap = False
    zl, kl = z.tolist(), core.tolist()
    out = []
    for i in range(first, n):
        zi = zl[i]
        if rz > 0:
            rich = zi >= rz or (rich and zi >= rz - band)
        if cz < 0:
            cheap = zi <= cz or (cheap and zi <= cz + band)
        out.append(mw if (kl[i] or cheap) and not rich else 0.0)
    w[first:] = out
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    sl = float(p.get("slope") or 0)
    line = (f"a power-law line (log price rising {sl:g}x as fast as log time since the coin's first block)" if sl > 0
            else "a power-law line (log price against log time since the coin's first block) fitted on all prices so far")
    steps = [f"After every {iv} candle it compares the price of {mk} with {line}, and measures the gap in standard "
             "deviations of the past gaps."]
    cs = int(p.get("coreSma") or 0)
    steps.append(f"Normally it holds {mk} while the price is above its {bars_text(cs, iv)} average and sits in euros "
                 "below it." if cs > 0 else f"Normally it simply holds {mk}.")
    rz, cz, band = float(p.get("richZ") or 0), float(p.get("cheapZ") or 0), float(p["band"])
    if rz > 0:
        steps.append(f"When the price is {rz:g} standard deviations or more above the line (a bubble by this "
                     f"measure) it sells, and waits until the gap is back under {rz - band:g}.")
    if cz < 0:
        steps.append(f"When the price is {abs(cz):g} standard deviations or more below the line (cheap by this "
                     f"measure) it buys even in a downtrend, until the gap is back above {cz + band:g}.")
    return {
        "summary": f"Holds {mk} but uses its long-run power-law growth line as a valuation yardstick: steps aside "
                   "in bubbles and/or buys when it is historically cheap.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Cycles that overshoot the long-run trend and fall back to it, and deep bear markets that end "
                      "near the bottom of the corridor.",
        "whenItLoses": "When the growth line itself bends (the coin grows slower than its past), cheap keeps getting "
                       "cheaper, and bubbles that run much further than the past ones.",
    }
