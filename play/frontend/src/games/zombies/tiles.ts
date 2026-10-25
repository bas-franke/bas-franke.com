// Tiled stone: the lobby's black marble floor (1.2 m tiles) and the travertine cladding on the columns, corner posts and walls
// (1.2 x 0.6 m slabs in running bond, the same grid world.ts's box projection draws). A bullet never takes a block out
// of these; it chips the tile it hits. Each hit leaves a crater of grey bedding concrete and cracks that stop at the
// tile's joints; the fourth hit on a tile breaks the whole tile off and leaves its concrete bed. The flying pieces are
// fx.ts's business (it owns the fragment pools); this file knows the tile grid, the marks and the beds.
//
// Purely visual and per client: every client sees every shot, so the counts agree closely enough.

import * as THREE from 'three';
import type { Vec3 } from '@shared/math';
import type { World } from '@shared/zombies/world';

/** Hits that break a tile off. */
export const TILE_HITS = 4;

export type Stone = 'marble' | 'travertine';

export interface Tile {
  key: string;
  stone: Stone;
  /** Axis of the face normal (0 x, 1 y, 2 z) and its sign. */
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  /** The face's coordinate along `axis`. */
  plane: number;
  /** The tile's rectangle in face coordinates (a, b), clipped to the face. See faceAB(). */
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  hits: number;
  marks: number[];
}

/** Face coordinates: the floor uses (x, z), faces across x use (z, y), faces across z use (x, y). */
export const faceAB = (axis: number, p: Vec3): [number, number] => (axis === 0 ? [p.z, p.y] : axis === 1 ? [p.x, p.z] : [p.x, p.y]);

/** World point on a face, `lift` out along its normal. */
export function facePoint(t: Tile, a: number, b: number, lift = 0): Vec3 {
  const n = t.plane + t.sign * lift;
  return t.axis === 0 ? { x: n, y: b, z: a } : t.axis === 1 ? { x: a, y: n, z: b } : { x: a, y: b, z: n };
}

export const faceNormal = (t: Tile): Vec3 => (t.axis === 0 ? { x: t.sign, y: 0, z: 0 } : t.axis === 1 ? { x: 0, y: t.sign, z: 0 } : { x: 0, y: 0, z: t.sign });

// ---- textures ---------------------------------------------------------------------------------------------------------

const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const CELL = 256;
/** Atlas cells (2 x 2): two craters, two crack patterns. */
const M = { crater: 0, crater2: 1, crack: 2, crack2: 3 } as const;

/** Grey bedding concrete with aggregate, as seen in a chip or under a missing tile. */
function concrete(x: number, y: number): [number, number, number] {
  const n = vnoise(x / 6, y / 6) * 0.6 + vnoise(x / 2, y / 2) * 0.4;
  const agg = hash(Math.floor(x / 2.5), Math.floor(y / 2.5));
  const k = (0.78 + n * 0.3) * (agg > 0.9 ? 0.62 : agg < 0.06 ? 1.25 : 1);
  return [138 * k, 133 * k, 124 * k];
}

