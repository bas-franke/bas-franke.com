import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["cusum_core_a20"]


def spec(**params):
    p = {"volLen": 10, "k": 0.0, "hIn": 3.0, "hOut": 3.0, "coreSma": 0, "combine": "or", **params}
    return normalize_spec({"family": "cusum_core_a20", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def noisy_path(seed=1):
    rng = np.random.default_rng(seed)
    flat = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, 40)))          # chop: sets sigma ~1 %
    up = flat[-1] * np.exp(np.cumsum(np.full(10, 0.02)))            # +2 sigma per bar
    down = up[-1] * np.exp(np.cumsum(np.full(10, -0.02)))
    return np.concatenate([flat, up, down])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "hIn": 0.1}})
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(600, 2)}
    for _ in range(10):
        v = FAM.targets(cd, spec(**FAM.sample(rng)))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
        assert set(np.unique(v[ok])) <= {0.0, 1.0}
    ex = FAM.explain(spec(coreSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_buys_a_rally_sells_a_selloff():
    c = noisy_path()
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(k=0.5))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:11]).all()
    assert w[44:50].max() == 1          # a few +2-sigma bars fire the up tally
    assert w[-1] == 0                   # the sell-off fires the down tally
    first_in = 40 + int(np.argmax(w[40:] == 1))
    assert first_in <= 43


def test_large_threshold_never_buys():
    c = noisy_path()
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(hIn=15.0, k=1.0))["BTC-EUR"].to_numpy()
    ok = np.isfinite(w)
    assert (w[ok] == 0).all()


def test_combine_with_sma():
    c = synth(400, 5)["close"].to_numpy()
    cd = {"BTC-EUR": closes(c)}
    cus = FAM.targets(cd, spec(volLen=20, hIn=4.0, hOut=4.0, k=0.3))["BTC-EUR"].to_numpy()
    o = FAM.targets(cd, spec(volLen=20, hIn=4.0, hOut=4.0, k=0.3, coreSma=30, combine="or"))["BTC-EUR"].to_numpy()
    a = FAM.targets(cd, spec(volLen=20, hIn=4.0, hOut=4.0, k=0.3, coreSma=30, combine="and"))["BTC-EUR"].to_numpy()
    sma = np.full(len(c), np.nan)
    sma[29:] = np.convolve(c, np.ones(30) / 30, mode="valid")
    core = (c > sma).astype(float)
    i = 40
    np.testing.assert_array_equal(o[i:], np.maximum(core[i:], cus[i:]))
    np.testing.assert_array_equal(a[i:], np.minimum(core[i:], cus[i:]))
