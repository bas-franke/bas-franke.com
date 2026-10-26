"""ema_cross v1: long (maxWeight) while EMA(fast) > EMA(slow) at the bar close, otherwise cash."""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "ema_cross"
VERSION = 1
TITLE = "EMA crossover"
BOT_READY = True
MULTI_MARKET = False


def default_params() -> dict:
    return {"fast": 12, "slow": 48}


def param_space() -> dict:
    return {
        "fast": {"type": "int", "min": 2, "max": 150, "log": True, "description": "fast EMA length in candles"},
        "slow": {"type": "int", "min": 5, "max": 500, "log": True, "description": "slow EMA length in candles"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["fast"] < p["slow"] else "fast must be shorter than slow"


def warmup(p: dict) -> int:
    return int(p["slow"]) - 1


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    f, s = ind.ema(c, p["fast"]), ind.ema(c, p["slow"])
    w = np.where(f > s, max_weight(spec), 0.0)
    w[~(np.isfinite(f) & np.isfinite(s))] = np.nan
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    return {
        "summary": f"Follows the trend of {mk}: it holds {mk} while the short-term average price is above the "
                   f"long-term average, and sits in euros otherwise.",
        "howItWorks": [
            f"After every {iv} candle it computes two exponential moving averages of the closing price: a fast one "
            f"over {bars_text(p['fast'], iv)} and a slow one over {bars_text(p['slow'], iv)}.",
            "When the fast average is above the slow one, prices are rising: it buys and holds.",
            "When the fast average drops below the slow one, it sells everything and waits in euros.",
            *risk_steps(spec),
        ],
        "whenItWins": "Long, steady trends: it rides big rallies and steps aside during long declines.",
        "whenItLoses": "Choppy sideways markets: the averages cross back and forth, so it buys high, sells low and "
                       "pays fees each time.",
    }
