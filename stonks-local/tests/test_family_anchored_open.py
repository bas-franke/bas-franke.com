import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["anchored_open"]
DAY = 86_400_000
JAN1 = 1_609_459_200_000          # 2021-01-01 00:00 UTC (a Friday)


def spec(markets=("BTC-EUR",), **params):
    p = {"useWeek": False, "useMonth": True, "useQuarter": False, "useYear": False,
         "anchor": "current", "minVotes": 1, "band": 0.0, **params}
    return normalize_spec({"family": "anchored_open", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def daily(opens_closes):
    return bars([(o, max(o, c), min(o, c), c) for o, c in opens_closes], start=JAN1, step=DAY)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    bad = dict(FAM.default_params(), useWeek=False, useMonth=False, useQuarter=False, useYear=False)
    assert FAM.validate({"params": bad}) is not None
    rng = random.Random(3)
    cd = {m: synth(900, i + 1, start=JAN1, step=DAY, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    ok = 0
    for _ in range(40):
        p = FAM.sample(rng)
        if FAM.validate({"params": p}) is not None:
            continue
        ok += 1
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        assert rows.any()
        first = int(np.argmax(rows))
        assert not np.isnan(v[first:]).any()
        assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    assert ok >= 10
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], useWeek=True, minVotes=2, band=0.02, anchor="previous"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_monthly_open():
    # January (31 days, partial first period: undecided), February opens at 50.
    rows = [(100, 100)] * 31 + [(50, 55), (55, 49), (49, 52), (52, 48)]
    w = FAM.targets({"BTC-EUR": daily(rows)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:31]).all()
    assert list(w[31:]) == [1, 0, 1, 0]
    # previous anchor: February compares with January's open, which is unknown (partial) -> still undecided
    w2 = FAM.targets({"BTC-EUR": daily(rows)}, spec(anchor="previous"))["BTC-EUR"].to_numpy()
    assert np.isnan(w2).all()
    # band 5 %: needs > 52.5 to turn up, < 47.5 to turn down
    w3 = FAM.targets({"BTC-EUR": daily(rows)}, spec(band=0.05))["BTC-EUR"].to_numpy()
    assert list(w3[31:]) == [1, 1, 1, 1]


def test_previous_anchor_and_votes():
    # Jan partial, Feb opens 10 (28 days), March opens 20.
    rows = [(5, 5)] * 31 + [(10, 12)] * 28 + [(20, 15), (15, 25)]
    w = FAM.targets({"BTC-EUR": daily(rows)}, spec(anchor="previous"))["BTC-EUR"].to_numpy()
    assert np.isnan(w[:59]).all()          # Feb's previous (Jan) unknown
    assert list(w[59:]) == [1, 1]          # March vs Feb open 10: 15 > 10, 25 > 10
    wc = FAM.targets({"BTC-EUR": daily(rows)}, spec())["BTC-EUR"].to_numpy()
    assert list(wc[59:]) == [0, 1]         # March vs March open 20
    # two votes (month current + week current): 2021-03-01 is a Monday, week open 20 as well
    wv = FAM.targets({"BTC-EUR": daily(rows)}, spec(useWeek=True, minVotes=2))["BTC-EUR"].to_numpy()
    assert list(wv[59:]) == [0, 1]


def test_no_lookahead():
    cd = {m: synth(900, i + 1, start=JAN1, step=DAY / 2, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    s = spec(["BTC-EUR", "ETH-EUR"], useWeek=True, useQuarter=True, minVotes=2, band=0.01)
    full = FAM.targets(cd, s).to_numpy()
    rng = np.random.default_rng(5)
    for k in (300, 650):
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
