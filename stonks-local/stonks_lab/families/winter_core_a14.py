"""winter_core_a14 v1 (agent-14): SMA trend core plus an "alt winter" hold zone from the 2019 altcoin pool.

Idea: a cross-asset value zone. When the old altcoins (alt_froth.OLD_ALTS, all listed on Bitvavo by 2019, so no
hindsight in the list) are typically far under their multi-year high, the whole crypto market is deep in a bear
market and late sellers are gone. A plain SMA core sits in euros exactly then and buys back late; this family keeps
holding the traded coin through such an "alt winter", whatever the coin's own trend says.

- dd_a,t = 1 - close_a,t / max(close_a over the last ``highLen`` bars) for every pool alt a (needs 200 bars);
  the traded market itself is left out of the pool (so the family can be tested on alts, #686).
- winter_t = median over the pool of dd_a,t >= ``depth`` (needs >= 5 pool alts with data).
- hold while close > SMA(``coreSma``) OR winter_t. ``coreSma`` 0 = winter zone only (cash otherwise).

Screen behind it (agent-14 w9, unrecorded, gross 0.2 %/switch, eval fold layout, pre-holdout, 11 old alts): BTC SMA50
core -19.0 -> -10.5..-12.0 with highLen 730-1000 / depth 0.8 (hold -16.8), beating 98 % of 200 random zones of the
same size and spell count added to the same core; ETH SMA50 -27.7 -> -19.6..-22.7 (78-86 % of random zones).
Other markets are aligned "as of" the bar time, so a decision at bar t uses nothing after t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, max_weight, pct, risk_steps, single_market
from .alt_froth import OLD_ALTS, _asof

NAME = "winter_core_a14"
VERSION = 1
TITLE = "Trend core that keeps holding through an altcoin winter"
BOT_READY = False
MULTI_MARKET = False
MIN_POOL = 5
MIN_BARS = 200


def default_params() -> dict:
    return {"highLen": 1000, "depth": 0.8, "coreSma": 50}


def param_space() -> dict:
    return {
        "highLen": {"type": "int", "min": 250, "max": 1500, "log": True,
                    "description": "candles over which each old altcoin's high is taken"},
        "depth": {"type": "float", "min": 0.4, "max": 0.95,
                  "description": "alt winter when the typical old altcoin is at least this far under its high"},
        "coreSma": {"type": "int", "min": 0, "max": 300, "zero": True,
                    "description": "SMA trend core (0 = winter zone only, euros otherwise)"},
    }


def warmup(p: dict) -> int:
    return max(MIN_BARS, int(p["coreSma"]))


def required_markets(spec: dict) -> list[str]:
    return list(OLD_ALTS)


def winter_depth(candles: dict, idx: np.ndarray, high_len: int, skip: str | None = None) -> np.ndarray:
    """Median drawdown of the pool alts from their ``high_len``-bar high, on idx; NaN with < MIN_POOL alts."""
    cols = []
    for m in OLD_ALTS:
        if m == skip or m not in candles or len(candles[m]) == 0:
            continue
        c = pd.Series(candles[m]["close"].to_numpy(np.float64))
        hi = c.rolling(int(high_len), min_periods=MIN_BARS).max().to_numpy()
        cols.append(_asof(candles[m], 1.0 - c.to_numpy() / hi, idx))
    if not cols:
        return np.full(len(idx), np.nan)
    D = np.column_stack(cols)
    ok = np.isfinite(D).sum(axis=1) >= MIN_POOL
    out = np.full(len(idx), np.nan)
    if ok.any():
        out[ok] = np.nanmedian(D[ok], axis=1)
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    idx = np.asarray(df.index, dtype=np.int64)
    c = df["close"].to_numpy(np.float64)
    dd = winter_depth(candles, idx, int(p["highLen"]), skip=m)
    winter = np.where(np.isfinite(dd), (dd >= float(p["depth"])).astype(np.float64), np.nan)
    sma_n = int(p.get("coreSma") or 0)
    if sma_n:
        s = ind.sma(c, sma_n)
        core = np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan)
    else:
        core = np.zeros(len(c))
    w = np.fmax(core, winter)  # NaN only where both are undecided
    w[~(np.isfinite(core) & np.isfinite(winter))] = np.nan
    return frame(idx, {m: w * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    m = (spec.get("markets") or ["?"])[0].replace("-EUR", "")
    sma_n = int(p.get("coreSma") or 0)
    steps = []
    if sma_n:
        steps.append(f"It holds {m} while the price is above its {bars_text(sma_n, iv)} average and sits in euros "
                     "below it.")
    else:
        steps.append(f"It sits in euros by default.")
    steps.append(f"After every {iv} candle it also checks nine altcoins that already traded in 2019 (XRP, ADA, LINK, "
                 f"TRX, LTC, BCH, XLM, XTZ, IOTA): when the typical one is more than {pct(float(p['depth']))} under its "
                 f"high of the last {bars_text(p['highLen'], iv)}, the market is in an 'alt winter'.")
    steps.append(f"During an alt winter it holds {m} whatever its own trend says, so it is already in when the "
                 "next recovery starts.")
    return {
        "summary": f"Follows {m}'s trend, but keeps holding through deep altcoin bear markets (buying the winter).",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bear-market bottoms: it is back in early, before the price climbs over its average again.",
        "whenItLoses": "Long, grinding bear markets that keep falling after the altcoins are already down a lot "
                       "(holding through the last leg down).",
    }
