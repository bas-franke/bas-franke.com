import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["range_wick"]
DAY = 86_400_000


def spec(markets=("BTC-EUR",), **params):
    p = dict(FAM.default_params())
    p.update(params)
    return normalize_spec({"family": "range_wick", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def quiet(n, px=100.0):
    return [(px, px + 1, px - 1, px) for _ in range(n)]


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    for _ in range(40):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "holdBars": 0, "blockBars": 0}}) is not None
    for b in ("cash", "sma", "hold"):
        ex = FAM.explain(spec(base=b, blockBars=5))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_upper_wick_wide_candle_buys_for_hold_bars():
    rows = quiet(10) + [(100, 110, 99, 101)] + quiet(8, 101)   # wide candle, upper wick 9/11
    cd = {"BTC-EUR": bars(rows, step=DAY)}
    w = FAM.targets(cd, spec(base="cash", rangeLook=5, rangeMult=2.0, wickMin=0.5, holdBars=3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:4]).all()
    assert (w[4:10] == 0.0).all()
    assert (w[10:13] == 1.0).all() and w[13] == 0.0


def test_lower_wick_wide_candle_blocks_hold_base():
    rows = quiet(10) + [(100, 101, 90, 99)] + quiet(8, 99)     # wide candle, lower wick 9/11
    cd = {"BTC-EUR": bars(rows, step=DAY)}
    w = FAM.targets(cd, spec(base="hold", rangeLook=5, rangeMult=2.0, wickMin=0.5, holdBars=0,
                             blockBars=4))["BTC-EUR"].to_numpy()
    assert (w[4:10] == 1.0).all()
    assert (w[10:14] == 0.0).all() and w[14] == 1.0


def test_narrow_long_wick_is_ignored():
    rows = quiet(10) + [(100, 101.2, 99.9, 100)] + quiet(5)    # long upper wick share but not wide
    cd = {"BTC-EUR": bars(rows, step=DAY)}
    w = FAM.targets(cd, spec(base="cash", rangeLook=5, rangeMult=1.5, wickMin=0.5, holdBars=3))["BTC-EUR"].to_numpy()
    assert (w[4:] == 0.0).all()


def test_two_markets_split_and_no_lookahead():
    cd = {"BTC-EUR": synth(600, 4, step=DAY, vol=0.04), "ETH-EUR": synth(600, 5, step=DAY, vol=0.05)}
    for s in (spec(markets=("BTC-EUR", "ETH-EUR"), base="sma", smaLen=50, blockBars=5),
              spec(base="cash", rangeLook=10, rangeMult=1.2, wickMin=0.4, holdBars=7)):
        full = FAM.targets(cd, s)
        assert np.nanmax(full.to_numpy()) <= 1.0 / len(s["markets"]) + 1e-12
        for k in (80, 400):
            tr = FAM.targets({m: cd[m].iloc[: k + 1] for m in s["markets"]}, s)
            for m in s["markets"]:
                assert np.allclose(full[m].to_numpy()[: k + 1], tr[m].to_numpy(), equal_nan=True)
