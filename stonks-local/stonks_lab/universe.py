"""The trading universe: the top-10 non-stablecoin cryptos by market cap that have a ``-EUR`` market on Bitvavo.

``top10()`` returns markets like ``"BTC-EUR"`` from ``data/universe.json`` (built on first use). The default list
is fixed so research results stay comparable over time; a coin that is not tradable on Bitvavo is replaced by the
next one by market cap (CoinGecko's free API), skipping stablecoins and wrapped/staked tokens.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import requests

from . import data

DEFAULT_TOP10: tuple[str, ...] = ("BTC", "ETH", "XRP", "BNB", "SOL", "DOGE", "ADA", "TRX", "LINK", "AVAX")
COINGECKO_URL = "https://api.coingecko.com/api/v3/coins/markets"

# Coins that are not a sensible "market movement" signal: stablecoins, fiat-backed, wrapped and staked tokens.
EXCLUDED: frozenset[str] = frozenset({
    "USDT", "USDC", "DAI", "FDUSD", "USDE", "USDS", "TUSD", "PYUSD", "USDD", "EURC", "EURS", "EURT", "BUSD",
    "USD1", "RLUSD", "USDP", "GUSD", "FRAX", "LUSD", "USDG", "USDT0", "BSC-USD", "XAUT", "PAXG",
    "WBTC", "WETH", "STETH", "WSTETH", "WEETH", "CBBTC", "RETH", "METH", "BETH", "WBETH", "LBTC", "SOLVBTC",
    "JITOSOL", "MSOL", "BNSOL", "LSETH", "EZETH", "RSETH", "WBNB", "TBTC",
})


def universe_path() -> Path:
    return data.DATA_DIR / "universe.json"


def bitvavo_eur_bases(markets: list[dict[str, Any]]) -> set[str]:
    """Bases with a trading ``-EUR`` market."""
    return {m["base"] for m in markets if m.get("quote") == "EUR" and m.get("status") == "trading"}


def coingecko_ranking(per_page: int = 100, get: Callable[..., Any] = requests.get) -> list[str]:
    """Uppercase symbols ordered by market cap (free endpoint, no key)."""
    resp = get(COINGECKO_URL, params={"vs_currency": "eur", "order": "market_cap_desc",
                                      "per_page": per_page, "page": 1}, timeout=30)
    resp.raise_for_status()
    return [c["symbol"].upper() for c in resp.json()]


def pick(default: tuple[str, ...], tradable: set[str], ranking: Callable[[], list[str]], n: int = 10) -> tuple[list[str], list[str]]:
    """Keep the default coins that are tradable; fill up from the market-cap ranking. Returns (bases, notes)."""
    chosen = [b for b in default if b in tradable]
    notes = [f"{b} has no trading -EUR market on Bitvavo" for b in default if b not in tradable]
    if len(chosen) < n:
        for sym in ranking():
            if sym in tradable and sym not in EXCLUDED and sym not in chosen:
                chosen.append(sym)
                notes.append(f"substituted {sym} (next by market cap)")
                if len(chosen) == n:
                    break
    return chosen[:n], notes


def build(client: data.BitvavoClient | None = None) -> dict[str, Any]:
    """Verify the default list against Bitvavo, substitute where needed and write ``data/universe.json``."""
    client = client or data.BitvavoClient()
    tradable = bitvavo_eur_bases(client.markets())
    bases, notes = pick(DEFAULT_TOP10, tradable, coingecko_ranking)
    doc = {
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "markets": [f"{b}-EUR" for b in bases],
        "source": "fixed default list verified against Bitvavo /v2/markets; substitutes by CoinGecko market cap",
        "notes": notes,
    }
    path = universe_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2), encoding="utf8")
    return doc


def top10(refresh: bool = False) -> list[str]:
    """Markets like ``"BTC-EUR"``, largest first."""
    path = universe_path()
    if refresh or not path.exists():
        return build()["markets"]
    return json.loads(path.read_text(encoding="utf8"))["markets"]


# --------------------------------------------------------------------------------------------- point-in-time universe
#
# ``top10()`` is TODAY's top 10: a strategy that rotates through it knows in 2020 which coins will still be big in
# 2026 (survivorship bias; agent-15 measured +11 -> -11 on the coins that were top 10 in 2020). ``top10_pit`` fixes
# that: a spec with ``"universe": "top10_pit"`` lists the whole candidate pool as its markets, and at every bar only
# the PIT_N pool coins with the highest trailing PIT_LOOKBACK_DAYS EUR volume on Bitvavo (volume * close, days
# strictly before the bar's day, at least PIT_LOOKBACK_DAYS days of history) may be held. Target weights on other
# coins are dropped and the row is scaled back up to its original total; buy and hold is the members at the window
# start. Everything uses only data available at that time.
#
# The pool = every non-stablecoin, non-wrapped coin that was in the CoinMarketCap top 15 at a year start 2019-2026
# (CoinMarketCap historical snapshots, coinmarketcap.com/historical/YYYY0101) AND has Bitvavo EUR candles. Bitvavo
# no longer serves EOS, MATIC, DASH, BSV or XMR (delisted / never listed), so those losers are missing: a small
# residual bias, much smaller than using today's list. LUNA-EUR is Terra Classic, crash included.
PIT_POOL: tuple[str, ...] = (
    "BTC", "ETH", "XRP", "BCH", "LTC", "XLM", "TRX", "ADA", "MIOTA", "XTZ", "LINK", "DOT", "UNI", "BNB", "SOL",
    "LUNA", "AVAX", "DOGE", "SHIB", "POL", "SUI", "HBAR",
)
PIT_N = 10
PIT_LOOKBACK_DAYS = 90
PIT_NAME = "top10_pit"
_DAY = 86_400_000


def pit_pool() -> list[str]:
    """The candidate markets of the point-in-time universe, sorted (a spec's ``markets``)."""
    return sorted(f"{b}-EUR" for b in PIT_POOL)


def pit_daily_members(daily: dict, n: int = PIT_N, lookback: int = PIT_LOOKBACK_DAYS):
    """Bool DataFrame (index: day open ms, columns: markets): member of the universe ON that day, decided from
    the ``lookback`` completed days before it (EUR volume = volume * close)."""
    import pandas as pd
    vols = {}
    for m, df in daily.items():
        if df is None or not len(df):
            continue
        v = (df["volume"].astype("float64") * df["close"].astype("float64"))
        vols[m] = v
    frame = pd.DataFrame(vols).sort_index()
    if frame.empty:
        return frame.astype(bool)
    full = pd.Index(range(int(frame.index[0]), int(frame.index[-1]) + _DAY, _DAY), name="ts")
    frame = frame.reindex(full)
    trailing = frame.rolling(lookback, min_periods=lookback).sum().shift(1)   # only days before
    rank = trailing.rank(axis=1, ascending=False, method="first")
    return (rank <= n) & trailing.notna()


def pit_members(index, markets: list[str], daily: dict | None = None, n: int = PIT_N,
                lookback: int = PIT_LOOKBACK_DAYS):
    """Membership at each bar of ``index`` (bar open ms) as a bool numpy array [bars, markets]: the day the bar
    opens in decides. ``daily`` = {market: 1d candles}; loaded from disk when None."""
    import numpy as np
    if daily is None:
        daily = {}
        for m in markets:
            try:
                daily[m] = data.load_candles(m, "1d")
            except FileNotFoundError:
                daily[m] = None
    dm = pit_daily_members({m: daily.get(m) for m in markets}, n, lookback)
    idx = np.asarray(index, dtype=np.int64)
    out = np.zeros((len(idx), len(markets)), dtype=bool)
    if dm.empty:
        return out
    days = np.asarray(dm.index, dtype=np.int64)
    pos = np.searchsorted(days, (idx // _DAY) * _DAY, side="right") - 1
    ok = pos >= 0
    for j, m in enumerate(markets):
        if m in dm.columns:
            col = dm[m].to_numpy(dtype=bool)
            out[ok, j] = col[pos[ok]]
    return out


def apply_pit(targets, members):
    """Drop target weight on non-members and scale each row back up to its original total (NaN rows stay NaN)."""
    import numpy as np
    W = targets.to_numpy(np.float64, copy=True)
    nan_rows = np.isnan(W).all(axis=1)
    Wz = np.where(np.isnan(W), 0.0, np.clip(W, 0.0, None))
    before = Wz.sum(axis=1)
    Wm = np.where(members, Wz, 0.0)
    after = Wm.sum(axis=1)
    scale = np.divide(before, after, out=np.zeros_like(before), where=after > 0)
    Wm = Wm * scale[:, None]
    Wm[nan_rows] = np.nan
    out = targets.copy()
    out.loc[:, :] = Wm
    return out


def is_survivorship_biased(markets: list[str], universe_name: str | None = None) -> bool:
    """A fixed list of more than two coins picked today (e.g. today's top 10) knows which coins survived. BTC and
    ETH alone (top 2 throughout) are fine; a point-in-time universe is fine."""
    return universe_name != PIT_NAME and len(markets or []) > 2
