import { Router } from 'express';
import type { ApiDeps } from './deps.js';
import { fail, ValidationError } from './util.js';

// Bot control: overview, settings, start/stop, strategy families and markets (SPEC.md §7).

/** Keys of settings.bot the dashboard may change. `enabled` only moves through start/stop. */
const EDITABLE = ['mode', 'strategy', 'maxExposureEur', 'dailyLossLimitEur', 'fees', 'paperStartEur'] as const;
const MARKETS_TTL_MS = 60 * 60 * 1000;

export function botRoutes(deps: ApiDeps) {
  const r = Router();
  const now = deps.now ?? Date.now;
  let markets: { at: number; list: unknown[] } | undefined;

  r.get('/overview', async (_req, res) => {
    res.json(await deps.getOverview());
  });

  r.put('/bot', async (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('Send the settings to change as an object.');
    const { confirmLive, ...rest } = body as Record<string, unknown>;
    if ('enabled' in rest) fail('Use Start / Stop to switch the bot on or off.');
    const unknown = Object.keys(rest).filter((k) => !(EDITABLE as readonly string[]).includes(k));
    if (unknown.length) fail(`Unknown setting: ${unknown.join(', ')}`);
    if (!Object.keys(rest).length) fail('Nothing to change.');
    if (confirmLive !== undefined && typeof confirmLive !== 'boolean') fail('confirmLive must be true or false.');
    if (rest.mode !== undefined && rest.mode !== 'paper' && rest.mode !== 'live') fail('mode must be "paper" or "live".');
    if (rest.mode === 'live' && confirmLive !== true && (await deps.getBotSettings()).mode !== 'live') {
      fail('Switching to live trading spends real money: confirm it first (confirmLive: true).');
    }
    if (rest.strategy !== undefined) {
      try {
        deps.validateSpec(rest.strategy);
      } catch (err) {
        throw new ValidationError(`Strategy is not valid: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // The settings module logs what changed.
    res.json(await deps.updateBotSettings(rest, { confirmLive: confirmLive === true }));
  });

  // The bot logs start/stop itself.
  r.post('/bot/start', async (_req, res) => {
    res.json(await deps.enableTrading());
  });

  r.post('/bot/stop', async (_req, res) => {
    res.json(await deps.disableTrading('stopped from dashboard'));
  });

  r.get('/strategies/families', (_req, res) => {
    res.json(deps.families());
  });

  r.get('/markets', async (_req, res) => {
    if (!markets || now() - markets.at > MARKETS_TTL_MS) markets = { at: now(), list: await deps.listMarkets() };
    res.json({ markets: markets.list });
  });

  return r;
}
