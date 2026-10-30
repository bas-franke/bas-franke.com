"""stonks_lab.live: the signal runner the bot calls on the server (no network: a fake Bitvavo)."""
from __future__ import annotations

import io
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from stonks_lab import data, live  # noqa: E402
from stonks_lab.families import FAMILIES, discover, normalize_spec  # noqa: E402
from test_data import FakeBitvavo  # noqa: E402

H = data.HOUR
LISTING = data.to_ms("2024-01-01")
NOW = data.to_ms("2024-03-01T10:30")


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(data, "DATA_DIR", tmp_path)
    fake = FakeBitvavo(listing=LISTING, now=NOW)
    monkeypatch.setattr(live, "_client", fake)
    monkeypatch.setattr(data, "now_ms", lambda: NOW)
    data._read_cached.cache_clear()
    yield fake
    data._read_cached.cache_clear()


def run(cmd, payload, monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(payload)))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    code = live.main([cmd])
    monkeypatch.undo()
    return code, json.loads(out.getvalue())


def ema_spec(**params):
    return {"family": "ema_cross", "markets": ["BTC-EUR"], "interval": "1h", "params": {"fast": 5, "slow": 20, **params}}


def test_catalog_lists_every_family_in_the_bot_shape():
    discover()
    cat = live.catalog()
    names = {f["family"] for f in cat["families"]}
    assert names == set(FAMILIES)
    for f in cat["families"]:
        assert {"family", "title", "version", "multiMarket", "anchored", "params", "objectParams"} <= set(f)
        for p in f["params"]:
            assert p["type"] in ("int", "number", "boolean", "choice")
            if p["type"] == "choice":
                assert p["default"] in p["options"]
    json.dumps(cat, allow_nan=False)
    wrappers = {f["family"]: f["objectParams"] for f in cat["families"] if f["objectParams"]}
    assert [p["name"] for p in wrappers["mtf_guard_a24"]] == ["inner"]   # the bot must accept the wrapped lead


def test_describe_reports_markets_and_param_errors():
    d = live.describe(ema_spec())
    assert d["error"] is None and d["markets"] == ["BTC-EUR"] and d["explanation"]
    assert live.describe(ema_spec(fast=30))["error"]
    with pytest.raises(KeyError):
        live.describe({"family": "../evil", "markets": ["BTC-EUR"], "interval": "1h"})
    with pytest.raises(ValueError, match="version"):
        live.describe({**ema_spec(), "familyVersion": 99})


def test_targets_warm_up_first_then_match_the_backtest_on_full_history(store, monkeypatch):
    spec = ema_spec()
    bar = data.to_ms("2024-03-01T08:00")
    assert live.targets({"spec": spec, "bar": bar}) == {"warming": ["BTC-EUR 1h"]}
    assert live.prepare({"spec": spec}) == {"ready": True}
    got = live.targets({"spec": spec, "bar": bar})
    assert got["t"] == bar  # the newer closed 09:00 bar is not used: the bot decides on `bar`

    full = data.load_candles("BTC-EUR", "1h")
    assert int(full.index[0]) == LISTING  # backfilled to the listing, like the lab
    fam = FAMILIES["ema_cross"]
    want = fam.targets({"BTC-EUR": full[full.index <= bar]}, normalize_spec(spec, fam))
    w = float(want.iloc[-1]["BTC-EUR"])
    assert got["weights"]["BTC-EUR"] == pytest.approx(0.0 if np.isnan(w) else w)

    # later bars only fetch what is new
    n = len(store.calls)
    live.targets({"spec": spec, "bar": data.to_ms("2024-03-01T09:00")})
    assert 0 < len(store.calls) - n <= 3


def test_prepare_is_single_flight(store):
    lock = data.DATA_DIR / "live_prepare.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("1")
    assert live.prepare({"spec": ema_spec()}) == {"busy": True}
    assert live._ready() == set()


def test_main_answers_json_errors(store, monkeypatch):
    code, out = run("targets", {"spec": ema_spec(fast=30), "bar": 0}, monkeypatch)
    assert code == 1 and "fast" in out["error"]
    code, out = run("describe", {"spec": ema_spec()}, monkeypatch)
    assert code == 0 and out["markets"] == ["BTC-EUR"]


# ------------------------------------------------------------------------------------------- trustworthy decisions

def ready(spec):
    assert live.prepare({"spec": spec}) == {"ready": True}


