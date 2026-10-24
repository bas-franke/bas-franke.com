// Rockets arenas, described as axis-aligned boxes so the same data drives server collision, client prediction,
// rendering and bot navigation. The server picks one per match and sends it in the init message, so clients never
// need their own copy. The maps themselves live in maps.ts; this file has the types and the builder they share.

import { aabb, type AABB, type Vec3, v3 } from '../math.js';
import { RK } from './constants.js';

/** `clip` boxes collide but are never drawn: the invisible walls that keep rocket jumps inside the arena. */
export type BoxKind = 'floor' | 'wall' | 'platform' | 'stair' | 'pillar' | 'crate' | 'ledge' | 'tower' | 'clip';

export interface MapBox extends AABB {
  kind: BoxKind;
}

export interface JumpPad {
  /** Centre of the pad on the surface it sits on. */
  pos: Vec3;
  radius: number;
  /** Velocity given to a player standing on the pad. */
  vel: Vec3;
}

export interface SpawnPoint {
  pos: Vec3;
  yaw: number;
}

export interface MapData {
  id: string;
  name: string;
  /** Half-size of the playable square. */
  half: number;
  boxes: MapBox[];
  pads: JumpPad[];
  spawns: SpawnPoint[];
  /** Health pack positions (on the ground). */
  packs: Vec3[];
  killY: number;
  /** Visual hints for the client; harmless to collision. */
  skyColor: number;
  fogColor: number;
  /** Per-kind colour overrides for this map's look. */
  tint?: Partial<Record<BoxKind, number>>;
  /** Neon trim, floor grid and jump pad colour. */
  accent?: number;
}

/** Launch velocity that carries a player from `from` to `to` with the apex `apexExtra` metres above the landing. */
export function padVelocityTo(from: Vec3, to: Vec3, apexExtra = 1.2): Vec3 {
  const g = RK.gravity;
  const dy = to.y - from.y;
  const vy = Math.sqrt(2 * g * Math.max(dy, 0) + 2 * g * apexExtra);
  const tUp = vy / g;
  const apex = from.y + (vy * vy) / (2 * g);
  const tDown = Math.sqrt((2 * Math.max(apex - to.y, 0.01)) / g);
  const t = tUp + tDown;
  return v3((to.x - from.x) / t, vy, (to.z - from.z) / t);
}

/** Yaw that looks from (x, z) toward the map centre. */
export const yawToCentre = (x: number, z: number) => (x === 0 && z === 0 ? 0 : Math.atan2(x, z));

/** Rotates (x, z) by `turns` quarter turns around the vertical axis through the centre. */
function rotXZ(x: number, z: number, turns: number): [number, number] {
  switch (((turns % 4) + 4) % 4) {
    case 1:
      return [-z, x];
    case 2:
      return [-x, -z];
    case 3:
      return [z, -x];
    default:
      return [x, z];
  }
}

const rotPoint = (p: Vec3, turns: number): Vec3 => {
  const [x, z] = rotXZ(p.x, p.z, turns);
  return v3(x, p.y, z);
};

/** Collects boxes, pads, spawns and packs. `quad` and `pair` stamp a piece of layout with rotational symmetry. */
export class MapBuilder {
  readonly boxes: MapBox[] = [];
  readonly pads: JumpPad[] = [];
  readonly spawns: SpawnPoint[] = [];
  readonly packs: Vec3[] = [];

