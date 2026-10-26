import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["turtle_skip_a18"]


def spec(markets=("BTC-EUR",), **params):
    p = {"entry": 3, "exit": 2, "skip": True, "failsafe": 0, **params}
    return normalize_spec({"family": "turtle_skip_a18", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "entry": 60, "failsafe": 55}})
    rng = random.Random(4)
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
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], failsafe=10))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


# three breakouts: i3 (103 -> exit 100 at i7: a loser), i9 (107 -> exit 108 at i12: a winner), i14 (113)
SEQ = [100, 101, 102, 103, 104, 105, 106, 100, 99, 107, 110, 112, 108, 107, 113, 115, 109, 108]


def run(**kw):
    return FAM.targets({"BTC-EUR": closes(SEQ)}, spec(**kw))["BTC-EUR"].to_numpy()


def test_plain_breakout_control():
    w = run(skip=False)
    # warm-up 3 bars. i3 103 > 102 buy; held to i6; i7 100 < min(105,106) out; i8 out; i9 107 > max(106,100,99)
    # buy; i12 108 < min(110,112)=110 out (entry 107 -> exit 108: a winner);
    # i13 out; i14 113 > max(110,112,108)=112 buy; i16 109 < min(113,115) out; i17 out
    assert np.isnan(w[:3]).all()
    assert list(w[3:]) == [1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0]


def test_skip_after_a_winner():
    w = run(skip=True)
    # first breakout (no history) taken, loses (103 -> 100); second (i9) taken, wins (107 -> 108); third (i14) is
    # skipped but tracked on paper
    assert list(w[3:]) == [1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]


def test_failsafe_takes_the_long_breakout():
    w = run(skip=True, failsafe=6)
    # i14 113 > high of the previous 6 candles (112) -> the failsafe buys the skipped breakout
    assert w[14] == 1 and w[15] == 1 and w[16] == 0
