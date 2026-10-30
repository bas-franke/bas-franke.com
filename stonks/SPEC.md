# Stonks: shared spec

This file is the contract between the three parts of Stonks. Change it first when you change a contract, and keep
all three parts in line with it.

| Part | Folder | Runs where | Language |
|---|---|---|---|
| Dashboard (site) | `stonks/frontend` | browser, served by Nginx on `stonks.bas-franke.com` | React + TS (Vite) |
| API + trading bot | `stonks/backend` | EC2, PM2 process `stonks`, port **3006**, database `stonks` | Node + Express + TS |
| Research lab | `stonks-local/` | the owner's PC; only its family code goes to the server for live signals (§6b) | Python 3.12 |

The bot runs **inside** the backend process (one project = one PM2 process). It trades on Bitvavo.

## 1. Fees and money

- Bitvavo fee tier of the account: **maker 0.15 %**, **taker 0.25 %** (`settings.fees`). Every backtest and the paper
  broker charge these. Limit orders that rest on the book pay maker; market orders and limit orders that cross pay taker.
- Every research backtest starts with **€1000** cash and no coins.
- Amounts are decimal strings on the wire to Bitvavo; internally numbers (EUR amounts are small enough for doubles).
  Prices must be a multiple of the market's `tickSize` (`pricePrecision` is deprecated and comes back null; fallback
  5 significant digits), amounts are rounded down to `quantityDecimals`, and orders must meet both
  `minOrderInQuoteAsset` (usually €5) and `minOrderInBaseAsset` (all from `GET /v2/markets`).
- Bitvavo's `clientOrderId` must be a UUID. The `orders` table stores `stonks-<uuid>` and only the UUID is sent; the bot
  only ever touches orders that have such a row. It never calls `DELETE /orders` (that cancels every order in a market).

## 2. Strategy spec (shared by backtests and the bot)

A strategy is JSON. The research lab produces them, the dashboard shows them, the bot runs them.

```jsonc
{
  "id": "ema_cross-btc-4h-a1b2c3",        // unique, stable: family + market + interval + short hash of params
  "name": "EMA crossover, BTC 4h",          // human title
  "family": "ema_cross",                    // which algorithm (see §3)
  "familyVersion": 1,                       // bump when a family's logic changes
  "markets": ["BTC-EUR"],                   // markets it may hold; rotation families list several
  "interval": "4h",                         // candle interval it decides on: 1m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 1W
  "params": { "fast": 12, "slow": 48 },     // family-specific
  "risk": {
    "maxWeight": 1.0,                       // most of equity in coins at once (0..1)
    "stopLossPct": null,                    // e.g. 0.08: exit a position 8 % under its average entry
    "takeProfitPct": null,                  // e.g. 0.2
    "trailingStopPct": null
  },
  "execution": {
    "orderType": "limit",                   // "limit" (default, maker) or "market"
    "limitOffsetBps": 5,                    // buy at close*(1-offset), sell at close*(1+offset); 0 = at close
    "postOnly": true,                       // never pay taker on a limit order
    "timeoutBars": 1,                       // cancel an unfilled limit order after N bars...
    "fallback": "cancel"                    // ...then "cancel" (skip) or "market" (pay taker + slippage)
  }
}
```

### Decision model

Every family is a pure function of closed candles (plus its own deterministic state derived from them):

```
targets(candles by market up to and including the last CLOSED bar t) -> { [market]: weight 0..1 }
```

The weight is the fraction of total equity (EUR cash + coins at close price) the strategy wants in that market.
Sum of weights ≤ `risk.maxWeight`. The executor turns the difference between current and target holdings into
orders; differences smaller than €5 or 2 % of equity are ignored (no churn).

### Backtest fill model (the bot's paper broker uses the same rules on live prices)

- Decision at the close of bar `t`, orders become active at bar `t+1`.
- **Limit buy** at price `p` fills in a bar whose `low < p` (strictly, so touching is not enough); fill price `p`, maker fee.
  **Limit sell** fills when `high > p`. If the limit is already marketable when placed and `postOnly` is set, it is
  repriced to the best maker price instead (backtest: treated as resting at `p`).
