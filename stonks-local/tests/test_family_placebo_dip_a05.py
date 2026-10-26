import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.placebo_dip_a05 import dip_state

FAM = FAMILIES["placebo_dip_a05"]


def spec(**params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "placebo_dip_a05", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def test_contract_and_samples():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(800, 2)}
    for _ in range(8):
        v = FAM.targets(cd, spec(**FAM.sample(rng)))["BTC-EUR"].to_numpy()
        fin = v[np.isfinite(v)]
        assert set(np.unique(fin)) <= {0.0, 1.0}
    assert len(FAM.explain(spec())["howItWorks"]) >= 3


def test_core_holds_uptrend_and_dips_are_random_below():
    up = bars([(x, x, x, x) for x in range(10, 210)])
    w = FAM.targets({"BTC-EUR": up}, spec(coreSma=5, meanGap=2, meanLen=3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:4]).all() and (w[4:] == 1).all()
    down = bars([(x, x, x, x) for x in range(400, 10, -1)])
    w = FAM.targets({"BTC-EUR": down}, spec(coreSma=5, meanGap=20, meanLen=5, seed=3))["BTC-EUR"].to_numpy()[4:]
    assert 0.05 < w.mean() < 0.5                    # some random dip holds, not all
    st = dip_state(np.ones(200_000, bool), 9, 20, 5)
    assert abs(st.mean() - 5 / 25) < 0.02          # exposure ~ len / (gap + len)
    assert (dip_state(np.zeros(500, bool), 9, 2, 5) == 0).all()   # never starts above the core


def test_no_lookahead_prefix():
    cd = {"BTC-EUR": synth(700, 6)}
    full = FAM.targets(cd, spec(seed=7, coreSma=30, meanGap=10, meanLen=8))["BTC-EUR"].to_numpy()
    for k in (200, 500):
        t = FAM.targets({"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}, spec(seed=7, coreSma=30, meanGap=10, meanLen=8))
        np.testing.assert_array_equal(t["BTC-EUR"].to_numpy(), full[: k + 1])
