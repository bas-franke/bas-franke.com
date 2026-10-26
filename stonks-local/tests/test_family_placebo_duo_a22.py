import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["placebo_duo_a22"]
MK = ["BTC-EUR", "ETH-EUR"]


def spec(**params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "placebo_duo_a22", "markets": MK, "interval": "1d", "params": p}, FAM)


def test_contract_and_weights():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    cd = {"BTC-EUR": synth(700, 2), "ETH-EUR": synth(700, 3)}
    for _ in range(8):
        df = FAM.targets(cd, spec(**FAM.sample(rng)))
        for m in MK:
            v = df[m].to_numpy()
            first = int(np.argmax(np.isfinite(v)))
            assert np.isfinite(v[first:]).all() and set(np.unique(v[first:])) <= {0.0, 0.5}
        assert (df.sum(axis=1) <= 1.0 + 1e-12).all()
    ex = FAM.explain(spec(mode="independent"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_common_vs_independent():
    cd = {"BTC-EUR": synth(3000, 2), "ETH-EUR": synth(3000, 3)}
    c = FAM.targets(cd, spec(seed=9, meanIn=20, meanOut=10, mode="common"))
    np.testing.assert_array_equal(c["BTC-EUR"].to_numpy(), c["ETH-EUR"].to_numpy())
    i = FAM.targets(cd, spec(seed=9, meanIn=20, meanOut=10, mode="independent"))
    assert (i["BTC-EUR"].to_numpy() != i["ETH-EUR"].to_numpy()).any()
    np.testing.assert_array_equal(i["BTC-EUR"].to_numpy(), c["BTC-EUR"].to_numpy())  # first market = common path
    assert abs((i["ETH-EUR"].to_numpy() > 0).mean() - 2 / 3) < 0.08


def test_ignores_prices_and_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4), "ETH-EUR": synth(600, 5)}
    full = FAM.targets(cd, spec(seed=11, meanIn=20, meanOut=10, mode="independent"))
    for k in (100, 400):
        t = FAM.targets({m: cd[m].iloc[: k + 1] for m in MK}, spec(seed=11, meanIn=20, meanOut=10, mode="independent"))
        for m in MK:
            np.testing.assert_array_equal(t[m].to_numpy(), full[m].to_numpy()[: k + 1])
    flat = bars([(10, 10, 10, 10)] * 600)
    other = FAM.targets({"BTC-EUR": flat, "ETH-EUR": flat}, spec(seed=11, meanIn=20, meanOut=10, mode="independent"))
    for m in MK:
        np.testing.assert_array_equal(other[m].to_numpy(), full[m].to_numpy())
