// Player accounts: username + password (no email, so children can sign up), scrypt password hashes, and a random
// session token in an HttpOnly cookie scoped to /api (it never travels with page or asset requests).

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type BinaryLike, type ScryptOptions } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from './config.js';
import { dbConfigured, one, query } from './db.js';
import { emptySave, merge, sanitize, type SaveData } from './saves.js';

const COOKIE = 'wws';
const SESSION_DAYS = 365;
const USERNAME = /^[A-Za-z0-9_.-]{3,20}$/;

const scrypt = (password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const SCRYPT = { N: 16384, r: 8, p: 1 };

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string) {
  const [scheme, n, salt, key] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { ...SCRYPT, N: Number(n) });
  return timingSafeEqual(actual, expected);
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest();

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function startSession(req: Request, res: Response, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash(token), userId, expires]);
  res.cookie(COOKIE, token, { httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/api', expires });
}

interface User {
  id: string;
  username: string;
  display_name: string;
}

async function currentUser(req: Request): Promise<User | undefined> {
  const token = readCookie(req, COOKIE);
  if (!token || !dbConfigured()) return undefined;
  const user = await one<User>(
    `UPDATE users SET last_seen_at = now()
       FROM sessions s
      WHERE s.token_hash = $1 AND s.expires_at > now() AND users.id = s.user_id
      RETURNING users.id, users.username, users.display_name`,
    [tokenHash(token)],
  );
  return user;
}

async function loadSave(userId: string): Promise<SaveData> {
  const row = await one<{ data: unknown }>('SELECT data FROM saves WHERE user_id = $1', [userId]);
  return row ? sanitize(row.data) : emptySave();
}

/** Merges `incoming` into the stored save and returns the result. */
async function mergeSave(userId: string, incoming: unknown): Promise<SaveData> {
  const current = await loadSave(userId);
  let next = current;
  if (incoming !== undefined && incoming !== null) next = merge(current, sanitize(incoming));
  await query(
    `INSERT INTO saves (user_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [userId, JSON.stringify(next)],
  );
  return next;
}

const view = (u: User) => ({ username: u.username, displayName: u.display_name });

// In-memory rate limits per IP; good enough for one small server, reset on deploy.
const attempts = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) return true;
  recent.push(now);
  attempts.set(key, recent);
  return false;
}
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [k, times] of attempts) if (!times.some((t) => t > cutoff)) attempts.delete(k);
}, 600_000).unref();

const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;

export const accounts = Router();

// Everything except the status call needs the database.
accounts.use((req, res, next) => {
  if (req.path !== '/' && !dbConfigured()) {
    res.status(503).json({ error: 'Accounts are not available yet. Your progress is saved on this device.' });
    return;
  }
  next();
});

/** Who is logged in, plus their save. `enabled` is false when the server has no database (guest mode only). */
accounts.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!dbConfigured()) {
    res.json({ enabled: false, user: null });
    return;
  }
  const user = await currentUser(req);
  res.json({ enabled: true, user: user ? view(user) : null, save: user ? await loadSave(user.id) : null });
});

accounts.post('/register', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const { username, password, save } = body(req);
  if (typeof username !== 'string' || !USERNAME.test(username)) {
    res.status(400).json({ error: 'Numele: 3–20 litere, cifre sau _ . - · Username: 3–20 letters, digits or _ . -', field: 'username' });
    return;
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    res.status(400).json({ error: 'Parola: minim 6 caractere · Password: at least 6 characters', field: 'password' });
    return;
  }
  if (limited(`signup:${ip}`, config.signupsPerHour, 3_600_000) || limited(`auth:${ip}`, config.authAttempts, 600_000)) {
    res.status(429).json({ error: 'Prea multe încercări. Mai încearcă peste puțin timp · Too many attempts, try again later.' });
    return;
  }
  const taken = await one('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
  if (taken) {
    res.status(409).json({ error: 'Numele este luat · That username is taken', field: 'username' });
    return;
  }
  const user = await one<User>(
    'INSERT INTO users (username, display_name, password_hash) VALUES (lower($1), $1, $2) RETURNING id, username, display_name',
    [username, await hashPassword(password)],
  );
  await startSession(req, res, user.id);
  const merged = await mergeSave(user.id, save);
  console.log(`[account] registered ${user.username} (${ip})`);
  res.status(201).json({ user: view(user), save: merged });
});

accounts.post('/login', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (limited(`auth:${ip}`, config.authAttempts, 600_000)) {
    res.status(429).json({ error: 'Prea multe încercări. Mai încearcă peste 10 minute · Too many attempts, try again in 10 minutes.' });
    return;
  }
  const { username, password, save } = body(req);
  const row =
    typeof username === 'string' && typeof password === 'string'
      ? await one<User & { password_hash: string }>('SELECT id, username, display_name, password_hash FROM users WHERE lower(username) = lower($1)', [username])
      : undefined;
  if (!row || !(await verifyPassword(password as string, row.password_hash))) {
    res.status(401).json({ error: 'Nume sau parolă greșită · Wrong username or password' });
    return;
  }
  await startSession(req, res, row.id);
  const merged = await mergeSave(row.id, save);
  res.json({ user: view(row), save: merged });
});

accounts.post('/logout', async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
  res.clearCookie(COOKIE, { path: '/api' });
  res.json({ ok: true });
});

/** Upload this device's save; the merged result comes back so the device can adopt progress from elsewhere. */
accounts.put('/save', async (req, res) => {
  const user = await currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  try {
    res.json({ save: await mergeSave(user.id, body(req).save) });
  } catch {
    res.status(400).json({ error: 'Invalid save' });
  }
});

/** Delete the account and everything stored with it (needs the password). */
accounts.post('/delete', async (req, res) => {
  const user = await currentUser(req);
  const { password } = body(req);
  const row = user && (await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]));
  if (!user || !row || typeof password !== 'string' || !(await verifyPassword(password, row.password_hash))) {
    res.status(401).json({ error: 'Parolă greșită · Wrong password' });
    return;
  }
  await query('DELETE FROM users WHERE id = $1', [user.id]);
  res.clearCookie(COOKIE, { path: '/api' });
  console.log(`[account] deleted ${user.username}`);
  res.json({ ok: true });
});
