import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Dashboard login (SPEC.md §7). One password from STONKS_ADMIN_PASSWORD, a random session token in an HttpOnly
 * cookie, and only an HMAC of the token in the `sessions` table so a database leak cannot be replayed as a login.
 * The HMAC key is derived from the password, so changing STONKS_ADMIN_PASSWORD (and restarting) signs every
 * existing session out: a leaked password can be revoked without touching the database.
 */

export const SESSION_COOKIE = 'stonks_session';
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const CLEANUP_EVERY_MS = 60 * 60 * 1000;
/** Failed logins from all addresses together per hour: caps guessing spread over many IPs (or an IPv6 range). */
const GLOBAL_FAILURES = 50;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
/** 32 random bytes as base64url. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', event: string, message: string, data?: unknown) => unknown;

export interface SessionStore {
  create(hash: Buffer, expiresAt: Date, ip: string | undefined): Promise<void>;
  /** True when a session with this hash exists and has not expired. */
  valid(hash: Buffer): Promise<boolean>;
  delete(hash: Buffer): Promise<void>;
  /** Removes expired sessions; returns how many. */
  deleteExpired(): Promise<number>;
}

export function pgSessionStore(query: Query): SessionStore {
  return {
    async create(hash, expiresAt, ip) {
      await query('INSERT INTO sessions (token_hash, expires_at, ip) VALUES ($1, $2, $3)', [hash, expiresAt, ip ?? null]);
    },
    async valid(hash) {
      const { rows } = await query('SELECT 1 FROM sessions WHERE token_hash = $1 AND expires_at > now()', [hash]);
      return rows.length > 0;
    },
    async delete(hash) {
      await query('DELETE FROM sessions WHERE token_hash = $1', [hash]);
    },
    async deleteExpired() {
      const res = await query('DELETE FROM sessions WHERE expires_at <= now()');
      return res.rowCount ?? 0;
    },
  };
}

/** In-memory store for tests. */
export function memorySessionStore(now: () => number = Date.now): SessionStore & { size(): number } {
  const sessions = new Map<string, number>();
  return {
    async create(hash, expiresAt) {
      sessions.set(hash.toString('hex'), expiresAt.getTime());
    },
    async valid(hash) {
      const exp = sessions.get(hash.toString('hex'));
      return exp !== undefined && exp > now();
    },
    async delete(hash) {
      sessions.delete(hash.toString('hex'));
    },
    async deleteExpired() {
      let n = 0;
      for (const [k, exp] of sessions) if (exp <= now()) (sessions.delete(k), n++);
      return n;
    },
    size: () => sessions.size,
  };
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest();

/** What the sessions table stores for a token: HMAC-SHA256 keyed by the current password. */
export const sessionHash = (token: string, password: string): Buffer =>
  createHmac('sha256', sha256(`stonks-session:${password}`)).update(token).digest();

/**
 * Rate-limit key for an address. IPv6 clients usually control a whole /64, so those count as one; IPv4-mapped
 * IPv6 addresses count as the IPv4 address.
 */
export function rateKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** Constant-time password check. An empty configured password never matches, so login is refused entirely. */
export function passwordMatches(given: unknown, expected: string): boolean {
  if (!expected || typeof given !== 'string') return false;
  return timingSafeEqual(sha256(given), sha256(expected));
}

/** Minimal Cookie header parser (no dependencies). Later duplicates do not override the first value. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Fixed-window attempt counter per key (IP), in memory. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt; false when the key is over its limit (the attempt must be refused). */
  hit(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return entry.count <= this.max;
  }

  /** Attempts recorded for the key in its current window (without recording one). */
  count(key: string): number {
    const entry = this.hits.get(key);
    return entry && entry.resetAt > this.now() ? entry.count : 0;
  }

  /** Seconds until the key may try again. */
  retryAfter(key: string): number {
    const entry = this.hits.get(key);
    return entry ? Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000)) : 0;
  }
}

export interface AuthOptions {
  store: SessionStore;
  /** Read on every login so tests (and a restart with a new env) see the current value. */
  password: () => string;
  production: boolean;
  log: LogFn;
  maxAttempts?: number;
  now?: () => number;
}

function sessionCookie(token: string, production: boolean, maxAgeSeconds: number) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Strict'];
  if (production) parts.push('Secure');
  return parts.join('; ');
}

