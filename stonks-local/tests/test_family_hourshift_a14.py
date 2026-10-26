import numpy as np

from _engine_util import synth
from stonks_lab.families import FAMILIES, normalize_spec

FAM = FAMILIES["hourshift_a14"]
PS = FAMILIES["phase_shift"]
H1 = 3_600_000
T0 = 1_600_000_000_000 - (1_600_000_000_000 % 86_400_000)
SMA130 = {"family": "stale_trend", "params": {"coreLen": 130, "hiLook": 60, "staleBars": 0}}


def spec(hour="00", period="24", inner=SMA130, markets=("BTC-EUR",)):
    return normalize_spec({"family": "hourshift_a14", "markets": list(markets), "interval": "1h",
                           "params": {"hour": hour, "period": period, "inner": inner}}, FAM)


def candles(n_days=400, seed=3):
    return {"BTC-EUR": synth(24 * n_days, seed, start=T0, step=H1, vol=0.006),
            "ETH-EUR": synth(24 * n_days, seed + 1, start=T0, step=H1, vol=0.008)}


def test_contract_and_validation():
    assert FAM.validate({"params": FAM.default_params()}) is None
    assert FAM.validate({"params": {"hour": "07", "period": "24", "inner": {"family": "nope", "params": {}}}})
    assert FAM.validate({"params": {"hour": "07", "period": "24",
                                    "inner": {"family": "stale_trend", "params": {"coreLen": -5}}}})
    assert FAM.validate({"params": {"hour": "7", "period": "24", "inner": SMA130}})        # hour must be "07"
    assert len(FAM.explain(spec("05"))["howItWorks"]) >= 3


def test_matches_phase_shift_preset_at_every_hour():
    cd = candles()
    for h in (0, 7, 23):
        a = FAM.targets(cd, spec(f"{h:02d}"))["BTC-EUR"].to_numpy()
        ps = normalize_spec({"family": "phase_shift", "markets": ["BTC-EUR"], "interval": "1h",
                             "params": {"preset": "sma130", "hour": h}}, PS)
        b = PS.targets(cd, ps)["BTC-EUR"].to_numpy()
        assert np.array_equal(np.nan_to_num(a, nan=-1), np.nan_to_num(b, nan=-1))
        assert np.isfinite(a).sum() > 100


def test_decides_once_per_candle_at_its_last_hour():
    cd = candles()
    for h, per in ((5, "24"), (3, "12")):
        w = FAM.targets(cd, spec(f"{h:02d}", per))["BTC-EUR"]
        ts = np.asarray(w.index)[np.isfinite(w.to_numpy())]
        P = int(per)
        assert (((ts - h * H1) // H1) % P == P - 1).all()


def test_multi_market_inner_and_no_look_ahead():
    cd = candles()
    inner = {"family": "beta_shift", "params": {"coreSma": 60, "ethShare": 1, "heat": "eth_sma", "heatLen": 40,
                                                "heatThr": 0, "offWeight": 0.5}}
    s = spec("09", "24", inner, markets=("BTC-EUR", "ETH-EUR"))
    full = FAM.targets(cd, s)
    assert set(full.columns) == {"BTC-EUR", "ETH-EUR"} and np.isfinite(full.to_numpy()).any()
    for k in (24 * 200 + 5, 24 * 300 + 17):
        part = FAM.targets({m: d.iloc[:k] for m, d in cd.items()}, s)
        a = np.nan_to_num(part.to_numpy(), nan=-1)
        b = np.nan_to_num(full.to_numpy()[:k], nan=-1)
        assert np.array_equal(a, b)
