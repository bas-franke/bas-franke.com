"""vote_blend v1 (agent-16, ensemble lane): AVERAGE the votes of weakly related no-hindsight signals instead of
AND/OR-ing them, plus a panic-buy override.

The honest BTC/ETH leads of the fleet each fix a different weakness of holding: an SMA trend core and a slow daily
MACD (2022-style slow bears), alt_froth (#255: old alts outrunning BTC before blow-off tops) and a market-wide panic
buy (#213/#245: V-recoveries the trend core re-enters late). froth_dip / core_dip combine them with AND/OR, which
gives an all-or-nothing position. Here every enabled "state" voter is 0 or 1 per bar and the position is

    weight = maxWeight / len(markets) * agg(voters)      agg = mean (mode avg), min (all) or max (any)
    weight = maxWeight / len(markets)                    while a panic dip trade is open (override)

Voters (each can be switched off):
- core:  the market's close > SMA(coreSma)
- macd:  the market's MACD(macdFast, macdSlow) line > its signal EMA(macdSignal)
- calm:  NOT in an alt-froth exit: the mean frothLook log return of 9 alts listed on Bitvavo by 2019 minus BTC's is
         above frothThr -> froth, until it is back under frothThr - frothBand (alt_froth's signal)
Panic ("pair": BTC's and ETH's RSI(rsiPeriod) both < rsiBelow; "pool": at least breadthMin of the 2019 pool BTC, ETH
and the 9 old alts has RSI < rsiBelow; "off") opens a dip trade that ends when the market's own RSI > sellAbove or
after maxHold candles. With no voter enabled the core weight is 0 (panic trades only).

All coin lists are fixed and were known in 2019 (no survivorship). Other markets are aligned "as of" the bar time,
so a decision at bar t uses nothing after t.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from .alt_froth import OLD_ALTS, froth as froth_spread

NAME = "vote_blend"
VERSION = 1
TITLE = "Averaged signal votes with panic buys"
BOT_READY = False
MULTI_MARKET = True
PAIR = ["BTC-EUR", "ETH-EUR"]
POOL = ["BTC-EUR", "ETH-EUR", *OLD_ALTS]
MIN_POOL = 3


def default_params() -> dict:
    return {"mode": "avg", "useCore": True, "coreSma": 132, "useMacd": True, "macdFast": 12, "macdSlow": 182,
            "macdSignal": 30, "useFroth": True, "frothLook": 120, "frothThr": 0.1, "frothBand": 0.05,
            "panic": "pair", "rsiPeriod": 25, "rsiBelow": 37.0, "breadthMin": 0.85, "sellAbove": 85.0,
            "maxHold": 90}


def param_space() -> dict:
    return {
        "mode": {"type": "choice", "values": ["avg", "all", "any"],
                 "description": "how the voters combine: average (fractional position), all must agree, any one"},
        "useCore": {"type": "bool", "description": "voter: close above its SMA"},
        "coreSma": {"type": "int", "min": 20, "max": 400, "log": True, "description": "SMA length of the core voter"},
        "useMacd": {"type": "bool", "description": "voter: MACD line above its signal line"},
        "macdFast": {"type": "int", "min": 4, "max": 40, "log": True, "description": "fast EMA of the MACD"},
        "macdSlow": {"type": "int", "min": 30, "max": 400, "log": True, "description": "slow EMA of the MACD"},
        "macdSignal": {"type": "int", "min": 5, "max": 80, "log": True, "description": "signal EMA of the MACD"},
        "useFroth": {"type": "bool", "description": "voter: no alt-season froth (old alts not far ahead of BTC)"},
        "frothLook": {"type": "int", "min": 30, "max": 300, "log": True,
                      "description": "candles over which the old alts' return is compared with BTC's"},
        "frothThr": {"type": "float", "min": 0.02, "max": 0.4,
                     "description": "froth while old alts beat BTC by more than this log return"},
        "frothBand": {"type": "float", "min": 0.0, "max": 0.2,
                      "description": "froth ends once the alts' lead is under the threshold minus this"},
        "panic": {"type": "choice", "values": ["off", "pair", "pool"],
                  "description": "panic buy trigger: BTC and ETH RSI both oversold (pair), most of the 2019 pool "
                                 "oversold (pool), or none"},
        "rsiPeriod": {"type": "int", "min": 4, "max": 40, "description": "RSI length of the panic signal"},
        "rsiBelow": {"type": "float", "min": 15, "max": 45, "description": "a coin is oversold under this RSI"},
        "breadthMin": {"type": "float", "min": 0.4, "max": 1.0,
                       "description": "pool panic: fraction of the 2019 pool that must be oversold"},
        "sellAbove": {"type": "float", "min": 40, "max": 95,
                      "description": "a dip trade ends when the market's own RSI rises over this"},
        "maxHold": {"type": "int", "min": 5, "max": 400, "zero": True, "log": True,
                    "description": "a dip trade ends after this many candles at the latest (0 = no limit)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["rsiBelow"]) >= float(p["sellAbove"]):
        return "rsiBelow must be below sellAbove"
    if int(p["macdFast"]) >= int(p["macdSlow"]):
        return "macdFast must be below macdSlow"
    if not (p.get("useCore") or p.get("useMacd") or p.get("useFroth")) and p.get("panic", "off") == "off":
        return "needs at least one voter or a panic trigger"
    return None


def warmup(p: dict) -> int:
    w = [int(p["rsiPeriod"]) if p.get("panic", "off") != "off" else 1]
    if p.get("useCore"):
        w.append(int(p["coreSma"]) - 1)
    if p.get("useMacd"):
        w.append(int(p["macdSlow"]) + int(p["macdSignal"]) - 2)
    if p.get("useFroth"):
        w.append(int(p["frothLook"]))
    return max(w)


def required_markets(spec: dict) -> list[str]:
    p = {**default_params(), **(spec.get("params") or {})}
    extra = []
    if p.get("useFroth"):
        extra += ["BTC-EUR", *OLD_ALTS]
    if p.get("panic") == "pair":
        extra += PAIR
    elif p.get("panic") == "pool":
        extra += POOL
    out = list(spec.get("markets") or [])
    for m in extra:
        if m not in out:
            out.append(m)
    return out


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _flag(cond: np.ndarray, defined: np.ndarray) -> np.ndarray:
    return np.where(defined, cond.astype(np.float64), np.nan)


def panic_signal(candles, p, idx) -> np.ndarray:
    """1.0 on panic bars, 0.0 otherwise, NaN while undefined; all 0 when panic is off."""
    n = len(idx)
    kind = p.get("panic", "off")
    if kind == "off":
        return np.zeros(n)
    below, per = float(p["rsiBelow"]), int(p["rsiPeriod"])
    coins = PAIR if kind == "pair" else POOL
    low, defined = np.zeros(n), np.zeros(n)
    for m in coins:
        if m not in candles or len(candles[m]) == 0:
            continue
        r = ind.rsi(candles[m]["close"].to_numpy(np.float64), per)
        f = _asof(candles[m], _flag(r < below, np.isfinite(r)), idx)
        low += np.nan_to_num(f, nan=0.0)
        defined += np.isfinite(f)
    if kind == "pair":
        return np.where(defined >= len(PAIR), (low >= len(PAIR)).astype(float), np.nan)
    frac = np.divide(low, defined, out=np.zeros(n), where=defined > 0)
    return np.where(defined >= MIN_POOL, (frac >= float(p["breadthMin"]) - 1e-12).astype(float), np.nan)


def calm_vote(candles, p, idx) -> np.ndarray:
    """1.0 while NOT in an alt-froth exit, 0.0 inside one, NaN while the spread is undefined."""
    n = len(idx)
    sp = froth_spread(candles, int(p["frothLook"]), idx)
    thr = float(p["frothThr"])
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
        out[i] = 0.0 if inside else 1.0
    return out


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    mode = p.get("mode", "avg")
    pan = panic_signal(candles, p, idx)
    calm = calm_vote(candles, p, idx) if p.get("useFroth") else None
    max_hold, sell_above = int(p.get("maxHold") or 0), float(p["sellAbove"])
    use_panic = p.get("panic", "off") != "off"
    each = max_weight(spec) / len(markets)
    cols = {}
    for m in markets:
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        votes = []
        if p.get("useCore"):
            s = ind.sma(c, int(p["coreSma"]))
            votes.append(_asof(df, _flag(c > s, np.isfinite(s)), idx))
        if p.get("useMacd"):
            line, sig, _ = ind.macd(c, int(p["macdFast"]), int(p["macdSlow"]), int(p["macdSignal"]))
            votes.append(_asof(df, _flag(line > sig, np.isfinite(line) & np.isfinite(sig)), idx))
        if calm is not None:
            votes.append(calm)
        if votes:
            V = np.vstack(votes)
            agg = {"avg": np.mean, "all": np.min, "any": np.max}[mode](V, axis=0)   # NaN if any voter undefined
        else:
            agg = np.zeros(n)
        r = _asof(df, ind.rsi(c, int(p["rsiPeriod"])), idx) if use_panic else np.zeros(n)
        ok = (np.isfinite(agg) & np.isfinite(pan) & np.isfinite(r)).tolist()
        aggl, panl, rl = agg.tolist(), pan.tolist(), r.tolist()
        w = np.full(n, np.nan)
        inside, held = False, 0
        for i in range(n):
            if not ok[i]:
                continue
            if use_panic:
                if not inside:
                    if panl[i] == 1.0:
                        inside, held = True, 0
                else:
                    held += 1
                    if rl[i] > sell_above or (max_hold and held >= max_hold):
                        inside = False
            w[i] = each if inside else each * aggl[i]
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
    voters = []
    if p.get("useCore"):
        voters.append(f"the price is above its {bars_text(p['coreSma'], iv)} average")
    if p.get("useMacd"):
        voters.append(f"a slow MACD ({p['macdFast']}/{p['macdSlow']}/{p['macdSignal']} candles) points up")
    if p.get("useFroth"):
        voters.append(f"nine altcoins that already traded in 2019 have NOT beaten Bitcoin by more than "
                      f"{pct(np.expm1(float(p['frothThr'])))} over {bars_text(p['frothLook'], iv)} (no alt-season "
                      "frenzy)")
    mode = p.get("mode", "avg")
    steps = []
    if voters:
        how = {"avg": "It holds a share of the money equal to the share of these checks that are positive",
               "all": "It holds only while all of these checks are positive",
               "any": "It holds while at least one of these checks is positive"}[mode]
        steps.append(f"After every {iv} candle it asks: " + "; ".join(voters) + ".")
        steps.append(f"{how} (in {mk}{share}).")
    kind = p.get("panic", "off")
    if kind != "off":
        who = ("Bitcoin's and Ether's RSI are both" if kind == "pair" else
               f"at least {pct(p['breadthMin'])} of eleven coins that traded in 2019 have an RSI")
        steps.append(f"When {who} under {float(p['rsiBelow']):g} (RSI over {bars_text(p['rsiPeriod'], iv)}), the "
                     f"market is in a panic sell-off: it buys the full position, whatever the checks say,")
        steps.append(f"and keeps it until the coin's own RSI climbs over {float(p['sellAbove']):g}"
                     + (f" or {bars_text(p['maxHold'], iv)} have passed." if int(p.get('maxHold') or 0) else "."))
    return {
        "summary": f"Scales {mk} up and down with a vote of trend and froth checks, and buys market-wide panics.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Long bull runs (all checks positive), slow bears (the trend checks sell) and sharp crashes "
                      "that recover (the panic buy).",
        "whenItLoses": "Choppy sideways markets where the checks flip back and forth, and bull runs led by "
                       "altcoins (the froth check sells early).",
    }
