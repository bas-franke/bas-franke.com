import random

import numpy as np

from _engine_util import bars, synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["sweep_exit_a18"]


def spec(**params):
    p = {"lowLen": 5, "mode": "failed", "gateLen": 0, "outBars": 4, "coreLen": 0, **params}
    return normalize_spec({"family": "sweep_exit_a18", "markets": ["BTC-EUR"], "interval": "1d", "params": p}, FAM)


def test_contract():
    assert FAM.validate({"params": FAM.default_params()}) is None
    rng = random.Random(7)
    cd = {"BTC-EUR": synth(900, 5)}
    for _ in range(10):
        v = FAM.targets(cd, spec(**FAM.sample(rng)))["BTC-EUR"].to_numpy()
        ok = np.isfinite(v)
        assert ok.any() and not np.isnan(v[int(np.argmax(ok)):]).any()
    assert len(FAM.explain(spec(gateLen=20, coreLen=30))["howItWorks"]) >= 3


def rising(n, start=100.0):
    return [(start + i, start + i + 0.5, start + i - 0.5, start + i) for i in range(n)]


def test_failed_sweep_steps_out_then_back_in():
    rows = rising(20)                       # lows 99.5..118.5
    rows.append((119, 120, 110, 119))       # low 110 < prior 5-low 113.5, close 119 above it: failed breakdown
    rows += rising(10, 120)
    w = FAM.targets({"BTC-EUR": bars(rows)}, spec())["BTC-EUR"].to_numpy()
    assert np.isnan(w[:5]).all()
    assert (w[5:20] == 1).all()
    assert (w[20:24] == 0).all()            # event bar + 3 more = 4 bars out
    assert (w[24:] == 1).all()


def test_close_below_counts_only_in_any_mode():
    rows = rising(20)
    rows.append((119, 119, 110, 111))       # breaks the low and closes under it
    rows += rising(10, 120)
    w_f = FAM.targets({"BTC-EUR": bars(rows)}, spec(mode="failed"))["BTC-EUR"].to_numpy()
    w_a = FAM.targets({"BTC-EUR": bars(rows)}, spec(mode="any"))["BTC-EUR"].to_numpy()
    assert w_f[20] == 1 and w_a[20] == 0


def test_gate_ignores_sweeps_in_downtrend_and_core_blocks():
    rows = [(200 - i, 200.5 - i, 199.5 - i, 200 - i) for i in range(40)]   # falling: every bar sweeps
    w_g = FAM.targets({"BTC-EUR": bars(rows)}, spec(mode="any", gateLen=10))["BTC-EUR"].to_numpy()
    assert (w_g[10:] == 1).all()            # gate: below SMA, sweeps ignored, plain hold
    w_c = FAM.targets({"BTC-EUR": bars(rows)}, spec(mode="any", gateLen=10, coreLen=10))["BTC-EUR"].to_numpy()
    assert (w_c[10:] == 0).all()
