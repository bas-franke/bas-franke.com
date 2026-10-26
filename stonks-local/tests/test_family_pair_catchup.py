import numpy as np
import pandas as pd

from _engine_util import H4, T0
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["pair_catchup"]


def spec(**params):
    p = dict(FAM.default_params())
    p.update(params)
    return normalize_spec({"family": "pair_catchup", "markets": ["ETH-EUR"], "interval": "4h", "params": p}, FAM)


def df(c):
    c = np.asarray(c, dtype=np.float64)
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.ones(len(c))},
                        index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))


def test_buys_laggard_after_leader_jump_then_exits():
    btc = [100] * 10 + [102] * 10          # BTC +2 % at bar 10
    eth = [50] * 20                        # ETH flat
    w = FAM.targets({"ETH-EUR": df(eth), "BTC-EUR": df(btc)}, spec(lag=1, gapPct=1.0, hold=3, coreSma=0))["ETH-EUR"]
    w = w.to_numpy()
    assert (w[1:10] == 0).all()
    assert (w[10:13] == 1.0).all() and w[13] == 0.0


def test_leader_up_and_threshold():
    btc = [100] * 10 + [99.5] * 10         # BTC -0.5 %, ETH -3 %: gap 2.5 % but leader fell
    eth = [50] * 10 + [48.5] * 10
    cd = {"ETH-EUR": df(eth), "BTC-EUR": df(btc)}
    assert np.nansum(FAM.targets(cd, spec(lag=1, gapPct=1.0, hold=3, leaderUp=True))["ETH-EUR"].to_numpy()) == 0
    assert np.nansum(FAM.targets(cd, spec(lag=1, gapPct=1.0, hold=3, leaderUp=False))["ETH-EUR"].to_numpy()) == 3
    assert np.nansum(FAM.targets(cd, spec(lag=1, gapPct=3.0, hold=3, leaderUp=False))["ETH-EUR"].to_numpy()) == 0


def test_core_holds_above_sma():
    eth = list(np.linspace(50, 80, 40))
    btc = list(np.linspace(100, 160, 40))   # same % path: no gap
    w = FAM.targets({"ETH-EUR": df(eth), "BTC-EUR": df(btc)}, spec(coreSma=10, gapPct=1.0))["ETH-EUR"].to_numpy()
    assert (w[12:] == 1.0).all()
    assert FAM.required_markets(spec()) == ["BTC-EUR"]
    assert FAM.explain(spec(coreSma=50))["summary"]
