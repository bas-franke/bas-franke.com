import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec


def spec(**params):
    fam = FAMILIES["scalp_hold"]
    return normalize_spec({"family": "scalp_hold", "markets": ["BTC-EUR"], "interval": "1m", "params": params}, fam)


def closes(c):
    return {"BTC-EUR": bars([(x, x, x, x) for x in c])}


def w_of(c, **p):
    return FAMILIES["scalp_hold"].targets(closes(c), spec(**p))["BTC-EUR"].to_numpy()


BASE = dict(lookback=3, threshold=1.0, maxHoldBars=0, cooldownBars=0, trendSma=0)


def test_contract_and_sampling():
    fam = FAMILIES["scalp_hold"]
    assert not fam.bot_ready
    assert fam.validate({"params": fam.default_params()}) is None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(3000, 1)}
    for _ in range(20):
        p = fam.sample(rng)
        assert fam.validate({"params": p}) is None, p
        p["lookback"] = min(p["lookback"], 200)
        p["trendSma"] = min(p["trendSma"], 1000)
        t = fam.targets(cd, spec(**p)).to_numpy()[:, 0]
        first = int(np.argmax(~np.isnan(t)))
        assert not np.isnan(t[first:]).any() and set(np.unique(t[first:])) <= {0.0, 1.0}
    ex = fam.explain(spec(**{**BASE, "maxHoldBars": 20, "cooldownBars": 3, "trendSma": 200}))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_momentum_holds_min_bars():
    c = [10, 10, 10, 13, 12, 9, 9, 9, 9, 9]
    # i3: z of 13 vs (10,10,13) > 1 -> buy. i5: z < 0 (exit signal) at age 2.
    w1 = w_of(c, signal="momentum", minHoldBars=1, **BASE)
    assert np.isnan(w1[:2]).all()
    assert list(w1[2:6]) == [0, 1, 1, 0]
    w4 = w_of(c, signal="momentum", minHoldBars=4, **BASE)
    # held until age 4 (i7) where the exit signal still holds? z at i7 of (9,9,9) = 0 -> no exit; ages on
    assert list(w4[2:7]) == [0, 1, 1, 1, 1]


def test_reversion_and_max_hold_and_cooldown():
    c = [10, 10, 10, 7, 7, 7, 7, 7, 7, 7, 10, 10]
    w = w_of(c, signal="reversion", minHoldBars=1, **{**BASE, "maxHoldBars": 3})
    # i3: z < -1 -> buy; flat after that (z = 0 never > 0) -> max hold exits at age 3 (i6)
    assert list(w[2:8]) == [0, 1, 1, 1, 0, 0]
    w2 = w_of(c, signal="reversion", minHoldBars=1, **{**BASE, "cooldownBars": 2})
    assert w2[3] == 1 and (w2[4:10] == 1).all()  # never exits (z == 0 at flat prices)


def test_trend_filter_blocks_entries():
    c = [20, 19, 18, 17, 16, 15, 14, 13, 16, 12, 12]
    w = w_of(c, signal="momentum", minHoldBars=1, **{**BASE, "trendSma": 8})
    assert (w[~np.isnan(w)] == 0).all()


def test_no_lookahead():
    fam = FAMILIES["scalp_hold"]
    cd = {"BTC-EUR": synth(900, 4)}
    for sig in ("momentum", "reversion", "breakout"):
        s = spec(signal=sig, lookback=20, threshold=1.0, minHoldBars=5, maxHoldBars=40, cooldownBars=3,
                 trendSma=100)
        full = fam.targets(cd, s).to_numpy()
        rng = np.random.default_rng(5)
        for k in (300, 650):
            trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
            np.testing.assert_array_equal(fam.targets(trunc, s).to_numpy(), full[: k + 1])
            d = cd["BTC-EUR"].copy()
            f = rng.uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            np.testing.assert_array_equal(fam.targets({"BTC-EUR": d}, s).to_numpy()[: k + 1], full[: k + 1])
