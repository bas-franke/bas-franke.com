// Local development only: runs a throwaway PostgreSQL in ./.pg so accounts work without an install.
// Production uses the shared RDS instance (DATABASE_URL in /srv/apps/play/.env).
import EmbeddedPostgres from 'embedded-postgres';

const port = Number(process.env.DEV_DB_PORT ?? 5436);

const pg = new EmbeddedPostgres({
  databaseDir: './.pg',
  user: 'play',
  password: 'play',
  port,
  persistent: true,
  onLog: () => {},
  onError: (msg) => console.error(String(msg)),
});

const run = async () => {
  await pg.initialise().catch(() => {}); // already initialised on later runs
  await pg.start();
  try {
    await pg.createDatabase('play');
  } catch {
    // exists
  }
  console.log(`dev postgres ready: postgres://play:play@127.0.0.1:${port}/play?sslmode=disable`);
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
