import { timingSafeEqual } from 'node:crypto';
import express, { type RequestHandler } from 'express';
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

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const basicAuth: RequestHandler = (req, res, next) => {
  if (!config.statusPassword) return next();
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const sep = decoded.indexOf(':');
    if (safeEqual(decoded.slice(0, sep), config.statusUser) && safeEqual(decoded.slice(sep + 1), config.statusPassword)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="status", charset="UTF-8"').status(401).json({ error: 'Unauthorized' });
};

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

app.get('/api/status', basicAuth, async (req, res) => {
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