- Unfilled after `timeoutBars` bars → cancelled, or with `fallback: "market"` filled at the next bar's open with
  **taker fee + 5 bps slippage**.
- **Market** orders fill at the next bar's open + 5 bps slippage (adverse), taker fee.
- Fees are paid in EUR (buy: you pay `amount*price*(1+fee)`; sell: you get `amount*price*(1-fee)`).
- Stops (`stopLossPct`, `trailingStopPct`) are checked against bar lows and exit as market orders; within one bar stops are
  checked before take profit (pessimistic). Take profit also exits at market. The average entry for stops/take profit is
  the plain average fill price. After a stop the market is locked until the strategy's target for it returns to 0.
- Limit buys reserve their cash while open (as on Bitvavo). Buys at one close are scaled together to the free cash; market
  buys leave room for fee + slippage. Cash from sells placed at the same close is only spent once it has arrived, so a
  rotation takes one extra bar.
- **Order-book chase (live bot and paper, `settings.bot.chase`, default on: 30 s / 10 min):** a limit order still
  unfilled `repriceSec` after it was placed is cancelled and placed again for its unfilled rest at the best bid (buy) or
  best ask (sell), post-only, unless it already sits there; once the first order of the chain is `marketAfterMin` old the
  rest goes out as a market order. Chased orders ignore `timeoutBars`/`fallback`. Backtests do not model the chase
  (they keep the limit-at-close + `timeoutBars` rule), so live fills are more certain and sometimes taker-priced.
  Only specs with the default execution (5 bps, 1 bar, cancel) follow the book (`followsBook`). A spec tuned to anything
  else rests at close∓offset with its own timeout and fallback, as researched; manual moves and stranded sells always chase.
- **Retries (live bot and paper):** each bar's plan is kept in `bot_state.decision`. A planned market and side with no
  working order (rejected, `canceledPostOnly`, crash before placing, a chase that ended unfilled) is placed again while the
  bar lasts: 60 s apart, 5 attempts including the first (`order_retry`, then the error `order_retries_exhausted`). Only
  what was planned is retried, so a rotation's buy still waits for the next decision, as in the backtest.
- Sizing values holdings and equity at the same close, like the backtest. Before placing, the bot reads the book and logs
  `thin_book` when the spread is over 30 bps or an order is over 20 % of the depth within 25 bps; that never blocks an order.
- **Paper fills** come from Bitvavo's public trades after the order's own `activeFrom`: a limit fills up to 25 % of the
  volume traded strictly through its price (the rest keeps resting), and a post-only order that would cross ends as
  `canceledPostOnly` instead of being repriced, so paper is stricter than live there.
- The live bot sizes every buy (limit ones too) to leave the **taker** fee plus 0.1 % of the
  cash free, because Bitvavo reserves the taker fee on open buy orders and refuses one that does not fit (code 216);
  backtests keep the maker-fee sizing, a difference of ~0.2 % of one buy.

## 3. Families the bot implements (v1)

Research may invent new families in Python. The bot can run **every** family the lab has: the ones below are ported
to `stonks/backend/src/strategies/` with a parity fixture (§6); every other family (or another version of one of
these) runs as the lab's own Python code on the server (§6b). A family is only "not yet runnable" while the server
does not have its code at the spec's `familyVersion` yet (the next deploy brings it).

