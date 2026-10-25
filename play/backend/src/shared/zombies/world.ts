// The destructible world of a Last Light map, built identically on the server and in the browser from the map id and
// the zones that are open (see maps.ts: the hotel opens its wings by party size).
//
// - Walls and breakable architecture are made of chunks: axis-aligned boxes about 0.5 m across with health. Bullets
//   chip them, grenades and zombies bash them, and chunks no longer connected to the floor or a ceiling collapse
//   (collapse()). Chunk indices are stable and do not depend on the open zones, so the server only sends indices and
//   health values.
// - Solids never break: floor, ceilings, corner posts, brass mullions, lockers, furniture, the mezzanine slabs, the
//   elevator doors, the shutters of closed wings, the boundary. Clips block players and zombies but not bullets or
//   grenades (boarded entrances: zombies get through by tearing the boards and vaulting).
// - A 1 m grid over the whole map indexes the chunks for collision and ray casts.

import type { AABB, Vec3 } from '../math.js';
import { LOCKER_ORDER, type WeaponId } from './weapons.js';
import { FURNITURE_SIZE, type FurnitureDef, type MapDef, type Mat, type OpeningDef, type Side, type StationKind, type WallDef, type ZoneId } from './maps.js';

export const CHUNK = 0.5;
/** Wall thickness of the old rectangle maps; the hotel's walls carry their own (WallDef.thick). */
export const WALL_T = 0.4;
export const YARD = 9;
export const SILL_Y = 1;
export const WINDOW_TOP = 2.5;
/** Entrance width in chunk columns. */
const WINDOW_COLS = 3;
/** Walls use 0.5 m rows up to this height and 1 m rows above (fewer chunks up where nobody fights). */
const FINE_ROWS = 6;

export const MAT_HP: Record<Mat, number> = {
  brick: 110,
  plaster: 70,
  concrete: 240,
  wood: 45,
  metal: 420,
  marble: 200,
  travertine: 150,
  walnut: 60,
  glass: 6,
};

export interface Chunk {
  min: Vec3;
  max: Vec3;
  mat: Mat;
  maxHp: number;
  /** Never breaks (window sills). */
  hard: boolean;
  /** Touches the floor or its ceiling: holds up whatever is connected to it. */
  anchored: boolean;
  /** Face-touching neighbours. */
  nb: number[];
  /** Part of a wall (not a column, desk or bar). */
  wall: boolean;
  /** The wall id (maps.ts WallDef.id) or prop kind ('column', 'desk', 'bar') it belongs to. */
  part: string;
  zone: ZoneId;
}

export type SolidKind =
  | 'floor'
  | 'ceiling'
  | 'post'
  | 'locker'
  | 'bound'
  | 'clip'
  | 'sill'
  | 'mullion'
  | 'shutter'
  | 'elevator'
  | 'mezzanine'
  | 'furniture'
  | 'bars';

export interface Solid extends AABB {
  kind: SolidKind;
  /** Zone the solid belongs to (a shutter: the closed wing behind it). */
  zone?: ZoneId;
}

export interface WindowInfo {
  i: number;
  side: Side;
  /** Wall id it is cut into. */
  wall: string;
  zone: ZoneId;
  /** A doorway from the floor, or a window over a 1 m sill. */
  door: boolean;
  look: 'revolving' | 'glassDoor' | 'serviceDoor' | 'window';
  /** False in a closed wing: no zombies come through and nobody repairs it. */
  active: boolean;
  /** Centre of the opening on the wall's centre plane, at the bottom of the opening (0 for doors, the sill else). */
  center: Vec3;
  /** Top of the opening. */
  top: number;
  /** Unit vector pointing out of the building. */
  out: Vec3;
  /** Where a player stands to repair, and where a zombie stands to tear boards. */
  inside: Vec3;
  outside: Vec3;
  /** Where zombies for this entrance rise from the ground. */
  spawns: Vec3[];
  width: number;
}

