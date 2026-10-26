import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["kelly_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {"muLen": 5, "volLen": 5, "frac": 1.0, "minStep": 0.0, **params}
    return normalize_spec({"family": "kelly_core", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(4)
    cd = {"BTC-EUR": synth(800, 2), "ETH-EUR": synth(800, 3, price=1500)}
    for _ in range(10):
        t = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **FAM.sample(rng))).to_numpy()
        ok = np.isfinite(t).all(axis=1)
        assert ok.any() and not np.isnan(t[int(np.argmax(ok)):]).any()
        assert (t[ok] >= 0).all() and (t[ok].sum(axis=1) <= 1 + 1e-12).all()
    ex = FAM.explain(spec(markets=("BTC-EUR", "ETH-EUR")))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_full_in_calm_uptrend_out_in_downtrend():
    up = [100 * 1.01 ** i * (1.002 if i % 2 else 0.998) for i in range(12)]
    down = [up[-1] * 0.97 ** (i + 1) * (1.002 if i % 2 else 0.998) for i in range(8)]
    w = FAM.targets({"BTC-EUR": closes(up + down)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:5]).all()
    assert (w[5:12] == 1).all()          # mean +1 %/bar, tiny variance: Kelly far above 1, capped
    assert (w[16:] == 0).all()           # mean negative: nothing


def test_choppy_gives_partial_and_minstep_holds():
    rng = np.random.default_rng(1)
    c = 100 * np.exp(np.cumsum(0.004 + rng.normal(0, 0.05, 300)))
    t = FAM.targets({"BTC-EUR": closes(list(c))}, spec(muLen=60, volLen=60, frac=0.5))["BTC-EUR"].to_numpy()
    v = t[np.isfinite(t)]
    assert ((v > 0) & (v < 1)).any()
    s = FAM.targets({"BTC-EUR": closes(list(c))}, spec(muLen=60, volLen=60, frac=0.5, minStep=0.3))["BTC-EUR"]
    s = s.to_numpy()[np.isfinite(t)]
    assert len(np.unique(s)) < len(np.unique(v))
