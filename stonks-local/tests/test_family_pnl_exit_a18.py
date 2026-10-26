import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["pnl_exit_a18"]


def spec(markets=("BTC-EUR",), **params):
    p = {"enterLen": 2, "winLen": 4, "gain": 0.1, "state": "peak", **params}
    return normalize_spec({"family": "pnl_exit_a18", "markets": list(markets), "interval": "1d", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "enterLen": 100, "winLen": 50}})
    rng = random.Random(3)
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
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"]))
    assert ex["summary"] and len(ex["howItWorks"]) >= 4 and ex["whenItWins"] and ex["whenItLoses"]


# i3 buys at 101 (above SMA2); run to 120 (+19 %: a winner); the i6-i7 dip is under SMA2 but above the slower
# SMA4, so the winner is kept
WIN = [100, 100, 100, 101, 110, 120, 118, 117, 119, 104, 103]


def test_winner_rides_out_a_dip_and_loser_is_cut():
    w = FAM.targets({"BTC-EUR": closes(WIN)}, spec())["BTC-EUR"].to_numpy()
    # SMA4 is defined from i3. i3 101 > SMA2 100 -> buy (entry 101). i5 120 = winner (+18.8 %).
    # i6 118 < SMA2 119 but > SMA4 (110+120+118+101)/4 = 112.25 -> still held; i7 117 < SMA2 but > SMA4 116.25: held
    # i9 104 < SMA4 (118+117+119+104)/4 = 114.5 -> out; i10 103 < SMA2 103.5 -> stays out
    assert np.isnan(w[:3]).all()
    assert list(w[3:]) == [1, 1, 1, 1, 1, 1, 0, 0]
    # plain core (winLen = enterLen): i6 118 < SMA2 119 -> out at i6, i8 119 > SMA2 117.5 -> back in, i9 out
    base = FAM.targets({"BTC-EUR": closes(WIN)}, spec(winLen=2))["BTC-EUR"].to_numpy()
    assert list(base[1:]) == [0, 0, 1, 1, 1, 0, 0, 1, 0, 0]


LOSE = [100, 100, 100, 101, 102, 100, 99]


def test_losing_trade_exits_on_the_entry_average():
    w = FAM.targets({"BTC-EUR": closes(LOSE)}, spec())["BTC-EUR"].to_numpy()
    # i3 buy at 101; i4 102 (+1 %, not a winner); i5 100 < SMA2 101 -> out at once
    assert list(w[3:]) == [1, 1, 0, 0]


def test_current_state_forgets_the_peak():
    # i3 buy 101; i4 120 winner; i5 112 is +10.9 % (still >= 10 %): under SMA2 116 but above SMA4 108.25 -> held;
    # i6 110 is +8.9 %: no longer a winner under 'current' -> under SMA2 111 -> out
    c = [100, 100, 100, 101, 120, 112, 110.9]
    cur = FAM.targets({"BTC-EUR": closes(c)}, spec(state="current"))["BTC-EUR"].to_numpy()
    peak = FAM.targets({"BTC-EUR": closes(c)}, spec(state="peak"))["BTC-EUR"].to_numpy()
    assert list(cur[3:]) == [1, 1, 1, 0]
    # peak: SMA4 at i6 = (101+120+112+110.9)/4 = 110.975 > 110.9 -> out too; so compare at a higher close
    c2 = [100, 100, 100, 101, 120, 112, 111.05]
    cur2 = FAM.targets({"BTC-EUR": closes(c2)}, spec(state="current"))["BTC-EUR"].to_numpy()
    peak2 = FAM.targets({"BTC-EUR": closes(c2)}, spec(state="peak"))["BTC-EUR"].to_numpy()
    assert list(cur2[3:]) == [1, 1, 1, 0]       # +9.95 % -> not a winner -> under SMA2 111.5 -> out
    assert list(peak2[3:]) == [1, 1, 1, 1]      # peak winner -> SMA4 111.01 < 111.05 -> held
    assert peak[3] == 1
