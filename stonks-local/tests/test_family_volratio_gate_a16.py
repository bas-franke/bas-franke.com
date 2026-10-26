import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["volratio_gate_a16"]


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "volratio_gate_a16", "markets": list(markets), "interval": "1d", "params": p},
                          FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def zigzag(n, amp, seed):
    rng = np.random.default_rng(seed)
    r = rng.choice([-1.0, 1.0], size=n) * amp
    return 100 * np.exp(np.cumsum(r))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "enterZ": 2.0, "exitZ": 1.0}})
    rng = random.Random(9)
    cd = {"BTC-EUR": synth(1200, 2), "ETH-EUR": synth(1200, 3)}
    for _ in range(8):
        p = FAM.sample(rng)
        df = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **p))
        v = df.to_numpy()
        ok = np.isfinite(v).all(axis=1)
        assert ok.any() and np.isfinite(v[int(np.argmax(ok)):]).all()
        assert (v[np.isfinite(v)] <= 0.5 + 1e-12).all()
    assert FAM.explain(spec(coreLen=50))["summary"]


def test_steps_out_when_eth_turns_wild():
    n = 300
    b = zigzag(n, 0.01, 1)
    e_amp = np.where(np.arange(n) < 250, 0.015, 0.06)       # ETH gets 4x wilder from bar 250
    rng = np.random.default_rng(2)
    e = 100 * np.exp(np.cumsum(rng.choice([-1.0, 1.0], size=n) * e_amp))
    cd = {"BTC-EUR": closes(list(b)), "ETH-EUR": closes(list(e))}
    p = dict(volLen=10, zLen=100, side="abs", exitZ=1.5, enterZ=1.0)
    w = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:100]).all()
    assert w[150:249].mean() > 0.8
    assert (w[256:262] == 0).all()
    w_low = FAM.targets(cd, spec(**{**p, "side": "low"}))["BTC-EUR"].to_numpy()
    assert (w_low[256:262] == 1).all()                        # only BTC-heavy abnormality counts
    w_or = FAM.targets(cd, spec(**{**p, "coreLen": 3, "combine": "or"}))["BTC-EUR"].to_numpy()
    assert (w_or[256:262] >= w[256:262]).all()


def test_no_lookahead_truncation():
    cd = {"BTC-EUR": synth(700, 4), "ETH-EUR": synth(700, 5)}
    s = spec(markets=("BTC-EUR", "ETH-EUR"), volLen=20, zLen=120, exitZ=1.0, enterZ=0.5)
    full = FAM.targets(cd, s).to_numpy()
    assert np.isfinite(full).any()
    for cut in (300, 555):
        part = FAM.targets({k: v.iloc[:cut] for k, v in cd.items()}, s).to_numpy()
        np.testing.assert_array_equal(part, full[:cut])
