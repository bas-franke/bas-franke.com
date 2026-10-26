import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["v_recovery"]
CRASH = [100, 100, 100, 60, 60, 70, 72, 74, 76, 78, 80, 82]   # -40 % crash, bounce to 70 (+16.7 % off the low) at i=5


def spec(markets=("BTC-EUR",), **params):
    p = {"coreSma": 0, "hiLook": 4, "lowLook": 2, "ddMin": 0.3, "bounceMin": 0.1, "holdBars": 3,
         "stopAtLow": True, "source": "own", **params}
    return normalize_spec({"family": "v_recovery", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "lowLook": 100, "hiLook": 50}})
    rng = random.Random(7)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for _ in range(15):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    assert set(FAM.markets_needed(spec(["BTC-EUR"], source="pair"))) == {"BTC-EUR", "ETH-EUR"}
    assert set(FAM.markets_needed(spec(["ETH-EUR"]))) == {"ETH-EUR"}
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], coreSma=50, source="pair"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_buys_confirmed_bounce_not_the_bottom_and_holds_n_bars():
    w = FAM.targets({"BTC-EUR": closes(CRASH)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:3]).all()
    assert list(w[3:]) == [0, 0, 1, 1, 1, 0, 0, 0, 0]


def test_no_trade_without_a_crash():
    mild = [100, 100, 100, 85, 85, 95, 96, 97, 98, 99, 100, 101]   # -15 % < ddMin
    w = FAM.targets({"BTC-EUR": closes(mild)}, spec())["BTC-EUR"].to_numpy()
    assert (w[3:] == 0).all()


def test_stop_at_low_ends_failed_recovery():
    fail = [100, 100, 100, 60, 60, 70, 55, 54, 53, 52, 51, 50]
    w = FAM.targets({"BTC-EUR": closes(fail)}, spec(holdBars=50))["BTC-EUR"].to_numpy()
    assert list(w[3:8]) == [0, 0, 1, 0, 0]
    w2 = FAM.targets({"BTC-EUR": closes(fail)}, spec(holdBars=50, stopAtLow=False))["BTC-EUR"].to_numpy()
    assert (w2[5:] == 1).all()


def test_pair_needs_both_and_core_holds_uptrend():
    cd = {"BTC-EUR": closes(CRASH), "ETH-EUR": closes([10] * 12)}
    assert (FAM.targets(cd, spec(source="pair"))["BTC-EUR"].to_numpy()[3:] == 0).all()
    cd2 = {"BTC-EUR": closes(CRASH), "ETH-EUR": closes([x / 10 for x in CRASH])}
    w2 = FAM.targets(cd2, spec(source="pair"))["BTC-EUR"].to_numpy()
    assert list(w2[3:]) == [0, 0, 1, 1, 1, 0, 0, 0, 0]
    up = list(range(1, 13))
    w3 = FAM.targets({"BTC-EUR": closes(up)}, spec(coreSma=3))["BTC-EUR"].to_numpy()
    assert (w3[3:] == 1).all()
