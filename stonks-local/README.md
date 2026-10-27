# Stonks research lab (`stonks-local/`)

The local, never-deployed half of [Stonks](../stonks/SPEC.md): Python code that downloads Bitvavo candles,
backtests trading strategy families with the exact fee and fill rules of SPEC section 2, and searches for the most
profitable ones for BTC and ETH. Up to 20 AI research agents run it in parallel; they share one experiment registry
(SQLite) so nobody repeats an experiment, write short lessons ("findings") for each other, and the best five
diverse strategies are uploaded to the dashboard at `https://stonks.bas-franke.com` (Research page).

Research agents: read [RESEARCH.md](RESEARCH.md) first. The latest digest of results is [FINDINGS.md](FINDINGS.md).

## Setup (Windows, Python 3.12)

```bash
cd stonks-local
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
```

Create the git-ignored `stonks-local/.env`:

```
STONKS_URL=https://stonks.bas-franke.com
STONKS_ADMIN_PASSWORD=...   # the dashboard password (same as STONKS_ADMIN_PASSWORD on the server)
TAAPI_SECRET=...            # optional, only for tools/check_indicators.py
```

Download candles (idempotent, only missing ranges are fetched):

```bash
.venv/Scripts/python tools/download.py --markets top10 --intervals all
.venv/Scripts/python tools/download.py --list
```

## Layout

| path | what |
|---|---|
| `stonks_lab/data.py`, `universe.py` | candle store (`data/candles/<MARKET>/<interval>.parquet`), the top-10 universe |
| `stonks_lab/families/` | strategy families (one module each; the 7 SPEC section 3 families are bot-ready) |
| `stonks_lab/backtest.py`, `evaluate.py` | SPEC fill model, walk-forward evaluation and the score |
| `stonks_lab/registry.py` | shared experiment memory: `data/lab.sqlite` (WAL, safe for 20 processes) |
| `stonks_lab/leaderboard.py` | diverse top 5 and the dashboard payload (SPEC section 7) |
| `stonks_lab/publish.py` | login + `POST /api/research` |
| `stonks_lab/tradechart.py`, `tools/trade_chart.py` | HTML chart of one backtest: every buy and sell on the price (sized by EUR, sells labelled with P&L), equity vs buy and hold, exposure, full trade table, round trips, CSV |
| `tools/theories/` | theory scripts: one hypothesis + variants + verdict each, with a trade chart per variant; `run_all.py` writes [THEORIES.md](THEORIES.md) |
| `lab.py` | the CLI below |
| `RESEARCH.md` | protocol for research agents |
| `FINDINGS.md` | generated digest (`lab.py digest`), committed |
| `data/`, `out/`, `.env`, `.venv/`, `STOP` | local only, git-ignored |

## Commands

All commands: `.venv/Scripts/python lab.py <command>` from `stonks-local/` (add `--json` for machine output,
`--db PATH` or `STONKS_LAB_DB` for another registry).

| command | does |
|---|---|
| `status` | counts, active lanes, coverage summary, STOP state, diverse top 5 |
| `coverage [--family F] [--untried]` | tried cells (family x interval x markets: done/failed/running, best score) and untried cells (`*` = no candles yet) |
| `findings [--lane L] [--tag T] [--agent A] [--limit N]` | shared lessons, oldest first |
| `top [-n N] [--diverse] [--family F] [--bot-ready]` | best experiments by out-of-sample score |
| `show HASH` | one experiment in full (hash prefix is fine) |
| `check SPEC` | is a spec already seen, or a near-duplicate? (doesn't run it) |
| `families` | families, bot-ready flag, defaults and param spaces |
| `lanes` / `lane claim|release LANE --agent A --round R --note "..."` | research lanes and who holds them (2 agents per lane) |
| `run SPEC --agent A --round R --hypothesis "..."` | claim, evaluate and record one spec (`SPEC` = file, `-` for stdin, or inline JSON); refuses duplicates and near-duplicates |
| `sweep --family F --interval I [--markets ...] --samples N --agent A --round R --hypothesis "..."` | random (or `--grid`) search of a family's param space; skips seen and near-duplicate specs; `--params/--risk/--execution` JSON hold knobs fixed; `--workers 2` default |
| `finding "text" --lane L --agent A --round R [--evidence h1,h2] [--tags dead-end,fees]` | record a lesson |
| `publish [--dry-run]` | build the top-5 payload, write `out/research.json`, upload it to the dashboard |
| `digest` | regenerate `FINDINGS.md` |

Create the file `stonks-local/STOP` to make every agent finish its current step and stop; delete it to resume.

## Tests

```bash
.venv/Scripts/python -m pytest tests -q
```
