import express from 'express';
import { login, logout, me, requireLogin } from './auth.js';
import { config } from './config.js';
import { runAll } from './runner.js';
import type { Report } from './types.js';

const MIN_REFRESH_MS = 15_000;

let latest: Report | undefined;
let inFlight: Promise<Report> | undefined;

function refresh() {
  inFlight ??= runAll()
    .then((report) => (latest = report))
    .finally(() => (inFlight = undefined));
  return inFlight;
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', me);

app.get('/api/status', requireLogin, async (req, res) => {
  const stale = !latest || Date.now() - Date.parse(latest.generatedAt) > MIN_REFRESH_MS;
  const report = req.query.refresh && stale ? await refresh() : (latest ?? (await refresh()));
  res.set('Cache-Control', 'no-store').json(report);
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(config.port, config.host, () => {
  console.log(`status backend listening on http://${config.host}:${config.port}`);
  refresh().catch((err) => console.error('initial status run failed', err));
  setInterval(() => refresh().catch((err) => console.error('status run failed', err)), config.refreshIntervalMs);
});
