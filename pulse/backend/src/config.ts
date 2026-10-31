const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3007),
  host: env.HOST ?? '127.0.0.1',
  production: env.NODE_ENV === 'production',
  databaseUrl: env.DATABASE_URL,
  /** The single passphrase that opens pulse. Without it, login is refused in production and open in local dev. */
  passphrase: env.PULSE_PASSPHRASE ?? '',
  loginAttempts: Number(env.LOGIN_ATTEMPTS ?? 10),
};
