"""t03: which TRIX rule works on ETH 1d: zero-line, signal-line or both?"""
from _harness import Theory, Variant, ret, run, sharpe

ETH = {"markets": ["ETH-EUR"], "interval": "1d"}


def verdict(r):
    z = max(sharpe(r["zero_n10"]), sharpe(r["zero_n20"]))
    s = max(sharpe(r["signal_n10"]), sharpe(r["signal_n20"]))
    best = max(r, key=lambda k: ret(r[k]))
    return z > s, f"best Sharpe zero-line {z:.2f} vs signal-line {s:.2f}; best return {best} {ret(r[best]):+.0f} %"


THEORY = Theory(
    name="t03_trix_modes",
    hypothesis="On ETH 1d the slow TRIX zero-line rule has a higher Sharpe than the faster signal-line rule, "
               "because the signal line whipsaws and pays fees.",
    variants=[Variant(f"{mode}_n{n}", {"family": "trix_trend", **ETH, "params": {"n": n, "signal": 9, "mode": mode}})
              for n in (10, 20) for mode in ("zero", "signal", "both")],
    verdict=verdict,
    tags=["trend"],
)

if __name__ == "__main__":
    run(THEORY)
