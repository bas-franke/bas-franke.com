import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["optrep_a12"]


def spec(markets=("BTC-EUR",), **params):
    base = FAM.default_params()
    base.update(params)
    return normalize_spec({"family": "optrep_a12", "markets": list(markets), "interval": "4h", "params": base}, FAM)


def closes(xs):
    return {"BTC-EUR": bars([(x, x, x, x) for x in xs])}


def wiggle(xs, amp=0.01):
    return [x * (1 + (amp if i % 2 else -amp)) for i, x in enumerate(xs)]


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_rally_goes_all_in_and_crash_goes_to_cash():
    up = wiggle(list(np.linspace(100.0, 400.0, 120)))
    w = FAM.targets(closes(up), spec(tenor=20, ladders=1, volLen=10, step=0.1))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:5]).all()
    assert np.nanmean(w[60:]) > 0.7   # ~0.5 right after each roll, ->1 as it rises
    down = wiggle(list(np.linspace(400.0, 100.0, 120)))
    w = FAM.targets(closes(down), spec(tenor=20, ladders=1, volLen=10, step=0.1))["BTC-EUR"].to_numpy()
    assert np.nanmean(w[60:]) < 0.3


def test_floor_step_and_restrike():
    up = wiggle(list(np.linspace(100.0, 400.0, 120)))
    w = FAM.targets(closes(up), spec(tenor=20, ladders=2, volLen=10, floorWeight=0.3, step=0.1))["BTC-EUR"]
    v = w.dropna().to_numpy()
    assert v.min() >= 0.3 - 1e-9 and v.max() <= 1.0
    assert np.allclose(v * 10, np.round(v * 10))
    # out of the money strike right after a roll gives a lower delta than at the money
    flat = wiggle([100.0] * 120, 0.02)
    atm = FAM.targets(closes(flat), spec(tenor=40, ladders=1, volLen=10, step=0.02))["BTC-EUR"].to_numpy()
    otm = FAM.targets(closes(flat), spec(tenor=40, ladders=1, volLen=10, step=0.02, strike=1.2))["BTC-EUR"].to_numpy()
    assert np.nanmean(otm) < np.nanmean(atm)


def test_multi_market_split_and_max_weight():
    cd = {"BTC-EUR": synth(300, 2, drift=0.002), "ETH-EUR": synth(300, 3, drift=0.002)}
    s = spec(markets=("BTC-EUR", "ETH-EUR"), tenor=30, ladders=3, volLen=20, step=0.25)
    s["risk"]["maxWeight"] = 0.8
    w = FAM.targets(cd, s).to_numpy()
    good = w[~np.isnan(w).any(axis=1)]
    assert len(good) > 100 and good.max() <= 0.4 + 1e-9


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(tenor=50, ladders=4, volLen=30), spec(tenor=13, ladders=1, volLen=7, strike=0.9, floorWeight=0.2)):
        full = FAM.targets(cd, s).to_numpy()
        for k in (150, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
