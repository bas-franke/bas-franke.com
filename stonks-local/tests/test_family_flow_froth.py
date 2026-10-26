import random

import numpy as np
import pandas as pd

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["flow_froth"]
POOL = ["XRP-EUR", "ADA-EUR", "LTC-EUR"]


def spec(markets=("BTC-EUR",), **params):
    p = {"turnLen": 1, "baseLen": 5, "zMin": 0.1, "mode": "flow", "lookback": 2, "threshold": 0.2, "minOut": 0,
         **params}
    return normalize_spec({"family": "flow_froth", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def candles(prices, volumes):
    df = bars([(x, x, x, x) for x in prices])
    df["volume"] = np.asarray(volumes, dtype=np.float64)
    return df


N = 12
FLAT = [10.0] * N
SPIKE = [1, 1, 1, 1, 1, 1, 3, 3, 1, 1, 1, 1]      # alt volume x3 at i6, i7: share 0.75 -> 0.9
PUMP = [10, 10, 10, 10, 15, 15, 15, 15, 15, 15, 15, 15]


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(4)
    cd = {m: synth(900, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
    for _ in range(15):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    assert set(FAM.markets_needed(spec(["ETH-EUR"]))) >= {"ETH-EUR", "BTC-EUR", "XRP-EUR", "MIOTA-EUR"}
    for mode in ("flow", "and", "or"):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], mode=mode, minOut=5))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_exits_on_alt_turnover_spike():
    cd = {"BTC-EUR": candles(FLAT, [1] * N), **{m: candles(FLAT, SPIKE) for m in POOL}}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:4]).all()                      # median over 5 candles not defined yet
    assert list(w[4:]) == [1, 1, 0, 0, 1, 1, 1, 1]
    # BTC turnover spiking instead lowers the alt share: keep holding
    cd2 = {"BTC-EUR": candles(FLAT, SPIKE), **{m: candles(FLAT, [1] * N) for m in POOL}}
    assert list(FAM.targets(cd2, spec())["BTC-EUR"].to_numpy()[4:]) == [1] * 8


def test_modes_and_or():
    # flow spike, flat alt prices: 'and' needs the price lead too -> holds
    cd = {"BTC-EUR": candles(FLAT, [1] * N), **{m: candles(FLAT, SPIKE) for m in POOL}}
    assert list(FAM.targets(cd, spec(mode="and"))["BTC-EUR"].to_numpy()[4:]) == [1] * 8
    assert list(FAM.targets(cd, spec(mode="or"))["BTC-EUR"].to_numpy()[4:]) == [1, 1, 0, 0, 1, 1, 1, 1]
    # alt price pump with constant EUR turnover (volume = 10 / price): only the price signal fires (i4, i5)
    vol = [10.0 / x for x in PUMP]
    cd2 = {"BTC-EUR": candles(FLAT, [1] * N), **{m: candles(PUMP, vol) for m in POOL}}
    assert list(FAM.targets(cd2, spec(mode="flow"))["BTC-EUR"].to_numpy()[4:]) == [1] * 8
    assert list(FAM.targets(cd2, spec(mode="or"))["BTC-EUR"].to_numpy()[4:]) == [0, 0, 1, 1, 1, 1, 1, 1]
    assert list(FAM.targets(cd2, spec(mode="and"))["BTC-EUR"].to_numpy()[4:]) == [1] * 8
    # both at once: alt price pump at i4/i5 and turnover spike at i4/i5
    sp2 = [1, 1, 1, 1, 3, 3, 1, 1, 1, 1, 1, 1]
    cd3 = {"BTC-EUR": candles(FLAT, [1] * N), **{m: candles(PUMP, [a * b for a, b in zip(vol, sp2)]) for m in POOL}}
    assert list(FAM.targets(cd3, spec(mode="and"))["BTC-EUR"].to_numpy()[4:]) == [0, 0, 1, 1, 1, 1, 1, 1]


def test_min_out_split_and_pool_minimum():
    cd = {"BTC-EUR": candles(FLAT, [1] * N), "ETH-EUR": candles(FLAT, [1] * N),
          **{m: candles(FLAT, SPIKE) for m in POOL}}
    w = FAM.targets(cd, spec(["BTC-EUR", "ETH-EUR"], minOut=4)).to_numpy()
    np.testing.assert_allclose(w[4:, 0], [.5, .5, 0, 0, 0, 0, .5, .5])
    np.testing.assert_allclose(w[4:, 1], w[4:, 0])
    cd2 = {"BTC-EUR": candles(FLAT, [1] * N), "XRP-EUR": candles(FLAT, SPIKE), "ADA-EUR": candles(FLAT, SPIKE)}
    assert np.isnan(FAM.targets(cd2, spec())["BTC-EUR"].to_numpy()).all()   # < 3 pool alts: undecided


def test_no_lookahead():
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
    rng0 = np.random.default_rng(9)
    for df in cd.values():
        df["volume"] = rng0.uniform(0.5, 2.0, len(df))
    s = spec(["BTC-EUR", "ETH-EUR"], turnLen=10, baseLen=60, zMin=0.02, mode="or", lookback=30, threshold=0.05,
             minOut=3)
    full = FAM.targets(cd, s).to_numpy()
    rng = np.random.default_rng(5)
    for k in (200, 450):
        trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
        pert = {}
        for m, df in cd.items():
            d = df.copy()
            f = rng.uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close", "volume"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            pert[m] = d
        np.testing.assert_array_equal(FAM.targets(pert, s).to_numpy()[: k + 1], full[: k + 1])
