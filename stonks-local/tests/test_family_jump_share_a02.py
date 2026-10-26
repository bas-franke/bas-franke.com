import random

import numpy as np

from _engine_util import bars
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["jump_share_a02"]
H1 = 3_600_000
T0 = 1_600_041_600_000 - (1_600_041_600_000 % 86_400_000)   # midnight UTC


def spec(**params):
    return normalize_spec({"family": "jump_share_a02", "markets": ["BTC-EUR"], "interval": "1h", "params": params},
                          FAM)


def hourly(day_kinds, seed=1):
    """'jump': one 3 % hour among tiny ones; 'diff': every hour +-1 % (clustered, diffusive)."""
    rng = np.random.default_rng(seed)
    rows, px = [], 100.0
    for kind in day_kinds:
        for h in range(24):
            if kind == "jump":
                r = (0.03 if h == 12 else 0.0005) * rng.choice([-1, 1])
            else:
                r = 0.01 * rng.choice([-1, 1])
            nx = px * np.exp(r)
            rows.append((px, max(px, nx), min(px, nx), nx))
            px = nx
    return {"BTC-EUR": bars(rows, start=T0, step=H1)}


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    r = random.Random(3)
    assert sum(FAM.validate({"params": FAM.sample(r)}) is None for _ in range(40)) == 40
    assert FAM.validate({"params": {**FAM.default_params(), "exitRank": 0.5, "enterRank": 0.3}}) is not None
    assert FAM.explain(spec(trendSma=50))["summary"]
    assert FAM.explain(spec(mode="hold"))["summary"]


def test_jump_share_measure():
    from stonks_lab.families.jump_share_a02 import daily_jump_share
    for kind, lo, hi in (("jump", 0.6, 1.0), ("diff", 0.0, 0.2)):
        c = hourly([kind] * 3)["BTC-EUR"]
        ts = np.asarray(c.index, dtype=np.int64)
        di = np.nonzero(((ts + H1) % 86_400_000) == 0)[0]
        s = daily_jump_share(ts, c["close"].to_numpy(), H1, di)
        assert lo <= s[-1] <= hi, (kind, s)


def test_steps_aside_in_diffusive_stretch_and_returns():
    days = ["jump"] * 70 + ["diff"] * 12 + ["jump"] * 20
    c = hourly(days)
    p = dict(jumpLen=5, rankLen=90, exitRank=0.2, enterRank=0.3)
    w = FAM.targets(c, spec(**p))["BTC-EUR"].to_numpy()
    assert w[24 * 70 - 1] == 1.0                     # jumpy calm: in
    assert w[24 * 82 - 1] == 0.0                     # after a diffusive stretch: out
    assert w[-1] == 1.0                              # jumps back: in again
    w2 = FAM.targets(c, spec(**p, offWeight=0.5))["BTC-EUR"].to_numpy()
    assert w2[24 * 82 - 1] == 0.5
    wh = FAM.targets(c, spec(**p, mode="hold"))["BTC-EUR"].to_numpy()
    assert np.nanmin(wh) == 1.0


def test_decides_once_per_day():
    c = hourly(["jump"] * 70 + ["diff"] * 12 + ["jump"] * 20)
    w = FAM.targets(c, spec(jumpLen=5, rankLen=90, exitRank=0.2, enterRank=0.3, decideHour=7))["BTC-EUR"].to_numpy()
    fin = np.isfinite(w)
    ts = np.asarray(c["BTC-EUR"].index)[fin]
    v = w[fin]
    for k in np.nonzero(np.diff(v))[0]:
        assert (ts[k + 1] + H1) % 86_400_000 == 7 * H1


def test_generic_contract_and_no_lookahead_4h():
    from _engine_util import synth
    cd = {"BTC-EUR": synth(900, 1)}
    s = normalize_spec({"family": "jump_share_a02", "markets": ["BTC-EUR"], "interval": "4h",
                        "params": {"jumpLen": 10, "rankLen": 120, "trendSma": 20}}, FAM)
    full = FAM.targets(cd, s).to_numpy()
    rows = np.isfinite(full[:, 0])
    assert rows.any()
    first = int(np.argmax(rows))
    assert np.isfinite(full[first:]).all() and (full[first:] >= 0).all() and (full[first:] <= 1).all()
    rng = np.random.default_rng(5)
    for k in (500, 700):
        trunc = {"BTC-EUR": cd["BTC-EUR"].iloc[: k + 1]}
        np.testing.assert_array_equal(FAM.targets(trunc, s).to_numpy(), full[: k + 1])
        d = cd["BTC-EUR"].copy()
        f = rng.uniform(0.3, 3.0, len(d) - k - 1)
        for col in ("open", "high", "low", "close"):
            x = d[col].to_numpy().copy()
            x[k + 1:] *= f
            d[col] = x
        np.testing.assert_array_equal(FAM.targets({"BTC-EUR": d}, s).to_numpy()[: k + 1], full[: k + 1])
