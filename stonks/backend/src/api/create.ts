import express, { Router, type ErrorRequestHandler } from 'express';
import { createAuth, csrfGuard } from '../auth.js';
import { botRoutes } from './bot.js';
import type { ApiDeps } from './deps.js';
import { historyRoutes } from './history.js';
import { researchRoutes } from './research.js';
import { ConflictError, ValidationError } from './util.js';

/** Body limit for everything except research uploads, and for those (parsed only after the session check). */
const SMALL_BODY = '32kb';
const RESEARCH_BODY = '4mb';

/**
 * The dashboard API (SPEC.md §7), mounted at /api. `GET /api/health` lives in index.ts; everything here except
 * login needs a session, and every state-changing request passes the CSRF guard first. It parses JSON bodies
 * itself: anonymous requests only ever get the small limit, the large one is reserved for logged-in clients.
 */
export function createApi(rawDeps: ApiDeps) {
  // Logging must never fail a request (it may run after the response is sent).
  const deps: ApiDeps = {
    ...rawDeps,
    log: async (level, event, message, data) => {
      try {
        await rawDeps.log(level, event, message, data);
      } catch (err) {
        console.error('log failed', event, err);
      }
    },
  };
  const auth = createAuth({
    store: deps.sessions,
    password: deps.password,
    production: deps.production,
    log: deps.log,
    maxAttempts: deps.maxLoginAttempts,
    now: deps.now,
  });

  const api = Router();
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(csrfGuard);
  const smallJson = express.json({ limit: SMALL_BODY });
  const isResearchUpload = (req: express.Request) => req.method === 'POST' && req.path.toLowerCase() === '/research';
  api.use((req, res, next) => (isResearchUpload(req) ? next() : smallJson(req, res, next)));

  api.post('/auth/login', auth.login);
  api.post('/auth/logout', auth.logout);

  api.use(auth.requireAuth);
  api.use(express.json({ limit: RESEARCH_BODY }));
  api.get('/auth/me', (_req, res) => {
    res.json({ loggedIn: true });
  });
  api.use(botRoutes(deps));
  api.use(historyRoutes(deps));
  api.use(researchRoutes(deps));

  const onError: ErrorRequestHandler = (err, _req, res, next) => {
    if (err instanceof ValidationError || deps.isSettingsError(err)) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    if (err instanceof ConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    const type = err && typeof err === 'object' ? (err as { type?: unknown }).type : undefined;
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON.' });
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body is too large.' });
      return;
    }
    next(err);
  };
  api.use(onError);
  return api;
}
