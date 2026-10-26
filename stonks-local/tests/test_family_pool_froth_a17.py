import random

import numpy as np
import pytest

from _engine_util import bars, synth
from stonks_lab import universe as uni
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["pool_froth_a17"]
AF = FAMILIES["alt_froth"]
DAY = 86_400_000


@pytest.fixture(autouse=True)
def _all_eligible(monkeypatch):
    monkeypatch.setattr(uni, "_TEST_ALL_ELIGIBLE", True)


def spec(markets=("BTC-EUR",), **params):
    p = {"lookback": 5, "threshold": 0.2, "band": 0.1, "pool": "pit", "universe": 10, "minPool": 1, **params}
    return normalize_spec({"family": "pool_froth_a17", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def daily(c, vol=1.0):
    df = bars([(x, x, x, x) for x in c], step=DAY)
    df["volume"] = vol
    return df


N = 200
FLAT = [10.0] * N
PUMP = [10.0] * 150 + [15.0] * 10 + [10.0] * 40     # +40 % log at bar 150, back down at 160


def test_contract_and_y2019_reproduces_alt_froth():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    for _ in range(10):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    names = ["BTC-EUR", "ETH-EUR", "XRP-EUR", "ADA-EUR", "LTC-EUR", "LINK-EUR"]
    cd = {m: synth(400, i + 1, step=DAY, vol=0.05, price=100 * (i + 1)) for i, m in enumerate(names)}
    for lb, thr in ((10, 0.05), (30, 0.1)):
        a = AF.targets(cd, normalize_spec({"family": "alt_froth", "markets": ["BTC-EUR", "ETH-EUR"], "interval": "1d",
                                           "params": {"lookback": lb, "threshold": thr, "band": 0.05, "minOut": 0,
                                                      "trendSma": 0}}, AF)).to_numpy()
        b = FAM.targets(cd, spec(["BTC-EUR", "ETH-EUR"], lookback=lb, threshold=thr, band=0.05, pool="y2019",
                                 minPool=3)).to_numpy()
        assert np.array_equal(np.isnan(a), np.isnan(b))
        assert np.allclose(np.nan_to_num(a), np.nan_to_num(b))
        assert (b[~np.isnan(b)] == 0).any()          # it does step aside sometimes
    assert {"BTC-EUR", "SOL-EUR", "XRP-EUR"} <= set(FAM.markets_needed(spec(["ETH-EUR"])))
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], pool="young"))
    assert ex["summary"] and len(ex["howItWorks"]) >= 5 and ex["whenItWins"] and ex["whenItLoses"]


def test_pit_pool_exits_on_pump_of_member_alts():
    cd = {"BTC-EUR": daily(FLAT, 100.0), "SOL-EUR": daily(PUMP), "DOGE-EUR": daily(PUMP)}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:5]).all()
    assert (w[5:150] == 1).all()
    assert (w[150:155] == 0).all()                    # spread ln 1.5 > 0.2 for 5 bars
    assert w[155] == 1                                # back to 0 < 0.1: buy back
    # no look-ahead: truncating the data leaves earlier decisions unchanged
    cut = {m: df.iloc[:152] for m, df in cd.items()}
    assert np.array_equal(FAM.targets(cut, spec())["BTC-EUR"].to_numpy(), w[:152], equal_nan=True)


def test_membership_by_turnover_and_young_pool():
    # universe 1: only the biggest-turnover coin (BTC) is a member -> no alt members -> hold through the pump
    cd = {"BTC-EUR": daily(FLAT, 100.0), "SOL-EUR": daily(PUMP), "DOGE-EUR": daily(PUMP)}
    w = FAM.targets(cd, spec(universe=1))["BTC-EUR"].to_numpy()
    assert (w[5:] == 1).all()
    # membership needs 90 days of turnover history: a pump before day 91 is ignored
    early = [10.0] * 40 + [15.0] * 10 + [10.0] * 150
    w2 = FAM.targets({"BTC-EUR": daily(FLAT, 100.0), "SOL-EUR": daily(early)}, spec())["BTC-EUR"].to_numpy()
    assert (w2[5:] == 1).all()
    # young pool ignores 2019 coins: an XRP pump exits "pit" but not "young"
    cd3 = {"BTC-EUR": daily(FLAT, 100.0), "XRP-EUR": daily(PUMP), "SOL-EUR": daily(FLAT)}
    assert (FAM.targets(cd3, spec(pool="pit"))["BTC-EUR"].to_numpy()[150:155] == 0).all()
    assert (FAM.targets(cd3, spec(pool="young"))["BTC-EUR"].to_numpy()[5:] == 1).all()
    # minPool: two members are too few at minPool 3 -> hold
    assert (FAM.targets(cd, spec(minPool=3))["BTC-EUR"].to_numpy()[5:] == 1).all()
