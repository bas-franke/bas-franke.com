"""flow_froth v1 (agent-11): hold BTC/ETH, step aside while retail money on Bitvavo floods into old altcoins.

Signal ("flow"): the share of Bitvavo EUR turnover (volume x close) over the last `turnLen` candles that went into a
fixed pool of altcoins already listed in 2019 (alt_froth.OLD_ALTS: XRP ADA LINK TRX LTC BCH XLM XTZ MIOTA, no
hindsight in the coin list), against that pool plus BTC: share = alts / (alts + BTC). Because Bitvavo's mix drifts
over the years, the signal is the share minus its own rolling median over `baseLen` candles (`z`, share points).

Exit rule (`mode`):
  - flow: out while z > zMin (alt turnover far above normal).
  - and:  out while z > zMin AND the old alts' `lookback` log return leads BTC's by more than `threshold`
          (alt_froth's price signal): money AND price both say alt mania.
  - or:   out while either says so.
After an exit it stays out at least `minOut` candles. Otherwise every traded market holds maxWeight / markets.

Signal study (agent-11, 1d BTC, 2020-03..2025-10, gross, overlapping 30-day forward returns): top quintile of z
(30-candle turnover) -> BTC next-30-day log return -3.6 % vs +4..+9 % in the other quintiles. Days with z in the
top quintile AND alt_froth lb120 > 0.1: -6.7 % (n=261); price froth without high flow +5.2 % (n=174), flow without
price froth +2.0 % (n=144). Decisions at bar t use only candles up to t (other markets aligned as of t).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index
from .alt_froth import MIN_POOL, OLD_ALTS, _asof, froth

NAME = "flow_froth"
VERSION = 1
TITLE = "Altcoin money-flow exit"
BOT_READY = False
MULTI_MARKET = True
BTC = "BTC-EUR"
MODES = ["flow", "and", "or"]


def default_params() -> dict:
    return {"turnLen": 30, "baseLen": 365, "zMin": 0.15, "mode": "flow", "lookback": 120, "threshold": 0.1,
            "minOut": 0}


def param_space() -> dict:
    return {
        "turnLen": {"type": "int", "min": 3, "max": 120, "log": True,
                    "description": "candles of EUR turnover summed for the altcoin share"},
        "baseLen": {"type": "int", "min": 60, "max": 1000, "log": True,
                    "description": "candles in the rolling median the share is compared with"},
        "zMin": {"type": "float", "min": 0.0, "max": 0.4,
                 "description": "sell when the altcoin share of turnover is this far (share points) above normal"},
        "mode": {"type": "choice", "values": MODES,
                 "description": "flow: turnover signal alone; and: turnover AND price lead of the old alts; "
                                "or: either"},
        "lookback": {"type": "int", "min": 10, "max": 400, "log": True,
                     "description": "candles over which the old alts' return is compared with BTC's (and/or)"},
        "threshold": {"type": "float", "min": 0.0, "max": 0.6,
                      "description": "price signal: the old alts beat BTC by more than this log return"},
        "minOut": {"type": "int", "min": 1, "max": 200, "zero": True, "log": True,
                   "description": "stay out at least this many candles after an exit (0 = no minimum)"},
    }


def warmup(p: dict) -> int:
    w = int(p["turnLen"]) + int(p["baseLen"]) - 2
    if p.get("mode", "flow") != "flow":
        w = max(w, int(p["lookback"]))
    return w


def required_markets(spec: dict) -> list[str]:
    return [BTC, *OLD_ALTS]


def _turnover_sum(df: pd.DataFrame, n: int) -> np.ndarray:
    t = df["volume"].to_numpy(np.float64) * df["close"].to_numpy(np.float64)
    return pd.Series(t).rolling(n, min_periods=n).sum().to_numpy(np.float64)


def flow_z(candles: dict, turn_len: int, base_len: int, idx: np.ndarray) -> np.ndarray:
    """Old-alt share of EUR turnover over turn_len candles minus its rolling base_len median, on idx (NaN = undecided)."""
    n = len(idx)
    if BTC not in candles or len(candles[BTC]) == 0:
        return np.full(n, np.nan)
    alt, cnt = np.zeros(n), np.zeros(n)
    for m in OLD_ALTS:
        if m not in candles or len(candles[m]) == 0:
            continue
        s = _asof(candles[m], _turnover_sum(candles[m], turn_len), idx)
        alt += np.nan_to_num(s, nan=0.0)
        cnt += np.isfinite(s)
    btc = _asof(candles[BTC], _turnover_sum(candles[BTC], turn_len), idx)
    tot = alt + btc
    ok = (cnt >= MIN_POOL) & np.isfinite(btc) & (tot > 0)
    share = np.divide(alt, tot, out=np.full(n, np.nan), where=ok)
    med = pd.Series(share).rolling(base_len, min_periods=base_len).median().to_numpy(np.float64)
    return share - med


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    mode = p["mode"]
    z = flow_z(candles, int(p["turnLen"]), int(p["baseLen"]), idx)
    zmin, thr, min_out = float(p["zMin"]), float(p["threshold"]), int(p.get("minOut") or 0)
    if mode == "flow":
        sp = np.zeros(n)
        valid = np.isfinite(z)
    else:
        sp = froth(candles, int(p["lookback"]), idx)
        valid = np.isfinite(z) & np.isfinite(sp)
    hot_flow = np.where(np.isfinite(z), z > zmin, False)
    hot_price = np.where(np.isfinite(sp), sp > thr, False)
    hot = {"flow": hot_flow, "and": hot_flow & hot_price, "or": hot_flow | hot_price}[mode]
    each = max_weight(spec) / len(markets)
    state = np.full(n, np.nan)
    out_, since = False, 0
    for i in range(n):
        if not valid[i]:
            continue
        if out_:
            since += 1
            if not hot[i] and since >= min_out:
                out_ = False
        elif hot[i]:
            out_, since = True, 0
        state[i] = 0.0 if out_ else 1.0
    cols = {}
    for m in markets:
        listed = _asof(candles[m], np.ones(len(candles[m])), idx)
        cols[m] = state * listed * each
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
    mode = p["mode"]
    flow_txt = (f"the share of Bitvavo's euro trading volume over the last {bars_text(p['turnLen'], iv)} that went "
                f"into nine altcoins already traded in 2019 (XRP, ADA, LINK, TRX, LTC, BCH, XLM, XTZ, IOTA) "
                f"rather than Bitcoin is more than {100 * float(p['zMin']):.0f} percentage points above its usual "
                f"level (the median of the last {bars_text(p['baseLen'], iv)})")
    price_txt = (f"those altcoins have beaten Bitcoin by more than {pct(np.expm1(float(p['threshold'])))} over "
                 f"{bars_text(p['lookback'], iv)}")
    rule = {"flow": f"When {flow_txt}, ",
            "and": f"When {flow_txt} and at the same time {price_txt}, ",
            "or": f"When {flow_txt}, or when {price_txt}, "}[mode]
    steps = [
        f"It holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "") + " by default.",
        rule + "retail money is chasing altcoins, which tends to happen near a top: it sells everything and waits "
               "in euros.",
        "It buys back as soon as that is no longer the case"
        + (f" and at least {bars_text(p['minOut'], iv)} have passed." if int(p.get('minOut') or 0) else "."),
    ]
    return {
        "summary": f"Holds {mk}, but sells while retail trading on Bitvavo floods into old altcoins (a frothy-top "
                   "sign).",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Speculative blow-offs where small investors pile into altcoins just before a crash.",
        "whenItLoses": "Broad bull markets with lasting altcoin interest (it misses gains while in euros) and slow "
                       "bear markets without an altcoin frenzy (it never sells).",
    }
