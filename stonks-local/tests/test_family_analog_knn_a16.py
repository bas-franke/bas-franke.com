import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["analog_knn_a16"]


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "analog_knn_a16", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "enter": 0.0, "exit": 0.01}})
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(1100, 2), "ETH-EUR": synth(1100, 3)}
    for _ in range(5):
        p = FAM.sample(rng)
        df = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **p))
        v = df.to_numpy()
        ok = np.isfinite(v).all(axis=1)
        assert ok.any() and np.isfinite(v[int(np.argmax(ok)):]).all()
        assert (v[np.isfinite(v)] <= 0.5 + 1e-12).all()
    ex = FAM.explain(spec(memory=500))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_learns_a_repeating_pattern():
    # a saw-tooth: 30 candles up, 30 down, repeated. After the first cycles the neighbours of a rising phase rose on.
    one = list(np.linspace(100, 130, 30)) + list(np.linspace(130, 100, 30))
    path = np.array(one * 14) * np.exp(np.linspace(0, 0.01, 30 * 28))
    p = dict(k=5, horizon=5, feats="mom", minLib=150, relative=False, enter=0.0, exit=0.0)
    w = FAM.targets({"BTC-EUR": closes(list(path))}, spec(**p))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:200]).all()
    tail = np.arange(len(path)) >= 420
    phase = np.arange(len(path)) % 60
    rising = tail & (phase >= 8) & (phase <= 22)
    falling = tail & (phase >= 38) & (phase <= 52)
    assert w[rising].mean() > 0.9 and w[falling].mean() < 0.1


def test_no_lookahead_truncation():
    cd = {"BTC-EUR": synth(800, 4)}
    s = spec(k=10, horizon=10, minLib=120, feats="trend")
    full = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
    assert np.isfinite(full).any()
    for cut in (400, 650):
        part = FAM.targets({"BTC-EUR": cd["BTC-EUR"].iloc[:cut]}, s)["BTC-EUR"].to_numpy()
        np.testing.assert_array_equal(part, full[:cut])
