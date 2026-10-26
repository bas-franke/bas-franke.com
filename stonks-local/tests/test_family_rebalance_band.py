import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["rebalance_band"]


def spec(markets=("BTC-EUR", "ETH-EUR"), **params):
    p = {"band": 0.1, "everyBars": 0, **params}
    return normalize_spec({"family": "rebalance_band", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"band": 0, "everyBars": 0}}) is not None
    rng = random.Random(2)
    cd = {m: synth(600, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", "SOL-EUR"])}
    for _ in range(20):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        s = spec(["BTC-EUR", "ETH-EUR", "SOL-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        assert not np.isnan(v).any()
        assert (v >= 0).all() and np.allclose(v.sum(axis=1), 0.6)
    ex = FAM.explain(spec(everyBars=30))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_band_rebalance():
    a = closes([100, 100, 150, 200, 200])
    b = closes([100, 100, 100, 100, 100])
    w = FAM.targets({"BTC-EUR": a, "ETH-EUR": b}, spec(band=0.1))["BTC-EUR"].to_numpy()
    # i2: 0.5u*150 / (75+50) = 0.6 -> drift 0.1, not > 0.1 -> keep 0.6
    # i3: A worth 100 vs 50 -> 0.667 > 0.6 -> rebalance to 0.5; i4 unchanged prices -> 0.5
    assert np.allclose(w, [0.5, 0.5, 0.6, 0.5, 0.5])


def test_schedule_and_no_lookahead():
    a = closes([100, 120, 140, 160, 180, 200])
    b = closes([100, 100, 100, 100, 100, 100])
    s = spec(band=0, everyBars=2)
    w = FAM.targets({"BTC-EUR": a, "ETH-EUR": b}, s)["BTC-EUR"].to_numpy()
    assert w[0] == 0.5 and w[2] == 0.5 and w[4] == 0.5
    assert w[1] > 0.5 and w[3] > 0.5 and w[5] > 0.5
    cd = {"BTC-EUR": synth(500, 1), "ETH-EUR": synth(500, 2, price=1500)}
    s2 = spec(band=0.05, everyBars=40)
    full = FAM.targets(cd, s2).to_numpy()
    for k in (100, 300):
        t = FAM.targets({m: df.iloc[: k + 1] for m, df in cd.items()}, s2).to_numpy()
        np.testing.assert_array_equal(t, full[: k + 1])
