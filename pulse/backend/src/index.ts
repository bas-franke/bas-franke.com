import { createServer } from 'node:http';
import express, { type ErrorRequestHandler, type Request } from 'express';
import { isAuthed, login, logout, requireAuth } from './auth.js';
import { config } from './config.js';
import { dbConfigured, dbReady, migrate } from './db.js';
import { attachRealtime, broadcast, clientCount } from './realtime.js';
import { removeNote, removeTask, saveNote, saveTask, snapshot, validId } from './store.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use('/api', express.json({ limit: '1mb' }));

app.get('/api/health', async (_req, res) => {
  const database = await dbReady();
  res.status(dbConfigured() && !database ? 503 : 200).json({ status: 'ok', database, tabs: clientCount() });
});

// Same-origin guard for writes: a browser always sends Origin on these and it must match our Host.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      // invalid Origin: refused below
    }
    if (host.toLowerCase() !== (req.headers.host ?? '').toLowerCase()) {
      res.status(403).json({ error: 'Cross-origin request refused.' });
      return;
    }
  }
  next();
});

app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', (req, res) => void res.json({ authed: isAuthed(req) }));

app.use('/api', requireAuth);

const from = (req: Request) => (typeof req.headers['x-client-id'] === 'string' ? req.headers['x-client-id'] : undefined);

app.get('/api/state', async (_req, res) => void res.json(await snapshot()));

app.put('/api/tasks/:id', async (req, res) => {
  if (!validId(req.params.id)) return void res.status(400).json({ error: 'Bad id.' });
  const task = await saveTask(req.params.id, req.body ?? {});
  broadcast({ type: 'task', task, from: from(req) });
  res.json(task);
});
app.delete('/api/tasks/:id', async (req, res) => {
  if (!validId(req.params.id)) return void res.status(400).json({ error: 'Bad id.' });
  await removeTask(req.params.id);
  broadcast({ type: 'task-removed', id: req.params.id, from: from(req) });
  res.json({ ok: true });
});
app.put('/api/notes/:id', async (req, res) => {
  if (!validId(req.params.id)) return void res.status(400).json({ error: 'Bad id.' });
  const note = await saveNote(req.params.id, req.body ?? {});
  broadcast({ type: 'note', note, from: from(req) });
  res.json(note);
});
app.delete('/api/notes/:id', async (req, res) => {
  if (!validId(req.params.id)) return void res.status(400).json({ error: 'Bad id.' });
  await removeNote(req.params.id);
  broadcast({ type: 'note-removed', id: req.params.id, from: from(req) });
  res.json({ ok: true });
});

app.use('/api', (_req, res) => void res.status(404).json({ error: 'Not found' }));

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
};
app.use(onError);

async function main() {
  if (dbConfigured()) await migrate();
  else console.log('DATABASE_URL is not set: pulse has nowhere to keep anything');
  const server = createServer(app);
  attachRealtime(server);
  server.listen(config.port, config.host, () => console.log(`pulse backend listening on http://${config.host}:${config.port}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
