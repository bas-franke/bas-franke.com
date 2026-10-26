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

import numpy as np
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
# coins that are
#   1. ELIGIBLE: in the top 15 (stablecoins / wrapped tokens removed) of the latest CoinMarketCap snapshot before
#      that day (CMC_SNAPSHOTS, January and July of every year; a coin leaves when it drops out), and
#   2. among those, the PIT_N with the highest trailing PIT_LOOKBACK_DAYS EUR volume on Bitvavo (volume * close of
#      the days strictly before the bar's day, at least PIT_LOOKBACK_DAYS days of history)
# may be held. Target weight on other coins is held as cash (no rescaling); buy and hold is the members at the
# window start. Everything uses only information available at that time.
#
# The pool = every coin that is eligible in some snapshot AND has Bitvavo EUR candles. Delisted / never-listed coins
# (EOS, BSV, MATIC before its POL rename, DASH, XMR, LEO, TON, ...) can't be held, so some survivorship remains;
# LUNA-EUR is Terra Classic, crash included. CC (2026-07) is left out: Bitvavo's CC may be another coin.
# PIT_VERSION is part of evaluate's EVAL_VERSION: changing the snapshots or rules means a rescore.
PIT_VERSION = 2   # 1: one fixed pool, every coin eligible from its first candle (look-ahead, findings #258-#260)
PIT_POOL: tuple[str, ...] = (
    "ADA", "ALGO", "ATOM", "AVAX", "BCH", "BNB", "BTC", "CRO", "DOGE", "DOT", "ETC", "ETH", "HYPE", "ICP", "LINK",
    "LTC", "LUNA", "MIOTA", "NEO", "POL", "SHIB", "SOL", "SUI", "TRX", "UNI", "XLM", "XRP", "XTZ",
)
# CoinMarketCap historical snapshots (https://coinmarketcap.com/historical/YYYYMMDD/), top 20 by market cap as
# published on that date, fetched 2026-10-26. A coin is ELIGIBLE for the point-in-time universe from a snapshot
# date until the next one when it is in the top PIT_SNAPSHOT_TOP after removing stablecoins / wrapped tokens
# (EXCLUDED). Coins without Bitvavo EUR candles (EOS, BSV, XMR, DASH, LEO, CRO, HT, TON, HYPE, ZEC, ...) simply
# cannot be held: some survivorship remains because delisted losers (EOS, BSV, MATIC, DASH, XMR) have no data.
CMC_SNAPSHOTS: dict[str, tuple[str, ...]] = {
    "2019-01-06": ("BTC", "ETH", "XRP", "BCH", "EOS", "LTC", "XLM", "USDT", "BSV", "TRX", "ADA", "MIOTA", "XMR",
                   "BNB", "DASH", "XEM", "ETC", "NEO", "MKR", "ZEC"),
    "2019-07-07": ("BTC", "ETH", "XRP", "LTC", "BCH", "EOS", "BNB", "USDT", "BSV", "TRX", "ADA", "XLM", "XMR", "LEO",
                   "DASH", "NEO", "LINK", "MIOTA", "ATOM", "ETC"),
    "2020-01-05": ("BTC", "ETH", "XRP", "USDT", "BCH", "LTC", "EOS", "BNB", "BSV", "XMR", "XLM", "TRX", "ADA", "XTZ",
                   "LEO", "ATOM", "HT", "NEO", "LINK"),
    "2020-07-05": ("BTC", "ETH", "USDT", "XRP", "BCH", "BSV", "LTC", "ADA", "BNB", "CRO", "EOS", "XTZ", "LINK", "XLM",
                   "LEO", "TRX", "XMR", "USDC", "HT", "VET"),
    "2021-01-03": ("BTC", "ETH", "USDT", "LTC", "XRP", "DOT", "BCH", "ADA", "BNB", "LINK", "USDC", "WBTC", "BSV", "XLM",
                   "EOS", "XMR", "THETA", "TRX", "XEM", "VET"),
    "2021-07-04": ("BTC", "ETH", "USDT", "BNB", "ADA", "DOGE", "XRP", "USDC", "DOT", "UNI", "BUSD", "BCH", "LTC", "SOL",
                   "LINK", "MATIC", "WBTC", "ETC", "THETA", "ICP"),
    "2022-01-02": ("BTC", "ETH", "BNB", "USDT", "SOL", "ADA", "USDC", "XRP", "LUNA", "DOT", "AVAX", "DOGE", "SHIB",
                   "MATIC", "CRO", "BUSD", "WBTC", "UNI", "ALGO", "LTC"),
    "2022-07-03": ("BTC", "ETH", "USDT", "USDC", "BNB", "BUSD", "XRP", "ADA", "SOL", "DOGE", "DAI", "DOT", "TRX", "SHIB",
                   "LEO", "WBTC", "AVAX", "MATIC", "UNI", "LTC"),
    "2023-01-01": ("BTC", "ETH", "USDT", "USDC", "BNB", "XRP", "BUSD", "DOGE", "ADA", "MATIC", "DAI", "LTC", "TRX", "DOT",
                   "SHIB", "UNI", "SOL", "AVAX", "LEO", "WBTC"),
    "2023-07-02": ("BTC", "ETH", "USDT", "BNB", "USDC", "XRP", "ADA", "DOGE", "LTC", "SOL", "TRX", "DOT", "MATIC", "BCH",
                   "TON", "WBTC", "DAI", "AVAX", "SHIB", "BUSD"),
    "2024-01-07": ("BTC", "ETH", "USDT", "BNB", "SOL", "XRP", "USDC", "ADA", "AVAX", "DOGE", "TRX", "DOT", "MATIC", "TON",
                   "LINK", "DAI", "SHIB", "ICP", "LTC", "BCH"),
    "2024-07-07": ("BTC", "ETH", "USDT", "BNB", "SOL", "USDC", "XRP", "TON", "DOGE", "ADA", "TRX", "AVAX", "SHIB", "DOT",
                   "LINK", "BCH", "DAI", "LEO", "NEAR", "MATIC"),
    "2025-01-05": ("BTC", "ETH", "XRP", "USDT", "SOL", "BNB", "DOGE", "USDC", "ADA", "TRX", "AVAX", "SUI", "LINK", "TON",
                   "SHIB", "XLM", "DOT", "HBAR", "BCH", "UNI"),
    "2025-07-06": ("BTC", "ETH", "USDT", "XRP", "BNB", "SOL", "USDC", "TRX", "DOGE", "ADA", "HYPE", "SUI", "BCH", "LINK",
                   "LEO", "XLM", "AVAX", "TON", "SHIB", "HBAR"),
    "2026-01-04": ("BTC", "ETH", "USDT", "XRP", "BNB", "USDC", "SOL", "TRX", "DOGE", "ADA", "BCH", "LINK", "HYPE", "ZEC",
                   "LEO", "XMR", "XLM", "SUI", "USDE", "LTC"),
    "2026-07-05": ("BTC", "ETH", "USDT", "BNB", "USDC", "XRP", "SOL", "TRX", "HYPE", "DOGE", "LEO", "ZEC", "ADA", "XLM",
                   "XMR", "LINK", "CC", "DAI", "BCH", "GRAM"),
}
PIT_SNAPSHOT_TOP = 15
_TEST_ALL_ELIGIBLE = False                    # tests only
# Renamed coins: the Bitvavo market that continues them (MATIC became POL in 2024-09).
PIT_ALIASES = {"MATIC": "POL"}
_SNAP_EXCLUDED = frozenset({"USDT", "USDC", "BUSD", "DAI", "USDE", "WBTC", "TUSD", "FDUSD", "PYUSD"})


