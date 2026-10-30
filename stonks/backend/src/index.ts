import express, { type ErrorRequestHandler } from 'express';
import { api } from './api/index.js';
import { drain } from './bot/engine.js';
import { botHealth, startBot, stopBot } from './bot/index.js';
import { config } from './config.js';
import { dbConfigured, dbReady, migrate } from './db.js';
import { errText, log } from './log.js';

// Dashboard API plus the trading bot, which runs in this same process (SPEC.md).

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/api/health', async (_req, res) => {
  const database = await dbReady();
  // 200 also when degraded (the status page's web checks mean "the API answers"); 503 only when the database is down.
  res.status(dbConfigured() && !database ? 503 : 200).json({ uptime: Math.round(process.uptime()), database, ...(await botHealth(database)) });
});

app.use('/api', api); // parses JSON bodies itself (small limit, large only for logged-in research uploads)

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

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    stopBot();
    // PM2 kills at kill_timeout (30 s); drain gives a running tick up to 25 s.
    setTimeout(() => process.exit(0), 28_000).unref();
    await drain().catch((err) => console.error('drain failed', err));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    void log('error', 'unhandled_rejection', `Unhandled promise rejection: ${errText(reason)}`);
  });
}

main();