export interface StationInfo {
  i: number;
  kind: StationKind;
  item?: WeaponId;
  zone: ZoneId;
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

export interface ZoneInfo {
  id: ZoneId;
  name: string;
  rect: Rect;
  /** Ceiling height. */
  h: number;
  minPlayers: number;
  open: boolean;
  /** The passage between this wing and the atrium (null for the atrium): shutter raised when open, closed when not. */
  passage: AABB | null;
}

export interface FurnitureInfo extends FurnitureDef {
  box: AABB;
}

export interface LampInfo {
  pos: Vec3;
  flicker: number;
  zone: ZoneId;
  kind: 'chandelier' | 'pendant';
}

export interface World {
  def: MapDef;
  zones: ZoneInfo[];
  /** Ids of the open zones. */
  open: ZoneId[];
  /** Floor areas players can be in: open zones plus the passages between them (inside() uses these). */
  areas: Rect[];
  chunks: Chunk[];
  /** 1 while a chunk stands. */
  alive: Uint8Array;
  hp: Float32Array;
  solids: Solid[];
  windows: WindowInfo[];
  stations: StationInfo[];
  furniture: FurnitureInfo[];
  lamps: LampInfo[];
  /** The atrium's floor rectangle (older code treats it as "the room"). */
  interior: Rect;
  bounds: Rect;
  /** Highest ceiling (the atrium). */
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
  /** Solids per 1 m column of the same grid (x, z only), for firstBlock. */
  solidCells: number[][];
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const EPS = 1e-3;

const FACING: Record<Side, Vec3> = { n: v(0, 0, -1), s: v(0, 0, 1), w: v(-1, 0, 0), e: v(1, 0, 0) };

/** Row boundaries from the floor to `h`: 0.5 m up to `fine`, then 1 m. */
function rows(h: number, fine = FINE_ROWS): number[] {
  const out = [0];
  let y = 0;
  while (y < h - EPS) {
    y = Math.min(h, y + (y < fine - EPS ? CHUNK : 1));
    out.push(y);
  }
  return out;
}

const sideOf = (w: WallDef): Side => (w.along === 'x' ? (w.out < 0 ? 'n' : 's') : w.out < 0 ? 'w' : 'e');

/** A box spanning [a0, a1] along the wall, [y0, y1] up and the wall's thickness (plus `pad` either side). */
export function wallBox(w: WallDef, a0: number, a1: number, y0: number, y1: number, pad = 0): AABB {
  const f0 = Math.min(w.fixed, w.fixed + w.out * w.thick) - pad;
  const f1 = Math.max(w.fixed, w.fixed + w.out * w.thick) + pad;
  return w.along === 'x' ? { min: v(a0, y0, f0), max: v(a1, y1, f1) } : { min: v(f0, y0, a0), max: v(f1, y1, a1) };
}

/** Point `along` the wall at distance `off` from its inner face (positive = outwards). */
function wallPoint(w: WallDef, along: number, off: number): Vec3 {
  const f = w.fixed + w.out * off;
  return w.along === 'x' ? v(along, 0, f) : v(f, 0, along);
}

// ---- building -------------------------------------------------------------------------------------------------

/** Builds the world with the given zones open (default: every zone, for labs and tools). The atrium is always open. */
export function buildWorld(def: MapDef, openZones?: readonly ZoneId[]): World {
  const open = new Set<ZoneId>(openZones ?? def.zones.map((z) => z.id));
  open.add('atrium');
  const zoneH = (id: ZoneId) => def.zones.find((z) => z.id === id)?.h ?? def.h;
  const chunks: Chunk[] = [];
  const solids: Solid[] = [];
  const windows: WindowInfo[] = [];
  const add = (min: Vec3, max: Vec3, mat: Mat, part: string, zone: ZoneId, ceil: number, wall = false, hard = false) => {
    chunks.push({ min, max, mat, maxHp: hard ? Infinity : MAT_HP[mat], hard, anchored: min.y <= EPS || max.y >= ceil - EPS, nb: [], wall, part, zone });
  };

  // Walls, with their openings and entrances.
  for (const w of def.walls) {
    const ops = def.openings.filter((o) => o.wall === w.id);
    const start = w.a0;
    const cols = Math.round((w.a1 - w.a0) / CHUNK);
    // Entrance columns: the column whose centre is `at`, and one either side.
    const entCols = new Map<number, number>();
    for (const e of def.entrances) {
      if (e.wall !== w.id) continue;
      const k = Math.round((e.at - start) / CHUNK - 0.5);
      const wi = windows.length;
      for (let c = k - 1; c <= k + 1; c++) entCols.set(c, wi);
      const along = start + (k + 0.5) * CHUNK;
      const center = wallPoint(w, along, w.thick / 2);
      center.y = e.door ? 0 : SILL_Y;
      windows.push({
        i: wi,
        side: sideOf(w),
        wall: w.id,
        zone: e.zone,
        door: e.door,
        look: e.look,
        active: open.has(e.zone),
        center,
        top: WINDOW_TOP,
        out: FACING[sideOf(w)],
        inside: wallPoint(w, along, -0.7),
        outside: wallPoint(w, along, w.thick + 0.65),
        spawns: [-2.2, 0, 2.2].map((lat, j) => wallPoint(w, along + lat, w.thick + 4.5 + j * 0.8)),
        width: WINDOW_COLS * CHUNK,
      });
      // Nobody walks through a boarded entrance; zombies vault (the server moves them through).
      const a0 = start + (k - 1) * CHUNK;
      const a1 = start + (k + 2) * CHUNK;
      solids.push({ kind: 'clip', zone: e.zone, ...wallBox(w, a0, a1, e.door ? 0 : SILL_Y, w.h, 0.05) });
    }
    const ys = rows(w.h, w.mat === 'glass' ? 3 : FINE_ROWS);
    for (let c = 0; c < cols; c++) {
      const a0 = start + c * CHUNK;
      const a1 = a0 + CHUNK;
      const mid = (a0 + a1) / 2;
      const ent = entCols.get(c);
      const door = ent !== undefined && windows[ent].door;
      const gap = ops.find((o) => mid > o.a0 && mid < o.a1);
      for (let r = 0; r + 1 < ys.length; r++) {
        const y0 = ys[r];
        const y1 = ys[r + 1];
        if (gap && y1 <= gap.y1 + EPS) continue;
        let hard = false;
        if (ent !== undefined) {
          if (door && y1 <= WINDOW_TOP + EPS) continue;
          if (!door && y0 >= SILL_Y - EPS && y1 <= WINDOW_TOP + EPS) continue;
          if (!door && y1 <= SILL_Y + EPS) hard = true;
        }
        const b = wallBox(w, a0, a1, y0, y1);
        add(b.min, b.max, hard && w.mat === 'glass' ? 'marble' : w.mat, w.id, w.zone, w.h, true, hard);
      }
    }
    for (const o of ops) fillOpening(w, o, open, solids);
  }

  for (const [x0, x1, z0, z1, h] of def.posts) solids.push({ kind: 'post', min: v(x0, 0, z0), max: v(x1, h, z1) });
  for (const b of barRuns(def)) solids.push({ kind: 'bars', ...b });
  for (const m of def.walls.filter((w) => w.id === def.mullions.wall)) {
    for (const at of def.mullions.at) {
      // Mullions stand a little proud of the glass on the inside.
      const b = wallBox(m, at - 0.1, at + 0.1, 0, m.h, 0.08);
      solids.push({ kind: 'mullion', ...b });
    }
  }

  // Breakable architecture.
  for (const p of def.props) {
    const ceil = zoneH(p.zone);
    if (p.kind === 'column') {
      const n = p.n ?? 1.2;
      const k = Math.max(1, Math.round(n / 0.6));
      const s = n / k;
      const ys = rows(ceil);
      for (let i = 0; i < k; i++)
        for (let j = 0; j < k; j++)
          for (let r = 0; r + 1 < ys.length; r++) {
            const x0 = p.x - n / 2 + i * s;
            const z0 = p.z - n / 2 + j * s;
            add(v(x0, ys[r], z0), v(x0 + s, ys[r + 1], z0 + s), 'travertine', 'column', p.zone, ceil, false, true);
          }
    } else {
      // Reception desk / bar counter: a walnut body on the floor under a marble top slab, 1 m deep.
      const len = p.n ?? 6;
      const cols = Math.round(len / CHUNK);
      for (let i = 0; i < cols; i++)
        for (let j = 0; j < 2; j++) {
          const a = -len / 2 + i * CHUNK;
          const d = -0.5 + j * CHUNK;
          const x0 = p.r === 1 ? p.x + d : p.x + a;
          const z0 = p.r === 1 ? p.z + a : p.z + d;
          add(v(x0, 0, z0), v(x0 + CHUNK, 0.5, z0 + CHUNK), 'walnut', p.kind, p.zone, ceil);
          add(v(x0, 0.5, z0), v(x0 + CHUNK, 1.0, z0 + CHUNK), 'walnut', p.kind, p.zone, ceil);
          add(v(x0, 1.0, z0), v(x0 + CHUNK, 1.1, z0 + CHUNK), 'marble', p.kind, p.zone, ceil);
        }
    }
  }

  // Floor, ceilings, mezzanines, the boundary.
  const ext = extents(def);
  const bounds: Rect = { minX: ext.minX - YARD, maxX: ext.maxX + YARD, minZ: ext.minZ - YARD, maxZ: ext.maxZ + YARD };
  solids.push({ kind: 'floor', min: v(bounds.minX - 1, -1, bounds.minZ - 1), max: v(bounds.maxX + 1, 0, bounds.maxZ + 1) });
  for (const z of def.zones) {
    const r = { ...z.rect };
    for (const w of def.walls.filter((x) => x.zone === z.id)) {
      const b = wallBox(w, w.a0, w.a1, 0, 1);
      r.minX = Math.min(r.minX, b.min.x);
      r.maxX = Math.max(r.maxX, b.max.x);
      r.minZ = Math.min(r.minZ, b.min.z);
      r.maxZ = Math.max(r.maxZ, b.max.z);
    }
    solids.push({ kind: 'ceiling', zone: z.id, min: v(r.minX, z.h, r.minZ), max: v(r.maxX, z.h + 0.35, r.maxZ) });
  }
  for (const m of def.mezzanine) {
    const w = def.walls.find((x) => x.id === m.wall);
    if (!w) continue;
    // From the wall's inner face, `depth` metres into the room, along the whole wall.
    const lo = w.out > 0 ? w.fixed - m.depth : w.fixed;
    const hi = w.out > 0 ? w.fixed : w.fixed + m.depth;
    solids.push(
      w.along === 'z'
        ? { kind: 'mezzanine', zone: w.zone, min: v(lo, m.y, w.a0), max: v(hi, m.y + 0.35, w.a1) }
        : { kind: 'mezzanine', zone: w.zone, min: v(w.a0, m.y, lo), max: v(w.a1, m.y + 0.35, hi) },
    );
  }
  const B = 1;
  solids.push({ kind: 'bound', min: v(bounds.minX - B, 0, bounds.minZ - B), max: v(bounds.minX, 14, bounds.maxZ + B) });
  solids.push({ kind: 'bound', min: v(bounds.maxX, 0, bounds.minZ - B), max: v(bounds.maxX + B, 14, bounds.maxZ + B) });
  solids.push({ kind: 'bound', min: v(bounds.minX, 0, bounds.minZ - B), max: v(bounds.maxX, 14, bounds.minZ) });
  solids.push({ kind: 'bound', min: v(bounds.minX, 0, bounds.maxZ), max: v(bounds.maxX, 14, bounds.maxZ + B) });

  const furniture = def.furniture.map((f) => ({ ...f, box: furnitureBox(f) }));
  for (const f of furniture) solids.push({ kind: 'furniture', zone: f.zone, min: f.box.min, max: f.box.max });

  const stations = placeStations(def, open);
  for (const st of stations) solids.push({ kind: 'locker', zone: st.zone, min: st.box.min, max: st.box.max });

  const zones: ZoneInfo[] = def.zones.map((z) => ({
    id: z.id,
    name: z.name,
    rect: { ...z.rect },
    h: z.h,
    minPlayers: z.minPlayers,
    open: open.has(z.id),
    passage: passageBox(def, z.id),
  }));
  const areas: Rect[] = [];
  for (const z of zones) {
    if (!z.open) continue;
    areas.push(z.rect);
    if (z.passage) areas.push({ minX: z.passage.min.x, maxX: z.passage.max.x, minZ: z.passage.min.z, maxZ: z.passage.max.z });
  }

  const lamps: LampInfo[] = def.lamps.map((l) => ({
    pos: v(l.x, l.y ?? zoneH(l.zone ?? 'atrium') - 0.95, l.z),
    flicker: l.flicker ?? 0,
    zone: l.zone ?? 'atrium',
    kind: l.kind ?? 'pendant',
  }));

  const height = Math.max(...def.zones.map((z) => z.h));
  const atrium = def.zones.find((z) => z.id === 'atrium')?.rect;
  const world: World = {
    def,
    zones,
    open: [...open],
    areas,
    chunks,
    alive: new Uint8Array(chunks.length).fill(1),
    hp: Float32Array.from(chunks, (c) => (c.hard ? 1e9 : c.maxHp)),
    solids,
    windows,
    stations,
    furniture,
    lamps,
    interior: atrium ? { ...atrium } : { minX: -def.w / 2, maxX: def.w / 2, minZ: -def.d / 2, maxZ: def.d / 2 },
    bounds,
    height,
    spawns: def.spawns.map((s) => v(s.x, 0, s.z)),
    gx0: bounds.minX,
    gz0: bounds.minZ,
    gnx: Math.ceil(bounds.maxX - bounds.minX),
    gny: Math.ceil(height + 1),
    gnz: Math.ceil(bounds.maxZ - bounds.minZ),
    cells: [],
    stamp: new Uint32Array(chunks.length),
    stampN: 0,
    solidCells: [],
  };
  world.cells = Array.from({ length: world.gnx * world.gny * world.gnz }, () => []);
  world.solidCells = Array.from({ length: world.gnx * world.gnz }, () => []);
  solids.forEach((sd, i) => {
    const [x0, x1, , , z0, z1] = cellRange(world, sd);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) world.solidCells[x * world.gnz + z].push(i);
  });
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
      const pos = (ox > 0.04 ? 1 : 0) + (oy > 0.04 ? 1 : 0) + (oz > 0.04 ? 1 : 0);
      if (pos >= 2) c.nb.push(j);
    });
  });
  return world;
}

