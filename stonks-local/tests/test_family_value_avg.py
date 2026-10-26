import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["value_avg"]


def spec(**params):
    return normalize_spec({"family": "value_avg", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def rows(xs):
    return {"BTC-EUR": bars([(x, x * 1.01, x * 0.99, x) for x in xs])}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(2)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(r)}) is None
    ex = FAM.explain(spec(allowSell=True, growth=0.01))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_flat_price_is_dca_then_full():
    w = FAM.targets(rows([100.0] * 10), spec(everyBars=2, tranches=4))["BTC-EUR"].to_numpy()
    np.testing.assert_allclose(w[[0, 1, 2, 4]], [0.25, 0.25, 0.5, 0.75])
    assert w[6] == 1.0 and w[9] == 1.0


def test_buys_more_after_drop_and_sells_excess():
    xs = [100.0, 50.0, 50.0]
    w = FAM.targets(rows(xs), spec(everyBars=1, tranches=4))["BTC-EUR"].to_numpy()
    # step 1 buys 0.25; price halves -> holding 0.125, target 0.5 -> buys 0.375; total 0.875, value 0.5
    assert abs(w[1] - 0.5 / 0.875) < 1e-12
    up = FAM.targets(rows([100.0, 400.0]), spec(everyBars=1, tranches=4, allowSell=True))["BTC-EUR"].to_numpy()
    # holding 0.25 -> 1.0 at x4, target 0.5 -> sells half; value 0.5 of total 1.75
    assert abs(up[1] - 0.5 / 1.75) < 1e-12


def test_anchor():
    cd = rows([100.0] * 10)
    t = int(cd["BTC-EUR"].index[4])
    w = FAM.targets(cd, spec(everyBars=1, tranches=2), start_time=t)["BTC-EUR"].to_numpy()
    assert np.isnan(w[3]) and w[4] == 0.5 and w[5] == 1.0


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    for s in (spec(everyBars=5, tranches=20, growth=0.02, allowSell=True), spec(everyBars=30, tranches=6)):
        full = FAM.targets(cd, s).to_numpy()
        for k in (120, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