function marksAtlas() {
  const W = CELL * 2;
  const c = document.createElement('canvas');
  c.width = c.height = W;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, W);
  // Craters: a jagged hole down to the concrete, a dark lip where the tile's edge throws a shadow, a ring of crushed
  // pale stone around it.
  for (const [cell, seed] of [
    [M.crater, 3],
    [M.crater2, 11],
  ] as const) {
    const ox = (cell % 2) * CELL;
    const oy = Math.floor(cell / 2) * CELL;
    for (let y = 0; y < CELL; y++)
      for (let x = 0; x < CELL; x++) {
        const u = (x + 0.5) / CELL - 0.5;
        const v = (y + 0.5) / CELL - 0.5;
        const r = Math.hypot(u, v) * 2;
        const ang = Math.atan2(v, u);
        // Conchoidal chips: a few big scallops plus fine jaggies.
        const jag = 0.62 + vnoise(ang * 1.6 + seed, seed) * 0.32 + vnoise(ang * 9 + seed, seed * 2) * 0.1;
        const hole = jag * 0.78;
        let rgba: [number, number, number, number];
        if (r < hole) {
          const [cr, cg, cb] = concrete(x + seed * 50, y);
          // Deeper (darker) towards the middle, and the lip shades the rim.
          const k = (0.72 + 0.28 * (r / hole)) * (r > hole - 0.06 ? 0.55 : 1);
          rgba = [cr * k, cg * k, cb * k, 255];
        } else {
          const t = (r - hole) / (1 - hole);
          const dust = Math.max(0, 1 - t * 1.4) * (0.55 + vnoise(x / 4, y / 4) * 0.45);
          rgba = [235, 232, 226, 255 * dust * 0.75];
        }
        const i = ((oy + y) * W + ox + x) * 4;
        img.data[i] = rgba[0];
        img.data[i + 1] = rgba[1];
        img.data[i + 2] = rgba[2];
        img.data[i + 3] = rgba[3];
      }
  }
  g.putImageData(img, 0, 0);
  // Cracks: branching hairlines from the middle, white (instance colour tints them per stone).
  for (const [cell, seed] of [
    [M.crack, 5],
    [M.crack2, 9],
  ] as const) {
    const ox = (cell % 2) * CELL + CELL / 2;
    const oy = Math.floor(cell / 2) * CELL + CELL / 2;
    g.save();
    g.beginPath();
    g.rect(ox - CELL / 2, oy - CELL / 2, CELL, CELL);
    g.clip();
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const arms = 5 + (seed % 3);
    const branch = (x: number, y: number, ang: number, len: number, w: number, depth: number) => {
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x, y);
      let a = ang;
      for (let s = 0; s < len; s += 6) {
        a += (hash(s + seed, depth * 7 + x) - 0.5) * 0.7;
        x += Math.cos(a) * 6;
        y += Math.sin(a) * 6;
        g.lineTo(x, y);
        if (depth < 2 && hash(s * 3 + seed, depth + y) < 0.1) {
          g.stroke();
          branch(x, y, a + (hash(s, seed) < 0.5 ? -1 : 1) * (0.5 + hash(seed, s)), len * 0.45, Math.max(0.6, w * 0.6), depth + 1);
          g.lineWidth = w;
          g.beginPath();
          g.moveTo(x, y);
        }
      }
      g.stroke();
    };
    for (let k = 0; k < arms; k++) branch(ox, oy, (k / arms) * Math.PI * 2 + hash(k, seed) * 0.8, CELL * (0.32 + hash(seed, k) * 0.18), 2.2, 0);
    // A short ring crack around the impact.
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(ox, oy, CELL * 0.09, hash(seed, 1) * 6, hash(seed, 1) * 6 + 4.2);
    g.stroke();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** The bed a tile leaves: grey adhesive with trowel ridges, a broken-off rim of tile left in the joint, shadowed edges. */
function bedTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const [cr, cg, cb] = concrete(x, y);
      // Notched-trowel ridges, a little wavy, with bald patches where the tile tore adhesive off with it.
      const ridge = 0.5 + 0.5 * Math.sin((x + vnoise(x / 20, y / 20) * 9) * 0.55);
      const torn = vnoise(x / 30 + 7, y / 30) > 0.62 ? 0.4 : 1;
      let k = 0.82 + 0.2 * ridge * torn;
      const e = Math.min(x, y, S - 1 - x, S - 1 - y) / S;
      // Shadow along the edges: the surrounding tiles stand proud of the bed.
      k *= 0.45 + 0.55 * Math.min(1, e / 0.05);
      const i = (y * S + x) * 4;
      img.data[i] = cr * k;
      img.data[i + 1] = cg * k;
      img.data[i + 2] = cb * k;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Marks are clipped to their tile's rectangle (per-instance `aClip` = a0, b0, a1, b1 on face axis `aAxis`). */
