import numpy as np
import pytest

from _engine_util import H4, T0, bars, fixed_spec, synth
from stonks_lab import backtest as bt
from stonks_lab.families import FAMILIES

MAKER, TAKER, SLIP = 0.0015, 0.0025, 0.0005
LIMIT0 = {"orderType": "limit", "limitOffsetBps": 0, "postOnly": True, "timeoutBars": 1, "fallback": "cancel"}
MARKET = {"orderType": "market"}


def run(rows, w, execution=LIMIT0, risk=None, **kw):
    cd = {"BTC-EUR": bars(rows)}
    spec = fixed_spec(w, execution=execution, risk=risk or {})
    return bt.run(spec, cd, **kw)


def test_limit_buy_touch_does_not_fill_cross_does():
    rows = [(100, 101, 99, 100),
            (100, 101, 100, 100.5),     # low == limit 100: touching is not enough
            (100.5, 102, 100.4, 101)]   # low 100.4 < limit 100.5: fills at 100.5
    r = run(rows, [1, 1, 1])
    assert len(r.trades) == 1
    t = r.trades[0]
    eur = 1000 / (1 + MAKER)
    assert t["time"] == T0 + 2 * H4 and t["side"] == "buy" and t["liquidity"] == "maker"
    assert t["price"] == 100.5
    assert abs(t["fee"] - eur * MAKER) < 1e-9 and round(t["fee"], 2) == 1.50
    assert abs(t["amount"] - eur / 100.5) < 1e-12
    assert abs(r.cash[-1]) < 1e-9
    assert r.equity[0] == 1000 and r.equity[1] == 1000
    assert abs(r.equity[2] - eur / 100.5 * 101) < 1e-9


def test_limit_sell_strict_and_fees_to_the_cent():
    rows = [(100, 101, 99, 100),
            (100, 101, 99.5, 100),      # buy limit 100 fills (low 99.5)
            (100, 103, 100, 102),       # w=0 at this close -> sell limit 102
            (102, 102, 101, 101.5),     # high == 102: no fill, cancelled; new limit 101.5
            (101.5, 101.6, 101, 101)]   # high 101.6 > 101.5: fills
    r = run(rows, [1, 1, 0, 0, 0])
    assert [t["side"] for t in r.trades] == ["buy", "sell"]
    b, s = r.trades
    units = (1000 / (1 + MAKER)) / 100
    assert s["time"] == T0 + 4 * H4 and s["price"] == 101.5 and abs(s["amount"] - units) < 1e-12
    gross = units * 101.5
    assert abs(s["fee"] - gross * MAKER) < 1e-9
    assert abs(r.cash[-1] - gross * (1 - MAKER)) < 1e-9
    assert round(r.equity[-1], 2) == round(1000 / 1.0015 / 100 * 101.5 * 0.9985, 2) == 1011.96
    assert abs(s["pnl"] - (gross * (1 - MAKER) - 1000)) < 1e-9
    assert r.metrics["trades"] == 2 and r.metrics["winRatePct"] == 100.0
    assert abs(r.metrics["feesEur"] - round(b["fee"] + s["fee"], 2)) < 1e-9


def test_market_order_next_open_slippage_taker():
    rows = [(100, 101, 99, 100), (100, 104, 99, 103), (103, 104, 102, 103)]
    r = run(rows, [1, 1, 1], execution=MARKET)
    t = r.trades[0]
    px = 100 * (1 + SLIP)
    eur = 1000 / (1 + TAKER + SLIP)  # sized at the close with room for fee and slippage, like the bot
    assert t["time"] == T0 + H4 and t["liquidity"] == "taker"
    assert abs(t["price"] - px) < 1e-12 and abs(t["fee"] - eur * TAKER) < 1e-9
    assert abs(t["amount"] - eur / px) < 1e-12
    assert abs(r.cash[1] - (1000 - eur * (1 + TAKER))) < 1e-9
    assert abs(r.equity[1] - (eur / px * 103 + r.cash[1])) < 1e-9


def test_timeout_then_fallback_market():
    ex = {**LIMIT0, "timeoutBars": 2, "fallback": "market"}
    rows = [(100, 101, 99, 100),
            (100, 101, 100, 100.5),     # no fill (touch)
            (100.5, 101, 100.2, 100.6), # no fill -> times out after 2 bars
            (103, 104, 102, 103)]       # fallback market at this open
    r = run(rows, [1, 1, 1, 1], execution=ex)
    assert len(r.trades) == 1
    t = r.trades[0]
    assert t["time"] == T0 + 3 * H4 and t["reason"] == "fallback" and t["liquidity"] == "taker"
    assert abs(t["price"] - 103 * (1 + SLIP)) < 1e-12
    assert abs(t["eur"] - 1000 / (1 + TAKER)) < 1e-9


