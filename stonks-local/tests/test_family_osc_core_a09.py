import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["osc_core_a09"]
H = 3_600_000


def spec(interval="1d", **params):
    p = {"osc": "rsi", "len": 3, "smooth": 1, "onLevel": 60.0, "offLevel": 40.0, "gateSma": 0, "dayHour": 0,
         **params}
    return normalize_spec({"family": "osc_core_a09", "markets": ["BTC-EUR"], "interval": interval, "params": p}, FAM)


def closes(c, step=86_400_000):
    return bars([(x, x, x, x) for x in c], step=step)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "onLevel": 50, "offLevel": 55}})
    assert FAM.validate({"params": {**FAM.default_params(), "osc": "none", "gateSma": 0}})
    rng = random.Random(5)
    cd = {"BTC-EUR": synth(700, 3)}
    for _ in range(12):
        s = spec(**FAM.sample(rng))
        v = FAM.targets(cd, s)["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
        assert set(np.unique(v[ok])) <= {0.0, 1.0}
        assert FAM.explain(s)["summary"]


def test_rsi_regime_buys_in_rally_sells_in_fall_with_hysteresis():
    path = [10, 10.5, 10.2, 10.4] + [10.4 + 0.5 * i for i in range(1, 9)] + [14.4 - 0.6 * i for i in range(1, 9)]
    w = FAM.targets({"BTC-EUR": closes(path)}, spec())["BTC-EUR"].to_numpy()
    assert (w[6:12] == 1).all()     # steady rally: RSI ~100
    assert (w[-4:] == 0).all()      # steady fall: RSI ~0
    # one small down close inside the rally keeps the position (RSI stays above offLevel)
    path2 = [10, 10.5, 10.2, 10.4, 11, 11.5, 12, 11.9, 12.5, 13]
    w2 = FAM.targets({"BTC-EUR": closes(path2)}, spec())["BTC-EUR"].to_numpy()
    assert w2[7] == 1 and w2[9] == 1


def test_none_is_plain_sma_core():
    c = synth(300, 9)["close"].to_numpy()
    w = FAM.targets({"BTC-EUR": closes(c)}, spec(osc="none", gateSma=20))["BTC-EUR"].to_numpy()
    sma = np.convolve(c, np.ones(20) / 20, mode="valid")
    np.testing.assert_array_equal(w[19:], (c[19:] > sma).astype(float))


def test_stoch_and_cci_follow_trend():
    path = [10 + 0.3 * i for i in range(30)] + [19 - 0.4 * i for i in range(30)]
    for osc in ("stoch", "cci"):
        w = FAM.targets({"BTC-EUR": closes(path)}, spec(osc=osc, len=5))["BTC-EUR"].to_numpy()
        assert w[25] == 1 and w[-1] == 0, osc


def test_day_hour_decides_once_a_day_at_that_hour():
    c = synth(24 * 60, 4, step=H)
    s = spec(interval="1h", dayHour=7, len=5)
    w = FAM.targets({"BTC-EUR": c}, s)["BTC-EUR"]
    dec = w.dropna()
    assert len(dec) > 30
    hours = ((dec.index.to_numpy() // H) % 24)
    assert (hours == 6).all()       # a day opening at 07:00 closes with the 06:00 hourly candle


def test_no_lookahead():
    rng = random.Random(11)
    for interval, step, n in (("1d", 86_400_000, 400), ("1h", H, 24 * 80)):
        df = synth(n, 6, step=step)
        for _ in range(4):
            s = spec(interval=interval, **{**FAM.sample(rng), "len": 10, "gateSma": 0})
            full = FAM.targets({"BTC-EUR": df}, s)["BTC-EUR"]
            for cut in (n // 2, n // 2 + 7, n - 30):
                part = FAM.targets({"BTC-EUR": df.iloc[:cut]}, s)["BTC-EUR"]
                a, b = full.loc[part.index].to_numpy(), part.to_numpy()
                assert np.array_equal(np.isnan(a), np.isnan(b)) and np.allclose(a[~np.isnan(a)], b[~np.isnan(b)])
