import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["pyramid_core"]


def spec(**params):
    return normalize_spec({"family": "pyramid_core", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def rows(xs):
    return {"BTC-EUR": bars([(x, x * 1.01, x * 0.99, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(2)
    assert all(FAM.validate({"params": FAM.sample(r)}) is None for _ in range(40))
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_pyramids_up_then_sells():
    xs = [100.0] * 10 + [100.0 * 1.05 ** i for i in range(1, 11)] + [60.0, 55.0]
    w = FAM.targets(rows(xs), spec(coreLen=5, first=0.4, tranches=4, step=0.1))["BTC-EUR"].to_numpy()
    assert np.isnan(w[3])
    assert w[9] == 0.0                     # flat price: not above the SMA
    assert abs(w[10] - 0.4) < 1e-12        # first tranche
    assert abs(w[11] - 0.4) < 1e-12        # +5 % < step
    assert abs(w[12] - 0.6) < 1e-12        # +10.25 % >= step: add 0.2
    assert abs(w[19] - 1.0) < 1e-12        # full after 4 buys
    assert w[-1] == 0.0


def test_first_one_is_plain_core():
    xs = list(np.linspace(100, 200, 30)) + list(np.linspace(200, 120, 20))
    w = FAM.targets(rows(xs), spec(coreLen=10, first=1.0, tranches=2))["BTC-EUR"].to_numpy()
    c = np.asarray(xs)
    for i in range(10, len(xs)):
        assert w[i] == (1.0 if c[i] > c[i - 9:i + 1].mean() else 0.0)


def test_no_lookahead():
    cd = {"BTC-EUR": synth(500, 7, drift=0.0008)}
    s = spec(coreLen=40, first=0.3, tranches=4, step=0.05, enterBand=0.01, exitBand=0.02)
    full = FAM.targets(cd, s).to_numpy()
    for k in (100, 350):
        trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
