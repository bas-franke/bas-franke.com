import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["leader_bag_a17"]
DAY = 86_400_000


def candles(n=1300, seed=1):
    rng = np.random.default_rng(seed)
    cd = {"BTC-EUR": synth(n, seed, step=DAY, vol=0.035, price=8000.0),
          "ETH-EUR": synth(n, seed + 1, step=DAY, vol=0.045, price=200.0)}
    for df in cd.values():
        df["volume"] = rng.lognormal(0, 0.7, len(df))
    return cd


def spec(**params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "leader_bag_a17", "markets": ["BTC-EUR", "ETH-EUR"], "interval": "1d",
                           "params": p}, FAM)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"duo": False, "panic": False, "beta": False, "split": False}})
    cd = candles()
    t = FAM.targets(cd, spec())
    v = t.to_numpy()
    ok = np.isfinite(v).all(axis=1)
    assert ok.any() and np.isfinite(v[int(np.argmax(ok)):]).all()
    assert (v[ok] >= 0).all() and (v[ok].sum(axis=1) <= 1 + 1e-9).all()
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_single_member_reproduces_the_member_and_bag_is_the_mean():
    cd = candles()
    duo = FAMILIES["duo_core"]
    d = duo.targets(cd, normalize_spec({"family": "duo_core", "markets": ["BTC-EUR", "ETH-EUR"], "interval": "1d",
                                        "params": {**duo.default_params(), **FAM.module.DUO}}, duo)).to_numpy()
    only = FAM.targets(cd, spec(panic=False, beta=False, split=False)).to_numpy()
    ok = np.isfinite(d).all(axis=1) & np.isfinite(only).all(axis=1)
    assert ok.sum() > 300
    np.testing.assert_allclose(only[ok], d[ok])
    singles = [FAM.targets(cd, spec(**{k: k == m for k in FAM.module.MEMBERS})).to_numpy()
               for m in FAM.module.MEMBERS]
    bag = FAM.targets(cd, spec()).to_numpy()
    ok = np.isfinite(bag).all(axis=1)
    np.testing.assert_allclose(bag[ok], np.mean(singles, axis=0)[ok])
    # maxWeight scales the bag
    s = spec()
    s["risk"]["maxWeight"] = 0.5
    np.testing.assert_allclose(FAM.targets(cd, s).to_numpy()[ok], 0.5 * bag[ok])


def test_no_lookahead():
    cd = candles(1300, 3)
    s = spec()
    full = FAM.targets(cd, s).to_numpy()
    rng = np.random.default_rng(6)
    for k in (800, 1100):
        trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
        pert = {}
        for m, df in cd.items():
            d = df.copy()
            f = rng.uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            x = d["volume"].to_numpy().copy()
            x[k + 1:] *= rng.uniform(0.1, 10.0, len(d) - k - 1)
            d["volume"] = x
            pert[m] = d
        np.testing.assert_array_equal(FAM.targets(pert, s).to_numpy()[: k + 1], full[: k + 1])
