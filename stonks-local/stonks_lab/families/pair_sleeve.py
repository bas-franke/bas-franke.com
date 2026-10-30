"""pair_sleeve v1: a single-coin book run on several coins from one shared euro wallet.

Every book the research ranks is scored per coin with its own wallet. The bot has one wallet, so this wrapper gives
each market a fixed share of it: the target for market m is share[m] x what the frozen ``inner`` book wants on m alone.
The inner book runs once per market, on that market's own candles, exactly as in its single-coin run, so it gives the
same signals; only the sizes are scaled. Nothing moves between the sleeves: money a sleeve does not use stays in euros.

    "params": {"inner": {"family": "s9_cyclebull", "params": {...}}, "share": {"BTC-EUR": 0.5, "ETH-EUR": 0.5}}

``inner`` and ``share`` are objects outside the param space (like floor_wrap_a07): a different book is a different
spec. An empty ``share`` splits equally; otherwise it names every spec market, each above 0, summing to at most 1.
A bar one market has no candle for keeps that market's last target (the bot would read a missing weight as "sell").
"""
from __future__ import annotations

import numpy as np

from . import get_family
from ._base import frame, market_names, max_weight, normalize_spec, pct, risk_steps, union_index

NAME = "pair_sleeve"
VERSION = 1
TITLE = "Shared wallet, one book per coin"
BOT_READY = False
MULTI_MARKET = True

DEFAULT_INNER = {"family": "s7_ladder", "params": {}}


def default_params() -> dict:
    return {"inner": DEFAULT_INNER, "share": {}}


def param_space() -> dict:
    return {}


def valid_params(p: dict) -> str | None:
    inner = p.get("inner")
    if not isinstance(inner, dict) or not isinstance(inner.get("family"), str):
        return "inner must be {'family': name, 'params': {...}}"
    if inner["family"] == NAME:
        return "inner cannot be pair_sleeve itself"
    try:
        fam = get_family(inner["family"])
    except Exception:
        return f"unknown inner family {inner.get('family')!r}"
    if fam.multi_market:
        return "inner must be a single-coin family"
    if fam.anchored:
        return "anchored (DCA-style) inner families are not supported"
    share = p.get("share")
    if not isinstance(share, dict):
        return "share must be {market: part of the wallet}"
    for m, v in share.items():
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 < v <= 1:
            return f"share of {m} must be above 0 and at most 1"
    if sum(share.values()) > 1 + 1e-9:
        return "the shares add up to more than 1"
    return fam.validate({"params": dict(inner.get("params") or {})})


def _shares(spec: dict) -> dict[str, float]:
    markets = list(spec.get("markets") or [])
    raw = (spec.get("params") or {}).get("share") or {}
    if not raw:
        return {m: 1.0 / len(markets) for m in markets}
    if set(raw) != set(markets):
        raise ValueError(f"share must name exactly the spec markets {markets}, got {sorted(raw)}")
    return {m: float(raw[m]) for m in markets}


def _inner(spec: dict, market: str) -> tuple:
    inner = (spec.get("params") or {}).get("inner") or DEFAULT_INNER
    fam = get_family(inner["family"])
    s = {"family": inner["family"], "markets": [market], "interval": spec.get("interval"),
         "params": dict(inner.get("params") or {}), "risk": {"maxWeight": 1.0}}
    for k in ("universe", "execution"):
        if k in spec:
            s[k] = spec[k]
    return fam, normalize_spec(s, fam)


def warmup(p: dict) -> int:
    inner = p.get("inner") or DEFAULT_INNER
    fam = get_family(inner["family"])
    return int(fam.warmup({**fam.default_params(), **(inner.get("params") or {})}) or 0)


def required_markets(spec: dict) -> list[str]:
    _shares(spec)                 # the bot's save check (describe) refuses a share that misses a market
    out: list[str] = []
    for m in spec.get("markets") or []:
        fam, s = _inner(spec, m)
        out += [x for x in fam.markets_needed(s) if x not in out]
    return out


def targets(candles, spec, start_time=None):
    del start_time
    markets = list(spec["markets"])
    shares = _shares(spec)
    mw = max_weight(spec)
    idx = union_index(candles, markets)
    out = {}
    for m in markets:
        fam, s = _inner(spec, m)
        w = fam.targets(candles, s)[m].reindex(idx).ffill().to_numpy(np.float64)
        out[m] = np.clip(w, 0.0, 1.0) * shares[m] * mw
    return frame(idx, out)


def explain(spec) -> dict:
    p = spec["params"]
    markets = list(spec.get("markets") or [])
    name = (p.get("inner") or DEFAULT_INNER).get("family", "?")
    wins, loses, steps = "", "", []
    if markets:
        try:
            fam, s = _inner(spec, markets[0])
            ex = fam.explain(s)
            title = fam.title
            s["markets"] = ["each coin"]
            wins, loses, steps = ex.get("whenItWins", ""), ex.get("whenItLoses", ""), list(ex.get("howItWorks") or [])
        except Exception:  # pragma: no cover - explanation must never break publishing
            title = name
        shares = _shares(spec)
        split = " and ".join(f"{pct(shares[m])} {m.split('-')[0]}" for m in markets)
    else:
        title, split = name, "equal shares"
    mk = market_names(spec)
    head = [f"One wallet in euros, split {split}. Each coin runs the book '{title}' on its own candles with the "
            "same settings and the same signals as its single-coin run, and that coin's position is its share of the "
            "wallet times what the book asks for. Money a coin does not use stays in euros; it never moves to the other coin."]
    tail = [s_ for s_ in steps if not s_.startswith(("It never puts", "Orders are"))]
    return {
        "summary": f"The book '{title}' on {mk} from one shared wallet ({split}).",
        "howItWorks": head + tail + risk_steps(spec),
        "whenItWins": (wins + " " if wins else "") + "Two coins also spread the timing of the book's bets.",
        "whenItLoses": (loses + " " if loses else "") + "A rally in one coin only ever gets that coin's share of the money.",
    }
