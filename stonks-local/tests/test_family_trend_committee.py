import random

import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["trend_committee"]
P = {"emaFast": 5, "emaSlow": 40, "macdFast": 6, "macdSlow": 30, "macdSignal": 9, "dcEntry": 20, "dcExit": 8}


def spec(markets=("BTC-EUR",), mw=1.0, **params):
    s = normalize_spec({"family": "trend_committee", "markets": list(markets), "interval": "1d",
                        "params": {**P, **params}}, FAM)
    s["risk"]["maxWeight"] = mw
    return s


def single(name, df, **params):
    fam = FAMILIES[name]
    s = normalize_spec({"family": name, "markets": ["BTC-EUR"], "interval": "1d", "params": params}, fam)
    return fam.targets({"BTC-EUR": df}, s)["BTC-EUR"].to_numpy()


def test_voters_match_v1_families_and_modes():
    df = synth(700, 4, vol=0.03)
    v = FAM.module.votes(df, P)
    first = FAM.warmup(P)
    e = single("ema_cross", df, fast=5, slow=40)
    m = single("macd_trend", df, fast=6, slow=30, signal=9, requirePositive=False)
    np.testing.assert_array_equal(v[first:, 0], e[first:])
    np.testing.assert_array_equal(v[first:, 1], m[first:])
    # donchian voter == donchian_breakout once both are past warm-up and the committee starts flat with it
    d = single("donchian_breakout", df, entry=20, exit=8)
    k = next(i for i in range(first, len(d)) if d[i] == 0)
    np.testing.assert_array_equal(v[k:, 2], d[k:])
    assert len({tuple(r) for r in v[first:]}) >= 4  # the voters really disagree sometimes
    w_avg = FAM.targets({"BTC-EUR": df}, spec(mw=0.9, mode="avg"))["BTC-EUR"].to_numpy()
    w_maj = FAM.targets({"BTC-EUR": df}, spec(mw=0.9, mode="majority"))["BTC-EUR"].to_numpy()
    assert np.isnan(w_avg[:first]).all() and not np.isnan(w_avg[first:]).any()
    np.testing.assert_allclose(w_avg[first:], 0.9 * v[first:].sum(axis=1) / 3)
    np.testing.assert_allclose(w_maj[first:], 0.9 * (v[first:].sum(axis=1) >= 2))


def test_multi_market_contract():
    cd = {"BTC-EUR": synth(600, 1), "ETH-EUR": synth(600, 2, price=1500)}
    s = spec(markets=("BTC-EUR", "ETH-EUR"), mw=0.6)
    v = FAM.targets(cd, s).to_numpy()
    first = int(np.argmax(~np.isnan(v).all(axis=1)))
    assert not np.isnan(v[first:]).any()
    assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    rng = random.Random(3)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(s)
    assert ex["summary"] and len(ex["howItWorks"]) >= 5


def test_no_lookahead():
    cd = {"BTC-EUR": synth(900, 1), "ETH-EUR": synth(900, 2, price=1500)}
    for mode in ("avg", "majority"):
        s = spec(markets=("BTC-EUR", "ETH-EUR"), mode=mode)
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
