"""froth_dip v1 (agent-06, ensemble lane): trend core + market-wide panic buys + alt-froth exit, all from coins that
were already listed on Bitvavo in 2019 (no hindsight in any coin list).

Two cross-asset BTC/ETH leads of the fleet attack different weaknesses of holding:
- breadth_dip (agent-02, #212/#213/#243): an SMA core plus a buy when most of the top 10 is RSI-oversold at once,
  held for weeks, catches the V-recoveries the SMA re-enters late. Its breadth list is today's top 10.
- alt_froth (agent-01, #255): hold, but step aside while old alts outrun BTC (alt-season blow-offs before tops).
This family combines them. Per market, at each bar close:

  panic  = at least breadthMin of the 2019 pool (BTC, ETH and 9 old alts) has RSI(rsiPeriod) < rsiBelow
           -> starts a dip trade, which ends when the market's own RSI > sellAbove or after maxHold candles
  core   = close > SMA(coreSma)                         (coreSma 0 = always on: hold by default)
  froth  = old-alt pool's lookback log return minus BTC's > frothThr, until it is back under frothThr - frothBand
           (alt_froth's signal; frothThr 0 = froth exit off)
  weight = maxWeight / len(markets) while (core or dip trade) and not froth

Other markets are aligned "as of" the bar time, so a decision at bar t uses nothing after t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from .alt_froth import OLD_ALTS, froth as froth_spread

NAME = "froth_dip"
VERSION = 1
TITLE = "Trend core, panic buys and froth exits"
BOT_READY = False
MULTI_MARKET = True
POOL = ["BTC-EUR", "ETH-EUR", *OLD_ALTS]
MIN_POOL = 3


def default_params() -> dict:
    return {"coreSma": 132, "rsiPeriod": 12, "rsiBelow": 36.5, "breadthMin": 0.85, "sellAbove": 85.0,
            "maxHold": 97, "frothLook": 120, "frothThr": 0.1, "frothBand": 0.05}


def param_space() -> dict:
    return {
        "coreSma": {"type": "int", "min": 20, "max": 600, "zero": True, "log": True,
                    "description": "hold while the close is above this SMA (0 = always hold unless froth)"},
        "rsiPeriod": {"type": "int", "min": 4, "max": 40, "description": "RSI length in candles"},
        "rsiBelow": {"type": "float", "min": 15, "max": 45,
                     "description": "a pool coin counts as oversold while its RSI is under this"},
        "breadthMin": {"type": "float", "min": 0.4, "max": 1.0,
                       "description": "panic buy when at least this fraction of the 2019 coin pool is oversold"},
        "sellAbove": {"type": "float", "min": 50, "max": 95,
                      "description": "end the dip trade when the coin's own RSI rises over this"},
        "maxHold": {"type": "int", "min": 5, "max": 500, "zero": True, "log": True,
                    "description": "end the dip trade after this many candles at the latest (0 = no limit)"},
        "frothLook": {"type": "int", "min": 20, "max": 400, "log": True,
                      "description": "candles over which the old alts' return is compared with BTC's"},
        "frothThr": {"type": "float", "min": 0.02, "max": 0.6, "zero": True,
                     "description": "step aside while old alts beat BTC by more than this log return (0 = off)"},
        "frothBand": {"type": "float", "min": 0.0, "max": 0.3,
                      "description": "back in once the alts' lead is under the threshold minus this"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["rsiBelow"]) >= float(p["sellAbove"]):
        return "rsiBelow must be below sellAbove"
    return None


def warmup(p: dict) -> int:
    return max(int(p["rsiPeriod"]), int(p.get("coreSma") or 0), int(p["frothLook"]))


def required_markets(spec: dict) -> list[str]:
    out = list(spec.get("markets") or [])
    return out + [m for m in POOL if m not in out]


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def panic(candles, p, idx) -> np.ndarray:
    """1.0 on bars where >= breadthMin of the pool is RSI-oversold, 0.0 otherwise, NaN while < MIN_POOL coins."""
    n = len(idx)
    low, defined = np.zeros(n), np.zeros(n)
    for m in POOL:
        if m not in candles or len(candles[m]) == 0:
            continue
        r = ind.rsi(candles[m]["close"].to_numpy(np.float64), int(p["rsiPeriod"]))
        flag = np.where(np.isfinite(r), (r < float(p["rsiBelow"])).astype(np.float64), np.nan)
        f = _asof(candles[m], flag, idx)
        low += np.nan_to_num(f, nan=0.0)
        defined += np.isfinite(f)
    frac = np.divide(low, defined, out=np.zeros(n), where=defined > 0)
    return np.where(defined >= MIN_POOL, (frac >= float(p["breadthMin"]) - 1e-12).astype(float), np.nan)


def froth_state(candles, p, idx) -> np.ndarray:
    """1.0 while in a froth exit, 0.0 otherwise (all 0 when frothThr is 0), NaN while the spread is undefined."""
    n = len(idx)
    thr = float(p.get("frothThr") or 0.0)
    if thr <= 0:
        return np.zeros(n)
    sp = froth_spread(candles, int(p["frothLook"]), idx)
    lo = thr - float(p["frothBand"])
    out = np.full(n, np.nan)
    inside = False
    for i, s in enumerate(sp.tolist()):
        if s != s:
            continue
        if inside:
            if s < lo:
                inside = False
        elif s > thr:
            inside = True
        out[i] = 1.0 if inside else 0.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    cap = panic(candles, p, idx)
    fr = froth_state(candles, p, idx)
    core_n, max_hold = int(p.get("coreSma") or 0), int(p.get("maxHold") or 0)
    sell_above = float(p["sellAbove"])
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        r = _asof(df, ind.rsi(c, int(p["rsiPeriod"])), idx)
        if core_n:
            s = ind.sma(c, core_n)
            core = _asof(df, np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan), idx)
        else:
            core = _asof(df, np.ones(len(df)), idx)
        w = np.full(n, np.nan)
        ok = (np.isfinite(cap) & np.isfinite(r) & np.isfinite(core) & np.isfinite(fr)).tolist()
        inside, held = False, 0
        capl, rl, corel, frl = cap.tolist(), r.tolist(), core.tolist(), fr.tolist()
        for i in range(n):
            if not ok[i]:
                continue
            if not inside:
                if capl[i] == 1.0:
                    inside, held = True, 0
            else:
                held += 1
                if rl[i] > sell_above or (max_hold and held >= max_hold):
                    inside = False
            on = (inside or corel[i] == 1.0) and frl[i] == 0.0
            w[i] = each if on else 0.0
        cols[m] = w
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
    share = f" ({100 / k:.0f} % of the money per coin)" if k > 1 else ""
    core_n = int(p.get("coreSma") or 0)
    steps = [
        (f"It holds {mk}{share} while the price is above its {bars_text(core_n, iv)} average (the trend core)."
         if core_n else f"It holds {mk}{share} by default."),
        f"After every {iv} candle it computes the RSI over {bars_text(p['rsiPeriod'], iv)} for eleven coins that "
        "were already trading in 2019 (BTC, ETH, XRP, ADA, LINK, TRX, LTC, BCH, XLM, XTZ, IOTA). When at least "
        f"{pct(p['breadthMin'])} of them have an RSI under {float(p['rsiBelow']):g} at once, the whole market is in "
        "a panic sell-off and it buys, even below the average.",
        f"It ends that dip purchase once the coin's own RSI climbs over {float(p['sellAbove']):g}"
        + (f", or after {bars_text(p['maxHold'], iv)} at the latest." if int(p.get('maxHold') or 0) else "."),
    ]
    if float(p.get("frothThr") or 0) > 0:
        steps.append(
            f"It sells everything and waits in euros while the nine old altcoins have beaten Bitcoin by more than "
            f"{pct(np.expm1(float(p['frothThr'])))} over {bars_text(p['frothLook'], iv)} (an alt-season frenzy that "
            f"usually ends badly), until that lead is back under "
            f"{pct(np.expm1(float(p['frothThr']) - float(p['frothBand'])))}.")
    return {
        "summary": f"Rides {mk}'s uptrends, buys market-wide panics and steps aside during altcoin frenzies.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets with sharp market-wide dips that recover, and alt-season tops followed by crashes.",
        "whenItLoses": "Choppy markets around the average, panics that keep falling, and healthy bull runs led by "
                       "altcoins (it waits in euros).",
    }
