import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["fib_dip_a20"]


def spec(**params):
    p = {"swingLook": 6, "legLook": 6, "minLeg": 0.3, "fib": 0.5, "stopFib": 1.0, "targetFib": 0.0,
         "takeTarget": True, "maxHold": 0, "coreSma": 0, "coreMode": "or", **params}
    return normalize_spec({"family": "fib_dip_a20", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "stopFib": 0.6, "fib": 0.6}})
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(800, 2)}
    for _ in range(15):
        p = FAM.sample(rng)
        v = FAM.targets(cd, spec(**p))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
        assert set(np.unique(v[ok])) <= {0.0, 1.0}
    ex = FAM.explain(spec(coreSma=20))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_buys_the_half_retracement_and_sells_at_the_old_high():
    # rally 10 -> 20, pull back to 15 (= 50 % of the leg), run back to 20
    path = [10] * 5 + [12, 14, 16, 18, 20, 18, 16, 15, 16, 18, 20, 21]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:10]).all()
    assert list(w[10:12]) == [0, 0]
    assert w[12] == 1                     # close 15 <= 20 - 0.5*10
    assert w[13] == 1 and w[14] == 1
    assert w[15] == 0                     # back at the old high: target reached
    assert w[16] == 0


def test_stop_below_the_leg_low():
    path = [10] * 5 + [12, 14, 16, 18, 20, 18, 16, 15, 12, 9.5, 9, 9]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert w[12] == 1 and w[13] == 1
    assert list(w[14:]) == [0, 0, 0]      # 9.5 < leg low 10: the rally failed, no second trade on that high


def test_or_core_and_gate():
    path = list(np.linspace(10, 30, 40)) + [25, 22, 20]
    or_w = FAM.targets({"BTC-EUR": closes(path)}, spec(coreSma=5, coreMode="or"))["BTC-EUR"].to_numpy()
    assert (or_w[12:40] == 1).all()       # steady rise: the core holds
    gate = FAM.targets({"BTC-EUR": closes(path)}, spec(coreSma=5, coreMode="gate"))["BTC-EUR"].to_numpy()
    assert (gate[np.isfinite(gate)] == 0).all()   # no 30 % pullback inside an uptrend: no dip trades
