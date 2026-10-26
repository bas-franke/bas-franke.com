import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["high_recency"]


def spec(markets=("BTC-EUR",), **params):
    p = {"coreSma": 3, "recentBars": 3, "nearPct": 0.0, "athLook": 0, "exitBand": 0.0, **params}
    return normalize_spec({"family": "high_recency", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {m: synth(900, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for _ in range(20):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.7
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.7 + 1e-12).all()
    for extra in ({"exitBand": 0.05, "athLook": 200, "nearPct": 0.1}, {"recentBars": 0}):
        ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], **extra))
        assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_holds_through_dip_after_new_high():
    c = [10, 10, 10, 12, 11, 10, 9, 8, 8]
    w = FAM.targets({"BTC-EUR": closes(c)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:2]).all()
    # i2 10 = SMA3 10 but a new high (10 = running max) -> in. i3 12 new high -> in.
    # i4 11 (high i3, 2 bars) in; i5 10 < SMA3 11 but high within 3 bars (i3..i5) -> in.
    # i6 9: last high i3 is 4 bars ago -> core: 9 < SMA 10 -> out. i7/i8 out.
    assert list(w[2:]) == [1, 1, 1, 1, 0, 0, 0]
    plain = FAM.targets({"BTC-EUR": closes(c)}, spec(recentBars=0))["BTC-EUR"].to_numpy()
    # plain SMA3: i2 10 = 10 no; i3 12 > 10.67 in; i4 11 = SMA 11 -> not under -> in; i5 10 < 11 out.
    assert list(plain[2:]) == [0, 1, 1, 0, 0, 0, 0]


def test_near_high_counts():
    c = [10, 10, 10, 12, 11, 11.5, 10.5, 10, 10]
    # nearPct 5 %: 11.5 >= 12 * 0.95 = 11.4 counts as a high at i5, so holding lasts to i7.
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(nearPct=0.05))["BTC-EUR"].to_numpy()
    assert list(w[2:]) == [1, 1, 1, 1, 1, 1, 0]
