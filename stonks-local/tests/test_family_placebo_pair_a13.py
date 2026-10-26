import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["placebo_pair_a13"]
D = 86_400_000


def spec(**params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "placebo_pair_a13", "markets": ["BTC-EUR", "ETH-EUR"], "interval": "1d",
                           "params": p}, FAM)


def candles(n=3000):
    return {"BTC-EUR": synth(n, 1, step=D), "ETH-EUR": synth(n, 2, step=D)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "mode": "nope"}})
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_joint_moves_together_split_does_not_and_exposure_matches():
    cd = candles()
    w = FAM.targets(cd, spec(mode="joint", meanIn=60, meanOut=20)).to_numpy()
    assert set(np.unique(w)) <= {0.0, 0.5}
    np.testing.assert_array_equal(w[:, 0], w[:, 1])
    assert 0.6 < (w[:, 0] > 0).mean() < 0.9            # ~75 % in
    s = FAM.targets(cd, spec(mode="split", meanIn=60, meanOut=20)).to_numpy()
    assert (s[:, 0] != s[:, 1]).any()
    assert (s.sum(axis=1) <= 1.0 + 1e-12).all()


def test_ignores_prices_and_truncation():
    cd = candles(2000)
    full = FAM.targets(cd, spec(mode="split", seed=9)).to_numpy()
    cut = FAM.targets({m: d.iloc[:1200] for m, d in cd.items()}, spec(mode="split", seed=9)).to_numpy()
    np.testing.assert_array_equal(cut, full[:1200])
    scaled = {m: d.assign(close=d["close"] * 3.0) for m, d in cd.items()}
    np.testing.assert_array_equal(FAM.targets(scaled, spec(mode="split", seed=9)).to_numpy(), full)
