"""dca_gate v1: dollar-cost averaging into one or more coins, only while each coin is above a slow trend (agent-19).

The starting cash is split equally into one sleeve per market. Each sleeve runs a virtual, fee-free portfolio that
starts at the anchor bar a (first bar of the union index with ts >= start_time, else the first bar). For each bar
i >= a and each market with close c (aligned: a missing bar carries the previous close) and s = SMA(trendSma) of
those closes (trendSma = 0: the gate is always open):

1. gate = trendSma == 0 or (s defined and c > s).
2. Exit (only when exitOnGate; exitBand is its hysteresis): if the sleeve holds coins and s is defined and
   c < s * (1 - exitBand), sell all its coins at c; the sleeve's schedule restarts (its tranche becomes the sleeve's
   cash / tranches, counted again from 0 buys). No buy on an exit bar.
3. Otherwise, with k = bars since the anchor or the last restart: a scheduled buy is due when k % everyBars == 0.
   A due buy that meets a closed gate is postponed: it happens on the first later bar whose gate is open.
   At most `tranches` scheduled buys per (re)start.
   Dip add-on (dipPct > 0): when c <= max(closes of the last `lookback` bars) * (1 - dipPct) and the dip is armed,
   buy one extra tranche (also below the trend when dipIgnoresGate) and disarm until c is out of the dip again.
   A buy spends min(tranche * slices, sleeve cash).

weight(market) = maxWeight * sleeve coins * c / (total value of all sleeves). Bars before the anchor are NaN.
Everything at bar i uses closes up to and including bar i.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, anchor_index, bars_text, frame, market_names, max_weight, pct, risk_steps, \
    union_index

NAME = "dca_gate"
VERSION = 1
TITLE = "Trend-gated DCA"
BOT_READY = False
MULTI_MARKET = True
ANCHORED = True


def default_params() -> dict:
    return {"everyBars": 7, "tranches": 8, "trendSma": 100, "exitOnGate": True, "exitBand": 0.0,
            "dipPct": 0.0, "lookback": 30, "dipIgnoresGate": False}


def param_space() -> dict:
    return {
        "everyBars": {"type": "int", "min": 1, "max": 500, "log": True, "description": "candles between buys"},
        "tranches": {"type": "int", "min": 1, "max": 60, "log": True,
                     "description": "equal slices each coin's share of the cash is split into"},
        "trendSma": {"type": "int", "min": 10, "max": 400, "log": True, "zero": True,
                     "description": "only buy while the close is above this SMA (0 = plain DCA, never gated)"},
        "exitOnGate": {"type": "bool", "description": "sell the coin when it closes under the SMA (minus exitBand)"},
        "exitBand": {"type": "float", "min": 0.005, "max": 0.3, "log": True, "zero": True,
                     "description": "with exitOnGate: sell only when the close is this fraction under the SMA (hysteresis)"},
        "dipPct": {"type": "float", "min": 0.03, "max": 0.5, "log": True, "zero": True,
                   "description": "a drop of this fraction from the recent high close buys an extra slice (0 = off)"},
        "lookback": {"type": "int", "min": 3, "max": 400, "log": True, "description": "candles in the recent high"},
        "dipIgnoresGate": {"type": "bool", "description": "dip buys happen even under the SMA"},
    }


def valid_params(p: dict) -> str | None:
    if not int(p["trendSma"]) and bool(p["exitOnGate"]):
        return "an exit needs a trendSma"
    return None


def warmup(p: dict) -> int:
    return max(int(p["trendSma"]), int(p["lookback"]) if float(p["dipPct"]) else 0)


def _exits(p: dict) -> bool:
    return bool(int(p["trendSma"])) and bool(p["exitOnGate"])


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    a = anchor_index(idx, start_time)
    every, tranches = int(p["everyBars"]), int(p["tranches"])
    sma_n = int(p["trendSma"])
    band = float(p["exitBand"])
    exits = _exits(p)
    dip_pct = float(p["dipPct"])
    dip_mult = 1.0 - dip_pct
    dip_free = bool(p["dipIgnoresGate"])
    mw = max_weight(spec)
    nm = len(markets)

    closes = [aligned_close(candles, m, idx) for m in markets]
    smas = [ind.sma(c, sma_n).tolist() if sma_n else None for c in closes]
    highs = [pd_rolling_max(c, int(p["lookback"])).tolist() if dip_pct > 0 else None for c in closes]
    cls = [c.tolist() for c in closes]

    cash = [1.0 / nm] * nm
    coins = [0.0] * nm
    tranche = [cash[j] / tranches for j in range(nm)]
    start = [a] * nm          # bar of the last (re)start of each sleeve
    done = [0] * nm           # scheduled buys made since the (re)start
    owed = [False] * nm       # a due buy waits for the gate
    armed = [True] * nm
    w = np.full((n, nm), np.nan)
    for i in range(a, n):
        vals = [0.0] * nm
        for j in range(nm):
            c = cls[j][i]
            if c != c:  # not listed yet
                continue
            s = smas[j][i] if sma_n else None
            s_ok = s is not None and s == s
            gate = (not sma_n) or (s_ok and c > s)
            dip = False
            if dip_pct > 0:
                h = highs[j][i]
                dip = (h == h) and c <= h * dip_mult
            if exits and coins[j] > 0 and s_ok and c < s * (1.0 - band):
                cash[j] += coins[j] * c
                coins[j] = 0.0
                start[j], done[j], owed[j] = i, 0, False
                tranche[j] = cash[j] / tranches
            else:
                if (i - start[j]) % every == 0 and done[j] < tranches:
                    owed[j] = True
                slices = 0
                if owed[j] and gate:
                    slices += 1
                    done[j] += 1
                    owed[j] = False
                if dip and armed[j] and (gate or dip_free):
                    slices += 1
                    armed[j] = False
                spend = min(slices * tranche[j], cash[j])
                if spend > 1e-12:
                    coins[j] += spend / c
                    cash[j] -= spend
            if not dip:
                armed[j] = True
            vals[j] = coins[j] * c
        total = sum(cash) + sum(vals)
        for j in range(nm):
            w[i, j] = mw * vals[j] / total if total > 0 else 0.0
    return frame(idx, {m: w[:, j] for j, m in enumerate(markets)})


def pd_rolling_max(c: np.ndarray, n: int) -> np.ndarray:
    """Rolling max of closes that tolerates the NaNs before a market is listed (NaN until n listed bars)."""
    out = np.full(len(c), np.nan)
    ok = ~np.isnan(c)
    if ok.any():
        f = int(np.argmax(ok))
        out[f:] = ind.rolling_max(c[f:], n)
    return out


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    nm = len(spec.get("markets") or [])
    split = f"It splits the starting money equally over {mk}, and each share" if nm > 1 else "Its starting money"
    steps = [f"{split} into {int(p['tranches'])} equal slices; it buys one slice every "
             f"{bars_text(p['everyBars'], iv)} until all slices are used."]
    if int(p["trendSma"]):
        steps.append(f"A buy only happens while the price is above its average of the last "
                     f"{bars_text(p['trendSma'], iv)}; a buy that falls in a downtrend waits until the price is back "
                     "above that average.")
        if _exits(spec["params"]):
            under = f"{pct(p['exitBand'])} under" if float(p["exitBand"]) else "under"
            steps.append(f"When the price closes {under} that average it sells that coin completely and starts "
                         "buying in slices again once the trend has returned.")
    else:
        steps.append("It never looks at the trend: it is plain dollar-cost averaging.")
    if float(p["dipPct"]):
        where = "" if (p["dipIgnoresGate"] or not int(p["trendSma"])) else " (only in an uptrend)"
        steps.append(f"When the price is {pct(p['dipPct'])} or more under its highest close of the last "
                     f"{bars_text(p['lookback'], iv)}, it buys one extra slice{where}, once per dip.")
    steps += risk_steps(spec)
    return {
        "summary": f"Buys {mk} bit by bit on a fixed schedule, but only while the trend is up, and steps out when "
                   "the trend breaks.",
        "howItWorks": steps,
        "whenItWins": "Long bull runs with deep bear markets in between: it is fully in during the rally and sits in "
                      "euros through most of the crash.",
        "whenItLoses": "Sideways, choppy markets around the average (it sells low and buys back higher, paying fees) "
                       "and fast V-shaped recoveries (it buys back in slices, late).",
    }
