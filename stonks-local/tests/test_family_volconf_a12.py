import random

import numpy as np
import pandas as pd

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["volconf_a12"]
T0 = 1_600_000_000_000
D = 86_400_000


def spec(markets=("BTC-EUR",), **params):
    base = FAM.default_params()
    base.update(params)
    return normalize_spec({"family": "volconf_a12", "markets": list(markets), "interval": "1d", "params": base}, FAM)


def frame(closes, vols):
    c = np.asarray(closes, dtype=np.float64)
    return {"BTC-EUR": pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.asarray(vols, float)},
                                    index=pd.Index(T0 + D * np.arange(len(c), dtype=np.int64), name="ts"))}


def noise_path(n, seed):
    r = np.random.default_rng(seed)
    return list(100 * np.exp(np.cumsum(r.normal(0, 0.01, n)))), list(np.exp(r.normal(0, 0.1, n)) * 10)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    for _ in range(30):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None or FAM.valid_params(p)
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_high_volume_rise_buys_low_volume_rise_does_not():
    c, v = noise_path(80, 1)
    # a jump on 5x volume vs the same jump on 0.2x volume
    up = c[-1] * np.exp(np.cumsum([0.04] * 3))
    hi = FAM.targets(frame(c + list(up), v + [50.0] * 3), spec(volLen=20, sumLen=3, enter=0.3, band=0.1))
    lo = FAM.targets(frame(c + list(up), v + [2.0] * 3), spec(volLen=20, sumLen=3, enter=0.3, band=0.1))
    assert hi["BTC-EUR"].iloc[-1] == 1.0
    assert lo["BTC-EUR"].iloc[-1] == 0.0
    # the plain-momentum twin buys either way
    tw = FAM.targets(frame(c + list(up), v + [2.0] * 3),
                     spec(volLen=20, sumLen=3, enter=0.3, band=0.1, weighting="none"))
    assert tw["BTC-EUR"].iloc[-1] == 1.0


def test_core_combine():
    c = list(np.linspace(100, 300, 120))
    v = [10.0] * 120
    s_or = spec(volLen=20, sumLen=5, enter=0.4, band=0.1, coreSma=20, combine="or")
    s_and = spec(volLen=20, sumLen=5, enter=0.4, band=0.1, coreSma=20, combine="and")
    assert FAM.targets(frame(c, v), s_or)["BTC-EUR"].iloc[-1] == 1.0     # core on (rising), signal flat
    assert FAM.targets(frame(c, v), s_and)["BTC-EUR"].iloc[-1] == 0.0
    assert FAM.valid_params({**FAM.default_params(), "combine": "or"})


def test_no_lookahead():
    cd = {"BTC-EUR": synth(500, 4, drift=0.0005)}
    for s in (spec(volLen=30, sumLen=10), spec(volLen=15, sumLen=3, weighting="none", coreSma=50, combine="or")):
        full = FAM.targets(cd, s).to_numpy()
        for k in (150, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
