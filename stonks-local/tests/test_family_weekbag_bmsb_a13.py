import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.weekbag_bmsb_a13 import tranche, weekday_of

FAM = FAMILIES["weekbag_bmsb_a13"]
D = 86_400_000
T0 = 1_600_041_600_000  # 2020-09-14 00:00 UTC, a Monday


def wavy(n, seed=1):
    """Daily candles swinging +-40 % every ~300 days: crosses a 20-week band a few times."""
    df = synth(n, seed, start=T0, step=D, drift=0.0, vol=0.01)
    f = np.exp(0.4 * np.sin(2 * np.pi * np.arange(n) / 300))
    for col in ("open", "high", "low", "close"):
        df[col] = df[col].to_numpy() * f
    return df


def spec(markets=("BTC-EUR",), **params):
    p = {**FAM.default_params(), **params}
    return normalize_spec({"family": "weekbag_bmsb_a13", "markets": list(markets), "interval": "1d", "params": p},
                          FAM)


def test_contract_and_weekday():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {**FAM.default_params(), "phases": 3}})
    assert weekday_of(np.array([T0, T0 + 6 * D]))[0] == 0 and weekday_of(np.array([T0 + 6 * D]))[0] == 6
    ex = FAM.explain(spec(markets=("BTC-EUR", "ETH-EUR")))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3


def test_single_clock_buys_above_band_sells_below_and_decides_weekly():
    df = wavy(1200, seed=4)
    w = FAM.targets({"BTC-EUR": df}, spec(phases=1, weekday=2))["BTC-EUR"].to_numpy()
    ts = np.asarray(df.index)
    dec = np.flatnonzero(np.isfinite(w))
    assert len(dec) > 50 and (weekday_of(ts[dec]) == 2).all()
    assert set(w[dec]) == {0.0, 1.0}
    # check against a hand computation on the Wednesday closes
    c = df["close"].to_numpy()
    wc = c[dec]
    sma = np.array([wc[max(0, k - 19):k + 1].mean() if k >= 19 else np.nan for k in range(len(wc))])
    for k in range(len(wc)):
        if np.isfinite(sma[k]) and k > 40:
            if w[dec][k] == 1.0 and w[dec][k - 1] == 0.0:
                assert wc[k] > sma[k]        # a buy needs the close above the SMA (and the EMA)
            if w[dec][k] == 0.0 and w[dec][k - 1] == 1.0:
                assert wc[k] < sma[k]


def test_seven_tranches_average_and_off_weight():
    df = wavy(1200, seed=5)
    c, ts = df["close"].to_numpy(), np.asarray(df.index)
    p = {**FAM.default_params(), "offWeight": 0.2}
    w = FAM.targets({"BTC-EUR": df}, spec(offWeight=0.2))["BTC-EUR"].to_numpy()
    parts = np.array([tranche(c, weekday_of(ts), d, p) for d in range(7)])
    mean = parts.mean(axis=0)
    ok = np.isfinite(mean)
    np.testing.assert_allclose(w[ok], mean[ok])
    assert np.isnan(w[~ok]).all()
    assert w[ok].min() >= 0.2 - 1e-12 and w[ok].max() <= 1.0
    assert ((w[ok] > 0.2 + 1e-9) & (w[ok] < 1.0 - 1e-9)).any()   # partial positions while tranches disagree


def test_no_lookahead():
    cd = {"BTC-EUR": wavy(900, seed=6), "ETH-EUR": wavy(900, seed=7)}
    for params in ({"phases": 7}, {"phases": 1, "weekday": 4}):
        sp = spec(markets=("BTC-EUR", "ETH-EUR"), **params)
        full = FAM.targets(cd, sp).to_numpy()
        rng = np.random.default_rng(3)
        for k in (400, 650, 777):
            trunc = FAM.targets({m: d.iloc[: k + 1] for m, d in cd.items()}, sp).to_numpy()
            np.testing.assert_array_equal(trunc, full[: k + 1])
            pert = {}
            for m, d in cd.items():
                d = d.copy()
                f = rng.uniform(0.3, 3.0, len(d) - k - 1)
                for col in ("open", "high", "low", "close"):
                    x = d[col].to_numpy().copy()
                    x[k + 1:] *= f
                    d[col] = x
                pert[m] = d
            np.testing.assert_array_equal(FAM.targets(pert, sp).to_numpy()[: k + 1], full[: k + 1])
