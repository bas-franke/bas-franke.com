import numpy as np
import pandas as pd

from _engine_util import H4, T0
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["streak_ride"]


def spec(**params):
    p = dict(FAM.default_params())
    p.update(params)
    return normalize_spec({"family": "streak_ride", "markets": ["BTC-EUR"], "interval": "4h", "params": p}, FAM)


def cd(closes):
    c = np.asarray(closes, dtype=np.float64)
    df = pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": np.ones(len(c))},
                      index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))
    return {"BTC-EUR": df}


def test_buys_after_streak_and_holds():
    # flat, then 3 up closes (streak 3), then flat
    c = [100] * 5 + [101, 102, 103] + [103] * 10
    w = FAM.targets(cd(c), spec(streak=3, hold=4, exitDown=0, trendSma=0))["BTC-EUR"].to_numpy()
    assert (w[:7] == 0).all() or np.isnan(w[:3]).all()
    assert w[7] == 1.0                        # third up close -> buy at that close
    assert (w[7:11] == 1.0).all() and w[11] == 0.0   # 4 candles held, then out


def test_restart_and_early_exit():
    c = [100] * 5 + [101, 102, 103, 104, 105] + [104, 103, 102] + [102] * 5
    s = spec(streak=3, hold=10, exitDown=2, trendSma=0)
    w = FAM.targets(cd(c), s)["BTC-EUR"].to_numpy()
    assert w[7] == 1.0 and w[9] == 1.0
    assert w[10] == 1.0 and w[11] == 0.0      # second consecutive down close sells


def test_trend_filter_blocks_entry():
    c = list(np.linspace(200, 100, 40)) + [101, 102, 103] + [103] * 5
    w = FAM.targets(cd(c), spec(streak=3, hold=4, trendSma=30))["BTC-EUR"].to_numpy()
    assert np.nansum(w) == 0


def test_explain():
    ex = FAM.explain(spec(exitDown=3, trendSma=50))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3
