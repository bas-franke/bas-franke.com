/** One candle: [openTimeMs, open, high, low, close, volume], oldest first in every array we pass around. */
export type Candle = [number, number, number, number, number, number];

export type CandlesByMarket = Record<string, Candle[]>;

/** Fraction of total equity per market, 0..1. */
export type Weights = Record<string, number>;

export const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1W'] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '1W': 604_800_000,
};

export type FamilyName =
  | 'ema_cross'
  | 'macd_trend'
  | 'donchian_breakout'
  | 'rsi_dip'
  | 'bollinger_reversion'
  | 'dca_dip'
  | 'rotation_momentum';

export interface RiskSpec {
  maxWeight: number;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  trailingStopPct: number | null;
}

export interface ExecutionSpec {
  orderType: 'limit' | 'market';
  limitOffsetBps: number;
  postOnly: boolean;
  timeoutBars: number;
  fallback: 'cancel' | 'market';
}

/** SPEC §2. `validateSpec` returns this with every default filled in. */
export interface StrategySpec {
  id: string;
  name: string;
  family: FamilyName;
  familyVersion: number;
  markets: string[];
  interval: Interval;
  params: Record<string, number | boolean | string>;
  risk: RiskSpec;
  execution: ExecutionSpec;
}

export interface ParamInfo {
  name: string;
  type: 'int' | 'number' | 'boolean' | 'enum';
  default: number | boolean | string;
  min?: number;
  max?: number;
  options?: string[];
  description: string;
}

export interface FamilyInfo {
  family: FamilyName;
  title: string;
  summary: string;
  version: number;
  /** True when the family trades several markets (rotation); the others trade exactly one. */
  multiMarket: boolean;
  params: ParamInfo[];
}

/**
 * Optional context for families whose state depends on where history starts. `startTime` anchors `dca_dip`
 * (its schedule and virtual cash start at the first bar at or after it). Without it the first candle is the anchor.
 */
export interface StrategyState {
  startTime?: number;
}
