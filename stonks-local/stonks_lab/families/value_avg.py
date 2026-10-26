"""value_avg v1 (agent-20, dca lane): value averaging (Edleson) into one coin, then hold.

A virtual, fee-free portfolio of 1 unit of cash starts at the anchor bar a (first bar with ts >= start_time, else the
first bar). Every ``everyBars`` candles (step j = 1, 2, ..., ``tranches``; the first at the anchor) the coin holding
is brought to a target VALUE, not a fixed amount: T_j = (j / tranches) * (1 + growth) ** (j - 1). After a fall it
buys more than a DCA slice, after a rise less, and with ``allowSell`` it even sells the excess. At the last step it
invests whatever cash is left and holds from then on.

weight = maxWeight * coins*c / (cash + coins*c). Bars before the anchor are NaN. Uses closes up to bar i only.
"""
from __future__ import annotations

import numpy as np

from ._base import anchor_index, bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "value_avg"
VERSION = 1
TITLE = "Value averaging"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"everyBars": 7, "tranches": 12, "growth": 0.0, "allowSell": False}


def param_space() -> dict:
    return {
        "everyBars": {"type": "int", "min": 1, "max": 200, "log": True, "description": "candles between steps"},
        "tranches": {"type": "int", "min": 2, "max": 100, "log": True,
                     "description": "steps until fully invested (the value path reaches the starting cash)"},
        "growth": {"type": "float", "min": 0.0, "max": 0.1,
                   "description": "extra growth per step built into the target value path"},
        "allowSell": {"type": "bool", "description": "sell the excess when the holding is above its target value"},
    }


def warmup(p: dict) -> int:
    return 0


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    w = np.full(n, np.nan)
    a = anchor_index(np.asarray(df.index, dtype=np.int64), start_time)
    every, J = int(p["everyBars"]), int(p["tranches"])
    g, sell = float(p["growth"]), bool(p["allowSell"])
    mw = max_weight(spec)
    cash, coins, step = 1.0, 0.0, 0
    out = []
    for ci in c[a:].tolist():
        k = len(out)
        if k % every == 0 and step < J and ci > 0:
            step += 1
            if step == J:
                coins += cash / ci
                cash = 0.0
            else:
                diff = (step / J) * (1.0 + g) ** (step - 1) - coins * ci
                if diff > 0:
                    spend = min(diff, cash)
                    coins += spend / ci
                    cash -= spend
                elif sell and diff < 0:
                    q = min(-diff / ci, coins)
                    coins -= q
                    cash += q * ci
        value = coins * ci
        total = cash + value
        out.append(mw * value / total if total > 0 else 0.0)
    w[a:] = out
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    every, J = int(p["everyBars"]), int(p["tranches"])
    steps = [
        f"It invests in {mk} over {J} steps, one every {bars_text(every, iv)}.",
        "At each step it tops the holding up to a target value that rises in a straight line"
        + (f" (plus {float(p['growth']):.1%} per step)" if float(p["growth"]) > 0 else "")
        + ": after a drop it buys more than an equal slice, after a rise less.",
    ]
    if p["allowSell"]:
        steps.append("If the holding is worth more than its target, it sells the excess.")
    steps.append("At the last step it invests the rest and then simply holds.")
    return {
        "summary": f"Value averaging into {mk}: buy more after drops and less after rises, then hold.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Markets that fall or chop during the buying period and recover afterwards.",
        "whenItLoses": "Steady rallies from the start (most cash is invested late, at higher prices).",
    }
