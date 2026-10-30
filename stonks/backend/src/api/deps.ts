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
  getBotSettings: () => Promise<{ mode: string; enabled?: boolean; manual?: { target: string } | null; strategy?: { name?: string } }>;
  updateBotSettings: (patch: Record<string, unknown>, opts: { confirmLive?: boolean }) => Promise<unknown>;
  /** True for the settings module's SettingsError (shown to the owner as a 400). */
  isSettingsError: (err: unknown) => boolean;
  families: () => unknown;
  /** Throws (or rejects) with a readable message when the strategy spec is not runnable. */
  validateSpec: (spec: unknown) => void | Promise<void>;
  /**
   * True when the bot can run this family at this version (a TypeScript port or the server's lab code). Research
   * entries get their `botReady` from it; without it the lab's own `botReady` flag is used.
   */
  isRunnable?: (family: string, version: unknown) => boolean;
  /** Closes [ms, price] of a market between two times (Bitvavo candles), to fill the comparison chart. */
  priceHistory?: (market: string, from: number, to: number) => Promise<[number, number][]>;
  /** Expected vs actual of the strategy a mode runs (GET /api/tracking). */
  tracking?: (mode: 'paper' | 'live', range: 'day' | 'week' | 'month' | 'year' | 'all') => Promise<unknown>;
  /** One verdict per part of the bot (GET /api/health/detail). */
  healthDetail?: () => Promise<unknown>;
  /** Sends one test mail (POST /api/bot/test-alert). */
  sendTestAlert?: () => Promise<{ ok: boolean; configured: boolean; error?: string }>;
  maxLoginAttempts?: number;
  now?: () => number;
}
