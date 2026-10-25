// The destructible world of a Last Light map, built identically on the server and in the browser from the map id.
//
// - Walls and props are made of chunks: axis-aligned boxes about 0.5 m across with health. Bullets chip them,
//   grenades and zombies bash them, and chunks no longer connected to the floor or ceiling collapse (collapse()).
//   Chunk indices are stable, so the server only ever sends indices and health values.
// - Solids are what never breaks: floor, ceiling, corner posts, lockers, the yard boundary and window sills.
//   Clips block players only (the window openings).
// - A 1 m grid over the whole map indexes the chunks for collision and ray casts.

import type { AABB, Vec3 } from '../math.js';
import { LOCKER_ORDER, type WeaponId } from './weapons.js';
import type { MapDef, Mat, PropDef, Side, StationKind } from './maps.js';

export const CHUNK = 0.5;
export const WALL_T = 0.4;
export const YARD = 9;
export const SILL_Y = 1;
export const WINDOW_TOP = 2.5;
/** Window opening width in chunk columns. */
const WINDOW_COLS = 3;

export const MAT_HP: Record<Mat, number> = { brick: 110, plaster: 70, concrete: 240, wood: 45, metal: 420 };

export interface Chunk {
  min: Vec3;
  max: Vec3;
  mat: Mat;
  maxHp: number;
  /** Never breaks (window sills). */
  hard: boolean;
  /** Touches the floor or the ceiling: holds up whatever is connected to it. */
  anchored: boolean;
  /** Face-touching neighbours. */
  nb: number[];
  /** Part of an outer wall (for the nav grid and rendering). */
  wall: boolean;
}

export interface Solid extends AABB {
  kind: 'floor' | 'ceiling' | 'post' | 'locker' | 'bound' | 'clip' | 'sill';
}

export interface WindowInfo {
  i: number;
  side: Side;
  /** Centre of the opening on the wall's centre plane, at sill height. */
  center: Vec3;
  /** Unit vector pointing out of the room. */
  out: Vec3;
  /** Where a player stands to repair, and where a zombie stands to tear boards. */
  inside: Vec3;
  outside: Vec3;
  /** Where zombies for this window rise from the ground. */
  spawns: Vec3[];
  width: number;
}

