"""btc_eth_ratio v1: hold BTC, ETH or cash depending on the trend of the ETH/BTC price ratio.

On every timestamp t of the union of BTC-EUR's and ETH-EUR's candles (a missing bar carries the previous close):
ratio = ETH close / BTC close. fastLine = EMA(ratio, fast) (fast = 1 is the ratio itself), slowLine =
EMA(ratio, slow). The leader is ETH when fastLine > slowLine * (1 + band), BTC when fastLine < slowLine * (1 - band),
otherwise the previous leader stays (hysteresis; the very first decision uses band 0).

The leader gets maxWeight * tilt, the other coin maxWeight * (1 - tilt) (tilt = 1 is a pure switch). With
absSma > 0 a coin is only held while its own close is above SMA(absSma) of its closes; a coin that fails the filter
has its share in euros (cash). Rows before the ratio EMAs and the filter SMAs are defined are NaN.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, max_weight, risk_steps, union_index

NAME = "btc_eth_ratio"
VERSION = 1
TITLE = "BTC/ETH relative strength switch"
BOT_READY = False
MULTI_MARKET = True
PAIR = ("BTC-EUR", "ETH-EUR")


def default_params() -> dict:
    return {"fast": 10, "slow": 50, "band": 0.0, "absSma": 0, "tilt": 1.0}


def param_space() -> dict:
    return {
        "fast": {"type": "int", "min": 1, "max": 200, "log": True,
                 "description": "EMA length of the ETH/BTC ratio's fast line (1 = the ratio itself)"},
        "slow": {"type": "int", "min": 3, "max": 1000, "log": True,
                 "description": "EMA length of the ETH/BTC ratio's slow line"},
        "band": {"type": "float", "min": 0.002, "max": 0.08, "log": True, "zero": True,
                 "description": "hysteresis: the fast line must clear the slow line by this fraction to switch"},
        "absSma": {"type": "int", "min": 10, "max": 1000, "log": True, "zero": True,
                   "description": "only hold a coin while it is above this SMA of its own price (0 = off)"},
        "tilt": {"type": "float", "min": 0.5, "max": 1.0,
                 "description": "share of the money in the leader; the rest goes to the other coin"},
    }


def valid_params(p: dict) -> str | None:
    return None if int(p["fast"]) < int(p["slow"]) else "fast must be shorter than slow"


def warmup(p: dict) -> int:
    return max(int(p["slow"]), int(p.get("absSma") or 0)) - 1


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if sorted(markets) != sorted(PAIR):
        raise ValueError(f"btc_eth_ratio trades exactly {list(PAIR)}, got {markets}")
    fast, slow, band = int(p["fast"]), int(p["slow"]), float(p.get("band") or 0.0)
    abs_n, tilt = int(p.get("absSma") or 0), float(p["tilt"])
    idx = union_index(candles, markets)
    n = len(idx)
    btc = aligned_close(candles, "BTC-EUR", idx)
    eth = aligned_close(candles, "ETH-EUR", idx)
    ratio = eth / btc
    f_line = ratio if fast == 1 else ind.ema(ratio, fast)
    s_line = ind.ema(ratio, slow)
    warm = np.isfinite(f_line) & np.isfinite(s_line)
    if abs_n > 0:
        b_sma, e_sma = ind.sma(btc, abs_n), ind.sma(eth, abs_n)
        b_ok, e_ok = btc > b_sma, eth > e_sma
        warm &= np.isfinite(b_sma) & np.isfinite(e_sma)
    else:
        b_ok = e_ok = np.ones(n, dtype=bool)
    mw = max_weight(spec)
    W = np.full((n, 2), np.nan)  # columns: BTC, ETH
    lead = 0  # 0 = BTC, 1 = ETH; set at the first warm bar
    started = False
    for t in range(n):
        if not warm[t]:
            if started:  # cannot happen after warm-up (EMAs/SMAs stay defined), but stay safe
                W[t] = W[t - 1]
            continue
        f, s = f_line[t], s_line[t]
        if not started:
            lead = 1 if f > s else 0
            started = True
        elif f > s * (1 + band):
            lead = 1
        elif f < s * (1 - band):
            lead = 0
        wb = mw * (tilt if lead == 0 else 1 - tilt)
        we = mw * (tilt if lead == 1 else 1 - tilt)
        W[t, 0] = wb if b_ok[t] else 0.0
        W[t, 1] = we if e_ok[t] else 0.0
    cols = {"BTC-EUR": W[:, 0], "ETH-EUR": W[:, 1]}
    return frame(idx, {m: cols[m] for m in markets})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    fast, slow, band = int(p["fast"]), int(p["slow"]), float(p.get("band") or 0.0)
    tilt = float(p["tilt"])
    line = ("the ETH/BTC price ratio itself" if fast == 1
            else f"the average ETH/BTC price ratio over the last {bars_text(fast, iv)}")
    steps = [
        f"After every {iv} candle it divides the ether price by the bitcoin price: when this ratio rises, ether is "
        "doing better than bitcoin.",
        f"It compares {line} with the longer average over {bars_text(slow, iv)}. Above it: ether is the leader. "
        "Below it: bitcoin is the leader.",
    ]
    if band > 0:
        steps.append(f"To avoid flip-flopping, it only switches when the difference is more than {band * 100:.1f} %.")
    if tilt >= 0.999:
        steps.append("It puts all the money in the leader and none in the other coin.")
    else:
        steps.append(f"It puts {tilt * 100:.0f} % of the money in the leader and {100 - tilt * 100:.0f} % in the "
                     "other coin.")
    if int(p.get("absSma") or 0) > 0:
        steps.append(f"Safety filter: a coin is only held while its price is above its "
                     f"{bars_text(p['absSma'], iv)} average; otherwise that share stays in euros.")
    return {
        "summary": "Switches between bitcoin and ether, holding whichever of the two has been gaining on the other"
                   + (", and goes to euros when the coin itself is falling." if int(p.get("absSma") or 0) > 0
                      else "."),
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long stretches where one of the two clearly outperforms the other (ether seasons, or bitcoin "
                      "dominance phases).",
        "whenItLoses": "Choppy periods where the lead changes back and forth: every switch costs fees and it tends "
                       "to switch just after the move.",
    }
