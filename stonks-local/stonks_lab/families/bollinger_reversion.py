"""bollinger_reversion v1: buy when the close falls below the lower band (SMA - k*population std), sell when the
close rises above the middle band (exitAt "middle") or the upper band (exitAt "upper")."""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "bollinger_reversion"
VERSION = 1
TITLE = "Bollinger band reversion"
BOT_READY = True
MULTI_MARKET = False


def default_params() -> dict:
    return {"period": 20, "stdDev": 2.0, "exitAt": "middle"}


def param_space() -> dict:
    return {
        "period": {"type": "int", "min": 5, "max": 200, "log": True, "description": "band length in candles"},
        "stdDev": {"type": "float", "min": 0.5, "max": 4.0, "description": "band width in standard deviations"},
        "exitAt": {"type": "choice", "values": ["middle", "upper"], "description": "which band to sell at"},
    }


def warmup(p: dict) -> int:
    return int(p["period"]) - 1


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    mid, up, lo = ind.bollinger(c, p["period"], float(p["stdDev"]))
    ex = up if p.get("exitAt", "middle") == "upper" else mid
    n = len(c)
    w = np.full(n, np.nan)
    first = warmup(p)
    mw = max_weight(spec)
    if first < n:
        cl, ll, el = c.tolist(), lo.tolist(), ex.tolist()
        out = [0.0] * (n - first)
        inside = False
        for k, i in enumerate(range(first, n)):
            if not inside:
                if cl[i] < ll[i]:
                    inside = True
            elif cl[i] > el[i]:
                inside = False
            out[k] = mw if inside else 0.0
        w[first:] = out
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    target = "upper band" if p.get("exitAt") == "upper" else "average (the middle band)"
    return {
        "summary": f"Bets that {mk} snaps back after an unusually low close: it buys below the lower Bollinger band "
                   f"and sells when the price is back at the {target}.",
        "howItWorks": [
            f"After every {iv} candle it computes the average close of the last {bars_text(p['period'], iv)} and "
            f"bands {float(p['stdDev']):g} standard deviations above and below it.",
            "A close under the lower band is unusually low compared with recent prices: it buys.",
            f"It sells everything once a candle closes above the {target}.",
            *risk_steps(spec),
        ],
        "whenItWins": "Range-bound markets where prices keep returning to their average.",
        "whenItLoses": "Strong downtrends, where a close under the band is the start of a bigger fall.",
    }