def snapshot_eligible(top: int = PIT_SNAPSHOT_TOP) -> list[tuple[int, frozenset]]:
    """[(snapshot day ms, eligible bases)], oldest first: the first ``top`` coins of each snapshot after removing
    stablecoins and wrapped tokens, renamed coins mapped to their current Bitvavo base."""
    out = []
    for day, syms in sorted(CMC_SNAPSHOTS.items()):
        keep = [s for s in syms if s.upper() not in EXCLUDED and s.upper() not in _SNAP_EXCLUDED][:top]
        ts = int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
        out.append((ts, frozenset(PIT_ALIASES.get(s, s) for s in keep)))
    return out


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
    import numpy as np
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
    trailing = trailing.where(pit_eligible(np.asarray(full, dtype=np.int64), list(frame.columns)))
    rank = trailing.rank(axis=1, ascending=False, method="first")
    return (rank <= n) & trailing.notna()


def pit_eligible(days, markets: list[str]):
    """Bool array [days, markets]: in the top PIT_SNAPSHOT_TOP of the latest CMC snapshot taken BEFORE that day
    (a snapshot counts from the day after its date; before the first snapshot the first one applies)."""
    if _TEST_ALL_ELIGIBLE:                    # synthetic test markets are in no snapshot
        return np.ones((len(days), len(markets)), dtype=bool)
    snaps = snapshot_eligible()
    starts = np.array([ts + _DAY for ts, _ in snaps], dtype=np.int64)
    k = np.clip(np.searchsorted(starts, np.asarray(days, dtype=np.int64), side="right") - 1, 0, len(snaps) - 1)
    out = np.zeros((len(k), len(markets)), dtype=bool)
    for j, m in enumerate(markets):
        base = m.split("-")[0]
        ok = np.array([base in el for _, el in snaps])
        out[:, j] = ok[k]
    return out


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
    """Weight on coins outside the universe at that bar becomes cash (NaN rows stay NaN). No rescaling: scaling the
    rest up would turn "2 picks, 1 not allowed" into 100 % in one coin. A family that should choose among the
    members itself can call :func:`pit_members` (public, past-only data)."""
    import numpy as np
    W = targets.to_numpy(np.float64, copy=True)
    nan_rows = np.isnan(W).all(axis=1)
    Wm = np.where(members, np.where(np.isnan(W), 0.0, np.clip(W, 0.0, None)), 0.0)
    Wm[nan_rows] = np.nan
    out = targets.copy()
    out.loc[:, :] = Wm
    return out


def is_survivorship_biased(markets: list[str], universe_name: str | None = None) -> bool:
    """A fixed list of more than two coins picked today (e.g. today's top 10) knows which coins survived. BTC and
    ETH alone (top 2 throughout) are fine; a point-in-time universe is fine."""
    return universe_name != PIT_NAME and len(markets or []) > 2
