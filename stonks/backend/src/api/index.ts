import { pgSessionStore } from '../auth.js';
import { sendTestAlert } from '../bot/alerts.js';
import { healthDetail } from '../bot/healthDetail.js';
import { disableTrading, enableTrading, getOverview, listMarkets } from '../bot/index.js';
import { trackingReport } from '../bot/shadow.js';
import { priceHistory } from '../bot/track.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { log } from '../log.js';
import { getBotSettings, SettingsError, updateBotSettings } from '../settings.js';
import { allFamilies, checkSpec, isRunnable } from '../strategies/runtime.js';
import { createApi } from './create.js';

export { createApi } from './create.js';
export type { ApiDeps } from './deps.js';

/** The dashboard API wired to the real database and bot (SPEC.md §7). */
export const api = createApi({
  query: (text, params) => query(text, params),
  sessions: pgSessionStore((text, params) => query(text, params)),
  password: () => config.adminPassword,
  production: config.production,
  log: (level, event, message, data) => log(level, event, message, data),
  getOverview,
  enableTrading,
  disableTrading,
  listMarkets,
  getBotSettings,
  updateBotSettings: (patch, opts) => updateBotSettings(patch, opts),
  isSettingsError: (err) => err instanceof SettingsError,
  families: () => allFamilies(),
  validateSpec: async (spec) => void (await checkSpec(spec)),
  isRunnable,
  priceHistory,
  tracking: (mode, range) => trackingReport((text, params) => query(text, params), mode, range),
  sendTestAlert,
  healthDetail: () => healthDetail(),
  maxLoginAttempts: config.loginAttempts,
});
