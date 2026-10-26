"""beta_shift v1 (agent-12): BTC trend core that moves into ether (the higher-beta coin) while the bull is hot.

Finding #373: de-risking alone can't beat holding BTC, a strategy must also add return in bull folds. With spot and
no leverage the only way to get more than 100 % BTC upside is to hold something that rises faster in a bull. Ether
has a beta of ~1.2-1.5 to bitcoin, so this family keeps BTC as the base and shifts into ETH only while the market is
"hot", and goes to euros (or a reduced BTC weight) when BTC is below its trend average.

On every timestamp t of the union of BTC-EUR's and ETH-EUR's candles (a missing bar carries the previous close),
using only closes up to t:
- risk-on  = BTC close > SMA(BTC, coreSma)   (coreSma = 0: always risk-on)
- hot (only while risk-on), by `heat`:
    "eth_sma": ETH close > SMA(ETH, heatLen) * (1 + heatThr)        (ether is in its own uptrend)
    "mom":     ln(BTC_t / BTC_{t-heatLen}) > heatThr                 (bitcoin is running)
    "ratio":   ETH/BTC > SMA(ETH/BTC, heatLen) * (1 + heatThr)       (ether is outrunning bitcoin)
- weights (x maxWeight): hot -> ETH ethShare, BTC 1 - ethShare; risk-on, not hot -> BTC 1;
  risk-off -> BTC offWeight, ETH 0.
Rows before the SMAs / lookbacks are defined are NaN.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, max_weight, pct, risk_steps, union_index

NAME = "beta_shift"
VERSION = 1
TITLE = "BTC core, shift into ETH while the bull is hot"
BOT_READY = False
MULTI_MARKET = True
PAIR = ("BTC-EUR", "ETH-EUR")


def default_params() -> dict:
    return {"coreSma": 130, "heat": "eth_sma", "heatLen": 50, "heatThr": 0.0, "ethShare": 1.0, "offWeight": 0.0}


def param_space() -> dict:
    return {
        "coreSma": {"type": "int", "min": 20, "max": 600, "log": True, "zero": True,
                    "description": "risk-on while BTC closes above this SMA (0 = always risk-on)"},
        "heat": {"type": "choice", "values": ["eth_sma", "mom", "ratio"],
                 "description": "what makes the bull 'hot': ETH above its SMA, BTC momentum, or ETH/BTC above its SMA"},
        "heatLen": {"type": "int", "min": 5, "max": 400, "log": True,
                    "description": "length of the heat signal (SMA length or momentum lookback in candles)"},
        "heatThr": {"type": "float", "min": 0.0, "max": 0.6,
                    "description": "how far above the SMA (fraction) or how big the BTC log return must be"},
        "ethShare": {"type": "float", "min": 0.3, "max": 1.0,
                     "description": "share of the money in ETH while hot (the rest stays in BTC)"},
        "offWeight": {"type": "float", "min": 0.0, "max": 1.0,
                      "description": "BTC weight kept while BTC is below its trend SMA (0 = all euros)"},
    }


def warmup(p: dict) -> int:
    return max(int(p.get("coreSma") or 0), int(p["heatLen"]) + (1 if p["heat"] == "mom" else 0)) - 1


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if sorted(markets) != sorted(PAIR):
        raise ValueError(f"beta_shift trades exactly {list(PAIR)}, got {markets}")
    core_n, heat, hl = int(p.get("coreSma") or 0), p["heat"], int(p["heatLen"])
    thr, share, off = float(p["heatThr"]), float(p["ethShare"]), float(p["offWeight"])
    idx = union_index(candles, markets)
    n = len(idx)
    btc = aligned_close(candles, "BTC-EUR", idx)
    eth = aligned_close(candles, "ETH-EUR", idx)
    ok = np.isfinite(btc) & np.isfinite(eth)
    if core_n > 0:
        core_sma = ind.sma(btc, core_n)
        ok &= np.isfinite(core_sma)
        with np.errstate(invalid="ignore"):
            on = btc > core_sma
    else:
        on = np.ones(n, dtype=bool)
    with np.errstate(invalid="ignore", divide="ignore"):
        if heat == "eth_sma":
            ref = ind.sma(eth, hl)
            ok &= np.isfinite(ref)
            hot = eth > ref * (1 + thr)
        elif heat == "mom":
            prev = np.full(n, np.nan)
            if n > hl:
                prev[hl:] = btc[:-hl]
            ok &= np.isfinite(prev)
            hot = np.log(btc / prev) > thr
        elif heat == "ratio":
            ratio = eth / btc
            ref = ind.sma(ratio, hl)
            ok &= np.isfinite(ref)
            hot = ratio > ref * (1 + thr)
        else:
            raise ValueError(f"unknown heat {heat!r}")
    hot = hot & on
    mw = max_weight(spec)
    wb = np.where(hot, 1 - share, np.where(on, 1.0, off)) * mw
    we = np.where(hot, share, 0.0) * mw
    wb[~ok] = np.nan
    we[~ok] = np.nan
    cols = {"BTC-EUR": wb, "ETH-EUR": we}
    return frame(idx, {m: cols[m] for m in markets})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    core_n, heat, hl = int(p.get("coreSma") or 0), p["heat"], int(p["heatLen"])
    thr, share, off = float(p["heatThr"]), float(p["ethShare"]), float(p["offWeight"])
    steps = []
    if core_n > 0:
        steps.append(f"After every {iv} candle it checks whether bitcoin is above its average price of the last "
                     f"{bars_text(core_n, iv)}. Below it, it keeps "
                     + ("only euros." if off <= 0 else f"{pct(off)} in bitcoin and the rest in euros."))
    else:
        steps.append("It is always invested; bitcoin is the default holding.")
    hot_text = {
        "eth_sma": f"ether is above its own average of the last {bars_text(hl, iv)}"
                   + (f" by more than {pct(thr)}" if thr > 0 else ""),
        "mom": f"bitcoin rose more than {pct(np.exp(thr) - 1)} over the last {bars_text(hl, iv)}",
        "ratio": f"ether has been gaining on bitcoin (the ETH/BTC price ratio is above its {bars_text(hl, iv)} "
                 "average" + (f" by more than {pct(thr)}" if thr > 0 else "") + ")",
    }[heat]
    steps.append(f"While bitcoin is in its uptrend it holds bitcoin, but when {hot_text} it calls the bull 'hot' and "
                 f"moves {pct(share)} of the money into ether, which tends to rise faster than bitcoin in strong "
                 "bull markets.")
    steps.append("When the heat fades it moves back to bitcoin; when bitcoin falls below its average it steps out.")
    return {
        "summary": "Holds bitcoin in an uptrend, swaps into the faster-moving ether while the bull market is hot, "
                   "and steps aside when bitcoin's trend breaks.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Strong bull markets in which ether outruns bitcoin (like 2020-21), plus long bear markets "
                      "it sits out.",
        "whenItLoses": "Bull markets led by bitcoin while ether lags (like 2023-24), and choppy markets around "
                       "the trend average where every switch costs fees.",
    }
