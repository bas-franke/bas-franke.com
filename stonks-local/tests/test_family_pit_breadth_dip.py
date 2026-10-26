import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["pit_breadth_dip"]
FLAT = [10.0] * 8
DIP = FLAT + [10, 11, 12, 11, 10, 9, 10, 11, 12, 13]


def spec(markets=("BTC-EUR",), **params):
    p = {"rsiPeriod": 2, "rsiBelow": 30, "breadthMin": 0.6, "sellAbove": 70, "maxHold": 0, "coreSma": 0,
         "pool": "pit", "universe": 3, "volLook": 5, **params}
    return normalize_spec({"family": "pit_breadth_dip", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c, vol=1.0):
    df = bars([(x, x, x, x) for x in c])
    df["volume"] = vol
    return df


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "rsiBelow": 40, "sellAbove": 40}})
    rng = random.Random(5)
    names = ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR", "LTC-EUR"]
    cd = {m: synth(400, i + 1, price=100 * (i + 1)) for i, m in enumerate(names)}
    for _ in range(15):
        p = FAM.sample(rng)
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    assert set(FAM.markets_needed(spec())) >= {"BTC-EUR", "LTC-EUR", "BCH-EUR", "LUNA-EUR"}
    assert "LTC-EUR" not in FAM.markets_needed(spec(pool="top10"))
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], maxHold=10, coreSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_buys_when_the_big_coins_dip_together():
    cd = {"BTC-EUR": closes(DIP, 100), "ETH-EUR": closes(DIP, 100), "LTC-EUR": closes(DIP, 100),
          "XRP-EUR": closes([10.0] * len(DIP), 1), "ADA-EUR": closes([10.0] * len(DIP), 1)}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert (w[np.isfinite(w)] >= 0).all()
    assert w[12] == 1 and np.nansum(w) > 0           # 3 of 3 members oversold


def test_small_coins_do_not_count():
    # the dipping alts trade almost nothing: the members are BTC + the two flat, high-turnover coins
    cd = {"BTC-EUR": closes(DIP, 100), "ETH-EUR": closes(DIP, 1), "LTC-EUR": closes(DIP, 1),
          "XRP-EUR": closes([10.0] * len(DIP), 100), "ADA-EUR": closes([10.0] * len(DIP), 100)}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert np.nansum(w) == 0                         # only 1 of 3 members oversold
    w_all = FAM.targets(cd, spec(universe=5))["BTC-EUR"].to_numpy()
    assert np.nansum(w_all) > 0                      # 3 of 5 oversold = 0.6


def test_top10_pool_reproduces_breadth_dip():
    names = ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR", "DOGE-EUR"]
    cd = {m: synth(300, i + 7, vol=0.05) for i, m in enumerate(names)}
    p = {"rsiPeriod": 6, "rsiBelow": 35, "breadthMin": 0.6, "sellAbove": 60, "maxHold": 20, "coreSma": 30}
    mine = FAM.targets(cd, spec(["BTC-EUR", "ETH-EUR"], pool="top10", **p))
    ref = FAMILIES["breadth_dip"].targets(cd, normalize_spec(
        {"family": "breadth_dip", "markets": ["BTC-EUR", "ETH-EUR"], "interval": "1d", "params": p},
        FAMILIES["breadth_dip"]))
    np.testing.assert_allclose(mine.to_numpy(), ref.to_numpy())