BAR = data.to_ms("2024-03-01T09:00")


def fake_family(monkeypatch, weights=None, reads=()):
    """ema_cross with its decision replaced: ``weights`` per market (None = no targets), reads candles from disk."""
    fam = FAMILIES["ema_cross"]

    def targets(candles, spec, start_time=None):
        for m, iv in reads:
            try:
                data.load_candles(m, iv)
            except FileNotFoundError:
                pass
        if weights is None:
            return None
        df = candles["BTC-EUR"]
        return pd.DataFrame({m: [v] * len(df) for m, v in weights.items()}, index=df.index)

    monkeypatch.setattr(fam, "targets", targets)
    return ema_spec()


def fail_market(store, monkeypatch, market, interval=None):
    real = store.get_candles

    def get_candles(m, iv, *a, **kw):
        if m == market and (interval is None or iv == interval):
            raise data.BitvavoError("HTTP 500")
        return real(m, iv, *a, **kw)

    monkeypatch.setattr(store, "get_candles", get_candles)
    return real


def test_failed_backfill_is_not_ready_and_is_retried(store, monkeypatch):
    spec = ema_spec()
    real = fail_market(store, monkeypatch, "BTC-EUR")
    got = live.prepare({"spec": spec})
    assert got["ready"] is False and "HTTP 500" in got["failed"]["BTC-EUR 1h"]
    assert "BTC-EUR 1h" not in live._ready()
    assert live.targets({"spec": spec, "bar": BAR}) == {"warming": ["BTC-EUR 1h"]}
    monkeypatch.setattr(store, "get_candles", real)
    ready(spec)
    assert live.targets({"spec": spec, "bar": BAR})["t"] == BAR


def test_unlisted_market_counts_ready_like_in_the_lab(store, monkeypatch):
    real = store.get_candles

    def get_candles(m, iv, *a, **kw):
        if m == "NOPE-EUR":
            raise data.NotListed("HTTP 400: market parameter is invalid")
        return real(m, iv, *a, **kw)

    monkeypatch.setattr(store, "get_candles", get_candles)
    monkeypatch.setattr(FAMILIES["ema_cross"], "markets_needed", lambda s: ["BTC-EUR", "NOPE-EUR"])
    spec = ema_spec()
    ready(spec)
    assert {"BTC-EUR 1h", "NOPE-EUR 1h"} <= live._ready()
    assert not data.candle_path("NOPE-EUR", "1h").exists()
    assert "weights" in live.targets({"spec": spec, "bar": BAR})


def test_error_205_is_not_listed_but_other_errors_are_failures(monkeypatch):
    class Resp:
        headers: dict = {}

        def __init__(self, code, text):
            self.status_code, self.text = code, text

    c = data.BitvavoClient(min_gap=0)
    monkeypatch.setattr(c.session, "get", lambda *a, **k: Resp(400, '{"errorCode":205,"error":"market parameter is invalid."}'))
    with pytest.raises(data.NotListed):
        c.get_candles("EOS-EUR", "1h", 0, 1)
    monkeypatch.setattr(c.session, "get", lambda *a, **k: Resp(400, '{"errorCode":105,"error":"rate limit"}'))
    with pytest.raises(data.BitvavoError) as e:
        c.get_candles("BTC-EUR", "1h", 0, 1)
    assert not isinstance(e.value, data.NotListed)


def test_no_candles_or_no_targets_hold(store, monkeypatch):
    spec = fake_family(monkeypatch, weights=None)
    ready(spec)
    got = live.targets({"spec": spec, "bar": BAR})
    assert "no targets" in got["hold"] and got["t"] is None
    got = live.targets({"spec": spec, "bar": LISTING - 10 * H})  # before anything exists
    assert "no candles for BTC-EUR" in got["hold"] and got["t"] is None


def test_all_nan_row_holds_and_a_partly_nan_row_is_out(store, monkeypatch):
    spec = fake_family(monkeypatch, weights={"BTC-EUR": np.nan})
    ready(spec)
    got = live.targets({"spec": spec, "bar": BAR})
    assert "no decision" in got["hold"] and got["t"] == BAR
    spec = {**ema_spec(), "markets": ["BTC-EUR", "ETH-EUR"]}
    monkeypatch.setattr(FAMILIES["ema_cross"], "validate", lambda s: None)
    fake_family(monkeypatch, weights={"BTC-EUR": np.nan, "ETH-EUR": 0.5})
    ready(spec)
    assert live.targets({"spec": spec, "bar": BAR}) == {"t": BAR, "weights": {"BTC-EUR": 0.0, "ETH-EUR": 0.5}}


