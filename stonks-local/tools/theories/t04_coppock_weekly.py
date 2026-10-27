"""t04: the Coppock curve on weekly BTC sidesteps most of the bear market."""
from _harness import Theory, Variant, bh_dd, bh_ret, dd, ret, run

BTCW = {"markets": ["BTC-EUR"], "interval": "1W"}


def verdict(r):
    ok = [k for k, v in r.items() if dd(v) < 50 and ret(v) >= 0.5 * bh_ret(v)]
    parts = ", ".join(f"{k} {ret(v):+.0f} %/DD {dd(v):.0f} % (B&H {bh_ret(v):+.0f} %/DD {bh_dd(v):.0f} %)"
                      for k, v in r.items())
    return bool(ok), f"passing: {', '.join(ok) or 'none'}; {parts}"


THEORY = Theory(
    name="t04_coppock_weekly",
    hypothesis="A Coppock curve on BTC keeps the max drawdown under 50 % while keeping at least half of buy and "
               "hold's return.",
    variants=[
        Variant("classic_cross", {"family": "coppock_curve", **BTCW,
                                  "params": {"rocLong": 14, "rocShort": 11, "wma": 10, "exit": "cross"}}),
        Variant("classic_turn", {"family": "coppock_curve", **BTCW,
                                 "params": {"rocLong": 14, "rocShort": 11, "wma": 10, "exit": "turn",
                                            "sellAbove": 40.0}}),
        Variant("fast_cross", {"family": "coppock_curve", **BTCW,
                               "params": {"rocLong": 8, "rocShort": 5, "wma": 6, "exit": "cross"}}),
        Variant("daily_equiv", {"family": "coppock_curve", "markets": ["BTC-EUR"], "interval": "1d",
                                "params": {"rocLong": 98, "rocShort": 77, "wma": 70, "exit": "cross"}},
                "the classic horizon on daily candles"),
    ],
    verdict=verdict,
    tags=["regime", "cycle"],
)

if __name__ == "__main__":
    run(THEORY)