export interface StationInfo {
  i: number;
  kind: StationKind;
  item?: WeaponId;
  /** Front centre of the locker at floor height, and the direction it faces (into the room). */
  pos: Vec3;
  facing: Vec3;
  box: AABB;
}

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface World {
  def: MapDef;
  chunks: Chunk[];
  /** 1 while a chunk stands. */
  alive: Uint8Array;
  hp: Float32Array;
  solids: Solid[];
  windows: WindowInfo[];
  stations: StationInfo[];
  lamps: { pos: Vec3; flicker: number }[];
  interior: Rect;
  bounds: Rect;
  height: number;
  spawns: Vec3[];
  // Chunk grid (1 m cells).
  gx0: number;
  gz0: number;
  gnx: number;
  gny: number;
  gnz: number;
  cells: number[][];
  stamp: Uint32Array;
  stampN: number;
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

// ---- building -------------------------------------------------------------------------------------------------

export function buildWorld(def: MapDef): World {
  const hw = def.w / 2;
  const hd = def.d / 2;
  const h = def.h;
  const chunks: Chunk[] = [];
  const solids: Solid[] = [];
  const windows: WindowInfo[] = [];
  const add = (min: Vec3, max: Vec3, mat: Mat, wall = false, hard = false) => {
    chunks.push({ min, max, mat, maxHp: hard ? Infinity : MAT_HP[mat], hard, anchored: min.y <= 1e-3 || max.y >= h - 1e-3, nb: [], wall });
  };

  // Outer walls, one side at a time. Each side runs along an axis between the corner posts.
  const sides: { side: Side; along: 'x' | 'z'; len: number; fixed: number; out: number }[] = [
    { side: 'n', along: 'x', len: def.w, fixed: -hd, out: -1 },
    { side: 's', along: 'x', len: def.w, fixed: hd, out: 1 },
    { side: 'w', along: 'z', len: def.d, fixed: -hw, out: -1 },
    { side: 'e', along: 'z', len: def.d, fixed: hw, out: 1 },
  ];
  const rows = Math.round(h / CHUNK);
  for (const s of sides) {
    const cols = Math.round(s.len / CHUNK);
    const start = -s.len / 2;
    // Window columns for this side: the column nearest `at`, and one either side.
    const winCols = new Map<number, number>();
    for (const wdef of def.windows) {
      if (wdef.side !== s.side) continue;
      const k = Math.round((wdef.at - start) / CHUNK - 0.5);
      const wi = windows.length;
      for (let c = k - 1; c <= k + 1; c++) winCols.set(c, wi);
      const along = start + (k + 0.5) * CHUNK;
      const wallMid = s.fixed + (s.out * WALL_T) / 2;
      const out = s.along === 'x' ? v(0, 0, s.out) : v(s.out, 0, 0);
      const at = (a: number, b: number) => (s.along === 'x' ? v(a, 0, b) : v(b, 0, a));
      const center = at(along, wallMid);
      center.y = SILL_Y;
      const inside = at(along, s.fixed - s.out * 0.7);
      const outside = at(along, s.fixed + s.out * (WALL_T + 0.65));
      const spawns = [-2.2, 0, 2.2].map((lat, j) => at(along + lat, s.fixed + s.out * (WALL_T + 4.5 + j * 0.8)));
      windows.push({ i: wi, side: s.side, center, out, inside, outside, spawns, width: WINDOW_COLS * CHUNK });
      // Players may not climb out; zombies vault (the server moves them through without collision).
      const a0 = start + (k - 1) * CHUNK;
      const a1 = start + (k + 2) * CHUNK;
      const f0 = Math.min(s.fixed, s.fixed + s.out * WALL_T);
      const f1 = Math.max(s.fixed, s.fixed + s.out * WALL_T);
      solids.push(s.along === 'x' ? { kind: 'clip', min: v(a0, SILL_Y, f0 - 0.05), max: v(a1, h, f1 + 0.05) } : { kind: 'clip', min: v(f0 - 0.05, SILL_Y, a0), max: v(f1 + 0.05, h, a1) });
    }
    for (let c = 0; c < cols; c++) {
      const a0 = start + c * CHUNK;
      const a1 = a0 + CHUNK;
      const f0 = Math.min(s.fixed, s.fixed + s.out * WALL_T);
      const f1 = Math.max(s.fixed, s.fixed + s.out * WALL_T);
      const isWin = winCols.has(c);
      for (let r = 0; r < rows; r++) {
        const y0 = r * CHUNK;
        const y1 = Math.min(h, y0 + CHUNK);
        if (isWin && y0 >= SILL_Y - 1e-3 && y1 <= WINDOW_TOP + 1e-3) continue;
        const sill = isWin && y1 <= SILL_Y + 1e-3;
        const min = s.along === 'x' ? v(a0, y0, f0) : v(f0, y0, a0);
        const max = s.along === 'x' ? v(a1, y1, f1) : v(f1, y1, a1);
        add(min, max, sill ? 'concrete' : def.wall, true, sill);
      }
    }
  }
  // Corner posts.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const x0 = sx < 0 ? -hw - WALL_T : hw;
      const z0 = sz < 0 ? -hd - WALL_T : hd;
      solids.push({ kind: 'post', min: v(x0, 0, z0), max: v(x0 + WALL_T, h, z0 + WALL_T) });
    }

  for (const p of def.props) addProp(p, h, add);

  // Floor, ceiling (with skylight holes), the yard boundary.
  const bounds: Rect = { minX: -hw - YARD, maxX: hw + YARD, minZ: -hd - YARD, maxZ: hd + YARD };
  solids.push({ kind: 'floor', min: v(bounds.minX - 1, -1, bounds.minZ - 1), max: v(bounds.maxX + 1, 0, bounds.maxZ + 1) });
  for (const c of ceilingPieces(def)) solids.push({ kind: 'ceiling', min: v(c.minX, h, c.minZ), max: v(c.maxX, h + 0.35, c.maxZ) });
  const B = 1;
  solids.push({ kind: 'bound', min: v(bounds.minX - B, 0, bounds.minZ - B), max: v(bounds.minX, 12, bounds.maxZ + B) });
  solids.push({ kind: 'bound', min: v(bounds.maxX, 0, bounds.minZ - B), max: v(bounds.maxX + B, 12, bounds.maxZ + B) });
  solids.push({ kind: 'bound', min: v(bounds.minX, 0, bounds.minZ - B), max: v(bounds.maxX, 12, bounds.minZ) });
  solids.push({ kind: 'bound', min: v(bounds.minX, 0, bounds.maxZ), max: v(bounds.maxX, 12, bounds.maxZ + B) });

  const stations = placeStations(def, windows);
  for (const st of stations) solids.push({ kind: 'locker', min: st.box.min, max: st.box.max });

  const world: World = {
    def,
    chunks,
    alive: new Uint8Array(chunks.length).fill(1),
    hp: Float32Array.from(chunks, (c) => (c.hard ? 1e9 : c.maxHp)),
    solids,
    windows,
    stations,
    lamps: def.lamps.map((l) => ({ pos: v(l.x, h - 0.95, l.z), flicker: l.flicker ?? 0 })),
    interior: { minX: -hw, maxX: hw, minZ: -hd, maxZ: hd },
    bounds,
    height: h,
    spawns: def.spawns.map((s) => v(s.x, 0, s.z)),
    gx0: bounds.minX,
    gz0: bounds.minZ,
    gnx: Math.ceil(bounds.maxX - bounds.minX),
    gny: Math.ceil(h + 1),
    gnz: Math.ceil(bounds.maxZ - bounds.minZ),
    cells: [],
    stamp: new Uint32Array(chunks.length),
    stampN: 0,
  };
  world.cells = Array.from({ length: world.gnx * world.gny * world.gnz }, () => []);
  chunks.forEach((c, i) => {
    const [x0, x1, y0, y1, z0, z1] = cellRange(world, c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) world.cells[cellIndex(world, x, y, z)].push(i);
  });
  // Neighbours: chunks whose faces touch (overlap in two axes, meet in the third).
  chunks.forEach((c, i) => {
    const probe = { min: v(c.min.x - 0.01, c.min.y - 0.01, c.min.z - 0.01), max: v(c.max.x + 0.01, c.max.y + 0.01, c.max.z + 0.01) };
    forChunks(world, probe, (j) => {
      if (j === i) return;
      const o = chunks[j];
      const ox = Math.min(c.max.x, o.max.x) - Math.max(c.min.x, o.min.x);
      const oy = Math.min(c.max.y, o.max.y) - Math.max(c.min.y, o.min.y);
      const oz = Math.min(c.max.z, o.max.z) - Math.max(c.min.z, o.min.z);
      const pos = [ox > 0.04, oy > 0.04, oz > 0.04].filter(Boolean).length;
      if (pos >= 2) c.nb.push(j);
    });
  });
  return world;
}

