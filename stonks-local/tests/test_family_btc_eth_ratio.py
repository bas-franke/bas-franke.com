import random

import numpy as np
import pytest

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["btc_eth_ratio"]
MK = ["BTC-EUR", "ETH-EUR"]


def spec(**params):
    return normalize_spec({"family": "btc_eth_ratio", "markets": MK, "interval": "4h", "params": params}, FAM)


def cf(closes):
    return bars([(x, x, x, x) for x in closes])


def test_contract_and_sampling():
    assert FAM.multi_market and not FAM.bot_ready
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "fast": 50, "slow": 50}}) is not None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(600, 1), "ETH-EUR": synth(600, 2, price=1500)}
    for _ in range(10):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(**{**p, "slow": min(p["slow"], 200), "fast": min(p["fast"], min(p["slow"], 200) - 1),
                    "absSma": min(p["absSma"], 200)})
        s["risk"]["maxWeight"] = 0.7
        v = FAM.targets(cd, s).to_numpy()
        first = int(np.argmax(~np.isnan(v).all(axis=1)))
        assert not np.isnan(v[first:]).any()
        assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.7 + 1e-12).all()
    ex = FAM.explain(spec(band=0.01, absSma=50, tilt=0.8))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_switches_to_the_leader():
    btc = cf([100] * 10)
    eth = cf([10, 10, 10, 10, 12, 14, 14, 10, 8, 8])  # ETH outperforms, then underperforms
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec(fast=1, slow=3, band=0, absSma=0, tilt=1.0)).to_numpy()
    assert np.isnan(w[:2]).all()
    # ratio .1 .1 .1 .1 .12 .14 .14 .1 .08 ; ema3 seeded .1 at i2 -> i3 .1 (f==s: BTC), i4 .11 (ETH) ...
    assert list(w[2:, 1]) == [0, 0, 1, 1, 1, 0, 0, 0]
    assert list(w[2:, 0]) == [1, 1, 0, 0, 0, 1, 1, 1]


def test_band_holds_previous_leader_and_tilt():
    btc = cf([100] * 6)
    eth = cf([10, 10, 10, 10.2, 13, 13])
    s = spec(fast=1, slow=3, band=0.05, absSma=0, tilt=0.75)
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, s).to_numpy()
    # i3: ratio .102 vs ema .101 -> inside the 5 % band, stays BTC; i4: .13 vs .1155 -> ETH
    np.testing.assert_allclose(w[2:], [[.75, .25], [.75, .25], [.25, .75], [.25, .75]])


def test_abs_filter_goes_to_cash():
    btc = cf([100, 90, 80, 70, 60, 50])
    eth = cf([10, 10, 10, 9, 8, 7])  # ETH falls slower: leader, but still below its own SMA
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec(fast=1, slow=2, absSma=2, tilt=1.0)).to_numpy()
    assert np.isnan(w[0]).all()
    assert (w[1:] == 0).all()


def test_wrong_markets_rejected():
    s = spec()
    s["markets"] = ["BTC-EUR", "SOL-EUR"]
    with pytest.raises(ValueError):
        FAM.targets({"BTC-EUR": cf([1, 2]), "SOL-EUR": cf([1, 2])}, s)


def test_no_lookahead():
    cd = {"BTC-EUR": synth(900, 1), "ETH-EUR": synth(900, 2, price=1500)}
    s = spec(fast=5, slow=40, band=0.01, absSma=60, tilt=0.8)
    full = FAM.targets(cd, s).to_numpy()
    rng = np.random.default_rng(5)
    for k in (300, 650):
        trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
        pert = {}
        for m, df in cd.items():
            d = df.copy()
            f = rng.uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            pert[m] = d
        np.testing.assert_array_equal(FAM.targets(pert, s).to_numpy()[: k + 1], full[: k + 1])
