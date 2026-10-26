import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["ratio_gate"]


def spec(market="ETH-EUR", **params):
    p = {"ratioFast": 1, "ratioSlow": 5, "band": 0.0, "coreLen": 0, "combine": "gate", **params}
    return normalize_spec({"family": "ratio_gate", "markets": [market], "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "ratioFast": 50, "ratioSlow": 40}})
    assert FAM.validate({"params": {**FAM.default_params(), "coreLen": 0, "combine": "and"}})
    assert set(FAM.markets_needed(spec("ETH-EUR"))) == {"ETH-EUR", "BTC-EUR"}
    assert set(FAM.markets_needed(spec("BTC-EUR"))) == {"ETH-EUR", "BTC-EUR"}
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(600, 1), "ETH-EUR": synth(600, 2, price=1000)}
    for _ in range(15):
        p = FAM.sample(rng)
        s = spec(**p)
        s["risk"]["maxWeight"] = 0.7
        v = FAM.targets(cd, s)["ETH-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
        assert set(np.unique(v[ok])) <= {0.0, 0.7}
    ex = FAM.explain(spec(coreLen=50, combine="and"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_holds_eth_only_while_ratio_rises():
    btc = [100.0] * 30
    eth = [10.0] * 10 + [10 + i for i in range(1, 11)] + [20 - i for i in range(1, 11)]  # ratio up, then down
    w = FAM.targets({"BTC-EUR": closes(btc), "ETH-EUR": closes(eth)}, spec())["ETH-EUR"].to_numpy()
    assert (w[11:20] == 1).all()
    assert (w[21:] == 0).all()        # ratio falling under its average: euros, not BTC


def test_eth_falling_with_btc_falling_faster_stays_in():
    btc = [100.0 - 2 * i for i in range(30)]
    eth = [10.0 - 0.1 * i for i in range(30)]  # ETH -29 %, BTC -58 %: ratio rising
    w = FAM.targets({"BTC-EUR": closes(btc), "ETH-EUR": closes(eth)}, spec())["ETH-EUR"].to_numpy()
    assert (w[6:] == 1).all()
    # with an AND core, the falling ETH price keeps it out
    w2 = FAM.targets({"BTC-EUR": closes(btc), "ETH-EUR": closes(eth)},
                     spec(coreLen=5, combine="and"))["ETH-EUR"].to_numpy()
    assert (w2[6:] == 0).all()
    # OR core: ratio alone is enough
    w3 = FAM.targets({"BTC-EUR": closes(btc), "ETH-EUR": closes(eth)},
                     spec(coreLen=5, combine="or"))["ETH-EUR"].to_numpy()
    assert (w3[6:] == 1).all()