type Adder = (min: Vec3, max: Vec3, mat: Mat) => void;

function addProp(p: PropDef, h: number, add: Adder) {
  const box = (x0: number, y0: number, z0: number, sx: number, sy: number, sz: number, mat: Mat) => add(v(x0, y0, z0), v(x0 + sx, y0 + sy, z0 + sz), mat);
  const grid = (cx: number, cz: number, nx: number, ny: number, nz: number, size: number, mat: Mat, y0 = 0, sy = size) => {
    const x0 = cx - (nx * size) / 2;
    const z0 = cz - (nz * size) / 2;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) box(x0 + i * size, y0 + j * sy, z0 + k * size, size, sy, size, mat);
  };
  switch (p.kind) {
    case 'crate':
      grid(p.x, p.z, 2, 2 * (p.n ?? 1), 2, 0.5, 'wood');
      break;
    case 'pillar':
      grid(p.x, p.z, 1, Math.round(h / 0.5), 1, 0.5, 'concrete');
      break;
    case 'altar':
      grid(p.x, p.z, 4, 2, 2, 0.5, 'concrete');
      break;
    case 'tank':
      grid(p.x, p.z, 3, 5, 3, 0.5, 'metal');
      break;
    case 'lowwall': {
      const n = Math.round((p.n ?? 2) / 0.5);
      for (let i = 0; i < n; i++)
        for (let j = 0; j < 2; j++) {
          const a = -((n * 0.5) / 2) + i * 0.5;
          if (p.r === 1) box(p.x - 0.15, j * 0.5, p.z + a, 0.3, 0.5, 0.5, 'brick');
          else box(p.x + a, j * 0.5, p.z - 0.15, 0.5, 0.5, 0.3, 'brick');
        }
      break;
    }
    case 'pew': {
      // Seat blocks with a thin back on the south edge; along x.
      const n = Math.round((p.n ?? 3) / 0.5);
      const x0 = p.x - (n * 0.5) / 2;
      for (let i = 0; i < n; i++) {
        box(x0 + i * 0.5, 0, p.z - 0.25, 0.5, 0.45, 0.45, 'wood');
        box(x0 + i * 0.5, 0, p.z + 0.2, 0.5, 0.45, 0.1, 'wood');
        box(x0 + i * 0.5, 0.45, p.z + 0.2, 0.5, 0.5, 0.1, 'wood');
      }
      break;
    }
    case 'table': {
      // 2 x 1 m top on four legs: shoot a leg out and that corner drops.
      const x0 = p.x - 1;
      const z0 = p.z - 0.5;
      for (const [lx, lz] of [
        [0, 0],
        [1.9, 0],
        [0, 0.9],
        [1.9, 0.9],
      ])
        box(x0 + lx, 0, z0 + lz, 0.1, 0.72, 0.1, 'wood');
      for (let i = 0; i < 4; i++) for (let k = 0; k < 2; k++) box(x0 + i * 0.5, 0.72, z0 + k * 0.5, 0.5, 0.08, 0.5, 'wood');
      break;
    }
  }
}

