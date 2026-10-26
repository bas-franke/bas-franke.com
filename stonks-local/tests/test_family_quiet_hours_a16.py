import numpy as np
import pandas as pd

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["quiet_hours_a16"]
QC = FAMILIES["quiet_core_a16"]
H = 3_600_000
D = 86_400_000
P = {"coreLen": 20, "volLen": 5, "rankLen": 30, "quietQ": 0.3, "exitQ": 0.0, "side": "low"}


def test_hour_zero_matches_native_daily():
    h1 = synth(24 * 120, 3, start=1_600_000_000_000 - 1_600_000_000_000 % D, step=H, vol=0.004)
    s = normalize_spec({"family": "quiet_hours_a16", "markets": ["BTC-EUR"], "interval": "1h",
                        "params": {**P, "hour": 0}}, FAM)
    w = FAM.targets({"BTC-EUR": h1}, s)["BTC-EUR"]
    key = h1.index // D
    g = h1.groupby(key)
    daily = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
                          "close": g["close"].last(), "volume": g["volume"].sum()})
    daily.index = pd.Index(daily.index.to_numpy() * D, name="ts")
    sd = normalize_spec({"family": "quiet_core_a16", "markets": ["BTC-EUR"], "interval": "1d", "params": P}, QC)
    nd = QC.targets({"BTC-EUR": daily}, sd)["BTC-EUR"].to_numpy()
    dec = w.dropna()
    # decisions land on each day's last hour, one per day, equal to the native daily targets
    assert ((dec.index.to_numpy() % D) == 23 * H).all()
    native = pd.Series(nd, index=daily.index.to_numpy() + 23 * H).dropna()
    pd.testing.assert_series_equal(dec, native, check_names=False, check_index_type=False)
    assert FAM.explain(s)["summary"]
