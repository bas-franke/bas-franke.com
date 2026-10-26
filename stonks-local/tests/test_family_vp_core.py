import random

import numpy as np
import pandas as pd

from _engine_util import T0, H4, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.vp_core import profile_line

FAM = FAMILIES["vp_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {"lookback": 3, "binPct": 0.01, "level": "poc", "q": 0.5, "entryBand": 0.0, "exitBand": 0.0, **params}
    return normalize_spec({"family": "vp_core", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def flat(closes, vols):
    c = np.asarray(closes, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.asarray(vols, dtype=np.float64)},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


C = [100, 100, 110, 120, 95]
V = [10, 10, 1, 1, 1]


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {m: synth(500, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for _ in range(12):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    for extra in ({"level": "quantile", "entryBand": 0.02, "exitBand": 0.05}, {}):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], **extra))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_point_of_control():
    df = flat(C, V)
    line = profile_line(df, spec()["params"])
    assert np.isnan(line[:2]).all()
    # i2/i3: the heavy 100 bars dominate; i4: window 110/120/95 with ~equal volume -> the 120 bin has most EUR
    assert abs(line[2] / 100 - 1) < 0.011 and abs(line[3] / 100 - 1) < 0.011
    assert abs(line[4] / 120 - 1) < 0.011
    w = FAM.targets({"BTC-EUR": df}, spec())["BTC-EUR"].to_numpy()
    assert list(w[2:]) == [1, 1, 0]


def test_quantile_line():
    df = flat(C, V)
    line = profile_line(df, spec(level="quantile", q=0.5)["params"])
    # i4 sorted 95/110/120 with EUR 95/110/120: half of 325 is reached at 110
    assert abs(line[4] - 110) < 1e-9
    w = FAM.targets({"BTC-EUR": df}, spec(level="quantile", q=0.5, exitBand=0.2))["BTC-EUR"].to_numpy()
    assert w[4] == 1  # 95 is not 20 % below 110
