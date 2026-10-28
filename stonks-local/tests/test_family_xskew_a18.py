import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["xskew_a18"]
POOL = ["ADA-EUR", "BCH-EUR", "ETC-EUR", "LINK-EUR", "LTC-EUR", "XRP-EUR"]


def spec(markets=("BTC-EUR",), **params):
    p = {"lookback": 1, "quantile": 0.6, "rankLen": 4, "minOut": 1, **params}
    return normalize_spec({"family": "xskew_a18", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def pool_with_mania(at, n=14):
    """Every pool coin drifts with a different small slope; at bar `at` one coin jumps +50 %: skew spikes."""
    cd = {}
    for j, m in enumerate(POOL):
        c = [10.0 * (1 + 0.001 * (j + 1)) ** i for i in range(n)]
        if j == 0:
            c = [x * (1.5 if i >= at else 1.0) for i, x in enumerate(c)]
        cd[m] = closes(c)
    return cd


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(4)
    cd = {m: synth(800, i + 1, price=50 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
    for _ in range(10):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.7
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.7 + 1e-12).all()
    assert set(FAM.markets_needed(spec(["ETH-EUR"]))) >= {"ETH-EUR", "XRP-EUR", "XTZ-EUR"}
    alt9 = set(FAM.markets_needed(spec(["ETH-EUR"], pool="alt9")))
    assert "XRP-EUR" in alt9 and "NEO-EUR" not in alt9 and "ETC-EUR" not in alt9
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"]))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_exits_on_one_coin_mania_and_returns():
    cd = {"BTC-EUR": closes([10.0] * 14), **pool_with_mania(8)}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert np.isfinite(w[4:]).all()
    assert w[8] == 0          # one coin +50 % in one bar: top skew of the window
    trig = np.r_[np.zeros(4, bool), w[4:] == 0]   # baseline skews tie up to float noise: triggers from minOut 1
    w2 = FAM.targets(cd, spec(minOut=3))["BTC-EUR"].to_numpy()
    want = [0.0 if trig[max(i - 2, 0):i + 1].any() else 1.0 for i in range(4, 14)]
    assert list(w2[4:]) == want and w2[8:11].sum() == 0


def test_negative_skew_keeps_holding():
    cd = {"BTC-EUR": closes([10.0] * 14), **pool_with_mania(8)}
    first = cd["ADA-EUR"]["close"].to_numpy()
    cd["ADA-EUR"] = closes([x / (2.25 if i >= 8 else 1.0) for i, x in enumerate(first)])   # one coin crashes instead
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert w[8] == 1


def test_traded_coin_left_out_of_its_own_pool_and_pool_minimum():
    cd = pool_with_mania(8)
    sk_all = FAM.module.pool_skew(cd, 1, cd["ADA-EUR"].index.to_numpy())
    sk_ex = FAM.module.pool_skew(cd, 1, cd["ADA-EUR"].index.to_numpy(), exclude={"ADA-EUR"})
    assert sk_all[8] > 1 and abs(sk_ex[8]) < 1
    small = {"BTC-EUR": closes([10.0] * 14), **{m: v for m, v in list(pool_with_mania(8).items())[:4]}}
    assert np.isnan(FAM.targets(small, spec())["BTC-EUR"].to_numpy()).all()
