import express, { type ErrorRequestHandler } from 'express';
import { accounts } from './accounts.js';
import { config } from './config.js';
import { dbConfigured, dbReady, migrate } from './db.js';

// The game runs in the browser (vocabulary included). The backend stores player accounts and their saves when a
// database is configured; without one the game works in guest mode with progress in cookies only.

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

app.get('/api/health', async (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), accounts: dbConfigured(), database: await dbReady() });
});

app.use('/api/account', accounts);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON.' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
};
app.use(onError);

async function main() {
  if (dbConfigured()) {
    try {
      await migrate();
    } catch (err) {
      // Keep serving (guest mode still works); account calls fail until the database is reachable.
      console.error('migrations failed', err);
    }
  } else console.log('DATABASE_URL is not set: accounts disabled, guest mode only');

  const server = app.listen(config.port, config.host, () => {
    console.log(`wordward backend listening on http://${config.host}:${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
