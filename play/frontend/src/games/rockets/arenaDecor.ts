// Decoration for the Rockets arenas: per-map themes, hazard stripes and a glow fence on every edge you can fall off,
// and non-colliding props (lamps, pipes, banners, battlements, antennas, chimneys, billboards, rocks under floating
// islands, lava). Props stay on or behind the outer walls and under the islands, never on a walkable surface, so
// nothing you can see but not touch gets in the way of a fight. Everything lands in a few vertex-coloured buckets
// that the arena merges into single meshes.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BoxKind, MapBox, MapData } from '@shared/rockets/map';
import { TEX_SIZE, type TexKey, mulberry } from './arenaTextures';

export type Visible = Exclude<BoxKind, 'clip'>;
type Prop = 'lamps' | 'pipes' | 'banners' | 'crenels' | 'antennas' | 'chimneys' | 'billboards';
export type Skyline = 'industry' | 'islands' | 'mesas' | 'pyramids' | 'spires' | 'castles' | 'volcanoes' | 'hills' | 'city' | 'none';

export interface Surface {
  top: TexKey;
  side: TexKey;
}

export interface Theme {
  surfaces: Partial<Record<Visible, Surface>>;
  props: Prop[];
  skyline: Skyline;
  /** What hangs under floating islands. */
  under?: 'rocks' | 'thrusters';
  lava?: boolean;
  stars?: number;
  planet?: boolean;
}

const s = (top: TexKey, side: TexKey = top): Surface => ({ top, side });

/** Default surface per kind; themes override a few. */
export const BASE_SURFACES: Record<Visible, Surface> = {
  floor: s('tiles', 'strata'),
  wall: s('stone', 'bricks'),
  platform: s('metal'),
  stair: s('metal', 'panels'),
  pillar: s('metal', 'ribs'),
  crate: s('crate'),
  ledge: s('metal', 'panels'),
  tower: s('metal', 'panels'),
};

const THEMES: Record<string, Theme> = {
  foundry: { surfaces: {}, props: ['pipes', 'lamps', 'banners', 'antennas', 'chimneys'], skyline: 'industry' },
  skyway: { surfaces: { floor: s('turf', 'strata'), platform: s('planks'), stair: s('planks') }, props: [], skyline: 'islands', under: 'rocks' },
  canyon: {
    surfaces: { floor: s('turf', 'strata'), ledge: s('stone', 'strata'), wall: s('stone', 'strata'), tower: s('stone', 'strata'), platform: s('planks'), stair: s('stone') },
    props: ['lamps', 'banners'],
    skyline: 'mesas',
  },
  ziggurat: { surfaces: { platform: s('stone'), stair: s('stone'), ledge: s('stone'), wall: s('stone') }, props: ['crenels', 'banners'], skyline: 'pyramids' },
  spires: { surfaces: {}, props: ['antennas', 'lamps', 'banners'], skyline: 'spires' },
  fortress: { surfaces: { floor: s('turf', 'strata'), ledge: s('stone'), tower: s('stone'), wall: s('stone'), stair: s('stone') }, props: ['crenels', 'banners', 'lamps'], skyline: 'castles' },
  pit: { surfaces: { floor: s('stone', 'strata'), wall: s('stone'), stair: s('stone') }, props: ['pipes', 'lamps', 'antennas'], skyline: 'volcanoes', lava: true },
  twin: { surfaces: {}, props: ['banners', 'lamps', 'antennas'], skyline: 'hills' },
  downtown: { surfaces: { tower: s('metal', 'windows'), wall: s('stone', 'bricks') }, props: ['billboards', 'antennas', 'lamps'], skyline: 'city', stars: 160 },
  orbit: { surfaces: { platform: s('metal', 'panels') }, props: [], skyline: 'none', under: 'thrusters', stars: 520, planet: true },
};

export const themeOf = (map: MapData): Theme => THEMES[map.id] ?? { surfaces: {}, props: ['lamps', 'banners'], skyline: 'hills' };

/** Collects geometries with a baked vertex colour (and alpha) so a whole family of props merges into one mesh. */
export class Bucket {
  private parts: THREE.BufferGeometry[] = [];
  private readonly col = new THREE.Color();

