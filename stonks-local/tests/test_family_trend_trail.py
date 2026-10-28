import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["trend_trail"]


def spec(**params):
    p = {"smaLen": 4, "drop": 0.12, "rise": 0.025, **params}
    return normalize_spec({"family": "trend_trail", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def weights(path, **params):
    return FAM.targets({"BTC-EUR": closes(path)}, spec(**params))["BTC-EUR"].to_numpy()


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"smaLen": 48, "drop": 0.05, "rise": 0.05}})
    ex = FAM.explain(spec(smaLen=480, drop=0.12, rise=0.025))
    assert "12" in ex["summary"] and len(ex["howItWorks"]) >= 3


def test_buys_above_the_average_sells_a_drop_and_the_bounce():
    # Four 100s wake the average. The spike to 200 is still above it. 170 is 15% off the peak and still
    # above the average, so the trail sells. 176 is a 3.5% bounce off 170 and still above the average.
    path = [100, 100, 100, 100, 200, 170, 176]
    w = weights(path)
    assert np.isnan(w[:4]).all()
    assert w[4] == 1
    assert w[5] == 0
    assert w[6] == 1


def test_a_close_under_the_average_sells_without_waiting_for_the_trail():
    path = [100, 100, 100, 100, 130, 90]
    w = weights(path)
    assert w[4] == 1
    assert w[5] == 0


def test_a_small_dip_stays_long():
    path = [100, 101, 102, 103, 110, 120, 130, 140, 130]
    w = weights(path, smaLen=4, drop=0.12, rise=0.025)
    assert w[4] == 1
    assert w[-1] == 1  # 130 is about 7% under 140, inside the 12% trail, and still above the average


def test_no_lookahead():
    path = [100 + i * 0.4 for i in range(30)] + [112, 100, 104, 108]
    full = weights(path)
    cut = weights(path[:20])
    assert np.array_equal(np.nan_to_num(full[:20]), np.nan_to_num(cut))
