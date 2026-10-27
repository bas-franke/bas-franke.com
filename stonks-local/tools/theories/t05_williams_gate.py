"""t05: a 200-candle trend gate makes Williams %R dip buys on BTC 4h win more often."""
from _harness import Theory, Variant, dd, ret, run, win

BTC = {"markets": ["BTC-EUR"], "interval": "4h"}
BASE = {"n": 14, "entryLevel": 92.0, "exitLevel": 30.0, "maxHold": 30}


def verdict(r):
    a, b = r["no_gate"], r["sma200"]
    ok = win(b) > win(a) and dd(b) < dd(a)
    return ok, (f"win rate {win(a):.0f} % -> {win(b):.0f} %, DD {dd(a):.0f} % -> {dd(b):.0f} %, "
                f"return {ret(a):+.0f} % -> {ret(b):+.0f} %")


THEORY = Theory(
    name="t05_williams_gate",
    hypothesis="On BTC 4h, Williams %R dip buys only above the 200-candle SMA have a higher win rate and a smaller "
               "drawdown than the same dips bought in any trend.",
    variants=[
        Variant("no_gate", {"family": "williams_dip", **BTC, "params": {**BASE, "trendSma": 0}}),
        Variant("sma200", {"family": "williams_dip", **BTC, "params": {**BASE, "trendSma": 200}}),
        Variant("sma600", {"family": "williams_dip", **BTC, "params": {**BASE, "trendSma": 600}}),
        Variant("sma200_stop8", {"family": "williams_dip", **BTC, "params": {**BASE, "trendSma": 200},
                                 "risk": {"stopLossPct": 0.08}}, "with an 8 % stop-loss"),
    ],
    verdict=verdict,
    tags=["dip"],
)

if __name__ == "__main__":
    run(THEORY)
