import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["vacation_core_a13"]


def spec(markets=("BTC-EUR",), **params):
    p = {"coreLen": 5, "vacation": 4, "reExit": 0.1, **params}
    return normalize_spec({"family": "vacation_core_a13", "markets": list(markets), "interval": "1d", "params": p},
                          FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


# 0-9 rise, 10-19 flat well under the old SMA (a dip that does not recover), 20-24 a deeper leg down
PATH = [100.0 + 2 * i for i in range(10)] + [100.0] * 10 + [85.0, 84.0, 83.0, 82.0, 81.0]


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(800, 2), "ETH-EUR": synth(800, 3)}
    for _ in range(5):
        p = FAM.sample(rng)
        s = spec(markets=("BTC-EUR", "ETH-EUR"), **p)
        s["risk"]["maxWeight"] = 0.8
        v = FAM.targets(cd, s).to_numpy()
        ok = np.isfinite(v)
        assert set(np.unique(v[ok])) <= {0.0, 0.4}
    ex = FAM.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_forced_buy_back_then_deeper_exit():
    w = FAM.targets({"BTC-EUR": closes(PATH)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:4]).all() and (w[4:10] == 1).all()
    assert w[10] == 0                       # close 100 < SMA5 (~106): sell at 100
    assert (w[11:14] == 0).all()            # out 1..3 candles
    assert (w[14:20] == 1).all()            # 4 candles out -> forced buy-back; flat at 100 is not 10 % lower
    assert (w[20:24] == 0).all()            # 85 < 100 * 0.9: deeper leg sold again
    assert w[24] == 1                       # ... and bought back after another 4-candle vacation
    plain = FAM.targets({"BTC-EUR": closes(PATH)}, spec(vacation=0))["BTC-EUR"].to_numpy()
    assert (plain[10:] == 0).all()          # vacation 0 = plain SMA core: out while not above the SMA
