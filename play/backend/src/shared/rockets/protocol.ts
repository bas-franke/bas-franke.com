// Rockets wire protocol. Field names are short because snapshots go out 30 times a second.

import type { Vec3Tuple } from '../math.js';
import type { MapData } from './map.js';

export interface RocketsInput {
  /** Monotonic per client; the server echoes the last one it applied so the client can reconcile. */
  seq: number;
  f: number;
  s: number;
  jump: boolean;
  fire: boolean;
  yaw: number;
  pitch: number;
}

export interface PlayerSnap {
  id: string;
  p: Vec3Tuple;
  v: Vec3Tuple;
  /** yaw */
  y: number;
  /** pitch */
  pt: number;
  hp: number;
  /** dead */
  d: 0 | 1;
  /** on ground */
  g: 0 | 1;
  /** Last input seq applied; only sent to the player it belongs to. */
  seq?: number;
}

export interface RocketSnap {
  id: string;
  /** owner */
  o: string;
  p: Vec3Tuple;
  v: Vec3Tuple;
}

export interface RocketsSnapshot {
  tick: number;
  /** Server time in ms. */
  t: number;
  /** Seconds left in the match. */
  left: number;
  pl: PlayerSnap[];
  rk: RocketSnap[];
  /** Indices of health packs currently available. */
  pk: number[];
}

export interface ScoreRow {
  id: string;
  frags: number;
  deaths: number;
}

export type RocketsEvent =
  | { k: 'fire'; id: string; o: string; p: Vec3Tuple; v: Vec3Tuple }
  | { k: 'boom'; id: string; p: Vec3Tuple }
  | { k: 'hurt'; id: string; dmg: number; by: string }
  | { k: 'kill'; v: string; by: string; self: boolean }
  | { k: 'spawn'; id: string; p: Vec3Tuple }
  | { k: 'pack'; i: number; by: string }
  | { k: 'pad'; id: string };

export type RocketsServerMsg =
  | { k: 'init'; map: MapData; scores: ScoreRow[]; left: number }
  | { k: 'snap'; s: RocketsSnapshot }
  | { k: 'ev'; e: RocketsEvent[] }
  | { k: 'score'; scores: ScoreRow[] }
  | { k: 'end'; scores: ScoreRow[]; winner: string | null };

export type RocketsClientMsg = { k: 'in'; i: RocketsInput[] };
