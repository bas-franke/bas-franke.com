// Optional player accounts. Nobody needs one: guests play with a nickname in a cookie. An account (email + password,
// activated by mail) carries the nickname and a copy of the browser's storage to other devices. Passwords are
// scrypt-hashed; the session is a random token in an HttpOnly cookie scoped to /api. Mail links are one-time tokens
// stored as SHA-256 hashes, like the sessions.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type BinaryLike, type ScryptOptions } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from './config.js';
import { dbConfigured, one, query } from './db.js';
import { mailConfigured, sendMail } from './mail.js';
import { LIMITS, sanitizeName } from './shared/protocol.js';

const COOKIE = 'play_sid';
const SESSION_DAYS = 365;
const ACTIVATE_HOURS = 48;
const RESET_HOURS = 1;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
/** Caps on the synced copy of browser storage. */
const SAVE_MAX_BYTES = 128 * 1024;
const SAVE_KEY_MAX = 100;

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

export function readCookie(req: { headers: { cookie?: string } }, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
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
  email: string;
  nickname: string;
}

const USER_COLUMNS = 'users.id, users.email, users.nickname';

async function currentUser(req: Request): Promise<User | undefined> {
  const token = readCookie(req, COOKIE);
  if (!token || !dbConfigured()) return undefined;
  return one<User>(
    `UPDATE users SET last_seen_at = now()
       FROM sessions s
      WHERE s.token_hash = $1 AND s.expires_at > now() AND users.id = s.user_id
      RETURNING ${USER_COLUMNS}`,
    [tokenHash(token)],
  );
}

/** The password and nickname a sign-up chose; they only take effect when its own activation link is opened. */
interface Pending {
  passwordHash: string;
  nickname: string;
}

/**
 * Creates a one-time mail link for `purpose`. A reset link replaces older ones. Activation links each carry the
 * credentials of the sign-up that asked for them, so signing up again with somebody else's unactivated address
 * cannot change what that person's own link activates.
 */
async function mailToken(userId: string, purpose: 'activate' | 'reset', pending?: Pending) {
  const token = randomBytes(32).toString('base64url');
  const hours = purpose === 'activate' ? ACTIVATE_HOURS : RESET_HOURS;
  if (purpose === 'reset') await query("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'reset'", [userId]);
  await query('INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, password_hash, nickname) VALUES ($1, $2, $3, $4, $5, $6)', [
    tokenHash(token),
    userId,
    purpose,
    new Date(Date.now() + hours * 3_600_000),
    pending?.passwordHash ?? null,
    pending?.nickname ?? null,
  ]);
  return `${config.publicUrl}/account/${purpose}/${token}`;
}

/** Spends a mail link; returns its row, or undefined when it is unknown, used or expired. */
async function useToken(token: unknown, purpose: 'activate' | 'reset') {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return undefined;
  return one<{ user_id: string; password_hash: string | null; nickname: string | null }>(
    'DELETE FROM email_tokens WHERE token_hash = $1 AND purpose = $2 AND expires_at > now() RETURNING user_id, password_hash, nickname',
    [tokenHash(token), purpose],
  );
}

async function sendActivation(user: User, pending?: Pending) {
  const link = await mailToken(user.id, 'activate', pending);
  const sent = await sendMail({
    to: user.email,
    subject: 'Activate your play account',
    text:
      `Hi ${user.nickname},\n\nThanks for making an account on play.bas-franke.com. Open the link below to activate it; ` +
      `it works for ${ACTIVATE_HOURS} hours.\n\n${link}\n\nDid not sign up? Then you can ignore this mail.`,
    link: { url: link, label: 'Activate my account' },
  });
  return { sent, link };
}

async function sendReset(user: User) {
  const link = await mailToken(user.id, 'reset');
  const sent = await sendMail({
    to: user.email,
    subject: 'Reset your play password',
    text:
      `Hi ${user.nickname},\n\nSomeone (hopefully you) asked to reset the password of your play.bas-franke.com account. ` +
      `Open the link below to pick a new one; it works for one hour.\n\n${link}\n\nDid not ask for this? Then you can ignore this mail; your password stays the same.`,
    link: { url: link, label: 'Pick a new password' },
  });
  return { sent, link };
}

