"""weekend_shock v1 (agent-21, regime lane): hold the coin, step aside for a while after a big weekend drop.

Signal study (finding #388): on Bitvavo spot a large weekend move (Friday close -> Sunday close) is not "filled" in
the next week as CME-gap folklore says; it tends to continue (weak weekly momentum). This family holds the coin by
default and goes to euros after a shock:

* ``mode="weekend"``: at the close of a Sunday daily candle (UTC), R = ln(close_Sunday / close_Friday). Only bars
  whose candle two bars back is exactly 2 days earlier count (no gaps).
* ``mode="rolling"``: the control. The same 2-candle return at every candle, any weekday.

When R <= -dropMin it sells and stays out for ``outDays`` candles. With ``regain`` it buys back earlier once a close
is back at or above the reference close (Friday's close, or the close two candles before the shock). A new shock
while out restarts the clock. Decisions at bar t use closes up to and including bar t only.
"""
from __future__ import annotations

import math

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "weekend_shock"
VERSION = 1
TITLE = "Weekend shock exit"
BOT_READY = False
MULTI_MARKET = False

_DAY = 86_400_000


def default_params() -> dict:
    return {"mode": "weekend", "dropMin": 0.06, "outDays": 5, "regain": True}


def param_space() -> dict:
    return {
        "mode": {"type": "choice", "values": ["weekend", "rolling"],
                 "description": "measure the drop over the weekend only (Fri->Sun close) or over any 2 candles"},
        "dropMin": {"type": "float", "min": 0.02, "max": 0.25, "log": True,
                    "description": "sell when the 2-candle return is at or below minus this"},
        "outDays": {"type": "int", "min": 1, "max": 60, "log": True,
                    "description": "candles it stays in euros after a shock"},
        "regain": {"type": "bool",
                   "description": "buy back early once the close is back at the pre-shock close"},
    }


def warmup(p: dict) -> int:
    return 2


def shock_weights(ts: np.ndarray, c: np.ndarray, p: dict, mw: float = 1.0) -> np.ndarray:
    n = len(c)
    w = np.full(n, np.nan)
    weekend = p["mode"] == "weekend"
    drop = float(p["dropMin"])
    out_n = int(p["outDays"])
    regain = bool(p["regain"])
    sunday = ((ts // _DAY) + 3) % 7 == 6  # 1970-01-01 was a Thursday (Mon = 0)
    until = -1
    ref = math.inf
    for i in range(n):
        if i < 2:
            continue
        shock = False
        if c[i] > 0 and c[i - 2] > 0 and (not weekend or (sunday[i] and ts[i] - ts[i - 2] == 2 * _DAY)):
            shock = math.log(c[i] / c[i - 2]) <= -drop
        if shock:
            until = i + out_n
            ref = c[i - 2]
        elif i < until and regain and c[i] >= ref:
            until = -1
        w[i] = 0.0 if i < until else mw
    return w


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    ts = df.index.to_numpy(np.int64)
    return frame(df.index, {m: shock_weights(ts, c, spec["params"], max_weight(spec))})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    if p["mode"] == "weekend":
        sig = (f"Every Sunday at midnight (UTC) it compares {mk}'s close with Friday's close. If it fell "
               f"{pct(p['dropMin'])} or more over the weekend, that is a shock.")
    else:
        sig = (f"After every {iv} candle it compares {mk}'s close with the close two candles earlier. A fall of "
               f"{pct(p['dropMin'])} or more is a shock.")
    steps = [
        f"It holds {mk} by default.",
        sig,
        f"After a shock it sells everything and waits in euros for {bars_text(int(p['outDays']), iv)}.",
    ]
    if p["regain"]:
        steps.append("It buys back earlier if the price climbs back to where it was before the shock.")
    return {
        "summary": f"Holds {mk}, but steps aside for a few days after a sharp {('weekend ' if p['mode'] == 'weekend' else '')}drop, "
                   "betting that big drops keep going for a while.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Crashes that start with a sharp drop and keep sliding for days.",
        "whenItLoses": "Sharp drops that bounce straight back (it sells low and buys back higher), and fees on "
                       "false alarms.",
    }
