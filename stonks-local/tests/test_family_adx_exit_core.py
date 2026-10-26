import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["adx_exit_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {"coreSma": 5, "dmiLen": 3, "exitAdx": 0, "dirConfirm": True, "hardStop": 0, **params}
    return normalize_spec({"family": "adx_exit_core", "markets": list(markets), "interval": "4h", "params": p}, FAM)


def path(c):
    return bars([(x, x * 1.01, x * 0.99, x) for x in np.asarray(c, dtype=np.float64)])


UP = list(100 * 1.02 ** np.arange(20))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(8)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for _ in range(12):
        s = spec(["BTC-EUR", "ETH-EUR"], **FAM.sample(rng))
        s["risk"]["maxWeight"] = 0.5
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.5 + 1e-12).all()
    ex = FAM.explain(spec(exitAdx=25, hardStop=0.1))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_plain_core_when_gate_off():
    down = list(UP[-1] * 0.97 ** np.arange(1, 10))
    w = FAM.targets({"BTC-EUR": path(UP + down)}, spec())["BTC-EUR"].to_numpy()
    c = np.array(UP + down)
    s = np.convolve(c, np.ones(5) / 5, "valid")
    f = int(np.argmax(~np.isnan(w)))
    assert w[f] == 1 and w[-1] == 0
    assert np.array_equal(w[f:], (c[f:] > s[f - 4:]).astype(float))


def test_quiet_dip_held_strong_drop_sold():
    # up, then a quiet sideways wobble just under the average: gated core holds, plain core sells
    wob = [UP[-1] * (0.99 + 0.006 * (k % 2)) for k in range(10)] + [UP[-1] * 0.975]  # last ADX ~33
    d = {"BTC-EUR": path(UP + wob)}
    plain = FAM.targets(d, spec())["BTC-EUR"].to_numpy()
    gated = FAM.targets(d, spec(exitAdx=45))["BTC-EUR"].to_numpy()
    assert plain[-1] == 0 and gated[-1] == 1
    stop = FAM.targets(d, spec(exitAdx=45, hardStop=0.01))["BTC-EUR"].to_numpy()
    assert stop[-1] == 0


def test_no_lookahead_prefix():
    c = synth(300, 3)
    full = FAM.targets({"BTC-EUR": c}, spec(coreSma=30, dmiLen=10, exitAdx=20))["BTC-EUR"].to_numpy()
    part = FAM.targets({"BTC-EUR": c.iloc[:180]}, spec(coreSma=30, dmiLen=10, exitAdx=20))["BTC-EUR"].to_numpy()
    np.testing.assert_array_equal(full[:180], part)
