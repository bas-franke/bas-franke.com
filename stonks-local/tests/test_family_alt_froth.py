import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["alt_froth"]
POOL = ["XRP-EUR", "ADA-EUR", "LTC-EUR"]


def spec(markets=("BTC-EUR",), **params):
    p = {"lookback": 2, "threshold": 0.2, "band": 0.1, "minOut": 0, "trendSma": 0, **params}
    return normalize_spec({"family": "alt_froth", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


FLAT = [10.0] * 10
PUMP = [10, 10, 10, 10, 15, 15, 15, 15, 15, 15]   # +40 % log at i4, lookback 2 -> spread > 0.2 at i4, i5


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
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
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], minOut=5, trendSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 5 and ex["whenItWins"] and ex["whenItLoses"]


def test_holds_by_default_and_exits_on_alt_pump():
    cd = {"BTC-EUR": closes(FLAT), **{m: closes(PUMP) for m in POOL}}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    # spread: i4,i5 = ln 1.5 = 0.405 > 0.2 -> out; i6+ = 0 < 0.1 -> back in
    assert list(w[2:]) == [1, 1, 0, 0, 1, 1, 1, 1]


def test_btc_leading_keeps_holding_and_pool_minimum():
    cd = {"BTC-EUR": closes(PUMP), **{m: closes(FLAT) for m in POOL}}
    assert list(FAM.targets(cd, spec())["BTC-EUR"].to_numpy()[2:]) == [1] * 8
    cd2 = {"BTC-EUR": closes(FLAT), "XRP-EUR": closes(PUMP), "ADA-EUR": closes(PUMP)}   # only 2 alts: undecided
    assert np.isnan(FAM.targets(cd2, spec())["BTC-EUR"].to_numpy()).all()


def test_min_out_band_and_split():
    cd = {"BTC-EUR": closes(FLAT), "ETH-EUR": closes(FLAT), **{m: closes(PUMP) for m in POOL}}
    w = FAM.targets(cd, spec(["BTC-EUR", "ETH-EUR"], minOut=4)).to_numpy()
    np.testing.assert_allclose(w[2:, 0], [.5, .5, 0, 0, 0, 0, .5, .5])
    np.testing.assert_allclose(w[2:, 1], w[2:, 0])
    w2 = FAM.targets(cd, spec(band=0.3))["BTC-EUR"].to_numpy()   # needs spread < -0.1 to re-enter: never
    assert list(w2[2:]) == [1, 1, 0, 0, 0, 0, 0, 0]


def test_trend_sma_filter():
    down = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
    cd = {"BTC-EUR": closes(down), **{m: closes(down) for m in POOL}}
    w = FAM.targets(cd, spec(trendSma=3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all() and (w[2:] == 0).all()


def test_no_lookahead():
    cd = {m: synth(600, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
    s = spec(["BTC-EUR", "ETH-EUR"], lookback=30, threshold=0.05, band=0.05, minOut=3, trendSma=40)
    full = FAM.targets(cd, s).to_numpy()
    rng = np.random.default_rng(5)
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
