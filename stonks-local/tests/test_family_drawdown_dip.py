import random

import numpy as np
import pandas as pd

from _engine_util import H4, T0, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["drawdown_dip"]


def spec(**params):
    return normalize_spec({"family": "drawdown_dip", "markets": ["ETH-EUR"], "interval": "4h", "params": params}, FAM)


def closes(c):
    c = np.asarray(c, dtype=np.float64)
    return {"ETH-EUR": pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.ones(len(c))},
                                    index=pd.Index(T0 + H4 * np.arange(len(c), dtype=np.int64), name="ts"))}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None and not FAM.bot_ready
    rng = random.Random(3)
    cd = {"ETH-EUR": synth(1400, 2)}
    for _ in range(25):
        p = FAM.sample(rng)
        assert FAM.validate({"params": p}) is None, p
        for mw in (1.0, 0.5):
            s = spec(**p)
            s["risk"]["maxWeight"] = mw
            v = FAM.targets(cd, s)["ETH-EUR"].to_numpy()
            first = int(np.argmax(~np.isnan(v)))
            assert not np.isnan(v[first:]).any() and (v[first:] >= 0).all() and (v[first:] <= mw + 1e-12).all()
            assert first <= FAM.warmup(p)
    ex = FAM.explain(spec(regimeSma=50, maxHoldBars=10))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_buys_dip_sells_take_profit():
    # flat 100, drop to 85 (15 % below the high), rebound to 95 (+11.8 % over 85)
    c = [100] * 10 + [95, 90, 85, 88, 92, 95, 95, 95]
    w = FAM.targets(closes(c), spec(lookback=5, dipPct=0.12, takeProfitPct=0.1))["ETH-EUR"].to_numpy()
    assert (w[4:12] == 0).all()
    assert w[12] == 1.0 and w[13] == 1.0 and w[14] == 1.0  # 92 < 85 * 1.1 = 93.5
    assert (w[15:] == 0).all()


def test_time_stop_and_rearm():
    # drop and stay down: the time stop sells, and it must not re-buy while still in the dip zone
    c = [100] * 10 + [80] * 10 + [100] * 6 + [80] * 3
    w = FAM.targets(closes(c), spec(lookback=8, dipPct=0.1, takeProfitPct=0.5, maxHoldBars=3))["ETH-EUR"].to_numpy()
    assert w[10] == 1.0 and w[12] == 1.0 and w[13] == 0.0
    assert (w[13:20] == 0).all()
    assert w[26] == 1.0  # recovered above the zone, then a fresh dip re-arms and buys


def test_regime_gate():
    # long downtrend with a dip at the end: the rising-SMA gate blocks it, no gate buys it
    c = list(np.linspace(200, 100, 60)) + [85, 85]
    base = dict(lookback=5, dipPct=0.1, takeProfitPct=0.1)
    w0 = FAM.targets(closes(c), spec(**base))["ETH-EUR"].to_numpy()
    w1 = FAM.targets(closes(c), spec(regimeSma=20, regimeMode="rising", **base))["ETH-EUR"].to_numpy()
    assert w0[-1] == 1.0 and w1[-1] == 0.0