/** Passages get a shutter while their wing is closed; elevator alcoves are always filled with the doors. */
function fillOpening(w: WallDef, o: OpeningDef, open: Set<ZoneId>, solids: Solid[]) {
  if (o.kind === 'passage' && o.zone && open.has(o.zone)) return;
  solids.push({ kind: o.kind === 'passage' ? 'shutter' : 'elevator', zone: o.zone ?? w.zone, ...wallBox(w, o.a0, o.a1, 0, o.y1) });
}

function passageBox(def: MapDef, zone: ZoneId): AABB | null {
  const o = def.openings.find((x) => x.kind === 'passage' && x.zone === zone);
  const w = o && def.walls.find((x) => x.id === o.wall);
  return o && w ? wallBox(w, o.a0, o.a1, 0, o.y1) : null;
}

/** Outer bounds of all walls, snapped outwards to the 0.5 m grid so nav cells line up with them. */
function extents(def: MapDef): Rect {
  const r: Rect = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const w of def.walls) {
    const b = wallBox(w, w.a0, w.a1, 0, 1);
    r.minX = Math.min(r.minX, b.min.x);
    r.maxX = Math.max(r.maxX, b.max.x);
    r.minZ = Math.min(r.minZ, b.min.z);
    r.maxZ = Math.max(r.maxZ, b.max.z);
  }
  r.minX = Math.floor(r.minX * 2) / 2;
  r.minZ = Math.floor(r.minZ * 2) / 2;
  r.maxX = Math.ceil(r.maxX * 2) / 2;
  r.maxZ = Math.ceil(r.maxZ * 2) / 2;
  return r;
}

