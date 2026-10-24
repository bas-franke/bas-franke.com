import { mkdir } from 'node:fs/promises';
import express, { type ErrorRequestHandler } from 'express';
import { aiConfigured } from './ai.js';
import { config, imagesDir } from './config.js';
import { dbReady, migrate } from './db.js';
import { adminRouter } from './routes/admin.js';
import { publicRouter } from './routes/public.js';
import { startScheduler } from './scheduler.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

let dbUp = false;

app.get('/api/health', (_req, res) => {
  // Always 200 so deploys succeed; the status page shows the details when something is off.
  const problems = [];
  if (!config.databaseUrl) problems.push('DATABASE_URL not set');
  else if (!dbUp) problems.push('database unreachable');
  if (!aiConfigured()) problems.push('OPENAI_API_KEY not set');
  if (!config.adminPassword) problems.push('ADMIN_PASSWORD not set');
  res.json({ status: problems.length ? 'degraded' : 'ok', problems, uptime: Math.round(process.uptime()) });
});

// Generated illustrations. Filenames are random, so long caching is safe.
app.use('/api/media', express.static(imagesDir(), { maxAge: '365d', immutable: true, index: false, fallthrough: true }));

// Everything below needs the database.
app.use('/api', (_req, res, next) => (dbUp ? next() : res.status(503).json({ error: 'Database is not available yet.' })));
app.use('/api', publicRouter);
app.use('/api/admin', adminRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
};
app.use(onError);

async function connectDb() {
  if (!config.databaseUrl) {
    console.error('DATABASE_URL is not set; the site will answer 503 until it is configured.');
    return;
  }
  for (;;) {
    try {
      await migrate();
      dbUp = true;
      console.log('database ready');
      return;
    } catch (err) {
      console.error('database not ready, retrying in 30s:', (err as Error).message);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}

app.listen(config.port, config.host, async () => {
  console.log(`inck backend listening on http://${config.host}:${config.port}`);
  await mkdir(imagesDir(), { recursive: true }).catch((err) => console.error('cannot create data dir', err));
  await connectDb();
  setInterval(async () => (dbUp = await dbReady()), 60_000);
  startScheduler();
});
