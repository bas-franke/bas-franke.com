import random

import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families import core_dip, macd_days

FAM = FAMILIES["duo_core"]
PAIR = ["BTC-EUR", "ETH-EUR"]


def spec(**params):
    p = {**FAM.default_params(), "rsiPeriod": 5, "coreSma": 20, "maxHold": 10, "fastDays": 3, "slowDays": 60,
         "signalDays": 5, **params}
    return normalize_spec({"family": "duo_core", "markets": list(PAIR), "interval": "1d", "params": p}, FAM)


def data():
    day = 86_400_000
    return {m: synth(600, i + 3, price=100 * (i + 1), step=day, vol=0.04) for i, m in enumerate(PAIR)}


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "rsiBelow": 50, "sellAbove": 40}})
    assert FAM.validate({"params": {**FAM.default_params(), "fastDays": 90, "slowDays": 80}})
    assert set(FAM.markets_needed(spec())) == set(PAIR)
    rng = random.Random(7)
    cd = data()
    for _ in range(10):
        p = FAM.sample(rng)
        s = spec(**p)
        s["risk"]["maxWeight"] = 0.8
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.8 + 1e-12).all()
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_legs_match_their_source_families():
    cd = data()
    s = spec(btcShare=0.3)
    w = FAM.targets(cd, s)
    b = core_dip.targets(cd, {"family": "core_dip", "interval": "1d", "markets": ["BTC-EUR"],
                              "params": {k: s["params"][k] for k in ("rsiPeriod", "rsiBelow", "sellAbove", "maxHold",
                                                                     "coreSma")} | {"scope": "pair"},
                              "risk": {"maxWeight": 1.0}})["BTC-EUR"]
    e = macd_days.state(cd["ETH-EUR"]["close"].to_numpy(np.float64),
                        {"fastDays": 3, "slowDays": 60, "signalDays": 5, "band": 0.0}, "1d")
    ok = w.notna().all(axis=1).to_numpy()
    assert ok.sum() > 300
    assert np.allclose(w["BTC-EUR"].to_numpy()[ok], 0.3 * b.reindex(w.index).to_numpy()[ok])
    assert np.allclose(w["ETH-EUR"].to_numpy()[ok], 0.7 * e[ok])
    assert set(np.unique(w["BTC-EUR"].to_numpy()[ok])) <= {0.0, 0.3}


def test_rejects_other_markets():
    s = spec()
    s["markets"] = ["BTC-EUR"]
    try:
        FAM.targets(data(), s)
    except ValueError:
        return
    raise AssertionError("expected ValueError")
