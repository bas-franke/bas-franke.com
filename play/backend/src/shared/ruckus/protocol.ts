// Ruckus wire protocol.

import type { Vec3Tuple } from '../math.js';
import type { Layout, MinigameId, RuckusInput, WorldState } from './world.js';

export type Phase = 'intro' | 'play' | 'results' | 'final';

export interface PawnSnap {
  id: string;
  p: Vec3Tuple;
  v: Vec3Tuple;
  /** yaw */
  y: number;
  /** on ground */
  g: 0 | 1;
  /** eliminated this round */
  out: 0 | 1;
  /** dash time left */
  dt: number;
  /** dash cooldown left */
  cd: number;
  /** stun left */
  st: number;
  /** per-round score where it matters (coins held) */
  sc?: number;
  /** Last input seq applied; only sent to the owner. */
  seq?: number;
}

export interface RuckusSnapshot {
  tick: number;
  t: number;
  phase: Phase;
  left: number;
  pawns: PawnSnap[];
  world: WorldState;
}

export interface RuckusScore {
  id: string;
  points: number;
  /** Points gained in the last finished round. */
  last: number;
}

export type RuckusEvent =
  | { k: 'out'; id: string }
  | { k: 'coin'; id: string; at: Vec3Tuple }
  | { k: 'boom'; at: Vec3Tuple; id: string }
  | { k: 'pass'; from: string; to: string }
  | { k: 'dash'; id: string }
  | { k: 'shove'; id: string; by: string }
  | { k: 'tile'; i: number; state: number };

export type RuckusServerMsg =
  | { k: 'init'; rounds: number; scores: RuckusScore[] }
  | { k: 'round'; round: number; rounds: number; mg: MinigameId; layout: Layout; world: WorldState; left: number }
  | { k: 'phase'; phase: Phase; left: number; placements?: string[]; scores?: RuckusScore[] }
  | { k: 'snap'; s: RuckusSnapshot }
  | { k: 'ev'; e: RuckusEvent[] }
  | { k: 'end'; scores: RuckusScore[]; winner: string | null };

export type RuckusClientMsg = { k: 'in'; i: RuckusInput[] };
