"""quiet_core_a16 v1 (agent-16): an SMA trend core that also holds through CALM stretches below its average.

Idea (pre-holdout study, agent-16 wave 8): below a trend core, a quiet market (short-window realized volatility in
the low part of its trailing range) drifts back up more often than a turbulent one, while crashes come with a vol
spike, which takes the strategy out again. So instead of sitting in cash for every bar below the average, it holds
while the market is calm and steps aside only while it is under the average AND turbulent.

- core_t  = close above SMA(coreLen)
- rank_t  = share of the previous rankLen bars whose volLen-bar realized vol (std of log returns) was below today's
- quiet   = rank_t < quietQ (entering); once in a quiet hold it stays until rank_t > exitQ (exitQ 0 = quietQ)
- side "low" holds core OR quiet; side "high" (ablation) holds core OR turbulent (rank > 1 - quietQ), same
  exposure budget; side "off" is the plain core.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, single_market

NAME = "quiet_core_a16"
VERSION = 1
TITLE = "Trend core that also holds through calm stretches below its average"
BOT_READY = False
MULTI_MARKET = False


def default_params() -> dict:
    return {"coreLen": 130, "volLen": 14, "rankLen": 365, "quietQ": 0.33, "exitQ": 0.0, "side": "low"}


def param_space() -> dict:
    return {
        "coreLen": {"type": "int", "min": 20, "max": 400, "log": True,
                    "description": "hold while the close is above this SMA"},
        "volLen": {"type": "int", "min": 5, "max": 120, "log": True,
                   "description": "candles in the realized-volatility window"},
        "rankLen": {"type": "int", "min": 60, "max": 1000, "log": True,
                    "description": "trailing candles the volatility is ranked against"},
        "quietQ": {"type": "float", "min": 0.05, "max": 0.6,
                   "description": "below the average, hold while the vol rank is under this (calm)"},
        "exitQ": {"type": "float", "min": 0.0, "max": 0.9, "zero": True,
                  "description": "leave a calm hold once the vol rank rises above this (0 = quietQ)"},
        "side": {"type": "choice", "values": ["low", "high", "off"],
                 "description": "low = hold calm stretches, high = ablation (hold turbulent ones), off = core only"},
    }


def valid_params(p: dict) -> str | None:
    eq = float(p.get("exitQ") or 0)
    if eq and eq < float(p["quietQ"]):
        return "exitQ must be 0 or >= quietQ"
    return None


def warmup(p: dict) -> int:
    return max(int(p["coreLen"]), int(p["volLen"]) + int(p["rankLen"]))


def vol_rank(close: np.ndarray, vol_len: int, rank_len: int) -> np.ndarray:
    """Share of the previous rank_len vols strictly below today's vol (NaN until defined)."""
    c = np.asarray(close, dtype=np.float64)
    r = np.full(len(c), np.nan)
    r[1:] = np.diff(np.log(c))
    v = np.full(len(c), np.nan)
    for i in range(vol_len, len(c)):
        v[i] = np.std(r[i - vol_len + 1:i + 1], ddof=1)
    out = np.full(len(c), np.nan)
    for i in range(len(c)):
        if i - rank_len < 0 or not np.isfinite(v[i]):
            continue
        prev = v[i - rank_len:i]
        if not np.isfinite(prev).all():
            continue
        out[i] = float((prev < v[i]).mean())
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    m, df = single_market(candles, spec)
    c = df["close"].to_numpy(np.float64)
    sm = ind.sma(c, int(p["coreLen"]))
    rk = vol_rank(c, int(p["volLen"]), int(p["rankLen"]))
    side = p.get("side", "low")
    q = float(p["quietQ"])
    eq = float(p.get("exitQ") or 0) or q
    out = np.full(len(c), np.nan)
    held = False
    for i in range(len(c)):
        if not (np.isfinite(sm[i]) and np.isfinite(rk[i])):
            continue
        core = c[i] > sm[i]
        if side == "off":
            extra = False
        elif side == "low":
            extra = rk[i] < eq if held else rk[i] < q
        else:  # "high": mirror ablation
            extra = rk[i] > 1 - eq if held else rk[i] > 1 - q
        held = bool(extra) and not core
        out[i] = 1.0 if (core or extra) else 0.0
    return frame(df.index, {m: out * max_weight(spec)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    side = p.get("side", "low")
    steps = [f"It holds {mk} while the price is above its average over {bars_text(p['coreLen'], iv)}."]
    if side == "low":
        steps.append(f"Below that average it keeps holding while the market is calm: the volatility of the last "
                     f"{bars_text(p['volLen'], iv)} is in the lowest {round(100 * float(p['quietQ']))} % of the last "
                     f"{bars_text(p['rankLen'], iv)}.")
        steps.append("It steps aside only while the price is below the average and the market is turbulent, "
                     "which is how crashes look.")
    elif side == "high":
        steps.append("Test version: below the average it holds only while the market is unusually turbulent.")
    return {
        "summary": f"A trend rule on {mk} that does not sell calm dips below its average, only turbulent ones.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Quiet sideways stretches after a correction that turn back up: it is already in.",
        "whenItLoses": "Slow, quiet bear markets (like 2022) that keep dripping lower without a volatility spike.",
    }
