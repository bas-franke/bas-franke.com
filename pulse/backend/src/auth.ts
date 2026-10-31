import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

/**
 * Single-user login. One passphrase from PULSE_PASSPHRASE; a successful login sets an HttpOnly cookie holding
 * `<expiry>.<hmac>`, signed with a key derived from the passphrase, so nothing is stored server side and changing the
 * passphrase (plus a restart) signs every device out. With no passphrase set, local dev is open and production
 * refuses to log anyone in.
 */
const COOKIE = 'pulse_session';
const DAYS = 90;
const key = () => createHmac('sha256', 'pulse-session-key').update(config.passphrase).digest();
const sign = (exp: string) => createHmac('sha256', key()).update(exp).digest('base64url');

const open = () => !config.passphrase && !config.production;

function parseCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
}

export function isAuthed(req: IncomingMessage): boolean {
  if (open()) return true;
  if (!config.passphrase) return false;
  const [exp, sig] = (parseCookie(req.headers.cookie) ?? '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

const attempts = new Map<string, { n: number; reset: number }>();

export function login(req: Request, res: Response) {
  if (!config.passphrase && config.production) {
    res.status(503).json({ error: 'Login is disabled: PULSE_PASSPHRASE is not set on the server.' });
    return;
  }
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const prev = attempts.get(ip);
  const entry = prev && prev.reset > now ? prev : { n: 0, reset: now + 10 * 60_000 };
  attempts.set(ip, entry);
  if (++entry.n > config.loginAttempts) {
    res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
    return;
  }
  const given = String((req.body as { passphrase?: unknown } | undefined)?.passphrase ?? '');
  const a = createHmac('sha256', 'cmp').update(given).digest();
  const b = createHmac('sha256', 'cmp').update(config.passphrase).digest();
  if (open() || timingSafeEqual(a, b)) {
    const exp = String(now + DAYS * 86_400_000);
    const cookie = [`${COOKIE}=${exp}.${sign(exp)}`, 'Path=/', `Max-Age=${DAYS * 86_400}`, 'HttpOnly', 'SameSite=Strict'];
    if (config.production) cookie.push('Secure');
    res.setHeader('Set-Cookie', cookie.join('; '));
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ error: 'That is not the passphrase.' });
}

export function logout(_req: Request, res: Response) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  res.json({ ok: true });
}

export const requireAuth = (req: Request, res: Response, next: NextFunction) =>
  isAuthed(req) ? next() : void res.status(401).json({ error: 'Not logged in.' });
