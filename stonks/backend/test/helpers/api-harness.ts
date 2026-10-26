import express, { type ErrorRequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { memorySessionStore } from '../../src/auth.js';
import { createApi } from '../../src/api/create.js';
import type { ApiDeps, Query } from '../../src/api/deps.js';

export class FakeSettingsError extends Error {}

export interface Harness {
  base: string;
  host: string;
  deps: ApiDeps;
  calls: { sql: string; params: unknown[] }[];
  logs: { level: string; event: string }[];
  settings: Record<string, unknown>;
  close(): Promise<void>;
  /** fetch against the API; JSON body + content type added when `json` is given. */
  req(method: string, path: string, opts?: { json?: unknown; cookie?: string; headers?: Record<string, string> }): Promise<Response>;
  login(password?: string): Promise<string>;
}

/** Answers the SQL the API sends with canned rows; research snapshots are kept in memory. */
function fakeQuery(calls: Harness['calls'], tables: Record<string, any[]>): Query {
  const research: { id: string; created_at: Date; payload: unknown }[] = [];
  return async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('INSERT INTO research_snapshots')) {
      const row = { id: String(research.length + 1), created_at: new Date(), payload: JSON.parse(String(params[0])) };
      research.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('FROM research_snapshots ORDER BY id DESC LIMIT 1')) return { rows: research.slice(-1) };
    if (sql.startsWith('DELETE FROM research_snapshots')) return { rows: [] };
    for (const [table, rows] of Object.entries(tables)) if (sql.includes(`FROM ${table}`)) return { rows };
    throw new Error(`unexpected SQL: ${sql}`);
  };
}

export async function startHarness(overrides: Partial<ApiDeps> = {}, tables: Record<string, any[]> = {}): Promise<Harness> {
  const calls: Harness['calls'] = [];
  const logs: Harness['logs'] = [];
  const settings: Record<string, unknown> = { enabled: false, mode: 'paper', dailyLossLimitEur: 100 };
  const deps: ApiDeps = {
    query: fakeQuery(calls, tables),
    sessions: memorySessionStore(),
    password: () => 'test-pass',
    production: false,
    log: (level, event) => void logs.push({ level, event }),
    getOverview: async () => ({ bot: settings, running: false, equityEur: 1000 }),
    enableTrading: async () => Object.assign(settings, { enabled: true }),
    disableTrading: async () => Object.assign(settings, { enabled: false }),
    listMarkets: async () => [{ market: 'BTC-EUR', base: 'BTC', quote: 'EUR', status: 'trading', minOrderInQuoteAsset: 5 }],
    getBotSettings: async () => settings as { mode: string },
    updateBotSettings: async (patch, opts) => {
      if (patch.dailyLossLimitEur !== undefined && Number(patch.dailyLossLimitEur) < 0) {
        throw new FakeSettingsError('dailyLossLimitEur must be ≥ 0');
      }
      if (patch.mode === 'live' && settings.mode !== 'live' && !opts.confirmLive) throw new FakeSettingsError('confirm live');
      return Object.assign(settings, patch);
    },
    isSettingsError: (err) => err instanceof FakeSettingsError,
    families: () => [{ family: 'ema_cross', title: 'EMA crossover', summary: '...', params: [] }],
    validateSpec: (spec) => {
      if (!spec || typeof spec !== 'object' || !('family' in spec)) throw new Error('family is missing');
    },
    ...overrides,
  };

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use('/api', createApi(deps));
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'Not found' }));
  app.use(((_err, _req, res, _next) => void res.status(500).json({ error: 'Internal error' })) as ErrorRequestHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `http://${host}`;

  const req: Harness['req'] = (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.cookie) headers.cookie = opts.cookie;
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] ??= 'application/json';
      body = typeof opts.json === 'string' ? opts.json : JSON.stringify(opts.json);
    }
    return fetch(base + path, { method, headers, body });
  };

  return {
    base,
    host,
    deps,
    calls,
    logs,
    settings,
    req,
    async login(password = 'test-pass') {
      const res = await req('POST', '/api/auth/login', { json: { password } });
      if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
      const set = res.headers.get('set-cookie') ?? '';
      return set.split(';')[0];
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function researchPayload(topCount = 5) {
  const curve = [
    [1700000000, 1000],
    [1700086400, 1010.5],
  ];
  return {
    generatedAt: '2026-10-26T12:00:00Z',
    summary: { experiments: 18234, families: 23, rounds: 41, dataRange: ['2019-01-01', '2026-10-25'], notes: 'ok' },
    benchmark: { name: 'Buy and hold BTC', returnPct: 412.3, maxDrawdownPct: 76.1, equity: curve },
    benchmarks: [{ name: 'Buy and hold ETH', returnPct: 100, maxDrawdownPct: 80, equity: curve }],
    top: Array.from({ length: topCount }, (_, i) => ({
      rank: i + 1,
      spec: {
        id: `ema_cross-btc-4h-${i}`,
        name: 'EMA crossover, BTC 4h',
        family: 'ema_cross',
        familyVersion: 1,
        markets: ['BTC-EUR'],
        interval: '4h',
        params: { fast: 12, slow: 48 },
      },
      botReady: true,
      metrics: { finalEur: 2140.5, returnPct: 114.05, sharpe: 1.42, testPeriod: ['2024-07-01', '2026-10-25'] },
      equity: curve,
      buyHoldEquity: curve,
      explanation: { summary: 'Plain.', howItWorks: ['a', 'b'], whenItWins: 'trends', whenItLoses: 'chop', vsBuyHold: 'less' },
      lineage: { experimentId: 'x', agent: 'agent-07', round: 41, parent: null },
    })),
  };
}
