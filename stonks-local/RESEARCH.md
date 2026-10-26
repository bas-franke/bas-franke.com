# Research protocol (read this first)

You are one of up to 20 research agents looking for the most profitable trading strategies for **BTC-EUR and
ETH-EUR on Bitvavo** (maker fee 0.15 %, taker 0.25 %, every backtest starts with EUR 1000). You share one
experiment registry with the others: everything anybody ever ran is in it, and nobody runs the same thing twice.
The five best diverse strategies end up on the dashboard. The contract for strategies, fees and fills is
[`stonks/SPEC.md`](../stonks/SPEC.md); the backtester implements it exactly, you don't change it.

Work from `C:\Projects\bas-franke.com\stonks-local` and run everything with the lab's Python:

```bash
cd /c/Projects/bas-franke.com/stonks-local
PY=.venv/Scripts/python
$PY lab.py status
```

Your brief gives you an **agent id** (`agent-07`) and a **round** number. Use them on every command. If you get no
round number, count your own rounds from 1.

## The loop

Repeat until the file `stonks-local/STOP` exists (check before each step; if it exists, release your lane and stop):

1. **Read** (2 minutes, not more): `$PY lab.py status`, `$PY lab.py findings --limit 40`, the lane you are
   considering: `$PY lab.py findings --lane <lane>` and `$PY lab.py coverage --family <family>`. Skim
   [FINDINGS.md](FINDINGS.md) once per session (top results, dead ends, coverage matrix).
2. **Pick a lane** (below) that is free or thinly covered and claim it:
   `$PY lab.py lane claim <lane> --agent A --round R --note "what you'll try"`. Exit code 3 = two agents already
   hold it: pick another. Prefer untried cells (`$PY lab.py coverage --untried`) and ideas the findings suggest
   ("would a trend filter fix this?") over re-polishing a cell that already has 200 experiments.
3. **Hypothesis**: one falsifiable sentence, e.g. "A 200-day SMA regime filter cuts rsi_dip's 2022 drawdown
   without losing more than 10 % return on BTC 4h". It goes in `--hypothesis` and is stored with every experiment.
4. **Experiment**:
   - Parameter search: `$PY lab.py sweep --family F --interval I --markets BTC-EUR --samples 40 --agent A --round R --hypothesis "..."`
     (`--markets ETH-EUR`, `BTC-EUR ETH-EUR`, or `top10`; `--grid` for a grid; `--params '{"trendSma":200}'` holds
     params fixed; `--risk '{"stopLossPct":0.08}'` and `--execution '{"orderType":"market"}'` set overlays).
   - One hand-written spec: `$PY lab.py run spec.json --agent A --round R --hypothesis "..."` (or `-` for stdin,
     or inline JSON). `$PY lab.py check spec.json` tells you first whether it's been done.
   - Both refuse exact duplicates and skip near-duplicates (same family/interval/markets/non-numeric knobs and every
     numeric knob within 5 %). Don't work around that; if you have a real reason, `run --allow-near` and say why
     in the hypothesis.
   - Budget per round: about 100-200 evaluations, `--workers 2` (the default). One sweep at a time per agent.
5. **Look**: `$PY lab.py top --family F -n 10`, `$PY lab.py show <hash>`. Judge by `score` (out-of-sample, below),
   then by `vsBH` (holdout return minus buy and hold of the same markets), drawdown and trade count.
6. **Write 1-3 findings**, each one short, concrete and with evidence hashes:
   `$PY lab.py finding "rsi_dip on BTC 5m: every variant loses 30-60 %/yr to fees; trades > 2000" --lane scalp --agent A --round R --evidence 3f2a9c1b07,77d0e1aa42 --tags dead-end,fees`
   Good findings state the scope (family, interval, markets), the number, and what to try next or never again.
   Tag negative results `dead-end` (they appear in FINDINGS.md "Dead ends"). Tag bugs you notice `bug`.
7. **Release** the lane with a one-line summary: `$PY lab.py lane release <lane> --agent A --note "summary"`.
8. **Publish** only if your round put an experiment of yours into `$PY lab.py top --diverse -n 5`:
   `$PY lab.py publish`. If it says the dashboard isn't reachable, carry on: the payload is kept in `out/`.
9. Next round (R+1), back to 1.

## Lanes

| lane | what to explore |
|---|---|
| `dca` | DCA variants: schedule length, tranche count, dip add-ons, take-profit and partial sells (`dca_dip`) |
| `dip` | Buy the dip: RSI / drawdown / z-score entries, with and without a trend filter (`rsi_dip`) |
| `trend` | Trend following: EMA/SMA crosses, MACD, time-series momentum (`ema_cross`, `macd_trend`) |
| `breakout` | Breakouts: Donchian channels, volatility/range breakouts, new highs (`donchian_breakout`) |
| `reversion` | Mean reversion: Bollinger bands, z-score, short-term reversal (`bollinger_reversion`) |
| `rotation` | Market movement vs the other top-10 cryptos: rotation, relative strength, BTC/ETH ratio (`rotation_momentum`) |
| `regime` | Regime filters: trade only when BTC trends / volatility is low / most of the top 10 is rising |
| `multi-tf` | Multi-timeframe: a slow filter (1d/1W) with fast entries (1h/4h) |
| `scalp` | Minute level (1m-15m) with full fees: is anything left after 0.3-0.5 % round trips? |
| `long` | Weekly / long horizon (1d, 1W): slow allocation, rebalancing, cycle filters |
| `ensemble` | Combinations: vote or average of two families, trend + dip, rotation + regime |
| `risk` | Risk overlays on promising specs: stop loss, trailing stop, take profit, `maxWeight` sizing |
| `execution` | Limit offset, timeout and market fallback: how much do maker fees vs missed fills matter? |
| `invent` | New families (see below), e.g. volatility targeting, VWAP reversion, weekly seasonality |

