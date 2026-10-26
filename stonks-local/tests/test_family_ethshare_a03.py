import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["ethshare_a03"]


def spec(markets=("BTC-EUR",), **params):
    p = {"turnLen": 1, "rankLen": 3, "exitQ": 0.8, "band": 0.3, "minOut": 0, "coreSma": 0, **params}
    return normalize_spec({"family": "ethshare_a03", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def flat(n, vol, price=100.0):
    df = bars([(price, price, price, price)] * n)
    df["volume"] = np.asarray(vol, dtype=np.float64)
    return df


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "exitQ": 0.6, "band": 0.4}})
    rng = random.Random(7)
    cd = {m: synth(900, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for _ in range(20):
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
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], coreSma=50, minOut=5))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_steps_out_while_eth_share_is_high():
    btc = flat(10, [10] * 10)
    # ETH share 1/11, 2/12, 3/13, ... rising (rank 1.0 -> out) from i3, then collapsing at i7 (rank low -> in)
    eth = flat(10, [1, 1, 1, 2, 3, 4, 5, 0.5, 0.5, 0.5])
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec())["BTC-EUR"].to_numpy()
    # rankLen 3 defined from i2 (shares 1,1,1 -> rank of a tie = 2/3 < 0.8 -> in); i3..i6 new highs -> out;
    # i7 lowest of 3 (rank 1/3 < 0.5) -> back in; later ties stay below 0.8 -> in
    assert np.isnan(w[:2]).all()
    assert list(w[2:]) == [1, 0, 0, 0, 0, 1, 1, 1]


def test_min_out_and_core():
    btc = flat(10, [10] * 10)
    eth = flat(10, [1, 1, 1, 2, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec(minOut=3, band=0.1))["BTC-EUR"].to_numpy()
    # out at i3; i4 rank low but only 1 candle out; back in at i6 (3 candles after the exit)
    assert list(w[2:]) == [1, 0, 0, 0, 1, 1, 1, 1]
    falling = bars([(x, x, x, x) for x in [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]])
    w2 = FAM.targets({"BTC-EUR": falling, "ETH-EUR": eth}, spec(coreSma=2))["BTC-EUR"].to_numpy()
    assert (w2[2:] == 0).all()


def test_day_hour_on_hourly_candles():
    from stonks_lab.families.ethshare_a03 import daily_candles
    H = 3_600_000
    n = 24 * 12
    rng = np.random.default_rng(3)
    ts = 1_600_041_600_000 + H * np.arange(n, dtype=np.int64)   # starts at 00:00 UTC
    def hourly(vol):
        df = flat(n, vol)
        df.index = __import__("pandas").Index(ts, name="ts")
        return df
    btc, eth = hourly(np.ones(n) * 10), hourly(rng.uniform(0.5, 2.0, n))
    cd = {"BTC-EUR": btc, "ETH-EUR": eth}
    s = normalize_spec({"family": "ethshare_a03", "markets": ["BTC-EUR"], "interval": "1h",
                        "params": {"turnLen": 2, "rankLen": 3, "exitQ": 0.8, "band": 0.1, "minOut": 0,
                                   "coreSma": 0, "dayHour": 0}}, FAM)
    w = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
    # hour 0 = native daily candles: decisions only at 23:00 UTC and equal to the 1d run on daily sums
    dec = np.flatnonzero(np.isfinite(w))
    assert len(dec) and ((ts[dec] // H) % 24 == 23).all()
    dd = {m: daily_candles(df, 0)[0] for m, df in cd.items()}
    s1 = {**s, "interval": "1d"}
    w1 = FAM.targets(dd, s1)["BTC-EUR"].to_numpy()
    assert list(w[dec]) == list(w1[np.isfinite(w1)])
    s7 = {**s, "params": {**s["params"], "dayHour": 7}}
    dec7 = np.flatnonzero(np.isfinite(FAM.targets(cd, s7)["BTC-EUR"].to_numpy()))
    assert len(dec7) and ((ts[dec7] // H) % 24 == 6).all()
