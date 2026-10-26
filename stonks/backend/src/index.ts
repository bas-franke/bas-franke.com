import express, { type ErrorRequestHandler } from 'express';
import { api } from './api/index.js';
import { botHealth, startBot, stopBot } from './bot/index.js';
import { config } from './config.js';
import { dbConfigured, dbReady, migrate } from './db.js';

// Dashboard API plus the trading bot, which runs in this same process (SPEC.md).

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' })); // research snapshots carry equity curves

app.get('/api/health', async (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()), database: await dbReady(), ...(await botHealth()) });
});

app.use('/api', api);

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
      console.error('migrations failed', err);
    }
  } else console.log('DATABASE_URL is not set: the dashboard has no data and the bot stays idle');

  const server = app.listen(config.port, config.host, () => {
    console.log(`stonks backend listening on http://${config.host}:${config.port}`);
  });
  if (config.botLoop && dbConfigured()) startBot();

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    stopBot();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
