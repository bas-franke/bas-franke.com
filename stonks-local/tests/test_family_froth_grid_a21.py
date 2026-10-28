import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec
from stonks_lab.families import froth_grid_a21 as fg

FAM = FAMILIES["froth_grid_a21"]
POOL = ["XRP-EUR", "ADA-EUR", "LTC-EUR"]


def spec(markets=("BTC-EUR",), **params):
    return normalize_spec({"family": "froth_grid_a21", "markets": list(markets), "interval": "1d",
                           "params": {**FAM.default_params(), **params}}, FAM)


def closes(c):
    return bars([(x, x, x, x) for x in c])


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(5)
    cd = {m: synth(500, i + 1, price=100 * (i + 1)) for i, m in enumerate(["BTC-EUR", "ETH-EUR", *POOL])}
    for _ in range(6):
        p = FAM.sample(rng)
        s = spec(["BTC-EUR", "ETH-EUR"], **p)
        s["risk"]["maxWeight"] = 0.6
        v = FAM.targets(cd, s).to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        assert rows.any()
        first = int(np.argmax(rows))
        assert first >= 180
        assert not np.isnan(v[first:]).any()
        assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= 0.6 + 1e-12).all()
    assert set(FAM.markets_needed(spec(pool="y2019_11"))) >= {"BTC-EUR", "ETC-EUR", "NEO-EUR", "XRP-EUR"}
    ex = FAM.explain(spec(["BTC-EUR", "ETH-EUR"], step=1.0))
    assert ex["summary"] and len(ex["howItWorks"]) >= 5 and ex["whenItWins"] and ex["whenItLoses"]


def test_holds_flat_market_and_scales_out_on_alt_pump():
    n = 400
    flat = [100.0] * n
    pump = [100.0] * 300 + [100.0 * np.exp(0.004 * (i + 1)) for i in range(100)]  # alts +0.4 %/day from bar 300
    cd = {"BTC-EUR": closes(flat), **{m: closes(pump) for m in POOL}}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:180]).all()
    assert (w[180:300] == 1.0).all()
    # 0.4 %/day: after 60 d the 60-day spread is 0.24 -> 4 of the 60-day cells (thr .05-.2) are out
    assert w[299] == 1.0 and w[-1] < 0.5
    assert np.all(np.diff(w[300:]) <= 1e-12)  # only scales out while the pump grows
    # majority vote rounds to 0/1
    wv = FAM.targets(cd, spec(step=1.0))["BTC-EUR"].to_numpy()
    assert set(np.unique(wv[180:])) <= {0.0, 1.0} and wv[-1] == 0.0


def test_btc_leading_keeps_holding():
    n = 300
    up = [100.0 * np.exp(0.003 * i) for i in range(n)]
    cd = {"BTC-EUR": closes(up), **{m: closes([100.0] * n) for m in POOL}}
    w = FAM.targets(cd, spec())["BTC-EUR"].to_numpy()
    assert (w[180:] == 1.0).all()


def test_grid_cell_matches_alt_froth():
    # the 120 d / 0.10 cell of the grid is alt_froth's live rule; the average can only be 1 when every cell holds
    from stonks_lab.families import alt_froth as af
    cd = {m: synth(600, i + 3, price=50 * (i + 1)) for i, m in enumerate(["BTC-EUR", *POOL])}
    idx = np.asarray(cd["BTC-EUR"].index, dtype=np.int64)
    a = af.froth(cd, 120, idx)
    b = fg.spread(cd, POOL, 120, idx)
    ok = np.isfinite(a)
    assert np.allclose(a[ok], b[ok])
