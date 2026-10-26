import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec


def spec(interval="1d", **params):
    fam = FAMILIES["panic_bounce"]
    return normalize_spec({"family": "panic_bounce", "markets": ["BTC-EUR"], "interval": interval,
                           "params": params}, fam)


def w_of(c, **p):
    cd = {"BTC-EUR": bars([(x, x, x, x) for x in c])}
    return FAMILIES["panic_bounce"].targets(cd, spec(**p))["BTC-EUR"].to_numpy()


def test_contract_and_sampling():
    fam = FAMILIES["panic_bounce"]
    assert not fam.bot_ready and fam.validate({"params": fam.default_params()}) is None
    rng = random.Random(2)
    cd = {"BTC-EUR": synth(4000, 1)}
    for _ in range(15):
        p = fam.sample(rng)
        assert fam.validate({"params": p}) is None, p
        t = fam.targets(cd, spec("5m", **p)).to_numpy()[:, 0]
        first = int(np.argmax(~np.isnan(t)))
        assert not np.isnan(t[first:]).any() and set(np.unique(t[first:])) <= {0.0, 1.0}
    ex = fam.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


CALM_THEN_DIP = [100, 101, 100, 101, 100, 101, 100, 90, 92, 101, 101, 101]


def test_buys_dip_in_volatile_market_and_sells_on_rebound():
    # 1d interval: bars per day = 1, so vol% = std of daily log returns * 100 (~1 % here, ~5 % at the dip)
    w = w_of(CALM_THEN_DIP, lookback=4, threshold=1.5, volBars=3, volMinPct=1.0, exitZ=0.0, maxHoldBars=50)
    i = 7
    assert np.isnan(w[:3]).all()
    assert (w[3:i] == 0).all() and w[i] == 1
    assert w[i + 1] == 1  # 92 still below the average
    assert w[i + 2] == 0  # 101 is above the average -> sold


def test_vol_gate_blocks_and_max_hold_exits():
    w = w_of(CALM_THEN_DIP, lookback=4, threshold=1.5, volBars=3, volMinPct=12.0, exitZ=0.0, maxHoldBars=50)
    assert (w[~np.isnan(w)] == 0).all()
    w2 = w_of(CALM_THEN_DIP, lookback=4, threshold=1.5, volBars=3, volMinPct=1.0, exitZ=2.0, maxHoldBars=2)
    assert list(w2[7:10]) == [1, 1, 0]


def test_no_lookahead():
    fam = FAMILIES["panic_bounce"]
    cd = {"BTC-EUR": synth(900, 4)}
    s = spec("5m", lookback=20, threshold=1.5, volBars=50, volMinPct=1.0, exitZ=0.5, maxHoldBars=30)
    full = fam.targets(cd, s).to_numpy()
    assert np.nanmax(full) == 1
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
