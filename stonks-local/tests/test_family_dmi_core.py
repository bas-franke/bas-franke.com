import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.dmi_core import dmi

FAM = FAMILIES["dmi_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {"dmiLen": 3, "entryAdx": 0, "exitAdx": 0, "diBand": 0.0, **params}
    return normalize_spec({"family": "dmi_core", "markets": list(markets), "interval": "4h", "params": p}, FAM)


def path(c):
    c = np.asarray(c, dtype=np.float64)
    return bars([(x, x * 1.01, x * 0.99, x) for x in c])


UP = list(100 * 1.02 ** np.arange(20))
DOWN = list(UP[-1] * 0.97 ** np.arange(1, 21))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(4)
    cd = {m: synth(600, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for _ in range(12):
        s = spec(["BTC-EUR", "ETH-EUR"], **FAM.sample(rng))
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    ex = FAM.explain(spec(entryAdx=20, exitAdx=25, diBand=2))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_dmi_directions():
    d = path(UP + DOWN)
    pdi, mdi, adx = dmi(d["high"].to_numpy(), d["low"].to_numpy(), d["close"].to_numpy(), 3)
    assert pdi[15] > mdi[15] and mdi[-1] > pdi[-1]
    assert np.isnan(adx[3]) and np.isfinite(adx[-1]) and adx[-1] > 50


def test_buys_uptrend_sells_downtrend():
    w = FAM.targets({"BTC-EUR": path(UP + DOWN)}, spec())["BTC-EUR"].to_numpy()
    f = int(np.argmax(~np.isnan(w)))
    assert w[f] == 1 and w[19] == 1 and w[-1] == 0


def test_exit_adx_gate_holds_weak_downturn():
    # long uptrend then a shallow sideways drift: -DI leads but ADX is falling low -> high exit gate keeps holding
    side = [UP[-1] * (1 - 0.002 * k) * (1.004 if k % 2 else 0.996) for k in range(1, 15)]
    d = {"BTC-EUR": path(UP + side)}
    loose = FAM.targets(d, spec())["BTC-EUR"].to_numpy()
    strict = FAM.targets(d, spec(exitAdx=45))["BTC-EUR"].to_numpy()
    assert loose[-1] == 0 or (loose[20:] == 0).any()
    assert strict[-1] == 1


def test_no_lookahead_prefix():
    c = synth(300, 7)
    full = FAM.targets({"BTC-EUR": c}, spec(dmiLen=10, exitAdx=20))["BTC-EUR"].to_numpy()
    part = FAM.targets({"BTC-EUR": c.iloc[:200]}, spec(dmiLen=10, exitAdx=20))["BTC-EUR"].to_numpy()
    np.testing.assert_array_equal(full[:200], part)
