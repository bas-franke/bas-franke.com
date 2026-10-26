"""Bitvavo candle store for the research lab.

One Parquet file per market and interval under ``data/candles/<MARKET>/<interval>.parquet`` with columns
``ts`` (int64 ms UTC, bar open time) and ``open high low close volume`` (float64), ascending, deduplicated and
only closed bars. ``1W`` (weeks starting Monday 00:00 UTC) is derived from ``1d``.

Public API (other lab modules are written against exactly this):

- ``load_candles(market, interval, start=None, end=None)``: DataFrame indexed by ``ts``; ``start`` inclusive,
  ``end`` exclusive; both accept int ms or an ISO date/time string (UTC).
- ``load_many(markets, interval, start=None, end=None)``: ``{market: DataFrame}``.
- ``available()``: ``[(market, interval, first_ts, last_ts, rows), ...]``.
- ``ensure(markets, intervals)``: download / update what is missing.
- ``INTERVAL_MS``: bar length in ms for every interval including ``1W``.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import requests

# --------------------------------------------------------------------------------------------- constants

LAB_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("STONKS_DATA_DIR", LAB_DIR / "data"))

MINUTE = 60_000
HOUR = 60 * MINUTE
DAY = 24 * HOUR
WEEK = 7 * DAY
#: 1970-01-01 was a Thursday; the first Monday 00:00 UTC is 1970-01-05.
WEEK_ORIGIN_MS = 4 * DAY

BITVAVO_INTERVALS: tuple[str, ...] = ("1m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d")
INTERVALS: tuple[str, ...] = BITVAVO_INTERVALS + ("1W",)
INTERVAL_MS: dict[str, int] = {
    "1m": MINUTE, "5m": 5 * MINUTE, "15m": 15 * MINUTE, "30m": 30 * MINUTE,
    "1h": HOUR, "2h": 2 * HOUR, "4h": 4 * HOUR, "6h": 6 * HOUR, "8h": 8 * HOUR, "12h": 12 * HOUR,
    "1d": DAY, "1W": WEEK,
}
COLUMNS: tuple[str, ...] = ("open", "high", "low", "close", "volume")

BITVAVO_URL = "https://api.bitvavo.com/v2"
PAGE_LIMIT = 1440                 # Bitvavo's maximum candles per request
DEFAULT_1M_DAYS = 400             # 1m history kept (more would be ~1M rows per market and year)
EARLIEST_MS = 1_514_764_800_000   # 2018-01-01: Bitvavo launched in 2019, nothing older exists
SAVE_EVERY_PAGES = 40             # flush long downloads to disk regularly so an interruption loses little


def candle_dir() -> Path:
    return DATA_DIR / "candles"


def candle_path(market: str, interval: str) -> Path:
    return candle_dir() / market / f"{interval}.parquet"


def _check_interval(interval: str) -> int:
    if interval not in INTERVAL_MS:
        raise ValueError(f"unknown interval {interval!r}; expected one of {', '.join(INTERVALS)}")
    return INTERVAL_MS[interval]


def to_ms(value: str | int | float | pd.Timestamp | None) -> int | None:
    """Int ms, ISO string (``"2024-01-01"``, ``"2024-01-01T12:00Z"``; naive = UTC) or Timestamp -> int ms."""
    if value is None:
        return None
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, float):
        return int(value)
    ts = pd.Timestamp(value)
    ts = ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")
    return int(ts.value // 1_000_000)


def now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------------------------- frames

def empty_frame() -> pd.DataFrame:
    df = pd.DataFrame({c: pd.Series(dtype="float64") for c in COLUMNS})
    df.index = pd.Index([], dtype="int64", name="ts")
    return df


def rows_to_frame(rows: Iterable[list[Any]]) -> pd.DataFrame:
    """Bitvavo rows ``[ts, open, high, low, close, volume]`` (strings or numbers) -> normalised frame."""
    rows = list(rows)
    if not rows:
        return empty_frame()
    arr = np.asarray(rows, dtype=object)
    df = pd.DataFrame({c: arr[:, i + 1].astype("float64") for i, c in enumerate(COLUMNS)})
    df.index = pd.Index(arr[:, 0].astype("int64"), name="ts")
    return normalize(df)


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    """Dedupe on ts (the last copy wins), sort ascending, enforce dtypes and column order."""
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df.loc[:, list(COLUMNS)].astype("float64")
    df.index = df.index.astype("int64")
    df.index.name = "ts"
    return df


def merge(old: pd.DataFrame | None, new: pd.DataFrame) -> pd.DataFrame:
    if old is None or old.empty:
        return normalize(new)
    if new.empty:
        return old
    return normalize(pd.concat([old, new]))


def resample(df: pd.DataFrame, src_interval: str, dst_interval: str,
             closed_until: int | None = None) -> pd.DataFrame:
    """Aggregate bars into a coarser interval (UTC-aligned buckets; ``1W`` uses Monday weeks). Only buckets
    ending at or before ``closed_until`` (default: the end of the last source bar) are kept; missing source
    bars inside a bucket simply had no trades."""
    src, dst = INTERVAL_MS[src_interval], INTERVAL_MS[dst_interval]
    if dst % src or dst < src:
        raise ValueError(f"cannot build {dst_interval} from {src_interval}")
    if df.empty:
        return empty_frame()
    origin = WEEK_ORIGIN_MS if dst_interval == "1W" else 0
    ts = df.index.to_numpy(dtype="int64")
    bucket = (ts - origin) // dst * dst + origin
    g = df.groupby(bucket, sort=True)
    out = pd.DataFrame({
        "open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
        "close": g["close"].last(), "volume": g["volume"].sum(),
    })
    out.index = out.index.astype("int64")
    out.index.name = "ts"
    limit = int(ts[-1]) + src if closed_until is None else closed_until
    return normalize(out[out.index + dst <= limit])


def resample_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    """Daily bars -> weekly bars on Monday 00:00 UTC; only closed weeks (the first, partial week of a
    market's history is kept)."""
    return resample(daily, "1d", "1W")


def find_gaps(df: pd.DataFrame, interval: str) -> list[tuple[int, int, int]]:
    """Missing bars as ``[(first_missing_ts, last_missing_ts, count), ...]``. Bitvavo omits bars without
    trades and has had maintenance windows; we report them and never invent candles."""
    if len(df) < 2:
        return []
    step = INTERVAL_MS[interval]
    ts = df.index.to_numpy(dtype="int64")
    diffs = np.diff(ts)
    idx = np.nonzero(diffs > step)[0]
    return [(int(ts[i] + step), int(ts[i + 1] - step), int(diffs[i] // step - 1)) for i in idx]


# --------------------------------------------------------------------------------------------- storage

def write_frame(path: Path, df: pd.DataFrame, meta: dict[str, Any] | None = None) -> None:
    """Atomic write (tmp file + replace) so concurrent readers never see a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pandas(df, preserve_index=True)
    if meta:
        md = dict(table.schema.metadata or {})
        md[b"stonks"] = json.dumps(meta).encode()
        table = table.replace_schema_metadata(md)
    tmp = path.with_suffix(f".tmp{os.getpid()}")
    pq.write_table(table, tmp, compression="zstd")
    for attempt in range(20):  # Windows refuses to replace a file another process is reading at that instant
        try:
            os.replace(tmp, path)
            break
        except PermissionError:
            time.sleep(0.1 * (attempt + 1))
    else:
        raise PermissionError(f"could not replace {path}")
    _read_cached.cache_clear()
    _summary_cached.cache_clear()


def read_meta(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    md = pq.read_schema(path).metadata or {}
    raw = md.get(b"stonks")
    return json.loads(raw) if raw else {}


def _file_key(path: Path) -> tuple[str, int, int] | None:
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    return str(path), st.st_mtime_ns, st.st_size


@lru_cache(maxsize=48)
def _read_cached(path: str, mtime_ns: int, size: int) -> pd.DataFrame:
    df = pd.read_parquet(path)
    if "ts" in df.columns:
        df = df.set_index("ts")
    return normalize(df)


def read_frame(path: Path) -> pd.DataFrame | None:
    key = _file_key(path)
    return None if key is None else _read_cached(*key)


# --------------------------------------------------------------------------------------------- public load API

def load_candles(market: str, interval: str, start: str | int | None = None,
                 end: str | int | None = None) -> pd.DataFrame:
    """Closed candles for one market, indexed by int64 ms ``ts`` (bar open time), ascending.
    ``start`` is inclusive, ``end`` exclusive. Raises FileNotFoundError when nothing is downloaded yet
    (run ``python tools/download.py`` or ``ensure``). The cached frame is shared; pandas copy-on-write keeps
    callers from mutating it for each other."""
    _check_interval(interval)
    df = read_frame(candle_path(market, interval))
    if df is None:
        raise FileNotFoundError(f"no {interval} candles for {market}; run tools/download.py")
    lo, hi = to_ms(start), to_ms(end)
    idx = df.index.to_numpy()
    i = 0 if lo is None else int(np.searchsorted(idx, lo, side="left"))
    j = len(idx) if hi is None else int(np.searchsorted(idx, hi, side="left"))
    return df.iloc[i:j]  # a lazy copy under copy-on-write: writes by the caller never reach the cache


def load_many(markets: Iterable[str], interval: str, start: str | int | None = None,
              end: str | int | None = None) -> dict[str, pd.DataFrame]:
    """``{market: load_candles(...)}``; frames are not aligned to a common index."""
    return {m: load_candles(m, interval, start, end) for m in markets}


@lru_cache(maxsize=1024)
def _summary_cached(path: str, mtime_ns: int, size: int) -> tuple[int, int, int]:
    ts = pq.read_table(path, columns=["ts"]).column("ts").to_numpy()
    if len(ts) == 0:
        return 0, 0, 0
    return int(ts[0]), int(ts[-1]), len(ts)


def available() -> list[tuple[str, str, int, int, int]]:
    """``[(market, interval, first_ts, last_ts, rows), ...]`` for every stored file with data."""
    out: list[tuple[str, str, int, int, int]] = []
    root = candle_dir()
    if not root.exists():
        return out
    order = {iv: i for i, iv in enumerate(INTERVALS)}
    for mdir in sorted(p for p in root.iterdir() if p.is_dir()):
        for f in mdir.glob("*.parquet"):
            if f.stem not in INTERVAL_MS:
                continue
            key = _file_key(f)
            if key is None:
                continue
            first, last, rows = _summary_cached(*key)
            if rows:
                out.append((mdir.name, f.stem, first, last, rows))
    out.sort(key=lambda r: (r[0], order[r[1]]))
    return out


# --------------------------------------------------------------------------------------------- Bitvavo HTTP

class CandleSource(Protocol):
    def get_candles(self, market: str, interval: str, start: int, end: int, limit: int) -> list[list[Any]]: ...


class BitvavoError(RuntimeError):
    pass


@dataclass
class BitvavoClient:
    """Public Bitvavo REST client with a polite rate limiter.

    Bitvavo allows 1000 weight per minute per IP (candles cost 1). Other processes on this PC share that
    budget, so each client spaces requests ``min_gap`` apart (default ~400/min) and pauses until the
    reset time whenever ``bitvavo-ratelimit-remaining`` drops under ``reserve``."""

    base_url: str = BITVAVO_URL
    min_gap: float = 0.15
    reserve: int = 250
    max_retries: int = 8
    timeout: float = 30.0
    session: requests.Session = field(default_factory=requests.Session)
    requests_made: int = 0
    _last: float = 0.0

    def _throttle(self) -> None:
        wait = self._last + self.min_gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def _respect_headers(self, resp: requests.Response) -> None:
        remaining = resp.headers.get("bitvavo-ratelimit-remaining")
        reset_at = resp.headers.get("bitvavo-ratelimit-resetat")
        if remaining is not None and reset_at is not None and int(remaining) < self.reserve:
            pause = max(0.0, int(reset_at) / 1000 - time.time()) + 1.0
            time.sleep(min(pause, 65.0))

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        delay = 1.0
        for attempt in range(self.max_retries + 1):
            self._throttle()
            try:
                resp = self.session.get(f"{self.base_url}{path}", params=params, timeout=self.timeout)
            except (requests.ConnectionError, requests.Timeout) as exc:
                err: Exception = exc
            else:
                self.requests_made += 1
                self._respect_headers(resp)
                if resp.status_code == 200:
                    return resp.json()
                body = resp.text[:300]
                if resp.status_code == 429 or resp.status_code >= 500:
                    err = BitvavoError(f"HTTP {resp.status_code}: {body}")
                    if resp.status_code == 429:
                        delay = max(delay, 30.0)
                else:
                    raise BitvavoError(f"HTTP {resp.status_code} for {path} {params}: {body}")
            if attempt == self.max_retries:
                raise BitvavoError(f"giving up on {path} {params}: {err}") from err
            time.sleep(delay)
            delay = min(delay * 2, 120.0)
        raise AssertionError("unreachable")

    def get_candles(self, market: str, interval: str, start: int, end: int, limit: int = PAGE_LIMIT) -> list[list[Any]]:
        """Bars with ``start <= ts`` and ``ts + interval <= end`` (Bitvavo's semantics), newest first."""
        return self.get_json(f"/{market}/candles",
                             {"interval": interval, "limit": limit, "start": start, "end": end})

    def markets(self) -> list[dict[str, Any]]:
        return self.get_json("/markets")


# --------------------------------------------------------------------------------------------- pagination

def iter_windows(start: int, end: int, step: int, limit: int | None = None,
                 descending: bool = False) -> Iterator[tuple[int, int]]:
    """Split ``[start, end)`` (bar open times) into request windows of at most ``limit`` bars.

    Each window ``(ws, we)`` is passed as Bitvavo ``start=ws, end=we`` and returns bars with
    ``ws <= ts <= we - step``. Bitvavo answers per *time window* (not per row count), so walking windows
    keeps working across long exchange gaps where a page would otherwise come back empty."""
    if end <= start:
        return
    span = (limit or PAGE_LIMIT) * step
    if descending:
        we = end
        while we > start:
            ws = max(start, we - span)
            yield ws, we
            we = ws
    else:
        ws = start
        while ws < end:
            we = min(end, ws + span)
            yield ws, we
            ws = we


def fetch_range(source: CandleSource, market: str, interval: str, start: int, end: int, *,
                descending: bool = False, on_chunk: Callable[[pd.DataFrame], None] | None = None,
                chunk_pages: int | None = None, limit: int | None = None) -> pd.DataFrame:
    """Download every bar with open time in ``[start, end)``. ``on_chunk`` gets the accumulated frame every
    ``chunk_pages`` pages (contiguous with what was fetched before, so partial saves never leave holes)."""
    step = INTERVAL_MS[interval]
    limit = limit or PAGE_LIMIT
    chunk_pages = chunk_pages or SAVE_EVERY_PAGES
    acc: list[pd.DataFrame] = []
    pages = 0
    for ws, we in iter_windows(start, end, step, limit, descending):
        rows = source.get_candles(market, interval, ws, we, limit)
        frame = rows_to_frame(rows)
        frame = frame[(frame.index >= start) & (frame.index < end)]
        acc.append(frame)
        pages += 1
        if on_chunk is not None and pages % chunk_pages == 0:
            on_chunk(normalize(pd.concat(acc)))
    if not acc:
        return empty_frame()
    out = normalize(pd.concat(acc))
    if on_chunk is not None and pages % chunk_pages:
        on_chunk(out)
    return out


# --------------------------------------------------------------------------------------------- ensure / update

Progress = Callable[[str], None]


def _floor(ts: int, step: int) -> int:
    return ts // step * step


def listing_start(source: CandleSource, market: str, now: int | None = None) -> int:
    """Open time of the market's first daily bar on Bitvavo (cached in the 1d file's metadata)."""
    meta = read_meta(candle_path(market, "1d"))
    if meta.get("historyStart") is not None:
        return int(meta["historyStart"])
    first: int | None = None
    for ws, we in iter_windows(EARLIEST_MS, _floor(now or now_ms(), DAY), DAY, descending=True):
        rows = source.get_candles(market, "1d", ws, we, PAGE_LIMIT)
        if not rows:  # 1440 days without a single bar: we are before the listing
            break
        first = min(int(r[0]) for r in rows)
    if first is None:
        raise BitvavoError(f"{market}: no daily candles on Bitvavo")
    return first


def update_market(source: CandleSource, market: str, interval: str, *, since: int | None = None,
                  now: int | None = None, progress: Progress = print) -> pd.DataFrame:
    """Bring one market+interval file up to date: backfill to ``since`` (or the listing), then fetch newer
    closed bars. Idempotent; only missing ranges are requested."""
    step = _check_interval(interval)
    now = now or now_ms()
    path = candle_path(market, interval)
    if interval == "1W":
        daily = update_market(source, market, "1d", now=now, progress=progress)
        weekly = resample_weekly(daily)
        write_frame(path, weekly, {"derivedFrom": "1d"})
        return weekly

    history_start = listing_start(source, market, now)
    floor = max(_floor(history_start, step), _floor(since, step) if since is not None else 0)
    end = _floor(now, step)  # bars opening before this are closed
    current = read_frame(path)
    meta = read_meta(path)
    if interval == "1d":
        meta["historyStart"] = history_start

    def save(df: pd.DataFrame) -> None:
        nonlocal current
        current = merge(current, df)
        write_frame(path, current, meta)

    has = current is not None and not current.empty
    first = int(current.index[0]) if has else end
    last = int(current.index[-1]) if has else None
    backfilled = has and (first <= floor or meta.get("backfilledTo", 1 << 62) <= floor)

    # newer bars first (ascending windows so partial saves stay contiguous), then backfill (descending)
    if last is not None and last + step < end:
        n0 = len(current)
        fetch_range(source, market, interval, last + step, end, on_chunk=save)
        progress(f"  {market} {interval}: +{len(current) - n0} new bars")
    if not backfilled and floor < first:
        n0 = 0 if current is None else len(current)
        pages = -(-(first - floor) // (PAGE_LIMIT * step))
        progress(f"  {market} {interval}: backfilling {pages} pages from {_iso(first)} to {_iso(floor)}")
        fetch_range(source, market, interval, floor, first, descending=True, on_chunk=save)
        meta["backfilledTo"] = floor
        if current is None:
            current = empty_frame()
        write_frame(path, current, meta)
        progress(f"  {market} {interval}: +{len(current) - n0} old bars")
    elif current is None:
        current = empty_frame()
        write_frame(path, current, meta)
    return current


def fill_prefix(market: str, interval: str, progress: Progress = print) -> int:
    """Bitvavo's history is shorter for some intervals than for finer ones (BTC-EUR 15m starts in 2021 while
    5m goes back to 2019). Build the missing older bars by resampling the finer stored interval with the
    earliest data. Real Bitvavo bars always win; returns how many bars were added."""
    if interval in ("1m", "1W"):
        return 0
    path = candle_path(market, interval)
    cur = read_frame(path)
    if cur is None or cur.empty:
        return 0
    step = INTERVAL_MS[interval]
    meta = read_meta(path)
    native_first = int(meta.get("nativeFirst", cur.index[0]))
    best: tuple[int, str, pd.DataFrame] | None = None
    for src in BITVAVO_INTERVALS:
        sstep = INTERVAL_MS[src]
        if sstep >= step or step % sstep:
            continue
        f = read_frame(candle_path(market, src))
        if f is None or f.empty or int(f.index[0]) + step > native_first:
            continue
        if best is None or int(f.index[0]) <= best[0]:  # earliest wins; ties go to the coarser source
            best = (int(f.index[0]), src, f)
    if best is None:
        return 0
    _, src, f = best
    part = resample(f[f.index < native_first], src, interval, closed_until=native_first)
    new = part[part.index < int(cur.index[0])]
    if new.empty:
        return 0
    meta["nativeFirst"] = native_first
    meta["derivedBefore"] = {"from": src, "until": native_first}
    write_frame(path, merge(cur, new), meta)
    progress(f"  {market} {interval}: +{len(new)} bars before {_iso(native_first)} derived from {src}")
    return len(new)


def ensure(markets: Iterable[str], intervals: Iterable[str], *, one_minute_days: int = DEFAULT_1M_DAYS,
           source: CandleSource | None = None, progress: Progress = print,
           report_gaps: bool = True, now: int | None = None) -> list[tuple[str, str, int, int, int]]:
    """Download/update every market x interval (1d first, it defines each market's listing date).
    1m is limited to the last ``one_minute_days`` days. Returns ``available()`` rows for what was touched."""
    src = source or BitvavoClient()
    intervals = list(intervals)
    for iv in intervals:
        _check_interval(iv)
    ordered = sorted(intervals, key=lambda iv: (iv != "1d", -INTERVAL_MS[iv]))
    now = now or now_ms()
    touched = []
    for market in markets:
        for iv in ordered:
            t0 = time.time()
            since = now - one_minute_days * DAY if iv == "1m" else None
            df = update_market(src, market, iv, since=since, now=now, progress=progress)
            line = f"{market:>10} {iv:>4}: {len(df):>8} rows"
            if len(df):
                line += f"  {_iso(int(df.index[0]))} .. {_iso(int(df.index[-1]))}"
            if report_gaps and len(df):
                gaps = find_gaps(df, iv)
                if gaps:
                    missing = sum(g[2] for g in gaps)
                    big = max(gaps, key=lambda g: g[2])
                    line += f"  gaps: {len(gaps)} ({missing} bars, largest {big[2]} from {_iso(big[0])})"
            progress(f"{line}  [{time.time() - t0:.1f}s]")
            touched.append((market, iv))
        for iv in ordered:
            fill_prefix(market, iv, progress)
    have = {(r[0], r[1]): r for r in available()}
    return [have[k] for k in touched if k in have]


def _iso(ts: int) -> str:
    return pd.Timestamp(ts, unit="ms", tz="UTC").strftime("%Y-%m-%d %H:%M")