function clipped(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aClip;\nattribute vec4 aUv;\nattribute float aAxis;\nvarying vec4 vClip;\nvarying float vAxis;\nvarying vec3 vTW;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
#ifdef USE_MAP
vMapUv = uv * aUv.zw + aUv.xy;
#endif`,
      )
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvClip = aClip;\nvAxis = aAxis;\nvTW = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vClip;\nvarying float vAxis;\nvarying vec3 vTW;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
{
  vec2 ab = vAxis < 0.5 ? vTW.zy : vAxis < 1.5 ? vTW.xz : vTW.xy;
  if (ab.x < vClip.x || ab.y < vClip.y || ab.x > vClip.z || ab.y > vClip.w) discard;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'ztile-marks';
  return mat;
}

/**
 * A broken piece of tile (unit size, thin along y): an irregular polygon, polished face up. `aPart` marks the face (0),
 * the broken edges (1) and the back with adhesive on it (2), so one material can tell them apart.
 */
export function tilePieceGeometry(seed: number, sides: number, round: number) {
  const ring: [number, number][] = [];
  const turn = hash(seed, 99) * Math.PI * 2;
  for (let i = 0; i < sides; i++) {
    // Uneven corners at uneven distances: a sliver, a wedge, a broken corner, never a regular polygon.
    const a = turn + ((i + 0.5 + (hash(seed, i) - 0.5) * 0.85) / sides) * Math.PI * 2;
    const sq = 0.5 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
    const r = (sq * (1 - round) + 0.5 * round) * (0.55 + hash(i, seed) * 0.5);
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const pos: number[] = [];
  const part: number[] = [];
  const tri = (k: number, ...v: number[]) => {
    pos.push(...v);
    part.push(k, k, k);
  };
  for (let i = 0; i < sides; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % sides];
    tri(0, 0, 0.5, 0, bx, 0.5, bz, ax, 0.5, az);
    tri(2, 0, -0.5, 0, ax, -0.5, az, bx, -0.5, bz);
    tri(1, ax, 0.5, az, bx, 0.5, bz, bx, -0.5, bz);
    tri(1, ax, 0.5, az, bx, -0.5, bz, ax, -0.5, az);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.computeVertexNormals();
  return g;
}

/** Material for tile pieces: instance colour on the polished face, `core` on the broken edges, grey adhesive behind. */
export function tilePieceMaterial(stone: Stone) {
  const marble = stone === 'marble';
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: marble ? 0.22 : 0.6, metalness: 0, flatShading: true, envMapIntensity: marble ? 0.7 : 0.5 });
  const core = marble ? '0.42, 0.41, 0.4' : '0.78, 0.71, 0.58';
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aPart;\nvarying float vPart;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart = aPart;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPart;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float zEdge = step(0.5, vPart) * (1.0 - step(1.5, vPart));
float zBack = step(1.5, vPart);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${core}), zEdge);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.27, 0.26, 0.245), zBack);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.95, max(zEdge, zBack));');
  };
  mat.customProgramCacheKey = () => `ztile-piece-${stone}`;
  return mat;
}

/** Polished-face tint per stone (the floor material lifts the black marble, so the pieces are not pure black). */
export const STONE_TINT: Record<Stone, number> = { marble: 0x141315, travertine: 0xc9bb9c };
/** Cracks show pale in black marble and dark in travertine. */
const CRACK_TINT: Record<Stone, [number, number, number]> = { marble: [0.4, 0.39, 0.38], travertine: [0.22, 0.17, 0.12] };

// ---- tile damage ----------------------------------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

interface Box {
  min: Vec3;
  max: Vec3;
}

export class TileDamage {
  readonly marks: THREE.InstancedMesh;
  readonly beds: THREE.InstancedMesh;
  private readonly tiles = new Map<string, Tile>();
  private readonly markOwner: (Tile | null)[];
  private readonly bedOwner: (Tile | null)[];
  private nextMark = 0;
  private nextBed = 0;
  private readonly clip: THREE.InstancedBufferAttribute;
  private readonly axis: THREE.InstancedBufferAttribute;
  private readonly uv: THREE.InstancedBufferAttribute;
  /** Whole-column boxes per column chunk (a column is several chunks; its cladding runs across them). */
  private readonly columnBox = new Map<number, Box>();
  private readonly disposables: { dispose(): void }[] = [];

