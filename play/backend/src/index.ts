import http from 'node:http';
import express, { type ErrorRequestHandler } from 'express';
import { accounts, sweepAccounts } from './accounts.js';
import { config } from './config.js';
import { dbConfigured, dbReady, migrate } from './db.js';
import { mailConfigured } from './mail.js';
import { attachWebSocket } from './net.js';
import { RoomError, RoomManager } from './rooms.js';
import { GAMES } from './shared/protocol.js';

const rooms = new RoomManager();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Optional accounts (guests never need one). Mounted before the small global body limit: saves carry browser storage.
app.use('/api/account', express.json({ limit: '200kb' }), accounts);
app.use(express.json({ limit: '8kb' }));

app.get('/api/health', async (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    rooms: rooms.rooms.size,
    players: rooms.playerCount(),
    accounts: dbConfigured(),
    database: await dbReady(),
    mail: mailConfigured(),
  });
});

app.get('/api/games', (_req, res) => {
  res.json({ games: Object.values(GAMES) });
});

app.get('/api/rooms', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ rooms: rooms.list() });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.get(String(req.params.code));
  if (!room || room.closed) {
    res.status(404).json({ error: 'That room does not exist (any more). Rooms close when the last player leaves.' });
    return;
  }
  res.set('Cache-Control', 'no-store').json({ room: room.summary() });
});

// Room creation is cheap but not free (a simulation loop each); limit how fast one IP can create them.
const createLog = new Map<string, number[]>();
app.post('/api/rooms', (req, res) => {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const recent = (createLog.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= config.createRateLimit) {
    res.status(429).json({ error: 'You are creating rooms too quickly. Try again in a minute.' });
    return;
  }
  recent.push(now);
  createLog.set(ip, recent);

  const room = rooms.create((req.body ?? {}) as Record<string, unknown>);
  console.log(`[room ${room.code}] created: ${room.settings.game}, ${room.settings.maxPlayers} slots, ${room.settings.bots} bots (${ip})`);
  res.status(201).json({ room: room.summary() });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof RoomError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Invalid JSON.' });
    return;
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'That request is too large.', tooLarge: true });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
};
app.use(onError);

const server = http.createServer(app);
attachWebSocket(server, rooms);

const sweeper = setInterval(() => rooms.sweep(), 2000);
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, times] of createLog) if (!times.some((t) => t > cutoff)) createLog.delete(ip);
}, 60_000).unref();

setInterval(sweepAccounts, 3_600_000).unref();

if (dbConfigured()) {
  // Keep serving while migrations run or fail: rooms and guests do not need the database.
  migrate().then(sweepAccounts, (err) => console.error('migrations failed', err));
} else console.log('DATABASE_URL is not set: accounts disabled, everybody plays as a guest');

server.listen(config.port, config.host, () => {
  console.log(`play backend listening on http://${config.host}:${config.port}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received, closing rooms`);
  clearInterval(sweeper);
  rooms.closeAll('The server is restarting for an update. Please create a new room in a moment.');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Last line of defence: a bug in one room must not take every room on the server down with it.
process.on('uncaughtException', (err) => console.error('uncaught exception', err));
