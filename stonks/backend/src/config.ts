const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3006),
  host: env.HOST ?? '127.0.0.1',
  production: env.NODE_ENV === 'production',
  /** PostgreSQL with settings, orders, fills, logs and research snapshots (see SPEC.md §4). */
  databaseUrl: env.DATABASE_URL,
  /** The one dashboard password. Without it nobody can log in. */
  adminPassword: env.STONKS_ADMIN_PASSWORD ?? '',
  /** Bitvavo API key with View + Trade rights (no Withdraw), IP-whitelisted to the server. */
  bitvavoKey: env.BITVAVO_API_KEY ?? '',
  bitvavoSecret: env.BITVAVO_API_SECRET ?? '',
  bitvavoUrl: env.BITVAVO_URL ?? 'https://api.bitvavo.com/v2',
  /** Bitvavo requires an operatorId on every order; any integer that identifies this bot. */
  bitvavoOperatorId: Number(env.BITVAVO_OPERATOR_ID ?? 1001),
  /** Set to 0 to keep the bot loop from starting at all (local development without keys). */
  botLoop: env.STONKS_BOT_LOOP !== '0',
  /** Login attempts per IP per 10 minutes. */
  loginAttempts: Number(env.LOGIN_ATTEMPTS ?? 10),
};
