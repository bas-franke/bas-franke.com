import random

import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.volexit_a19 import run_state

FAM = FAMILIES["volexit_a19"]


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "volexit_a19", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(900, 2), "ETH-EUR": synth(900, 3)}
    for _ in range(8):
        p = FAM.sample(rng)
        df = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **p))
        v = df.to_numpy()
        ok = np.isfinite(v).all(axis=1)
        assert ok.any() and np.isfinite(v[int(np.argmax(ok)):]).all()
        assert (v[np.isfinite(v)] <= 0.5 + 1e-12).all()
    assert len(FAM.explain(spec(maxBelow=10))["howItWorks"]) >= 3


def test_sells_only_on_heavy_turnover():
    close = np.array([10, 11, 12, 9, 9, 9, 13, 9, 9], dtype=float)
    sma = np.full(9, 10.0)
    ratio = np.array([1, 1, 1, 0.8, 0.9, 2.0, 1, 1.0, 1.0])
    w = run_state(close, sma, ratio, 1.5, 0)
    # in at 0 (10 > 10? no) -> out; in at 1,2; quiet dip 3,4 stays in; heavy at 5 sells; back in at 6;
    assert list(w) == [0, 1, 1, 1, 1, 0, 1, 1, 1]


def test_plain_core_and_fail_safe():
    close = np.array([11, 9, 9, 9, 11, 9], dtype=float)
    sma = np.full(6, 10.0)
    ratio = np.full(6, 0.5)
    assert list(run_state(close, sma, ratio, 0.0, 0)) == [1, 0, 0, 0, 1, 0]
    assert list(run_state(close, sma, ratio, 1.5, 2)) == [1, 1, 0, 0, 1, 1]
