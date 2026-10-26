"""rotation_blend v1 (agent-08): momentum rotation ranked over several look-back horizons at once.

rotation_momentum ranks coins by one `lookback` return, and its score swings with that one number (findings
#112/#139/#172). Here every coin gets a rank per horizon (lookback, lookback*mult, lookback*mult^2, ... `horizons`
of them, each measured on the coin's own series) and the coins are ordered by their average rank (ties: average
return, then market name). A coin is only eligible while its average return over the horizons is > 0 (`absMom`);
the best `top` eligible coins get maxWeight/top each, unused slots stay cash. With regimeSma > 0 everything is
cash unless BTC-EUR closes above its SMA(regimeSma) at that bar (same gate as rotation_momentum).

A coin needs history for its longest horizon before it can be ranked. Rows before the first bar where some coin
is rankable (and the regime SMA has been defined, if used) are NaN. Decisions at bar t use closes up to t only.
"""
from __future__ import annotations

import numpy as np

from .. import indicators as ind
from ._base import bars_text, frame, market_names, max_weight, risk_steps, union_index

NAME = "rotation_blend"
VERSION = 1
TITLE = "Multi-horizon momentum rotation"
BOT_READY = False
MULTI_MARKET = True
REGIME_MARKET = "BTC-EUR"


def default_params() -> dict:
    return {"lookback": 10, "mult": 2.0, "horizons": 3, "top": 3, "regimeSma": 50, "absMom": True}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 2, "max": 200, "log": True,
                     "description": "shortest horizon: return over this many candles"},
        "mult": {"type": "float", "min": 1.3, "max": 3.0,
                 "description": "each next horizon is this many times longer"},
        "horizons": {"type": "int", "min": 1, "max": 4, "description": "number of horizons whose ranks are averaged"},
        "top": {"type": "int", "min": 1, "max": 10, "description": "how many of the best-ranked coins to hold"},
        "regimeSma": {"type": "int", "min": 10, "max": 400, "zero": True, "log": True,
                      "description": "only hold coins while BTC is above this SMA (0 = off)"},
        "absMom": {"type": "bool",
                   "description": "only hold coins whose average return over the horizons is positive"},
    }


def horizon_list(p: dict) -> list[int]:
    out = []
    for k in range(int(p["horizons"])):
        h = max(1, int(round(int(p["lookback"]) * float(p["mult"]) ** k)))
        if h not in out:
            out.append(h)
    return out


def valid_params(p: dict) -> str | None:
    if int(p["top"]) < 1:
        return "top must be at least 1"
    if max(horizon_list(p)) > 1000:
        return "longest horizon must be at most 1000 candles"
    return None


def warmup(p: dict) -> int:
    r = int(p.get("regimeSma") or 0)
    return max(max(horizon_list(p)), r - 1 if r > 0 else 0)


def required_markets(spec: dict) -> list[str]:
    return [REGIME_MARKET] if int((spec.get("params") or {}).get("regimeSma") or 0) > 0 else []


def _regime(candles, idx, regime_n):
    n = len(idx)
    if REGIME_MARKET not in candles:
        raise KeyError(f"rotation_blend with regimeSma needs {REGIME_MARKET} candles")
    b = candles[REGIME_MARKET]
    bts = np.asarray(b.index, dtype=np.int64)
    bc = b["close"].to_numpy(np.float64)
    bs = ind.sma(bc, regime_n)
    bpos = np.searchsorted(idx, bts)
    inside = bpos < n
    bpos, bc, bs, bts = bpos[inside], bc[inside], bs[inside], bts[inside]
    match = idx[bpos] == bts
    reg_warm = np.zeros(n, dtype=bool)
    ok = np.zeros(n, dtype=bool)
    reg_warm[bpos[match]] = np.isfinite(bs[match])
    ok[bpos[match]] = np.isfinite(bs[match]) & (bc[match] > bs[match])
    return ok, np.maximum.accumulate(reg_warm)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    hs = horizon_list(p)
    top, regime_n, abs_mom = int(p["top"]), int(p.get("regimeSma") or 0), bool(p.get("absMom", True))
    idx = union_index(candles, markets)
    n, M, H = len(idx), len(markets), len(hs)
    rets = np.full((H, M, n), np.nan)
    for j, m in enumerate(markets):
        df = candles[m]
        c = df["close"].to_numpy(np.float64)
        pos = np.searchsorted(idx, np.asarray(df.index, dtype=np.int64))
        for k, h in enumerate(hs):
            rets[k, j, pos] = ind.rolling_return(c, h)
    ready = np.isfinite(rets).all(axis=0)  # (M, n): coin rankable at t
    warm = ready.any(axis=0)
    regime_ok = np.ones(n, dtype=bool)
    if regime_n > 0:
        regime_ok, reg_warm = _regime(candles, idx, regime_n)
        warm &= reg_warm
    first = int(np.argmax(warm)) if warm.any() else n
    each = max_weight(spec) / top
    W = np.zeros((n, M))
    W[:first] = np.nan
    name_rank = np.argsort(np.argsort(np.array(markets)))
    mean_ret = rets.mean(axis=0)  # NaN unless the coin is rankable; only read for rankable coins
    for t in range(first, n):
        if not regime_ok[t]:
            continue
        cand = np.flatnonzero(ready[:, t])
        if len(cand) == 0:
            continue
        # Average rank (0 = best) over the horizons, among the rankable coins only.
        score = np.zeros(len(cand))
        for k in range(H):
            r = rets[k, cand, t]
            order = sorted(range(len(cand)), key=lambda i: (-r[i], name_rank[cand[i]]))
            rk = np.empty(len(cand))
            rk[order] = np.arange(len(cand))
            score += rk
        mr = mean_ret[cand, t]
        keep = [i for i in range(len(cand)) if (mr[i] > 0 or not abs_mom)]
        keep.sort(key=lambda i: (score[i], -mr[i], name_rank[cand[i]]))
        for i in keep[:top]:
            W[t, cand[i]] = each
    return frame(idx, {m: W[:, j] for j, m in enumerate(markets)})


def explain(spec) -> dict:
    p, iv = spec["params"], spec.get("interval")
    mk = market_names(spec)
    top = int(p["top"])
    hs = horizon_list(p)
    hz = ", ".join(bars_text(h, iv) for h in hs)
    steps = [
        f"After every {iv} candle it measures how much each of {mk} rose or fell over {len(hs)} periods: {hz}.",
        "For each period the coins are ranked from best to worst; a coin's overall place is its average rank, so a "
        "coin must lead over short and longer stretches, not just one.",
        f"It holds the {top} best-placed coin{'s' if top > 1 else ''}, each with an equal share "
        f"({100 / top:.0f} % each).",
    ]
    if bool(p.get("absMom", True)):
        steps.append("A coin whose average return over those periods is negative is never held; its share stays "
                     "in euros.")
    if int(p.get("regimeSma") or 0) > 0:
        steps.append(f"Market filter: it only holds coins while bitcoin is above its "
                     f"{bars_text(p['regimeSma'], iv)} average price; otherwise everything goes to euros.")
    return {
        "summary": "Rotates into the coins that have been rising fastest over several time spans at once, and steps "
                   "into euros when bitcoin's trend breaks.",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Bull markets where a few coins lead for weeks or months.",
        "whenItLoses": "Sharp reversals and choppy markets: the leaders turn just after it buys them, and switching "
                       "costs fees.",
    }
