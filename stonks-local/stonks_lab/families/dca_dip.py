"""dca_dip v1: dollar-cost averaging with extra dip buys and partial take profit.

Runs a virtual, fee-free portfolio of 1 unit of cash that starts at the anchor bar a (first bar with ts >= start_time,
else the first bar) and outputs its coin weight. Identical to dcaDip in stonks/backend/src/strategies/families.ts.
For each bar i >= a, k = i - a, close c, tranche = 1/tranches:

1. Take profit: if coins > 0 and c >= avgEntry*(1+takeProfitPct): sell sellFraction of the coins at c (the cost basis
   shrinks by the same fraction, so avgEntry stays; sellFraction >= 1 sells everything) and buy nothing this bar.
   While the price stays above the threshold it keeps selling that fraction every bar.
2. Otherwise buy = 0; if k % everyBars == 0 and fewer than `tranches` scheduled buys happened: buy += tranche.
   dip = c <= (highest HIGH of bars i-lookback+1..i)*(1-dipPct); if dip and armed: buy += tranche, armed = false.
   Spend min(buy, cash) at c (only when > 1e-12).
3. Whenever not dip: armed = true (armed starts true). A take-profit bar updates "armed" too.

weight = maxWeight * coins*c / (cash + coins*c). Bars before the anchor are NaN (no decision).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import anchor_index, bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "dca_dip"
VERSION = 1
TITLE = "DCA with dip buys"
BOT_READY = True
MULTI_MARKET = False
ANCHORED = True


def default_params() -> dict:
    return {"everyBars": 6, "tranches": 10, "dipPct": 0.1, "lookback": 30, "takeProfitPct": 0.2,
            "sellFraction": 0.5}


def param_space() -> dict:
    return {
        "everyBars": {"type": "int", "min": 1, "max": 1000, "log": True, "description": "candles between buys"},
        "tranches": {"type": "int", "min": 2, "max": 100, "log": True,
                     "description": "equal slices the starting cash is split into"},
        "dipPct": {"type": "float", "min": 0.01, "max": 0.5, "log": True,
                   "description": "a drop of this fraction from the recent high buys an extra slice"},
        "lookback": {"type": "int", "min": 2, "max": 1000, "log": True, "description": "candles in the recent high"},
        "takeProfitPct": {"type": "float", "min": 0.02, "max": 5.0, "log": True,
                          "description": "take profit this fraction above the average entry"},
        "sellFraction": {"type": "float", "min": 0.05, "max": 1.0,
                         "description": "part of the position sold at take profit"},
    }


def warmup(p: dict) -> int:
    return 0


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    hi = ind.rolling_max(df["high"].to_numpy(np.float64), int(p["lookback"]))
    n = len(c)
    w = np.full(n, np.nan)
    a = anchor_index(np.asarray(df.index, dtype=np.int64), start_time)
    every, tranches = int(p["everyBars"]), int(p["tranches"])
    dip_mult = 1.0 - float(p["dipPct"])
    tp_mult = 1.0 + float(p["takeProfitPct"])
    sell_fraction = float(p["sellFraction"])
    mw = max_weight(spec)
    tranche = 1.0 / tranches
    cash, coins, cost = 1.0, 0.0, 0.0
    scheduled, armed = 0, True
    cl, hl = c.tolist(), hi.tolist()
    out = []
    for i in range(a, n):
        ci = cl[i]
        h = hl[i]
        k = i - a
        dip = (h == h) and ci <= h * dip_mult  # h == h: not NaN
        if coins > 0 and ci >= (cost / coins) * tp_mult:
            if sell_fraction >= 1:
                cash += coins * ci
                coins = 0.0
                cost = 0.0
            else:
                q = coins * sell_fraction
                cash += q * ci
                coins -= q
                cost -= cost * sell_fraction
        else:
            buy = 0.0
            if k % every == 0 and scheduled < tranches:
                buy += tranche
                scheduled += 1
            if dip and armed:
                buy += tranche
                armed = False
            spend = min(buy, cash)
            if spend > 1e-12:
                coins += spend / ci
                cost += spend
                cash -= spend
        if not dip:
            armed = True
        value = coins * ci
        total = cash + value
        out.append(mw * (value / total) if total > 0 else 0.0)
    w[a:] = out
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    sf = float(p["sellFraction"])
    sell = "everything" if sf >= 1 else f"{pct(sf)} of its coins (again every candle while the price stays up there)"
    return {
        "summary": f"Buys {mk} bit by bit on a fixed schedule instead of all at once, buys extra after big drops and "
                   "takes some profit after strong rises.",
        "howItWorks": [
            f"It splits the starting money into {int(p['tranches'])} equal slices and buys one slice every "
            f"{bars_text(p['everyBars'], iv)} until all slices are used.",
            f"When the price is {pct(p['dipPct'])} or more under the highest price of the last "
            f"{bars_text(p['lookback'], iv)}, it buys one extra slice (once per dip).",
            f"When the price is {pct(p['takeProfitPct'])} above its average buy price, it sells {sell}; that money "
            "stays in euros.",
            *risk_steps(spec),
        ],
        "whenItWins": "Markets that dip and recover: it averages in at lower prices and trims near the highs.",
        "whenItLoses": "Steady rallies (it is only partly invested at first, so it lags simply buying everything on "
                       "day one) and long bear markets (it keeps buying all the way down).",
    }
