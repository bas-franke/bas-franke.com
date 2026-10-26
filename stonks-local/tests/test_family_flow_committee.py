import random

import numpy as np
import pandas as pd

from _engine_util import T0, H4
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["flow_committee"]
SMALL = dict(macdFast=3, macdSlow=10, macdSignal=3, obvFast=3, obvSlow=10)


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "flow_committee", "markets": list(markets), "interval": "1d",
                           "params": {**SMALL, **params}}, FAM)


def frame_of(closes, volumes, offset=0):
    c = np.asarray(closes, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.asarray(volumes, dtype=np.float64)},
                        index=pd.Index(T0 + H4 * (offset + np.arange(len(c), dtype=np.int64)), name="ts"))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(6)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "obvFast": 80, "obvSlow": 50}})
    for mode in ("avg", "majority", "any"):
        ex = FAM.explain(spec(mode=mode, smaLen=20))
        assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_buys_uptrend_sells_downtrend():
    n = 60
    c = list(np.geomspace(100, 400, n)) + list(400 * (1 - 0.75 * (np.arange(n) / (n - 1)) ** 2))  # accelerating fall
    v = [5.0] * (2 * n)
    for mode in ("avg", "majority", "any"):
        w = FAM.targets({"BTC-EUR": frame_of(c, v)}, spec(mode=mode, smaLen=20))["BTC-EUR"].to_numpy()
        assert np.isnan(w[:10]).all()
        assert w[n - 5] == 1.0          # all three in near the top of the rise
        assert w[-1] == 0.0             # all three out at the end of the fall


def test_modes_split_votes():
    # price falls faster and faster (below SMA, MACD out on even bars) but heavy volume on the small up candles
    # makes OBV rise
    n = 80
    c = [200 - 100 * (i / n) ** 2 + (3 if i % 2 else 0) for i in range(n)]
    v = [10 if i % 2 else 1 for i in range(n)]
    cd = {"BTC-EUR": frame_of(c, v)}
    k = n - 2
    from stonks_lab.families.flow_committee import votes
    assert votes(cd["BTC-EUR"], {**SMALL, "smaLen": 20})[k].tolist() == [0.0, 1.0, 0.0]
    w2 = {m: FAM.targets(cd, spec(mode=m, smaLen=0))["BTC-EUR"].to_numpy()[k] for m in ("avg", "majority", "any")}
    w3 = {m: FAM.targets(cd, spec(mode=m, smaLen=20))["BTC-EUR"].to_numpy()[k] for m in ("avg", "majority", "any")}
    # with 2 voters (obv in, macd out): avg 1/2, majority (needs 2 of 2) out, any in
    assert w2 == {"avg": 0.5, "majority": 0.0, "any": 1.0}
    assert abs(w3["avg"] - 1 / 3) < 1e-12 and w3["majority"] == 0.0 and w3["any"] == 1.0


def test_multi_market_slices_and_late_listing():
    n = 60
    up = list(np.geomspace(100, 400, n))
    cd = {"BTC-EUR": frame_of(up, [5.0] * n), "ETH-EUR": frame_of(up[:30], [5.0] * 30, offset=30)}
    out = FAM.targets(cd, spec(markets=("BTC-EUR", "ETH-EUR"), smaLen=10))
    assert out.shape[1] == 2
    assert out["BTC-EUR"].iloc[-1] == 0.5          # half the money per coin
    i = out.index.get_loc(int(T0 + H4 * 25))
    assert out["ETH-EUR"].iloc[i] == 0.0           # not listed yet: its slice stays in euros
    assert out["ETH-EUR"].iloc[-1] == 0.5