// ---- saves: a copy of the browser's localStorage for this site ------------------------------------------------

type Save = Record<string, string>;

function sanitizeSave(raw: unknown): Save {
  const out: Save = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && key && key.length <= SAVE_KEY_MAX) out[key] = value;
  }
  return out;
}

const saveBytes = (save: Save) => Object.entries(save).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);

/** Thrown when a merged save would pass the cap; answered with 413 so the device stops retrying the same upload. */
class SaveTooLarge extends Error {}

async function loadSave(userId: string): Promise<Save> {
  const row = await one<{ data: unknown }>('SELECT data FROM saves WHERE user_id = $1', [userId]);
  return row ? sanitizeSave(row.data) : {};
}

/**
 * Merges a device's storage into the account's. `deviceWins` (an upload from a device already logged in) lets the
 * device overwrite stored keys; at login the account wins, so its progress comes to the new device.
 */
async function mergeSave(userId: string, incoming: unknown, deviceWins: boolean): Promise<Save> {
  const current = await loadSave(userId);
  const device = sanitizeSave(incoming);
  let next: Save;
  if (deviceWins) {
    next = { ...current, ...device };
    if (saveBytes(next) > SAVE_MAX_BYTES) throw new SaveTooLarge();
  } else {
    // At login the account's keys come first; device-only keys are added while they fit.
    next = { ...current };
    let bytes = saveBytes(next);
    for (const [k, v] of Object.entries(device)) {
      if (k in next) continue;
      bytes += Buffer.byteLength(k) + Buffer.byteLength(v);
      if (bytes > SAVE_MAX_BYTES) break;
      next[k] = v;
    }
  }
  await query(
    `INSERT INTO saves (user_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [userId, JSON.stringify(next)],
  );
  return next;
}

const view = (u: User) => ({ id: String(u.id), email: u.email, nickname: u.nickname });

// ---- rate limits: in memory per IP, good enough for one small server ------------------------------------------

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

/** A wrong password and an unknown email should take equally long, so timing does not reveal who has an account. */
const DUMMY_HASH = hashPassword(randomBytes(16).toString('hex'));

/** Mail sends per address per hour on top of the per-IP limit, so nobody can flood one inbox from many IPs. */
const mailLimited = (ip: string, email: string) => limited(`mail:${ip}`, 5, 600_000) || (!!email && limited(`mailto:${email}`, 4, 3_600_000));

const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
const cleanEmail = (raw: unknown) => (typeof raw === 'string' ? raw.trim().toLowerCase() : '');
const validPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= 8 && p.length <= 200;
const tooMany = (res: Response) => res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
/** The mail link itself, returned only while there is no SendGrid key (local development). */
const devLink = (link: string) => (mailConfigured() ? {} : { devLink: link });

export const accounts = Router();

// Everything except the status call needs the database.
accounts.use((req, res, next) => {
  if (!(req.path === '/' && req.method === 'GET') && !dbConfigured()) {
    res.status(503).json({ error: 'Accounts are not available right now. You can keep playing as a guest.' });
    return;
  }
  next();
});

/** Who is logged in, plus their save. `enabled` is false when the server has no database (guests only). */
accounts.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!dbConfigured()) {
    res.json({ enabled: false, mail: mailConfigured(), user: null, save: null });
    return;
  }
  const user = await currentUser(req);
  res.json({ enabled: true, mail: mailConfigured(), user: user ? view(user) : null, save: user ? await loadSave(user.id) : null });
});

accounts.post('/register', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const { password, nickname } = body(req);
  const email = cleanEmail(body(req).email);
  if (!EMAIL.test(email)) {
    res.status(400).json({ error: 'That does not look like an email address.', field: 'email' });
    return;
  }
  if (!validPassword(password)) {
    res.status(400).json({ error: 'Pick a password of at least 8 characters.', field: 'password' });
    return;
  }
  const nick = sanitizeName(nickname, '');
  if (!nick) {
    res.status(400).json({ error: `Pick a nickname (up to ${LIMITS.playerNameMax} characters).`, field: 'nickname' });
    return;
  }
  if (limited(`signup:${ip}`, config.signupsPerHour, 3_600_000) || limited(`auth:${ip}`, config.authAttempts, 600_000)) {
    tooMany(res);
    return;
  }
  const existing = await one<User & { verified_at: Date | null }>(`SELECT ${USER_COLUMNS}, verified_at FROM users WHERE lower(email) = $1`, [email]);
  if (existing?.verified_at) {
    res.status(409).json({ error: 'There is already an account with that email. Log in, or reset the password.', field: 'email' });
    return;
  }
  if (limited(`mailto:${email}`, 4, 3_600_000)) {
    tooMany(res);
    return;
  }
  // Signing up again before activating leaves the account as it is: the new password and nickname travel with the
  // new activation link only. No save is stored yet; the device uploads it once the account is active.
  const pending = { passwordHash: await hashPassword(password), nickname: nick };
  const user =
    existing ??
    (await one<User>(`INSERT INTO users (email, nickname, password_hash) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`, [email, nick, pending.passwordHash]));
  const { link } = await sendActivation({ ...user, nickname: nick }, pending);
  console.log(`[account] registered ${user.id} (${ip})`);
  res.status(201).json({ pending: true, email, ...devLink(link) });
});

accounts.post('/activate', async (req, res) => {
  const row = await useToken(body(req).token, 'activate');
  // Only the first activation sets the credentials; a stray older link for an active account just logs in.
  const fresh = row && (await one<{ id: string }>('SELECT id FROM users WHERE id = $1 AND verified_at IS NULL', [row.user_id]));
  const user = !row
    ? undefined
    : fresh && row.password_hash
      ? await one<User>(`UPDATE users SET verified_at = now(), password_hash = $2, nickname = $3 WHERE id = $1 RETURNING ${USER_COLUMNS}`, [row.user_id, row.password_hash, row.nickname])
      : await one<User>(`UPDATE users SET verified_at = coalesce(verified_at, now()) WHERE id = $1 RETURNING ${USER_COLUMNS}`, [row.user_id]);
  if (!user) {
    res.status(400).json({ error: 'This activation link is used up or has expired. Log in to get a new one.' });
    return;
  }
  if (fresh) {
    // A brand-new account starts empty (whatever an earlier unactivated sign-up stored is dropped), and the other
    // pending activation links stop working.
    await query('DELETE FROM saves WHERE user_id = $1', [user.id]);
    await query("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'activate'", [user.id]);
  }
  await startSession(req, res, user.id);
  console.log(`[account] activated ${user.id}`);
  res.json({ user: view(user), save: await loadSave(user.id) });
});

accounts.post('/resend', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const email = cleanEmail(body(req).email);
  if (mailLimited(ip, email)) {
    tooMany(res);
    return;
  }
  const user = email ? await one<User>(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1 AND verified_at IS NULL`, [email]) : undefined;
  // Same answer whether or not the address has an account, so this cannot be used to look up who plays here.
  const link = user ? (await sendActivation(user)).link : undefined;
  res.json({ ok: true, ...(link ? devLink(link) : {}) });
});

