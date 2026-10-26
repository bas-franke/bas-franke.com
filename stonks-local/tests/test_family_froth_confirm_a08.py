import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["froth_confirm_a08"]
ALT = FAMILIES["alt_froth"]
POOL = ["XRP-EUR", "ADA-EUR", "LTC-EUR"]


def spec(markets=("BTC-EUR",), family="froth_confirm_a08", **params):
    p = {"lookback": 2, "threshold": 0.2, "band": 0.1, "confirm": 0, "minOut": 0, "trendSma": 0, **params}
    if family == "alt_froth":
        p.pop("confirm")
    return normalize_spec({"family": family, "markets": list(markets), "interval": "1d", "params": p},
                          FAMILIES[family])


def closes(c):
    return bars([(x, x, x, x) for x in c])


FLAT = [10.0] * 12
SPIKE = [10, 10, 10, 10, 15, 15, 15, 15, 15, 15, 15, 15]           # spread > 0.2 only at i4, i5 (2 candles)
SEASON = [10, 10, 10, 10, 15, 22, 33, 50, 50, 50, 50, 50]          # spread > 0.2 at i4..i8 (5 candles)


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(4)
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
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], confirm=10, minOut=5, trendSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 5 and ex["whenItWins"] and ex["whenItLoses"]


def test_confirm_zero_equals_alt_froth():
    cd = {m: synth(600, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
    kw = dict(lookback=30, threshold=0.05, band=0.05, minOut=3, trendSma=40)
    a = FAM.targets(cd, spec(["BTC-EUR", "ETH-EUR"], confirm=0, **kw)).to_numpy()
    b = ALT.targets(cd, spec(["BTC-EUR", "ETH-EUR"], family="alt_froth", **kw)).to_numpy()
    np.testing.assert_array_equal(np.isnan(a), np.isnan(b))
    np.testing.assert_allclose(np.nan_to_num(a), np.nan_to_num(b))


def test_short_spike_ignored_lasting_froth_sells():
    cd = {"BTC-EUR": closes(FLAT), **{m: closes(SPIKE) for m in POOL}}
    w0 = FAM.targets(cd, spec(confirm=0))["BTC-EUR"].to_numpy()
    assert np.isnan(w0[:2]).all() and list(w0[2:]) == [1, 1, 0, 0, 1, 1, 1, 1, 1, 1]
    w2 = FAM.targets(cd, spec(confirm=2))["BTC-EUR"].to_numpy()
    assert list(w2[2:]) == [1] * 10                       # 2-candle spike < 3 needed: no sale
    cd2 = {"BTC-EUR": closes(FLAT), **{m: closes(SEASON) for m in POOL}}
    w = FAM.targets(cd2, spec(confirm=2))["BTC-EUR"].to_numpy()
    # spread > 0.2 at i4..i8 -> third candle in a row is i6: out from i6; i9 spread 0 < 0.1 -> back in
    assert list(w[2:]) == [1, 1, 1, 1, 0, 0, 0, 1, 1, 1]


def test_trend_sma_filter():
    down = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
    cd = {"BTC-EUR": closes(down), **{m: closes(down) for m in POOL}}
    w = FAM.targets(cd, spec(trendSma=3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all() and (w[2:] == 0).all()


def test_no_lookahead():
    cd = {m: synth(600, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
    s = spec(["BTC-EUR", "ETH-EUR"], lookback=30, threshold=0.05, band=0.05, confirm=5, minOut=3, trendSma=40)
    full = FAM.targets(cd, s).to_numpy()
    for cut in (250, 400, 555):
        part = FAM.targets({m: d.iloc[:cut] for m, d in cd.items()}, s).to_numpy()
        np.testing.assert_array_equal(np.isnan(part), np.isnan(full[:cut]))
        np.testing.assert_allclose(np.nan_to_num(part), np.nan_to_num(full[:cut]))
