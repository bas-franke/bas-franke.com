import json

import numpy as np

from _engine_util import synth
from stonks_lab import backtest as bt
from stonks_lab import tradechart
from stonks_lab.families import FAMILIES, normalize_spec


def _run():
    df = synth(800, seed=5)
    cd = {"BTC-EUR": df}
    spec = normalize_spec({"family": "ema_cross", "markets": ["BTC-EUR"], "interval": "4h",
                           "params": {"fast": 5, "slow": 20}}, FAMILIES["ema_cross"])
    bh = bt.buy_and_hold(["BTC-EUR"], cd, interval="4h")
    return bt.run(spec, cd, bh_equity=bh.equity), bh, cd


def test_trade_rows_cover_every_fill():
    res, _, _ = _run()
    rows = tradechart.trade_rows(res)
    assert len(rows) == len(res.trades) > 4
    sells = [r for r in rows if r["side"] == "sell"]
    assert all(r["pnl"] is not None and r["pnlPct"] is not None for r in sells)
    assert all(r["heldDays"] is not None and r["heldDays"] >= 0 for r in sells)
    assert sum(r["pnl"] for r in sells) == sum(t["pnl"] for t in res.trades)


def test_round_trips_match_closed_sells():
    res, _, _ = _run()
    rts = tradechart.round_trips(tradechart.trade_rows(res))
    closed = [t for t in res.trades if t["side"] == "sell" and t["closed"]]
    assert len([p for p in rts if p["exit"] is not None]) == len(closed)
    assert np.isclose(sum(p["pnl"] for p in rts), sum(t["pnl"] for t in res.trades))


def test_render_and_write(tmp_path):
    res, bh, cd = _run()
    html = tradechart.render(res, bh, cd, title="t <x>")
    assert "t &lt;x&gt;" in html and "</script>" in html
    blob = html.split("const D=", 1)[1].split(";\nconst $=", 1)[0]
    data = json.loads(blob.replace("<\\/", "</"))
    assert len(data["trades"]) == len(res.trades) and "BTC-EUR" in data["prices"]
    p = tradechart.write(tmp_path / "c.html", res, bh, cd, title="x")
    assert p.exists() and p.with_suffix(".trades.csv").read_text().count("\n") == len(res.trades) + 1


def test_decimate_keeps_extremes():
    ts = np.arange(100_000, dtype=np.int64)
    c = np.sin(ts / 500.0) + 2
    c[54_321] = 10.0
    t, v = tradechart._decimate(ts, c, 2000)
    assert len(v) <= 2100 and max(v) == 10.0
