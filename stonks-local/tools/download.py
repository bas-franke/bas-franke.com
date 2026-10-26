"""Download / update Bitvavo candles into data/candles (idempotent: only missing ranges are fetched).

    python tools/download.py --markets top10 --intervals all
    python tools/download.py --markets BTC-EUR,ETH-EUR --intervals 5m,15m,1m --one-minute-days 400
    python tools/download.py --list
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stonks_lab import data, universe  # noqa: E402


def parse_markets(arg: str) -> list[str]:
    out: list[str] = []
    for part in arg.split(","):
        part = part.strip()
        if not part:
            continue
        if part == "top10":
            out += universe.top10()
        else:
            out.append(part.upper() if "-" in part else f"{part.upper()}-EUR")
    return list(dict.fromkeys(out))


def parse_intervals(arg: str) -> list[str]:
    if arg == "all":
        return list(data.INTERVALS)
    ivs = [p.strip() for p in arg.split(",") if p.strip()]
    for iv in ivs:
        if iv not in data.INTERVAL_MS:
            raise SystemExit(f"unknown interval {iv}; use one of {', '.join(data.INTERVALS)} or 'all'")
    return ivs


def print_available() -> None:
    rows = data.available()
    total = 0
    for market, iv, first, last, n in rows:
        size = data.candle_path(market, iv).stat().st_size
        total += size
        print(f"{market:>10} {iv:>4} {n:>9} rows  {data._iso(first)} .. {data._iso(last)}  {size / 1e6:6.1f} MB")
    print(f"{len(rows)} files, {total / 1e6:.1f} MB")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--markets", default="top10", help="comma list of markets/bases, or 'top10' (default)")
    ap.add_argument("--intervals", default="1h,4h,1d,1W", help="comma list or 'all'")
    ap.add_argument("--one-minute-days", type=int, default=data.DEFAULT_1M_DAYS, help="1m history to keep")
    ap.add_argument("--min-gap", type=float, default=0.15, help="seconds between Bitvavo requests")
    ap.add_argument("--list", action="store_true", help="only print what is stored")
    args = ap.parse_args()
    if args.list:
        print_available()
        return
    markets, intervals = parse_markets(args.markets), parse_intervals(args.intervals)
    print(f"markets: {', '.join(markets)}\nintervals: {', '.join(intervals)}", flush=True)
    client = data.BitvavoClient(min_gap=args.min_gap)
    t0 = time.time()
    data.ensure(markets, intervals, one_minute_days=args.one_minute_days, source=client,
                progress=lambda s: print(s, flush=True))
    print(f"done: {client.requests_made} requests in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
