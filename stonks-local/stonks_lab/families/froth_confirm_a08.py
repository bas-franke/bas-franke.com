"""froth_confirm_a08 v1: alt_froth with a confirmed exit, sell only after the alt froth has LASTED (agent-08).

Same signal as alt_froth: the mean ``lookback``-candle log return of nine altcoins listed on Bitvavo since 2019 (XRP ADA
LINK TRX LTC BCH XLM XTZ MIOTA, no hindsight in the list) minus BTC's. alt_froth sells on the first candle the spread is
over ``threshold``; this family sells only after the spread has been over ``threshold`` for ``confirm`` + 1 candles in a
row. Idea: a short alt spike (one coin's pump, a brief rotation) is a false exit inside a bull run, while a real alt
season stays frothy for weeks. Re-entry is unchanged (spread back under ``threshold - band`` and ``minOut`` candles
out). ``confirm = 0`` reproduces alt_froth exactly (the paired ablation).

Pre-study (agent-08, 1d 2019-2025 gross, 0.3 % per switch, 12 lookback/threshold cells): confirm 20 d beat confirm 0
on ETH in 12/12 cells (median +17 log-pts/yr), BTC 8/12 (median +8). Other markets are aligned "as of" the bar time,
so a decision at bar t uses nothing after t.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from .alt_froth import OLD_ALTS, _asof, froth

NAME = "froth_confirm_a08"
VERSION = 1
TITLE = "Confirmed altcoin froth exit"
BOT_READY = False
MULTI_MARKET = True


def default_params() -> dict:
    return {"lookback": 120, "threshold": 0.1, "band": 0.05, "confirm": 20, "minOut": 0, "trendSma": 0}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 5, "max": 400, "log": True,
                     "description": "candles over which the old alts' return is compared with BTC's"},
        "threshold": {"type": "float", "min": 0.0, "max": 1.0,
                      "description": "froth level: the old alts beat BTC by more than this log return"},
        "band": {"type": "float", "min": 0.0, "max": 0.5,
                 "description": "buy back once the lead is under threshold minus this"},
        "confirm": {"type": "int", "min": 1, "max": 200, "zero": True, "log": True,
                    "description": "sell only after the froth has lasted this many extra candles in a row (0 = at once)"},
        "minOut": {"type": "int", "min": 1, "max": 400, "zero": True, "log": True,
                   "description": "stay out at least this many candles after a froth exit (0 = no minimum)"},
        "trendSma": {"type": "int", "min": 10, "max": 600, "zero": True, "log": True,
                     "description": "also stay out while the market is under this SMA (0 = off)"},
    }


def warmup(p: dict) -> int:
    t = int(p.get("trendSma") or 0)
    return max(int(p["lookback"]), t - 1 if t else 0)


def required_markets(spec: dict) -> list[str]:
    return ["BTC-EUR", *OLD_ALTS]


def froth_state(sp: np.ndarray, thr: float, band: float, confirm: int, min_out: int) -> np.ndarray:
    """1 = hold, 0 = out, NaN = undecided. Exit after confirm+1 consecutive candles with spread > thr."""
    state = np.full(len(sp), np.nan)
    out_, since, run = False, 0, 0
    for i, s in enumerate(sp.tolist()):
        if not np.isfinite(s):
            run = 0
            continue
        run = run + 1 if s > thr else 0
        if out_:
            since += 1
            if s < thr - band and since >= min_out:
                out_ = False
        elif run >= confirm + 1:
            out_, since = True, 0
        state[i] = 0.0 if out_ else 1.0
    return state


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    sp = froth(candles, int(p["lookback"]), idx)
    state = froth_state(sp, float(p["threshold"]), float(p["band"]), int(p.get("confirm") or 0),
                       int(p.get("minOut") or 0))
    tsma = int(p.get("trendSma") or 0)
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        if tsma:
            c = df["close"].to_numpy(np.float64)
            s = ind.sma(c, tsma)
            tr = _asof(df, np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan), idx)
        else:
            tr = _asof(df, np.ones(len(df)), idx)
        cols[m] = state * tr * each
    W = np.column_stack([cols[m] for m in markets])
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    conf = int(p.get("confirm") or 0)
    steps = [
        f"It holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "") + " by default.",
        f"After every {iv} candle it compares the return over {bars_text(p['lookback'], iv)} of nine altcoins that "
        "were already trading in 2019 (XRP, ADA, LINK, TRX, LTC, BCH, XLM, XTZ, IOTA) with Bitcoin's.",
        f"When those old altcoins have been ahead of Bitcoin by more than {pct(np.expm1(float(p['threshold'])))} "
        + (f"for {bars_text(conf + 1, iv)} in a row" if conf else "")
        + ", the market is in an alt-season frenzy that usually ends badly: it sells everything and waits in euros. "
        "Short alt spikes that fade quickly do not trigger a sale.",
        f"It buys back once their lead has shrunk below {pct(np.expm1(float(p['threshold']) - float(p['band'])))}"
        + (f" and at least {bars_text(p['minOut'], iv)} have passed." if int(p.get('minOut') or 0) else "."),
    ]
    if int(p.get("trendSma") or 0):
        steps.append(f"It also stays out of a coin while its price is under its {bars_text(p['trendSma'], iv)} "
                     "average.")
    return {
        "summary": f"Holds {mk}, but sells once old altcoins have pumped far ahead of Bitcoin for weeks (a lasting "
                   "alt-season frenzy).",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long alt seasons that end in a crash (2021-style tops), without being shaken out by short alt "
                      "spikes inside a bull market.",
        "whenItLoses": "Fast tops where the crash starts before the froth has lasted long enough, and broad bull "
                       "markets where altcoins lead for months and keep rising.",
    }
