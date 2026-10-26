import type { SessionStore } from '../auth.js';

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
export type LogFn = (
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  message: string,
  data?: unknown,
) => unknown;

/**
 * Everything the API needs from the rest of the backend. `index.ts` wires the real modules; tests pass fakes.
 * Kept structural (no imports of the bot's types) so the router can be tested on its own.
 */
export interface ApiDeps {
  query: Query;
  sessions: SessionStore;
  password: () => string;
  production: boolean;
  log: LogFn;
  getOverview: () => Promise<unknown>;
  enableTrading: () => Promise<unknown>;
  disableTrading: (reason: string) => Promise<unknown>;
  listMarkets: () => Promise<unknown[]>;
  getBotSettings: () => Promise<{ mode: string }>;
  updateBotSettings: (patch: Record<string, unknown>, opts: { confirmLive?: boolean }) => Promise<unknown>;
  /** True for the settings module's SettingsError (shown to the owner as a 400). */
  isSettingsError: (err: unknown) => boolean;
  families: () => unknown;
  /** Throws with a readable message when the strategy spec is not runnable. */
  validateSpec: (spec: unknown) => void;
  maxLoginAttempts?: number;
  now?: () => number;
}
