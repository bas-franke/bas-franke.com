import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["turnover_panic"]


def spec(markets=("BTC-EUR",), **params):
    p = {"coreSma": 0, "source": "own", "volLook": 3, "volMult": 3.0, "dropLook": 1, "dropMin": 0.1,
         "holdBars": 3, "extend": False, **params}
    return normalize_spec({"family": "turnover_panic", "markets": list(markets), "interval": "4h",
                           "params": p}, FAM)


def candles(closes, vols):
    df = bars([(x, x, x, x) for x in closes])
    df["volume"] = np.asarray(vols, dtype=float)
    return df


# a flush at i5: price -20 % on ~5x the usual EUR turnover (volume 6 at 0.8 x price vs 1 at 1 x)
C = [10, 10, 10, 10, 10, 8, 8, 8, 8, 8, 8, 8]
V = [1, 1, 1, 1, 1, 6, 1, 1, 1, 1, 1, 1]


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for m, df in cd.items():
        df["volume"] = np.random.default_rng(5).lognormal(0, 0.8, len(df))
    for _ in range(20):
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
    assert FAM.markets_needed(spec(["ETH-EUR"])) == ["ETH-EUR"]
    assert set(FAM.markets_needed(spec(["ETH-EUR"], source="any"))) == {"BTC-EUR", "ETH-EUR"}
    for extra in ({"coreSma": 50}, {"source": "both", "dropMin": 0, "extend": True}):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], **extra))
        assert ex["summary"] and len(ex["howItWorks"]) >= 2 and ex["whenItWins"] and ex["whenItLoses"]


def test_flush_buys_and_holds_for_hold_bars():
    w = FAM.targets({"BTC-EUR": candles(C, V)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:3]).all()
    # in at i5 (the flush), held i6, i7, out at i8 (held 3 candles)
    assert list(w[3:]) == [0, 0, 1, 1, 1, 0, 0, 0, 0]


def test_no_buy_without_volume_or_without_fall():
    quiet = FAM.targets({"BTC-EUR": candles(C, [1] * 12)}, spec())["BTC-EUR"].to_numpy()
    assert (quiet[3:] == 0).all()
    up = [10, 10, 10, 10, 10, 12, 12, 12, 12, 12, 12, 12]
    pump = FAM.targets({"BTC-EUR": candles(up, V)}, spec())["BTC-EUR"].to_numpy()
    assert (pump[3:] == 0).all()
    small = FAM.targets({"BTC-EUR": candles(C, V)}, spec(dropMin=0.3))["BTC-EUR"].to_numpy()
    assert (small[3:] == 0).all()


def test_extend_restarts_the_clock():
    c = [10, 10, 10, 10, 10, 8, 6, 6, 6, 6, 6, 6]
    v = [1, 1, 1, 1, 1, 6, 9, 1, 1, 1, 1, 1]
    plain = FAM.targets({"BTC-EUR": candles(c, v)}, spec())["BTC-EUR"].to_numpy()
    assert list(plain[3:]) == [0, 0, 1, 1, 1, 0, 0, 0, 0]
    ext = FAM.targets({"BTC-EUR": candles(c, v)}, spec(extend=True))["BTC-EUR"].to_numpy()
    assert list(ext[3:]) == [0, 0, 1, 1, 1, 1, 0, 0, 0]


def test_shared_source_both_or_any():
    flat = candles([10] * 12, [1] * 12)
    cd = {"BTC-EUR": candles(C, V), "ETH-EUR": flat}
    both = FAM.targets(cd, spec(["ETH-EUR"], source="both"))["ETH-EUR"].to_numpy()
    assert (both[3:] == 0).all()
    anyw = FAM.targets(cd, spec(["ETH-EUR"], source="any"))["ETH-EUR"].to_numpy()
    assert list(anyw[3:]) == [0, 0, 1, 1, 1, 0, 0, 0, 0]   # ETH bought on BTC's flush
    own = FAM.targets(cd, spec(["ETH-EUR"]))["ETH-EUR"].to_numpy()
    assert (own[3:] == 0).all()


def test_core_holds_outside_flushes():
    up = list(range(1, 13))
    w = FAM.targets({"BTC-EUR": candles(up, [1] * 12)}, spec(coreSma=3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:3]).all() and (w[3:] == 1).all()
