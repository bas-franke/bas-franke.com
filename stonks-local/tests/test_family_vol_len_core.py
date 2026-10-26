import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["vol_len_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), "fastLen": 2, "slowLen": 10, "volLen": 2, "rankLen": 3, "volQ": 0.8, **params}
    return normalize_spec({"family": "vol_len_core", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(cs):
    return bars([(c, c, c, c) for c in cs])


# a calm steady rise, then one sharp drop that lands under the fast SMA but above the slow one
PATH = [100.0 + i for i in range(20)] + [117.0]


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "fastLen": 200, "slowLen": 100}})
    rng = random.Random(17)
    cd = {"BTC-EUR": synth(1500, 2), "ETH-EUR": synth(1500, 3)}
    for _ in range(10):
        p = FAM.sample(rng)
        df = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **p))
        v = df.to_numpy()
        ok = np.isfinite(v).all(axis=1)
        assert ok.any() and np.isfinite(v[int(np.argmax(ok)):]).all()
        assert (v[np.isfinite(v)] <= 0.5 + 1e-12).all()
    ex = FAM.explain(spec(band=0.01, mode="hi_slow"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_turbulence_switches_the_average():
    w = FAM.targets({"BTC-EUR": closes(PATH)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:9]).all() and (w[9:20] == 1).all()
    assert w[20] == 0           # hi_fast: the drop spikes vol -> SMA2 (118) -> out
    w = FAM.targets({"BTC-EUR": closes(PATH)}, spec(mode="hi_slow"))["BTC-EUR"].to_numpy()
    assert (w[9:] == 1).all()   # hi_slow: turbulent -> SMA10 (115.2) -> stay in


def test_band_hysteresis():
    w = FAM.targets({"BTC-EUR": closes(PATH)}, spec(band=0.02))["BTC-EUR"].to_numpy()
    assert w[20] == 1           # 117 is within 2 % of 118: no sell


def test_no_lookahead():
    rng = np.random.default_rng(4)
    cd = {"BTC-EUR": synth(1400, 1), "ETH-EUR": synth(1400, 2, price=1500)}
    for params in ({"fastLen": 20, "slowLen": 100, "volLen": 20, "rankLen": 200},
                   {"fastLen": 30, "slowLen": 60, "volLen": 10, "rankLen": 300, "mode": "hi_slow", "band": 0.02}):
        s = spec(markets=("BTC-EUR", "ETH-EUR"), **params)
        full = FAM.targets(cd, s).to_numpy()
        assert np.isfinite(full).any()
        for k in (450, 900):
            trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
            pert = {}
            for m, df in cd.items():
                d = df.copy()
                f = rng.uniform(0.3, 3.0, len(d) - k - 1)
                for col in ("open", "high", "low", "close"):
                    x = d[col].to_numpy().copy()
                    x[k + 1:] *= f
                    d[col] = x
                pert[m] = d
            np.testing.assert_array_equal(FAM.targets(pert, s).to_numpy()[: k + 1], full[: k + 1])
