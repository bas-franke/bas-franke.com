"""stonks_lab.live: the signal runner the bot calls on the server (no network: a fake Bitvavo)."""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import numpy as np
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