  /** Adds `geo` (consumed) in `color`; `alpha` may vary with the vertex position. */
  add(geo: THREE.BufferGeometry, color: number | THREE.Color, alpha: number | ((x: number, y: number, z: number) => number) = 1) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    const pos = g.attributes.position as THREE.BufferAttribute;
    const c = this.col.set(color);
    const data = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      data.set([c.r, c.g, c.b, typeof alpha === 'number' ? alpha : alpha(pos.getX(i), pos.getY(i), pos.getZ(i))], i * 4);
    }
    g.setAttribute('color', new THREE.BufferAttribute(data, 4));
    this.parts.push(g);
    return this;
  }

  get size() {
    return this.parts.length;
  }

  /** The merged geometry (or null when empty); the parts are disposed. */
  build(): THREE.BufferGeometry | null {
    if (!this.parts.length) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const g of this.parts) g.dispose();
    this.parts = [];
    return merged;
  }
}

/** Moves a geometry into place: rotate around Y, then translate. */
export function at<G extends THREE.BufferGeometry>(geo: G, x: number, y: number, z: number, rotY = 0): G {
  if (rotY) geo.rotateY(rotY);
  geo.translate(x, y, z);
  return geo;
}

const shade = (color: number, k: number) => new THREE.Color(color).multiplyScalar(k);

// ---- edges you can fall off --------------------------------------------------------------------------------------

const inside = (b: MapBox, x: number, z: number) => x > b.min.x && x < b.max.x && z > b.min.z && z < b.max.z;

/** True when something stops a player who steps off a surface at height `top` at (x, z): a floor below or a wall. */
function supported(boxes: MapBox[], self: MapBox, x: number, z: number, top: number) {
  for (const o of boxes) if (o !== self && inside(o, x, z) && o.min.y <= top + 0.5) return true;
  return false;
}

/** True when another box sits on this surface at (x, z), hiding it. */
function covered(boxes: MapBox[], self: MapBox, x: number, z: number, top: number) {
  for (const o of boxes) if (o !== self && inside(o, x, z) && o.min.y <= top + 0.05 && o.max.y > top + 0.05) return true;
  return false;
}

export interface Hazards {
  /** Yellow and black stripes along each drop, with uvs for the hazard texture. */
  stripes: THREE.BufferGeometry | null;
}

/**
 * Finds every stretch of surface edge with nothing below it (the void, or the pit) and draws a hazard stripe on the
 * top and the side there, plus a short glowing fence rising from it into `glow` so drops read from across the map.
 */
export function edgeHazards(map: MapData, glow: Bucket): Hazards {
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], u0: number, u1: number, v0: number, v1: number) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
    for (let i = 0; i < 6; i++) nor.push(...n);
  };
  const fence = 0.75;
  const fenceColor = 0xff5a3a;
  const tile = TEX_SIZE.hazard;
  for (const b of map.boxes) {
    if (b.kind === 'clip') continue;
    const top = b.max.y;
    const sx = b.max.x - b.min.x;
    const sz = b.max.z - b.min.z;
    // Each edge: fixed coordinate, outward sign, and whether it runs along x.
    const edges: [number, number, boolean][] = [
      [b.max.x, 1, false],
      [b.min.x, -1, false],
      [b.max.z, 1, true],
      [b.min.z, -1, true],
    ];
    for (const [fixed, out, alongX] of edges) {
      const a0 = alongX ? b.min.x : b.min.z;
      const a1 = alongX ? b.max.x : b.max.z;
      const len = a1 - a0;
      const n = Math.max(1, Math.ceil(len / 0.75));
      const step = len / n;
      const width = Math.min(0.45, (alongX ? sz : sx) * 0.3);
      const at2 = (a: number, off: number): [number, number] => (alongX ? [a, fixed + out * off] : [fixed + out * off, a]);
      let runStart = -1;
      for (let i = 0; i <= n; i++) {
        let open = false;
        if (i < n) {
          const mid = a0 + (i + 0.5) * step;
          const [ox, oz] = at2(mid, 0.3);
          const [ix, iz] = at2(mid, -0.2);
          open = !supported(map.boxes, b, ox, oz, top) && !covered(map.boxes, b, ix, iz, top);
        }
        if (open && runStart < 0) runStart = i;
        if (!open && runStart >= 0) {
          const s0 = a0 + runStart * step;
          const s1 = a0 + i * step;
          runStart = -1;
          const p = (a: number, off: number, y: number) => {
            const [x, z] = at2(a, off);
            return [x, y, z];
          };
          const nOut = alongX ? [0, 0, out] : [out, 0, 0];
          // Top strip, then the band down the side face, both a hair off the surface.
          quad(p(s0, 0, top + 0.012), p(s1, 0, top + 0.012), p(s1, -width, top + 0.012), p(s0, -width, top + 0.012), [0, 1, 0], s0 / tile, s1 / tile, 0, width / tile);
          const band = Math.min(0.35, (b.max.y - b.min.y) * 0.6);
          quad(p(s0, 0.012, top), p(s1, 0.012, top), p(s1, 0.012, top - band), p(s0, 0.012, top - band), nOut, s0 / tile, s1 / tile, 0, band / tile);
          // The fence: an open strip that fades upward.
          const [x0, z0] = at2(s0, 0.02);
          const [x1, z1] = at2(s1, 0.02);
          const fenceGeo = new THREE.PlaneGeometry(Math.hypot(x1 - x0, z1 - z0), fence);
          fenceGeo.translate(0, fence / 2, 0);
          at(fenceGeo, (x0 + x1) / 2, top, (z0 + z1) / 2, alongX ? 0 : Math.PI / 2);
          glow.add(fenceGeo, fenceColor, (_x, y) => (y < top + 0.01 ? 0.55 : 0));
        }
      }
    }
  }
  if (!pos.length) return { stripes: null };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return { stripes: g };
}

