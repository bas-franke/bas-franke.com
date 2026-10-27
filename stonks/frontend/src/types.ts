// Wire types for the Stonks API (stonks/SPEC.md §2, §5, §7).

export type Mode = 'paper' | 'live';
export type Interval = '1m' | '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '8h' | '12h' | '1d' | '1W';
export const INTERVALS: Interval[] = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1W'];

export interface StrategyRisk {
  maxWeight: number;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  trailingStopPct: number | null;
}

export interface StrategyExecution {
  orderType: 'limit' | 'market';
  limitOffsetBps: number;
  postOnly: boolean;
  timeoutBars: number;
  fallback: 'cancel' | 'market';
}

export interface StrategySpec {
  id: string;
  name: string;
  family: string;
  familyVersion: number;
  markets: string[];
  interval: Interval;
  params: Record<string, number | string | boolean>;
  risk: StrategyRisk;
  execution: StrategyExecution;
}

export interface BotSettings {
  enabled: boolean;
  mode: Mode;
  strategy: StrategySpec;
  maxExposureEur: number | null;
  dailyLossLimitEur: number;
  fees: { maker: number; taker: number };
  paperStartEur: number;
  /** Set when the strategy was activated from the Research page (SPEC §8). */
  activeResearch?: ActiveResearch | null;
}

export type BucketName = 'minute' | 'hourly' | 'daily' | 'weekly' | 'mixed';
export const BUCKET_NAMES: BucketName[] = ['minute', 'hourly', 'daily', 'weekly', 'mixed'];

export interface ActiveResearch {
  researchId: number;
  bucket: BucketName | string;
  rank: number;
  name: string;
  activatedAt: string;
}

export interface Balance {
  symbol: string;
  available: number | string;
  inOrder: number | string;
  eurValue: number;
}

export interface Overview {
  bot: BotSettings;
  running: boolean;
  lastTickAt: string | null;
  bitvavo: { connected: boolean; error?: string };
  balances: Balance[];
  equityEur: number;
  /** null until the bot has recorded today's start-of-day equity. */
  todayPnlEur: number | null;
  dailyLossLimitEur: number;
  openOrders: number;
  strategyExplanation: string;
  activeResearch?: ActiveResearch | null;
}

/** Order rows: SPEC §4 lists the columns but not the JSON names, so the UI reads them tolerantly (see `pick`). */
export interface Order {
  id: number | string;
  mode: Mode;
  market: string;
  side: 'buy' | 'sell';
  type?: string;
  orderType?: string;
  price: number | string | null;
  amount: number | string;
  filled?: number | string;
  filledAmount?: number | string;
  fee?: number | string;
  feeEur?: number | string;
  feePaid?: number | string | null;
  feeCurrency?: string | null;
  filledQuote?: number | string | null;
  status: string;
  strategyId?: string;
  reason?: string | null;
  exchangeOrderId?: string;
  clientOrderId?: string;
  createdAt?: string;
  created_at?: string;
}

export interface Fill {
  id: number | string;
  mode: Mode;
  market: string;
  side: 'buy' | 'sell';
  price: number | string;
  amount: number | string;
  fee?: number | string;
  feeEur?: number | string;
  feeCurrency?: string;
  taker?: boolean;
  liquidity?: 'maker' | 'taker';
  orderId?: number | string;
  exchangeTradeId?: string;
  ts?: string;
  executedAt?: string;
  createdAt?: string;
  created_at?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogRow {
  id: number;
  ts: string;
  level: LogLevel;
  event: string;
  message: string;
  data: unknown;
}

export interface EquityPoint {
  ts: string;
  totalEur: number;
}

export interface ParamDescription {
  key?: string;
  name?: string;
  type?: 'int' | 'integer' | 'number' | 'float' | 'boolean' | 'bool' | 'enum' | 'string';
  default?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  description?: string;
  label?: string;
}

export interface FamilyInfo {
  family: string;
  name?: string;
  title?: string;
  version?: number;
  familyVersion?: number;
  description?: string;
  summary?: string;
  multiMarket?: boolean;
  params: ParamDescription[] | Record<string, ParamDescription>;
}

export interface MarketInfo {
  market: string;
  base?: string;
  quote?: string;
  status?: string;
}

export type Series = [number | string, number][];

export interface ResearchMetrics {
  finalEur: number;
  returnPct: number;
  cagrPct?: number;
  maxDrawdownPct: number;
  sharpe: number;
  trades: number;
  winRatePct: number;
  feesEur: number;
  exposurePct?: number;
  vsBuyHoldPct: number;
  /** The lab's ranking score (only comparable within one timeframe bucket). */
  score?: number;
  trainReturnPct?: number;
  testPeriod?: [string, string];
}

export interface ResearchEntry {
  rank: number;
  spec: StrategySpec;
  botReady: boolean;
  metrics: ResearchMetrics;
  equity: Series;
  buyHoldEquity: Series;
  explanation: {
    summary: string;
    howItWorks: string[];
    whenItWins: string;
    whenItLoses: string;
    vsBuyHold: string;
  };
  lineage?: { experimentId?: string; agent?: string; round?: number; parent?: string | null };
}

export interface Benchmark {
  name: string;
  returnPct: number;
  maxDrawdownPct: number;
  equity: Series;
}

/** One timeframe bucket of a v2 research payload (SPEC §8). */
export interface ResearchBucket {
  label: string;
  intervals: string[];
  profile?: { holdoutDays?: number; folds?: number; foldSpanDays?: number; dataFrom?: string } | null;
  /** Buy and hold's score on this bucket's evaluation profile. */
  holdScore?: number | null;
  /** Placebo strategies (random timing): what pure luck scores here. */
  luckLine?: { median?: number; best?: number; exposure?: number } | null;
  benchmark?: Benchmark | null;
  notes?: string;
  top: ResearchEntry[];
}

export interface ResearchPayload {
  /** Snapshot id (added by the backend). */
  id?: number;
  createdAt?: string;
  buckets?: Partial<Record<BucketName, ResearchBucket>>;
  generatedAt: string;
  summary: { experiments: number; families: number; rounds: number; dataRange: [string, string]; notes?: string };
  benchmark: Benchmark;
  benchmarks?: Benchmark[];
  top: ResearchEntry[];
}

export type ResearchResponse = ResearchPayload | { empty: true };

export interface ActivateResult {
  ok: true;
  bot: BotSettings;
  activeResearch: ActiveResearch;
  started: boolean;
  startError?: string;
}
