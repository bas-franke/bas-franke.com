// Last Light destruction themes: what each material looks like when a bullet hits it and when a chunk of it breaks.
// fx.ts owns the pools and the physics; this file holds the per-material look table, the shapes the pieces are made
// of (glass slivers, glazed pot shards, bent brass, leaves, torn scraps, springs, cushions, leafy clumps) and which
// theme a chunk breaks with (a lamp shade pops, a vase splashes, a sofa seat bursts its stuffing).

import * as THREE from 'three';
import { furnitureParts, type FurniturePartName } from '@shared/zombies/furniture';
import type { Mat } from '@shared/zombies/maps';
import type { World } from '@shared/zombies/world';

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function flat(g: THREE.BufferGeometry) {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.computeVertexNormals();
  return ng;
}

// ---- looks ----------------------------------------------------------------------------------------------------------

export interface Look {
  /** Fragment base colour, roughness, metalness. */
  color: number;
  rough: number;
  metal: number;
  /** How much dust a break raises (0..1), and its colour. */
  dust: number;
  dustColor: number;
  /** Grit (falling crumbs) and chip (flying impact bits) colours. */
  grit: number;
  chips: number;
  /** Colour of the surface for tinted hole cells (holes.ts draws those neutral, 255 = this colour). */
  surface: number;
  /** surfaced() pattern in fx.ts. */
  surf: number;
}

export const LOOK: Record<Mat, Look> = {
  brick: { color: 0x84422d, rough: 0.92, metal: 0, dust: 0.85, dustColor: 0x9a7b68, grit: 0x7a4a36, chips: 0xb88a72, surface: 0xf2a88c, surf: 0 },
  plaster: { color: 0xc9c1b0, rough: 0.95, metal: 0, dust: 1, dustColor: 0xc8c2b6, grit: 0xb9b2a4, chips: 0xe4ded2, surface: 0xfffaf0, surf: 1 },
  concrete: { color: 0x7d7a73, rough: 0.9, metal: 0, dust: 0.75, dustColor: 0x8c8982, grit: 0x6e6b65, chips: 0xa8a49b, surface: 0xd2ccc4, surf: 2 },
  wood: { color: 0x6e4c2e, rough: 0.8, metal: 0, dust: 0.3, dustColor: 0x7a644c, grit: 0x8a6440, chips: 0xc8a272, surface: 0xe0b890, surf: 3 },
  metal: { color: 0x5c6166, rough: 0.42, metal: 0.85, dust: 0.08, dustColor: 0x5a5a5a, grit: 0x55595e, chips: 0x9aa0a6, surface: 0xb4bac0, surf: 4 },
  marble: { color: 0xe9e5dd, rough: 0.25, metal: 0, dust: 0.9, dustColor: 0xe8e6e0, grit: 0xd8d4cc, chips: 0xf6f4ef, surface: 0xf4f0e8, surf: 7 },
  travertine: { color: 0xc9b48c, rough: 0.85, metal: 0, dust: 0.8, dustColor: 0xd6c39a, grit: 0xbfa77a, chips: 0xe0cfa6, surface: 0xe8d6ae, surf: 8 },
  walnut: { color: 0x4a2c1a, rough: 0.35, metal: 0, dust: 0.25, dustColor: 0x6a4c34, grit: 0x5a3a24, chips: 0xb08454, surface: 0xffffff, surf: 3 },
  glass: { color: 0xcfe4ea, rough: 0.04, metal: 0.1, dust: 0.05, dustColor: 0xc8d4d8, grit: 0xd4eaf0, chips: 0xe6f6fa, surface: 0xffffff, surf: 9 },
  fabric: { color: 0xe4dac8, rough: 1, metal: 0, dust: 0.25, dustColor: 0xd8d0c2, grit: 0xcfc4b0, chips: 0xf2ece0, surface: 0xf1ebe0, surf: 10 },
  leather: { color: 0x4a2418, rough: 0.55, metal: 0, dust: 0.12, dustColor: 0x8a7050, grit: 0x3a1c12, chips: 0x5a2c1c, surface: 0xa07060, surf: 11 },
  ceramic: { color: 0xffffff, rough: 0.3, metal: 0, dust: 0.45, dustColor: 0xc4b49a, grit: 0xb8a68c, chips: 0xe8e0d2, surface: 0xffffff, surf: 9 },
  brass: { color: 0xc9973f, rough: 0.3, metal: 1, dust: 0.03, dustColor: 0x7a6a50, grit: 0xb8893a, chips: 0xe8c070, surface: 0xffffff, surf: 12 },
  foliage: { color: 0x3c5a26, rough: 0.7, metal: 0, dust: 0.1, dustColor: 0x5a6a40, grit: 0x4d6b2c, chips: 0x6a8a3a, surface: 0xffffff, surf: 6 },
};

