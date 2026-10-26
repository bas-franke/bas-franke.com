import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.placebo_timing import random_state

FAM = FAMILIES["placebo_duo_a07"]
D1 = 86_400_000
T0 = 1_600_000_000_000 - (1_600_000_000_000 % D1)


def spec(mode="joint", seed=3, mi=40, mo=20, mw=1.0):
    return normalize_spec({"family": "placebo_duo_a07", "markets": ["BTC-EUR", "ETH-EUR"], "interval": "1d",
                           "params": {"seed": seed, "meanIn": mi, "meanOut": mo, "mode": mode},
                           "risk": {"maxWeight": mw}}, FAM)


def candles(n=900):
    return {"BTC-EUR": synth(n, 1, start=T0, step=D1), "ETH-EUR": synth(n, 2, start=T0, step=D1, price=1500)}


def test_joint_follows_one_path_and_splits_equally():
    cd = candles()
    t = FAM.targets(cd, spec("joint"))
    st = random_state(len(t), 3, 40, 20)
    assert np.allclose(t["BTC-EUR"].to_numpy(), st * 0.5) and np.allclose(t["ETH-EUR"].to_numpy(), st * 0.5)
    assert 0.5 < st.mean() < 0.85 and (np.diff(st) != 0).sum() > 10
    t2 = FAM.targets(cd, spec("joint", mw=0.6)).to_numpy()
    assert t2.sum(axis=1).max() <= 0.6 + 1e-12


def test_independent_paths_differ_and_ignore_prices():
    cd = candles()
    t = FAM.targets(cd, spec("independent")).to_numpy()
    assert not np.array_equal(t[:, 0], t[:, 1])
    flipped = {m: d.assign(close=d["close"][::-1].to_numpy()) for m, d in cd.items()}
    assert np.array_equal(FAM.targets(flipped, spec("independent")).to_numpy(), t)
    part = FAM.targets({m: d.iloc[:500] for m, d in cd.items()}, spec("independent")).to_numpy()
    assert np.array_equal(part, t[:500])
    assert len(FAM.explain(spec())["howItWorks"]) >= 2
