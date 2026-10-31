// Local development only: runs a throwaway PostgreSQL in ./.pg so accounts work without an install.
// Production uses the shared RDS instance (DATABASE_URL in /srv/apps/pulse/.env).
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.env.DEV_DB_PORT ?? 5437);

const pg = new EmbeddedPostgres({
  databaseDir: './.pg',
  user: 'pulse',
  password: 'pulse',
  port,
  persistent: true,
  onLog: () => {},
  onError: (msg) => console.error(String(msg)),
});

const run = async () => {
  await pg.initialise().catch(() => {}); // already initialised on later runs
  await pg.start();
  try {
    await pg.createDatabase('pulse');
  } catch {
    // exists
  }
  console.log(`dev postgres ready: postgres://pulse:pulse@127.0.0.1:${port}/pulse?sslmode=disable`);
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
