import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["trend_basket"]
MK = ["BTC-EUR", "ETH-EUR"]


def spec(markets=MK, **params):
    return normalize_spec({"family": "trend_basket", "markets": list(markets), "interval": "1d", "params": params},
                          FAM)


def closes(xs, start=None):
    rows = [(x, x, x, x) for x in xs]
    return bars(rows) if start is None else bars(rows, start=start)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"base": 200, "mult": 3.0, "count": 3, "btcSma": 0}}) is not None
    rng = random.Random(8)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(spec(btcSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4


def test_graded_weights_per_coin():
    up = list(np.linspace(100, 200, 40))
    down = list(np.linspace(200, 100, 40))
    cd = {"BTC-EUR": closes(up), "ETH-EUR": closes(down)}
    w = FAM.targets(cd, spec(base=2, mult=2.0, count=3))
    assert np.isnan(w.iloc[:7].to_numpy()).all()          # longest SMA 8 candles
    assert (w["BTC-EUR"].to_numpy()[8:] == 0.5).all()     # rising: all votes up, full half slot
    assert (w["ETH-EUR"].to_numpy()[8:] == 0.0).all()     # falling: no votes, cash
    # one dip candle after a long rise: 2-candle SMA votes down, 4 and 8 still up -> 2/3 of the slot
    xs = up + [198.0]
    w2 = FAM.targets({"BTC-EUR": closes(xs)}, spec(markets=["BTC-EUR"], base=2, mult=2.0, count=3))
    assert abs(w2["BTC-EUR"].to_numpy()[-1] - 2 / 3) < 1e-12


def test_late_listing_gets_zero_then_shares():
    btc = closes(list(np.linspace(100, 200, 60)))
    t_late = int(btc.index[30])
    eth = closes(list(np.linspace(100, 200, 30)), start=t_late)
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec(base=2, mult=2.0, count=2))
    assert w["BTC-EUR"].to_numpy()[10] == 1.0 and w["ETH-EUR"].to_numpy()[10] == 0.0
    assert w["BTC-EUR"].to_numpy()[-1] == 0.5 and w["ETH-EUR"].to_numpy()[-1] == 0.5


def test_btc_gate():
    btc = closes(list(np.linspace(200, 100, 40)))
    eth = closes(list(np.linspace(100, 200, 40)))
    w = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec(markets=["ETH-EUR"], base=2, mult=2.0, count=2, btcSma=5))
    assert (w["ETH-EUR"].to_numpy()[6:] == 0.0).all()
    w2 = FAM.targets({"BTC-EUR": btc, "ETH-EUR": eth}, spec(markets=["ETH-EUR"], base=2, mult=2.0, count=2))
    assert (w2["ETH-EUR"].to_numpy()[6:] == 1.0).all()


def test_no_lookahead():
    cd = {"BTC-EUR": synth(500, 2, drift=0.001), "ETH-EUR": synth(500, 3, drift=0.001, price=1500.0)}
    s = spec(base=10, mult=2.2, count=3, btcSma=30)
    full = FAM.targets(cd, s).to_numpy()
    for k in (120, 400):
        trunc = {m: cd[m].iloc[: k + 1] for m in cd}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