accounts.post('/login', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (limited(`auth:${ip}`, config.authAttempts, 600_000)) {
    tooMany(res);
    return;
  }
  const { password, save } = body(req);
  const email = cleanEmail(body(req).email);
  const row =
    email && typeof password === 'string'
      ? await one<User & { password_hash: string; verified_at: Date | null }>(`SELECT ${USER_COLUMNS}, password_hash, verified_at FROM users WHERE lower(email) = $1`, [email])
      : undefined;
  const ok = await verifyPassword(typeof password === 'string' ? password : '', row?.password_hash ?? (await DUMMY_HASH));
  if (!row || (!ok && row.verified_at)) {
    res.status(401).json({ error: 'Wrong email or password.' });
    return;
  }
  // An unactivated account's stored password may not be the one this person picked (see register), so it is not checked.
  if (!row.verified_at) {
    res.status(403).json({ error: 'Activate your account first: open the link in the mail we sent you.', unverified: true });
    return;
  }
  await startSession(req, res, row.id);
  res.json({ user: view(row), save: await mergeSave(row.id, save, false) });
});

accounts.post('/logout', async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
  res.clearCookie(COOKIE, { path: '/api' });
  res.json({ ok: true });
});

accounts.post('/forgot', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  const email = cleanEmail(body(req).email);
  if (mailLimited(ip, email)) {
    tooMany(res);
    return;
  }
  const user = email ? await one<User>(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1`, [email]) : undefined;
  const link = user ? (await sendReset(user)).link : undefined;
  res.json({ ok: true, ...(link ? devLink(link) : {}) });
});

accounts.post('/reset', async (req, res) => {
  const { token, password } = body(req);
  if (!validPassword(password)) {
    res.status(400).json({ error: 'Pick a password of at least 8 characters.', field: 'password' });
    return;
  }
  const userId = (await useToken(token, 'reset'))?.user_id;
  // Getting the reset mail proves the address too, so this also activates an account that never was.
  const user =
    userId &&
    (await one<User>(`UPDATE users SET password_hash = $2, verified_at = coalesce(verified_at, now()) WHERE id = $1 RETURNING ${USER_COLUMNS}`, [
      userId,
      await hashPassword(password),
    ]));
  if (!user) {
    res.status(400).json({ error: 'This reset link is used up or has expired. Ask for a new one.' });
    return;
  }
  // A new password logs out every other device.
  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  await startSession(req, res, user.id);
  res.json({ user: view(user), save: await loadSave(user.id) });
});

accounts.patch('/', async (req, res) => {
  const user = await currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not logged in.' });
    return;
  }
  const nick = sanitizeName(body(req).nickname, '');
  if (!nick) {
    res.status(400).json({ error: `Pick a nickname (up to ${LIMITS.playerNameMax} characters).`, field: 'nickname' });
    return;
  }
  const updated = await one<User>(`UPDATE users SET nickname = $2 WHERE id = $1 RETURNING ${USER_COLUMNS}`, [user.id, nick]);
  res.json({ user: view(updated) });
});

/** Upload this device's storage; the merged whole comes back so the device can adopt progress from elsewhere. */
accounts.put('/save', async (req, res) => {
  const user = await currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not logged in.' });
    return;
  }
  try {
    res.json({ save: await mergeSave(user.id, body(req).save, true) });
  } catch (err) {
    if (!(err instanceof SaveTooLarge)) throw err;
    res.status(413).json({ error: `Your saved data is over ${SAVE_MAX_BYTES / 1024} KB; the newest changes were not synced.`, tooLarge: true });
  }
});

accounts.post('/password', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (limited(`auth:${ip}`, config.authAttempts, 600_000)) {
    tooMany(res);
    return;
  }
  const user = await currentUser(req);
  const { current, password } = body(req);
  const row = user && (await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]));
  if (!user || !row || typeof current !== 'string' || !(await verifyPassword(current, row.password_hash))) {
    res.status(401).json({ error: 'Your current password is not right.', field: 'current' });
    return;
  }
  if (!validPassword(password)) {
    res.status(400).json({ error: 'Pick a password of at least 8 characters.', field: 'password' });
    return;
  }
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(password)]);
  // Other devices are logged out; this one keeps its session.
  await query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [user.id, tokenHash(readCookie(req, COOKIE) ?? '')]);
  res.json({ ok: true });
});

/** Delete the account and everything stored with it (needs the password). */
accounts.post('/delete', async (req, res) => {
  const ip = req.ip ?? 'unknown';
  if (limited(`auth:${ip}`, config.authAttempts, 600_000)) {
    tooMany(res);
    return;
  }
  const user = await currentUser(req);
  const { password } = body(req);
  const row = user && (await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [user.id]));
  if (!user || !row || typeof password !== 'string' || !(await verifyPassword(password, row.password_hash))) {
    res.status(401).json({ error: 'Wrong password.', field: 'password' });
    return;
  }
  await query('DELETE FROM users WHERE id = $1', [user.id]);
  res.clearCookie(COOKIE, { path: '/api' });
  console.log(`[account] deleted ${user.id}`);
  res.json({ ok: true });
});

/** Clears expired sessions and mail links now and then. */
export function sweepAccounts() {
  if (!dbConfigured()) return;
  query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
  query('DELETE FROM email_tokens WHERE expires_at < now()').catch(() => {});
  // Sign-ups that were never activated are dropped after a week.
  query("DELETE FROM users WHERE verified_at IS NULL AND created_at < now() - interval '7 days'").catch(() => {});
}
