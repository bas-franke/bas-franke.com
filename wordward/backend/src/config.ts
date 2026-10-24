const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3005),
  host: env.HOST ?? '127.0.0.1',
  /** PostgreSQL for player accounts. Without it the game runs in guest mode (progress in cookies only). */
  databaseUrl: env.DATABASE_URL,
  /** Login and sign-up attempts allowed per IP per 10 minutes. */
  authAttempts: Number(env.AUTH_ATTEMPTS ?? 20),
  /** New accounts per IP per hour. */
  signupsPerHour: Number(env.SIGNUPS_PER_HOUR ?? 5),
};
