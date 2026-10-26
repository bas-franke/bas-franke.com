import { Router, type ErrorRequestHandler } from 'express';
import { createAuth, csrfGuard } from '../auth.js';
import { botRoutes } from './bot.js';
import type { ApiDeps } from './deps.js';
import { historyRoutes } from './history.js';
import { researchRoutes } from './research.js';
import { ValidationError } from './util.js';

/**
 * The dashboard API (SPEC.md §7), mounted at /api. `GET /api/health` lives in index.ts; everything here except
 * login needs a session, and every state-changing request passes the CSRF guard first.
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

  api.post('/auth/login', auth.login);
  api.post('/auth/logout', auth.logout);

  api.use(auth.requireAuth);
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
    next(err);
  };
  api.use(onError);
  return api;
}