/** The ceiling as rectangles around the skylight holes (a hole splits its band into strips). */
function ceilingPieces(def: MapDef): Rect[] {
  const hw = def.w / 2 + WALL_T;
  const hd = def.d / 2 + WALL_T;
  let pieces: Rect[] = [{ minX: -hw, maxX: hw, minZ: -hd, maxZ: hd }];
  for (const s of def.skylights ?? []) {
    const hole: Rect = { minX: s.x - s.w / 2, maxX: s.x + s.w / 2, minZ: s.z - s.d / 2, maxZ: s.z + s.d / 2 };
    const next: Rect[] = [];
    for (const p of pieces) {
      if (hole.minX >= p.maxX || hole.maxX <= p.minX || hole.minZ >= p.maxZ || hole.maxZ <= p.minZ) {
        next.push(p);
        continue;
      }
      if (hole.minZ > p.minZ) next.push({ ...p, maxZ: hole.minZ });
      if (hole.maxZ < p.maxZ) next.push({ ...p, minZ: hole.maxZ });
      const z0 = Math.max(p.minZ, hole.minZ);
      const z1 = Math.min(p.maxZ, hole.maxZ);
      if (hole.minX > p.minX) next.push({ minX: p.minX, maxX: hole.minX, minZ: z0, maxZ: z1 });
      if (hole.maxX < p.maxX) next.push({ minX: hole.maxX, maxX: p.maxX, minZ: z0, maxZ: z1 });
    }
    pieces = next;
  }
  return pieces;
}

