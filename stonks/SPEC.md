# Stonks: shared spec

This file is the contract between the three parts of Stonks. Change it first when you change a contract, and keep
all three parts in line with it.

| Part | Folder | Runs where | Language |
|---|---|---|---|
| Dashboard (site) | `stonks/frontend` | browser, served by Nginx on `stonks.bas-franke.com` | React + TS (Vite) |
| API + trading bot | `stonks/backend` | EC2, PM2 process `stonks`, port **3006**, database `stonks` | Node + Express + TS |
| Research lab | `stonks-local/` | the owner's PC only, never deployed | Python 3.12 |

The bot runs **inside** the backend process (one project = one PM2 process). It trades on Bitvavo.

## 1. Fees and money

- Bitvavo fee tier of the account: **maker 0.15 %**, **taker 0.25 %** (`settings.fees`). Every backtest and the paper
  broker charge these. Limit orders that rest on the book pay maker; market orders and limit orders that cross pay taker.
- Every research backtest starts with **€1000** cash and no coins.
- Amounts are decimal strings on the wire to Bitvavo; internally numbers (EUR amounts are small enough for doubles).
  Round prices/amounts to the market's `pricePrecision` (significant digits) / `quantityDecimals` from `GET /v2/markets`,
  and respect `minOrderInQuoteAsset` (usually €5).

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
- Stops (`stopLossPct`, `trailingStopPct`) are checked against bar lows and exit as market orders.

## 3. Families the bot implements (v1)

Research may invent new families in Python. A family is **bot-ready** only once it is also implemented in
`stonks/backend/src/strategies/` with a parity fixture (§6). Until then the dashboard shows it with "not yet runnable".

| family | idea | params |
|---|---|---|
| `ema_cross` | trend: long while fast EMA > slow EMA | `fast`, `slow` |
| `macd_trend` | trend: long while MACD > signal (and optionally > 0) | `fast`, `slow`, `signal`, `requirePositive` |
| `donchian_breakout` | trend: buy on close above N-bar high, exit under M-bar low | `entry`, `exit` |
| `rsi_dip` | buy the dip: buy when RSI < `buyBelow`, sell when RSI > `sellAbove`, optional trend filter (close > SMA `trendSma`, 0 = off) | `period`, `buyBelow`, `sellAbove`, `trendSma` |
| `bollinger_reversion` | buy at lower band, sell at middle/upper | `period`, `stdDev`, `exitAt` ("middle"\|"upper") |
| `dca_dip` | DCA: deploy the starting cash in `tranches` equal buys every `everyBars` bars; a drop of `dipPct` from the recent `lookback` high buys an extra tranche; take profit sells `sellFraction` of the position at `takeProfitPct` above average entry | `everyBars`, `tranches`, `dipPct`, `lookback`, `takeProfitPct`, `sellFraction` |
| `rotation_momentum` | market movement: rank the `universe` (top-10 EUR markets) by `lookback`-bar return, hold the top `top` equally if their return > 0 (and optionally only if BTC is above its SMA `regimeSma`), else cash | `lookback`, `top`, `regimeSma` |

Indicator definitions (both sides must match): EMA seeded with the SMA of the first `n` closes, `alpha = 2/(n+1)`;
RSI = Wilder's smoothing; Bollinger = SMA ± k·population std; MACD = EMA(fast) − EMA(slow), signal = EMA(signal) of MACD.

## 4. Database (`stonks`, migrations in `backend/src/migrations.ts`)

| table | what |
|---|---|
| `settings` | `key text PK, value jsonb, updated_at`. Keys: `bot` (see §5), `paper_wallet` (`{ "EUR": 1000, "BTC": 0, ... }`) |
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
  "dailyLossLimitEur": 100,      // loss since 00:00 Europe/Amsterdam (realized + unrealized) that switches the bot off
  "fees": { "maker": 0.0015, "taker": 0.0025 },
  "paperStartEur": 1000
}
```

Daily loss guard: at 00:00 Europe/Amsterdam the bot records start-of-day equity. When `startOfDay - equityNow ≥
dailyLossLimitEur` it cancels its open orders, sets `enabled: false`, logs an `error` event `daily_loss_limit` and stays
off until the owner turns it on again. Deposits/withdrawals are not trades: equity changes not explained by fills
reset the start-of-day baseline (logged as `warn`).

The bot only ever touches orders it created (its `clientOrderId`s start with the prefix `stonks-`) and never withdraws.

## 6. Parity between Python and TypeScript

`stonks-local` exports, for each bot-ready family, a fixture `stonks/backend/test/fixtures/parity/<family>.json`:
`{ spec, candles: { [market]: [[t,o,h,l,c,v], ...] }, targets: [[t, { market: weight }], ...] }`.
`npm test` in `stonks/backend` replays the candles through the TS family and fails on any difference > 1e-9.

## 7. HTTP API (`/api`, JSON)

Everything except `GET /api/health` and `POST /api/auth/login` needs the session cookie `stonks_session`
(HttpOnly, Secure in production, SameSite=Strict, 30 days). The password is `STONKS_ADMIN_PASSWORD` from the env.

| method + path | body / query | returns |
|---|---|---|
| `GET /api/health` | | `{ status:"ok", database:bool, bitvavo:bool, bot:{enabled,mode} }` (no amounts) |
| `POST /api/auth/login` | `{ password }` | `{ ok:true }` + cookie; 401 wrong; 429 after 10 tries / 10 min per IP |
| `POST /api/auth/logout` | | `{ ok:true }` |
| `GET /api/auth/me` | | `{ loggedIn:true }` or 401 |
| `GET /api/overview` | | `{ bot: settings.bot, running:bool, lastTickAt, bitvavo:{connected, error?}, balances:[{symbol, available, inOrder, eurValue}], equityEur, todayPnlEur, dailyLossLimitEur, openOrders:n, strategyExplanation }` |
| `PUT /api/bot` | partial `settings.bot` | updated `settings.bot`; switching `mode` to `live` needs `{ confirmLive:true }`; validated |
| `POST /api/bot/start` / `POST /api/bot/stop` | | updated `settings.bot` (stop also cancels the bot's open orders) |
| `GET /api/orders` | `?mode=&market=&limit=&before=` | `{ orders:[...] }` newest first |
| `GET /api/fills` | same | `{ fills:[...] }` |
| `GET /api/equity` | `?mode=&days=` | `{ points:[{ts,totalEur}] }` |
| `GET /api/logs` | `?level=&after=<id>&limit=` | `{ logs:[...] }` (the dashboard polls with `after` for a live tail) |
| `GET /api/strategies/families` | | the bot-ready families with param descriptions |
| `GET /api/markets` | | Bitvavo EUR markets (cached 1 h) |
| `GET /api/research` | | newest research snapshot payload or `{ empty:true }` |
| `POST /api/research` | payload below | `{ ok:true, id }` (session cookie: the lab logs in with the same password) |

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