/** Pot glaze (outside) and fired clay (inside and the broken edges), baked into the pot-shard vertex colours. */
const GLAZE = new THREE.Color(0x15140f);
const CLAY = new THREE.Color(0xd8cfc0);

// ---- themes ---------------------------------------------------------------------------------------------------------

/**
 * How a chunk breaks. Most materials have one theme; furniture parts get their own (a glass vase splashes water, a
 * fabric lamp shade pops its bulb, a tablecloth tears without stuffing, a sofa seat throws springs).
 */
export type Theme =
  | 'classic'
  | 'pane'
  | 'vase'
  | 'marble'
  | 'travertine'
  | 'walnut'
  | 'upholstery'
  | 'sofa'
  | 'shade'
  | 'cloth'
  | 'leather'
  | 'luggage'
  | 'pot'
  | 'canopy'
  | 'flowers'
  | 'brass';

const PART_NAMES: FurniturePartName[] = ['seat', 'back', 'arm', 'body', 'top', 'leg', 'pole', 'shade', 'pot', 'trunk', 'canopy', 'vase', 'flowers', 'panel', 'deck', 'rail', 'case', 'cloth', 'chair'];

/** Per chunk: its furniture part (index into PART_NAMES + 1, 0 = not furniture) and whether it is in a sofa or armchair. */
export class ChunkParts {
  private readonly part: Uint8Array;
  private readonly sofa: Uint8Array;

  constructor(world: World) {
    this.part = new Uint8Array(world.chunks.length);
    this.sofa = new Uint8Array(world.chunks.length);
    const cache = new Map<string, FurniturePartName[]>();
    world.chunks.forEach((c, i) => {
      if (c.furn === undefined || c.furnPart === undefined) return;
      const f = world.furniture[c.furn];
      if (!f) return;
      let names = cache.get(f.kind);
      if (!names) cache.set(f.kind, (names = furnitureParts(f.kind).map((p) => p.name)));
      const name = names[c.furnPart];
      if (name) this.part[i] = PART_NAMES.indexOf(name) + 1;
      if (f.kind === 'sofa' || f.kind === 'armchair') this.sofa[i] = 1;
    });
  }

  name(chunk: number): FurniturePartName | null {
    const k = chunk >= 0 && chunk < this.part.length ? this.part[chunk] : 0;
    return k ? PART_NAMES[k - 1] : null;
  }

  /** Thin sheet parts a bullet goes straight through (brass drums and rails, lamp poles). */
  thin(chunk: number) {
    const n = this.name(chunk);
    return n === 'body' || n === 'rail' || n === 'pole' || n === 'shade';
  }

  theme(chunk: number, mat: Mat): Theme {
    const n = this.name(chunk);
    switch (mat) {
      case 'glass':
        return n === 'vase' ? 'vase' : 'pane';
      case 'marble':
        return 'marble';
      case 'travertine':
        return 'travertine';
      case 'walnut':
        return 'walnut';
      case 'fabric':
        if (n === 'shade') return 'shade';
        if (n === 'cloth') return 'cloth';
        return this.sofa[chunk] && (n === 'seat' || n === 'back') ? 'sofa' : 'upholstery';
      case 'leather':
        return n === 'case' ? 'luggage' : 'leather';
      case 'ceramic':
        return 'pot';
      case 'foliage':
        return n === 'flowers' ? 'flowers' : 'canopy';
      case 'brass':
        return 'brass';
      default:
        return 'classic';
    }
  }
}