def test_timeout_cancel_skips():
    rows = [(100, 101, 99.9, 100), (100, 101, 100, 100), (100, 101, 100, 100)]
    r = run(rows, [1, 1, 1])
    assert r.trades == [] and np.allclose(r.equity, 1000)


def test_stop_loss_against_lows_exits_as_market_and_stands_down():
    rows = [(100, 101, 99, 100),
            (100, 101, 99, 100),        # market buy at 100.05
            (99, 99.5, 85, 90),         # low 85 <= stop 90.045: exit at 90.045*(1-slip)
            (90, 95, 89, 94),           # target still 1: stood down, no re-buy
            (94, 95, 93, 94),           # target 0 at this close resets the stand-down
            (94, 96, 93, 95),           # target 1 again -> buy at next open
            (96, 97, 95, 96)]
    r = run(rows, [1, 1, 1, 1, 0, 1, 1], execution=MARKET, risk={"stopLossPct": 0.1})
    sides = [(t["side"], t["reason"], t["time"]) for t in r.trades]
    assert sides[0] == ("buy", "signal", T0 + H4)
    assert sides[1] == ("sell", "stop_loss", T0 + 2 * H4)
    entry = 100.05  # the plain fill price, fees excluded, like the bot's replayPosition
    assert abs(r.trades[1]["price"] - entry * 0.9 * (1 - SLIP)) < 1e-9
    assert sides[2] == ("buy", "signal", T0 + 6 * H4)
    assert len(sides) == 3


def test_stop_gap_down_fills_at_open():
    rows = [(100, 101, 99, 100), (100, 101, 99, 100), (80, 82, 79, 81), (81, 82, 80, 81)]
    r = run(rows, [1, 1, 1, 1], execution=MARKET, risk={"stopLossPct": 0.1})
    assert r.trades[1]["reason"] == "stop_loss"
    assert abs(r.trades[1]["price"] - 80 * (1 - SLIP)) < 1e-9


def test_trailing_stop_and_take_profit():
    rows = [(100, 101, 99, 100), (100, 101, 99, 100), (100, 120, 100, 119), (119, 119, 107, 110), (110, 111, 109, 110)]
    r = run(rows, [1] * 5, execution=MARKET, risk={"trailingStopPct": 0.1})
    # peak after bar 2 = 120 -> stop 108; bar 3 low 107 triggers, open 119 > 108 so fill at 108*(1-slip)
    assert r.trades[1]["reason"] == "trailing_stop" and abs(r.trades[1]["price"] - 108 * (1 - SLIP)) < 1e-9
    r = run(rows, [1] * 5, execution=MARKET, risk={"takeProfitPct": 0.15})
    tp = 100.05 * 1.15
    assert r.trades[1]["reason"] == "take_profit" and r.trades[1]["liquidity"] == "taker"
    assert abs(r.trades[1]["price"] - tp * (1 - SLIP)) < 1e-9 and r.trades[1]["time"] == T0 + 2 * H4


def test_churn_threshold_and_min_order():
    # weight 0.5, small drift: one buy, then deltas stay under 2 % of equity -> no more trades
    rows = [(100, 101, 99, 100)] + [(100 + i * 0.1, 101 + i * 0.1, 99, 100 + i * 0.1) for i in range(1, 30)]
    r = run(rows, [0.5] * 30)
    assert len(r.trades) == 1 and abs(r.trades[0]["eur"] - 500) < 1e-9
    # big move: weight drifts past 2 % -> rebalancing sell
    rows2 = rows[:3] + [(130, 131, 129, 130)] * 4
    r2 = run(rows2, [0.5] * 7)
    assert [t["side"] for t in r2.trades][:2] == ["buy", "sell"]
    # under EUR 5 nothing trades at all
    r3 = run(rows, [1] * 30, start_eur=4.0)
    assert r3.trades == []