// ---- props -------------------------------------------------------------------------------------------------------

export interface PropBuckets {
  /** Toon-lit props. */
  solid: Bucket;
  /** Unlit glowing bits: lamp heads, antenna tips, billboard faces, lava. */
  glow: Bucket;
  /** Additive fades (the hazard fences). */
  fade: Bucket;
}

const cyl = (r: number, h: number, seg = 8) => new THREE.CylinderGeometry(r, r, h, seg);
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);

/**
 * Walks the top of the outer wall, calling `fn` every `spacing` metres with the wall-top centre, the inward normal
 * and the yaw that faces inward. Skips the ends so corners stay free for antennas.
 */
function alongWalls(half: number, spacing: number, fn: (x: number, z: number, nx: number, nz: number, yaw: number, t: number) => void) {
  const n = Math.max(1, Math.round((half * 2) / spacing));
  for (let side = 0; side < 4; side++) {
    for (let i = 0; i < n; i++) {
      const t = -half + ((i + 0.5) / n) * half * 2;
      const e = half + 0.5;
      const [x, z, nx, nz] = side === 0 ? [t, -e, 0, 1] : side === 1 ? [e, t, -1, 0] : side === 2 ? [-t, e, 0, -1] : [-e, -t, 1, 0];
      fn(x, z, nx, nz, Math.atan2(nx, nz), t);
    }
  }
}

