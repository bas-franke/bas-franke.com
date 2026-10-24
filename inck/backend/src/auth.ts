import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { config } from './config.js';

const COOKIE = 'inck_admin';
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;

const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; since: number }>();

export const authConfigured = () => Boolean(config.adminPassword);

// Derived from the password, so changing ADMIN_PASSWORD logs everyone out.
const secret = () => config.sessionSecret ?? createHash('sha256').update(`inck-session:${config.adminPassword}`).digest();
const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function sessionUser(req: Request): string | undefined {
  const token = readCookie(req, COOKIE);
  if (!token || !authConfigured()) return undefined;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return undefined;
  try {
    const { user, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { user: string; exp: number };
    return Date.now() < exp ? user : undefined;
  } catch {
    return undefined;
  }
}

function setSession(req: Request, res: Response, user: string, remember: boolean) {
  const maxAge = remember ? REMEMBER_MS : SESSION_MS;
  const payload = Buffer.from(JSON.stringify({ user, exp: Date.now() + maxAge })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'strict',
    path: '/api/admin',
    ...(remember ? { maxAge } : {}),
  });
}

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!authConfigured()) return res.status(503).json({ error: 'ADMIN_PASSWORD is not set on the server.' });
  if (sessionUser(req)) return next();
  res.status(401).json({ error: 'Not logged in' });
};

export const login: RequestHandler = (req, res) => {
  if (!authConfigured()) return res.status(503).json({ error: 'ADMIN_PASSWORD is not set on the server.' });

  const ip = req.ip ?? 'unknown';
  const entry = attempts.get(ip);
  if (entry && Date.now() - entry.since < ATTEMPT_WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const { username, password, remember } = (req.body ?? {}) as { username?: unknown; password?: unknown; remember?: unknown };
  if (
    typeof username === 'string' &&
    typeof password === 'string' &&
    safeEqual(username, config.adminUser) &&
    safeEqual(password, config.adminPassword!)
  ) {
    attempts.delete(ip);
    setSession(req, res, username, remember === true);
    return res.json({ user: username });
  }

  const fresh = !entry || Date.now() - entry.since >= ATTEMPT_WINDOW_MS;
  attempts.set(ip, fresh ? { count: 1, since: Date.now() } : { count: entry.count + 1, since: entry.since });
  res.status(401).json({ error: 'Wrong username or password.' });
};

export const logout: RequestHandler = (_req, res) => {
  res.clearCookie(COOKIE, { path: '/api/admin' });
  res.json({ ok: true });
};

export const me: RequestHandler = (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user });
};
