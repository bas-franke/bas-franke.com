// The Rockets arena, described as axis-aligned boxes so the same data drives server collision, client prediction,
// rendering and bot navigation. Sent to clients in the init message, so a stale bundle still sees the right map.

import { aabb, type AABB, type Vec3, v3 } from '../math.js';
import { RK } from './constants.js';

export type BoxKind = 'floor' | 'wall' | 'platform' | 'stair' | 'pillar' | 'crate' | 'ledge' | 'tower';

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

function box(kind: BoxKind, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): MapBox {
  return { ...aabb(minX, minY, minZ, maxX, maxY, maxZ), kind };
}

/** A staircase of `steps` boxes climbing in +dir along one axis, each RK.stepHeight tall. */
function stairs(
  boxes: MapBox[],
  axis: 'x' | 'z',
  dir: 1 | -1,
  startX: number,
  startZ: number,
  width: number,
  baseY: number,
  topY: number,
  depth = 0.9,
) {
  const steps = Math.round((topY - baseY) / RK.stepHeight);
  for (let i = 0; i < steps; i++) {
    const y1 = baseY + (i + 1) * RK.stepHeight;
    const along0 = i * depth;
    const along1 = (i + 1) * depth;
    if (axis === 'z') {
      const z0 = startZ + dir * along0;
      const z1 = startZ + dir * along1;
      boxes.push(box('stair', startX - width / 2, baseY, Math.min(z0, z1), startX + width / 2, y1, Math.max(z0, z1)));
    } else {
      const x0 = startX + dir * along0;
      const x1 = startX + dir * along1;
      boxes.push(box('stair', Math.min(x0, x1), baseY, startZ - width / 2, Math.max(x0, x1), y1, startZ + width / 2));
    }
  }
}

export function buildArena(): MapData {
  const half = 22;
  const wallH = 8;
  const boxes: MapBox[] = [];

  // Floor and outer walls.
  boxes.push(box('floor', -half, -1, -half, half, 0, half));
  boxes.push(box('wall', -half - 1, 0, -half - 1, half + 1, wallH, -half));
  boxes.push(box('wall', -half - 1, 0, half, half + 1, wallH, half + 1));
  boxes.push(box('wall', -half - 1, 0, -half, -half, wallH, half));
  boxes.push(box('wall', half, 0, -half, half + 1, wallH, half));

  // Central platform with stairs on the north and south side.
  const platH = 2.5;
  boxes.push(box('platform', -6, 0, -6, 6, platH, 6));
  stairs(boxes, 'z', -1, 0, 6 + 5 * 0.9, 4, 0, platH); // climbs toward -z onto the south edge (z = +6)
  stairs(boxes, 'z', 1, 0, -6 - 5 * 0.9, 4, 0, platH); // climbs toward +z onto the north edge (z = -6)

  // Four corner towers, reached by jump pads (or a rocket jump).
  const towerH = 4.5;
  const towerHalf = 3;
  const towerCentres = [v3(16, 0, 16), v3(-16, 0, 16), v3(16, 0, -16), v3(-16, 0, -16)];
  for (const c of towerCentres) {
    boxes.push(box('tower', c.x - towerHalf, 0, c.z - towerHalf, c.x + towerHalf, towerH, c.z + towerHalf));
  }

  // Pillars for cover on the diagonals, clear of the staircases.
  for (const [x, z] of [
    [8, 8],
    [-8, 8],
    [8, -8],
    [-8, -8],
  ]) {
    boxes.push(box('pillar', x - 0.9, 0, z - 0.9, x + 0.9, 5.5, z + 0.9));
  }

  // Crates: low cover and small step-ups.
  const crates: [number, number, number][] = [
    [-13, 5, 1.6],
    [13, -5, 1.6],
    [6, 14, 1.4],
    [-6, -14, 1.4],
    [-14, -5, 1.0],
    [14, 5, 1.0],
  ];
  for (const [x, z, s] of crates) boxes.push(box('crate', x - s / 2, 0, z - s / 2, x + s / 2, s, z + s / 2));

  // Ledges along the east and west walls, with stairs at one end.
  const ledgeH = 3;
  boxes.push(box('ledge', half - 2.5, 0, -9, half, ledgeH, 9));
  stairs(boxes, 'z', -1, half - 1.25, 9 + 6 * 0.9, 2.5, 0, ledgeH);
  boxes.push(box('ledge', -half, 0, -9, -half + 2.5, ledgeH, 9));
  stairs(boxes, 'z', 1, -half + 1.25, -9 - 6 * 0.9, 2.5, 0, ledgeH);

  // Jump pads: one per tower on the floor, one in the middle of the platform launching straight up.
  const pads: JumpPad[] = towerCentres.map((c) => {
    const pos = v3(Math.sign(c.x) * 10.5, 0, Math.sign(c.z) * 10.5);
    const target = v3(c.x, towerH, c.z);
    return { pos, radius: 1.1, vel: padVelocityTo(pos, target, 1.4) };
  });
  pads.push({ pos: v3(0, platH, 0), radius: 1.0, vel: v3(0, 14, 0) });

  const spawns: SpawnPoint[] = [
    { pos: v3(-18, 0, 0), yaw: -Math.PI / 2 },
    { pos: v3(18, 0, 0), yaw: Math.PI / 2 },
    { pos: v3(0, 0, -18), yaw: Math.PI },
    { pos: v3(0, 0, 18), yaw: 0 },
    { pos: v3(-10, 0, 14), yaw: Math.PI * 0.25 },
    { pos: v3(10, 0, -14), yaw: -Math.PI * 0.75 },
    { pos: v3(10, 0, 14), yaw: -Math.PI * 0.25 },
    { pos: v3(-10, 0, -14), yaw: Math.PI * 0.75 },
    { pos: v3(0, platH, 4), yaw: 0 },
    { pos: v3(0, platH, -4), yaw: Math.PI },
  ];

  const packs: Vec3[] = [v3(4.5, platH, 4.5), v3(-4.5, platH, -4.5), v3(19, 0, 12), v3(-19, 0, -12), v3(12, 0, -19), v3(-12, 0, 19)];

  return {
    name: 'Foundry',
    half,
    boxes,
    pads,
    spawns,
    packs,
    killY: RK.killY,
    skyColor: 0x0b0f1a,
    fogColor: 0x121a2b,
  };
}

export const ARENA: MapData = buildArena();
