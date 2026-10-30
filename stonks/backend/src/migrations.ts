/**
 * Schema migrations, applied in order at startup (see db.ts). Never edit an applied migration; add a new one.
 * The tables are described in SPEC.md §4.
 */
export const migrations: { name: string; sql: string }[] = [
  {
    name: '001_core',
    sql: `
      CREATE TABLE settings (
        key         text PRIMARY KEY,
        value       jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      -- Only a SHA-256 of the session token is stored, so a database leak cannot be replayed as a login.
      CREATE TABLE sessions (
        token_hash  bytea PRIMARY KEY,
        created_at  timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL,
        ip          text
      );

      CREATE TABLE orders (
        id                 bigserial PRIMARY KEY,
        mode               text NOT NULL CHECK (mode IN ('paper', 'live')),
        client_order_id    text NOT NULL UNIQUE,
        exchange_order_id  text,
        market             text NOT NULL,
        side               text NOT NULL CHECK (side IN ('buy', 'sell')),
        order_type         text NOT NULL,
        price              numeric,
        amount             numeric NOT NULL,
        filled_amount      numeric NOT NULL DEFAULT 0,
        filled_quote       numeric NOT NULL DEFAULT 0,
        fee_paid           numeric NOT NULL DEFAULT 0,
        fee_currency       text,
        status             text NOT NULL,
        strategy_id        text,
        reason             text,
        raw                jsonb,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX orders_created ON orders (created_at DESC);
      CREATE INDEX orders_open ON orders (status) WHERE status IN ('new', 'partiallyFilled', 'awaitingTrigger');

      CREATE TABLE fills (
        id                 bigserial PRIMARY KEY,
        order_id           bigint REFERENCES orders(id) ON DELETE SET NULL,
        mode               text NOT NULL CHECK (mode IN ('paper', 'live')),
        exchange_trade_id  text NOT NULL,
        market             text NOT NULL,
        side               text NOT NULL,
        price              numeric NOT NULL,
        amount             numeric NOT NULL,
        quote              numeric NOT NULL,
        fee                numeric NOT NULL DEFAULT 0,
        fee_currency       text,
        taker              boolean,
        executed_at        timestamptz NOT NULL,
        UNIQUE (mode, exchange_trade_id)
      );
      CREATE INDEX fills_executed ON fills (executed_at DESC);

      CREATE TABLE bot_logs (
        id       bigserial PRIMARY KEY,
        ts       timestamptz NOT NULL DEFAULT now(),
        level    text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
        event    text NOT NULL,
        message  text NOT NULL,
        data     jsonb
      );
      CREATE INDEX bot_logs_ts ON bot_logs (ts DESC);

      CREATE TABLE equity_snapshots (
        ts         timestamptz NOT NULL DEFAULT now(),
        mode       text NOT NULL,
        total_eur  numeric NOT NULL,
        cash_eur   numeric NOT NULL,
        holdings   jsonb NOT NULL
      );
      CREATE INDEX equity_snapshots_ts ON equity_snapshots (mode, ts DESC);

      CREATE TABLE research_snapshots (
        id          bigserial PRIMARY KEY,
        created_at  timestamptz NOT NULL DEFAULT now(),
        payload     jsonb NOT NULL
      );
    `,
  },
  {
    // Strategies the owner keeps forever: full copies of research entries, independent of research_snapshots (which
    // keep only the newest 200 uploads). Rows only go away when the owner removes them.
    name: '002_hall_of_fame',
    sql: `
      CREATE TABLE hall_of_fame (
        id           bigserial PRIMARY KEY,
        created_at   timestamptz NOT NULL DEFAULT now(),
        research_id  bigint,
        bucket       text NOT NULL,
        rank         integer NOT NULL,
        spec_key     text NOT NULL UNIQUE,
        entry        jsonb NOT NULL
      );
    `,
  },
  {
    // Informative comparison tracking (SPEC §5a): every minute BTC-EUR, ETH-EUR and the portfolio of the current mode.
    name: '003_track_points',
    sql: `
      CREATE TABLE track_points (
        ts             timestamptz NOT NULL,
        mode           text NOT NULL,
        portfolio_eur  numeric,
        btc_eur        numeric,
        eth_eur        numeric
      );
      CREATE INDEX track_points_ts ON track_points (mode, ts);
    `,
  },
  {
    // Long-form explanations of single strategies (SPEC §8b), keyed by the strategy's spec id.
    name: '004_writeups',
    sql: `
      CREATE TABLE writeups (
        spec_id     text PRIMARY KEY,
        title       text NOT NULL,
        body        jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // The owner orders the hall of fame by hand. Existing rows keep today's order (newest first); new rows go on top.
    name: '005_hall_of_fame_position',
    sql: `
      ALTER TABLE hall_of_fame ADD COLUMN position integer;
      UPDATE hall_of_fame h SET position = o.n FROM (SELECT id, row_number() OVER (ORDER BY id DESC) AS n FROM hall_of_fame) o WHERE h.id = o.id;
    `,
  },
  {
    // Expected vs actual (SPEC §5b): a virtual portfolio following the decisions. Rebuilt from bot_logs when needed, so
    // the keys make a replay add nothing twice. shadow_decisions keeps each bar's closes for the slippage of its fills.
    name: '006_shadow_tracking',
    sql: `
      CREATE TABLE shadow_points (
        ts            timestamptz NOT NULL,
        mode          text NOT NULL,
        strategy_id   text NOT NULL,
        expected_eur  numeric NOT NULL,
        actual_eur    numeric,
        hold_eur      numeric NOT NULL,
        PRIMARY KEY (mode, strategy_id, ts)
      );

      CREATE TABLE shadow_decisions (
        mode         text NOT NULL,
        strategy_id  text NOT NULL,
        bar          bigint NOT NULL,
        ts           timestamptz NOT NULL,
        prices       jsonb NOT NULL,
        with_orders  boolean NOT NULL,
        PRIMARY KEY (mode, strategy_id, bar)
      );
    `,
  },
];
