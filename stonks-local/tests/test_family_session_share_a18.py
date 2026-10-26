import random

import numpy as np
import pandas as pd

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["session_share_a18"]
H = 3_600_000
T0 = 1_600_000_000_000 - (1_600_000_000_000 % 86_400_000)   # midnight UTC


def spec(**params):
    p = {"sessStart": 12, "sessLen": 8, "shareLen": 5, "rankLen": 90, "side": "out_high", "thr": 0.8,
         "combine": "none", "coreLen": 10, **params}
    return normalize_spec({"family": "session_share_a18", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def hourly(days, heavy_from, heavy_to):
    """Flat price; the 12-20 UTC hours trade 10x volume on days heavy_from..heavy_to."""
    n = 24 * days
    ts = T0 + H * np.arange(n, dtype=np.int64)
    hour = (ts // H) % 24
    day = np.arange(n) // 24
    vol = np.ones(n)
    vol[(hour >= 12) & (hour < 20) & (day >= heavy_from) & (day <= heavy_to)] *= 10
    c = np.full(n, 100.0)
    return pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": vol}, index=pd.Index(ts, name="ts"))


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(24 * 500, 2, start=T0, step=H)}
    for _ in range(6):
        v = FAM.targets(cd, spec(**FAM.sample(rng)))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    assert len(FAM.explain(spec(combine="or"))["howItWorks"]) >= 3


def test_steps_out_when_session_share_spikes_and_decides_at_day_end():
    df = hourly(200, 150, 160)
    w = FAM.targets({"BTC-EUR": df}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:24 * 40]).all()
    assert w[24 * 149 + 23] == 1                 # day 149 decided: calm
    assert w[24 * 150 + 22] == 1                 # day 150 not decided before its 23:00 candle
    assert w[24 * 150 + 23] == 0                 # heavy session day -> out
    assert w[24 * 152 + 5] == 0
    w2 = FAM.targets({"BTC-EUR": df}, spec(side="in_high"))["BTC-EUR"].to_numpy()
    assert w2[24 * 149 + 23] == 0 and w2[24 * 151] == 1
