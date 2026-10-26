import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["vol_panic_core"]
# calm +-1 % wiggle, then a crash: big swings with a falling price at i=12..13
CALM = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101]
CRASH = CALM + [80, 70, 75, 76, 77, 78, 79, 80, 81, 82]


def spec(markets=("BTC-EUR",), **params):
    p = {"coreType": "sma", "coreLen": 0, "coreBand": 0.0, "source": "own", "volShort": 2, "volLong": 8,
         "volRatio": 1.4, "dropLook": 2, "dropMin": 0.1, "holdBars": 3, **params}
    return normalize_spec({"family": "vol_panic_core", "markets": list(markets), "interval": "4h", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "volShort": 30, "volLong": 40}})
    rng = random.Random(5)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
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
    assert set(FAM.markets_needed(spec(["BTC-EUR"], source="both"))) == {"BTC-EUR", "ETH-EUR"}
    assert set(FAM.markets_needed(spec(["ETH-EUR"]))) == {"ETH-EUR"}
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], coreLen=50, coreType="ema", coreBand=0.02, source="both"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_own_panic_buys_and_holds_fixed_time():
    w = FAM.targets({"BTC-EUR": closes(CRASH)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:8]).all() and (w[8:12] == 0).all()
    assert w[12] == 1                  # first crash bar: vol spike + -20 % over 2 bars
    assert list(w[12:16]) == [1, 1, 1, 0]   # held 3 bars, then out (no new panic: price rising)
    assert (w[16:] == 0).all()


def test_rising_spike_is_not_a_panic():
    up = CALM + [120, 140, 135, 136, 137, 138, 139, 140, 141, 142]
    w = FAM.targets({"BTC-EUR": closes(up)}, spec(dropMin=0.0))["BTC-EUR"].to_numpy()
    assert (w[8:] == 0).all()


def test_both_source_needs_btc_and_eth():
    flat = closes(CALM + CALM[:10])
    w = FAM.targets({"BTC-EUR": closes(CRASH), "ETH-EUR": flat}, spec(source="both"))["BTC-EUR"].to_numpy()
    assert (w[8:] == 0).all()
    w2 = FAM.targets({"BTC-EUR": closes(CRASH), "ETH-EUR": flat}, spec(source="any"))["BTC-EUR"].to_numpy()
    assert w2[12] == 1
    w3 = FAM.targets({"BTC-EUR": flat, "ETH-EUR": closes(CRASH)}, spec(["BTC-EUR"], source="both"))
    assert (w3["BTC-EUR"].to_numpy()[8:] == 0).all()


def test_core_sma_ema_and_band():
    up = list(range(1, 21))
    for t in ("sma", "ema"):
        w = FAM.targets({"BTC-EUR": closes(up)}, spec(coreLen=3, coreType=t))["BTC-EUR"].to_numpy()
        assert (w[8:] == 1).all()
    # band: a dip just under the SMA does not switch the core off
    path = list(range(1, 21)) + [18.0, 18.1, 18.2]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec(coreLen=4, coreBand=0.05))["BTC-EUR"].to_numpy()
    assert w[20] == 1
    w0 = FAM.targets({"BTC-EUR": closes(path)}, spec(coreLen=4))["BTC-EUR"].to_numpy()
    assert w0[20] == 0
