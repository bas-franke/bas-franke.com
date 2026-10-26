import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["breadth_era"]
DIP = [10, 11, 12, 11, 10, 9, 10, 11, 12, 13]   # RSI(2) from i=2: 100, 50, 25, 12.5, 56.25, 78.1, ...
DAY = 86_400_000


def spec(markets=("BTC-EUR",), **params):
    p = {"rsiPeriod": 2, "rsiBelow": 30, "breadthMin": 0.6, "sellAbove": 70, "maxHold": 0, "coreSma": 0,
         "breadthList": "y2020", **params}
    return normalize_spec({"family": "breadth_era", "markets": list(markets), "interval": "4h", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_lists():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {m: synth(700, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", "XRP-EUR", "LTC-EUR"])}
    for _ in range(15):
        p = {**FAM.sample(rng), "breadthList": "y2020"}
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    assert set(FAM.markets_needed(spec())) >= {"BCH-EUR", "LTC-EUR", "XLM-EUR"}
    assert "SOL-EUR" not in FAM.markets_needed(spec())
    assert "SOL-EUR" in FAM.markets_needed(spec(breadthList="today"))
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], maxHold=10, coreSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


def test_y2020_list_ignores_today_coins():
    # SOL is oversold with BTC but is not on the 2020 list; ETH/XRP flat -> only 1 of 3 voters oversold
    cd = {"BTC-EUR": closes(DIP), "SOL-EUR": closes(DIP), "ETH-EUR": closes([10] * 10), "XRP-EUR": closes([10] * 10)}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert (w[2:] == 0).all()
    cd["ETH-EUR"] = closes(DIP)
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert list(w[2:]) == [0, 0, 1, 1, 1, 0, 0, 0]


def test_pit_only_members_vote(monkeypatch):
    import stonks_lab.families.breadth_era as be
    monkeypatch.setattr(be, "_voters", lambda p, iv: ["BTC-EUR", "ETH-EUR", "XRP-EUR", "LTC-EUR"])
    cd = {m: closes(DIP) for m in ["BTC-EUR", "ETH-EUR", "XRP-EUR"]}
    cd["LTC-EUR"] = closes([10] * 10)          # never oversold
    d0 = int(cd["BTC-EUR"].index[0]) // DAY * DAY - 120 * DAY

    def daily_with(ltc_traded):
        out = {}
        for m in ["BTC-EUR", "ETH-EUR", "XRP-EUR", "LTC-EUR"]:
            if m == "LTC-EUR" and not ltc_traded:
                out[m] = None                  # no turnover history: not a member
                continue
            d = bars([(1, 1, 1, 1)] * 125, start=d0, step=DAY)
            out[m] = d
        return out

    s = spec(breadthList="pit", breadthMin=0.9)
    w = be.targets(cd, s, daily=daily_with(False))["BTC-EUR"].to_numpy()
    assert list(w[2:]) == [0, 0, 1, 1, 1, 0, 0, 0]     # 3 of 3 members oversold
    w = be.targets(cd, s, daily=daily_with(True))["BTC-EUR"].to_numpy()
    assert (w[2:] == 0).all()                          # LTC is a member: 3 of 4 = 75 % < 90 %


def test_reproduces_breadth_dip_with_today_list():
    cd = {m: synth(600, i + 1, price=50 * (i + 1)) for i, m in enumerate(
        ["BTC-EUR", "ETH-EUR", "XRP-EUR", "SOL-EUR", "ADA-EUR"])}
    p = {"rsiPeriod": 6, "rsiBelow": 35, "breadthMin": 0.5, "sellAbove": 65, "maxHold": 20, "coreSma": 40}
    a = FAMILIES["breadth_dip"].targets(cd, normalize_spec(
        {"family": "breadth_dip", "markets": ["BTC-EUR"], "interval": "4h", "params": p}, FAMILIES["breadth_dip"]))
    b = FAM.targets(cd, spec(**p, breadthList="today"))
    np.testing.assert_array_equal(a.to_numpy(), b.to_numpy())
