import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families.vr_switch import variance_ratio

FAM = FAMILIES["vr_switch"]


def spec(markets=("BTC-EUR",), **params):
    p = {"trendLen": 3, "vrWin": 6, "vrQ": 2, "vrThr": 1.0, "revMode": "dip", "revLen": 3, "entryZ": 1.0, **params}
    return normalize_spec({"family": "vr_switch", "markets": list(markets), "interval": "4h", "params": p}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    cd = {m: synth(800, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR"])}
    for _ in range(12):
        p = FAM.sample(rng)
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        if rows.any():
            first = int(np.argmax(rows))
            assert not np.isnan(v[first:]).any()
            assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"]))
    assert ex["summary"] and len(ex["howItWorks"]) >= 3 and ex["whenItWins"] and ex["whenItLoses"]


def test_variance_ratio_trend_vs_chop():
    trend = 100 * np.exp(np.cumsum(np.r_[0, np.repeat([0.02, 0.03], 40)]))
    zig = 100 * np.exp(np.cumsum(np.r_[0, np.tile([0.03, -0.03], 40)]))
    assert variance_ratio(trend, 20, 4)[-1] > 1.0 or np.isnan(variance_ratio(trend, 20, 4)[-1])
    assert variance_ratio(zig, 20, 4)[-1] < 0.2


def test_trend_regime_holds_above_sma():
    # steadily accelerating rise: positive autocorrelated moves -> VR >= threshold 0 -> trend rule
    up = list(100 * np.exp(np.cumsum(np.linspace(0.01, 0.05, 30))))
    w = FAM.targets({"BTC-EUR": closes(up)}, spec(vrThr=0.6))["BTC-EUR"].to_numpy()
    first = int(np.argmax(~np.isnan(w)))
    assert (w[first:] == 1).all()


def test_chop_modes():
    zig = list(100 * np.exp(np.cumsum(np.r_[0, np.tile([0.03, -0.03], 15)])))
    zig = zig + [zig[-1] * 0.85, zig[-1] * 0.85, zig[-1] * 1.02, zig[-1] * 1.05]
    cd = {"BTC-EUR": closes(zig)}
    hold = FAM.targets(cd, spec(vrThr=1.4, revMode="hold"))["BTC-EUR"].to_numpy()
    cash = FAM.targets(cd, spec(vrThr=1.4, revMode="cash"))["BTC-EUR"].to_numpy()
    f = int(np.argmax(~np.isnan(hold)))
    assert (hold[f:] == 1).all() and (cash[f:] == 0).all()
    dip = FAM.targets(cd, spec(vrThr=1.4, revMode="dip", entryZ=1.0))["BTC-EUR"].to_numpy()
    n = len(zig)
    assert dip[n - 4] == 1          # big drop: z << -1 -> buy at that close
    assert dip[n - 1] == 0          # back above the average -> sold


def test_no_lookahead_prefix():
    c = synth(400, 9)
    full = FAM.targets({"BTC-EUR": c}, spec(trendLen=20, vrWin=40, vrQ=3, revLen=10))["BTC-EUR"].to_numpy()
    part = FAM.targets({"BTC-EUR": c.iloc[:250]}, spec(trendLen=20, vrWin=40, vrQ=3, revLen=10))["BTC-EUR"].to_numpy()
    np.testing.assert_array_equal(full[:250], part)