/** Lockers stand against the inside of the walls, spread evenly and clear of the windows and corners. */
function placeStations(def: MapDef, windows: WindowInfo[]): StationInfo[] {
  const wanted: { kind: StationKind; item?: WeaponId }[] = [
    ...LOCKER_ORDER.map((item) => ({ kind: 'weapon' as const, item })),
    { kind: 'ammo' },
    { kind: 'nades' },
    { kind: 'armor' },
  ];
  const hw = def.w / 2;
  const hd = def.d / 2;
  const spots: { pos: Vec3; facing: Vec3 }[] = [];
  // Walk the walls clockwise from the north-west corner in 1 m steps.
  const step = 1;
  const walls: { from: Vec3; dir: Vec3; len: number; facing: Vec3 }[] = [
    { from: v(-hw, 0, -hd), dir: v(1, 0, 0), len: def.w, facing: v(0, 0, 1) },
    { from: v(hw, 0, -hd), dir: v(0, 0, 1), len: def.d, facing: v(-1, 0, 0) },
    { from: v(hw, 0, hd), dir: v(-1, 0, 0), len: def.w, facing: v(0, 0, -1) },
    { from: v(-hw, 0, hd), dir: v(0, 0, -1), len: def.d, facing: v(1, 0, 0) },
  ];
  const blocked = (p: Vec3) =>
    windows.some((w) => Math.hypot(w.inside.x - p.x, w.inside.z - p.z) < 2.1) ||
    def.props.some((pr) => Math.abs(pr.x - p.x) < 2.2 && Math.abs(pr.z - p.z) < 2.2);
  for (const w of walls) {
    for (let a = 1.5; a <= w.len - 1.5 + 1e-6; a += step) {
      const p = v(w.from.x + w.dir.x * a + w.facing.x * 0.55, 0, w.from.z + w.dir.z * a + w.facing.z * 0.55);
      if (!blocked(p)) spots.push({ pos: p, facing: w.facing });
    }
  }
  // Pick evenly spaced spots, never two side by side.
  const out: StationInfo[] = [];
  const stride = spots.length / wanted.length;
  for (let i = 0; i < wanted.length && spots.length; i++) {
    const s = spots[Math.min(spots.length - 1, Math.floor(i * stride + stride / 2))];
    const f = s.facing;
    // Box: 1.0 wide, 2.0 tall, 0.5 deep, back against the wall.
    const back = { x: s.pos.x - f.x * 0.55, z: s.pos.z - f.z * 0.55 };
    const front = { x: s.pos.x - f.x * 0.05, z: s.pos.z - f.z * 0.05 };
    const side = { x: Math.abs(f.z) * 0.5, z: Math.abs(f.x) * 0.5 };
    const box: AABB = {
      min: v(Math.min(back.x, front.x) - side.x, 0, Math.min(back.z, front.z) - side.z),
      max: v(Math.max(back.x, front.x) + side.x, 2, Math.max(back.z, front.z) + side.z),
    };
    out.push({ i, kind: wanted[i].kind, item: wanted[i].item, pos: v(s.pos.x, 0, s.pos.z), facing: f, box });
  }
  return out;
}

// ---- grid ---------------------------------------------------------------------------------------------------------

const cellIndex = (w: World, x: number, y: number, z: number) => (x * w.gny + y) * w.gnz + z;

function cellRange(w: World, b: AABB): [number, number, number, number, number, number] {
  const cx = (q: number) => Math.min(w.gnx - 1, Math.max(0, Math.floor(q - w.gx0)));
  const cy = (q: number) => Math.min(w.gny - 1, Math.max(0, Math.floor(q)));
  const cz = (q: number) => Math.min(w.gnz - 1, Math.max(0, Math.floor(q - w.gz0)));
  return [cx(b.min.x), cx(b.max.x - 1e-6), cy(b.min.y), cy(b.max.y - 1e-6), cz(b.min.z), cz(b.max.z - 1e-6)];
}

/** Calls `fn` once for every chunk (alive or not) whose grid cells overlap `box`. Return true to stop. */
export function forChunks(w: World, box: AABB, fn: (i: number) => boolean | void) {
  const stamp = ++w.stampN;
  if (stamp > 0xfffffff0) {
    w.stamp.fill(0);
    w.stampN = 1;
  }
  const [x0, x1, y0, y1, z0, z1] = cellRange(w, box);
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) {
        const list = w.cells[cellIndex(w, x, y, z)];
        for (let k = 0; k < list.length; k++) {
          const i = list[k];
          if (w.stamp[i] === w.stampN) continue;
          w.stamp[i] = w.stampN;
          if (fn(i)) return;
        }
      }
}

const overlap = (a: AABB, bmin: Vec3, bmax: Vec3) =>
  a.min.x < bmax.x && a.max.x > bmin.x && a.min.y < bmax.y && a.max.y > bmin.y && a.min.z < bmax.z && a.max.z > bmin.z;

