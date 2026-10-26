"""upday_share v1 (agent-16): trend by the SHARE of up-candles instead of by the size of the move.

Idea ("frog in the pan" / information discreteness): a rise made of many small up-days is steadier and lasts longer
than the same rise made of a few big jumps. A pre-holdout study (finding by agent-16, wave 5) found BTC 1d's 60-day
share of up-days ordered the next 30 days within 6 of 7 years, also after removing plain 60-day momentum.

- share_t = fraction of the last ``look`` candles (up to and including t) that closed above the previous close;
- state: buy when share_t >= ``enter``, sell when share_t < ``exit`` (hysteresis; ``exit`` <= ``enter``);
- optional SMA core (``coreLen``, 0 = off) combined with ``combine``: "and" = hold only when both say so,
  "or" = hold when either says so;
- ``scope``: "own" uses each coin's own candles, "btc" uses BTC-EUR's share for every coin (needs BTC-EUR candles).

Multi-market: each market gets maxWeight / len(markets). All values use closes up to and including bar t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "upday_share"
VERSION = 1
TITLE = "Up-candle share trend"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"look": 60, "enter": 0.55, "exit": 0.5, "coreLen": 0, "combine": "and", "scope": "own"}


def param_space() -> dict:
    return {
        "look": {"type": "int", "min": 10, "max": 400, "log": True,
                 "description": "count up-candles over this many candles"},
        "enter": {"type": "float", "min": 0.4, "max": 0.7,
                  "description": "buy when at least this share of the candles closed higher"},
        "exit": {"type": "float", "min": 0.3, "max": 0.65,
                 "description": "sell when the share drops below this (at most enter)"},
        "coreLen": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                    "description": "SMA core length combined with the share signal (0 = off)"},
        "combine": {"type": "choice", "values": ["and", "or"],
                    "description": "and = hold only when share and SMA agree, or = hold when either is bullish"},
        "scope": {"type": "choice", "values": ["own", "btc"],
                  "description": "own = each coin's own up-candles, btc = BTC-EUR's up-candles for every coin"},
    }


def valid_params(p: dict) -> str | None:
    return None if float(p["exit"]) <= float(p["enter"]) else "exit must be at most enter"


def warmup(p: dict) -> int:
    return max(int(p["look"]) + 1, int(p.get("coreLen") or 0))


def required_markets(spec: dict) -> list[str]:
    ms = list(spec.get("markets") or [])
    scope = (spec.get("params") or {}).get("scope", "own")
    return ms + (["BTC-EUR"] if scope == "btc" and "BTC-EUR" not in ms else [])


def up_share(close: np.ndarray, look: int) -> np.ndarray:
    c = np.asarray(close, dtype=np.float64)
    up = np.full(len(c), np.nan)
    ok = np.isfinite(c[1:]) & np.isfinite(c[:-1])
    up[1:] = np.where(ok, (c[1:] > c[:-1]).astype(np.float64), np.nan)
    return ind.sma(up, look)  # NaN until look valid up/down flags


def hysteresis(share: np.ndarray, enter: float, exit_: float) -> np.ndarray:
    out = np.full(len(share), np.nan)
    state = 0.0
    for i, s in enumerate(share):
        if not np.isfinite(s):
            continue
        if state == 0.0 and s >= enter - 1e-12:
            state = 1.0
        elif state == 1.0 and s < exit_ - 1e-12:
            state = 0.0
        out[i] = state
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    if not markets:
        raise ValueError("upday_share needs at least one market")
    scope = p.get("scope", "own")
    if scope == "btc" and "BTC-EUR" not in candles:
        raise KeyError("upday_share scope=btc needs BTC-EUR candles")
    idx = union_index(candles, markets)  # BTC's signal (scope btc) is taken as of each traded bar
    look, enter, exit_ = int(p["look"]), float(p["enter"]), float(p["exit"])
    core_len, combine = int(p.get("coreLen") or 0), p.get("combine", "and")
    each = max_weight(spec) / len(markets)
    btc_sig = None
    if scope == "btc":
        btc_sig = hysteresis(up_share(aligned_close(candles, "BTC-EUR", idx), look), enter, exit_)
    cols = {}
    for m in markets:
        c = aligned_close(candles, m, idx)
        sig = btc_sig if btc_sig is not None else hysteresis(up_share(c, look), enter, exit_)
        if core_len > 0:
            sm = ind.sma(c, core_len)
            core = np.where(np.isfinite(sm), (c > sm).astype(np.float64), np.nan)
            ok = np.isfinite(sig) & np.isfinite(core)
            on = (sig == 1) & (core == 1) if combine == "and" else (sig == 1) | (core == 1)
        else:
            ok = np.isfinite(sig)
            on = sig == 1
        ok &= np.isfinite(c)
        cols[m] = np.where(ok, on.astype(np.float64) * each, np.nan)
    df = frame(idx, cols)
    if len(markets) > 1:
        any_ok = df.notna().any(axis=1).to_numpy()
        df = df.fillna(0.0)
        df[~any_ok] = np.nan
    return df


def explain(spec) -> dict:
    p, iv, mk = spec["params"], spec.get("interval"), market_names(spec)
    who = "Bitcoin's" if p.get("scope") == "btc" else "the coin's own"
    steps = [
        f"After every {iv} candle it counts how many of the last {bars_text(p['look'], iv)} closed higher than the "
        f"candle before ({who} candles), ignoring how big each move was.",
        f"It buys when at least {pct(p['enter'])} of them were up-candles and sells when that share drops below "
        f"{pct(p['exit'])}: a rise made of many small up-days is treated as a steady trend.",
    ]
    if p.get("coreLen"):
        how = "and" if p.get("combine") == "and" else "or"
        steps.append(f"It combines that with a trend core: the price above its {bars_text(p['coreLen'], iv)} average "
                     f"({'both must agree' if how == 'and' else 'either one is enough'}).")
    if len(spec.get("markets") or []) > 1:
        steps.append(f"The money is split evenly between {mk}.")
    return {
        "summary": f"Holds {mk} while most recent candles close higher (a steady, broad rise), euros otherwise.",
        "howItWorks": [*steps, *risk_steps(spec)],
        "whenItWins": "Grinding bull markets made of many small up-days; it steps aside when down-days start to "
                      "outnumber up-days.",
        "whenItLoses": "Rallies made of a few huge jumps between flat days, and choppy markets where the share hovers "
                       "around the threshold.",
    }
