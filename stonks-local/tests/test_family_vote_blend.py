import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["vote_blend"]
ALTS = ["XRP-EUR", "ADA-EUR", "LTC-EUR"]
OFF = {"useCore": False, "useMacd": False, "useFroth": False, "panic": "off"}


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), **OFF, "coreSma": 3, "frothLook": 2, "frothThr": 0.2, "frothBand": 0.1,
         "rsiPeriod": 2, "rsiBelow": 20.0, "sellAbove": 60.0, "maxHold": 0, **params}
    return normalize_spec({"family": "vote_blend", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), **OFF}}) is not None
    rng = random.Random(7)
    cd = {m: synth(800, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *ALTS])}
    done = 0
    while done < 15:
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        done += 1
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    need = set(FAM.markets_needed(spec(["ETH-EUR"], useFroth=True, panic="pair")))
    assert need >= {"ETH-EUR", "BTC-EUR", "XRP-EUR", "MIOTA-EUR"}
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], useCore=True, useMacd=True, useFroth=True, panic="pool"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_average_all_any_of_core_and_froth():
    # BTC rises from i3 (core on from i3); alts pump +40 % at i5 (froth i5, i6; calm again from i7)
    btc = [10, 10, 10, 11, 12, 13, 14, 15, 16, 17]
    alt = [10] * 5 + [16] * 5
    cd = {"BTC-EUR": closes(btc), **{m: closes(alt) for m in ALTS}}
    w = FAM.targets(cd, spec(useCore=True, useFroth=True, mode="avg"))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    # i2: core off (10 == sma), calm -> 0.5; i3-4 1; i5-6 froth -> 0.5; i7+ 1
    np.testing.assert_allclose(w[2:], [.5, 1, 1, .5, .5, 1, 1, 1])
    w_all = FAM.targets(cd, spec(useCore=True, useFroth=True, mode="all"))["BTC-EUR"].to_numpy()
    np.testing.assert_allclose(w_all[2:], [0, 1, 1, 0, 0, 1, 1, 1])
    w_any = FAM.targets(cd, spec(useCore=True, useFroth=True, mode="any"))["BTC-EUR"].to_numpy()
    np.testing.assert_allclose(w_any[2:], [1] * 8)


def test_pair_panic_overrides_and_ends():
    # both crash at i4-5 (RSI2 ~0), recover strongly from i6
    px = [10, 10.5, 11, 11.5, 8, 6, 9, 11, 12, 13]
    cd = {"BTC-EUR": closes(px), "ETH-EUR": closes(px)}
    w = FAM.targets(cd, spec(useCore=True, coreSma=8, panic="pair"))["BTC-EUR"].to_numpy()
    # core: SMA8 defined from i7: close 11 < mean -> 0 ; i8 12 > 10.1? -> 1
    assert np.isnan(w[:7]).all()   # core voter undefined until i7
    w2 = FAM.targets(cd, spec(panic="pair"))["BTC-EUR"].to_numpy()   # panic only
    # RSI(2): i4 < 20 -> buy; holds through i5; i6 RSI > 60 -> sells
    assert list(np.nan_to_num(w2[2:], nan=-1)) == [0, 0, 1, 1, 0, 0, 0, 0]
    # ETH not crashing -> no pair panic
    cd2 = {"BTC-EUR": closes(px), "ETH-EUR": closes([10 + i for i in range(10)])}
    assert (FAM.targets(cd2, spec(panic="pair"))["BTC-EUR"].to_numpy()[2:] == 0).all()
    # max hold 1 ends the trade after one bar even without a rebound
    w3 = FAM.targets(cd, spec(panic="pair", maxHold=1))["BTC-EUR"].to_numpy()
    assert list(w3[2:6]) == [0, 0, 1, 0]


def test_macd_voter():
    up = list(10 * 1.03 ** np.arange(40)) + list(10 * 1.03 ** 39 * 0.97 ** np.arange(1, 41))
    cd = {"BTC-EUR": closes(up)}
    w = FAM.targets(cd, spec(useMacd=True, macdFast=3, macdSlow=8, macdSignal=3))["BTC-EUR"].to_numpy()
    assert (w[12:40] == 1).all() and (w[41:52] == 0).all()


def test_no_lookahead():
    cd = {m: synth(600, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *ALTS])}
    s = spec(["BTC-EUR", "ETH-EUR"], useCore=True, coreSma=40, useMacd=True, macdFast=5, macdSlow=30, macdSignal=9,
             useFroth=True, frothLook=30, frothThr=0.05, frothBand=0.02, panic="pool", rsiPeriod=6, rsiBelow=35,
             breadthMin=0.5, maxHold=20)
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
