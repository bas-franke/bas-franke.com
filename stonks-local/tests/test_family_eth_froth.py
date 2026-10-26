import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["eth_froth"]
POOL = ["XRP-EUR", "ADA-EUR", "LTC-EUR"]


def spec(markets=("BTC-EUR",), **params):
    p = {"lookback": 2, "threshold": 0.2, "band": 0.1, "mode": "eth", "altLookback": 2, "altThreshold": 0.2,
         "minOut": 0, **params}
    return normalize_spec({"family": "eth_froth", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def c(prices):
    return bars([(x, x, x, x) for x in prices])


N = 12
FLAT = [10.0] * N
ETH_PUMP = [10, 10, 10, 10, 13, 13, 13, 13, 13, 13, 13, 13]   # +26 % at i4: lead 0.26 at i4, i5, then 0
ALT_PUMP = [10, 10, 10, 10, 10, 13, 13, 13, 13, 13, 13, 13]   # alt lead at i5, i6


def w(cd, **kw):
    return list(FAM.targets(cd, spec(**kw))["BTC-EUR"].to_numpy())


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    cd = {m: synth(900, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
    for _ in range(15):
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
    assert set(FAM.markets_needed(spec(["BTC-EUR"]))) == {"BTC-EUR", "ETH-EUR"}
    assert "XRP-EUR" in set(FAM.markets_needed(spec(["BTC-EUR"], mode="and")))
    for mode in ("eth", "and", "or"):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], mode=mode, minOut=5))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_exits_on_eth_spike_and_band():
    cd = {"BTC-EUR": c(FLAT), "ETH-EUR": c(ETH_PUMP)}
    out = w(cd)
    assert np.isnan(out[:2]).all()
    assert out[2:] == [1, 1, 0, 0, 1, 1, 1, 1, 1, 1]
    # BTC pumping instead (ETH lags): keep holding
    assert w({"BTC-EUR": c(ETH_PUMP), "ETH-EUR": c(FLAT)})[2:] == [1] * 10
    # wide band: lead must drop below 0.2 - 0.3 < 0 to buy back; lead 0 is not below -0.1 -> stays out
    assert w(cd, band=0.3)[2:] == [1, 1] + [0] * 8
    # minOut keeps it out longer
    assert w(cd, minOut=4)[2:] == [1, 1, 0, 0, 0, 0, 1, 1, 1, 1]


def test_and_or_modes():
    alts = {m: c(ALT_PUMP) for m in POOL}
    cd = {"BTC-EUR": c(FLAT), "ETH-EUR": c(ETH_PUMP), **alts}
    # and: ETH lead (i4, i5) overlaps alt lead (i5, i6) only at i5
    assert w(cd, mode="and")[2:] == [1, 1, 1, 0, 1, 1, 1, 1, 1, 1]
    assert w(cd, mode="or")[2:] == [1, 1, 0, 0, 0, 1, 1, 1, 1, 1]
    # no alt pump: 'and' never exits
    cd2 = {"BTC-EUR": c(FLAT), "ETH-EUR": c(ETH_PUMP), **{m: c(FLAT) for m in POOL}}
    assert w(cd2, mode="and")[2:] == [1] * 10


def test_split_two_markets():
    cd = {"BTC-EUR": c(FLAT), "ETH-EUR": c(ETH_PUMP)}
    df = FAM.targets(cd, spec(["BTC-EUR", "ETH-EUR"]))
    assert list(df["ETH-EUR"].to_numpy()[2:6]) == [0.5, 0.5, 0, 0]


def test_no_lookahead():
    cd = {m: synth(600, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
    rng = np.random.default_rng(6)
    for mode in ("eth", "or"):
        s = spec(["BTC-EUR", "ETH-EUR"], lookback=20, threshold=0.05, band=0.05, minOut=3, mode=mode,
                 altLookback=30, altThreshold=0.05)
        full = FAM.targets(cd, s).to_numpy()
        for k in (200, 450):
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
