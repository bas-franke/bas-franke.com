import random

import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["macd_days"]
D1 = 86_400_000


def spec(markets=("BTC-EUR",), interval="1d", mw=1.0, **params):
    s = normalize_spec({"family": "macd_days", "markets": list(markets), "interval": interval,
                        "params": {"fastDays": 6, "slowDays": 30, "signalDays": 9, **params}}, FAM)
    s["risk"]["maxWeight"] = mw
    return s


def test_band_zero_equals_macd_trend_on_daily():
    df = synth(700, 4, step=D1, vol=0.03)
    w = FAM.targets({"BTC-EUR": df}, spec())["BTC-EUR"].to_numpy()
    ref_fam = FAMILIES["macd_trend"]
    ref = ref_fam.targets({"BTC-EUR": df}, normalize_spec(
        {"family": "macd_trend", "markets": ["BTC-EUR"], "interval": "1d",
         "params": {"fast": 6, "slow": 30, "signal": 9, "requirePositive": False}}, ref_fam))["BTC-EUR"].to_numpy()
    np.testing.assert_array_equal(w, ref)
    assert np.nanmax(w) == 1.0 and np.nanmin(w) == 0.0


def test_days_scale_with_interval():
    # 4h candles: 6 per day, so 6/30/9 days = 36/180/54 candles of macd_trend
    df = synth(1500, 7)
    w = FAM.targets({"BTC-EUR": df}, spec(interval="4h"))["BTC-EUR"].to_numpy()
    ref_fam = FAMILIES["macd_trend"]
    ref = ref_fam.targets({"BTC-EUR": df}, normalize_spec(
        {"family": "macd_trend", "markets": ["BTC-EUR"], "interval": "4h",
         "params": {"fast": 36, "slow": 180, "signal": 54, "requirePositive": False}}, ref_fam))["BTC-EUR"].to_numpy()
    np.testing.assert_array_equal(w, ref)
    assert FAM.module.lengths({"fastDays": 9, "slowDays": 182, "signalDays": 35}, "1W") == (1, 26, 5)


def test_buys_in_uptrend_sells_in_downtrend_and_band_reduces_flips():
    t = np.arange(600)
    c = 100 * np.exp(np.where(t < 300, 0.004 * t, 0.004 * 300 - 0.004 * (t - 300)))
    df = synth(600, 1, step=D1)
    for col in ("open", "high", "low", "close"):
        df[col] = c * (1 + 0.003 * np.sin(t / 3.0))
    w = FAM.targets({"BTC-EUR": df}, spec(requirePositive=True))["BTC-EUR"].to_numpy()
    assert np.nanmean(w[60:290]) > 0.6 and np.nanmean(w[330:]) < 0.1
    for col in ("open", "high", "low", "close"):
        df[col] = c * (1 + 0.02 * np.sin(t / 3.0))
    w0 = FAM.targets({"BTC-EUR": df}, spec())["BTC-EUR"].to_numpy()
    wb = FAM.targets({"BTC-EUR": df}, spec(band=0.01))["BTC-EUR"].to_numpy()
    flips0 = np.sum(np.abs(np.diff(np.nan_to_num(w0))) > 0)
    flipsb = np.sum(np.abs(np.diff(np.nan_to_num(wb))) > 0)
    assert flipsb < flips0
    wp = FAM.targets({"BTC-EUR": df}, spec(requirePositive=True))["BTC-EUR"].to_numpy()
    assert np.nansum(wp) <= np.nansum(w0)


def test_multi_market_contract_and_no_lookahead():
    cd = {"BTC-EUR": synth(900, 1), "ETH-EUR": synth(900, 2, price=1500)}
    s = spec(markets=("BTC-EUR", "ETH-EUR"), interval="4h", mw=0.6, band=0.004, fastDays=2, slowDays=20,
             signalDays=5)
    full = FAM.targets(cd, s).to_numpy()
    first = int(np.argmax(~np.isnan(full).all(axis=1)))
    assert not np.isnan(full[first:]).any()
    assert (full[first:] >= 0).all() and (full[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    for k in (300, 650):
        trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
    rng = random.Random(3)
    for _ in range(30):
        assert FAM.validate({"params": FAM.sample(rng)}) is None
    ex = FAM.explain(s)
    assert ex["summary"] and len(ex["howItWorks"]) >= 4
