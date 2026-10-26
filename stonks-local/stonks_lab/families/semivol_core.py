"""semivol_core v1 (agent-20): "good volatility vs bad volatility" regime, long only, one market.

Over the last ``lookback`` candles it splits the squared log returns into the up-moves and the down-moves (realized
upside and downside semivariance). ``share = up / (up + down)`` is 0.5 when the market swings equally both ways, near
1 when the big moves are rallies and near 0 when they are sell-offs. It holds while the share is above ``enter``
(with hysteresis: it sells only when the share drops under ``enter - gap``). Unlike a moving average this weighs each
day by the square of its move, so a few violent down days flip it quickly while a slow grind does little.

Optional slow SMA core (``trendSma``) combined with ``combine``: "and" = hold only when both say in (a filter),
"or" = hold when either says in (the semivol signal re-enters before the SMA does). Decisions at bar t use candles
up to and including bar t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "semivol_core"
VERSION = 1
TITLE = "Upside vs downside volatility regime"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"lookback": 30, "enter": 0.55, "gap": 0.05, "trendSma": 0, "combine": "and"}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 5, "max": 400, "log": True,
                     "description": "candles over which upside and downside squared returns are summed"},
        "enter": {"type": "float", "min": 0.3, "max": 0.8,
                  "description": "hold while the upside share of realized variance is above this"},
        "gap": {"type": "float", "min": 0.0, "max": 0.25,
                "description": "hysteresis: sell only when the share falls under enter minus this"},
        "trendSma": {"type": "int", "min": 10, "max": 600, "log": True, "zero": True,
                     "description": "slow SMA core combined with the signal (0 = off)"},
        "combine": {"type": "choice", "values": ["and", "or"],
                    "description": "and = need both signal and close > SMA; or = either one is enough"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["enter"]) - float(p["gap"]) < 0.05:
        return "enter - gap must be at least 0.05"
    return None


def warmup(p: dict) -> int:
    return max(int(p["lookback"]) + 1, int(p["trendSma"] or 0))


def upside_share(close: np.ndarray, n: int) -> np.ndarray:
    """up / (up + down) realized semivariance over the last n log returns ending at each bar; NaN before n returns."""
    c = np.asarray(close, dtype=np.float64)
    r = np.full(len(c), np.nan)
    r[1:] = np.log(c[1:] / c[:-1])
    up = np.where(r > 0, r * r, 0.0)
    dn = np.where(r < 0, r * r, 0.0)
    up[0] = dn[0] = 0.0
    cu, cd = np.cumsum(up), np.cumsum(dn)
    out = np.full(len(c), np.nan)
    if len(c) > n:
        su = cu[n:] - cu[:-n]
        sd = cd[n:] - cd[:-n]
        tot = su + sd
        with np.errstate(invalid="ignore", divide="ignore"):
            out[n:] = np.where(tot > 0, su / tot, 0.5)
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    sh = upside_share(c, int(p["lookback"]))
    ts = int(p["trendSma"] or 0)
    sma = ind.sma(c, ts) if ts else np.zeros(n)
    hi, lo = float(p["enter"]), float(p["enter"]) - float(p["gap"])
    both = p["combine"] == "and"
    mw = max_weight(spec)
    w = np.full(n, np.nan)
    sig = False
    for i in range(n):
        if not (np.isfinite(sh[i]) and np.isfinite(sma[i])):
            continue
        if sig:
            sig = sh[i] >= lo
        else:
            sig = sh[i] > hi
        if ts:
            core = c[i] > sma[i]
            on = (sig and core) if both else (sig or core)
        else:
            on = sig
        w[i] = mw if on else 0.0
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    lb = bars_text(int(p["lookback"]), iv)
    hi, lo = float(p["enter"]), float(p["enter"]) - float(p["gap"])
    ts = int(p["trendSma"] or 0)
    steps = [
        f"After every {iv} candle it looks at {mk}'s moves over the last {lb} and splits their squared size into "
        "rallies and drops (upside and downside volatility).",
        f"It is in while rallies make up more than {hi:.0%} of that volatility and sells once they fall under {lo:.0%}.",
    ]
    if ts:
        if p["combine"] == "and":
            steps.append(f"It also needs the price above its {bars_text(ts, iv)} average; under it, it stays in euros.")
        else:
            steps.append(f"It is also in whenever the price is above its {bars_text(ts, iv)} average, even if the "
                         "volatility signal says out.")
    return {
        "summary": f"Holds {mk} while the big moves are mostly up and steps out when violent drops dominate.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets with mostly upward swings, and sell-offs that start with a few big red candles.",
        "whenItLoses": "Choppy markets where a single big drop flips it out just before a rebound (fees, missed rallies).",
    }
