"""drawdown_dip v1 (agent-15, dip lane): buy when the close is dipPct below its highest close of the last
`lookback` candles, sell at a take-profit over the entry close or after `maxHoldBars` (time stop).

- Re-arm: after an exit it only buys again once the close has climbed out of the dip zone (above
  high * (1 - dipPct)), so a time stop does not instantly re-buy the same dip.
- Optional regime gate (regimeSma > 0) on entries only: "above" = close above SMA(regimeSma);
  "rising" = SMA(regimeSma) higher than max(1, regimeSma // 4) candles ago (a dip inside a long uptrend).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "drawdown_dip"
VERSION = 1
TITLE = "Drawdown-from-high dip buying"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"lookback": 60, "dipPct": 0.12, "takeProfitPct": 0.1, "maxHoldBars": 0, "regimeSma": 0,
            "regimeMode": "rising"}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 5, "max": 1000, "log": True,
                     "description": "candles in the recent high the drop is measured from"},
        "dipPct": {"type": "float", "min": 0.02, "max": 0.6, "log": True,
                   "description": "buy when the close is this fraction below the recent high"},
        "takeProfitPct": {"type": "float", "min": 0.01, "max": 2.0, "log": True,
                          "description": "sell when the close is this fraction above the entry close"},
        "maxHoldBars": {"type": "int", "min": 2, "max": 2000, "zero": True, "log": True,
                        "description": "sell after this many candles in the trade (0 = no time stop)"},
        "regimeSma": {"type": "int", "min": 10, "max": 1000, "zero": True, "log": True,
                      "description": "only buy while the regime SMA allows it (0 = no filter)"},
        "regimeMode": {"type": "choice", "values": ["rising", "above"],
                       "description": "rising: the SMA is higher than a quarter of its length ago; "
                                      "above: the close is above the SMA"},
    }


def _slope_bars(n: int) -> int:
    return max(1, int(n) // 4)


def warmup(p: dict) -> int:
    w = int(p["lookback"]) - 1
    r = int(p.get("regimeSma") or 0)
    if r > 0:
        w = max(w, r - 1 + (_slope_bars(r) if p.get("regimeMode", "rising") == "rising" else 0))
    return w


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    hi = ind.rolling_max(c, int(p["lookback"]))
    r = int(p.get("regimeSma") or 0)
    if r > 0:
        s = ind.sma(c, r)
        if p.get("regimeMode", "rising") == "rising":
            gate = s > ind.shift(s, _slope_bars(r))
        else:
            gate = c > s
    else:
        gate = np.ones(n, dtype=bool)
    w = np.full(n, np.nan)
    first = warmup(p)
    mw = max_weight(spec)
    dip, tp, hold = float(p["dipPct"]), float(p["takeProfitPct"]), int(p.get("maxHoldBars") or 0)
    if first < n:
        cl, hl, gl = c.tolist(), hi.tolist(), gate.tolist()
        out = [0.0] * (n - first)
        inside, armed, entry, held = False, True, 0.0, 0
        for k, i in enumerate(range(first, n)):
            level = hl[i] * (1.0 - dip)
            if inside:
                held += 1
                if cl[i] >= entry * (1.0 + tp) or (hold > 0 and held >= hold):
                    inside, armed = False, cl[i] > level
            else:
                if not armed and cl[i] > level:
                    armed = True
                if armed and cl[i] <= level and gl[i]:
                    inside, entry, held = True, cl[i], 0
            out[k] = mw if inside else 0.0
        w[first:] = out
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    steps = [
        f"After every {iv} candle it looks up the highest closing price of {mk} over the last "
        f"{bars_text(p['lookback'], iv)}.",
        f"When the price has fallen {pct(p['dipPct'])} or more below that high, it buys the dip.",
        f"It sells once the price is {pct(p['takeProfitPct'])} above where it bought"
        + (f", or after {bars_text(p['maxHoldBars'], iv)} at the latest" if int(p.get('maxHoldBars') or 0) else "")
        + ".",
        "After selling it only buys again once the price has climbed back out of the dip zone.",
    ]
    r = int(p.get("regimeSma") or 0)
    if r > 0:
        if p.get("regimeMode", "rising") == "rising":
            steps.insert(2, f"It only buys while the {bars_text(r, iv)} average is rising, so dips inside a long "
                            "uptrend, not crashes in a bear market.")
        else:
            steps.insert(2, f"It only buys while the price is still above its {bars_text(r, iv)} average.")
    return {
        "summary": f"Buys {mk} after a set drop from its recent high and sells after a set rebound.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets and ranges with sharp pullbacks that bounce back.",
        "whenItLoses": "Long bear markets: the drop keeps going and it holds a falling coin until the time stop.",
    }
