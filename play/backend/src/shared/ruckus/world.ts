// Ruckus minigame world description and pawn movement, shared by server and client prediction.

import { clamp, type Vec3, wrapAngle } from '../math.js';
import { RU } from './constants.js';

export type MinigameId = 'hotpotato' | 'lava' | 'coins' | 'sweeper' | 'sumo';

export interface MinigameMeta {
  id: MinigameId;
  name: string;
  rules: string;
  seconds: number;
}

export const MINIGAMES: Record<MinigameId, MinigameMeta> = {
  hotpotato: {
    id: 'hotpotato',
    name: 'Hot Potato',
    rules: 'Someone is holding a bomb. Touch another player to hand it over. When it blows, the holder is out. Last one standing wins.',
    seconds: 75,
  },
  lava: {
    id: 'lava',
    name: 'Floor is Lava',
    rules: 'Tiles crack as soon as you step on them and fall away a moment later. Keep moving and be the last one standing.',
    seconds: 60,
  },
  coins: {
    id: 'coins',
    name: 'Coin Rush',
    rules: 'Coins keep dropping into the arena. Grab more than anyone else before the time runs out. Dashing into someone makes them drop a few.',
    seconds: 45,
  },
  sweeper: {
    id: 'sweeper',
    name: 'Sweeper',
    rules: 'Bars sweep around the platform and get faster. Getting hit shoves you toward the edge. Fall off and you are out.',
    seconds: 60,
  },
  sumo: {
    id: 'sumo',
    name: 'Sumo',
    rules: 'The platform shrinks. Dash into other players to shove them off. Last one on the platform wins.',
    seconds: 60,
  },
};

export const MINIGAME_IDS = Object.keys(MINIGAMES) as MinigameId[];

export type Layout =
  | { kind: 'disc'; radius: number }
  | { kind: 'tiles'; cols: number; rows: number; size: number }
  | { kind: 'square'; half: number };

export interface Bar {
  /** Angle in radians. */
  a: number;
  /** Angular speed in rad/s (sign = direction). */
  w: number;
  /** Length from the centre. */
  len: number;
}

export interface Coin {
  id: number;
  x: number;
  z: number;
}

/** Dynamic minigame state; sent in every snapshot. Only the fields a minigame uses are present. */
export interface WorldState {
  /** Current disc radius (sumo shrinks it). */
  radius?: number;
  /** Per tile: 0 solid, 1 cracking, 2 gone. */
  tiles?: number[];
  bars?: Bar[];
  coins?: Coin[];
  bomb?: { holder: string | null; fuse: number };
}

export const BAR_THICKNESS = 0.6;
export const BAR_HEIGHT = 0.9;

export function tileIndex(layout: Extract<Layout, { kind: 'tiles' }>, x: number, z: number): number {
  const cx = Math.floor(x / layout.size + layout.cols / 2);
  const cz = Math.floor(z / layout.size + layout.rows / 2);
  if (cx < 0 || cz < 0 || cx >= layout.cols || cz >= layout.rows) return -1;
  return cz * layout.cols + cx;
}

export function tileCenter(layout: Extract<Layout, { kind: 'tiles' }>, i: number): { x: number; z: number } {
  const cx = i % layout.cols;
  const cz = Math.floor(i / layout.cols);
  return { x: (cx - layout.cols / 2 + 0.5) * layout.size, z: (cz - layout.rows / 2 + 0.5) * layout.size };
}

/** Height of the floor under (x, z), or null where there is nothing to stand on. */
export function groundHeight(layout: Layout, world: WorldState, x: number, z: number): number | null {
  switch (layout.kind) {
    case 'disc': {
      const r = world.radius ?? layout.radius;
      return x * x + z * z <= r * r ? 0 : null;
    }
    case 'square':
      return Math.abs(x) <= layout.half && Math.abs(z) <= layout.half ? 0 : null;
    case 'tiles': {
      const i = tileIndex(layout, x, z);
      if (i < 0) return null;
      const s = world.tiles?.[i] ?? 0;
      return s === 2 ? null : 0;
    }
  }
}

export interface RuckusInput {
  seq: number;
  /** Desired move direction in world XZ, length <= 1. */
  mx: number;
  mz: number;
  dash: boolean;
}

export interface Pawn {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  onGround: boolean;
  /** Remaining dash time. */
  dashT: number;
  dashCd: number;
  /** Remaining stun after a bar hit: no control, immune to further hits. */
  stun: number;
}