/** Axis-aligned bounds of a piece of furniture's rotated footprint. */
export function furnitureBox(f: FurnitureDef): AABB {
  const s = FURNITURE_SIZE[f.kind];
  const c = Math.abs(Math.cos(f.yaw));
  const sn = Math.abs(Math.sin(f.yaw));
  const hx = (s.w * c + s.d * sn) / 2;
  const hz = (s.w * sn + s.d * c) / 2;
  return { min: v(f.x - hx, 0, f.z - hz), max: v(f.x + hx, s.h, f.z + hz) };
}

/** Lockers stand against the walls at the map's spots; an open wing takes its share of the expensive guns. */
function placeStations(def: MapDef, open: Set<ZoneId>): StationInfo[] {
  const rest: { kind: StationKind; item?: WeaponId }[] = [
    ...LOCKER_ORDER.map((item) => ({ kind: 'weapon' as const, item })),
    { kind: 'ammo' },
    { kind: 'nades' },
    { kind: 'armor' },
  ];
  const assigned: { spot: MapDef['stations'][number]; item: { kind: StationKind; item?: WeaponId } }[] = [];
  for (const zone of ['lounge', 'restaurant'] as ZoneId[]) {
    const items = def.wingItems[zone];
    if (!items || !open.has(zone)) continue;
    const spots = def.stations.filter((s) => s.zone === zone);
    items.forEach((id, k) => {
      const at = rest.findIndex((x) => x.item === id);
      if (at < 0 || !spots[k]) return;
      assigned.push({ spot: spots[k], item: rest[at] });
      rest.splice(at, 1);
    });
  }
  const atrium = def.stations.filter((s) => s.zone === 'atrium');
  rest.forEach((item, k) => {
    if (atrium[k]) assigned.push({ spot: atrium[k], item });
  });
  const stations: StationInfo[] = assigned.map(({ spot, item }, i) => {
    const f = FACING[spot.facing];
    // Box: 1.0 wide, 2.0 tall, 0.5 deep, back against the wall (the spot is 0.05 m in front of the box).
    const back = { x: spot.x - f.x * 0.55, z: spot.z - f.z * 0.55 };
    const front = { x: spot.x - f.x * 0.05, z: spot.z - f.z * 0.05 };
    const side = { x: Math.abs(f.z) * 0.5, z: Math.abs(f.x) * 0.5 };
    const box: AABB = {
      min: v(Math.min(back.x, front.x) - side.x, 0, Math.min(back.z, front.z) - side.z),
      max: v(Math.max(back.x, front.x) + side.x, 2, Math.max(back.z, front.z) + side.z),
    };
    return { i, kind: item.kind, item: item.item, zone: spot.zone, pos: v(spot.x, 0, spot.z), facing: f, box };
  });
  // The ammo crate stands free in the lobby: a 1.0 x 0.7 x 0.6 m box you can walk up to from any side.
  if (def.ammoCrate) {
    const { x, z } = def.ammoCrate;
    stations.push({ i: stations.length, kind: 'crate', zone: 'atrium', pos: v(x, 0, z), facing: v(0, 0, 1), box: { min: v(x - 0.5, 0, z - 0.3), max: v(x + 0.5, 0.7, z + 0.3) } });
  }
  return stations;
}

