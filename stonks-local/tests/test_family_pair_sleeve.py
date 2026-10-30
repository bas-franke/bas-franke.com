import ast
import json
import sys
from pathlib import Path

import numpy as np
import pytest

from _engine_util import synth
from stonks_lab import backtest, data, live
from stonks_lab.families import FAMILIES, normalize_spec

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_data import FakeBitvavo  # noqa: E402

FAM = FAMILIES["pair_sleeve"]
D1 = 86_400_000
T0 = 1_600_000_000_000 - (1_600_000_000_000 % D1)
PAIR = ("BTC-EUR", "ETH-EUR")
LEAD = {"family": "stale_trend", "params": {"coreLen": 50, "hiLook": 30, "staleBars": 0}}


def spec(inner=LEAD, share=None, markets=PAIR, mw=1.0):
    return normalize_spec({"family": "pair_sleeve", "markets": list(markets), "interval": "1d",
                           "params": {"inner": inner, "share": share or {}}, "risk": {"maxWeight": mw}}, FAM)


def candles(n=600, seed=4):
    return {"BTC-EUR": synth(n, seed, start=T0, step=D1), "ETH-EUR": synth(n, seed + 1, start=T0, step=D1, price=1500)}


def alone(cd, market, inner=LEAD):
    fam = FAMILIES[inner["family"]]
    s = normalize_spec({"family": inner["family"], "markets": [market], "interval": "1d",
                        "params": inner["params"]}, fam)
    return fam.targets({market: cd[market]}, s)[market]


def test_validation_and_explain():
    assert FAM.validate({"params": FAM.default_params()}) is None
    for bad in ({"inner": {"family": "nope", "params": {}}},
                {"inner": {"family": "pair_sleeve", "params": {}}},
                {"inner": {"family": "floor_wrap_a07", "params": {}}},    # multi-market
                {"inner": {"family": "dca_dip", "params": {}}},           # anchored
                {"inner": LEAD, "share": {"BTC-EUR": 0.7, "ETH-EUR": 0.7}},
                {"inner": LEAD, "share": {"BTC-EUR": 0, "ETH-EUR": 0.5}},
                {"inner": LEAD, "share": {"BTC-EUR": "half"}},
                {"inner": LEAD, "share": []}):
        assert FAM.validate({"params": bad}), bad
    ex = FAM.explain(spec(share={"BTC-EUR": 0.3, "ETH-EUR": 0.7}))
    assert "30 % BTC and 70 % ETH" in ex["howItWorks"][0]
    assert ex["summary"] and ex["whenItWins"] and ex["whenItLoses"]


def test_weight_is_share_times_the_single_coin_run():
    cd = candles()
    t = FAM.targets(cd, spec(share={"BTC-EUR": 0.3, "ETH-EUR": 0.7}))
    for m, part in (("BTC-EUR", 0.3), ("ETH-EUR", 0.7)):
        raw = alone(cd, m).to_numpy()
        np.testing.assert_allclose(np.nan_to_num(t[m].to_numpy(), nan=-1), np.nan_to_num(raw * part, nan=-1))
    assert (t.sum(axis=1) <= 1 + 1e-12).all()
    half = FAM.targets(cd, spec())
    np.testing.assert_allclose(np.nan_to_num(half["ETH-EUR"].to_numpy(), nan=-1),
                               np.nan_to_num(alone(cd, "ETH-EUR").to_numpy() * 0.5, nan=-1))
    capped = FAM.targets(cd, spec(mw=0.6))
    assert np.nanmax(capped.sum(axis=1)) <= 0.6 + 1e-12 and np.nanmax(capped.to_numpy()) <= 0.3 + 1e-12


def test_a_share_must_name_every_market():
    with pytest.raises(ValueError):
        FAM.markets_needed(spec(share={"BTC-EUR": 0.5}))
    with pytest.raises(ValueError):
        FAM.targets(candles(), spec(share={"BTC-EUR": 0.5, "SOL-EUR": 0.5}))


def test_a_bar_without_a_candle_keeps_the_target_and_nothing_looks_ahead():
    cd = candles()
    cd["ETH-EUR"] = cd["ETH-EUR"].drop(cd["ETH-EUR"].index[400])
    s = spec()
    full = FAM.targets(cd, s)
    assert len(full) == 600
    e = full["ETH-EUR"].to_numpy()
    assert np.isfinite(e[400]) and e[400] == e[399]
    for k in (300, 500):
        ts = int(full.index[k])
        part = FAM.targets({m: d[np.asarray(d.index) <= ts] for m, d in cd.items()}, s).to_numpy()
        assert np.array_equal(np.nan_to_num(part, nan=-1), np.nan_to_num(full.to_numpy()[: k + 1], nan=-1))


def test_runs_one_shared_wallet_through_the_engine():
    cd = candles()
    res = backtest.run(spec(), cd)
    assert {t["market"] for t in res.trades} == set(PAIR)
    assert res.exposure.max() <= 1 + 1e-9 and res.cash.min() > -1e-6


def test_imports_stay_within_what_the_server_gets():
    src = (Path(live.__file__).parent / "families" / "pair_sleeve.py").read_text(encoding="utf-8")
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Import):
            assert all(a.name.split(".")[0] in ("numpy", "pandas") for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            assert node.module == "__future__"
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 1 and node.module in (None, "_base")


def test_bot_rules_catalog_and_spec_size():
    cat = {f["family"]: f for f in live.catalog()["families"]}["pair_sleeve"]
    assert cat["multiMarket"] and not cat["anchored"] and cat["params"] == []
    assert [p["name"] for p in cat["objectParams"]] == ["inner", "share"]
    book = {"family": "s10_bearbreadth", "params": FAMILIES["s10_bearbreadth"].default_params()}
    s = spec(book, {"BTC-EUR": 0.5, "ETH-EUR": 0.5})
    assert set(s["markets"]) == set(PAIR)
    assert max(len(json.dumps(s["params"][k])) for k in ("inner", "share")) < 20_000


def test_live_answers_with_the_share_of_each_coin(tmp_path, monkeypatch):
    now = data.to_ms("2024-03-01T10:30")
    monkeypatch.setattr(data, "DATA_DIR", tmp_path)
    monkeypatch.setattr(live, "_client", FakeBitvavo(listing=data.to_ms("2024-01-01"), now=now))
    monkeypatch.setattr(data, "now_ms", lambda: now)
    monkeypatch.setattr(data, "candle_path", data.candle_path)    # live.targets hooks it for the process: restore it
    data._read_cached.cache_clear()
    raw ={"family": "pair_sleeve", "markets": list(PAIR), "interval": "1h",
           "params": {"inner": {"family": "ema_cross", "params": {"fast": 5, "slow": 20}},
                      "share": {"BTC-EUR": 0.5, "ETH-EUR": 0.5}}}
    try:
        d = live.describe(raw)
        assert d["error"] is None and d["markets"] == list(PAIR) and d["explanation"]
        bar = data.to_ms("2024-03-01T09:00")
        assert live.targets({"spec": raw, "bar": bar})["warming"] == ["BTC-EUR 1h", "ETH-EUR 1h"]
        assert live.prepare({"spec": raw}) == {"ready": True}
        got = live.targets({"spec": raw, "bar": bar})
        assert got["t"] == bar and set(got["weights"]) == set(PAIR)
        assert all(v in (0.0, 0.5) for v in got["weights"].values())
    finally:
        data._read_cached.cache_clear()