| family | idea | params |
|---|---|---|
| `ema_cross` | trend: long while fast EMA > slow EMA | `fast`, `slow` |
| `macd_trend` | trend: long while MACD > signal (and optionally > 0) | `fast`, `slow`, `signal`, `requirePositive` |
| `donchian_breakout` | trend: buy on close above N-bar high, exit under M-bar low | `entry`, `exit` |
| `rsi_dip` | buy the dip: buy when RSI < `buyBelow`, sell when RSI > `sellAbove`, optional trend filter (close > SMA `trendSma`, 0 = off) | `period`, `buyBelow`, `sellAbove`, `trendSma` |
| `bollinger_reversion` | buy at lower band, sell at middle/upper | `period`, `stdDev`, `exitAt` ("middle"\|"upper") |
| `dca_dip` | DCA: deploy the starting cash in `tranches` equal buys every `everyBars` bars; a drop of `dipPct` from the recent `lookback` high buys an extra tranche; take profit sells `sellFraction` of the position at `takeProfitPct` above average entry | `everyBars`, `tranches`, `dipPct`, `lookback`, `takeProfitPct`, `sellFraction` |
| `rotation_momentum` | market movement: rank the `universe` (top-10 EUR markets) by `lookback`-bar return, hold the top `top` equally if their return > 0 (and optionally only if BTC is above its SMA `regimeSma`), else cash | `lookback`, `top`, `regimeSma` |
| `alt_froth` | hold the markets equally, but go to cash while a fixed pool of 9 altcoins listed since 2019 (XRP ADA LINK TRX LTC BCH XLM XTZ MIOTA; signal-only, never traded) beats BTC's `lookback`-bar log return by > `threshold`; back in under `threshold - band` after `minOut` bars; optional per-market SMA filter `trendSma` | `lookback`, `threshold`, `band`, `minOut`, `trendSma` |

Indicator definitions (both sides must match): EMA seeded with the SMA of the first `n` closes, `alpha = 2/(n+1)`;
RSI = Wilder's smoothing, 50 when prices are flat; Bollinger = SMA ± k·population std; MACD = EMA(fast) − EMA(slow),
signal = EMA(signal) of MACD; Donchian levels use the N bars **before** the current one. An indicator that isn't warm
yet means "out" (TS returns weight 0, Python NaN = no decision; fixtures start at the first valid bar).

Family details both sides implement (the docstrings in `stonks_lab/families/*.py` and `src/strategies/*.ts` are exact):
- `dca_dip` runs a fee-free virtual portfolio anchored at the strategy's start time (backtest: window start), measures
  the recent high from bar highs, re-arms dip buys only after the price recovers above the dip threshold, and keeps
  selling `sellFraction` each bar while above the take-profit level.
- `rotation_momentum` measures each market's lookback return on its own series, gives each slot `maxWeight/top` (unused
  slots stay cash), breaks ties by market name, and needs a BTC candle at bar t when the regime filter is on.
- Research uses today's top-10 for rotation and basket benchmarks, so those results carry survivorship bias.

## 4. Database (`stonks`, migrations in `backend/src/migrations.ts`)

| table | what |
|---|---|
| `settings` | `key text PK, value jsonb, updated_at`. Keys: `bot` (see §5), `paper_wallet` (`{ "EUR": 1000, "BTC": 0, ... }`), `bot_state` (per-mode day baseline, last decided bar, stop locks, trailing peaks) |
| `sessions` | dashboard logins: `token_hash bytea PK, created_at, expires_at, ip` |
| `orders` | one row per order the bot placed: mode, exchange ids, market, side, type, price, amount, filled, fee, status, strategy id, reason, raw |
| `fills` | one row per execution (Bitvavo trade or paper fill), unique on `(mode, exchange_trade_id)` |
| `bot_logs` | `id, ts, level ('debug'\|'info'\|'warn'\|'error'), event, message, data jsonb` |
| `equity_snapshots` | `ts, mode, total_eur, cash_eur, holdings jsonb` (every 5 min while the bot runs, plus on every fill) |
| `research_snapshots` | `id, created_at, payload jsonb`: the research lab's latest top-5 upload (§7); the newest row is shown |

## 5. Bot settings (`settings.bot`)

