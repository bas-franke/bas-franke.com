import express, { type ErrorRequestHandler } from 'express';

// The game runs entirely in the browser (vocabulary included); the backend only exists for the health check the
// deploy workflow and the status page rely on, and as the place for future online features.
const port = Number(process.env.PORT ?? 3005);
const host = process.env.HOST ?? '127.0.0.1';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
};
app.use(onError);

const server = app.listen(port, host, () => {
  console.log(`wordward backend listening on http://${host}:${port}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