export type Mover = 'player' | 'zombie' | 'nade';

/** The first solid or standing chunk overlapping `box`, or null. */
export function firstBlock(w: World, box: AABB, who: Mover): AABB | null {
  for (const s of w.solids) {
    if (s.kind === 'clip' && who !== 'player') continue;
    if (overlap(box, s.min, s.max)) return s;
  }
  let hit: AABB | null = null;
  forChunks(w, box, (i) => {
    const c = w.chunks[i];
    if (w.alive[i] && overlap(box, c.min, c.max)) {
      hit = c;
      return true;
    }
  });
  return hit;
}

// ---- rays ---------------------------------------------------------------------------------------------------------

export interface RayHit {
  t: number;
  /** Chunk index, or -1 for a solid. */
  chunk: number;
  n: Vec3;
  mat: Mat;
}

/** Entry distance of a ray into a box, or -1. */
export function rayBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3, maxT: number): number {
  let t0 = 0;
  let t1 = maxT;
  for (const a of ['x', 'y', 'z'] as const) {
    const da = d[a];
    if (Math.abs(da) < 1e-9) {
      if (o[a] < min[a] || o[a] > max[a]) return -1;
      continue;
    }
    let ta = (min[a] - o[a]) / da;
    let tb = (max[a] - o[a]) / da;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return -1;
  }
  return t0;
}

function faceNormal(p: Vec3, min: Vec3, max: Vec3): Vec3 {
  const ds = [p.x - min.x, max.x - p.x, p.y - min.y, max.y - p.y, p.z - min.z, max.z - p.z];
  let k = 0;
  for (let i = 1; i < 6; i++) if (ds[i] < ds[k]) k = i;
  return [v(-1, 0, 0), v(1, 0, 0), v(0, -1, 0), v(0, 1, 0), v(0, 0, -1), v(0, 0, 1)][k];
}

const SOLID_MAT: Record<Solid['kind'], Mat> = { floor: 'concrete', ceiling: 'concrete', post: 'concrete', locker: 'metal', bound: 'concrete', clip: 'concrete', sill: 'concrete' };

/** Nearest solid or standing chunk along the ray (clips are ignored: bullets fly through windows). */
export function raycast(w: World, o: Vec3, d: Vec3, maxT: number): RayHit | null {
  let best = maxT;
  let bestChunk = -2;
  let bestMin: Vec3 | null = null;
  let bestMax: Vec3 | null = null;
  let bestMat: Mat = 'concrete';
  for (const s of w.solids) {
    if (s.kind === 'clip') continue;
    const t = rayBox(o, d, s.min, s.max, best);
    if (t >= 0 && t < best) {
      best = t;
      bestChunk = -1;
      bestMin = s.min;
      bestMax = s.max;
      bestMat = SOLID_MAT[s.kind];
    }
  }
  // 3D DDA through the chunk grid.
  const gmin = v(w.gx0, 0, w.gz0);
  const gmax = v(w.gx0 + w.gnx, w.gny, w.gz0 + w.gnz);
  const tEnter = rayBox(o, d, gmin, gmax, best);
  if (tEnter >= 0) {
    const stamp = ++w.stampN;
    const p = v(o.x + d.x * (tEnter + 1e-4), o.y + d.y * (tEnter + 1e-4), o.z + d.z * (tEnter + 1e-4));
    let ix = Math.min(w.gnx - 1, Math.max(0, Math.floor(p.x - w.gx0)));
    let iy = Math.min(w.gny - 1, Math.max(0, Math.floor(p.y)));
    let iz = Math.min(w.gnz - 1, Math.max(0, Math.floor(p.z - w.gz0)));
    const sx = d.x > 0 ? 1 : -1;
    const sy = d.y > 0 ? 1 : -1;
    const sz = d.z > 0 ? 1 : -1;
    const next = (i: number, s: number, base: number, oa: number, da: number) => (Math.abs(da) < 1e-9 ? Infinity : (base + i + (s > 0 ? 1 : 0) - oa) / da);
    let tx = next(ix, sx, w.gx0, o.x, d.x);
    let ty = next(iy, sy, 0, o.y, d.y);
    let tz = next(iz, sz, w.gz0, o.z, d.z);
    const dx = Math.abs(d.x) < 1e-9 ? Infinity : 1 / Math.abs(d.x);
    const dy = Math.abs(d.y) < 1e-9 ? Infinity : 1 / Math.abs(d.y);
    const dz = Math.abs(d.z) < 1e-9 ? Infinity : 1 / Math.abs(d.z);
    let tCell = tEnter;
    for (let guard = 0; guard < 400; guard++) {
      if (tCell > best) break;
      const list = w.cells[cellIndex(w, ix, iy, iz)];
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        if (w.stamp[i] === stamp || !w.alive[i]) continue;
        w.stamp[i] = stamp;
        const c = w.chunks[i];
        const t = rayBox(o, d, c.min, c.max, best);
        if (t >= 0 && t < best) {
          best = t;
          bestChunk = i;
          bestMin = c.min;
          bestMax = c.max;
          bestMat = c.mat;
        }
      }
      if (tx < ty && tx < tz) {
        ix += sx;
        tCell = tx;
        tx += dx;
        if (ix < 0 || ix >= w.gnx) break;
      } else if (ty < tz) {
        iy += sy;
        tCell = ty;
        ty += dy;
        if (iy < 0 || iy >= w.gny) break;
      } else {
        iz += sz;
        tCell = tz;
        tz += dz;
        if (iz < 0 || iz >= w.gnz) break;
      }
    }
  }
  if (bestChunk === -2 || !bestMin || !bestMax) return null;
  const hp = v(o.x + d.x * best, o.y + d.y * best, o.z + d.z * best);
  return { t: best, chunk: bestChunk, n: faceNormal(hp, bestMin, bestMax), mat: bestMat };
}

