// Last Light wire protocol. Field names are short because snapshots go out 30 times a second.

import type { Vec3Tuple } from '../math.js';
import type { ZInput } from './physics.js';
import type { WeaponId } from './weapons.js';

/** 0 alive, 1 downed, 2 dead (back next wave). */
export type LifeState = 0 | 1 | 2;

export interface ZPlayerSnap {
  id: string;
  p: Vec3Tuple;
  v: Vec3Tuple;
  y: number;
  pt: number;
  st: LifeState;
  /** Weapon in hand. */
  w: WeaponId;
  /** Aiming down sights. */
  a?: 1;
  /** Reloading. */
  r?: 1;
  /** Sprinting. */
  sp?: 1;
  /** Holding use on something (repairing, reviving). */
  u?: 1;
}

/** Zombie states on the wire. */
export const ZState = { Rise: 0, Walk: 1, Tear: 2, Vault: 3, Attack: 4, Bash: 5 } as const;
export type ZState = (typeof ZState)[keyof typeof ZState];

export interface ZombieSnap {
  id: number;
  p: Vec3Tuple;
  y: number;
  s: ZState;
  /** Progress of the current state, 0..1 (rise, vault, attack swing). */
  a: number;
  /** Look variant (clothes, skin, gait). */
  v: number;
  /** Speed class: 0 shambler, 1 jogger. */
  j: 0 | 1;
  /** Lost limbs (GIB bits). */
  g: number;
}

export const GIB = { head: 1, armL: 2, armR: 4, legL: 8, legR: 16 } as const;

export interface MeSnap {
  seq: number;
  hp: number;
  ar: number;
  pts: number;
  sl: [WeaponId, WeaponId | null];
  cur: 0 | 1;
  mag: [number, number];
  res: [number, number];
  nd: number;
  /** Seconds of reload left. */
  rl: number;
  /** Bleed-out seconds left while downed. */
  bo?: number;
  /** Progress of a repair or revive in progress, 0..1. */
  pr?: number;
}

export interface ZSnapshot {
  tick: number;
  /** Server time in ms. */
  t: number;
  wave: number;
  /** 'break' between waves (left = seconds), 'wave' while fighting (left = zombies still to kill). */
  ph: 'break' | 'wave';
  left: number;
  pl: ZPlayerSnap[];
  zb: ZombieSnap[];
  /** Boards per window; only when changed. */
  bd?: number[];
  me?: MeSnap;
}

export interface ZScore {
  id: string;
  points: number;
  kills: number;
  heads: number;
  downs: number;
  revives: number;
}

/** Material codes for impacts: index into IMPACT_MATS. */
export const IMPACT_MATS = ['none', 'brick', 'plaster', 'concrete', 'wood', 'metal', 'flesh'] as const;
export type ImpactMat = (typeof IMPACT_MATS)[number];

export type ZEvent =
  /** Someone fired; `e` are the bullet end points with the material code they hit. */
  | { k: 'shot'; id: string; w: WeaponId; o: Vec3Tuple; e: [number, number, number, number][] }
  | { k: 'zhit'; z: number; p: Vec3Tuple; head: 0 | 1; by: string }
  | { k: 'zdie'; z: number; by: string; head: 0 | 1; gib: number; how: 'gun' | 'nade' | 'knife'; dir: Vec3Tuple }
  /** Chunks broken (`d`) and chunks that lost their support and fell (`f`); `at` is the cause, for debris velocity. */
  | { k: 'chunks'; d: number[]; f: number[]; at: Vec3Tuple; x?: 1 }
  /** Health of damaged chunks: [index, hp] pairs. */
  | { k: 'chp'; c: number[] }
  | { k: 'board'; w: number; n: number; a: 'tear' | 'fix' }
  | { k: 'nade'; id: number; by: string; o: Vec3Tuple; v: Vec3Tuple }
  | { k: 'boom'; id: number; p: Vec3Tuple }
  | { k: 'phurt'; id: string; dmg: number; from: Vec3Tuple }
  | { k: 'pdown'; id: string }
  | { k: 'previve'; id: string; by: string }
  | { k: 'pdead'; id: string }
  | { k: 'pspawn'; id: string; p: Vec3Tuple }
  | { k: 'wave'; n: number; count: number }
  | { k: 'clear'; n: number }
  | { k: 'buy'; id: string; what: string; cost: number }
  | { k: 'pts'; id: string; n: number; why: 'hit' | 'kill' | 'head' | 'knife' | 'fix' | 'revive' }
  | { k: 'deny'; id: string; why: string }
  | { k: 'zatk'; z: number }
  | { k: 'melee'; id: string };

export type ZombiesServerMsg =
  | {
      k: 'init';
      /** Shape the room page reads for the after-match panel. */
      map: { id: string; name: string };
      /** Chunk state: broken indices and [index, hp] pairs of damaged ones. */
      down: number[];
      dmg: number[];
      boards: number[];
      wave: number;
      scores: ZScore[];
    }
  | { k: 'snap'; s: ZSnapshot }
  | { k: 'ev'; e: ZEvent[] }
  | { k: 'score'; scores: ZScore[] }
  | { k: 'end'; scores: ZScore[]; winner: string | null; wave: number };

export type ZombiesClientMsg =
  | { k: 'in'; i: ZInput[] }
  /** One trigger pull: origin, one direction per pellet, and the server time the shooter was looking at. */
  | { k: 'fire'; w: WeaponId; o: Vec3Tuple; d: Vec3Tuple[]; rt: number }
  | { k: 'reload' }
  | { k: 'slot'; s: 0 | 1 }
  | { k: 'throw'; o: Vec3Tuple; v: Vec3Tuple }
  | { k: 'knife'; o: Vec3Tuple; d: Vec3Tuple; rt: number };
