import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["underwater_a04"]
D = 86_400_000


def spec(**params):
    p = {"look": 20, "suMin": 0.8, "holdBars": 3, "weighting": "volume", "coreSma": 0, **params}
    return normalize_spec({"family": "underwater_a04", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def closes(c, vol=None):
    df = bars([(x, x, x, x) for x in c], step=D)
    if vol is not None:
        df["volume"] = np.asarray(vol, dtype=np.float64)
    return df


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(1)
    cd = {"BTC-EUR": synth(900, 3, step=D)}
    for _ in range(12):
        s = spec(**FAM.sample(rng))
        v = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
        assert set(np.unique(v[ok])) <= {0.0, 1.0}
        assert FAM.explain(s)["summary"]


def test_buys_when_turnover_under_water():
    up = [100.0 + i for i in range(40)]
    down = [139.0 - 3 * i for i in range(1, 11)]
    c = up + down + [110.0] * 30
    w = FAM.targets({"BTC-EUR": closes(c)}, spec())["BTC-EUR"].to_numpy()
    assert (w[20:40] == 0).all()              # rising: nobody under water
    assert w[45:50].max() == 1                # slide: most of the last 20 days traded higher
    assert w[-1] == 0                          # flat long enough: the underwater days roll out


def test_volume_weighting_differs_from_equal():
    # 20-day window: 5 heavy-volume days at 200, then 15 light days at 100..114, then close 150
    c = [200.0] * 5 + [100.0 + i for i in range(15)] + [150.0]
    vol = [100.0] * 5 + [1.0] * 15 + [1.0]
    df = closes(c, vol)
    from stonks_lab.families.underwater_a04 import underwater_share
    sv, se = underwater_share(df, 20, "volume"), underwater_share(df, 20, "equal")
    assert sv[-1] > 0.9 and se[-1] < 0.3        # euros say most buyers are under water, day count says few


def test_core_or_buy():
    c = synth(500, 5, step=D)["close"].to_numpy()
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(coreSma=20, suMin=0.99))["BTC-EUR"].to_numpy()
    sma = np.convolve(c, np.ones(20) / 20, mode="valid")
    core = (c[19:] > sma).astype(float)
    ok = np.isfinite(w[19:])
    assert (w[19:][ok] >= core[ok]).all()


def test_no_lookahead():
    df = synth(600, 8, step=D)
    df["volume"] = np.random.default_rng(2).uniform(1, 10, len(df))
    rng = random.Random(4)
    for _ in range(5):
        s = spec(**{**FAM.sample(rng), "look": 60})
        full = FAM.targets({"BTC-EUR": df}, s)["BTC-EUR"]
        for cut in (300, 451, 577):
            part = FAM.targets({"BTC-EUR": df.iloc[:cut]}, s)["BTC-EUR"]
            a, b = full.loc[part.index].to_numpy(), part.to_numpy()
            assert np.array_equal(np.isnan(a), np.isnan(b)) and np.allclose(a[~np.isnan(a)], b[~np.isnan(b)])


def test_day_hour_on_hourly_candles():
    H = 3_600_000
    h = synth(24 * 200, 12, step=H, vol=0.004)
    s1 = normalize_spec({"family": "underwater_a04", "markets": ["BTC-EUR"], "interval": "1h",
                         "params": {"look": 30, "suMin": 0.7, "holdBars": 5, "weighting": "volume",
                                    "coreSma": 20, "dayHour": 5}}, FAM)
    w = FAM.targets({"BTC-EUR": h}, s1)["BTC-EUR"].dropna()
    assert len(w) > 100 and (((w.index.to_numpy() // H) % 24) == 4).all()
