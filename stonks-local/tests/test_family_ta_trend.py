import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["ta_trend"]


def spec(**params):
    p = {"indicator": "macd", "n": 20, "thr": 0.0, **params}
    return normalize_spec({"family": "ta_trend", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def closes(path):
    return bars([(x, x * 1.002, x * 0.998, x) for x in path])


def weights(path, **params):
    return FAM.targets({"BTC-EUR": closes(path)}, spec(**params))["BTC-EUR"].to_numpy()


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    ex = FAM.explain(spec(n=600))
    assert "MACD" in ex["summary"] or "MACD" in ex["howItWorks"][0]
    assert len(ex["howItWorks"]) >= 3


def test_a_long_rise_ends_long_and_a_long_fall_ends_flat():
    up = [100 * (1.002 ** i) for i in range(80)]
    w = weights(up, n=12, thr=0.0)
    assert np.isfinite(w).any()
    assert w[-1] == 1
    down = up + [up[-1] * (0.99 ** i) for i in range(1, 40)]
    w2 = weights(down, n=12, thr=0.0)
    assert w2[-1] == 0


def test_no_lookahead():
    path = [100 * (1.001 ** i) for i in range(60)] + [100 * (1.001 ** 59) * (0.995 ** i) for i in range(1, 20)]
    full = weights(path, n=10)
    cut = weights(path[:40], n=10)
    assert np.array_equal(np.nan_to_num(full[:40]), np.nan_to_num(cut))
