import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["altseason_a05"]
POOL = ["XRP-EUR", "ADA-EUR", "LINK-EUR", "TRX-EUR", "LTC-EUR", "BCH-EUR", "XLM-EUR", "XTZ-EUR", "MIOTA-EUR"]


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), "lookback": 2, **params}
    return normalize_spec({"family": "altseason_a05", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def market(btc, alt_paths):
    cd = {"BTC-EUR": closes(btc)}
    for m, pth in zip(POOL, alt_paths):
        cd[m] = closes(pth)
    return cd


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "share": 0.5, "band": 0.6}})
    assert FAM.explain(spec())["summary"]


def test_sells_in_alt_season_and_buys_back():
    btc = [10, 10, 10, 10, 10, 10, 10, 10]
    up = [10, 10, 10, 11, 12, 12, 12, 12]  # beats BTC over 2 bars at t=3,4 (and t=5: 12 vs 10)
    flat = [10, 10, 10, 10, 10, 10, 10, 10]
    # 7/9 alts pump -> share .78 >= .75 at t=3..5, then back to 0 at t=6
    cd = market(btc, [up] * 7 + [flat] * 2)
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    assert list(w[2:8]) == [1.0, 0.0, 0.0, 0.0, 1.0, 1.0]
    # only 6/9 pump -> share .67 < .75: always in
    cd = market(btc, [up] * 6 + [flat] * 3)
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert (w[2:] == 1.0).all()


def test_band_keeps_it_out():
    btc = [10] * 9
    up = [10, 10, 10, 12, 12, 12, 12, 12, 12]  # beats BTC at t=3,4 only
    flat = [10] * 9
    cd = market(btc, [up] * 3 + [[10, 10, 10, 12, 12, 13, 14, 13, 13]] * 4 + [flat] * 2)
    # share over 2 bars: t=3,4 7/9; t=5,6 4/9 (inside a .4 band under .75); t=7,8 0
    w = FAM.targets(cd, spec(band=0.4))["BTC-EUR"].to_numpy()
    assert list(w[3:9]) == [0.0, 0.0, 0.0, 0.0, 1.0, 1.0]
    w = FAM.targets(cd, spec(band=0.0))["BTC-EUR"].to_numpy()
    assert list(w[3:9]) == [0.0, 0.0, 1.0, 1.0, 1.0, 1.0]


def test_lead_mean_needs_size_too():
    btc = [10] * 8
    small = [10, 10, 10, 10.1, 10.1, 10.1, 10.1, 10.1]  # beats BTC by a hair at t=3,4
    crash = [10, 10, 10, 5, 5, 5, 5, 5]                 # far behind BTC at t=3,4
    # 6/9 beat BTC (share .67 >= .5) but the mean lead is negative -> no season with lead=mean
    cd = market(btc, [small] * 6 + [crash] * 3)
    w = FAM.targets(cd, spec(share=0.5))["BTC-EUR"].to_numpy()
    assert list(w[3:5]) == [0.0, 0.0]
    w = FAM.targets(cd, spec(share=0.5, lead="mean"))["BTC-EUR"].to_numpy()
    assert list(w[3:5]) == [1.0, 1.0]
    big = [10, 10, 10, 15, 15, 15, 15, 15]
    cd = market(btc, [big] * 6 + [crash] * 3)  # mean lead > 0 and share .67 -> out
    w = FAM.targets(cd, spec(share=0.5, lead="mean"))["BTC-EUR"].to_numpy()
    assert list(w[2:6]) == [1.0, 0.0, 0.0, 1.0]