// ---- shapes ---------------------------------------------------------------------------------------------------------

/** A thin, sharp sliver of glass: a long triangle or a narrow quad, flat in xz (spawn it with y scale ~0.08 of x). */
export function sliverGeometry(seed: number, thick = 0.375) {
  const n = 3 + Math.floor(hash(seed, 2) * 2);
  const ring: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (hash(seed, i) - 0.5) * 0.9;
    const r = 0.35 + hash(i, seed) * 0.2;
    // Stretched along z: broken glass runs to long points.
    ring.push([Math.cos(a) * r * 0.55, Math.sin(a) * r * 1.25]);
  }
  return prism(ring, thick, 1);
}

/** A flat polygon with a thickness (top and bottom faces plus the edge). */
function prism(ring: [number, number][], thick: number, bevel: number) {
  const pts: number[] = [];
  const n = ring.length;
  const t = thick / 2;
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % n];
    pts.push(0, t, 0, bx, t * bevel, bz, ax, t * bevel, az);
    pts.push(0, -t, 0, ax, -t * bevel, az, bx, -t * bevel, bz);
    pts.push(ax, t * bevel, az, bx, t * bevel, bz, bx, -t * bevel, bz);
    pts.push(ax, t * bevel, az, bx, -t * bevel, bz, ax, -t * bevel, az);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.computeVertexNormals();
  return g;
}

