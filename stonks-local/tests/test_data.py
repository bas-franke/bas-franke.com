"""Tests for stonks_lab.data and stonks_lab.universe with a fake Bitvavo (no network)."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from stonks_lab import data, universe  # noqa: E402

H, D = data.HOUR, data.DAY
LISTING = data.to_ms("2024-01-01")
NOW = data.to_ms("2024-03-01T10:30")


class FakeBitvavo:
    """Answers like Bitvavo: bars with ``start <= ts`` and ``ts + interval <= end``, newest first, at most
    ``limit``; prices are a deterministic function of ts; ``gaps`` are ts ranges without trades."""

    def __init__(self, listing: int = LISTING, now: int = NOW, gaps: list[tuple[int, int]] | None = None,
                 starts: dict[str, int] | None = None):
        self.listing, self.now, self.gaps = listing, now, gaps or []
        self.starts = starts or {}
        self.calls: list[tuple[str, str, int, int, int]] = []
        self.market_status: dict[str, str] | None = {}   # for markets(); None = the request fails
        self.gaps_of: dict[str, tuple[int, int]] = {}     # per market: a ts range without trades

    @staticmethod
    def bar(ts: int, step: int) -> list[object]:
        o = 100 + (ts // step) % 17
        return [ts, str(o), str(o + 2), str(o - 1), str(o + 1), "1.5"]

    def get_candles(self, market: str, interval: str, start: int, end: int, limit: int = 1440) -> list[list[object]]:
        self.calls.append((market, interval, start, end, limit))
        step = data.INTERVAL_MS[interval]
        first = max(self.listing, self.starts.get(interval, 0))
        lo = max(start, first)
        lo = -(-lo // step) * step
        rows = []
        ts = (min(end, self.now) - step) // step * step
        while ts >= lo and len(rows) < limit:
            quiet = self.gaps_of.get(market, (0, 0))
            if ts + step <= end and not any(a <= ts < b for a, b in [*self.gaps, quiet]):
                rows.append(self.bar(ts, step))
            ts -= step
        return rows

    def markets(self) -> list[dict[str, object]]:
        if self.market_status is None:
            raise data.BitvavoError("HTTP 500")
        return [{"market": m, "status": st} for m, st in self.market_status.items()]


@pytest.fixture(autouse=True)
def tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(data, "DATA_DIR", tmp_path)
    monkeypatch.setattr(data, "PAGE_LIMIT", 100)
    data._read_cached.cache_clear()
    data._summary_cached.cache_clear()
    return tmp_path


# ------------------------------------------------------------------------------------------- pure helpers

def test_interval_ms_has_all_intervals():
    assert set(data.INTERVALS) == set(data.INTERVAL_MS)
    assert data.INTERVAL_MS["1W"] == 7 * D and data.INTERVAL_MS["1m"] == 60_000


def test_iter_windows_cover_range_without_overlap():
    for desc in (False, True):
        wins = list(data.iter_windows(0, 1050 * H, H, 100, descending=desc))
        assert len(wins) == 11
        spans = sorted(wins)
        assert spans[0][0] == 0 and spans[-1][1] == 1050 * H
        assert all(a[1] == b[0] for a, b in zip(spans, spans[1:]))
        assert all(we - ws <= 100 * H for ws, we in wins)
    assert list(data.iter_windows(5, 5, H)) == []


def test_rows_to_frame_dedupes_sorts_and_types():
    rows = [[3 * H, "1", "2", "0.5", "1.5", "10"], [H, "1", "2", "0.5", "1.5", "10"],
            [3 * H, "9", "9", "9", "9", "9"]]
    df = data.rows_to_frame(rows)
    assert list(df.index) == [H, 3 * H]
    assert df.loc[3 * H, "close"] == 9.0  # the last copy wins
    assert df.index.dtype == np.int64 and df.index.name == "ts"
    assert list(df.columns) == list(data.COLUMNS) and all(df.dtypes == "float64")


def test_merge_dedupes_overlap():
    a = data.rows_to_frame([FakeBitvavo.bar(i * H, H) for i in range(5)])
    b = data.rows_to_frame([FakeBitvavo.bar(i * H, H) for i in range(3, 8)])
    m = data.merge(a, b)
    assert list(m.index) == [i * H for i in range(8)]


def test_resample_weekly_monday_weeks_and_closed_only():
    monday = data.to_ms("2024-01-01")  # a Monday
    days = [monday - 2 * D, monday - D] + [monday + i * D for i in range(10)]
    rows = [[t, str(10 + i), str(20 + i), str(5 + i), str(11 + i), "1"] for i, t in enumerate(days)]
    w = data.resample_weekly(data.rows_to_frame(rows))
    # partial first week (Sat+Sun of the week of 2023-12-25) kept, full week 2024-01-01 kept,
    # week 2024-01-08 has only 3 days -> not closed -> dropped
    assert list(w.index) == [monday - 7 * D, monday]
    wk = w.loc[monday]
    assert wk["open"] == 12 and wk["close"] == 11 + 8 and wk["high"] == 20 + 8 and wk["low"] == 5 + 2
    assert wk["volume"] == 7
    assert pd.Timestamp(monday, unit="ms").day_of_week == 0


def test_resample_intraday():
    rows = [FakeBitvavo.bar(i * 15 * data.MINUTE, 15 * data.MINUTE) for i in range(9)]
    h = data.resample(data.rows_to_frame(rows), "15m", "1h")
    assert list(h.index) == [0, H]  # third hour has one bar only -> not closed
    with pytest.raises(ValueError):
        data.resample(h, "1h", "15m")


def test_find_gaps():
    df = data.rows_to_frame([FakeBitvavo.bar(t * H, H) for t in (0, 1, 4, 5, 7)])
    assert data.find_gaps(df, "1h") == [(2 * H, 3 * H, 2), (6 * H, 6 * H, 1)]


def test_to_ms():
    assert data.to_ms("1970-01-02") == D
    assert data.to_ms("1970-01-01T01:00:00+01:00") == 0
    assert data.to_ms(123) == 123 and data.to_ms(None) is None


# ------------------------------------------------------------------------------------------- pagination

def test_fetch_range_pages_through_long_gap():
    # a gap longer than one page window comes back as an empty page; we must keep walking
    src = FakeBitvavo(gaps=[(LISTING + 10 * H, LISTING + 250 * H)])
    df = data.fetch_range(src, "BTC-EUR", "1h", LISTING, LISTING + 400 * H, descending=True)
    assert len(src.calls) == 4
    assert len(df) == 400 - 240
    assert df.index.is_monotonic_increasing
    assert data.find_gaps(df, "1h") == [(LISTING + 10 * H, LISTING + 249 * H, 240)]


def test_fetch_range_chunks_are_contiguous():
    src = FakeBitvavo()
    seen = []
    data.fetch_range(src, "X-EUR", "1h", LISTING, LISTING + 1000 * H, descending=True,
                     on_chunk=lambda f: seen.append((int(f.index[0]), int(f.index[-1]), len(f))), chunk_pages=3)
    assert len(seen) == 4
    for first, last, n in seen:
        assert last == LISTING + 999 * H and n == (last - first) // H + 1


def test_update_market_full_then_incremental():
    src = FakeBitvavo()
    df = data.update_market(src, "BTC-EUR", "1h", now=NOW, progress=lambda s: None)
    expected = (data._floor(NOW, H) - LISTING) // H
    assert len(df) == expected and int(df.index[0]) == LISTING
    assert int(df.index[-1]) + H <= NOW  # only closed bars
    assert data.read_meta(data.candle_path("BTC-EUR", "1d"))  == {}  # 1d not stored, only probed

    # nothing new: no requests at all except the listing probe
    src.calls.clear()
    data.update_market(src, "BTC-EUR", "1h", now=NOW, progress=lambda s: None)
    assert all(c[1] == "1d" for c in src.calls)

    # five hours later: one small forward request
    later = NOW + 5 * H
    src.now = later
    src.calls.clear()
    df2 = data.update_market(src, "BTC-EUR", "1h", now=later, progress=lambda s: None)
    hourly = [c for c in src.calls if c[1] == "1h"]
    assert len(hourly) == 1 and hourly[0][2] == int(df.index[-1]) + H
    assert len(df2) == expected + 5 and not df2.index.duplicated().any()


def test_update_market_resumes_interrupted_backfill(monkeypatch):
    src = FakeBitvavo()
    real = data.fetch_range

    def interrupted(*a, **kw):
        if kw.get("descending"):
            kw["on_chunk"](data.normalize(pd.concat([data.rows_to_frame(
                src.get_candles("BTC-EUR", "1h", NOW - 300 * H, data._floor(NOW, H), 1000))])))
            raise KeyboardInterrupt
        return real(*a, **kw)

    monkeypatch.setattr(data, "fetch_range", interrupted)
    with pytest.raises(KeyboardInterrupt):
        data.update_market(src, "BTC-EUR", "1h", now=NOW, progress=lambda s: None)
    monkeypatch.setattr(data, "fetch_range", real)
    partial = data.load_candles("BTC-EUR", "1h")
    assert 0 < len(partial) < 1000
    df = data.update_market(src, "BTC-EUR", "1h", now=NOW, progress=lambda s: None)
    assert int(df.index[0]) == LISTING and data.find_gaps(df, "1h") == []


def test_one_minute_since_limits_history():
    src = FakeBitvavo(listing=NOW - 10 * D)
    since = NOW - 2 * D
    df = data.update_market(src, "ETH-EUR", "1m", since=since, now=NOW, progress=lambda s: None)
    assert int(df.index[0]) == data._floor(since, data.MINUTE)


def test_ensure_derives_weekly_and_fills_prefix():
    # 15m history starts later than 5m on Bitvavo (as with BTC-EUR): the older part is resampled from 5m
    src = FakeBitvavo(listing=NOW - 20 * D, starts={"15m": NOW - 3 * D})
    rows = data.ensure(["BTC-EUR"], ["5m", "15m", "1W"], source=src, progress=lambda s: None, now=NOW)
    got = {r[1]: r for r in rows}
    assert set(got) == {"5m", "15m", "1W"}
    m5 = data.load_candles("BTC-EUR", "5m")
    m15 = data.load_candles("BTC-EUR", "15m")
    assert int(m15.index[0]) == int(m5.index[0])
    assert data.find_gaps(m15, "15m") == []
    meta = data.read_meta(data.candle_path("BTC-EUR", "15m"))
    assert meta["derivedBefore"]["from"] == "5m"
    # native bars stay native
    t = int(m15.index[-1])
    assert m15.loc[t, "open"] == float(FakeBitvavo.bar(t, 15 * data.MINUTE)[1])
    # derived bars aggregate the 5m bars
    t0 = int(m15.index[0])
    chunk = m5.loc[t0:t0 + 10 * data.MINUTE]
    assert m15.loc[t0, "high"] == chunk["high"].max() and m15.loc[t0, "volume"] == chunk["volume"].sum()
    w = data.load_candles("BTC-EUR", "1W")
    assert all(pd.Timestamp(int(t), unit="ms").day_of_week == 0 for t in w.index)


# ------------------------------------------------------------------------------------------- load API

def _store(market: str = "BTC-EUR", interval: str = "1h", n: int = 48) -> pd.DataFrame:
    df = data.rows_to_frame([FakeBitvavo.bar(LISTING + i * H, H) for i in range(n)])
    data.write_frame(data.candle_path(market, interval), df)
    return df


def test_load_candles_shape_and_slicing():
    _store()
    df = data.load_candles("BTC-EUR", "1h")
    assert df.index.name == "ts" and df.index.dtype == np.int64
    assert list(df.columns) == ["open", "high", "low", "close", "volume"]
    assert all(df.dtypes == "float64") and df.index.is_monotonic_increasing
    part = data.load_candles("BTC-EUR", "1h", start="2024-01-01T05:00", end=LISTING + 10 * H)
    assert list(part.index) == [LISTING + i * H for i in range(5, 10)]  # start inclusive, end exclusive
    assert len(data.load_candles("BTC-EUR", "1h", start="2030-01-01")) == 0
    with pytest.raises(FileNotFoundError):
        data.load_candles("NOPE-EUR", "1h")
    with pytest.raises(ValueError):
        data.load_candles("BTC-EUR", "3h")


def test_load_candles_cache_sees_rewrites_and_is_not_mutated_by_callers():
    _store(n=10)
    a = data.load_candles("BTC-EUR", "1h")
    a.loc[a.index[0], "close"] = -1.0
    assert data.load_candles("BTC-EUR", "1h").iloc[0]["close"] != -1.0
    _store(n=20)
    assert len(data.load_candles("BTC-EUR", "1h")) == 20


def test_load_many_and_available():
    _store("BTC-EUR", "1h", 10)
    _store("ETH-EUR", "1h", 12)
    _store("ETH-EUR", "1d", 3)
    many = data.load_many(["BTC-EUR", "ETH-EUR"], "1h")
    assert {k: len(v) for k, v in many.items()} == {"BTC-EUR": 10, "ETH-EUR": 12}
    av = data.available()
    assert av == [("BTC-EUR", "1h", LISTING, LISTING + 9 * H, 10),
                  ("ETH-EUR", "1h", LISTING, LISTING + 11 * H, 12),
                  ("ETH-EUR", "1d", LISTING, LISTING + 2 * H, 3)]


# ------------------------------------------------------------------------------------------- universe

def test_universe_pick_substitutes_by_market_cap():
    tradable = {"BTC", "ETH", "XRP", "SOL", "DOGE", "ADA", "TRX", "LINK", "AVAX", "USDC", "DOT", "WBTC"}
    bases, notes = universe.pick(universe.DEFAULT_TOP10, tradable,
                                 lambda: ["BTC", "ETH", "USDT", "BNB", "USDC", "WBTC", "DOT", "XLM"])
    assert len(bases) == 10 and "BNB" not in bases and bases[-1] == "DOT"
    assert any("BNB" in n for n in notes)


def test_universe_top10_reads_file(tmp_store):
    (tmp_store / "universe.json").write_text('{"date": "2026-10-26", "markets": ["BTC-EUR", "ETH-EUR"]}')
    assert universe.top10() == ["BTC-EUR", "ETH-EUR"]


# ------------------------------------------------------------------------------------------- live updates

def test_refetch_overwrites_the_newest_stored_bars_and_keeps_the_rest():
    src = FakeBitvavo()
    df = data.update_market(src, "BTC-EUR", "1h", now=NOW, progress=lambda s: None)
    last = int(df.index[-1])
    src.bar = lambda ts, step: [ts, "1", "2", "0.5", "1.5", "7"]
    src.calls.clear()
    got = data.update_market(src, "BTC-EUR", "1h", now=NOW, progress=lambda s: None, refetch=2)
    assert [c[2] for c in src.calls if c[1] == "1h"] == [last - H]
    assert list(got.loc[last - H:, "volume"]) == [7.0, 7.0] and got.loc[last - 2 * H, "volume"] == 1.5
    assert len(got) == len(df)


def test_lab_updates_do_not_refetch():
    src = FakeBitvavo()
    data.update_market(src, "BTC-EUR", "1h", now=NOW, progress=lambda s: None)
    src.calls.clear()
    data.update_market(src, "BTC-EUR", "1h", now=NOW, progress=lambda s: None)
    assert [c for c in src.calls if c[1] == "1h"] == []


def test_refetch_keeps_the_listing_date_so_updates_need_no_probe():
    src = FakeBitvavo()
    data.update_market(src, "BTC-EUR", "1h", now=NOW, progress=lambda s: None, refetch=2)
    src.calls.clear()
    data.update_market(src, "BTC-EUR", "1h", now=NOW + H, progress=lambda s: None, refetch=2)
    assert all(c[1] == "1h" for c in src.calls)


def test_refetch_passes_through_weekly_and_short_files():
    src = FakeBitvavo(listing=NOW - 20 * D)
    data.update_market(src, "BTC-EUR", "1W", now=NOW, progress=lambda s: None, refetch=2)
    src.calls.clear()
    data.update_market(src, "BTC-EUR", "1W", now=NOW, progress=lambda s: None, refetch=2)
    assert {c[1] for c in src.calls} == {"1d"} and len(src.calls) == 1
    one = FakeBitvavo(listing=NOW - 2 * D)
    n = len(data.update_market(one, "X-EUR", "1h", now=NOW, progress=lambda s: None, refetch=500))
    assert len(data.update_market(one, "X-EUR", "1h", now=NOW, progress=lambda s: None, refetch=500)) == n  # file shorter


def test_listing_probe_without_candles_means_not_listed():
    class Nothing(FakeBitvavo):
        def get_candles(self, *a, **k):
            return []

    with pytest.raises(data.NotListed):
        data.update_market(Nothing(), "NOPE-EUR", "1h", now=NOW, progress=lambda s: None)
    assert issubclass(data.NotListed, data.BitvavoError)  # the lab's handling of it stays the same
