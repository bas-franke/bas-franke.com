"""altseason_a05 v1: hold BTC/ETH, step aside during an "altcoin season" measured by BREADTH (agent-05).

alt_froth measures froth by magnitude (the old-alt pool's mean return minus BTC's > threshold). This family uses the
folklore "altcoin season index" instead: the SHARE of a fixed pool of old altcoins (listed on Bitvavo by 2019, no
hindsight in the list: XRP ADA LINK TRX LTC BCH XLM XTZ MIOTA) whose `lookback`-candle return beats BTC's. The
folklore definition is 75 % of the alts beating BTC over 90 days, which fixes the default knobs before any test.

While the share is >= `share` the strategy holds no coins; it buys back once the share is below `share - band`.
`lead` "mean" also requires the pool's MEAN return to beat BTC's (alt_froth's magnitude signal at threshold 0), so
a "season" needs both breadth and size; with share 0.5 that is a rule with a single knob (lookback).
`horizons` "ladder" averages the share over lookback/2, lookback and 2*lookback (less sensitive to one window).
Otherwise it holds every traded market with an equal slice of maxWeight. A decision at bar t uses only candles up to
t (other markets are aligned "as of" the bar time).
"""
from __future__ import annotations

import numpy as np

from ._base import bars_text, frame, market_names, max_weight, pct, risk_steps, union_index

NAME = "altseason_a05"
VERSION = 2  # v2 adds the optional mean-lead confirmation (lead); v1 rows = lead "off"
TITLE = "Altcoin season breadth exit"
BOT_READY = False
MULTI_MARKET = True
OLD_ALTS = ["XRP-EUR", "ADA-EUR", "LINK-EUR", "TRX-EUR", "LTC-EUR", "BCH-EUR", "XLM-EUR", "XTZ-EUR", "MIOTA-EUR"]
MIN_POOL = 5


def default_params() -> dict:
    return {"lookback": 90, "share": 0.75, "band": 0.0, "horizons": "single", "lead": "off"}


def param_space() -> dict:
    return {
        "lookback": {"type": "int", "min": 10, "max": 400, "log": True,
                     "description": "candles over which each old alt's return is compared with BTC's"},
        "share": {"type": "float", "min": 0.3, "max": 1.0,
                  "description": "step aside when at least this share of the old alts beats BTC"},
        "band": {"type": "float", "min": 0.0, "max": 0.4,
                 "description": "buy back once the share is under share minus this"},
        "horizons": {"type": "choice", "values": ["single", "ladder"],
                     "description": "single lookback, or the mean share over lookback/2, lookback, 2*lookback"},
        "lead": {"type": "choice", "values": ["off", "mean"],
                 "description": "mean: also require the pool's mean return to beat BTC's (both breadth and size)"},
    }


def valid_params(p: dict) -> str | None:
    if float(p["band"]) > float(p["share"]):
        return "band must not exceed share"
    return None