def test_buy_and_hold_fees():
    cd = {"BTC-EUR": bars([(100, 101, 99, 100), (100, 110, 99, 110), (110, 111, 109, 110)])}
    r = bt.buy_and_hold("BTC-EUR", cd, interval="4h")
    px = 100 * (1 + SLIP)
    units = 1000 / (px * (1 + TAKER))
    assert abs(r.trades[0]["amount"] - units) < 1e-12
    assert abs(r.trades[0]["fee"] - units * px * TAKER) < 1e-9
    assert abs(r.equity[-1] - units * 110) < 1e-9
    assert abs(r.equity[0] - units * 100) < 1e-9  # already down by fee + slippage at the first close


def test_rotation_sells_then_buys_with_reserved_cash():
    a = bars([(100, 101, 99, 100)] * 6)
    b = bars([(50, 51, 49, 50)] * 6)
    w = {"BTC-EUR": [1, 1, 0, 0, 0, 0], "ETH-EUR": [0, 0, 1, 1, 1, 1]}
    spec = fixed_spec(w, markets=("BTC-EUR", "ETH-EUR"), execution=LIMIT0)
    r = bt.run(spec, {"BTC-EUR": a, "ETH-EUR": b})
    got = [(t["market"], t["side"], (t["time"] - T0) // H4) for t in r.trades]
    # BTC bought at bar 1; switch decided at close 2: sell fills bar 3, ETH buy placed at close 3, fills bar 4
    assert got == [("BTC-EUR", "buy", 1), ("BTC-EUR", "sell", 3), ("ETH-EUR", "buy", 4)]


def test_window_starts_with_previous_decision_and_weights_capped():
    cd = {"BTC-EUR": bars([(100, 101, 99, 100)] * 6)}
    spec = fixed_spec([1] * 6, execution=MARKET, risk={"maxWeight": 0.5})
    r = bt.run(spec, cd, start=T0 + 2 * H4)
    assert r.ts[0] == T0 + 2 * H4
    assert r.trades[0]["time"] == T0 + 2 * H4          # decided at the close before the window
    assert abs(r.trades[0]["eur"] - 500) < 1e-9          # maxWeight caps the target


@pytest.mark.parametrize("name", sorted(["ema_cross", "macd_trend", "donchian_breakout", "rsi_dip",
                                         "bollinger_reversion", "dca_dip", "rotation_momentum"]))
@pytest.mark.parametrize("risk,ex", [({}, {}), ({"stopLossPct": 0.05, "trailingStopPct": 0.1}, MARKET),
                                     ({"takeProfitPct": 0.1, "maxWeight": 0.7},
                                      {"timeoutBars": 3, "fallback": "market"})])
def test_fast_path_changes_nothing_and_no_lookahead(name, risk, ex):
    fam = FAMILIES[name]
    cd = {"BTC-EUR": synth(1500, 1), "ETH-EUR": synth(1500, 2, price=1500), "SOL-EUR": synth(1500, 3, price=100)}
    markets = list(cd) if fam.multi_market else ["BTC-EUR"]
    spec = {"family": name, "markets": markets, "interval": "4h", "params": fam.default_params(), "risk": risk,
            "execution": ex}
    start = int(cd["BTC-EUR"].index[200])
    fast = bt.run(spec, cd, start=start)
    bt.FAST_PATH = False
    try:
        slow = bt.run(spec, cd, start=start)
    finally:
        bt.FAST_PATH = True
    assert np.array_equal(fast.equity, slow.equity)
    assert fast.trades == slow.trades
    # perturb everything after bar k: the equity up to k and every earlier trade stay identical
    k = 900
    pert = {}
    rng = np.random.default_rng(9)
    for m, df in cd.items():
        d = df.copy()
        f = rng.uniform(0.5, 1.5, len(d) - k - 1)
        for col in ("open", "high", "low", "close"):
            v = d[col].to_numpy().copy()
            v[k + 1:] *= f
            d[col] = v
        pert[m] = d
    p = bt.run(spec, pert, start=start)
    kk = k - 200
    assert np.array_equal(p.equity[: kk + 1], fast.equity[: kk + 1])
    cut = int(cd["BTC-EUR"].index[k])
    assert [t for t in p.trades if t["time"] <= cut] == [t for t in fast.trades if t["time"] <= cut]


def test_speed_50k_bars():
    import time
    cd = {"BTC-EUR": synth(50_000, 4)}
    spec = {"family": "ema_cross", "markets": ["BTC-EUR"], "interval": "4h", "params": {"fast": 12, "slow": 48}}
    t = time.perf_counter()
    bt.run(spec, cd)
    assert time.perf_counter() - t < 1.0
