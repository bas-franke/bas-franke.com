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
