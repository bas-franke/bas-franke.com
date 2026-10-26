import random

import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.knn_analog_a05 import forecast_z

FAM = FAMILIES["knn_analog_a05"]


def spec(**params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "knn_analog_a05", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def test_contract_and_samples():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(2)
    cd = {"BTC-EUR": synth(700, 3)}
    for _ in range(6):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        v = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
        fin = v[np.isfinite(v)]
        assert set(np.unique(fin)) <= {0.0, 1.0}
    ex = FAM.explain(spec(coreSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_learns_a_repeating_pattern():
    # a deterministic cycle: 20 bars up, 20 bars down. Analogs of "early in the up leg" rose afterwards.
    n = 1200
    ph = np.arange(n) % 40
    step = np.where(ph < 20, 0.01, -0.01)
    c = 100 * np.exp(np.cumsum(step))
    p = {**FAM.default_params(), "horizon": 5, "k": 10, "look": 8, "volLen": 20, "minHist": 100,
         "features": "ret"}
    z = forecast_z(c + np.random.default_rng(0).normal(0, 1e-6, n), p)
    late = np.arange(n) > 600
    up_early = late & (ph >= 2) & (ph <= 12)
    dn_early = late & (ph >= 22) & (ph <= 32)
    assert np.nanmean(z[up_early]) > 1 and np.nanmean(z[dn_early]) < -1


def test_no_lookahead_prefix():
    cd = {"BTC-EUR": synth(600, 5)}
    sp = spec(horizon=5, k=10, look=8, volLen=20, minHist=100)
    full = FAM.targets(cd, sp)["BTC-EUR"].to_numpy()
    for k in (350, 500):
        t = FAM.targets({"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}, sp)["BTC-EUR"].to_numpy()
        np.testing.assert_array_equal(t, full[: k + 1])
