"""rotation_gate v1 (agent-04): momentum rotation with a choice of market gate and gate hysteresis.

Selection is exactly rotation_momentum's: on every timestamp of the union of the markets' candles, each market with
`lookback` earlier candles in its own series gets ret = close[idx]/close[idx-lookback] - 1; markets with ret > 0 are
ranked (desc, ties by name) and the best `top` get maxWeight/top each.

What differs is the market gate that decides whether anything is held at all (`gate`):
  - none:      always allowed (plain rotation).
  - btc_sma:   BTC-EUR close vs SMA(gateLen) of BTC closes (rotation_momentum's regimeSma).
  - index_sma: an equal-weight index of the spec's markets (cumulated mean log return of the listed coins) vs its
               SMA(gateLen): "is the basket as a whole trending?".
  - breadth:   share of listed markets whose close is above their own SMA(gateLen); gate on when >= breadthMin.
  - btc_mom:   BTC-EUR return over gateLen candles > 0.
`band` adds hysteresis: the gate switches on only when the signal is `band` above its threshold (close > SMA*(1+band),
share >= breadthMin + band, momentum > band) and off only when it is `band` below it. band = 0 is the plain gate.

All gate series are computed on the union index with forward-filled closes (NaN before a market lists), so a
decision at t only uses closes up to t. Rows before the first warm bar (some market has a lookback return and the
gate signal has been defined) are NaN.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import aligned_close, bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "rotation_gate"
VERSION = 1
TITLE = "Momentum rotation with market gate"
BOT_READY = False
MULTI_MARKET = True
BTC = "BTC-EUR"
GATES = ["none", "btc_sma", "index_sma", "breadth", "btc_mom"]


def default_params() -> dict:
    return {"lookback": 20, "top": 3, "gate": "btc_sma", "gateLen": 50, "band": 0.0, "breadthMin": 0.5}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 2, "max": 400, "log": True,
                     "description": "candles over which each coin's return is measured for the ranking"},
        "top": {"type": "int", "min": 1, "max": 10, "description": "how many of the best coins to hold"},
        "gate": {"type": "choice", "values": GATES,
                 "description": "market gate: none, BTC above its SMA, equal-weight index above its SMA, share of "
                                "coins above their own SMA, or BTC momentum"},
        "gateLen": {"type": "int", "min": 5, "max": 400, "log": True,
                    "description": "SMA length (or momentum lookback for btc_mom) of the gate in candles"},
        "band": {"type": "float", "min": 0.0, "max": 0.15,
                 "description": "gate hysteresis: switch on this far above the threshold, off this far below"},
        "breadthMin": {"type": "float", "min": 0.2, "max": 0.9,
                       "description": "breadth gate: minimum share of coins above their own SMA"},
    }


def valid_params(p: dict) -> str | None:
    if int(p["top"]) < 1:
        return "top must be at least 1"
    if p["gate"] == "breadth" and not (float(p["breadthMin"]) - float(p["band"]) > 0
                                       and float(p["breadthMin"]) + float(p["band"]) <= 1):
        return "breadthMin +- band must stay inside (0, 1]"
    return None


def warmup(p: dict) -> int:
    g = p.get("gate", "none")
    n = int(p["gateLen"])
    gw = 0 if g == "none" else (n if g == "btc_mom" else n - 1)
    return max(int(p["lookback"]), gw)


def required_markets(spec: dict) -> list[str]:
    g = (spec.get("params") or {}).get("gate", default_params()["gate"])
    return [BTC] if g in ("btc_sma", "btc_mom") else []


def _hysteresis(sig: np.ndarray, hi: float, lo: float) -> np.ndarray:
    """on when sig > hi (from off), off when sig <= lo (from on); NaN signal = off."""
    on = np.zeros(len(sig), dtype=bool)
    state = False
    for t, x in enumerate(sig):
        if not np.isfinite(x):
            state = False
        elif state:
            state = not (x <= lo)
        else:
            state = x > hi
        on[t] = state
    return on


def _gate(candles, markets, idx, p):
    """(gate_on, gate_warm) boolean arrays on idx."""
    n = len(idx)
    g, L, band = p["gate"], int(p["gateLen"]), float(p["band"])
    if g == "none":
        return np.ones(n, dtype=bool), np.ones(n, dtype=bool)
    if g in ("btc_sma", "btc_mom"):
        if BTC not in candles:
            raise KeyError(f"rotation_gate gate={g} needs {BTC} candles")
        c = aligned_close(candles, BTC, idx)
        if g == "btc_sma":
            s = ind.sma(c, L)
            sig = c / s - 1.0
        else:
            sig = ind.rolling_return(c, L)
        return _hysteresis(sig, band, -band), np.isfinite(sig)
    closes = np.vstack([aligned_close(candles, m, idx) for m in markets])  # (M, n)
    if g == "index_sma":
        with np.errstate(divide="ignore", invalid="ignore"):
            lr = np.log(closes[:, 1:] / closes[:, :-1])
        ok = np.isfinite(lr)
        cnt = ok.sum(axis=0)
        mean = np.where(cnt > 0, np.where(ok, lr, 0.0).sum(axis=0) / np.maximum(cnt, 1), np.nan)
        started = np.isfinite(closes).any(axis=0)
        level = np.full(n, np.nan)
        first = int(np.argmax(started)) if started.any() else n
        if first < n:
            steps = np.nan_to_num(mean[first:], nan=0.0)  # bars after the first listing; no listed return = flat
            level[first] = 1.0
            level[first + 1:] = np.exp(np.cumsum(steps))
        s = ind.sma(level, L)
        sig = level / s - 1.0
        return _hysteresis(sig, band, -band), np.isfinite(sig)
    # breadth
    above = np.zeros_like(closes)
    valid = np.zeros_like(closes, dtype=bool)
    for j in range(len(markets)):
        s = ind.sma(closes[j], L)
        valid[j] = np.isfinite(s) & np.isfinite(closes[j])
        above[j] = valid[j] & (closes[j] > s)
    cnt = valid.sum(axis=0)
    share = np.where(cnt > 0, above.sum(axis=0) / np.maximum(cnt, 1), np.nan)
    bmin = float(p["breadthMin"])
    # share >= bmin + band switches on; share < bmin - band switches off (strict/non-strict as in a plain gate).
    eps = 1e-12
    return _hysteresis(share, bmin + band - eps, bmin - band - eps), np.isfinite(share)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    lookback, top = int(p["lookback"]), int(p["top"])
    idx = union_index(candles, markets)
    n = len(idx)
    rets = np.full((len(markets), n), np.nan)
    for j, m in enumerate(markets):
        df = candles[m]
        r = ind.rolling_return(df["close"].to_numpy(np.float64), lookback)
        pos = np.searchsorted(idx, np.asarray(df.index, dtype=np.int64))
        rets[j, pos] = r
    gate_on, gate_warm = _gate(candles, markets, idx, p)
    warm = np.isfinite(rets).any(axis=0) & np.maximum.accumulate(gate_warm)
    first = int(np.argmax(warm)) if warm.any() else n
    each = max_weight(spec) / top
    W = np.zeros((n, len(markets)))
    W[:first] = np.nan
    order_names = np.argsort(np.argsort(np.array(markets)))
    pos_ret = np.where(np.isfinite(rets) & (rets > 0), rets, -np.inf)
    for t in range(first, n):
        if not gate_on[t]:
            continue
        col = pos_ret[:, t]
        cand = np.flatnonzero(col > -np.inf)
        if len(cand) == 0:
            continue
        if len(cand) > top:
            cand = sorted(cand.tolist(), key=lambda j: (-col[j], order_names[j]))[:top]
        W[t, cand] = each
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    top = int(p["top"])
    g, L, band = p["gate"], int(p["gateLen"]), float(p["band"])
    steps = [
        f"After every {iv} candle it measures how much each of {mk} rose or fell over the last "
        f"{bars_text(p['lookback'], iv)}.",
        f"It holds the {top} best performer{'s' if top > 1 else ''}, each with an equal share of the money "
        f"({100 / top:.0f} % each), as long as they actually went up; coins that fell are never held.",
    ]
    gate_text = {
        "none": "There is no market filter: it is always looking for risers.",
        "btc_sma": f"Market filter: it only holds coins while bitcoin is above its {bars_text(L, iv)} average.",
        "index_sma": f"Market filter: it only holds coins while an equal-weight index of all these coins is above "
                     f"its {bars_text(L, iv)} average.",
        "breadth": f"Market filter: it only holds coins while at least {100 * float(p['breadthMin']):.0f} % of the "
                   f"coins are above their own {bars_text(L, iv)} average.",
        "btc_mom": f"Market filter: it only holds coins while bitcoin is higher than {bars_text(L, iv)} ago.",
    }[g]
    steps.append(gate_text + " Otherwise everything goes to euros.")
    if g != "none" and band > 0:
        steps.append(f"To avoid flip-flopping, the filter switches on only once the signal is {100 * band:.1f} % "
                     "past its threshold and off only once it is the same distance below it.")
    return {
        "summary": "Rotates into the coins that are rising the fastest and steps into euros when the market as a "
                   "whole turns down.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets where a few coins lead for weeks; the filter sidesteps long bear markets.",
        "whenItLoses": "Choppy markets around the filter's threshold and sharp reversals right after it buys "
                       "yesterday's winners.",
    }