Every lane should cover both BTC-EUR and ETH-EUR, and the time frames that make sense for it (1m to 1W). Lanes are
not walls: if your finding points into another lane, write it down and pick that lane next round.

## Rules

- **Never repeat an experiment.** Always go through `lab.py run`/`sweep`; never call `evaluate` in your own loop
  without recording it.
- **Never tune on the holdout.** Choose parameters by `score` (walk-forward folds) only. The holdout metrics
  (`test%`, `vsBH`) are the final exam: report them, don't optimise them, and never pick between variants by them.
- **Fees are fixed** (SPEC section 1-2). Don't lower them, don't skip the fill model, don't assume fills at the close.
- **Buy and hold is the benchmark, never a candidate.** A strategy that is just "hold" (or equivalent) does not count.
  If something loses to buy and hold, say so plainly in your finding.
- **Your files only.** Never edit another agent's family, nor `data.py`, `backtest.py`, `evaluate.py`,
  `registry.py`, `leaderboard.py`, `publish.py` or `lab.py`. Found a bug there? `finding ... --tags bug` and tell
  your coordinator.
- **Never delete or edit registry rows** (`data/lab.sqlite`). A failed experiment stays failed; after a genuine fix
  `run --retry-failed`.
- **Modest CPU**: at most 2 workers, one sweep at a time. 20 agents share 12 cores.
- **No look-ahead**: a decision at bar t may only use candles up to and including bar t.
- **Agents don't commit** registry data or `FINDINGS.md`; the coordinator runs `lab.py digest` and commits.
  A new family you wrote (module + test) is committed by you, on its own, with pathspecs
  (`git commit --only -m "stonks-local: family <name>" -- <paths>`), only when its tests pass.

## Score (how experiments are ranked)

`stonks_lab/evaluate.py` scores every spec out of sample (copied from its docstring):

- **Holdout** = the last 365 days of data (last 25 % if there are less than two years). Reported on the dashboard,
  **never** part of the score.
- The history before the holdout is cut into K+2 equal segments (K = 6 folds); fold k tests segment k+2 from a fresh
  EUR 1000 start. Buy and hold of the same markets (equal split, one taker buy) is run on every window.

```
x_f   = ln(final_f / 1000) - ln(buyHoldFinal_f / 1000)    log excess return over buy and hold, test fold f
dd_f  = max drawdown of the strategy in test fold f        (fraction, 0.3 = 30 %)
N     = fills summed over all test folds
score = 100 * ( median_f(x_f) - 0.5 * median_f(dd_f) ) - 10 * max(0, 1 - N / 20)
```

Roughly "percentage points of typical out-of-sample excess return over buy and hold, minus half the typical
drawdown, minus up to 10 points for fewer than 20 trades". Medians make one lucky fold count for little; fewer than
3 usable folds gives no score. Positive = it beat holding the same coins after fees and drawdown; most ideas
score below 0, which is a useful finding too. `lab.py show <hash>` has `scoreParts`, every fold and the holdout.

## Adding a family

Create `stonks_lab/families/<name>.py` (snake_case, unique; check `$PY lab.py families`):

```python
NAME = "vol_target"            # unique
VERSION = 1                    # bump when the logic changes (old results stay under the old version)
TITLE = "Volatility targeting"
MULTI_MARKET = False           # True if it can hold several markets at once
BOT_READY = False              # research families are never bot-ready; porting to the bot is separate work

def default_params() -> dict: ...
def param_space() -> dict:     # name -> {"type": "int"|"float", "min", "max", "log"?, "zero"?} | {"type": "bool"}
    ...                        #        | {"type": "choice", "values": [...]}, plus "description"
def valid_params(p) -> str | None: ...          # optional cross-param check, None = ok
def warmup(p) -> int: ...                       # optional: bars before the first decision
def targets(candles, spec, start_time=None):    # DataFrame indexed by ts (int64 ms), one column per market,
    ...                                         # weight 0..maxWeight decided at that bar's close, NaN = undecided
def explain(spec) -> dict:     # {"summary", "howItWorks": [...], "whenItWins", "whenItLoses"} in plain language
    ...
```

It is discovered automatically. Add `tests/test_family_<name>.py` (small synthetic candles: it buys when it should,
sells when it should); the generic no-look-ahead test in `tests/test_families.py` runs on every family. Run
`$PY -m pytest tests -q`, then sweep it. The helpers in `stonks_lab/families/_base.py` and
`stonks_lab/indicators.py` (EMA/RSI/Bollinger/MACD per SPEC) save time; import them, don't copy them.

## How results reach the dashboard

`$PY lab.py publish` ranks all done experiments by score, keeps at most 2 per family and drops near-identical
variants and specs with fewer than 5 trades in the test folds (sitting in cash is not a
strategy), takes the top 5, adds the holdout metrics, equity curves (400 points), buy-and-hold curves, benchmarks
(buy and hold BTC, ETH, equal-weight top 10), the family's plain-language explanation plus an honest
"vs buy and hold" sentence, and posts it to `https://stonks.bas-franke.com/api/research`. `--dry-run` only writes
`out/research.json`. Families that the bot implements are marked bot-ready; others show as "not yet runnable".
