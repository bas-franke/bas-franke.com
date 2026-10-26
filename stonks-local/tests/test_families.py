import random
import time
import types

import numpy as np
import pandas as pd
import pytest

from _engine_util import H4, T0, bars, synth
from stonks_lab.families import FAMILIES, V1_FAMILIES, normalize_spec, register_family


def spec_for(name, markets=None, **params):
    fam = FAMILIES[name]
    ms = markets or (["BTC-EUR", "ETH-EUR", "SOL-EUR"] if fam.multi_market else ["BTC-EUR"])
    return normalize_spec({"family": name, "markets": ms, "interval": "4h", "params": params}, fam)


def candles3(n=800):
    return {"BTC-EUR": synth(n, 1), "ETH-EUR": synth(n, 2, price=1500), "SOL-EUR": synth(n, 3, price=100)}


def test_registry_v1_bot_ready():
    for name in V1_FAMILIES:
        assert name in FAMILIES and FAMILIES[name].bot_ready and FAMILIES[name].version == 1
    assert FAMILIES["rotation_momentum"].multi_market and FAMILIES["dca_dip"].anchored


def test_register_new_family_not_bot_ready():
    mod = types.SimpleNamespace(NAME="test_new_family", default_params=lambda: {}, param_space=lambda: {},
                                explain=lambda s: {"summary": "x"}, targets=lambda c, s, start_time=None: None)
    fam = register_family(mod)
    assert FAMILIES["test_new_family"] is fam and not fam.bot_ready
    del FAMILIES["test_new_family"]


@pytest.mark.parametrize("name", V1_FAMILIES)
def test_family_contract(name):
    fam = FAMILIES[name]
    assert fam.validate({"params": fam.default_params()}) is None
    rng = random.Random(1)
    for _ in range(20):
        p = fam.sample(rng)
        assert fam.validate({"params": p}) is None, p
    cd = candles3()
    for mw in (1.0, 0.6):
        spec = spec_for(name)
        spec["risk"]["maxWeight"] = mw
        t = fam.targets(cd, spec)
        assert list(t.columns) == spec["markets"]
        assert t.index.dtype == np.int64
        v = t.to_numpy()
        rows = ~np.isnan(v).all(axis=1)
        assert rows.any()
        first = int(np.argmax(rows))
        assert not np.isnan(v[first:]).any(), "NaN after the first decision"
        assert (v[first:] >= 0).all() and (v[first:].sum(axis=1) <= mw + 1e-12).all()
    ex = fam.explain(spec_for(name))
    assert ex["summary"] and len(ex["howItWorks"]) >= 2 and ex["whenItWins"] and ex["whenItLoses"]


@pytest.mark.parametrize("name", V1_FAMILIES)
def test_no_lookahead(name):
    fam = FAMILIES[name]
    cd = candles3(900)
    spec = spec_for(name)
    if name == "rotation_momentum":
        spec["params"]["regimeSma"] = 50
    full = fam.targets(cd, spec).to_numpy()
    rng = np.random.default_rng(5)
    for k in (300, 650):
        trunc = {m: df.iloc[: k + 1] for m, df in cd.items()}
        t = fam.targets(trunc, spec).to_numpy()
        np.testing.assert_array_equal(t, full[: k + 1])
        pert = {}
        for m, df in cd.items():
            d = df.copy()
            f = rng.uniform(0.3, 3.0, len(d) - k - 1)
            for col in ("open", "high", "low", "close"):
                x = d[col].to_numpy().copy()
                x[k + 1:] *= f
                d[col] = x
            pert[m] = d
        np.testing.assert_array_equal(fam.targets(pert, spec).to_numpy()[: k + 1], full[: k + 1])


def closes_frame(closes, highs=None):
    c = np.asarray(closes, float)
    h = c if highs is None else np.asarray(highs, float)
    return bars([(x, hh, x, x) for x, hh in zip(c, h)])


def test_ema_cross_hand():
    cd = {"BTC-EUR": closes_frame([1, 1, 1, 5, 5, 1, 1, 1])}
    w = FAMILIES["ema_cross"].targets(cd, spec_for("ema_cross", fast=1, slow=3))["BTC-EUR"].to_numpy()
    # ema1 = close; ema3 seeded 1 at i=2 then .5*x+.5*prev: 3, 4, 2.5, 1.75, 1.375
    assert np.isnan(w[:2]).all()
    assert list(w[2:]) == [0, 1, 1, 0, 0, 0]


