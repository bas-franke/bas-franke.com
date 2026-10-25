/**
 * Schema migrations, applied in order at startup (see db.ts). Never edit an applied
 * migration; add a new one.
 */
export const migrations: { name: string; sql: string }[] = [
  {
    name: '001_accounts',
    sql: `
      CREATE TABLE users (
        id             bigserial PRIMARY KEY,
        email          text NOT NULL,
        nickname       text NOT NULL,
        password_hash  text NOT NULL,
        verified_at    timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        last_seen_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX users_email ON users (lower(email));

      -- Only a SHA-256 of the session token is stored, so a database leak cannot be replayed as logins.
      CREATE TABLE sessions (
        token_hash  bytea PRIMARY KEY,
        user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL
      );
      CREATE INDEX sessions_user ON sessions (user_id);

      -- One-time links from the activation and password reset mails (hashed like sessions).
      CREATE TABLE email_tokens (
        token_hash  bytea PRIMARY KEY,
        user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose     text NOT NULL CHECK (purpose IN ('activate', 'reset')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        expires_at  timestamptz NOT NULL
      );
      CREATE INDEX email_tokens_user ON email_tokens (user_id);

      -- A copy of the player's browser storage (nickname, settings, game progress), merged with every device's copy.
      CREATE TABLE saves (
        user_id     bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        data        jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];
