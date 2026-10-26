import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["thrust_a03"]


def spec(markets=("BTC-EUR",), **params):
    p = {"coreSma": 3, "n": 1, "k": 2.0, "volLen": 4, "buyBelow": True, "holdBars": 3,
         "sellAbove": False, "outBars": 2, **params}
    return normalize_spec({"family": "thrust_a03", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "buyBelow": False, "sellAbove": False}})
    rng = random.Random(5)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
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
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], sellAbove=True))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


# alternating wiggles (sigma ~1.6 %), a falling trend, then one +10 % candle that starts below the 3-SMA
DOWN = [100, 98, 99, 97, 98, 96, 97, 95, 96, 94, 103.4, 97, 95, 93, 91, 89]


def test_thrust_below_buys_early_and_holds():
    w = FAM.targets({"BTC-EUR": closes(DOWN)}, spec(volLen=6))["BTC-EUR"].to_numpy()
    # sigma (before the run) defined from i7; falling = out; i10 +10 % jump from below the SMA: buy, held for
    # 3 candles (i10..i12) although i11/i12 are back under the SMA, then out
    assert np.isnan(w[:7]).all()
    assert list(w[7:]) == [0, 0, 0, 1, 1, 1, 0, 0, 0]
    # without the early buy only the core holds i10 (close above its SMA)
    off = FAM.targets({"BTC-EUR": closes(DOWN)}, spec(volLen=6, buyBelow=False, sellAbove=True))["BTC-EUR"]
    assert list(off.to_numpy()[7:]) == [0, 0, 0, 1, 0, 0, 0, 0, 0]


UP = [100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 116.6, 118, 117, 119, 118, 120]


def test_thrust_above_steps_out():
    sp = spec(coreSma=0, volLen=6, buyBelow=False, sellAbove=True)
    w = FAM.targets({"BTC-EUR": closes(UP)}, sp)["BTC-EUR"].to_numpy()
    # no core = hold; i10 +10 % surge: out for 2 candles (i10, i11), then back in
    assert list(w[7:]) == [1, 1, 1, 0, 0, 1, 1, 1, 1]
    big = FAM.targets({"BTC-EUR": closes(UP)}, spec(coreSma=0, volLen=6, buyBelow=False, sellAbove=True, k=8.0))
    assert (big["BTC-EUR"].to_numpy()[7:] == 1).all()