```jsonc
{
  "enabled": false,              // master switch; the owner turns it on from the dashboard. Deploys never change it.
  "mode": "paper",               // "paper" (simulated orders on live prices) or "live" (real Bitvavo orders)
  "strategy": { /* strategy spec, §2 */ },
  "maxExposureEur": null,        // null = may use the whole portfolio
  "dailyLossLimit": { "unit": "pct", "value": 15, "action": "no_buys" },  // loss over the last 24 h (realized + unrealized):
                                 // "pct" = % of the equity 24 h ago, "eur" = euros; action "alert" | "no_buys" | "stop"
  "fees": { "maker": 0.0015, "taker": 0.0025 },
  "paperStartEur": 1000,
  "activeResearch": null,        // set by POST /api/bot/activate (§8); reset to null when the strategy is changed by hand
  "chase": { "enabled": true, "repriceSec": 30, "marketAfterMin": 10 },  // order-book chase (§2)
  "manual": null                 // { target: "BTC"|"ETH"|"EUR", setAt } from POST /api/bot/allocate: while set the bot holds
                                 // everything there (BTC-EUR/ETH-EUR, 1m decisions, post-only limit at the best price,
                                 // re-placed each minute) instead of the strategy; a strategy change clears it
}
```

Loss guard (rolling 24 h): every tick the bot compares equity with its equity 24 h earlier (samples every 5 minutes in
`bot_state`; right after switching on, the window starts then). When `equity24hAgo - equityNow ≥ limit` (a `pct` limit
is that % of `equity24hAgo`) it logs one `error` event `daily_loss_limit` per trip and acts on `action`:
- `no_buys` (default): stays on, cancels open buys and withholds new ones; sells, stops and exits go on. Ends by itself
  (`guard_cleared`) once the loss is back under the limit. Withheld buys stay planned, so they go out if that happens in the same bar.
- `alert`: only reports it and keeps trading.
- `stop`: cancels its orders and sets `enabled: false` until the owner turns it on again. The position stays held with nothing
  managing it, which is why it is no longer the default: it cost 4-15 points a year on the books tested.

Backtests of the 15 % `no_buys` default cost 0-0.7 points a year; no action lowered the worst drop, which builds over weeks,
so the guard is a fault brake and not a drawdown tool (`stonks-local/FINDINGS.md`). A limit stored earlier keeps its value and only
gains the default action. No fresh numbers for 5 minutes logs the error `guard_blind`. Equity 0 never trips; a coin without a
ticker keeps its last known price, also across restarts. Deposits/withdrawals are not trades: equity
changes not explained by fills (beyond max(€2, 0.5 % of equity)) shift the baseline by their EUR value (logged as
`warn`), so real losses still count. Settings stored before this had `dailyLossLimitEur`: the old default €100 became
10 %, any other amount stays a euro limit. The Overview's "today" figure still counts from 00:00 Europe/Amsterdam.

In live mode the bot treats the whole Bitvavo account as its portfolio (owner's choice): BTC or ETH the strategy doesn't
want is sold at the next decision. Any other coin is left alone and reported once per strategy (`foreign_coin`).
`maxExposureEur` caps how much EUR it puts into coins.

Orders Bitvavo can't find for 10 minutes become status `unknown` (`order_unknown`): they stop blocking their side and are
rechecked every 5 minutes for 3 days through the order and then the trade history (`order_unknown_found`, `order_unknown_fills`),
so no fill is lost. Database calls time out after 30 s; a tick stuck for 5 minutes exits the process so PM2 restarts it
(`tick_stuck`). Shutdown waits up to 25 s for a running tick (`kill_timeout` 30 s). The clock resyncs hourly and on Bitvavo's
timestamp errors. `PUT /api/bot` with a strategy change while live needs `confirmLive`, like activate.

The bot only ever touches orders it created (its `clientOrderId`s start with the prefix `stonks-`) and never withdraws.

## 5a. Portfolio vs buy and hold (informative)

Once a minute the backend stores `track_points (ts, mode, portfolio_eur, btc_eur, eth_eur)`: BTC-EUR and ETH-EUR last
prices and the portfolio value of the bot's current mode (from the engine's last portfolio view; NULL when that is older
than 6 minutes). It runs beside the trading loop and never places orders or changes settings. `GET /api/compare?range=
day|week|month|year|all` returns the portfolio (equity_snapshots + track_points), BTC and ETH as `[ms, eur]` (at most 500
points each); where no track points exist yet, BTC/ETH come from Bitvavo candles. `all` starts at the first portfolio
point of the mode. The Overview indexes every line to 100 at the range start. `POST /api/portfolio-history/clear
{ confirm: "CLEAR" }` deletes that mode's equity_snapshots and track_points (charts only; trading never reads them).

