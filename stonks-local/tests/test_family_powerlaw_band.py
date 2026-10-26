import random

import numpy as np
import pandas as pd

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.powerlaw_band import zscores

FAM = FAMILIES["powerlaw_band"]
DAY = 86_400_000
T2019 = 1_552_000_000_000  # 2019-03-08


def spec(**params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "powerlaw_band", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def candles(c):
    c = np.asarray(c, dtype=np.float64)
    return {"BTC-EUR": pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.ones(len(c))},
                                    index=pd.Index(T2019 + DAY * np.arange(len(c), dtype=np.int64), name="ts"))}


def law(n, slope=5.0):
    days = (T2019 - pd.Timestamp("2009-01-03").value // 1_000_000) / DAY + np.arange(n)
    return 1e-10 * days ** slope


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready
    assert FAM.validate({"params": {**FAM.default_params(), "richZ": 0, "cheapZ": 0}}) is not None
    rng = random.Random(5)
    cd = {"BTC-EUR": synth(900, 2, start=T2019, step=DAY)}
    for _ in range(30):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        for mw in (1.0, 0.5):
            s = spec(**p)
            s["risk"]["maxWeight"] = mw
            v = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
            first = FAM.warmup(p)
            assert np.isnan(v[:first]).all()
            if first < len(v):
                assert not np.isnan(v[first:]).any() and set(np.unique(v[first:])) <= {0.0, mw}
    ex = FAM.explain(spec(cheapZ=-1.5, coreSma=100))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_zscore_on_the_line_and_bubble():
    n = 600
    c = law(n) * np.exp(0.05 * np.sin(np.arange(n) / 9))
    c[500:530] *= np.linspace(1, 3, 30)  # a bubble 3x above the line
    for slope in (0.0, 5.0):
        z = zscores("BTC-EUR", candles(c)["BTC-EUR"].index, c, slope, 200)
        assert np.isnan(z[:199]).all() and np.isfinite(z[199:]).all()
        assert abs(z[400]) < 2.0 and z[528] > 3.0


def test_rich_exit_and_cheap_hold():
    n = 700
    c = law(n) * np.exp(0.05 * np.sin(np.arange(n) / 9))
    c[500:530] *= np.linspace(1, 3, 30)
    c[530:560] *= np.linspace(3, 1, 30)
    c[600:640] *= np.linspace(1, 0.3, 40)  # a crash far under the line
    c[640:] *= 0.3
    w = FAM.targets(candles(c), spec(richZ=2.5, band=0.5))["BTC-EUR"].to_numpy()
    assert (w[364:500] == 1).all() and w[528] == 0 and w[-1] == 1
    w2 = FAM.targets(candles(c), spec(richZ=0, cheapZ=-2.0, band=0.3, coreSma=50))["BTC-EUR"].to_numpy()
    assert w2[650] == 1.0      # under its 50-day average, but far under the line: cheap, holds
    w3 = FAM.targets(candles(c), spec(richZ=4.0, cheapZ=0, band=0.3, coreSma=50))["BTC-EUR"].to_numpy()
    assert w3[650] == 0.0      # no cheap zone: the core is out