// ---- destruction --------------------------------------------------------------------------------------------------

/** Applies damage; returns true when the chunk broke. */
export function damageChunk(w: World, i: number, dmg: number): boolean {
  if (!w.alive[i] || w.chunks[i].hard) return false;
  w.hp[i] -= dmg;
  if (w.hp[i] > 0) return false;
  w.alive[i] = 0;
  w.hp[i] = 0;
  return true;
}

/** Kills every standing chunk no longer connected to an anchored one; returns their indices. */
export function collapse(w: World): number[] {
  const n = w.chunks.length;
  const seen = new Uint8Array(n);
  const queue: number[] = [];
  for (let i = 0; i < n; i++)
    if (w.alive[i] && (w.chunks[i].anchored || w.chunks[i].hard)) {
      seen[i] = 1;
      queue.push(i);
    }
  for (let q = 0; q < queue.length; q++) {
    for (const j of w.chunks[queue[q]].nb)
      if (!seen[j] && w.alive[j]) {
        seen[j] = 1;
        queue.push(j);
      }
  }
  const fallen: number[] = [];
  for (let i = 0; i < n; i++)
    if (w.alive[i] && !seen[i]) {
      w.alive[i] = 0;
      w.hp[i] = 0;
      fallen.push(i);
    }
  return fallen;
}

/** Chunks overlapping a sphere, with their distance from the centre. */
export function chunksInSphere(w: World, c: Vec3, r: number, fn: (i: number, d: number) => void) {
  const box = { min: v(c.x - r, c.y - r, c.z - r), max: v(c.x + r, c.y + r, c.z + r) };
  forChunks(w, box, (i) => {
    if (!w.alive[i]) return;
    const ch = w.chunks[i];
    const dx = Math.max(ch.min.x - c.x, 0, c.x - ch.max.x);
    const dy = Math.max(ch.min.y - c.y, 0, c.y - ch.max.y);
    const dz = Math.max(ch.min.z - c.z, 0, c.z - ch.max.z);
    const d = Math.hypot(dx, dy, dz);
    if (d <= r) fn(i, d);
  });
}

export const inside = (w: World, x: number, z: number, margin = 0) =>
  x > w.interior.minX + margin && x < w.interior.maxX - margin && z > w.interior.minZ + margin && z < w.interior.maxZ - margin;

export const chunkCenter = (c: Chunk): Vec3 => v((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2);
