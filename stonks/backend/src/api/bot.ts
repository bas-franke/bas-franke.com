import { Router } from 'express';
import type { ApiDeps } from './deps.js';
import { BUCKETS, type Bucket } from './research.js';
import { ConflictError, fail, num, ValidationError } from './util.js';

// Bot control: overview, settings, start/stop, strategy families and markets (SPEC.md §7).

/** Keys of settings.bot the dashboard may change. `enabled` only moves through start/stop. */
const EDITABLE = ['mode', 'strategy', 'maxExposureEur', 'dailyLossLimit', 'fees', 'paperStartEur', 'chase'] as const;
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
        await deps.validateSpec(rest.strategy);
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

  // One-click activation of a research strategy (SPEC §8). The spec always comes from the stored snapshot.
  r.post('/bot/activate', async (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('Send { researchId, bucket, rank, start }.');
    const { researchId, bucket, rank, start, confirmLive, hallOfFameId } = body as Record<string, unknown>;
    if (start !== undefined && typeof start !== 'boolean') fail('start must be true or false.');
    if (confirmLive !== undefined && typeof confirmLive !== 'boolean') fail('confirmLive must be true or false.');

    let entry: { spec?: Record<string, unknown>; botReady?: boolean } | undefined;
    // What gets stored as activeResearch: a hall of fame pick is { researchId: hall id, bucket: 'hall', rank: 1 }.
    let source: { researchId: number; bucket: string; rank: number; what: string };
    if (hallOfFameId !== undefined) {
      // A hall of fame strategy: its stored copy, whichever research snapshot it came from (SPEC §8).
      if (typeof hallOfFameId !== 'number' || !Number.isInteger(hallOfFameId) || hallOfFameId < 1) fail('hallOfFameId must be a hall of fame id.');
      const { rows } = await deps.query('SELECT id, entry FROM hall_of_fame WHERE id = $1', [hallOfFameId]);
      if (!rows.length) fail('That strategy is no longer in the hall of fame.');
      entry = rows[0].entry as typeof entry;
      source = { researchId: hallOfFameId as number, bucket: 'hall', rank: 1, what: `hall of fame #${hallOfFameId}` };
    } else {
      if (typeof researchId !== 'number' || !Number.isInteger(researchId) || researchId < 1) fail('researchId must be a research snapshot id.');
      if (typeof bucket !== 'string' || !(BUCKETS as readonly string[]).includes(bucket)) fail(`bucket must be one of ${BUCKETS.join(', ')}.`);
      if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1 || rank > 5) fail('rank must be 1 to 5.');
      const { rows } = await deps.query('SELECT id, created_at, payload FROM research_snapshots ORDER BY id DESC LIMIT 1');
      if (!rows.length) fail('There is no research to activate yet.');
      if (num(rows[0].id) !== researchId)
        throw new ConflictError('The research was updated since this page loaded. Reload it and pick the strategy again.');
      const payload = rows[0].payload as { top?: unknown[]; buckets?: Partial<Record<Bucket, { top?: unknown[] }>> };
      // v1 snapshots only have `top`, which is the daily bucket.
      const list = payload.buckets ? payload.buckets[bucket as Bucket]?.top : bucket === 'daily' ? payload.top : undefined;
      entry = (list ?? []).find((e) => (e as { rank?: unknown }).rank === rank) as typeof entry;
      if (!entry || !entry.spec) fail(`There is no number ${rank} in the ${bucket} list of this research.`);
      source = { researchId: researchId as number, bucket: bucket as string, rank: rank as number, what: `${bucket} #${rank}, snapshot ${researchId}` };
    }
    if (!entry || !entry.spec) fail('That strategy has no spec.');
    const spec = entry!.spec!;
    const ready = deps.isRunnable ? deps.isRunnable(String(spec.family), spec.familyVersion) : entry!.botReady === true;
    if (!ready) fail('The server does not have this strategy family (at this version) yet: deploy the newest lab code, then activate it.');
    try {
      await deps.validateSpec(spec);
    } catch (err) {
      throw new ValidationError(`The bot cannot run this strategy yet: ${err instanceof Error ? err.message : String(err)}`);
    }

    const current = await deps.getBotSettings();
    if (current.mode === 'live' && confirmLive !== true)
      fail('The bot is in live mode: activating a strategy trades real money. Confirm it first (confirmLive: true).');

    const activeResearch = {
      researchId: source.researchId,
      bucket: source.bucket,
      rank: source.rank,
      name: String(spec.name ?? '').slice(0, 200),
      activatedAt: new Date(now()).toISOString(),
    };
    // Changing the strategy makes the bot cancel its open orders for the old one (settings change listener).
    let bot = await deps.updateBotSettings({ strategy: spec, activeResearch }, { confirmLive: confirmLive === true });
    await deps.log(current.mode === 'live' ? 'warn' : 'info', 'research_activated',
      `Activated research strategy "${activeResearch.name}" (${source.what}) in ${current.mode} mode`,
      activeResearch);
    let started = false;
    let startError: string | undefined;
    if (start === true) {
      try {
        bot = await deps.enableTrading();
        started = true;
      } catch (err) {
        if (!(err instanceof ValidationError) && !deps.isSettingsError(err)) throw err;
        startError = (err as Error).message;
      }
    }
    res.json({ ok: true, bot, activeResearch, started, ...(startError ? { startError } : {}) });
  });

  // "Move everything" (Settings): hold all of it in BTC, ETH or euros instead of following the strategy, with post-only
  // limit orders; `target: null` goes back to the strategy. The bot runs it, so it is switched on if it was off.
  r.post('/bot/allocate', async (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('Send { target, confirmLive? }.');
    const { target, confirmLive } = body as Record<string, unknown>;
    if (target !== null && target !== 'BTC' && target !== 'ETH' && target !== 'EUR') fail('target must be "BTC", "ETH", "EUR" or null (back to the strategy).');
    if (confirmLive !== undefined && typeof confirmLive !== 'boolean') fail('confirmLive must be true or false.');
    const current = await deps.getBotSettings();
    if (target === null) {
      const was = current.manual?.target;
      const name = current.strategy?.name ?? '';
      const bot = await deps.updateBotSettings({ manual: null }, {});
      if (was) await deps.log('info', 'manual_cleared', `Back to the strategy ${name} after the manual move to ${was}`);
      res.json({ ok: true, bot, started: false });
      return;
    }
    if (current.mode === 'live' && confirmLive !== true)
      fail(`The bot is in live mode: moving everything to ${target} trades real money. Confirm it first (confirmLive: true).`);
    const manual = { target, setAt: new Date(now()).toISOString() };
    let bot = await deps.updateBotSettings({ manual }, { confirmLive: confirmLive === true });
    await deps.log(current.mode === 'live' ? 'warn' : 'info', 'manual_allocation',
      `Moving everything to ${target === 'EUR' ? 'euros' : target} in ${current.mode} mode with post-only limit orders (re-placed every minute until filled)`, manual);
    let started = false;
    let startError: string | undefined;
    if (!(bot as { enabled?: boolean }).enabled) {
      try {
        bot = await deps.enableTrading();
        started = true;
      } catch (err) {
        if (!(err instanceof ValidationError) && !deps.isSettingsError(err)) throw err;
        startError = (err as Error).message;
      }
    }
    res.json({ ok: true, bot, started, ...(startError ? { startError } : {}) });
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