## 5b. Expected vs actual, alerts and health

A runner beside the trading loop (`bot/shadow.ts`, no orders, no settings) reads the `decision` rows and keeps a virtual
portfolio that follows those targets by the backtest's rule: fills at the decision bar's close, maker fee, the €5 / 2 % dead-band,
starting from the real equity at the strategy's first decision. Tables `shadow_points` and `shadow_decisions`, state in
`settings.shadow_state`. It ignores `maxExposureEur`. Slippage per fill is the fill price against the decision close, adverse
positive. `GET /api/tracking` flags a gap worse than -5 % over 30+ days and average slippage over 25 bps across 10+ fills, and the
runner logs `tracking_drift` once a day while one holds.

Alerts (`bot/alerts.ts`) mail through SendGrid (`SENDGRID_API_KEY`, `MAIL_FROM`, `STONKS_ALERT_EMAIL`): every `error` and the
warnings `decision_held`, `stale_candles`, `foreign_coin`, `stop_skipped`, `tracking_drift`, one mail per event name per 30 minutes.
Unconfigured it does nothing. `POST /api/bot/test-alert` sends one.

`GET /api/health` stays public and has no amounts; `status` is `ok` or `degraded` (tick older than 120 s while on, last tick failed, or
no database, which also answers 503). The status page checks it. `GET /api/health/detail` (logged in) reports each part with
`ok|warn|fail|unknown`, and the dashboard's Health page shows it; `unknown` does not count toward the overall status.

## 6. Parity between Python and TypeScript

`stonks-local` exports, for each bot-ready family, a fixture `stonks/backend/test/fixtures/parity/<family>.json`:
`{ spec, candles: { [market]: [[t,o,h,l,c,v], ...] }, targets: [[t, { market: weight }], ...] }`.
`npm test` in `stonks/backend` replays the candles through the TS family and fails on any difference > 1e-9.

## 6b. Lab families on the server

For a spec whose family has no TypeScript port at its version, the bot runs the lab's code itself
(`src/strategies/runtime.ts` picks the engine, `src/strategies/python.ts` talks to `stonks_lab/live.py`):

- **What is deployed**: `deploy-stonks.yml` bundles `stonks_lab/{__init__,data,indicators,universe,live}.py` and
  `stonks_lab/families/*.py` (no backtester, evaluator, registry or research tools) to `/srv/apps/stonks/lab`, keeps a
  venv with `requirements.txt` in `/srv/apps/stonks/venv` and writes `lab/catalog.json` (every family with its param
  space) with it. Any change to those files triggers a deploy, so the server always runs the code the research tested.