const tokenHashFrom = (req: Request, password: string): Buffer | undefined => {
  if (!password) return undefined; // no password configured: no session is valid either
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return token && TOKEN_RE.test(token) ? sessionHash(token, password) : undefined;
};

export function createAuth(opts: AuthOptions) {
  const now = opts.now ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? 10;
  const limiter = new RateLimiter(maxAttempts, RATE_WINDOW_MS, now);
  const failures = new RateLimiter(GLOBAL_FAILURES, GLOBAL_WINDOW_MS, now);
  let lastCleanup = 0;

  const cleanup = async () => {
    if (now() - lastCleanup < CLEANUP_EVERY_MS) return;
    lastCleanup = now();
    try {
      await opts.store.deleteExpired();
    } catch (err) {
      console.error('session cleanup failed', err);
    }
  };

  const login: RequestHandler = async (req, res) => {
    const ip = req.ip ?? 'unknown';
    const key = rateKey(ip);
    if (!limiter.hit(key)) {
      res.setHeader('Retry-After', String(limiter.retryAfter(key)));
      res.status(429).json({ error: 'Too many login attempts. Try again in a few minutes.' });
      // Once per window, so a flood of refused attempts cannot flood the bot log.
      if (limiter.count(key) === maxAttempts + 1)
        await opts.log('warn', 'login_rate_limited', `login rate limit hit from ${key}`, { ip });
      return;
    }
    if (failures.count('all') >= GLOBAL_FAILURES) {
      res.setHeader('Retry-After', String(failures.retryAfter('all')));
      res.status(429).json({ error: 'Too many failed logins. Login is paused for a while.' });
      return;
    }
    const expected = opts.password();
    if (!expected) {
      res.status(503).json({ error: 'Login is disabled: STONKS_ADMIN_PASSWORD is not set on the server.' });
      await opts.log('error', 'login_disabled', 'login attempt while no admin password is configured', { ip });
      return;
    }
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (!passwordMatches(password, expected)) {
      failures.hit('all');
      res.status(401).json({ error: 'Wrong password.' });
      await opts.log('warn', 'login_failed', `failed login from ${ip}`, { ip });
      if (failures.count('all') === GLOBAL_FAILURES)
        await opts.log('error', 'login_paused', `${GLOBAL_FAILURES} failed logins within an hour: login is paused for everyone`, { ip });
      return;
    }
    await cleanup();
    const token = randomBytes(32).toString('base64url');
    await opts.store.create(sessionHash(token, expected), new Date(now() + SESSION_MS), ip);
    res.setHeader('Set-Cookie', sessionCookie(token, opts.production, SESSION_MS / 1000));
    res.json({ ok: true });
    await opts.log('info', 'login', `dashboard login from ${ip}`, { ip });
  };

  const logout: RequestHandler = async (req, res) => {
    const hash = tokenHashFrom(req, opts.password());
    if (hash) await opts.store.delete(hash);
    res.setHeader('Set-Cookie', sessionCookie('', opts.production, 0));
    res.json({ ok: true });
  };

  const requireAuth: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    const hash = tokenHashFrom(req, opts.password());
    if (!hash || !(await opts.store.valid(hash))) {
      res.status(401).json({ error: 'Not logged in.' });
      return;
    }
    void cleanup();
    next();
  };

  return { login, logout, requireAuth };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for state-changing requests: a JSON content type (which a plain HTML form cannot send cross-site
 * without a CORS preflight) and, when the browser sends an Origin, one that matches the Host. SameSite=Strict on
 * the cookie is the first line of defence; this is the second.
 */
export const csrfGuard: RequestHandler = (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const length = req.headers['content-length'];
  const bodyless = req.headers['transfer-encoding'] === undefined && (length === undefined || length === '0');
  // A body-less POST (logout, start, stop) may omit the type, but then it must carry a matching Origin, which
  // browsers always send on POST/PUT/DELETE.
  if (type !== 'application/json' && !(bodyless && !req.headers['content-type'] && origin !== undefined)) {
    res.status(415).json({ error: 'Send Content-Type: application/json.' });
    return;
  }
  if (origin !== undefined) {
    let host: string | undefined;
    try {
      host = new URL(origin).host;
    } catch {
      host = undefined;
    }
    if (!host || host.toLowerCase() !== (req.headers.host ?? '').toLowerCase()) {
      res.status(403).json({ error: 'Cross-origin request refused.' });
      return;
    }
  }
  next();
};