def test_donchian_hand():
    hi = [10, 11, 12, 11, 10, 13, 12, 11, 9, 9]
    c = [9, 10, 11, 10, 9, 12.5, 11, 10, 8, 8.5]
    df = bars([(x, h, x - 1, x) for x, h in zip(c, hi)])
    w = FAMILIES["donchian_breakout"].targets({"BTC-EUR": df}, spec_for("donchian_breakout", entry=3, exit=2))
    w = w["BTC-EUR"].to_numpy()
    # i=5: close 12.5 > max(high[2..4]) = 12 -> in; lows = close-1; i=8: close 8 < min(low[6..7]) = 9 -> out
    assert np.isnan(w[:3]).all()
    assert list(w[3:]) == [0, 0, 1, 1, 1, 0, 0]


def test_rsi_dip_hand():
    c = [10, 9, 8, 7, 8, 9, 10, 11, 10]
    w = FAMILIES["rsi_dip"].targets({"BTC-EUR": closes_frame(c)},
                                    spec_for("rsi_dip", period=2, buyBelow=30, sellAbove=70, trendSma=0))
    w = w["BTC-EUR"].to_numpy()
    # rsi: i2=0 (buy), i3=0, i4=50, i5=83.3 (sell)
    assert list(w[2:]) == [1, 1, 1, 0, 0, 0, 0]
    w2 = FAMILIES["rsi_dip"].targets({"BTC-EUR": closes_frame(c)},
                                     spec_for("rsi_dip", period=2, buyBelow=30, sellAbove=70, trendSma=3))
    assert (w2["BTC-EUR"].to_numpy()[2:] == 0).all()  # downtrend: close < SMA(3), never buys


def test_bollinger_hand():
    c = [10, 10, 10, 10, 7, 9, 10.5, 11]
    w = FAMILIES["bollinger_reversion"].targets({"BTC-EUR": closes_frame(c)},
                                                spec_for("bollinger_reversion", period=4, stdDev=1.0))
    w = w["BTC-EUR"].to_numpy()
    # i4: window 10,10,10,7 mid 9.25 sd 1.299 lower 7.95 -> 7 < lower: in; i5: mid 9 -> 9 not > 9; i6: 10.5 > 9.125
    assert list(w[3:]) == [0, 1, 1, 0, 0]


def test_dca_dip_hand():
    c = [100, 100, 85, 84, 100, 160, 160]
    spec = spec_for("dca_dip", everyBars=100, tranches=4, dipPct=0.1, lookback=3, takeProfitPct=0.5,
                    sellFraction=0.5)
    w = FAMILIES["dca_dip"].targets({"BTC-EUR": closes_frame(c)}, spec)["BTC-EUR"].to_numpy()
    coins = 0.25 / 100
    assert w[0] == pytest.approx(0.25) and w[1] == pytest.approx(0.25)
    coins += 0.25 / 85                                     # dip: 85 <= 100*0.9, armed
    assert w[2] == pytest.approx(coins * 85 / (0.5 + coins * 85), abs=1e-15)
    assert w[3] == pytest.approx(coins * 84 / (0.5 + coins * 84), abs=1e-15)  # still in the dip: not re-armed
    assert w[4] == pytest.approx(coins * 100 / (0.5 + coins * 100), abs=1e-15)
    # avg entry 0.5/coins = 91.9; 160 >= 137.8 -> sell half
    cash = 0.5 + coins / 2 * 160
    coins /= 2
    assert w[5] == pytest.approx(coins * 160 / (cash + coins * 160), abs=1e-15)
    cash += coins / 2 * 160                                # avg unchanged -> sells half again
    coins /= 2
    assert w[6] == pytest.approx(coins * 160 / (cash + coins * 160), abs=1e-15)
    # anchored: nothing before start_time, schedule restarts there
    w2 = FAMILIES["dca_dip"].targets({"BTC-EUR": closes_frame(c)}, spec, start_time=T0 + 4 * H4)["BTC-EUR"]
    assert np.isnan(w2.to_numpy()[:4]).all() and w2.to_numpy()[4] == pytest.approx(0.25)


