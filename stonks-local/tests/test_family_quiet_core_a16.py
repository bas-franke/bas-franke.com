import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["quiet_core_a16"]


def spec(**params):
    p = {"coreLen": 5, "volLen": 3, "rankLen": 20, "quietQ": 0.4, "exitQ": 0.0, "side": "low", **params}
    return normalize_spec({"family": "quiet_core_a16", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


# 0-29 turbulent chop, 30-39 a calm slide below the SMA, 40-44 a turbulent crash
PATH = [100.0 if i % 2 == 0 else 106.0 for i in range(30)] + [103.0 - 0.1 * k for k in range(10)] \
    + [95.0, 99.0, 88.0, 94.0, 82.0]


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "quietQ": 0.4, "exitQ": 0.2}})
    rng = random.Random(5)
    cd = {"BTC-EUR": synth(1500, 2)}
    for _ in range(6):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        s = spec(**p)
        s["risk"]["maxWeight"] = 0.7
        v = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
        ok = ~np.isnan(v)
        if ok.any():
            first = int(np.argmax(ok))
            assert ok[first:].all() and set(np.unique(v[first:])) <= {0.0, 0.7}
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_holds_calm_slide_and_exits_turbulent_crash():
    w = FAM.targets({"BTC-EUR": closes(PATH)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:23]).all() and not np.isnan(w[23:]).any()  # volLen + rankLen warm-up
    # the calm slide (from bar 33 on: vol window fully inside it) is below the SMA but held
    sm = np.convolve(PATH, np.ones(5) / 5, mode="valid")
    assert all(PATH[i] < sm[i - 4] for i in range(34, 40))
    assert (w[33:40] == 1).all()
    # the crash: below the SMA and turbulent -> out
    assert (w[41:45] == 0).all()
    # plain core stays out in the slide; the turbulent mirror is out in the slide and in during the crash
    off = FAM.targets({"BTC-EUR": closes(PATH)}, spec(side="off"))["BTC-EUR"].to_numpy()
    assert (off[34:40] == 0).all()
    hi = FAM.targets({"BTC-EUR": closes(PATH)}, spec(side="high"))["BTC-EUR"].to_numpy()
    assert (hi[34:40] == 0).all() and (hi[42:45] == 1).all()


def test_no_lookahead_on_prefix():
    cd = {"BTC-EUR": synth(600, 4)}
    full = FAM.targets(cd, spec(coreLen=20, volLen=10, rankLen=100))["BTC-EUR"].to_numpy()
    cut = {"BTC-EUR": cd["BTC-EUR"].iloc[:400]}
    part = FAM.targets(cut, spec(coreLen=20, volLen=10, rankLen=100))["BTC-EUR"].to_numpy()
    np.testing.assert_array_equal(full[:400], part)
