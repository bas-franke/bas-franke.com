import random

import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["level_stop_a21"]
H1 = 3_600_000
T0 = 1_600_041_600_000 - (1_600_041_600_000 % 86_400_000)   # midnight UTC


def spec(**params):
    p = {"smaDays": 5, "band": 0.01, "mode": "both", "decideHour": 0, **params}
    return normalize_spec({"family": "level_stop_a21", "markets": ["BTC-EUR"], "interval": "1h", "params": p}, FAM)


def candles(path):
    c = np.asarray(path, dtype=float)
    o = np.concatenate([[c[0]], c[:-1]])
    rows = [(a, max(a, b) * 1.001, min(a, b) * 0.999, b) for a, b in zip(o, c)]
    return {"BTC-EUR": bars(rows, start=T0, step=H1)}


def path():
    # 10 flat days, 10 days rising, a sharp drop at hour 3 of day 20, then low
    flat = [100.0] * (24 * 10)
    rise = list(100 * np.exp(np.linspace(0.0, 0.3, 24 * 10)))
    drop = [rise[-1] * 0.7] * (24 * 10)
    return flat + rise + drop


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    assert sum(FAM.validate({"params": FAM.sample(rng)}) is None for _ in range(40)) == 40
    assert len(FAM.explain(spec())["howItWorks"]) >= 4


def test_buys_in_the_rise_and_sells_the_hour_of_the_drop():
    w = FAM.targets(candles(path()), spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[: 24 * 5 - 1]).all()
    assert (w[24 * 6: 24 * 10] == 0).all()                # flat: no band break
    assert (w[24 * 15: 24 * 20] == 1).all()               # rising: held
    assert w[24 * 20] == 0                                # first candle of the drop: sold at once


def test_exit_waits_for_the_decide_hour_in_daily_mode():
    w = FAM.targets(candles(path()), spec(mode="daily", decideHour=7))["BTC-EUR"].to_numpy()
    assert (w[24 * 15: 24 * 20] == 1).all()
    assert (w[24 * 20: 24 * 20 + 6] == 1).all()           # the drop at 00:00..05:00 closes is ignored
    assert w[24 * 20 + 6] == 0                            # the candle closing at 07:00 sells
    ws = FAM.targets(candles(path()), spec(mode="entry", decideHour=7))["BTC-EUR"].to_numpy()
    assert ws[24 * 20 + 5] == 1 and ws[24 * 20 + 6] == 0
    we = FAM.targets(candles(path()), spec(mode="exit", decideHour=7))["BTC-EUR"].to_numpy()
    assert we[24 * 20] == 0
