"""trend_harvest v1 (agent-18, risk lane): a slow trend core that banks big runs and can buy back in.

Why: findings #94/#101/#109 show that a 40-80 % take profit lifts macd_trend on ETH 1d a lot, but the engine's
takeProfitPct overlay always sells everything and then stays out until the trend signal switches off and on again
(the "lockout"). Finding #95 asked for the next step: take profit inside a family, with partial sells and a re-entry
rule. This family tests whether the gain comes from banking the blow-off (then re-entry should not hurt) or from the
long lockout that happens to dodge the following crash (then re-entry should hurt).

Rule per bar close (decisions only use candles up to and including that bar; trading starts flat at the anchor):
- core on: ``core=macd``: MACD(fast, slow) line > its signal EMA; ``core=ema``: EMA(fast) > EMA(slow).
- core off: weight 0, every lock is cleared.
- core on and flat (not locked): buy maxWeight, the entry price is that close.
- holding, not locked, close >= entry * (1 + tpPct): sell ``sellFraction`` of the position (keep
  maxWeight * (1 - sellFraction)) and lock. The lock price is that close.
- locked: ``reentry=cross``: stay reduced until the core switches off (= the engine overlay's lockout);
  ``reentry=pullback``: back to maxWeight once a close is ``pullbackPct`` below the lock price (new entry = that close);
  ``reentry=cooldown``: back to maxWeight ``cooldownBars`` candles after the lock (new entry = that close).
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import anchor_index, bars_text, frame, market_names, max_weight, pct, risk_steps, single_market

NAME = "trend_harvest"
VERSION = 1
TITLE = "Trend with take profit and re-entry"
BOT_READY = False
MULTI_MARKET = False
ANCHORED = True


def default_params() -> dict:
    return {"core": "macd", "fast": 12, "slow": 182, "signal": 30, "tpPct": 0.6, "sellFraction": 1.0,
            "reentry": "cross", "pullbackPct": 0.15, "cooldownBars": 30}


def param_space() -> dict:
    return {
        "core": {"type": "choice", "values": ["macd", "ema"],
                 "description": "trend signal: MACD line above its signal line (macd) or fast EMA above slow EMA (ema)"},
        "fast": {"type": "int", "min": 2, "max": 60, "log": True, "description": "fast EMA length in candles"},
        "slow": {"type": "int", "min": 20, "max": 400, "log": True, "description": "slow EMA length in candles"},
        "signal": {"type": "int", "min": 2, "max": 120, "log": True,
                   "description": "signal EMA length of the MACD line (macd core only)"},
        "tpPct": {"type": "float", "min": 0.1, "max": 2.0, "log": True,
                  "description": "take profit once the close is this much above the entry price"},
        "sellFraction": {"type": "float", "min": 0.25, "max": 1.0,
                         "description": "share of the position sold at the take profit (1 = all)"},
        "reentry": {"type": "choice", "values": ["cross", "pullback", "cooldown"],
                    "description": "when to buy back after a take profit: next trend signal (cross), after a "
                                   "pullback from the take-profit price, or after a fixed wait"},
        "pullbackPct": {"type": "float", "min": 0.03, "max": 0.4, "log": True,
                        "description": "pullback re-entry: buy back this far below the take-profit close"},
        "cooldownBars": {"type": "int", "min": 1, "max": 200, "log": True,
                         "description": "cooldown re-entry: buy back this many candles after the take profit"},
    }


def valid_params(p: dict) -> str | None:
    return None if p["fast"] < p["slow"] else "fast must be shorter than slow"


def warmup(p: dict) -> int:
    return int(p["slow"]) + (int(p["signal"]) - 2 if p["core"] == "macd" else 0)


def core_on(c: np.ndarray, p: dict) -> np.ndarray:
    """1.0 / 0.0 where the trend core is on / off, NaN while its indicators are undefined."""
    if p["core"] == "macd":
        a, b, _ = ind.macd(c, int(p["fast"]), int(p["slow"]), int(p["signal"]))
    else:
        a, b = ind.ema(c, int(p["fast"])), ind.ema(c, int(p["slow"]))
    out = np.where(a > b, 1.0, 0.0)
    out[~(np.isfinite(a) & np.isfinite(b))] = np.nan
    return out


def targets(candles, spec, start_time=None):
    m, df = single_market(candles, spec)
    p = spec["params"]
    c = df["close"].to_numpy(np.float64)
    n = len(c)
    on = core_on(c, p)
    w = np.full(n, np.nan)
    first = max(anchor_index(np.asarray(df.index, dtype=np.int64), start_time), warmup(p))
    mw = max_weight(spec)
    tp, sf = float(p["tpPct"]), min(1.0, float(p["sellFraction"]))
    mode, pb, cd = p["reentry"], float(p["pullbackPct"]), int(p["cooldownBars"])
    keep = mw * (1.0 - sf) if sf < 0.999 else 0.0
    cl, ol = c.tolist(), on.tolist()
    pos, entry, locked, lock_px, lock_bar = 0.0, 0.0, False, 0.0, 0
    for i in range(first, n):
        if ol[i] != ol[i]:  # NaN: undecided
            continue
        if ol[i] == 0.0:
            pos, locked = 0.0, False
        elif locked:
            if (mode == "pullback" and cl[i] <= lock_px * (1.0 - pb)) or (mode == "cooldown" and i - lock_bar >= cd):
                pos, entry, locked = mw, cl[i], False
        elif pos == 0.0:
            pos, entry = mw, cl[i]
        elif cl[i] >= entry * (1.0 + tp):
            pos, locked, lock_px, lock_bar = keep, True, cl[i], i
        w[i] = pos
    return frame(df.index, {m: w})


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    if p["core"] == "macd":
        core = (f"It holds {mk} while its MACD is above the signal line: the {bars_text(p['fast'], iv)} average price "
                f"minus the {bars_text(p['slow'], iv)} average, compared with its own {bars_text(p['signal'], iv)} "
                "average. Otherwise it holds euros.")
    else:
        core = (f"It holds {mk} while the {bars_text(p['fast'], iv)} average price is above the "
                f"{bars_text(p['slow'], iv)} average. Otherwise it holds euros.")
    sold = "everything" if p["sellFraction"] >= 0.999 else pct(p["sellFraction"]) + " of the position"
    if p["reentry"] == "cross":
        back = "It does not buy back until the trend signal has switched off and on again."
    elif p["reentry"] == "pullback":
        back = (f"It buys back to a full position once the price closes {pct(p['pullbackPct'])} below where it took "
                "profit, as long as the trend signal is still on.")
    else:
        back = (f"It buys back to a full position {bars_text(p['cooldownBars'], iv)} after taking profit, as long as "
                "the trend signal is still on.")
    return {
        "summary": f"A slow trend strategy on {mk} that cashes in after a big run and decides separately when to "
                   "buy back.",
        "howItWorks": [core,
                       f"When a candle closes {pct(p['tpPct'])} above the buy price, it sells {sold}.",
                       back,
                       "When the trend signal switches off it sells whatever is left."] + risk_steps(spec),
        "whenItWins": "Sharp rallies that reverse: it banks the gain before the giveback.",
        "whenItLoses": "Long steady bull runs, where selling early (and buying back higher) leaves gains on the table.",
    }