def test_rotation_hand():
    a = closes_frame([100, 110, 120, 130, 120])
    b = closes_frame([100, 120, 120, 125, 125])
    c = closes_frame([100, 90, 95, 100, 105])
    cd = {"AAA-EUR": a, "BBB-EUR": b, "CCC-EUR": c}
    spec = spec_for("rotation_momentum", markets=["AAA-EUR", "BBB-EUR", "CCC-EUR"], lookback=1, top=2,
                    regimeSma=0)
    t = FAMILIES["rotation_momentum"].targets(cd, spec)
    v = t.to_numpy()
    assert np.isnan(v[0]).all()
    # i1: rets .1 .2 -.1 -> B, A ; i2: .0909 0 .0556 -> A, C ; i3: .083 .0417 .0526 -> A, C ; i4: -.077 0 .05 -> C
    np.testing.assert_allclose(v[1:], [[.5, .5, 0], [.5, 0, .5], [.5, 0, .5], [0, 0, .5]])
    # ties broken by market name
    d = {"BBB-EUR": closes_frame([100, 110]), "AAA-EUR": closes_frame([100, 110])}
    s = spec_for("rotation_momentum", markets=["BBB-EUR", "AAA-EUR"], lookback=1, top=1, regimeSma=0)
    assert list(FAMILIES["rotation_momentum"].targets(d, s).to_numpy()[1]) == [0, 1]
    # regime filter: BTC under its SMA -> all cash
    cd2 = {**cd, "BTC-EUR": closes_frame([100, 90, 80, 70, 60])}
    s2 = spec_for("rotation_momentum", markets=["AAA-EUR", "BBB-EUR", "CCC-EUR"], lookback=1, top=2,
                  regimeSma=2)
    assert FAMILIES["rotation_momentum"].markets_needed(s2)[-1] == "BTC-EUR"
    np.testing.assert_array_equal(FAMILIES["rotation_momentum"].targets(cd2, s2).to_numpy()[1:], 0)


def test_rotation_missing_bars_use_own_series():
    a = closes_frame([100, 110, 120, 130])
    b = closes_frame([100, 120, 130]).iloc[[0, 2]]  # BBB has no candle at bar 1
    b.index = a.index[[0, 2]]
    spec = spec_for("rotation_momentum", markets=["AAA-EUR", "BBB-EUR"], lookback=1, top=1, regimeSma=0)
    v = FAMILIES["rotation_momentum"].targets({"AAA-EUR": a, "BBB-EUR": b}, spec).to_numpy()
    # bar 2: BBB's previous own candle is bar 0 -> ret 0.3 beats AAA's 0.0909
    np.testing.assert_allclose(v[1:], [[1, 0], [0, 1], [1, 0]])


# --------------------------------------------------------------------------------------------- every family
# The generic contract and no-look-ahead checks run on EVERY discovered family (finding #445), on real cached daily
# candles (signal markets and point-in-time universes need real coins), with the default params and one sampled
# param set, on the first market set the family accepts: the point-in-time pool (spec universe top10_pit), today's
# top 10, BTC+ETH, or BTC alone; on daily candles, or the last ~11 months of hourly ones for intraday families that
# never decide on daily candles. Skipped when no real candles are cached.

from stonks_lab import data as _data  # noqa: E402
from stonks_lab.families import discover  # noqa: E402

discover()
ALL_FAMILIES = sorted(n for n in FAMILIES if not n.startswith("test_"))
CUTS_FROM_END = (200, 30)          # truncate / perturb everything after bar n - 1 - k
REAL_INTERVALS = ("1d", "1h")
REAL_TAIL = {"1h": 8000}           # bars of real history used per interval (all daily candles)
SLOW_PROBE_S = 1.0                 # slower than this on ~3 years of bars (e.g. model refits): keep to those
# Contract problems found by this test in other agents' families, reported to the fleet; xfail until fixed.
KNOWN_CONTRACT_ISSUES = {
    "time_window": "its default params are rejected by its own valid_params (buy and hold)",
}
_REAL: dict = {}