  box(kind: BoxKind, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    this.boxes.push({ ...aabb(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)), kind });
    return this;
  }

  /** A box centred on (cx, cz) with half-extents hx, hz, from y0 up to y1. */
  block(kind: BoxKind, cx: number, cz: number, hx: number, hz: number, y1: number, y0 = 0) {
    return this.box(kind, cx - hx, y0, cz - hz, cx + hx, y1, cz + hz);
  }

  /** A staircase climbing in +dir along one axis from (startX, startZ), each step RK.stepHeight tall. */
  stairs(axis: 'x' | 'z', dir: 1 | -1, startX: number, startZ: number, width: number, baseY: number, topY: number, depth = 0.9) {
    const steps = Math.round((topY - baseY) / RK.stepHeight);
    for (let i = 0; i < steps; i++) {
      const y1 = baseY + (i + 1) * RK.stepHeight;
      const a0 = dir * i * depth;
      const a1 = dir * (i + 1) * depth;
      if (axis === 'z') this.box('stair', startX - width / 2, baseY, startZ + a0, startX + width / 2, y1, startZ + a1);
      else this.box('stair', startX + a0, baseY, startZ - width / 2, startX + a1, y1, startZ + width / 2);
    }
    return this;
  }

  /** Length of the run that `stairs` needs to climb from baseY to topY. */
  static run(baseY: number, topY: number, depth = 0.9) {
    return Math.round((topY - baseY) / RK.stepHeight) * depth;
  }

  /** A pad at `from` that throws players onto `to`. */
  padTo(from: Vec3, to: Vec3, apexExtra = 1.4, radius = 1.1) {
    this.pads.push({ pos: from, radius, vel: padVelocityTo(from, to, apexExtra) });
    return this;
  }

  /** A pad that launches straight up. */
  padUp(pos: Vec3, vy: number, radius = 1) {
    this.pads.push({ pos, radius, vel: v3(0, vy, 0) });
    return this;
  }

  /** A spawn point; by default it faces the map centre. */
  spawn(x: number, y: number, z: number, yaw = yawToCentre(x, z)) {
    this.spawns.push({ pos: v3(x, y, z), yaw });
    return this;
  }

  pack(x: number, y: number, z: number) {
    this.packs.push(v3(x, y, z));
    return this;
  }

  /** Draws `piece` four times, rotated a quarter turn each time. */
  quad(piece: (b: MapBuilder) => void) {
    return this.stamp(piece, [0, 1, 2, 3]);
  }

  /** Draws `piece` twice, the second copy turned half way round. */
  pair(piece: (b: MapBuilder) => void) {
    return this.stamp(piece, [0, 2]);
  }

  private stamp(piece: (b: MapBuilder) => void, turns: number[]) {
    const part = new MapBuilder();
    piece(part);
    for (const t of turns) {
      for (const b of part.boxes) {
        const [ax, az] = rotXZ(b.min.x, b.min.z, t);
        const [bx, bz] = rotXZ(b.max.x, b.max.z, t);
        this.box(b.kind, ax, b.min.y, az, bx, b.max.y, bz);
      }
      for (const p of part.pads) this.pads.push({ pos: rotPoint(p.pos, t), radius: p.radius, vel: rotPoint(p.vel, t) });
      for (const s of part.spawns) {
        const [fx, fz] = rotXZ(-Math.sin(s.yaw), -Math.cos(s.yaw), t);
        this.spawns.push({ pos: rotPoint(s.pos, t), yaw: Math.atan2(-fx, -fz) });
      }
      for (const p of part.packs) this.packs.push(rotPoint(p, t));
    }
    return this;
  }

  /**
   * The outer shell: an optional floor, visible walls `wallH` tall (0 for none) and invisible clip walls above them
   * up to RK.ceiling. Open maps (no floor) clip from below the kill height so nobody escapes sideways either.
   */
  shell(half: number, wallH: number, floor = true) {
    if (floor) this.box('floor', -half, -1, -half, half, 0, half);
    const bottom = floor ? 0 : RK.killY - 10;
    const sides: [number, number, number, number][] = [
      [-half - 1, -half - 1, half + 1, -half],
      [-half - 1, half, half + 1, half + 1],
      [-half - 1, -half, -half, half],
      [half, -half, half + 1, half],
    ];
    for (const [x0, z0, x1, z1] of sides) {
      if (wallH > 0) this.box('wall', x0, bottom, z0, x1, wallH, z1);
      this.box('clip', x0, wallH > 0 ? wallH : bottom, z0, x1, RK.ceiling, z1);
    }
    return this;
  }

  build(meta: Pick<MapData, 'id' | 'name' | 'half' | 'skyColor' | 'fogColor' | 'tint' | 'accent'>): MapData {
    return { ...meta, boxes: this.boxes, pads: this.pads, spawns: this.spawns, packs: this.packs, killY: RK.killY };
  }
}
