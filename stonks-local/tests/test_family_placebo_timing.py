import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["placebo_timing"]


def spec(**params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "placebo_timing", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def test_contract_and_exposure():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(800, 2)}
    for _ in range(10):
        df = FAM.targets(cd, spec(**FAM.sample(rng)))
        v = df["BTC-EUR"].to_numpy()
        first = int(np.argmax(np.isfinite(v)))
        assert np.isfinite(v[first:]).all() and set(np.unique(v[first:])) <= {0.0, 1.0}
    ex = FAM.explain(spec(coreSma=20))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3
    # long-run exposure ~ meanIn / (meanIn + meanOut)
    from stonks_lab.families.placebo_timing import random_state
    st = random_state(200_000, 7, 30, 10)
    assert abs(st.mean() - 0.75) < 0.03
    assert (random_state(500, 7, 30, 10) == random_state(500, 7, 30, 10)).all()
    assert (random_state(500, 7, 30, 10) != random_state(500, 8, 30, 10)).any()


def test_ignores_prices_and_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4)}
    full = FAM.targets(cd, spec(seed=11, meanIn=20, meanOut=10))["BTC-EUR"].to_numpy()
    for k in (100, 400):
        t = FAM.targets({"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}, spec(seed=11, meanIn=20, meanOut=10))
        np.testing.assert_array_equal(t["BTC-EUR"].to_numpy(), full[: k + 1])
    flat = bars([(10, 10, 10, 10)] * 600)
    other = FAM.targets({"BTC-EUR": flat}, spec(seed=11, meanIn=20, meanOut=10))["BTC-EUR"].to_numpy()
    np.testing.assert_array_equal(other, full)          # prices don't matter without a core


def test_core_gates_holding():
    up = bars([(x, x, x, x) for x in range(10, 110)])
    down = bars([(x, x, x, x) for x in range(110, 10, -1)])
    w_up = FAM.targets({"BTC-EUR": up}, spec(seed=5, meanIn=1000, meanOut=2, coreSma=5))["BTC-EUR"].to_numpy()
    w_dn = FAM.targets({"BTC-EUR": down}, spec(seed=5, meanIn=1000, meanOut=2, coreSma=5))["BTC-EUR"].to_numpy()
    assert np.isnan(w_up[:4]).all() and w_up[4:].mean() > 0.9
    assert (w_dn[4:] == 0).all()