def test_prepare_warms_cross_market_reads_so_targets_downloads_no_history(store, monkeypatch):
    spec = fake_family(monkeypatch, weights={"BTC-EUR": 1.0}, reads=[("XRP-EUR", "1h"), ("BTC-EUR", "1d")])
    ready(spec)
    assert int(data.load_candles("XRP-EUR", "1h").index[0]) == LISTING
    store.calls.clear()
    got = live.targets({"spec": spec, "bar": BAR})
    assert got["weights"] == {"BTC-EUR": 1.0}
    assert len(store.calls) == 3  # one small window per read, no listing probe or backfill
    assert all(c[3] - c[2] <= 3 * data.INTERVAL_MS[c[1]] for c in store.calls)


def test_family_code_or_new_reads_warm_again(store, monkeypatch):
    spec = ema_spec()
    ready(spec)
    monkeypatch.setattr(live, "code_hash", lambda fam: "changed")
    assert live.targets({"spec": spec, "bar": BAR})["warming"][0].startswith("reads ema_cross")


def test_failed_warm_read_is_reported(store, monkeypatch):
    spec = fake_family(monkeypatch, weights={"BTC-EUR": 1.0}, reads=[("XRP-EUR", "1h")])
    fail_market(store, monkeypatch, "XRP-EUR")
    got = live.prepare({"spec": spec})
    assert got["ready"] is False and "XRP-EUR 1h" in got["failed"]
    assert "warming" in live.targets({"spec": spec, "bar": BAR})


def stale_setup(store, monkeypatch, market="XRP-EUR"):
    """Everything prepared; then time moves 5 hours on and ``market`` no longer updates."""
    spec = fake_family(monkeypatch, weights={"BTC-EUR": 1.0}, reads=[(market, "1h")])
    ready(spec)
    store.now = NOW + 5 * H
    monkeypatch.setattr(data, "now_ms", lambda: NOW + 5 * H)
    fail_market(store, monkeypatch, market)
    return spec, BAR + 5 * H


def test_a_stale_read_with_a_failed_update_holds_naming_the_market(store, monkeypatch):
    spec, bar = stale_setup(store, monkeypatch)
    store.market_status = {"BTC-EUR": "trading", "XRP-EUR": "trading"}
    got = live.targets({"spec": spec, "bar": bar})
    assert "XRP-EUR 1h" in got["hold"] and "HTTP 500" in got["hold"] and got["t"] == bar


def test_one_late_bar_is_tolerated(store, monkeypatch):
    spec, bar = stale_setup(store, monkeypatch)
    store.market_status = {"XRP-EUR": "trading"}
    assert "weights" in live.targets({"spec": spec, "bar": BAR + H})  # newest XRP bar is 1 bar behind at that bar


def test_delisted_or_halted_coin_is_no_reason_to_hold(store, monkeypatch):
    spec, bar = stale_setup(store, monkeypatch)
    store.market_status = {"BTC-EUR": "trading", "XRP-EUR": "halted"}
    assert "weights" in live.targets({"spec": spec, "bar": bar})
    store.market_status = {"BTC-EUR": "trading"}      # gone from the list altogether
    assert "weights" in live.targets({"spec": spec, "bar": bar})


def test_market_list_failure_holds_rather_than_guess(store, monkeypatch):
    spec, bar = stale_setup(store, monkeypatch)
    store.market_status = None
    assert "market list" in live.targets({"spec": spec, "bar": bar})["hold"]


def test_quiet_coin_after_a_good_update_is_no_reason_to_hold(store, monkeypatch):
    spec = fake_family(monkeypatch, weights={"BTC-EUR": 1.0}, reads=[("XRP-EUR", "1h")])
    ready(spec)
    store.gaps_of = {"XRP-EUR": (NOW - 3 * H, NOW + 9 * H)}   # thin market: no trades, so no candles
    store.now = NOW + 5 * H
    monkeypatch.setattr(data, "now_ms", lambda: NOW + 5 * H)
    assert "weights" in live.targets({"spec": spec, "bar": BAR + 5 * H})


def test_a_stale_traded_or_core_market_is_never_excused(store, monkeypatch):
    spec, bar = stale_setup(store, monkeypatch, market="ETH-EUR")
    store.market_status = {"ETH-EUR": "halted"}
    assert "ETH-EUR 1h" in live.targets({"spec": spec, "bar": bar})["hold"]


