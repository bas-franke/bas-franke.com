import random

import numpy as np
import pandas as pd

from _engine_util import T0, H4, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["dist_days"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "dist_days", "markets": list(markets), "interval": "1d", "params": params}, FAM)


def candles(closes, vols):
    c = np.asarray(closes, dtype=np.float64)
    o = np.concatenate([[c[0]], c[:-1]])
    return pd.DataFrame({"open": o, "high": np.maximum(o, c) * 1.001, "low": np.minimum(o, c) * 0.999, "close": c,
                         "volume": np.asarray(vols, dtype=np.float64)},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


BASE = dict(distRet=0.02, volRule="prev", volMult=1.0, window=10, maxDist=2, expireGain=0.0, ftdDay=3,
            ftdRet=0.03, reenterSma=0)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(7)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(r)}) is None
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def _path():
    closes = [100.0] * 60
    vols = [10.0] * 60
    # two distribution days (-3 % on rising volume) -> sell at the second
    closes += [97.0, 97.0, 94.09]
    vols += [20.0, 10.0, 20.0]
    # drift lower to a low, then up days; the 4th day after the low is +4 % on rising volume -> buy
    closes += [93.0, 92.0, 92.5, 93.0, 93.2, 96.93]
    vols += [10.0, 10.0, 10.0, 10.0, 10.0, 30.0]
    return closes, vols


def test_sells_on_distribution_and_buys_on_follow_through():
    closes, vols = _path()
    w = FAM.targets({"BTC-EUR": candles(closes, vols)}, spec(**BASE))["BTC-EUR"].to_numpy()
    assert w[59] == 1.0 and w[60] == 1.0 and w[61] == 1.0     # held by default, one distribution day only
    assert w[62] == 0.0                                       # second distribution day: out
    assert (w[63:68] == 0.0).all()
    assert w[68] == 1.0                                       # follow-through day


def test_no_volume_no_distribution():
    closes, vols = _path()
    vols = [10.0] * len(vols)
    w = FAM.targets({"BTC-EUR": candles(closes, vols)}, spec(**BASE))["BTC-EUR"].to_numpy()
    assert (w[60:] == 1.0).all()


def test_two_markets_split_weight():
    closes, vols = _path()
    cd = {"BTC-EUR": candles(closes, vols), "ETH-EUR": candles(closes, vols)}
    w = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), **BASE))
    assert w["BTC-EUR"].to_numpy()[60] == 0.5 and w["ETH-EUR"].to_numpy()[62] == 0.0


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.0003, vol=0.03)}
    cd["BTC-EUR"]["volume"] = np.random.default_rng(2).lognormal(0, 0.5, 600)
    for s in (spec(**BASE), spec(**{**BASE, "volRule": "avg", "volMult": 1.2, "expireGain": 0.05, "reenterSma": 40})):
        full = FAM.targets(cd, s).to_numpy()
        for k in (150, 400):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
