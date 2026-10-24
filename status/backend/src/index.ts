import express, { type ErrorRequestHandler } from 'express';
import { analyticsReport, collect, cors, RANGES } from './analytics.js';
import { login, logout, me, requireLogin } from './auth.js';
import { config } from './config.js';
import { dbEnabled, migrate } from './db.js';
import { runAll } from './runner.js';
import type { Report } from './types.js';
import { errorMessage } from './util.js';

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

// Visitor analytics. Every site's frontend posts its page views to /api/page (public, cross-origin);
// the dashboard reads the aggregated numbers from /api/analytics. See README "Visitor analytics".
app.options('/api/page', cors);
app.post('/api/page', cors, express.text({ type: '*/*', limit: '2kb' }), collect);
app.get('/api/analytics', requireLogin, async (req, res) => {
  const days = Number(req.query.days);
  res.set('Cache-Control', 'no-store').json(await analyticsReport(RANGES.includes(days) ? days : 30));
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: errorMessage(err) });
};
app.use('/api', onError);

app.listen(config.port, config.host, () => {
  console.log(`status backend listening on http://${config.host}:${config.port}`);
  if (dbEnabled()) migrate().catch((err) => console.error('database migration failed; analytics will not work', err));
  else console.log('DATABASE_URL is not set: page views are dropped and the analytics are disabled');
  refresh().catch((err) => console.error('initial status run failed', err));
  setInterval(() => refresh().catch((err) => console.error('status run failed', err)), config.refreshIntervalMs);
});
