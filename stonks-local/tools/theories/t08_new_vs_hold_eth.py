"""t08: does any of the six new families beat buy and hold on ETH 1d, risk-adjusted?"""
from _harness import Theory, Variant, bh_dd, dd, ret, run, sharpe

ETH = {"markets": ["ETH-EUR"], "interval": "1d"}
NEW = ("aroon_trend", "vortex_trend", "trix_trend", "coppock_curve", "williams_dip", "elder_impulse")


def verdict(r):
    any_v = next(iter(r.values()))
    bh_sharpe = any_v["buyHold"].get("sharpe") or 0.0
    ok = [k for k, v in r.items() if dd(v) < bh_dd(v) and sharpe(v) > bh_sharpe]
    return bool(ok), (f"B&H Sharpe {bh_sharpe:.2f} / DD {bh_dd(any_v):.0f} %; beat it: {', '.join(ok) or 'none'}; "
                      + ", ".join(f"{k} {ret(v):+.0f} %/Sharpe {sharpe(v):.2f}/DD {dd(v):.0f} %" for k, v in r.items()))


THEORY = Theory(
    name="t08_new_vs_hold_eth",
    hypothesis="At least one of the six new families (default params) beats ETH 1d buy and hold on both Sharpe and "
               "max drawdown.",
    variants=[Variant(f, {"family": f, **ETH}) for f in NEW],
    verdict=verdict,
    tags=["benchmark"],
)

if __name__ == "__main__":
    run(THEORY)
