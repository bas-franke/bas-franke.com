import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.data import DAY
from stonks_lab.families import FAMILIES, normalize_spec

FAM = "panic_overlay"
T0D = 1_600_000_000_000 // DAY * DAY  # midnight UTC
M5 = 300_000


def spec(interval="5m", **params):
    return normalize_spec({"family": FAM, "markets": ["BTC-EUR"], "interval": interval, "params": params},
                          FAMILIES[FAM])


def w_of(c, interval="5m", step=M5, **p):
    cd = {"BTC-EUR": bars([(x, x, x, x) for x in c], start=T0D, step=step)}
    return FAMILIES[FAM].targets(cd, spec(interval, **p))["BTC-EUR"].to_numpy()


def test_contract_and_sampling():
    fam = FAMILIES[FAM]
    assert not fam.bot_ready and fam.validate({"params": fam.default_params()}) is None
    rng = random.Random(3)
    cd = {"BTC-EUR": synth(6000, 1, start=T0D, step=3_600_000)}
    for _ in range(15):
        p = fam.sample(rng)
        p.update(baseDays=min(p["baseDays"], 60), macdSlow=min(p["macdSlow"], 60), macdFast=min(p["macdFast"], 20))
        assert fam.validate({"params": p}) is None, p
        t = fam.targets(cd, spec("1h", **p)).to_numpy()[:, 0]
        assert np.isfinite(t).any()
        first = int(np.argmax(np.isfinite(t)))
        assert not np.isnan(t[first:]).any() and (t[first:] >= 0).all() and (t[first:] <= 1).all()
    ex = fam.explain(spec())
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_base_uses_completed_days_only():
    # 1h candles, 24 per day; days 0-2 at 100, day 3 at 110 -> SMA(2 days) on, but only from day 3's last bar
    c = [100.0] * 72 + [110.0] * 24 + [110.0] * 24
    w = w_of(c, "1h", 3_600_000, base="sma", baseDays=2, band=0.0, overlay=False, lookback=6, volBars=12)
    assert np.isnan(w[:47]).all() and (w[47:95] == 0).all()  # SMA ready at the end of day 1, flat price -> off; day 3 not complete before bar 95
    assert w[95] == 1 and (w[96:] == 1).all()


def test_overlay_buys_panic_dip_when_base_off_and_core_holds():
    calm = [100.0, 101.0] * 30
    c = calm + [80.0, 85.0, 101.0, 101.0, 100.0, 101.0]
    i = len(calm)
    common = dict(base="none", lookback=10, threshold=2.5, volBars=10, volMinPct=1.0, exitZ=0.0, maxHoldBars=50)
    w = w_of(c, **common, overlay=True)
    assert (w[10:i] == 0).all() and w[i] == 1 and w[i + 1] == 1 and w[i + 2] == 0
    w_off = w_of(c, **{**common, "coreWeight": 0.3}, overlay=False)
    assert np.allclose(w_off[10:], 0.3)
    w_core = w_of(c, **{**common, "coreWeight": 0.3}, overlay=True)
    assert w_core[i] == 1 and w_core[i + 2] == 0.3
    w_cold = w_of(c, **{**common, "volMinPct": 500.0}, overlay=True)
    assert (w_cold[10:] == 0).all()


def test_no_lookahead():
    fam = FAMILIES[FAM]
    cd = {"BTC-EUR": synth(3000, 4, start=T0D, step=3_600_000, vol=0.03)}
    s = spec("1h", base="sma", baseDays=20, band=0.01, lookback=20, threshold=2.5, volBars=50, volMinPct=3.0,
             exitZ=0.5, maxHoldBars=30)
    full = fam.targets(cd, s).to_numpy()[:, 0]
    for cut in (1000, 1777, 2500):
        part = fam.targets({"BTC-EUR": cd["BTC-EUR"].iloc[:cut]}, s).to_numpy()[:, 0]
        np.testing.assert_array_equal(part, full[:cut])
