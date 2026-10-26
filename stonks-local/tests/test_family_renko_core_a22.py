import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["renko_core_a22"]


def spec(markets=("BTC-EUR",), **params):
    p = {"mode": "pct", "brickPct": 0.1, "brickAtr": 2.0, "atrLen": 14, "reversal": 2, "trendSma": 0,
         "offWeight": 0.0, **params}
    return normalize_spec({"family": "renko_core_a22", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


C = [100, 111, 105, 92, 90, 95, 111]


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
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
    for extra in ({"mode": "atr", "trendSma": 50, "offWeight": 0.3}, {}):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], **extra))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_two_brick_reversal():
    w = FAM.targets({"BTC-EUR": closes(C)}, spec())["BTC-EUR"].to_numpy()
    # 111: first up brick (top 110); 105 and 92 stay above 110/1.21 = 90.9; 90 flips down (bottom 90.9);
    # 95 is not 2 bricks above 90.9 (needs 110); 111 flips up again.
    assert list(w) == [0, 1, 1, 1, 0, 0, 1]


def test_one_brick_reversal_and_off_weight():
    w = FAM.targets({"BTC-EUR": closes(C)}, spec(reversal=1, offWeight=0.25))["BTC-EUR"].to_numpy()
    # reversal 1: 92 <= 100 (one brick under the top 110) flips down already
    assert list(w) == [0.25, 1, 1, 0.25, 0.25, 0.25, 1]


def test_sma_gate_blocks_entry():
    w = FAM.targets({"BTC-EUR": closes([100] * 5 + [50, 60, 70, 80])}, spec(trendSma=5, brickPct=0.1))["BTC-EUR"]
    v = w.to_numpy()
    # 60 / 70 / 80 rise >= 2 bricks off the low (renko up from 70 on) but stay under the 5-bar SMA until 80? SMA(5)
    # at 80 = (100+50+60+70+80)/5 = 72 -> buy only there
    assert v[-1] == 1 and v[-2] == 0


def test_no_lookahead():
    full = FAM.targets({"BTC-EUR": closes(C)}, spec())["BTC-EUR"].to_numpy()
    for t in range(1, len(C)):
        part = FAM.targets({"BTC-EUR": closes(C[: t + 1])}, spec())["BTC-EUR"].to_numpy()
        np.testing.assert_array_equal(part, full[: t + 1])


def test_multi_market_split():
    up = closes([10, 12, 13, 14])
    flat = closes([10, 10, 10, 10])
    df = FAM.targets({"BTC-EUR": up, "ETH-EUR": flat}, spec(["BTC-EUR", "ETH-EUR"]))
    assert list(df["BTC-EUR"].to_numpy()[1:]) == [0.5, 0.5, 0.5]
    assert (df["ETH-EUR"].to_numpy() == 0).all()