export function newPawn(x: number, z: number): Pawn {
  return { pos: { x, y: 0, z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, onGround: true, dashT: 0, dashCd: 0, stun: 0 };
}

export interface PawnStepResult {
  dashed: boolean;
  /** A sweeper bar hit the pawn. */
  swept: boolean;
}

/** Advances a pawn by one fixed step. Pawn-vs-pawn contact is applied by the server only. */
export function stepPawn(p: Pawn, input: RuckusInput, layout: Layout, world: WorldState, dt = RU.dt): PawnStepResult {
  const res: PawnStepResult = { dashed: false, swept: false };
  let mx = input.mx;
  let mz = input.mz;
  const ml = Math.hypot(mx, mz);
  if (ml > 1) {
    mx /= ml;
    mz /= ml;
  }

  p.dashCd = Math.max(0, p.dashCd - dt);
  p.stun = Math.max(0, p.stun - dt);
  if (p.stun > 0) {
    // Stunned: no steering, just slide out.
    mx = mz = 0;
    input = { ...input, dash: false };
  }
  if (input.dash && p.dashCd === 0 && p.dashT === 0) {
    p.dashT = RU.dashTime;
    p.dashCd = RU.dashCooldown;
    if (ml > 0.1) p.yaw = Math.atan2(-mx, -mz);
    res.dashed = true;
  }

  if (p.dashT > 0) {
    p.dashT = Math.max(0, p.dashT - dt);
    p.vel.x = -Math.sin(p.yaw) * RU.dashSpeed;
    p.vel.z = -Math.cos(p.yaw) * RU.dashSpeed;
  } else if (p.onGround) {
    if (ml > 0.05 && p.stun === 0) {
      const tx = mx * RU.speed;
      const tz = mz * RU.speed;
      const k = Math.min(1, RU.accel * dt);
      p.vel.x += (tx - p.vel.x) * k;
      p.vel.z += (tz - p.vel.z) * k;
      p.yaw = Math.atan2(-mx, -mz);
    } else {
      const k = Math.max(0, 1 - RU.friction * dt);
      p.vel.x *= k;
      p.vel.z *= k;
    }
  } else if (ml > 0.05) {
    // A little air control so falling players can try to save themselves.
    p.vel.x += mx * RU.accel * 0.15 * dt;
    p.vel.z += mz * RU.accel * 0.15 * dt;
  }

  // Sweeper bars shove whoever they touch, once; the stun keeps a bar from juggling a pawn off the edge.
  if (world.bars && p.onGround && p.stun === 0) {
    const r = Math.hypot(p.pos.x, p.pos.z);
    for (const bar of world.bars) {
      if (r > bar.len + RU.radius || r < 0.01) continue;
      const ang = Math.atan2(p.pos.z, p.pos.x);
      const da = Math.abs(wrapAngle(ang - bar.a));
      const halfWidth = (BAR_THICKNESS / 2 + RU.radius) / Math.max(r, 0.5);
      if (da < halfWidth) {
        const tangential = Math.sign(bar.w) * Math.max(Math.abs(bar.w) * r, 3) * 1.3;
        // Tangent of the circle at the pawn in the direction of rotation (angle increasing).
        p.vel.x = -Math.sin(ang) * tangential + Math.cos(ang) * 3;
        p.vel.z = Math.cos(ang) * tangential + Math.sin(ang) * 3;
        p.vel.y = 3.5;
        p.onGround = false;
        p.dashT = 0;
        p.stun = RU.sweepStun;
        res.swept = true;
        break;
      }
    }
  }

  p.vel.y -= RU.gravity * dt;
  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;
  p.pos.z += p.vel.z * dt;

  if (layout.kind === 'square') {
    const lim = layout.half - RU.radius;
    if (p.pos.x < -lim || p.pos.x > lim) {
      p.pos.x = clamp(p.pos.x, -lim, lim);
      p.vel.x *= -0.3;
    }
    if (p.pos.z < -lim || p.pos.z > lim) {
      p.pos.z = clamp(p.pos.z, -lim, lim);
      p.vel.z *= -0.3;
    }
  }

  const g = groundHeight(layout, world, p.pos.x, p.pos.z);
  if (g !== null && p.pos.y <= g && p.vel.y <= 0) {
    p.pos.y = g;
    p.vel.y = 0;
    p.onGround = true;
  } else {
    p.onGround = false;
  }
  return res;
}