/** A plate bent into a curl (brass drum skin, a torn rail): flat shard, then y += k·x². */
export function bentGeometry(seed: number) {
  const ring: [number, number][] = [];
  const n = 5 + Math.floor(hash(seed, 1) * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + hash(seed, i) * 0.5;
    const r = 0.3 + hash(i, seed + 3) * 0.22;
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const g = prism(ring, 0.07, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  const k = 0.9 + hash(seed, 9) * 0.8;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    p.setY(i, p.getY(i) + k * x * x - 0.3 * z * z * hash(seed, 4));
  }
  g.computeVertexNormals();
  return g;
}

/**
 * A curved shard off a glazed pot: a patch of a cylinder wall, ragged on every side. Vertex colours carry the dark
 * glaze outside and the pale fired clay inside and on the broken edges.
 */
export function potShardGeometry(seed: number) {
  const NU = 4;
  const NV = 3;
  const arc = 1.1;
  const R = 1.2;
  const T = 0.14;
  // Ragged outline: each grid vertex jittered, the rim ones more.
  const grid = (r: number) => {
    const out: THREE.Vector3[] = [];
    for (let j = 0; j <= NV; j++)
      for (let i = 0; i <= NU; i++) {
        const edge = i === 0 || i === NU || j === 0 || j === NV;
        const ju = (hash(seed + i * 7, j * 3) - 0.5) * (edge ? 0.28 : 0.08);
        const jv = (hash(seed + j * 5, i * 11) - 0.5) * (edge ? 0.3 : 0.08);
        const a = (i / NU - 0.5 + ju / NU) * arc;
        const y = j / NV - 0.5 + jv / NV;
        // The wall's thickness and curve along y (the thin axis fx.ts rests pieces on), its height along z.
        out.push(new THREE.Vector3(Math.sin(a) * r, Math.cos(a) * r - R + 0.05, y));
      }
    return out;
  };
  const outer = grid(R);
  const inner = grid(R - T);
  const pos: number[] = [];
  const col: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, k: THREE.Color) => {
    // y and z are swapped against the cylinder (see grid), so the winding is turned back here.
    pos.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
    for (let q = 0; q < 3; q++) col.push(k.r, k.g, k.b);
  };
  const at = (i: number, j: number) => j * (NU + 1) + i;
  for (let j = 0; j < NV; j++)
    for (let i = 0; i < NU; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      tri(outer[a], outer[b], outer[c], GLAZE);
      tri(outer[a], outer[c], outer[d], GLAZE);
      tri(inner[a], inner[c], inner[b], CLAY);
      tri(inner[a], inner[d], inner[c], CLAY);
    }
  // Broken edges round the rim.
  const rim: number[] = [];
  for (let i = 0; i < NU; i++) rim.push(at(i, 0));
  for (let j = 0; j < NV; j++) rim.push(at(NU, j));
  for (let i = NU; i > 0; i--) rim.push(at(i, NV));
  for (let j = NV; j > 0; j--) rim.push(at(0, j));
  for (let k = 0; k < rim.length; k++) {
    const a = rim[k];
    const b = rim[(k + 1) % rim.length];
    tri(outer[a], inner[a], inner[b], CLAY);
    tri(outer[a], inner[b], outer[b], CLAY);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** A leaf card, flat in xz, length along z, folded a little along its midrib. */
export function leafGeometry(seed: number) {
  const N = 6;
  const pos: number[] = [];
  const outline = (t: number) => Math.sin(Math.PI * Math.pow(t, 0.8)) * (0.24 + hash(seed, 1) * 0.08);
  for (let i = 0; i < N; i++) {
    const t0 = i / N;
    const t1 = (i + 1) / N;
    const z0 = t0 - 0.5;
    const z1 = t1 - 0.5;
    const w0 = outline(t0);
    const w1 = outline(t1);
    const fold = 0.06;
    // Midrib at y = fold, edges at y = 0 (and a slight droop towards the tip).
    const d0 = -t0 * t0 * 0.12;
    const d1 = -t1 * t1 * 0.12;
    for (const s of [-1, 1]) {
      pos.push(0, fold + d0, z0, s * w0, d0, z0, s * w1, d1, z1);
      pos.push(0, fold + d0, z0, s * w1, d1, z1, 0, fold + d1, z1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A torn scrap (cloth, paper, a flake of lacquer): an irregular polygon in xz with a slight curl. */
export function scrapGeometry(seed: number) {
  const n = 6 + Math.floor(hash(seed, 5) * 3);
  const pos: number[] = [];
  const pt = (k: number) => {
    const a = (k / n) * Math.PI * 2 + hash(seed, k) * 0.5;
    const r = 0.34 + hash(k, seed + 1) * 0.2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    return [x, 0.18 * x * x - 0.1 * z, z];
  };
  for (let k = 0; k < n; k++) pos.push(0, 0.01, 0, ...pt(k + 1), ...pt(k));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A coil spring out of a sofa seat: a helix tube about 1 m tall (scaled per piece). */
export function springGeometry() {
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= 60; k++) {
    const t = k / 60;
    const a = t * Math.PI * 2 * 5;
    // Narrower in the waist, like an hourglass seat coil.
    const r = 0.32 + 0.12 * Math.abs(t - 0.5) * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, t - 0.5, Math.sin(a) * r));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.035, 4, false);
}

/** A cushion: a box with its faces bulged and edges rounded. */
export function cushionGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    // Blend from the box towards a rounded box (superellipsoid-ish), plus a little lumpiness.
    const l = v.length() || 1;
    const k = 0.35;
    const lump = 1 + (hash(i, 77) - 0.5) * 0.06;
    v.multiplyScalar((1 - k + (k * 0.6) / l) * lump);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** A leafy clump (a piece of a tree's canopy or a bunch of flowers): a lumpy, spiky ball. */
export function clumpGeometry(seed: number) {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 0.6 + hash(Math.round(x * 97) + seed, Math.round(y * 89) + Math.round(z * 83)) * 0.75;
    p.setXYZ(i, x * k, y * k * 0.85, z * k);
  }
  return flat(g);
}
