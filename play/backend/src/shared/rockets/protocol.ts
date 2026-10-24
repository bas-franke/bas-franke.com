// Rockets wire protocol. Field names are short because snapshots go out 30 times a second.

import type { Vec3Tuple } from '../math.js';
import type { ItemKind, ItemSpawn } from './items.js';
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
  /** Health; above 100 after a mega health, ticking back down. */
  hp: number;
  /** Armor, omitted when 0. Soaks ITEM.armorProtection of incoming damage. */
  ar?: number;
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
  /** Indices of health packs currently available. Only sent when it changed since this player's last snapshot. */
  pk?: number[];
  /** Indices into the init message's `items` currently available. Only sent when it changed. */
  it?: number[];
  /** Seconds of start countdown left (only while > 0). */
  cd?: number;
  /** 1 during overtime. */
  ot?: 1;
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
  /** Item `i` (index into init `items`) was picked up; `t` is its kind so the client can play the right sound. */
  | { k: 'item'; i: number; t: ItemKind; by: string }
  | { k: 'pad'; id: string };

export type RocketsServerMsg =
  | { k: 'init'; map: MapData; items: ItemSpawn[]; scores: ScoreRow[]; left: number }
  | { k: 'snap'; s: RocketsSnapshot }
  | { k: 'ev'; e: RocketsEvent[] }
  | { k: 'score'; scores: ScoreRow[] }
  | { k: 'end'; scores: ScoreRow[]; winner: string | null };

export type RocketsClientMsg = { k: 'in'; i: RocketsInput[] };
