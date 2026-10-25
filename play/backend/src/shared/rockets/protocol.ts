// Rockets wire protocol. Field names are short because snapshots go out 30 times a second.

import type { Vec3Tuple } from '../math.js';
import type { RocketsMode as GameMode, Team } from '../protocol.js';
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
  /** Team modes: team scores [red, blue] (frags in tdm, captures in ctf, round wins in elim). */
  ts?: [number, number];
  /** CTF: flag state per team, index = team. */
  fl?: [FlagSnap, FlagSnap];
  /** Elimination: round state. */
  rd?: RoundSnap;
}

export interface FlagSnap {
  /** 0 at base, 1 carried, 2 dropped. */
  s: 0 | 1 | 2;
  /** Where it is (the carrier's position while carried). */
  p: Vec3Tuple;
  /** Carrier id while carried. */
  by?: string;
}

export interface RoundSnap {
  /** Round number, from 1. */
  n: number;
  /** Players still alive per team [red, blue]. */
  alive: [number, number];
  /** Seconds left in the round (or in the intermission). */
  left: number;
  /** 'play' while fighting; 'over' during the intermission after a round. */
  state: 'play' | 'over';
}

export interface ScoreRow {
  id: string;
  frags: number;
  deaths: number;
  /** Team modes. */
  team?: Team;
  /** CTF captures. */
  caps?: number;
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
  | { k: 'pad'; id: string }
  /** CTF: a flag changed hands. `team` is the flag's team. */
  | { k: 'flag'; team: Team; a: 'take' | 'drop' | 'return' | 'capture'; by: string }
  /** Elimination: round `n` ended; winner null on a draw. */
  | { k: 'round'; n: number; winner: Team | null }
  /** A player switched team mid-match. */
  | { k: 'team'; id: string; team: Team };

export type RocketsServerMsg =
  | {
      k: 'init';
      map: MapData;
      items: ItemSpawn[];
      scores: ScoreRow[];
      left: number;
      mode: GameMode;
      /** Team modes: base positions [red, blue] (CTF flags stand here). */
      bases?: [Vec3Tuple, Vec3Tuple];
    }
  | { k: 'snap'; s: RocketsSnapshot }
  | { k: 'ev'; e: RocketsEvent[] }
  | { k: 'score'; scores: ScoreRow[] }
  | { k: 'end'; scores: ScoreRow[]; winner: string | null; winnerTeam?: Team | null };

export type RocketsClientMsg = { k: 'in'; i: RocketsInput[] };
