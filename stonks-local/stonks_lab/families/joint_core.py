"""joint_core: BTC/ETH SMA core that reads the partner coin's trend too (agent-03).

BTC and ETH move together; when only one of them slips under its average while the other still trends up, the slip
is often noise, and a true bear breaks both. Each traded coin (BTC-EUR or ETH-EUR) has a peer (the other one):

- own  = close > SMA(ownSma) of the coin itself;  peer = the peer's close > SMA(peerSma) (as of the same bar).
- mode "or":  hold while own OR peer  (sell only when both trends are broken; buy when either is up)
- mode "and": hold while own AND peer (sell when either breaks)
- mode "own": hold while own (plain SMA core, the ablation)

Each traded market gets maxWeight / len(markets) while held. Only BTC-EUR and ETH-EUR, no alt list (no hindsight).
A decision at bar t uses candles up to and including t only; the peer is aligned "as of" the bar time.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "joint_core"
VERSION = 1
TITLE = "Trend core confirmed by the partner coin"
BOT_READY = False
MULTI_MARKET = True
PEER = {"BTC-EUR": "ETH-EUR", "ETH-EUR": "BTC-EUR"}


def default_params() -> dict:
    return {"ownSma": 100, "peerSma": 100, "mode": "or"}


def param_space() -> dict:
    return {
        "ownSma": {"type": "int", "min": 20, "max": 400, "log": True,
                   "description": "the coin's own trend: close above this SMA"},
        "peerSma": {"type": "int", "min": 20, "max": 400, "log": True,
                    "description": "the partner coin's trend: its close above this SMA"},
        "mode": {"type": "choice", "values": ["or", "and", "own"],
                 "description": "or = sell only when both trends break; and = sell when either breaks; own = ignore "
                                "the partner"},
    }


def valid_params(p: dict) -> str | None:
    return None


def warmup(p: dict) -> int:
    return max(int(p["ownSma"]), int(p["peerSma"])) - 1


def required_markets(spec: dict) -> list[str]:
    return ["BTC-EUR", "ETH-EUR"]


def _asof(df: pd.DataFrame, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _above(df: pd.DataFrame, n: int) -> np.ndarray:
    c = df["close"].to_numpy(np.float64)
    s = ind.sma(c, n)
    return np.where(np.isfinite(s), (c > s).astype(np.float64), np.nan)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    for m in markets:
        if m not in PEER:
            raise ValueError(f"joint_core trades BTC-EUR and/or ETH-EUR only, got {m}")
    idx = union_index(candles, markets)
    n = len(idx)
    each = max_weight(spec) / len(markets)
    mode = p.get("mode", "or")
    cols = []
    for m in markets:
        own = _asof(candles[m], _above(candles[m], int(p["ownSma"])), idx)
        if mode == "own":
            w = own
        else:
            pdf = candles[PEER[m]]
            peer = _asof(pdf, _above(pdf, int(p["peerSma"])), idx)
            ok = np.isfinite(own) & np.isfinite(peer)
            v = np.maximum(own, peer) if mode == "or" else np.minimum(own, peer)
            w = np.where(ok, v, np.nan)
        cols.append(w * each)
    W = np.column_stack(cols) if cols else np.zeros((n, 0))
    good = np.isfinite(W).all(axis=1)
    first = int(np.argmax(good)) if good.any() else n
    W[:first] = np.nan
    W[first:] = np.nan_to_num(W[first:], nan=0.0)
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    k = len(spec.get("markets") or [])
    mode = p.get("mode", "or")
    own = f"the coin's price is above its average of the last {bars_text(p['ownSma'], iv)}"
    peer = f"the partner coin (bitcoin for ether, ether for bitcoin) is above its average of the last " \
           f"{bars_text(p['peerSma'], iv)}"
    rule = {"or": f"It holds while {own}, or while {peer}: it only sells when both trends are broken.",
            "and": f"It holds only while {own} and {peer}: it sells as soon as either trend breaks.",
            "own": f"It holds while {own} (the partner coin is ignored in this variant)."}[mode]
    steps = [
        f"It trades {mk}" + (f", {100 / k:.0f} % of the money per coin." if k > 1 else "."),
        rule,
        "It checks this once per candle and otherwise keeps what it has.",
    ]
    return {
        "summary": f"A trend strategy on {mk} that also looks at whether the partner coin (BTC or ETH) is trending.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets where one coin dips under its average while the other keeps rising (or mode): "
                      "it sits through the dip; long bear markets where both fall: it waits in euros.",
        "whenItLoses": "Crashes where one coin leads the way down while the other lags, and sideways markets.",
    }