  constructor(
    private readonly world: World,
    root: THREE.Object3D,
    nMarks = 420,
    nBeds = 96,
  ) {
    const own = <T extends { dispose(): void }>(x: T) => (this.disposables.push(x), x);
    const geo = own(new THREE.PlaneGeometry(1, 1));
    this.clip = new THREE.InstancedBufferAttribute(new Float32Array(nMarks * 4), 4);
    this.axis = new THREE.InstancedBufferAttribute(new Float32Array(nMarks), 1);
    this.uv = new THREE.InstancedBufferAttribute(new Float32Array(nMarks * 4), 4);
    geo.setAttribute('aClip', this.clip);
    geo.setAttribute('aAxis', this.axis);
    geo.setAttribute('aUv', this.uv);
    const markMat = own(
      clipped(
        new THREE.MeshStandardMaterial({
          map: own(marksAtlas()),
          roughness: 0.92,
          metalness: 0,
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        }),
      ),
    );
    this.marks = new InstancedMeshZ(geo, markMat, nMarks);
    this.marks.renderOrder = 3;
    this.marks.setColorAt(0, _c.set(1, 1, 1));
    this.markOwner = new Array(nMarks).fill(null);

    const bedMat = own(new THREE.MeshStandardMaterial({ map: own(bedTexture()), color: 0x6e6b66, roughness: 0.96, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.beds = new InstancedMeshZ(own(new THREE.PlaneGeometry(1, 1)), bedMat, nBeds);
    this.beds.renderOrder = 1;
    this.bedOwner = new Array(nBeds).fill(null);
    root.add(this.beds, this.marks);
  }

  /** The tile under a bullet impact, or null when the surface is not tiled stone. Creates the tile on first sight. */
  tileAt(p: Vec3, n: Vec3, mat: string, chunk: number): Tile | null {
    let stone: Stone;
    let axis: 0 | 1 | 2;
    let lo: [number, number];
    let hi: [number, number];
    let plane: number;
    let sign: 1 | -1;
    if (mat === 'marble' && chunk === -1 && n.y > 0.9 && p.y < 0.05) {
      // The lobby floor, clipped to the floor area it is in (open zones and passages).
      const r = this.world.areas.find((x) => p.x >= x.minX - 0.01 && p.x <= x.maxX + 0.01 && p.z >= x.minZ - 0.01 && p.z <= x.maxZ + 0.01);
      if (!r) return null;
      stone = 'marble';
      axis = 1;
      sign = 1;
      plane = 0;
      lo = [r.minX, r.minZ];
      hi = [r.maxX, r.maxZ];
    } else if (mat === 'travertine' && Math.abs(n.y) < 0.5) {
      const box = chunk >= 0 ? this.column(chunk) : this.post(p);
      if (!box) return null;
      stone = 'travertine';
      axis = Math.abs(n.x) > 0.5 ? 0 : 2;
      sign = (axis === 0 ? n.x : n.z) > 0 ? 1 : -1;
      plane = axis === 0 ? (sign > 0 ? box.max.x : box.min.x) : sign > 0 ? box.max.z : box.min.z;
      lo = faceAB(axis, box.min);
      hi = faceAB(axis, box.max);
    } else return null;

    const [a, b] = faceAB(axis, p);
    let a0: number;
    let b0: number;
    let w: number;
    let h: number;
    let ti: number;
    let tj: number;
    if (stone === 'marble') {
      w = h = 1.2;
      ti = Math.floor(a / w);
      tj = Math.floor(b / h);
      a0 = ti * w;
      b0 = tj * h;
    } else {
      // world.ts: side faces across x get a (13.7, 5.3) m offset; travertine rows are 0.6 m, odd rows shift by half a slab.
      const oa = axis === 0 ? 13.7 : 0;
      const ob = axis === 0 ? 5.3 : 0;
      w = 1.2;
      h = 0.6;
      tj = Math.floor((b + ob) / h);
      const shift = ((tj % 2) + 2) % 2 ? w / 2 : 0;
      ti = Math.floor((a + oa + shift) / w);
      a0 = ti * w - shift - oa;
      b0 = tj * h - ob;
    }
    const key = `${axis}${sign}:${plane.toFixed(2)}:${ti}:${tj}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { key, stone, axis, sign, plane, a0: Math.max(lo[0], a0), a1: Math.min(hi[0], a0 + w), b0: Math.max(lo[1], b0), b1: Math.min(hi[1], b0 + h), hits: 0, marks: [] };
      if (t.a1 - t.a0 < 0.01 || t.b1 - t.b0 < 0.01) return null;
      this.tiles.set(key, t);
    }
    return t;
  }

  /** Floor tiles whose middle is within `r` of `p` (grenades). */
  floorTilesNear(p: Vec3, r: number): { t: Tile; d: number }[] {
    const out: { t: Tile; d: number }[] = [];
    const up = { x: 0, y: 1, z: 0 };
    for (let i = Math.floor((p.x - r) / 1.2); i <= Math.floor((p.x + r) / 1.2); i++)
      for (let j = Math.floor((p.z - r) / 1.2); j <= Math.floor((p.z + r) / 1.2); j++) {
        const c = { x: (i + 0.5) * 1.2, y: 0, z: (j + 0.5) * 1.2 };
        const d = Math.hypot(c.x - p.x, c.z - p.z);
        if (d > r) continue;
        const t = this.tileAt(c, up, 'marble', -1);
        if (t) out.push({ t, d });
      }
    return out;
  }

  /** Records a hit; returns the hit count (TILE_HITS: the tile just broke off and its bed is down). */
  hit(t: Tile, p: Vec3, add = 1): number {
    if (t.hits >= TILE_HITS) return t.hits;
    t.hits = Math.min(TILE_HITS, t.hits + add);
    if (t.hits >= TILE_HITS) {
      this.clearMarks(t);
      this.placeBed(t);
      return t.hits;
    }
    const [a, b] = faceAB(t.axis, p);
    const h = t.hits;
    // The chip: grows a little as the tile gets weaker.
    this.mark(t, a, b, rnd(0.07, 0.1) * (1 + h * 0.18), Math.random() < 0.5 ? M.crater : M.crater2, _c.set(1, 1, 1));
    // Cracks from the impact, longer with every hit; the third runs across most of the tile.
    const span = Math.min(t.a1 - t.a0, t.b1 - t.b0);
    const crack = h === 1 ? rnd(0.25, 0.4) : h === 2 ? rnd(0.5, 0.7) : Math.max(0.9, span * 1.6);
    const [cr, cg, cb] = CRACK_TINT[t.stone];
    this.mark(t, a, b, Math.min(crack, 2.2), Math.random() < 0.5 ? M.crack : M.crack2, _c.setRGB(cr, cg, cb));
    return t.hits;
  }

  private mark(t: Tile, a: number, b: number, size: number, cell: number, tint: THREE.Color) {
    const i = this.nextMark;
    this.nextMark = (this.nextMark + 1) % this.markOwner.length;
    const old = this.markOwner[i];
    if (old) old.marks = old.marks.filter((x) => x !== i);
    this.markOwner[i] = t;
    t.marks.push(i);
    const n = faceNormal(t);
    const fp = facePoint(t, a, b, 0.003 + (i % 5) * 0.0004);
    _p.set(fp.x, fp.y, fp.z);
    _q.setFromUnitVectors(_z, _n.set(n.x, n.y, n.z)).multiply(_q2.setFromAxisAngle(_z, rnd(0, 6.28)));
    this.marks.setMatrixAt(i, _m.compose(_p, _q, _s.set(size, size, 1)));
    this.marks.setColorAt(i, tint);
    // Clip a hair inside the joints, so the grout line stays visible.
    this.clip.setXYZW(i, t.a0 + 0.004, t.b0 + 0.004, t.a1 - 0.004, t.b1 - 0.004);
    this.axis.setX(i, t.axis);
    this.uv.setXYZW(i, (cell % 2) / 2, 1 - (Math.floor(cell / 2) + 1) / 2, 0.5, 0.5);
    this.marks.instanceMatrix.needsUpdate = true;
    this.clip.needsUpdate = this.axis.needsUpdate = this.uv.needsUpdate = true;
    if (this.marks.instanceColor) this.marks.instanceColor.needsUpdate = true;
  }

  private clearMarks(t: Tile) {
    for (const i of t.marks) {
      this.markOwner[i] = null;
      this.marks.setMatrixAt(i, ZERO);
    }
    t.marks = [];
    this.marks.instanceMatrix.needsUpdate = true;
  }

  private placeBed(t: Tile) {
    const i = this.nextBed;
    this.nextBed = (this.nextBed + 1) % this.bedOwner.length;
    // Out of beds: the oldest missing tile is back in one piece (and can be broken again).
    const old = this.bedOwner[i];
    if (old) old.hits = 0;
    this.bedOwner[i] = t;
    const n = faceNormal(t);
    _n.set(n.x, n.y, n.z);
    const fa = facePoint(t, 1, 0);
    const f0 = facePoint(t, 0, 0);
    const fb = facePoint(t, 0, 1);
    _a.set(fa.x - f0.x, fa.y - f0.y, fa.z - f0.z);
    _b.set(fb.x - f0.x, fb.y - f0.y, fb.z - f0.z);
    // Keep the basis right-handed (a x b = n), or the plane faces into the stone.
    let sx = t.a1 - t.a0;
    if (_s.copy(_a).cross(_b).dot(_n) < 0) {
      _a.negate();
      sx = -sx;
    }
    _m.makeBasis(_a, _b, _n);
    const c = facePoint(t, (t.a0 + t.a1) / 2, (t.b0 + t.b1) / 2, 0.002);
    _m.scale(_s.set(Math.abs(sx), t.b1 - t.b0, 1));
    _m.setPosition(c.x, c.y, c.z);
    this.beds.setMatrixAt(i, _m);
    this.beds.instanceMatrix.needsUpdate = true;
  }

  private column(chunk: number): Box | null {
    const c = this.world.chunks[chunk];
    // Columns, and the travertine-clad walls (one box per wall: its tiles run on across the chunks).
    if (!c || !(c.part === 'column' || (c.wall && c.mat === 'travertine'))) return null;
    let box = this.columnBox.get(chunk);
    if (box) return box;
    // Flood over the column's chunks for the whole column's extent.
    const seen = new Set([chunk]);
    const list = [chunk];
    box = { min: { ...c.min }, max: { ...c.max } };
    for (let k = 0; k < list.length; k++)
      for (const j of this.world.chunks[list[k]].nb) {
        const o = this.world.chunks[j];
        if (seen.has(j) || o.part !== c.part) continue;
        seen.add(j);
        list.push(j);
        box.min.x = Math.min(box.min.x, o.min.x);
        box.min.y = Math.min(box.min.y, o.min.y);
        box.min.z = Math.min(box.min.z, o.min.z);
        box.max.x = Math.max(box.max.x, o.max.x);
        box.max.y = Math.max(box.max.y, o.max.y);
        box.max.z = Math.max(box.max.z, o.max.z);
      }
    for (const j of list) this.columnBox.set(j, box);
    return box;
  }

  private post(p: Vec3): Box | null {
    const e = 0.02;
    for (const s of this.world.solids)
      if (s.kind === 'post' && p.x >= s.min.x - e && p.x <= s.max.x + e && p.y >= s.min.y - e && p.y <= s.max.y + e && p.z >= s.min.z - e && p.z <= s.max.z + e) return s;
    return null;
  }

  clear() {
    this.tiles.clear();
    this.markOwner.fill(null);
    this.bedOwner.fill(null);
    for (let i = 0; i < this.markOwner.length; i++) this.marks.setMatrixAt(i, ZERO);
    for (let i = 0; i < this.bedOwner.length; i++) this.beds.setMatrixAt(i, ZERO);
    this.marks.instanceMatrix.needsUpdate = this.beds.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.marks.removeFromParent();
    this.beds.removeFromParent();
    this.marks.dispose();
    this.beds.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** An InstancedMesh that starts empty (every instance scaled to zero) and is never frustum-culled. */
class InstancedMeshZ extends THREE.InstancedMesh {
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, n: number) {
    super(geo, mat, n);
    this.frustumCulled = false;
    this.receiveShadow = true;
    for (let i = 0; i < n; i++) this.setMatrixAt(i, ZERO);
  }
}