/** Height of the brass security bars outside every exterior wall on the ground floor. */
export const BARS_H = 4;
export const BARS_T = 0.12;

/**
 * Brass bars just outside every exterior wall on the ground floor, with gaps only at the entrances: whatever gets
 * blasted out of a wall or a pane of the facade, nobody gets outside and zombies only come in through the entrances.
 * A stretch of wall counts as exterior where the point just beyond its outer face is in no zone (open or closed).
 */
export function barRuns(def: MapDef): AABB[] {
  const inZone = (x: number, z: number) => def.zones.some((zn) => x > zn.rect.minX && x < zn.rect.maxX && z > zn.rect.minZ && z < zn.rect.maxZ);
  const out: AABB[] = [];
  for (const w of def.walls) {
    const gaps = def.entrances.filter((e) => e.wall === w.id).map((e) => [e.at - 0.9, e.at + 0.9] as const);
    const f0 = w.fixed + w.out * w.thick;
    const f1 = f0 + w.out * BARS_T;
    let run0: number | null = null;
    const flush = (end: number) => {
      if (run0 !== null && end - run0 > 0.05) {
        const lo = Math.min(f0, f1);
        const hi = Math.max(f0, f1);
        const h = Math.min(BARS_H, w.h);
        out.push(w.along === 'x' ? { min: v(run0, 0, lo), max: v(end, h, hi) } : { min: v(lo, 0, run0), max: v(hi, h, end) });
      }
      run0 = null;
    };
    for (let a = w.a0; a < w.a1 - EPS; a += CHUNK) {
      const mid = a + CHUNK / 2;
      const p = wallPoint(w, mid, w.thick + 0.6);
      const exterior = !inZone(p.x, p.z) && !gaps.some(([g0, g1]) => mid > g0 && mid < g1);
      if (exterior) run0 ??= a;
      else flush(a);
    }
    flush(w.a1);
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
  const [x0, x1, , , z0, z1] = cellRange(w, box);
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++) {
      const list = w.solidCells[x * w.gnz + z];
      for (let k = 0; k < list.length; k++) {
        const s = w.solids[list[k]];
        if (s.kind === 'clip' && who === 'nade') continue;
        if (overlap(box, s.min, s.max)) return s;
      }
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

const SOLID_MAT: Record<SolidKind, Mat> = {
  floor: 'marble',
  ceiling: 'plaster',
  post: 'travertine',
  locker: 'metal',
  bound: 'concrete',
  clip: 'concrete',
  sill: 'concrete',
  mullion: 'metal',
  bars: 'metal',
  shutter: 'metal',
  elevator: 'metal',
  mezzanine: 'marble',
  furniture: 'wood',
};

/** Nearest solid or standing chunk along the ray (clips are ignored: bullets fly through windows). */
export function raycast(w: World, o: Vec3, d: Vec3, maxT: number): RayHit | null {
  let best = maxT;
  let bestChunk = -2;
  let bestMin: Vec3 | null = null;
  let bestMax: Vec3 | null = null;
  let bestMat: Mat = 'concrete';
  for (const s of w.solids) {
    // Bullets fly through windows (clips) and between the bars.
    if (s.kind === 'clip' || s.kind === 'bars') continue;
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

/** Inside the building: in an open zone or a passage between two. */
export const inside = (w: World, x: number, z: number, margin = 0) =>
  w.areas.some((a) => x > a.minX + margin && x < a.maxX - margin && z > a.minZ + margin && z < a.maxZ - margin);

export const chunkCenter = (c: Chunk): Vec3 => v((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2);
