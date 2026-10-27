"""t01: Aroon trend beats the classic EMA 12/48 cross on BTC 1d after fees."""
from _harness import Theory, Variant, dd, ret, run

BTC = {"markets": ["BTC-EUR"], "interval": "1d"}


def verdict(r):
    base = r["ema_12_48"]
    best = max((k for k in r if k.startswith("aroon")), key=lambda k: ret(r[k]))
    ok = ret(r[best]) >= 0.9 * ret(base) and dd(r[best]) < dd(base)
    return ok, (f"best Aroon ({best}) {ret(r[best]):+.0f} % / DD {dd(r[best]):.0f} % vs EMA 12/48 "
                f"{ret(base):+.0f} % / DD {dd(base):.0f} %")


THEORY = Theory(
    name="t01_aroon_vs_ema",
    hypothesis="Aroon trend following on BTC 1d keeps at least 90 % of EMA 12/48's return with a smaller max "
               "drawdown.",
    variants=[
        Variant("ema_12_48", {"family": "ema_cross", **BTC, "params": {"fast": 12, "slow": 48}}, "baseline"),
        Variant("aroon_25", {"family": "aroon_trend", **BTC, "params": {"n": 25}}),
        Variant("aroon_50", {"family": "aroon_trend", **BTC, "params": {"n": 50}}),
        Variant("aroon_25_sma200", {"family": "aroon_trend", **BTC, "params": {"n": 25, "trendSma": 200}}),
    ],
    verdict=verdict,
    tags=["trend"],
)

if __name__ == "__main__":
    run(THEORY)