/** Builds the theme's props into the buckets. */
export function buildProps(map: MapData, theme: Theme, out: PropBuckets) {
  const { solid, glow } = out;
  const rand = mulberry(map.id.length * 131 + map.half * 7);
  const accent = map.accent ?? 0x3ee0b0;
  const walls = map.boxes.filter((b) => b.kind === 'wall');
  const wallTop = walls.length ? Math.max(...walls.map((b) => b.max.y)) : 0;
  const half = map.half;
  const wallColor = map.tint?.wall ?? 0x7d93c4;
  const dark = 0x3a3848;
  const has = (p: Prop) => theme.props.includes(p) && wallTop > 0;

  if (has('crenels')) {
    alongWalls(half, 2, (x, z, nx, nz, yaw) => {
      solid.add(at(box(1.1, 1.2, 1), x, wallTop + 0.6, z, yaw), shade(wallColor, 1.06));
      void nx;
      void nz;
    });
  }

  if (has('pipes')) {
    for (let side = 0; side < 4; side++) {
      const yaw = (side * Math.PI) / 2;
      const len = half * 2 + 2;
      const run = (r: number, off: number, color: number) => {
        const g = cyl(r, len, 8);
        g.rotateZ(Math.PI / 2);
        // Built along +x at z = -(half + 0.5) + off, then turned to each side.
        g.translate(0, wallTop + r + 0.02, -(half + 0.5) + off);
        solid.add(g.rotateY(yaw), color);
        for (let x = -half; x <= half; x += 4) {
          const f = cyl(r + 0.08, 0.16, 8);
          f.rotateZ(Math.PI / 2);
          f.translate(x, wallTop + r + 0.02, -(half + 0.5) + off);
          solid.add(f.rotateY(yaw), dark);
        }
      };
      run(0.28, 0.22, accent);
      run(0.18, -0.25, 0x9aa0ac);
    }
  }

  if (has('lamps')) {
    alongWalls(half, 12, (x, z, nx, nz, yaw) => {
      const y = wallTop + (has('crenels') ? 1.2 : 0);
      solid.add(at(cyl(0.09, 2.4, 6), x, y + 1.2, z), dark);
      solid.add(at(box(0.08, 0.08, 0.9), x + nx * 0.4, y + 2.4, z + nz * 0.4, yaw), dark);
      solid.add(at(box(0.5, 0.22, 0.34), x + nx * 0.85, y + 2.36, z + nz * 0.85, yaw), dark);
      glow.add(at(box(0.4, 0.06, 0.26), x + nx * 0.85, y + 2.23, z + nz * 0.85, yaw), 0xfff1b8);
    });
  }

  if (has('banners')) {
    const h = Math.min(3.4, wallTop * 0.4);
    const bottom = wallTop - 0.3 - h;
    const blocked = (x: number, z: number) =>
      map.boxes.some((b) => b.kind !== 'clip' && b.kind !== 'wall' && b.max.y > bottom - 0.2 && x > b.min.x - 1.2 && x < b.max.x + 1.2 && z > b.min.z - 1.2 && z < b.max.z + 1.2);
    alongWalls(half, half * 0.66, (x, z, nx, nz, yaw) => {
      const fx = x + nx * 0.53;
      const fz = z + nz * 0.53;
      if (blocked(fx + nx, fz + nz)) return;
      solid.add(at(cyl(0.06, 2.2, 6).rotateZ(Math.PI / 2), fx + nx * 0.06, wallTop - 0.25, fz + nz * 0.06, yaw), dark);
      solid.add(at(box(1.8, h, 0.04), fx, bottom + h / 2, fz, yaw), accent);
      solid.add(at(box(1.8, 0.32, 0.05), fx, bottom + h * 0.72, fz, yaw), 0xffffff);
      solid.add(at(cyl(0.42, 0.06, 12).rotateX(Math.PI / 2), fx + nx * 0.02, bottom + h * 0.4, fz + nz * 0.02, yaw), 0xffffff);
      solid.add(at(cyl(0.22, 0.07, 12).rotateX(Math.PI / 2), fx + nx * 0.03, bottom + h * 0.4, fz + nz * 0.03, yaw), dark);
    });
  }

  if (has('antennas')) {
    for (const [cx, cz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const x = cx * (half + 0.5);
      const z = cz * (half + 0.5);
      const h = 7 + rand() * 4;
      solid.add(at(cyl(0.14, h, 6), x, wallTop + h / 2, z), dark);
      for (let y = 1.5; y < h - 1; y += 1.6) solid.add(at(box(1.2 - y / (h * 1.4), 0.08, 0.08), x, wallTop + y, z, Math.PI / 4), dark);
      glow.add(at(new THREE.IcosahedronGeometry(0.28, 0), x, wallTop + h + 0.1, z), 0xff4a3a);
    }
  }

  if (has('chimneys')) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      const d = half + 9 + rand() * 9;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      const h = 20 + rand() * 10;
      const r = 1.4 + rand() * 0.8;
      solid.add(at(new THREE.CylinderGeometry(r * 0.8, r, h, 10), x, h / 2, z), 0xb8603a);
      solid.add(at(cyl(r * 0.84, 1.2, 10), x, h * 0.78, z), 0xffffff);
      solid.add(at(cyl(r * 0.86, 0.8, 10), x, h - 0.4, z), dark);
      for (let p = 0; p < 3; p++) {
        const puff = new THREE.IcosahedronGeometry(r * (1.2 + p * 0.5), 1);
        solid.add(at(puff, x + p * r * 0.9, h + r + p * r * 1.4, z + p * 0.6), 0xe4e2ec);
      }
    }
  }

  if (has('billboards')) {
    alongWalls(half, half * 0.5, (x, z, nx, nz, yaw, t) => {
      if (Math.abs(t) < half * 0.3) return;
      const y = wallTop + 1.6;
      solid.add(at(box(0.25, 1.6, 0.25), x - nz * 2.5, wallTop + 0.8, z + nx * 2.5), dark);
      solid.add(at(box(0.25, 1.6, 0.25), x + nz * 2.5, wallTop + 0.8, z - nx * 2.5), dark);
      solid.add(at(box(7.2, 3.4, 0.35), x, y + 1.7, z, yaw), dark);
      const face = rand() < 0.5 ? accent : 0xff6ab0;
      glow.add(at(box(6.6, 2.8, 0.05), x + nx * 0.19, y + 1.7, z + nz * 0.19, yaw), face);
      glow.add(at(box(4.2, 0.4, 0.06), x + nx * 0.2, y + 2.2, z + nz * 0.2, yaw), 0xffffff);
      glow.add(at(box(2.6, 0.3, 0.06), x + nx * 0.2, y + 1.4, z + nz * 0.2, yaw), 0x16121c);
    });
  }

  // Under the floating islands: rock roots on Skyway, engines on Orbit. Only where nothing walkable is below.
  if (theme.under) {
    for (const b of map.boxes) {
      if (b.kind !== 'floor' && b.kind !== 'platform') continue;
      const sx = b.max.x - b.min.x;
      const sz = b.max.z - b.min.z;
      if (Math.min(sx, sz) < 3) continue;
      const cx = (b.min.x + b.max.x) / 2;
      const cz = (b.min.z + b.max.z) / 2;
      const below = map.boxes.some((o) => o !== b && o.kind !== 'clip' && o.max.y <= b.min.y && o.max.x > b.min.x && o.min.x < b.max.x && o.max.z > b.min.z && o.min.z < b.max.z);
      if (below) continue;
      const r = Math.min(sx, sz) / 2;
      if (theme.under === 'rocks') {
        const color = map.tint?.floor ? shade(0x8a6a4a, 1) : 0x8a6a4a;
        const main = new THREE.ConeGeometry(r * 0.95, r * 1.4, 6);
        main.rotateX(Math.PI);
        solid.add(at(main, cx, b.min.y - r * 0.7, cz, rand()), color);
        // Smaller roots spread along the long side.
        const extra = Math.floor(Math.max(sx, sz) / (r * 2));
        for (let i = 0; i < extra + 1; i++) {
          const t = (i + 0.5) / (extra + 1) - 0.5;
          const rr = r * (0.45 + rand() * 0.25);
          const g = new THREE.ConeGeometry(rr, rr * 1.8, 5);
          g.rotateX(Math.PI);
          const ox = sx > sz ? t * (sx - rr * 2) : (rand() - 0.5) * r;
          const oz = sx > sz ? (rand() - 0.5) * r : t * (sz - rr * 2);
          solid.add(at(g, cx + ox, b.min.y - rr * 0.9, cz + oz, rand() * 3), shade(0x8a6a4a, 0.85));
        }
      } else {
        const rr = Math.min(r * 0.45, 2.2);
        solid.add(at(new THREE.CylinderGeometry(rr, rr * 0.75, 0.7, 10), cx, b.min.y - 0.35, cz), 0x5a5e70);
        solid.add(at(new THREE.CylinderGeometry(rr * 0.7, rr * 0.5, 0.25, 10), cx, b.min.y - 0.8, cz), 0x2e3040);
        glow.add(at(new THREE.CylinderGeometry(rr * 0.5, rr * 0.5, 0.06, 10), cx, b.min.y - 0.95, cz), accent);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          glow.add(at(box(0.12, 0.1, 0.12), cx + dx * (r - 0.4), b.min.y - 0.06, cz + dz * (r - 0.4)), accent);
        }
      }
    }
  }

  if (theme.lava) {
    // A lava lake far down the pit: falling in is what kills you, so make it look like it.
    const y = map.killY + 5;
    const lake = new THREE.PlaneGeometry(half * 2, half * 2);
    lake.rotateX(-Math.PI / 2);
    glow.add(at(lake, 0, y, 0), 0xff6a1e);
    for (let i = 0; i < 40; i++) {
      const crust = new THREE.CircleGeometry(1 + rand() * 3.5, 7);
      crust.rotateX(-Math.PI / 2);
      glow.add(at(crust, (rand() - 0.5) * half * 1.9, y + 0.05, (rand() - 0.5) * half * 1.9), rand() < 0.5 ? 0xc8361a : 0xffc040);
    }
  }
}