def _lbs(p: dict) -> list[int]:
    lb = int(p["lookback"])
    return [max(2, lb // 2), lb, 2 * lb] if p.get("horizons") == "ladder" else [lb]


def warmup(p: dict) -> int:
    return max(_lbs(p))


def required_markets(spec: dict) -> list[str]:
    return ["BTC-EUR", *OLD_ALTS]


def _asof(df, values: np.ndarray, idx: np.ndarray) -> np.ndarray:
    t = np.asarray(df.index, dtype=np.int64)
    v = np.asarray(values, dtype=np.float64)
    pos = np.searchsorted(t, idx, side="right") - 1
    out = np.full(len(idx), np.nan)
    ok = pos >= 0
    out[ok] = v[pos[ok]]
    return out


def _logret(df, n: int) -> np.ndarray:
    c = np.log(df["close"].to_numpy(np.float64))
    out = np.full(len(c), np.nan)
    if len(c) > n:
        out[n:] = c[n:] - c[:-n]
    return out


def breadth(candles: dict, lookback: int, idx: np.ndarray) -> np.ndarray:
    """Share of the old-alt pool whose lookback log return beats BTC's, on idx; NaN while < MIN_POOL alts."""
    n = len(idx)
    if "BTC-EUR" not in candles or len(candles["BTC-EUR"]) == 0:
        return np.full(n, np.nan)
    btc = _asof(candles["BTC-EUR"], _logret(candles["BTC-EUR"], lookback), idx)
    win, cnt = np.zeros(n), np.zeros(n)
    for m in OLD_ALTS:
        if m not in candles or len(candles[m]) == 0:
            continue
        r = _asof(candles[m], _logret(candles[m], lookback), idx)
        ok = np.isfinite(r) & np.isfinite(btc)
        win += np.where(ok, r > btc, False)
        cnt += ok
    return np.divide(win, cnt, out=np.full(n, np.nan), where=cnt >= MIN_POOL)


def mean_lead(candles: dict, lookback: int, idx: np.ndarray) -> np.ndarray:
    """Mean lookback log return of the old-alt pool minus BTC's (alt_froth's froth), NaN while < MIN_POOL alts."""
    n = len(idx)
    if "BTC-EUR" not in candles or len(candles["BTC-EUR"]) == 0:
        return np.full(n, np.nan)
    btc = _asof(candles["BTC-EUR"], _logret(candles["BTC-EUR"], lookback), idx)
    tot, cnt = np.zeros(n), np.zeros(n)
    for m in OLD_ALTS:
        if m not in candles or len(candles[m]) == 0:
            continue
        r = _asof(candles[m], _logret(candles[m], lookback), idx)
        ok = np.isfinite(r) & np.isfinite(btc)
        tot += np.where(ok, r - btc, 0.0)
        cnt += ok
    return np.divide(tot, cnt, out=np.full(n, np.nan), where=cnt >= MIN_POOL)


def targets(candles, spec, start_time=None):
    p = spec["params"]
    markets = list(spec["markets"])
    idx = union_index(candles, markets)
    n = len(idx)
    sh = np.mean([breadth(candles, lb, idx) for lb in _lbs(p)], axis=0)  # NaN until every horizon is defined
    if p.get("lead", "off") == "mean":
        ld = np.mean([mean_lead(candles, lb, idx) for lb in _lbs(p)], axis=0)
        sh = np.where(np.isfinite(ld), np.where(ld > 0, sh, np.minimum(sh, 0.0)), np.nan)  # no lead -> no season
    hi, lo = float(p["share"]), float(p["share"]) - float(p["band"])
    each = max_weight(spec) / len(markets)
    state = np.full(n, np.nan)
    out_ = False
    for i, s in enumerate(sh.tolist()):
        if not np.isfinite(s):
            continue
        if out_:
            if s < lo:
                out_ = False
        elif s >= hi:
            out_ = True
        state[i] = 0.0 if out_ else 1.0
    cols = {}
    for m in markets:
        have = _asof(candles[m], np.ones(len(candles[m])), idx)
        cols[m] = state * have * each
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
    lbs = " / ".join(bars_text(x, iv) for x in _lbs(p))
    steps = [
        f"It holds {mk}" + (f" ({100 / k:.0f} % of the money per coin)" if k > 1 else "") + " by default.",
        f"After every {iv} candle it counts how many of nine altcoins that were already trading in 2019 (XRP, ADA, "
        f"LINK, TRX, LTC, BCH, XLM, XTZ, IOTA) did better than Bitcoin over the last {lbs}"
        + (" (averaged over those windows)." if len(_lbs(p)) > 1 else "."),
        f"When at least {pct(float(p['share']))} of them beat Bitcoin, it calls an 'altcoin season', a frothy phase "
        "that tends to end in a crash: it sells everything and waits in euros.",
        f"It buys back once fewer than {pct(float(p['share']) - float(p['band']))} of them are ahead of Bitcoin.",
    ]
    if p.get("lead", "off") == "mean":
        steps.insert(3, "It only calls it a season while those altcoins are also ahead of Bitcoin on average; once "
                        "their average lead is gone it buys back.")
    return {
        "summary": f"Holds {mk}, but sells during an 'altcoin season' (most old altcoins beating Bitcoin).",
        "howItWorks": steps + risk_steps(spec),
        "whenItWins": "Speculative alt-season blow-offs (2021-style tops) that end in a broad crash.",
        "whenItLoses": "Broad healthy rallies where altcoins keep beating Bitcoin for months; it then waits in euros "
                       "while prices rise.",
    }