- **Validation**: param types and ranges come from the catalog (0 is also allowed where the lab's space says `zero`);
  cross-param rules run in Python (`describe`) when a strategy is saved or activated. A spec may carry `universe`
  (e.g. `top10_pit`), which the lab reads.
- **Same data as the backtest**: lab families decide on the full candle history, like the backtest, not on a warmup
  window (expanding fits, placebo draws and state machines depend on all of it). `data.py` keeps it in
  `/srv/apps/stonks/labdata`: the first decision of a new strategy starts a one-time background download (`prepare`;
  1m keeps the last 400 days like the lab) and that bar waits for it (`history_loading` / `history_ready` events);
  after that each decision only fetches the newest closed bars and decides at exactly the bar the bot is on.
- **Per decision**: `python -m stonks_lab.live targets` gets `{ spec, bar, startTime? }` and answers the weights at
  `bar`; a NaN market in a row = out (0). `{ hold, t? }` means there is no trustworthy decision, so every position stays and
  no order goes out: an all-NaN row (the backtest's "no decision"), no history, or a needed candle that is stale. The bot retries
  until the grace period, then logs `decision_held`. An all-zero answer with `t: null` counts as a hold too. Spec markets, BTC and
  ETH count as stale when they lag; another pool coin only when its update failed, since quiet coins have gaps. Anchored families (`ANCHORED = True`) get the strategy's start time like `dca_dip`. The bot
  clamps to `risk.maxWeight` and applies risk exits and execution exactly as for TypeScript families.
- **Version bumps**: a deployed lab change that bumps the running family's `VERSION` makes the stored strategy invalid,
  so the bot switches itself off (`settings_invalid`) instead of trading changed logic; activate the new research.
- **History**: only what really downloaded counts as ready (`live_ready_v2.json`), and `prepare` also runs the family once, so
  the candles it reads itself are warm before `targets` is asked, keyed by code hash. Each update refetches the last 2 stored
  bars, because a bar saved seconds after its close can be provisional. The prepare lock goes stale after 15 minutes (60 s
  heartbeat); a busy prepare is not "ready", it waits 60 s, and failures back off 1-30 minutes.
- **Same-version changes**: `catalog.json` holds a `codeHash` per family (its file, sibling imports, shared helpers, a wrapper's
  `inner`). The bot stores it when a strategy starts and logs the error `family_code_changed` once if it differs, but keeps
  trading. `universe` is not applied by `live.py`; it would matter only if the bot traded more than BTC and ETH.
- `botReady` in `GET /api/research` is decided by the backend (`isRunnable`: TypeScript port or lab catalog at that
  version), not by the lab's flag.

## 7. HTTP API (`/api`, JSON)

Everything except `GET /api/health` and `POST /api/auth/login` needs the session cookie `stonks_session`
(HttpOnly, Secure in production, SameSite=Strict, 30 days). The password is `STONKS_ADMIN_PASSWORD` from the env.
State-changing requests need `Content-Type: application/json` (body-less POSTs may instead carry an `Origin` matching
the host); an `Origin` that doesn't match the host is refused. Errors are `{ error: "message" }`. Responses use
camelCase and numbers (not numeric strings).

| method + path | body / query | returns |
|---|---|---|
| `GET /api/health` | | `{ status:"ok", database:bool, bitvavo:bool, bot:{enabled,mode} }` (no amounts) |
| `POST /api/auth/login` | `{ password }` | `{ ok:true }` + cookie; 401 wrong; 429 after 10 tries / 10 min per IP |
| `POST /api/auth/logout` | | `{ ok:true }` |
| `GET /api/auth/me` | | `{ loggedIn:true }` or 401 |
| `GET /api/overview` | | `{ bot: settings.bot, running:bool, lastTickAt, bitvavo:{connected, error?}, balances:[{symbol, available, inOrder, eurValue}], equityEur, todayPnlEur, last24hPnlEur, lossWindowSince, dailyLossLimit, dailyLossLimitEur (the limit in euros now), openOrders:n, strategyExplanation, activeResearch }` |
| `PUT /api/bot` | partial `settings.bot` | updated `settings.bot`; switching `mode` to `live` needs `{ confirmLive:true }`; validated |
| `POST /api/bot/activate` | `{ researchId, bucket, rank, start, confirmLive? }` | `{ ok, bot, activeResearch, started, startError? }`; 400 not bot-ready / unknown family / live without confirm, 409 when `researchId` is not the newest snapshot (§8) |
| `POST /api/bot/allocate` | `{ target: "BTC"\|"ETH"\|"EUR"\|null, confirmLive? }` | `{ ok, bot, started, startError? }`; moves everything to one coin or euros (switches the bot on), `null` = back to the strategy; 400 live without confirm |
| `GET /api/hall-of-fame` | | `{ entries: [{ id, addedAt, researchId, bucket, rank, entry }] }`, newest first; `entry` = the research entry as kept (§7 shape, `botReady` = runnable on this server now) |
| `GET /api/bot/paper-record` | `?strategyId=` | `{ days, fills, firstAt }`: that spec's paper record. Going live, or changing a live strategy, with under 14 days or 5 fills answers 409 `{ error, paperGate:{ days, fills, needDays, needFills } }` unless the body has `skipPaperGate:true`; manual allocation is exempt |
| `GET /api/tracking` | `?mode=&range=day\|week\|month\|year\|all` | expected vs actual vs hold, gap, slippage, drift alerts (§5b) |
| `GET /api/health/detail` | | `{ status, checkedAt, bot, components:{ engine, database, bitvavo, clock, decision, candles, lab, alerts, lossGuard, orders, stuckOrders, shadow, process }, events }` (§5b) |
| `POST /api/bot/test-alert` | `{}` | `{ ok, configured, error? }` |
| `POST /api/hall-of-fame` | `{ researchId, bucket, rank }` | `{ ok, id }`; copies that entry from that stored snapshot; 409 when the same spec is already kept |
| `DELETE /api/hall-of-fame/:id` | `{}` | `{ ok }`; only the owner removes entries, nothing else ever does |
| `POST /api/bot/start` / `POST /api/bot/stop` | | updated `settings.bot` (stop also cancels the bot's open orders) |
| `GET /api/orders` | `?mode=&market=&limit=&before=` | `{ orders:[...] }` newest first |
| `GET /api/fills` | same | `{ fills:[...] }` |
| `GET /api/equity` | `?mode=&days=` | `{ mode, points:[{ts,totalEur,cashEur}] }` (≤ 1500 points; optional `buyHold:[{ts,totalEur}]`) |
| `GET /api/logs` | `?level=&after=<id>&before=<id>&limit=` | `{ logs:[...] }` newest first; `level` is a minimum; `after` returns the oldest entries after that id so a live tail never skips |
| `GET /api/strategies/families` | | the bot-ready families with param descriptions |
| `GET /api/markets` | | Bitvavo EUR markets (cached 1 h) |
| `GET /api/research` | | newest research snapshot payload or `{ empty:true }` |
| `POST /api/research` | payload below | `{ ok:true, id }` (session cookie: the lab logs in with the same password) |
| `GET /api/notes` | | `{ text, updatedAt }` the personal scratch pad (`settings` key `notes`); `{ text:"", updatedAt:null }` when nothing is saved yet |
| `PUT /api/notes` | `{ text }` | `{ ok:true }`; `text` is a string of at most 50 000 characters |

### Research payload (`POST /api/research`)

```jsonc
{
  "generatedAt": "2026-10-26T12:00:00Z",
  "summary": { "experiments": 18234, "families": 23, "rounds": 41, "dataRange": ["2019-01-01","2026-10-25"],
               "notes": "short plain-language state of the research" },
  "benchmark": { "name": "Buy and hold BTC", "returnPct": 412.3, "maxDrawdownPct": 76.1, "equity": [[t, eur], ...] },
  "benchmarks": [ /* same shape: buy and hold ETH, and an equal-weight top-10 basket */ ],
  "top": [                      // exactly the 5 best, rank 1 first
    {
      "rank": 1,
      "spec": { /* strategy spec, §2 */ },
      "botReady": true,
      "metrics": {              // out-of-sample (test period) unless the key says otherwise
        "finalEur": 2140.5, "returnPct": 114.05, "cagrPct": 31.2, "maxDrawdownPct": 18.4, "sharpe": 1.42,
        "trades": 87, "winRatePct": 54.0, "feesEur": 38.2, "exposurePct": 46.0,
        "vsBuyHoldPct": -12.3,  // return difference to buy-and-hold of the same market(s) over the same period
        "trainReturnPct": 160.2, "testPeriod": ["2024-07-01","2026-10-25"]
      },
      "equity": [[t, eur], ...],            // test period, ≤ 400 points
      "buyHoldEquity": [[t, eur], ...],     // same timestamps
      "explanation": {
        "summary": "One or two plain sentences.",
        "howItWorks": ["step", "step", "..."],
        "whenItWins": "...", "whenItLoses": "...",
        "vsBuyHold": "Plain-language comparison with buy and hold."
      },
      "lineage": { "experimentId": "...", "agent": "agent-07", "round": 41, "parent": "..." }
    }
  ]
}
```

## 8a. Hall of fame

Strategies the owner keeps forever (table `hall_of_fame`: id, created_at, research_id, bucket, rank, spec_key unique,
entry jsonb). Each row is a full copy of a research entry, so new uploads and the pruning of `research_snapshots`
(newest 200 kept) never change or delete it; only `DELETE /api/hall-of-fame/:id` does. `POST /api/bot/activate` with
`{ hallOfFameId, start, confirmLive? }` activates the kept copy; `activeResearch` is then
`{ researchId: <hall id>, bucket: "hall", rank: 1, ... }`.

## 8b. Strategy write-ups

Long-form explanations of single strategies, table `writeups (spec_id PK, title, body jsonb, updated_at)`, keyed by the
research spec's `id`. A research card whose spec id has a write-up shows "Read the full write-up", which opens
`/writeup?spec=<id>`. Body: `{ title, subtitle?, sections: [...] }`, section types `text`, `heading`, `candles`,
`rules`, `callout`, `example` (eli5, story, charts with `[ms, value]` series, an optional position band, events,
result), `table`. API: `GET /api/writeups` (list), `GET /api/writeups/:specId`, `PUT /api/writeups/:specId` (logged
in; large bodies allowed like research uploads). Example charts are made-up prices run through the strategy's real code.

## 8. Timeframe buckets (research v2)

Research is ranked separately per **timeframe bucket**, each judged on windows that fit how long its trades last.
A strategy belongs to the bucket of its decision interval (`spec.interval`):

| bucket | intervals | evaluation profile (eval v4, short buckets only) |
|---|---|---|
| `minute` | 1m, 5m, 15m | data: last 400 days (1m) / since 2019 (5m, 15m) but folds only over the last 400 days; holdout = last 60 days; 6 folds of equal length before it |
| `hourly` | 30m, 1h, 2h, 4h | folds over the last 3 years; holdout = last 120 days; 6 folds |
| `daily` | 6h, 8h, 12h, 1d | unchanged eval v3 (folds since 2019, holdout = last 365 days) |
| `weekly` | 1W | eval v3 windows on weekly bars (folds since 2019, holdout = last 365 days) |
| `mixed` | any | strategies that decide on more than one candle size (family flag `MIXED_TIMEFRAMES` or `mixed_timeframes(spec)`, e.g. a daily lead with a 15m crash guard); they are left out of the interval buckets. `intervals` = the trading intervals of its entries |

Scores are only comparable within a bucket. Each bucket carries its own buy-and-hold reference score and placebo
(random timing) luck line computed on the same profile. Fees and fill rules (§1-2) are identical in every bucket.

### Research payload v2

The payload keeps every v1 field (old dashboards still work: `top` = the daily bucket) and adds:

```jsonc
"buckets": {
  "minute": {
    "label": "Minute trading", "intervals": ["1m","5m","15m"],
    "profile": { "holdoutDays": 60, "folds": 6, "foldSpanDays": 56, "dataFrom": "2025-09-21" },
    "holdScore": -20.1, "luckLine": { "median": -35.0, "best": -8.0, "exposure": 0.7 },
    "benchmark": { /* buy and hold BTC over this bucket's holdout, same shape as §7 benchmark */ },
    "notes": "plain-language state of this bucket",
    "top": [ /* 0-5 entries, same shape as §7 top entries */ ]
  },
  "hourly": { ... }, "daily": { ... }, "weekly": { ... }, "mixed": { ... }
}
```

A bucket may have fewer than 5 (or 0) entries when nothing qualifies; its `notes` say why (e.g. "nothing beats
buy and hold after fees at minute level").

### Activating a research strategy in the bot

Every top entry with `botReady: true` can be activated from the dashboard with one action:
`POST /api/bot/activate` body `{ "researchId": <snapshot id>, "bucket": "hourly", "rank": 2, "start": true|false,
"confirmLive"?: true }`. The backend copies that entry's `spec` from the stored snapshot (never from the request
body), validates it, saves it as `settings.bot.strategy` (cancelling the bot's open orders for the old strategy),
records `settings.bot.activeResearch = { researchId, bucket, rank, name, activatedAt }`, and when `start` is true
also switches the bot on in its current mode (live mode still needs `confirmLive: true`). Entries with
`botReady: false` (the server does not have that family version yet, §6b) cannot be activated.
