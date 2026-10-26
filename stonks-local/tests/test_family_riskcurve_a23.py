import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families import riskcurve_a23 as RC

FAM = FAMILIES["riskcurve_a23"]
BIG = ["XRP-EUR", "ADA-EUR"]
SMALL = ["XTZ-EUR", "NEO-EUR"]


def spec(markets=("BTC-EUR",), **params):
    p = {"lookback": 2, "k": 2, "exitQ": 0.9, "band": 0.3, "rankLen": 90, "turnLen": 20, **params}
    return normalize_spec({"family": NAME, "markets": list(markets), "interval": "1d", "params": p}, FAM)


NAME = "riskcurve_a23"


def series(c, vol=1.0):
    df = bars([(x, x, x, x) for x in c])
    df["volume"] = vol
    return df


def world(small_path, n=120):
    flat = [10.0] * n
    cd = {"BTC-EUR": series(flat)}
    for m in BIG:
        cd[m] = series(flat, vol=1000.0)
    for m in SMALL:
        cd[m] = series(small_path, vol=1.0)
    return cd


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "exitQ": 0.5, "band": 0.5}}) is not None
    rng = random.Random(5)
    cd = {m: synth(500, i + 1, price=50 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *RC.POOL])}
    for _ in range(10):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    assert set(FAM.markets_needed(spec(["ETH-EUR"]))) >= {"ETH-EUR", "BTC-EUR", "XRP-EUR", "NEO-EUR"}
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"]))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_exits_when_small_coins_pump_and_returns():
    n = 120
    path = [10.0] * 100 + [10.0 * 1.2 ** (i + 1) for i in range(3)] + [10.0 * 1.2 ** 3] * (n - 103)
    w = FAM.targets(world(path, n), spec())["BTC-EUR"].to_numpy()
    first = int(np.argmax(np.isfinite(w)))
    assert first > 2 and np.isnan(w[:first]).all()
    assert (w[first:100] == 1).all()                     # flat pool: depth 0 sits at mid-rank 0.5 -> hold
    assert w[100] == 0 and w[101] == 0                   # small coins outrun the large ones -> out
    assert w[-1] == 1                                    # lead gone, percentile low again -> back in


def test_large_coins_pumping_keeps_holding():
    n = 120
    flat = [10.0] * n
    pump = [10.0] * 100 + [10.0 * 1.2 ** (i + 1) for i in range(3)] + [10.0 * 1.2 ** 3] * (n - 103)
    cd = {"BTC-EUR": series(flat)}
    for m in BIG:
        cd[m] = series(pump, vol=1000.0)
    for m in SMALL:
        cd[m] = series(flat, vol=1.0)
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert (w[np.isfinite(w)][-25:] == 1).all()


def test_traded_market_leaves_the_pool():
    n = 120
    path = [10.0] * 100 + [10.0 * 1.2 ** (i + 1) for i in range(3)] + [10.0 * 1.2 ** 3] * (n - 103)
    cd = world(path, n)
    # trading NEO alone: it leaves the pool, 3 coins left (< 2k=4) -> undecided throughout
    assert np.isnan(FAM.targets(cd, spec(["NEO-EUR"]))["NEO-EUR"].to_numpy()).all()


def test_depth_and_percentile_helpers():
    idx = np.asarray(world([10.0] * 10, 10)["BTC-EUR"].index, dtype=np.int64)
    x = np.array([np.nan, 1, 2, 3, 0.5] + [1.0] * 70)
    q = RC.trailing_pct(x, 90)
    assert np.isnan(q[:60]).all() and np.isfinite(q[61])
    assert len(RC.depth(world([10.0] * 10, 10), idx, 2, 2, 5)) == 10
