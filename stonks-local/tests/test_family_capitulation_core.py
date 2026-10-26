import random

import numpy as np
import pandas as pd

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["capitulation_core"]


def spec(markets=("BTC-EUR",), **params):
    p = {"ddLook": 3, "ddMin": 0.2, "volLen": 3, "volMult": 2.0, "maxHold": 2, "coreSma": 0, "scope": "own",
         **params}
    return normalize_spec({"family": "capitulation_core", "markets": list(markets), "interval": "4h", "params": p},
                          FAM)


def candles(closes, vols):
    df = bars([(x, x, x, x) for x in closes])
    df["volume"] = np.asarray(vols, dtype=np.float64)
    return df


# 10 bars: drop of 30 % at bar 4 on 5x volume, flat afterwards
CRASH = [10, 10, 10, 10, 7, 7, 7, 7, 7, 7]
VOL_SPIKE = [1, 1, 1, 1, 5, 1, 1, 1, 1, 1]
VOL_FLAT = [1] * 10


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
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
    assert set(FAM.markets_needed(spec(["BTC-EUR"], scope="pair"))) == {"BTC-EUR", "ETH-EUR"}
    assert set(FAM.markets_needed(spec(["ETH-EUR"], scope="btc"))) == {"BTC-EUR", "ETH-EUR"}
    assert set(FAM.markets_needed(spec(["ETH-EUR"]))) == {"ETH-EUR"}
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], coreSma=50, scope="pair"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_buys_capitulation_and_holds_max_hold_bars():
    w = FAM.targets({"BTC-EUR": candles(CRASH, VOL_SPIKE)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:3]).all()
    assert list(w[3:]) == [0, 1, 1, 0, 0, 0, 0]


def test_volume_filter_blocks_quiet_drop_and_zero_disables_it():
    w = FAM.targets({"BTC-EUR": candles(CRASH, VOL_FLAT)}, spec())["BTC-EUR"].to_numpy()
    assert (w[3:] == 0).all()
    w0 = FAM.targets({"BTC-EUR": candles(CRASH, VOL_FLAT)}, spec(volMult=0))["BTC-EUR"].to_numpy()
    # drawdown alone: bars 4 and 5 are 30 % under the 3-bar high; bar 5 restarts the 2-bar clock
    assert list(w0[2:]) == [0, 0, 1, 1, 1, 0, 0, 0]


def test_pair_scope_needs_both_in_drawdown():
    cd = {"BTC-EUR": candles(CRASH, VOL_SPIKE), "ETH-EUR": candles([10] * 10, VOL_SPIKE)}
    w = FAM.targets(cd, spec(scope="pair"))["BTC-EUR"].to_numpy()
    assert (w[3:] == 0).all()
    cd2 = {"BTC-EUR": candles(CRASH, VOL_FLAT), "ETH-EUR": candles(CRASH, VOL_SPIKE)}
    w2 = FAM.targets(cd2, spec(scope="pair"))["BTC-EUR"].to_numpy()
    assert list(w2[3:]) == [0, 1, 1, 0, 0, 0, 0]


def test_btc_scope_triggers_eth():
    cd = {"BTC-EUR": candles(CRASH, VOL_SPIKE), "ETH-EUR": candles([10] * 10, VOL_FLAT)}
    w = FAM.targets(cd, spec(["ETH-EUR"], scope="btc"))["ETH-EUR"].to_numpy()
    assert list(w[3:]) == [0, 1, 1, 0, 0, 0, 0]


def test_core_holds_uptrend():
    up = list(range(1, 11))
    w = FAM.targets({"BTC-EUR": candles(up, VOL_FLAT)}, spec(coreSma=3))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:3]).all() and (w[3:] == 1).all()
