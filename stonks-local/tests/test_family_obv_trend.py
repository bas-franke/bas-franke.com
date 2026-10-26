import random

import numpy as np
import pandas as pd

from _engine_util import T0, H4, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["obv_trend"]


def spec(**params):
    return normalize_spec({"family": "obv_trend", "markets": ["BTC-EUR"], "interval": "1d", "params": params}, FAM)


def candles(closes, volumes):
    c = np.asarray(closes, dtype=np.float64)
    return {"BTC-EUR": pd.DataFrame({"open": c, "high": c, "low": c, "close": c,
                                     "volume": np.asarray(volumes, dtype=np.float64)},
                                    index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(11)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "fast": 60, "slow": 50}})
    ex = FAM.explain(spec(priceSma=20))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_obv_values():
    from stonks_lab.families.obv_trend import obv
    np.testing.assert_array_equal(obv(np.array([1.0, 2, 2, 1, 3]), np.array([5.0, 1, 2, 3, 4])), [0, 1, 1, -2, 2])


def test_buys_on_inflow_sells_on_outflow():
    # price chops in a range, but heavy volume on up candles first, then on down candles
    n = 60
    c = [100 + (i % 2) for i in range(2 * n)]
    v = [(10 if i % 2 else 1) for i in range(n)] + [(1 if i % 2 else 10) for i in range(n, 2 * n)]
    w = FAM.targets(candles(c, v), spec(fast=3, slow=10))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:9]).all()
    assert (w[20:n] == 1.0).all()
    assert (w[n + 20:] == 0.0).all()


def test_price_filter_modes():
    n = 60
    c = list(np.linspace(200, 100, n))          # falling price
    v = [10 if i % 2 else 1 for i in range(n)]  # heavy volume on the small up candles: OBV rises
    c = [x + (3 if i % 2 else 0) for i, x in enumerate(c)]
    cd = candles(c, v)
    alone = FAM.targets(cd, spec(fast=3, slow=10))["BTC-EUR"].to_numpy()
    both = FAM.targets(cd, spec(fast=3, slow=10, priceSma=20, mode="and"))["BTC-EUR"].to_numpy()
    half = FAM.targets(cd, spec(fast=3, slow=10, priceSma=20, mode="half"))["BTC-EUR"].to_numpy()
    k = n - 1
    assert both[k] == 0.0                        # price below its SMA vetoes
    assert alone[k] == 1.0 and half[k] == 0.5


def test_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, drift=0.001)}
    cd["BTC-EUR"]["volume"] = np.random.default_rng(1).uniform(1, 10, 600)
    s = spec(fast=8, slow=40, priceSma=30, mode="half")
    full = FAM.targets(cd, s).to_numpy()
    for k in (100, 400):
        trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