def test_coin_without_any_file_is_no_reason_to_hold(store, monkeypatch):
    spec, bar = stale_setup(store, monkeypatch)
    data.candle_path("XRP-EUR", "1h").unlink()
    assert "weights" in live.targets({"spec": spec, "bar": bar})


def test_out_of_time_stops_fetching_and_holds(store, monkeypatch):
    spec = ema_spec()
    ready(spec)
    store.now = NOW + 5 * H
    monkeypatch.setattr(data, "now_ms", lambda: NOW + 5 * H)
    monkeypatch.setattr(live, "TARGETS_BUDGET_S", -1)
    store.calls.clear()
    got = live.targets({"spec": spec, "bar": BAR + 5 * H})
    assert "out of time" in got["hold"] and store.calls == []


def test_targets_replace_provisional_bars(store, monkeypatch):
    spec = ema_spec()
    ready(spec)
    last = int(data.load_candles("BTC-EUR", "1h").index[-1])
    bar = store.bar
    store.bar = lambda ts, step: [ts, "1", "2", "0.5", "1.5", "9"] if ts == last - H else bar(ts, step)
    live.targets({"spec": spec, "bar": last})
    assert data.load_candles("BTC-EUR", "1h").loc[last - H, "close"] == 1.5
    assert data.load_candles("BTC-EUR", "1h").loc[last - 2 * H, "close"] != 1.5  # only the last 2 are fetched again


def test_refetch_without_changes_does_not_rewrite_the_file(store):
    spec = ema_spec()
    ready(spec)
    p = data.candle_path("BTC-EUR", "1h")
    t = p.stat().st_mtime_ns
    live.targets({"spec": spec, "bar": BAR})
    assert p.stat().st_mtime_ns == t


def test_busy_stale_and_live_locks(store, monkeypatch):
    lock = data.DATA_DIR / "live_prepare.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("1")
    os.utime(lock, (time.time() - live.LOCK_STALE_S + 60,) * 2)
    assert live.prepare({"spec": ema_spec()}) == {"busy": True}
    os.utime(lock, (time.time() - live.LOCK_STALE_S - 60,) * 2)
    assert live.prepare({"spec": ema_spec()}) == {"ready": True}
    assert not lock.exists()


def test_lock_is_kept_alive_while_prepare_runs(store, monkeypatch):
    monkeypatch.setattr(live, "LOCK_BEAT_S", 0.01)
    lock = data.DATA_DIR / "live_prepare.lock"
    with live._prepare_lock() as mine:
        assert mine
        os.utime(lock, (1, 1))
        deadline = time.time() + 5
        while lock.stat().st_mtime < 1000 and time.time() < deadline:
            time.sleep(0.01)
        assert lock.stat().st_mtime > 1000


def test_use_live_data_restores_the_real_path(store):
    real = data.candle_path
    with live.use_live_data() as reads:
        data.candle_path("BTC-EUR", "1h")
        assert list(reads) == [("BTC-EUR", "1h")]
    assert data.candle_path is real


def test_code_hash_is_deterministic_and_follows_imports(tmp_path, monkeypatch):
    discover()
    fam = FAMILIES["s10_bearbreadth"]
    h = live.code_hash(fam)
    assert h == live.code_hash(fam) and len(h) == 64
    assert h != live.code_hash(FAMILIES["s9_cyclebull"])
    root = live._LAB_ROOT
    sib = root / "families" / "_step.py"
    files = {p.name for p in live._imports(root / "families" / "step_wrap_a24.py")}
    assert {"_step.py", "_base.py"} <= files and sib.is_file()
    assert "universe.py" in {p.name for p in live._imports(root / "families" / "pit_rotation.py")}

    real = Path.read_bytes
    crlf = lambda self: real(self).replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")  # noqa: E731
    monkeypatch.setattr(Path, "read_bytes", crlf)
    assert live.code_hash(fam) == h                     # line endings do not matter

    def changed(self):
        return real(self) + (b"# touched\n" if self.name == "_ta.py" else b"")

    monkeypatch.setattr(Path, "read_bytes", changed)
    assert live.code_hash(fam) != h                     # a shared module does


def test_catalog_has_a_code_hash_per_family():
    discover()
    cat = live.catalog()
    assert all(len(f["codeHash"]) == 64 for f in cat["families"])
