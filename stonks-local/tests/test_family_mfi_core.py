import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.mfi_core import mfi

FAM = FAMILIES["mfi_core"]


def spec(**params):
    base = {"osc": "mfi", "oscLen": 5, "below": 20.0, "sellAbove": 70.0, "maxHold": 0, "coreSma": 0}
    return normalize_spec({"family": "mfi_core", "markets": ["BTC-EUR"], "interval": "1d",
                           "params": {**base, **params}}, FAM)


def cd(xs, vols):
    df = bars([(x, x + 1, x - 1, x) for x in xs])
    df["volume"] = np.asarray(vols, float)
    return {"BTC-EUR": df}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "below": 80.0, "sellAbove": 70.0}}) is not None
    r = random.Random(3)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(r)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 2


def test_mfi_values():
    xs = [100, 101, 102, 101, 103, 104]
    m = mfi(np.array(xs) + 1, np.array(xs) - 1, np.array(xs, float), np.ones(6), 3)
    assert np.isnan(m[:3]).all()
    # window bars 1..3: up 101, up 102, down 101 -> 100*(101+102)/(101+102+101)
    assert abs(m[3] - 100 * 203 / 304) < 1e-9
    assert mfi(np.ones(5), np.ones(5), np.ones(5), np.zeros(5), 2)[4] == 50.0


def test_buys_panic_and_sells_on_recovery():
    xs = [100.0] * 3 + [100 + i for i in range(1, 6)] + [104, 100, 96, 92, 88] + [90, 94, 98, 102, 106, 110]
    w = FAM.targets(cd(xs, [1.0] * len(xs)), spec())["BTC-EUR"].to_numpy()
    assert w[7] == 0.0                     # rising: no panic, no core
    assert w[13] == 1.0                    # five falling closes: MFI 0 -> buys
    assert w[-1] == 0.0                    # MFI back above 70 -> sold


def test_volume_matters_for_mfi_not_rsi():
    # same prices; the down bars come with near-zero volume, so money flow never looks like panic
    xs = [100.0] * 3 + [100 + i for i in range(1, 6)] + [104, 103.5, 103, 102.5, 102, 101.5]
    vol = [1.0] * 9 + [1e-6] * 5
    mf = FAM.targets(cd(xs, vol), spec(below=20.0, oscLen=8))["BTC-EUR"].to_numpy()
    rs = FAM.targets(cd(xs, vol), spec(osc="rsi", below=45.0, oscLen=3))["BTC-EUR"].to_numpy()
    assert mf[-1] == 0.0
    assert rs[-1] == 1.0


def test_no_lookahead():
    data = {"BTC-EUR": synth(600, 4, drift=0.0005)}
    data["BTC-EUR"]["volume"] = np.random.default_rng(1).uniform(0.5, 2.0, 600)
    for s in (spec(osc="mfi", oscLen=14, below=30.0, sellAbove=75.0, maxHold=40, coreSma=50),
              spec(osc="rsi", oscLen=10, below=35.0, sellAbove=70.0, maxHold=0, coreSma=0)):
        full = FAM.targets(data, s).to_numpy()
        for k in (60, 300, 450):
            trunc = {"BTC-EUR": data["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
            d = data["BTC-EUR"].copy()
            f = np.random.default_rng(k).uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close", "volume"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            np.testing.assert_array_equal(FAM.targets({"BTC-EUR": d}, s).to_numpy()[: k + 1], full[: k + 1])