def real(market, interval="1d"):
    if (market, interval) not in _REAL:
        try:
            df = _data.load_candles(market, interval)
            _REAL[(market, interval)] = df.iloc[-REAL_TAIL[interval]:] if interval in REAL_TAIL else df
        except FileNotFoundError:
            _REAL[(market, interval)] = None
    return _REAL[(market, interval)]


def real_candles(fam, spec):
    cd = {m: real(m, spec["interval"]) for m in fam.markets_needed(spec)}
    return {m: d for m, d in cd.items() if d is not None and len(d)}


def market_sets(fam):
    if not fam.multi_market:
        return [(["BTC-EUR"], None)]
    from stonks_lab.universe import PIT_NAME, pit_pool, top10
    return [(pit_pool(), PIT_NAME), (top10(), None), (["BTC-EUR", "ETH-EUR"], None)]


def real_spec(name, params=None):
    """(spec, candles, targets, slow) on the first interval and market set the family accepts and decides on (else the
    first accepted one); None when no real data is cached."""
    if real("BTC-EUR", "1d") is None:
        return None
    fam = FAMILIES[name]
    fallback = None
    for interval in REAL_INTERVALS:
        for ms, uni in market_sets(fam):
            raw = {"family": name, "markets": ms, "interval": interval, "params": dict(params or {})}
            if uni:
                raw["universe"] = uni
            spec = normalize_spec(raw, fam)
            cd = real_candles(fam, spec)
            if not all(m in cd for m in spec["markets"]):
                continue
            try:
                keep = max(int(fam.warmup(spec["params"]) or 0) + 300, 1100)
                short = {m: d.iloc[-keep:] for m, d in cd.items()}
                t0 = time.perf_counter()
                t = fam.targets(short, spec)
                slow = time.perf_counter() - t0 >= SLOW_PROBE_S
                if slow:
                    cd = short
                else:
                    t = fam.targets(cd, spec)
            except ValueError:          # this family does not take this market set
                continue
            if np.isfinite(t.to_numpy(np.float64)).any():
                return spec, cd, t, slow
            fallback = fallback or (spec, cd, t, slow)
            break
    return fallback


def _same(a, b):
    return a.shape == b.shape and np.array_equal(np.nan_to_num(a, nan=-7.0), np.nan_to_num(b, nan=-7.0))


def lookahead_problems(fam, candles, spec, cuts=CUTS_FROM_END, seed=5, full_df=None):
    """Decisions up to bar t must not change when everything after t is dropped or scrambled (prices and volume
    x 0.3..3). Returns a list of problems (empty = no look-ahead found)."""
    full_df = fam.targets(candles, spec) if full_df is None else full_df
    full = full_df.to_numpy()
    idx = np.asarray(full_df.index, dtype=np.int64)
    rng = np.random.default_rng(seed)
    out = []
    for back in cuts:
        k = len(idx) - 1 - back
        if k < 10:
            continue
        ts = idx[k]
        trunc = {m: d[np.asarray(d.index, dtype=np.int64) <= ts] for m, d in candles.items()}
        t = fam.targets(trunc, spec).to_numpy()[: k + 1]
        if not _same(t, full[: k + 1]):
            out.append(f"truncating after bar {k} changes earlier decisions")
        pert = {}
        for m, d in candles.items():
            d = d.copy()
            after = np.asarray(d.index, dtype=np.int64) > ts
            f = rng.uniform(0.3, 3.0, int(after.sum()))
            for col in ("open", "high", "low", "close", "volume"):
                if col in d:
                    x = d[col].to_numpy(np.float64).copy()
                    x[after] *= f
                    d[col] = x
            pert[m] = d
        p = fam.targets(pert, spec).to_numpy()[: k + 1]
        if not _same(p, full[: k + 1]):
            out.append(f"changing the bars after bar {k} changes earlier decisions")
    return out


def contract_problems(t, spec):
    """Columns = spec markets, increasing int64 index, every weight within [0, maxWeight] and every row's sum too.
    Rows before the first decision are all NaN (warm-up); a NaN row after it means 'no decision' (allowed, e.g.
    phase_shift decides once a day on hourly bars) and a NaN cell in a decided row counts as 0."""
    mw = float(spec["risk"]["maxWeight"])
    out = []
    if list(t.columns) != spec["markets"]:
        out.append(f"columns {list(t.columns)[:3]}... are not the spec markets")
    if t.index.dtype != np.int64:
        out.append(f"index dtype {t.index.dtype}, expected int64")
    if len(t) > 1 and not np.all(np.diff(t.index.to_numpy()) > 0):
        out.append("index not strictly increasing")
    v = t.to_numpy(np.float64)
    if np.isinf(v).any():
        out.append("infinite weight")
    if not np.isfinite(v).any():
        return out + ["never decides"]
    with np.errstate(invalid="ignore"):
        if (v < 0).any() or (v > mw + 1e-9).any():
            out.append(f"weight outside [0, {mw}]: min {np.nanmin(v)}, max {np.nanmax(v)}")
    tot = np.nansum(v, axis=1)
    if (tot > mw + 1e-9).any():
        out.append(f"row weights sum to {tot.max()} > maxWeight {mw}")
    return out


def _param_sets(fam):
    return [("default", fam.default_params()), ("sampled", fam.sample(random.Random(7)))]


@pytest.mark.parametrize("name", ALL_FAMILIES)
def test_every_family_contract(name):
    if name in KNOWN_CONTRACT_ISSUES:
        pytest.xfail(KNOWN_CONTRACT_ISSUES[name])
    fam = FAMILIES[name]
    assert fam.validate({"params": fam.default_params()}) is None
    rng = random.Random(1)
    for _ in range(10):
        p = fam.sample(rng)
        assert fam.validate({"params": p}) is None, p
    for label, params in _param_sets(fam):
        got = real_spec(name, params)
        if got is None:
            pytest.skip("no real candles cached")
        spec, cd, t1, _ = got
        ex = fam.explain(spec)
        assert ex["summary"] and len(ex["howItWorks"]) >= 2 and ex["whenItWins"] and ex["whenItLoses"]
        for mw in (1.0, 0.6):
            s = dict(spec, risk={**spec["risk"], "maxWeight": mw})
            probs = contract_problems(t1 if mw == 1.0 else fam.targets(cd, s), s)
            assert not probs, f"{label} params {params}, maxWeight {mw}: {probs}"


@pytest.mark.parametrize("name", ALL_FAMILIES)
def test_every_family_no_lookahead(name):
    fam = FAMILIES[name]
    for label, params in _param_sets(fam):
        got = real_spec(name, params)
        if got is None:
            pytest.skip("no real candles cached")
        spec, cd, full, slow = got
        probs = lookahead_problems(fam, cd, spec, cuts=CUTS_FROM_END[-1:] if slow else CUTS_FROM_END, full_df=full)
        assert not probs, f"{label} params {params} on {len(spec['markets'])} markets: {probs}"


def _leaky_module(kind):
    def targets(candles, spec, start_time=None):
        df = candles[spec["markets"][0]]
        c = df["close"].to_numpy(np.float64)
        if kind == "shift":
            sig = pd.Series(c).shift(-1).to_numpy() > c                       # tomorrow's close
        elif kind == "median":
            sig = c > np.median(c)                                            # median of the whole history
        else:
            sig = pd.Series(c).rolling(5, center=True).mean().to_numpy() < c  # centered window
        w = sig.astype(np.float64)
        w[:5] = np.nan
        return pd.DataFrame({spec["markets"][0]: w}, index=pd.Index(np.asarray(df.index, dtype=np.int64), name="ts"))
    return types.SimpleNamespace(NAME=f"test_leaky_{kind}", default_params=lambda: {}, param_space=lambda: {},
                                 explain=lambda s: {"summary": "x"}, targets=targets)


@pytest.mark.parametrize("kind", ["shift", "median", "centered"])
def test_lookahead_checker_catches_leaks(kind):
    fam = register_family(_leaky_module(kind))
    try:
        cd = {"BTC-EUR": synth(600, 4)}
        spec = normalize_spec({"family": fam.name, "markets": ["BTC-EUR"], "interval": "4h", "params": {}}, fam)
        assert lookahead_problems(fam, cd, spec)
    finally:
        del FAMILIES[fam.name]
