// The enchanted library around the play field: tall bookshelves on both sides and at the far end, arched windows on a
// starry night, brass lanterns, ivy, flowers, mushrooms, cushions, globes and piles of books spilling onto the floor.
//
// Everything is procedural and seeded, so the room is the same every time. To stay cheap on phones:
// - Everything static is merged into two materials: 'solid' (wood, brass, books, cushions, lantern glass: one atlas,
//   untextured and unlit pieces flagged by their uvs) and 'foliage' (leaves and flowers, double sided, swaying).
// - Triangles that can never face the camera (Game.placeCamera keeps it high above, in front, on x = 0) are dropped
//   at build time: undersides, backs, the sides of books facing the far end. About 40% of the room.
// - Both materials are cut into chunks (shelf bands along z, floor strips, far wall) that are frustum culled with
//   tight boxes: a portrait phone looks down from so high that it never sees the shelves by the defenders, a
//   landscape screen never sees the far end. 12 chunk draws at most, ~8 on screen.
// - Lantern light is faked: baked into a per-vertex `bake` value that the materials add as warm emissive light, plus
//   additive camera-facing glow octagons (shrunk to where their falloff still changes a pixel) and floor light pools.
// - 'low' quality (detectQuality) thins the foliage and the faintest glows.
// No real lights are added here, and `update` only advances one time uniform.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { detectQuality } from './engine';

export interface LibraryOptions {
  /** Depth of the play field along -z, from `lineZ` to `lineZ - length`. */
  length: number;
  /** Width of the play field along x, centred on x = 0. */
  width: number;
  /** z of the defence line (near end of the field, bottom of the screen). */
  lineZ: number;
}

export interface Library {
  update(dt: number, t: number): void;
}

// ---- layout -------------------------------------------------------------------------------------------------------

/** Floor between the field edge and the shelf fronts, where props pile up. */
const STRIP = 3.8;
/** Floor between the far end of the field and the far wall. */
const FAR_GAP = 2.6;
/** Shelf depth (front face to back panel). */
const DEPTH = 1.0;
/** Height of the shelf walls (cornice on top). */
const HEIGHT = 5.2;
/** Tops of the shelf boards; the first is the plinth. */
const ROWS = [0.5, 1.64, 2.78, 3.92];
/** Target bay width between two posts. */
const BAY = 2.3;
/** How far the side walls continue behind the defence line. */
const NEAR_EXTRA = 22;
/** Shelves this far past the defence line are painted (one quad per run of books): only wide screens' corners see them. */
const PAINTED_FROM = 10;
/** Gallery tiers stepping up behind each side wall. */
const GALLERIES = 3;

const BOOK_COLORS = [
  0x66342a, 0x58302e, 0x3a4636, 0x35423e, 0x343c52, 0x7e6238, 0x4a3424, 0x463640, 0xa8916c, 0x664630, 0x434b3c,
  0x723e2e, 0x33392f, 0x54343a, 0x3a4458,
];
const CUSHION_COLORS = [0x80382e, 0x70342c, 0x4c5e3c, 0x405438, 0x3a4c6a, 0x36524e];
const LEAF_COLORS = [0x3f7428, 0x4c8530, 0x5a9236, 0x356a24, 0x669c3a, 0x447a2a];
const WOOD = 0x6e4a2e;
const WOOD_DARK = 0x3e2a1a;
/** Lighter wood for the front edges of boards and posts, so the shelf structure reads from above. */
const WOOD_EDGE = 0x8a6440;
const BRASS = 0x9a6c34;
const BRASS_DARK = 0x4e3418;

/** Share of foliage and faint glows kept on the 'low' quality tier. */
const LOW_KEEP = { wallLeaf: 0.7, stripLeaf: 0.85, flower: 0.75 };

/** Colour of the faked lantern light (linear, multiplied by albedo and the baked amount). */
const WARM = new THREE.Vector3(0.95, 0.58, 0.24);
/** Flat light added to everything solid on the walls (shelves, books) and on the floor strip, as a share of albedo. */
const AMBIENT_WALL = 0.2;
const AMBIENT_STRIP = 0.06;
const AMBIENT_GALLERY = 0.34;
/** Most glow 'energy' (size^2 x intensity) the optional glows (candles) may add per metre of wall. */
const GLOW_CAP = 0.3;

// ---- small helpers ------------------------------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _l = new THREE.Matrix4();
const _w = new THREE.Matrix4();
const _v = new THREE.Vector3();

/** Local transform: translate, Euler rotation (XYZ, so rz is applied first, then ry, then rx), scale. */
function local(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, out = _l) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  return out.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** A wall frame: x along the wall, y up, z towards the field (into the wall is negative z). */
function wallFrame(ox: number, oz: number, ux: number, uz: number, nx: number, nz: number) {
  return new THREE.Matrix4()
    .makeBasis(new THREE.Vector3(ux, 0, uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(nx, 0, nz))
    .setPosition(ox, 0, oz);
}

/**
 * Where the camera can be. Game.placeCamera keeps it on x = 0 (plus a little shake), high above the floor and in front
 * of the defence line: with fov 28 and pitch 58..65 degrees, over every aspect ratio (0.4..3.56) and HUD inset it lands
 * at y 34..91 and z 14..47 (computed offline from placeCamera). This box is a margin around that. A triangle whose front faces away from every point of the
 * box can never be seen, so the merged meshes leave it out: bottoms of everything, the sides of books and boxes that
 * face the far end or the outside, the backs of the shelves. That is about 40% of the room's triangles.
 */
const CAM_BOX = { cx: 0, cy: 62, cz: 30, hx: 1.5, hy: 32, hz: 19 };

/** Per-instance extras for `Bag.add`. */
interface AddOpts {
  /** Bake the lantern light at the piece's origin instead of per vertex (books and leaves: one value per piece). */
  pivot?: boolean;
  /** Shifts spine uvs (u < 0.79) by this many 0.2-wide atlas columns. */
  uvShift?: number;
  /**
   * How the piece is textured in the solid material (default 'plain'): 'atlas' = book atlas, 'cushion' = the cushion
   * mask packed beside it, 'plain' = vertex colour only (u = -1, no texture fetch), 'unlit' = vertex colour as light
   * (u = -2: lantern glass, flames), 'raw' = the geometry's own uvs.
   */
  tex?: 'atlas' | 'cushion' | 'spines' | 'plain' | 'unlit' | 'raw';
  /** For 'spines': the slice [u0, u1] of the painted run of books the quad shows. */
  uvRect?: [number, number];
  /** Fraction of albedo added as light everywhere (foliage). */
  lit?: number;
}

/** One merged chunk being written. */
class Chunk {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  /** Where to sample the baked lantern light, per vertex. */
  bp: number[] = [];
  sway: number[] = [];
  lit: number[] = [];
  idx: number[] = [];
  /**
   * Bounds for frustum culling, one per group of pieces with similar extents (same wall, similar height and reach into
   * the room), so a box never pairs a lantern's reach with the floor under the shelves.
   */
  boxes = new Map<number, THREE.Box3>();
}

const _nm = new THREE.Matrix3();
const _pb = new THREE.Box3();
const _remap = new Int32Array(4096);

/**
 * Collects static pieces with a vertex colour and merges them into one indexed geometry per chunk (a band of the room
 * that is frustum culled as a whole). Unless `doubleSided`, triangles that can never face the camera are dropped.
 */
class Bag {
  readonly chunks = new Map<number, Chunk>();
  constructor(private readonly o: { uv?: boolean; sway?: boolean; lit?: boolean; doubleSided?: boolean; single?: boolean } = {}) {}

  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color | number, chunk: number, side: number, x: AddOpts = {}) {
    const c = typeof color === 'number' ? _col.setHex(color) : color;
    if (this.o.single) chunk = 0;
    let ch = this.chunks.get(chunk);
    if (!ch) this.chunks.set(chunk, (ch = new Chunk()));
    const P = geo.attributes.position as THREE.BufferAttribute;
    const N = geo.attributes.normal as THREE.BufferAttribute;
    const U = geo.attributes.uv as THREE.BufferAttribute | undefined;
    const C = geo.attributes.color as THREE.BufferAttribute | undefined;
    const index = geo.index;
    const triCount = index ? index.count / 3 : P.count / 3;
    const e = m.elements;
    _nm.getNormalMatrix(m);
    const ne = _nm.elements;
    const ox = e[12];
    const oy = e[13];
    const oz = e[14];
    // Sway amplitude: the piece's local height times its scale along local y (as the instanced shader had it).
    const sy = this.o.sway ? Math.hypot(e[4], e[5], e[6]) : 0;
    const remap = _remap.length >= P.count ? _remap : new Int32Array(P.count);
    remap.fill(-1, 0, P.count);
    const box = _pb.makeEmpty();
    const tx = (i: number, k: number) => {
      const px = P.getX(i);
      const py = P.getY(i);
      const pz = P.getZ(i);
      return e[k] * px + e[k + 4] * py + e[k + 8] * pz + e[k + 12];
    };
    for (let t = 0; t < triCount; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const d = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      if (!this.o.doubleSided) {
        const ax = tx(a, 0), ay = tx(a, 1), az = tx(a, 2);
        const ux = tx(b, 0) - ax, uy = tx(b, 1) - ay, uz = tx(b, 2) - az;
        const vx = tx(d, 0) - ax, vy = tx(d, 1) - ay, vz = tx(d, 2) - az;
        const fx = uy * vz - uz * vy;
        const fy = uz * vx - ux * vz;
        const fz = ux * vy - uy * vx;
        // Largest f · (camera - a) over the camera box.
        const best =
          fx * (CAM_BOX.cx - ax) + fy * (CAM_BOX.cy - ay) + fz * (CAM_BOX.cz - az) +
          Math.abs(fx) * CAM_BOX.hx + Math.abs(fy) * CAM_BOX.hy + Math.abs(fz) * CAM_BOX.hz;
        if (best <= 0) continue;
      }
      for (const i of [a, b, d]) {
        let o = remap[i];
        if (o < 0) {
          o = remap[i] = ch.pos.length / 3;
          const px = tx(i, 0);
          const py = tx(i, 1);
          const pz = tx(i, 2);
          ch.pos.push(px, py, pz);
          box.expandByPoint(_v.set(px, py, pz));
          const nx = N.getX(i);
          const ny = N.getY(i);
          const nz = N.getZ(i);
          _v.set(ne[0] * nx + ne[3] * ny + ne[6] * nz, ne[1] * nx + ne[4] * ny + ne[7] * nz, ne[2] * nx + ne[5] * ny + ne[8] * nz).normalize();
          ch.nrm.push(_v.x, _v.y, _v.z);
          if (C) ch.col.push(c.r * C.getX(i), c.g * C.getY(i), c.b * C.getZ(i));
          else ch.col.push(c.r, c.g, c.b);
          if (this.o.uv) {
            let u = U ? U.getX(i) : 0;
            let v = U ? U.getY(i) : 0;
            if (x.uvShift && u < 0.79) u += x.uvShift * 0.2;
            const tex = x.tex ?? 'plain';
            if (tex === 'atlas') {
              u *= ATLAS_BOOKS;
              v = ATLAS_V0 + v * (1 - ATLAS_V0);
            } else if (tex === 'cushion') {
              u = ATLAS_BOOKS + u * (1 - ATLAS_BOOKS);
              v = ATLAS_V0 + (0.5 + v * 0.5) * (1 - ATLAS_V0);
            } else if (tex === 'spines') {
              const r = x.uvRect ?? [0, 1];
              u = r[0] + u * (r[1] - r[0]);
              v *= ATLAS_V0;
            } else if (tex !== 'raw') {
              u = tex === 'plain' ? -1 : -2;
              v = 0;
            }
            ch.uv.push(u, v);
          }
          if (x.pivot) ch.bp.push(ox, oy, oz);
          else ch.bp.push(px, py, pz);
          if (this.o.sway) ch.sway.push(ox, oy, oz, P.getY(i) * sy);
          if (this.o.sway || this.o.lit) ch.lit.push(x.lit ?? 0);
        }
        ch.idx.push(o);
      }
    }
    if (box.isEmpty()) return;
    // Group by wall, by the piece's lowest point and by how far it reaches towards the field.
    const reach = side === 0 ? box.max.x : side === 1 ? -box.min.x : box.max.z;
    const key = side * 10000 + Math.floor(box.min.y / 1.2) * 100 + Math.floor(reach * 3);
    const g = ch.boxes.get(key);
    if (g) g.union(box);
    else ch.boxes.set(key, box.clone());
  }

  /** One geometry per chunk; `bake(x, y, z)` gives the lantern light (omit for unlit materials). */
  build(bake?: (x: number, y: number, z: number) => number, bakeScale = 1) {
    const out: { chunk: number; geo: THREE.BufferGeometry; boxes: THREE.Box3[] }[] = [];
    for (const [chunk, ch] of [...this.chunks].sort((p, q) => p[0] - q[0])) {
      if (!ch.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(ch.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(ch.nrm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(ch.col, 3));
      if (this.o.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(ch.uv, 2));
      if (this.o.sway) g.setAttribute('sway', new THREE.Float32BufferAttribute(ch.sway, 4));
      if (this.o.sway || this.o.lit) g.setAttribute('lit', new THREE.Float32BufferAttribute(ch.lit, 1));
      if (bake) {
        const n = ch.bp.length / 3;
        const b = new Float32Array(n);
        for (let i = 0; i < n; i++) b[i] = bake(ch.bp[i * 3], ch.bp[i * 3 + 1], ch.bp[i * 3 + 2]) * bakeScale;
        g.setAttribute('bake', new THREE.BufferAttribute(b, 1));
      }
      g.setIndex(ch.idx);
      g.computeBoundingSphere();
      // Leaves sway a few centimetres: pad the bounds.
      const boxes = [...ch.boxes.values()].map((b) => b.expandByScalar(this.o.sway ? 0.1 : 0.01));
      out.push({ chunk, geo: g, boxes });
    }
    this.chunks.clear();
    return out;
  }
}

const _col = new THREE.Color();

// ---- materials ----------------------------------------------------------------------------------------------------

const time = { value: 0 };
const warm = { value: WARM };
/** Distance along -z where the room starts fading into darkness, and where it is darkest (set by buildLibrary). */
const fade = { value: new THREE.Vector2(30, 46) };

interface MatOpts {
  map?: THREE.Texture;
  /** The map is a mask: r = shade, g = gold trim, b = paper (books and cushions). */
  trim?: boolean;
  /**
   * Leaves and flowers: they sway a little (`sway` attribute: the piece's pivot xyz and the vertex's amplitude) and
   * take their self-light from the `lit` attribute.
   */
  foliage?: boolean;
  /** Takes a flat self-light share from the `lit` attribute (foliage always does). */
  lit?: boolean;
  side?: THREE.Side;
  /** Albedo multiplier far from any lantern (1 = no extra shadow). */
  shadow?: number;
}

/** Soft lit material with the baked lantern light added as warm emissive. Expects a `bake` attribute. */
function libMaterial(key: string, o: MatOpts = {}) {
  const m = new THREE.MeshLambertMaterial({ map: o.map ?? null, vertexColors: true, side: o.side ?? THREE.FrontSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.uniforms.uWarm = warm;
    sh.uniforms.uFade = fade;
    let vs = 'attribute float bake;\nvarying float vBake;\nvarying float vWz;\nvarying float vLit;\nuniform float uTime;\n';
    if (o.foliage) vs += 'attribute vec4 sway;\n';
    if (o.foliage || o.lit) vs += 'attribute float lit;\n';
    vs += sh.vertexShader;
    let begin = '#include <begin_vertex>\n\tvBake = bake;';
    begin += o.foliage || o.lit ? '\n\tvLit = lit;' : '\n\tvLit = 0.0;';
    if (o.foliage)
      begin += `
	transformed.x += sin( uTime * 1.3 + sway.x * 0.9 + sway.z * 0.6 + sway.y * 1.7 ) * 0.07 * sway.w;
	transformed.z += cos( uTime * 1.05 + sway.z * 0.8 + sway.x * 0.4 ) * 0.05 * sway.w;`;
    vs = vs.replace('#include <begin_vertex>', begin);
    vs = vs.replace('#include <project_vertex>', '#include <project_vertex>\n\tvWz = ( modelMatrix * vec4( transformed, 1.0 ) ).z;');
    sh.vertexShader = vs;
    let fs = 'varying float vBake;\nvarying float vWz;\nvarying float vLit;\nuniform vec3 uWarm;\nuniform vec2 uFade;\n' + sh.fragmentShader;
    if (o.trim)
      fs = fs.replace('#include <color_fragment>', '').replace(
        '#include <map_fragment>',
        `#include <color_fragment>
#ifdef USE_MAP
	// u < 0 marks untextured pieces (constant over each triangle, so the branch never splits a pixel quad).
	if ( vMapUv.x >= 0.0 ) {
		vec4 tx = texture2D( map, vMapUv );
		diffuseColor.rgb = mix( diffuseColor.rgb * tx.r, vec3( 0.58, 0.38, 0.13 ) * ( 0.75 + 0.35 * tx.r ), tx.g );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.66, 0.56, 0.40 ) * tx.r, tx.b );
	}
#endif`,
      );
    fs = fs.replace(
      '#include <emissivemap_fragment>',
      // Deep shadow away from the lanterns, warm light near them, and the far end sinking into darkness.
      `#include <emissivemap_fragment>
	float farF = smoothstep( uFade.x, uFade.y, -vWz );
	float litF = clamp( vBake * 2.4, 0.0, 1.0 );
	diffuseColor.rgb *= mix( ${(o.shadow ?? 0.8).toFixed(3)}, 1.0, litF ) * ( 1.0 - 0.85 * farF );
	totalEmissiveRadiance += diffuseColor.rgb * ( vBake * uWarm * ( 1.0 - 0.3 * farF ) + vLit * ( 1.0 - farF ) );
	#ifdef USE_MAP
		// Unlit pieces (u = -2): the vertex colour is the light (lantern glass, flames, the globe's core).
		if ( vMapUv.x < -1.5 ) {
			totalEmissiveRadiance = vColor.rgb;
			diffuseColor.rgb = vec3( 0.0 );
		}
	#endif`,
    );
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => `library-${key}`;
  return m;
}

// ---- textures -----------------------------------------------------------------------------------------------------

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Width of the atlas taken by the book columns (the cushion mask fills the rest). */
const ATLAS_BOOKS = 320 / 448;
/** Height share of the atlas taken by the painted run of spines at the bottom (the rest is books and cushions). */
const ATLAS_V0 = 128 / 384;

/**
 * Atlas 448x256. Books (u 0..320 px): four spine patterns (columns 0-3), then paper (top half) and plain cover (bottom
 * half). Then the cushion mask (128x128, top right; repeated below so mip levels never blend in anything else). Below
 * all that (448x128, v < ATLAS_V0), a painted run of ten book spines of uneven height for the cheap distant shelves.
 */
function bookAtlas() {
  const W = 320;
  const H = 256;
  const c = canvas(448, H + 128);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const rnd = mulberry32(7);
  const noise = new Float32Array(W * H);
  for (let i = 0; i < noise.length; i++) noise[i] = rnd();
  for (let y = 0; y < H; y++) {
    const v = 1 - y / H; // canvas top = v 1
    for (let x = 0; x < W; x++) {
      const col = Math.floor(x / 64);
      const u = (x % 64) / 63;
      let r = 0;
      let g = 0;
      let b = 0;
      if (col < 4) {
        // Rounded spine shading, fine leather noise.
        r = (0.62 + 0.38 * Math.sin(Math.PI * (0.08 + u * 0.84))) * (0.93 + 0.07 * noise[y * W + x]);
        const band = (v0: number, v1: number) => v >= v0 && v <= v1;
        const ridge = (vc: number) => Math.abs(v - vc) < 0.012;
        if (col === 0) {
          if (band(0.86, 0.9) || band(0.1, 0.14) || band(0.79, 0.805) || band(0.195, 0.21)) g = 1;
        } else if (col === 1) {
          if (band(0.82, 0.92) || band(0.08, 0.12)) g = 1;
          if (band(0.45, 0.62) && u > 0.22 && u < 0.78) r *= 1.25; // label
          if ((band(0.45, 0.46) || band(0.61, 0.62)) && u > 0.22 && u < 0.78) g = 1;
        } else if (col === 2) {
          for (const vc of [0.2, 0.36, 0.52, 0.68, 0.84]) if (ridge(vc)) r *= 0.55;
          if (band(0.88, 0.93)) g = 1;
          if (Math.abs(v - 0.6) < 0.05 && Math.abs(u - 0.5) < 0.25 - Math.abs(v - 0.6) * 4) g = 1; // diamond
        } else {
          if (band(0.9, 0.95) || band(0.05, 0.1)) g = 1;
          if (band(0.3, 0.7) && Math.abs(u - 0.5) < 0.08) g = 1; // vertical title stripe
        }
      } else if (v > 0.5) {
        // Paper: cream with page lines.
        b = 1;
        r = 0.86 + 0.1 * noise[y * W + x] - (y % 6 === 0 ? 0.24 : 0);
      } else {
        // Cover: plain leather with a gold frame and a small emblem.
        r = 0.88 + 0.1 * noise[y * W + x];
        const cu = (x - 256) / 63 - 0.5;
        const cv = v / 0.5 - 0.5;
        const e = Math.max(Math.abs(cu), Math.abs(cv));
        if (e > 0.36 && e < 0.4) g = 1;
        const dd = Math.abs(cu) + Math.abs(cv) * 0.8;
        if (dd < 0.13 || (dd > 0.18 && dd < 0.2)) g = 1;
      }
      const i = (y * W + x) * 4;
      img.data[i] = Math.min(255, r * 255);
      img.data[i + 1] = g * 255;
      img.data[i + 2] = b * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const cushion = cushionCanvas();
  ctx.drawImage(cushion, W, 0);
  ctx.drawImage(cushion, W, 128);
  ctx.putImageData(spinesMask(), 0, H);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/** A run of book spines as a mask (r = shade, g = gold bands), 448x128: dark gaps above the shorter books. */
function spinesMask() {
  const W = 448;
  const H = 128;
  const img = new ImageData(W, H);
  const rnd = mulberry32(19);
  let x0 = 0;
  while (x0 < W) {
    const w = Math.min(W - x0, Math.round(30 + rnd() * 22));
    const top = Math.round(rnd() * 34); // rows of shadow above the book
    const shade = 0.72 + rnd() * 0.36;
    const b1 = top + 8 + Math.round(rnd() * 6);
    const b2 = H - 12 - Math.round(rnd() * 6);
    const label = rnd() < 0.5;
    for (let y = 0; y < H; y++)
      for (let x = x0; x < x0 + w; x++) {
        const u = (x - x0) / (w - 1);
        let r = 0.12;
        let g = 0;
        if (y >= top && u > 0.04 && u < 0.96) {
          r = shade * (0.6 + 0.4 * Math.sin(Math.PI * (0.08 + u * 0.84)));
          if (Math.abs(y - b1) < 2 || Math.abs(y - b2) < 2) g = 1;
          if (label && y > top + (H - top) * 0.4 && y < top + (H - top) * 0.55 && u > 0.25 && u < 0.75) r *= 1.25;
        }
        const i = (y * W + x) * 4;
        img.data[i] = Math.min(255, r * 255);
        img.data[i + 1] = g * 255;
        img.data[i + 3] = 255;
      }
    x0 += w;
  }
  return img;
}

/** Cushion mask 128x128: r = shade (puffy vignette), g = gold border and star motif. */
function cushionCanvas() {
  const S = 128;
  const c = canvas(S, S);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / (S - 1) - 0.5;
      const v = y / (S - 1) - 0.5;
      const r = 0.78 + 0.22 * (1 - Math.min(1, (u * u + v * v) * 3));
      const edge = Math.max(Math.abs(u), Math.abs(v));
      let g = edge > 0.36 && edge < 0.39 ? 1 : 0;
      // Eight-pointed star in the middle.
      const a = Math.atan2(v, u);
      const d = Math.hypot(u, v);
      const star = 0.1 + 0.07 * Math.pow(Math.abs(Math.cos(a * 4)), 3);
      if (d < star) g = 1;
      // Small diamonds in the corners.
      for (const [cu, cv] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]])
        if (Math.abs(u - cu) + Math.abs(v - cv) < 0.05) g = 1;
      const i = (y * S + x) * 4;
      img.data[i] = r * 255;
      img.data[i + 1] = g * 255;
      img.data[i + 2] = 0;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Night sky for the windows: deep blue gradient with stars. */
function skyTexture() {
  const c = canvas(256, 512);
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#071433');
  grad.addColorStop(0.55, '#123070');
  grad.addColorStop(1, '#2d5fa8');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 512);
  const rnd = mulberry32(11);
  for (let i = 0; i < 26; i++) {
    // soft clouds of light near the bottom
    const x = rnd() * 256;
    const y = 300 + rnd() * 220;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 40 + rnd() * 50);
    g.addColorStop(0, 'rgba(120,160,230,0.12)');
    g.addColorStop(1, 'rgba(120,160,230,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 512);
  }
  for (let i = 0; i < 170; i++) {
    const x = rnd() * 256;
    const y = rnd() * 512;
    const s = rnd() < 0.1 ? 2.2 : 0.6 + rnd() * 1.1;
    ctx.fillStyle = `rgba(255,${235 + rnd() * 20},${200 + rnd() * 55},${0.5 + rnd() * 0.5})`;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
    if (s > 2) {
      ctx.strokeStyle = 'rgba(255,245,220,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 7, y);
      ctx.lineTo(x + 7, y);
      ctx.moveTo(x, y - 7);
      ctx.lineTo(x, y + 7);
      ctx.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---- geometry -----------------------------------------------------------------------------------------------------

/** Sets a box face's uvs to a rectangle of the atlas. Face order: +x, -x, +y, -y, +z, -z. */
function boxUv(g: THREE.BufferGeometry, face: number, u0: number, v0: number, u1: number, v1: number) {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = face * 4; i < face * 4 + 4; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
}

/** A book standing on its bottom: thickness along x, height y, depth z, spine at +z. Origin bottom centre. */
function bookGeometry(onShelf = false) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // Reset to 0..1 per face first (BoxGeometry already is), then map.
  boxUv(g, 0, 0.8, 0.0, 1.0, 0.5); // covers
  boxUv(g, 1, 0.8, 0.0, 1.0, 0.5);
  boxUv(g, 2, 0.8, 0.5, 1.0, 1.0); // pages
  boxUv(g, 3, 0.8, 0.5, 1.0, 1.0);
  boxUv(g, 4, 0.0, 0.0, 0.2, 1.0); // spine
  boxUv(g, 5, 0.8, 0.5, 1.0, 1.0); // fore edge
  uv.needsUpdate = true;
  g.translate(0, 0.5, 0);
  // Drop the bottom face (always on a shelf or a book): 10 triangles a book. Books on a shelf also never show their
  // fore edge (against the back panel): 8 triangles.
  const idx = Array.from(g.index!.array);
  g.setIndex(idx.slice(0, 18).concat(idx.slice(24, onShelf ? 30 : 36)));
  g.clearGroups();
  return g;
}

/** An open book lying on the floor: cover under two slightly raised page blocks. ~1 unit wide, 0.7 deep. */
function openBookGeometry() {
  const cover = new THREE.BoxGeometry(1.1, 0.03, 0.78);
  for (let f = 0; f < 6; f++) boxUv(cover, f, 0.8, 0.0, 1.0, 0.5);
  cover.translate(0, 0.015, 0);
  const pages = [-1, 1].map((s) => {
    const p = new THREE.BoxGeometry(0.47, 0.06, 0.64);
    for (let f = 0; f < 6; f++) boxUv(p, f, 0.8, 0.5, 1.0, 1.0);
    p.rotateZ(s * -0.12);
    p.translate(s * 0.245, 0.06, 0);
    return p;
  });
  const g = mergeGeometries([cover, ...pages])!;
  cover.dispose();
  pages.forEach((p) => p.dispose());
  return g;
}

/** A plump square cushion, ~1 unit across, 0.36 tall, uvs from above. */
function cushionGeometry() {
  const g = new THREE.SphereGeometry(0.5, 10, 7);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i) * 2;
    let z = pos.getZ(i) * 2;
    const y = pos.getY(i) * 2;
    x = Math.sign(x) * Math.pow(Math.abs(x), 0.45);
    z = Math.sign(z) * Math.pow(Math.abs(z), 0.45);
    const puff = 1 - 0.55 * Math.max(x * x, z * z);
    pos.setXYZ(i, x * 0.5, (y * 0.2 * puff + 0.19) * 0.95, z * 0.5);
    uv.setXY(i, (x + 1) / 2, (1 - z) / 2);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * A leaf with a centre fold, length 1 along +y, normal +z, vertex-shaded darker at the base. `heart`: two round lobes
 * either side of the stem notch (4 triangles, for the big leaves on the floor strip); otherwise a plain pointed leaf
 * (2 triangles, for the small ivy on the walls, where the lobes would be under a pixel anyway).
 */
function leafGeometry(heart: boolean) {
  const P = heart ? [
    [0, 0.1, 0], // stem notch
    [0.34, 0.0, 0.05], // right lobe
    [0.5, 0.4, 0.09], // right shoulder
    [0, 1, 0], // tip
    [-0.5, 0.4, 0.09],
    [-0.34, 0.0, 0.05],
  ] : [
    [0, 0, 0],
    [0.46, 0.4, 0.08],
    [0, 1, 0],
    [-0.46, 0.4, 0.08],
  ];
  // Triangles fanned from the base, the right half a bit brighter.
  const tris = heart ? [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 4],
    [0, 4, 5],
  ] : [
    [0, 1, 2],
    [0, 2, 3],
  ];
  const pos: number[] = [];
  const col: number[] = [];
  for (const t of tris)
    for (const k of t) {
      pos.push(...P[k]);
      const s = (0.62 + 0.38 * P[k][1]) * (P[k][0] > 0 ? 1.1 : 1);
      col.push(s, s, s);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  // Normals of a folded leaf: just point them out of the leaf plane.
  const n = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 0.25, 1);
  return g;
}

/** Five white petals around a yellow centre, flat in the xz plane facing up, radius 1. */
function flowerGeometry() {
  const pos: number[] = [];
  const col: number[] = [];
  const white = [1, 1, 0.95];
  const yellow = [1, 0.75, 0.2];
  const push = (x: number, y: number, z: number, c: number[]) => {
    pos.push(x, y, z);
    col.push(...c);
  };
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const pt = (r: number, w: number): [number, number] => [ca * r - sa * w, sa * r + ca * w];
    // A pointed rhombus petal: a star-shaped flower like the little white jasmine stars of the reference.
    const c0 = pt(0.05, 0);
    const r = pt(0.55, -0.4);
    const l = pt(0.55, 0.4);
    const tip = pt(1.0, 0);
    const cream = [0.95, 0.9, 0.78];
    push(c0[0], 0.02, c0[1], cream);
    push(l[0], 0.07, l[1], white);
    push(r[0], 0.07, r[1], white);
    push(r[0], 0.07, r[1], white);
    push(l[0], 0.07, l[1], white);
    push(tip[0], 0.1, tip[1], white);
  }
  push(0, 0.12, 0.25, yellow);
  push(0.22, 0.12, -0.13, yellow);
  push(-0.22, 0.12, -0.13, yellow);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 0; i < nrm.length; i += 3) nrm[i + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/**
 * An octagon around the unit circle (a triangle fan, 6 triangles): a round falloff wastes 17% fewer pixels in it than
 * in a square. `(a, b)` are the two coordinates it spans.
 */
function octagon(plane: 'xy' | 'xz') {
  const pos: number[] = [];
  const r = 1 / Math.cos(Math.PI / 8);
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    const u = Math.cos(a) * r;
    const v = Math.sin(a) * r;
    if (plane === 'xy') pos.push(u, v, 0);
    else pos.push(u, 0, -v);
  }
  const idx: number[] = [];
  for (let k = 1; k < 7; k++) idx.push(0, k, k + 1);
  return { pos, idx };
}

/**
 * Outputs below this never change a pixel: the canvas is 8-bit and these shaders write raw values with additive
 * blending, so anything under half a step rounds away. Quads shrink to the radius where their falloff drops below it.
 */
const GLOW_FLOOR = 0.4 / 255;

/** Camera-facing additive glow quads; flicker per instance in the vertex shader. */
function glowMesh(centers: number[], data: number[]) {
  const g = new THREE.InstancedBufferGeometry();
  const oct = octagon('xy');
  g.setAttribute('position', new THREE.Float32BufferAttribute(oct.pos, 3));
  g.setIndex(oct.idx);
  g.setAttribute('center', new THREE.InstancedBufferAttribute(new Float32Array(centers), 3));
  g.setAttribute('gdata', new THREE.InstancedBufferAttribute(new Float32Array(data), 4));
  g.instanceCount = centers.length / 3;
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: time },
    vertexShader: /* glsl */ `
      attribute vec3 center;
      attribute vec4 gdata; // size, phase, intensity, hue (0 warm lamp, 1 candle)
      uniform float uTime;
      varying vec2 vUv;
      varying float vI;
      varying float vHue;
      void main() {
        float ph = gdata.y;
        float f = 0.86 + 0.08 * sin( uTime * 6.3 + ph ) + 0.06 * sin( uTime * 14.7 + ph * 2.7 ) * ( 0.5 + 0.5 * sin( uTime * 0.9 + ph ) );
        vec4 mv = modelViewMatrix * vec4( center, 1.0 );
        float s = gdata.x * ( 0.94 + 0.08 * f );
        // The halo term (1 - d)^2 * 0.55 * intensity fades out before the quad's edge: stop where it can no longer
        // change a pixel (the core term is long gone there).
        float rv = clamp( 1.0 - sqrt( ${GLOW_FLOOR.toFixed(6)} / ( 0.55 * gdata.z ) ), 0.3, 1.0 );
        mv.xy += position.xy * s * rv;
        mv.z += s * 0.7;
        gl_Position = projectionMatrix * mv;
        vUv = position.xy * rv;
        vI = gdata.z * f;
        vHue = gdata.w;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vI;
      varying float vHue;
      void main() {
        float d = length( vUv );
        if ( d >= 1.0 ) discard;
        float a = 1.0 - d;
        float a2 = a * a;
        float a4 = a2 * a2;
        float halo = a2 * 0.55;
        float core = a4 * a4 * a2 * 1.6;
        vec3 col = mix( vec3( 1.0, 0.62, 0.24 ), vec3( 1.0, 0.72, 0.36 ), vHue );
        gl_FragColor = vec4( ( col * halo + vec3( 1.0, 0.9, 0.7 ) * core ) * vI, 1.0 );
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

/** Warm additive light pools lying on the floor under lanterns and candles (one draw call, gentle flicker). */
function poolMesh(data: number[]) {
  const g = new THREE.InstancedBufferGeometry();
  const oct = octagon('xz');
  g.setAttribute('position', new THREE.Float32BufferAttribute(oct.pos, 3));
  g.setIndex(oct.idx);
  g.setAttribute('pool', new THREE.InstancedBufferAttribute(new Float32Array(data), 4)); // x, z, radius, intensity
  g.instanceCount = data.length / 4;
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: time, uFade: fade },
    vertexShader: /* glsl */ `
      attribute vec4 pool;
      uniform float uTime;
      uniform vec2 uFade;
      varying vec2 vUv;
      varying float vI;
      void main() {
        float ph = pool.x * 1.3 + pool.y * 0.7;
        float f = 0.9 + 0.06 * sin( uTime * 5.1 + ph ) + 0.04 * sin( uTime * 11.3 + ph * 2.1 );
        vI = pool.w * f * ( 1.0 - 0.6 * smoothstep( uFade.x, uFade.y, -pool.y ) );
        // Falloff (1 - d)^2 * intensity: stop where it can no longer change a pixel.
        float rv = clamp( 1.0 - sqrt( ${GLOW_FLOOR.toFixed(6)} / pool.w ), 0.3, 1.0 );
        vUv = position.xz * rv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( pool.x + vUv.x * pool.z, 0.03, pool.y + vUv.y * pool.z, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vI;
      void main() {
        float d = length( vUv );
        if ( d >= 1.0 ) discard;
        float a = 1.0 - d;
        gl_FragColor = vec4( vec3( 1.0, 0.6, 0.26 ) * a * a * vI, 1.0 );
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.renderOrder = 9;
  return mesh;
}

// ---- the library --------------------------------------------------------------------------------------------------

interface LightSpot {
  x: number;
  y: number;
  z: number;
  i: number;
  r: number;
}

export function buildLibrary(scene: THREE.Scene, opts: LibraryOptions): Library {
  const rng = mulberry32(20261024);
  const R = (a = 0, b = 1) => a + (b - a) * rng();
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(rng() * arr.length)];
  const jitter = (hex: number, l = 0.08, h = 0.015) => {
    const c = new THREE.Color(hex);
    c.offsetHSL(R(-h, h), R(-0.05, 0.05), R(-l, l));
    return c;
  };

  const halfW = opts.width / 2;
  const wallX = halfW + STRIP;
  const zNear = opts.lineZ + NEAR_EXTRA;
  const zBack = opts.lineZ - opts.length - FAR_GAP;
  const sideLen = zNear - zBack;
  fade.value.set(-(opts.lineZ - opts.length * 0.72), -(zBack - 5));

  // Primitives (unit sized).
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 6);
  const cyl12 = new THREE.CylinderGeometry(1, 1, 1, 9);
  const cone = new THREE.ConeGeometry(1, 1, 6);
  const hemi = new THREE.SphereGeometry(1, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  const ball = new THREE.SphereGeometry(1, 10, 7);
  const dot = new THREE.SphereGeometry(1, 4, 2);
  const ring = new THREE.TorusGeometry(1, 0.06, 4, 24);
  const bookGeo = bookGeometry();
  const shelfBookGeo = bookGeometry(true);
  const openBookGeo = openBookGeometry();
  const cushionGeo = cushionGeometry();
  const leafGeo = leafGeometry(true);
  const ivyGeo = leafGeometry(false);
  const flowerGeo = flowerGeometry();
  const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);

  // 'low' (phones, weak machines) thins the foliage and the faintest glows. The thinning draws from its own random
  // stream, so the room's layout is the same on both tiers.
  const low = detectQuality() === 'low';
  const thinRng = mulberry32(4242);
  const keep = (p: number) => !low || thinRng() < p;

  // Everything solid (wood, brass, books, cushions, lantern glass) shares one material, so each chunk is one draw.
  const solid = new Bag({ uv: true, lit: true });
  const skyBag = new Bag({ uv: true, single: true });
  const foliage = new Bag({ sway: true, doubleSided: true });
  const lights: LightSpot[] = [];
  const glowC: number[] = [];
  const glowD: number[] = [];

  // Chunks, frustum culled as a whole (see `cull` below): the shelves of the side walls in four bands along z, the
  // floor strips in front of them in two, the far wall with its strip. A portrait phone looks down from so high that it
  // sees no shelf near the defenders; a landscape screen never sees the far end.
  const WALL_BANDS = [opts.lineZ - 7, opts.lineZ - 14, opts.lineZ - 26];
  const STRIP_BAND = opts.lineZ - 24;
  /** 0 = left wall, 1 = right wall, 2 = far wall (and the corners). */
  let side = 0;
  /** 0 = shelves (the wall itself), 1 = props on the floor strip in front of it. */
  let layer = 0;
  const chunkAt = (z: number) => {
    if (side === 2) return layer === 0 ? 3 : 5;
    if (layer === 1) return z > STRIP_BAND ? 4 : 5;
    return z > WALL_BANDS[0] ? 0 : z > WALL_BANDS[1] ? 1 : z > WALL_BANDS[2] ? 2 : 3;
  };

  const W = new THREE.Matrix4();
  /** world = W * local */
  const at = (m: THREE.Matrix4) => _w.multiplyMatrices(W, m);
  /** Adds a piece to a bag in the current wall frame. */
  const piece = (bag: Bag, geo: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color | number, x?: AddOpts) => {
    const w = at(m);
    // Solid pieces get a flat share of ambient light: more on the walls, so the shelves read mid-brown, not black.
    const xo = bag === solid && x?.lit === undefined ? { ...x, lit: layer === 0 ? wallAmbient : AMBIENT_STRIP } : x;
    bag.add(geo, w, color, chunkAt(w.elements[14]), side, xo);
  };
  const toWorld = (x: number, y: number, z: number) => _v.set(x, y, z).applyMatrix4(W);

  /** Glow energy (size^2 x intensity) placed per metre of each wall, for GLOW_CAP. */
  const glowLoad = new Map<number, number>();
  /**
   * An additive camera-facing glow. `capped` glows (candles) are left out where the metre of wall around them already
   * glows enough, so clusters of props never stack into a blown-out band.
   */
  const glow = (x: number, y: number, z: number, size: number, intensity: number, hue: number, keepP = 1, capped = false) => {
    const p = toWorld(x, y, z);
    const ph = rng() * 100;
    const key = side * 1000 + Math.floor(side === 2 ? p.x : p.z);
    const load = glowLoad.get(key) ?? 0;
    const e = size * size * intensity;
    if (capped && load + e > GLOW_CAP) return;
    if (!keep(keepP)) return;
    glowLoad.set(key, load + e);
    glowC.push(p.x, p.y, p.z);
    glowD.push(size, ph, intensity, hue);
  };
  const light = (x: number, y: number, z: number, i: number, r: number) => {
    const p = toWorld(x, y, z);
    lights.push({ x: p.x, y: p.y, z: p.z, i, r });
  };
  const poolD: number[] = [];
  const pool = (x: number, z: number, r: number, i: number) => {
    const p = toWorld(x, 0, z);
    poolD.push(p.x, p.z, r, i);
  };
  /** Flat light share for solid wall pieces being added (see AMBIENT_*). */
  let wallAmbient = AMBIENT_WALL;
  /** Depth of the floor strip in front of the wall being built. */
  let strip = STRIP;

  // -- props, all in the current wall frame (x along, y up, z towards the field) --

  /** A brass lantern standing at (x, y, z), about 0.6 s tall, glass glowing. */
  const lantern = (x: number, y: number, z: number, s: number, hanging = false) => {
    const brass = jitter(BRASS, 0.05);
    const dark = jitter(BRASS_DARK, 0.05);
    piece(solid, cyl, local(x, y + 0.03 * s, z, 0, 0, 0, 0.17 * s, 0.06 * s, 0.17 * s), dark);
    piece(solid, cyl, local(x, y + 0.2 * s, z, 0, 0.4, 0, 0.09 * s, 0.26 * s, 0.09 * s), 0xffb85a, { tex: 'unlit' });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      piece(solid, box, local(x + Math.cos(a) * 0.12 * s, y + 0.2 * s, z + Math.sin(a) * 0.12 * s, 0, -a, 0, 0.05 * s, 0.3 * s, 0.05 * s), dark);
    }
    piece(solid, cone, local(x, y + 0.42 * s, z, 0, 0.4, 0, 0.18 * s, 0.16 * s, 0.18 * s), brass);
    piece(solid, box, local(x, y + 0.54 * s, z, 0, 0.4, 0, 0.1 * s, 0.07 * s, 0.03 * s), dark);
    if (hanging) piece(solid, box, local(x, y + 0.6 * s + 0.25, z, 0, 0, 0, 0.02, 0.5, 0.02), dark);
    // A small warm halo and a bright core: the lantern itself stays readable.
    glow(x, y + 0.22 * s, z, 1.1 * Math.min(s, 1.3), 0.16, 0);
    glow(x, y + 0.22 * s, z, 0.36 * s, 0.5, 1);
    light(x, y + 0.25 * s, z, 0.32, 2.4 * Math.min(1.5, s));
    if (y + 0.25 * s < 2 && z < strip - 0.5) pool(x, z, Math.min(1.1 + s * 0.5, strip + 0.3 - z), 0.14);
  };

  const candle = (x: number, y: number, z: number, h: number, s: number) => {
    piece(solid, cyl, local(x, y + h / 2, z, 0, 0, 0, 0.05 * s, h, 0.05 * s), jitter(0xeee0c0, 0.04));
    piece(solid, cone, local(x, y + h + 0.05 * s, z, 0, 0, 0, 0.03 * s, 0.1 * s, 0.03 * s), 0xffd27a, { tex: 'unlit' });
    glow(x, y + h + 0.06 * s, z, 0.35 * s, 0.4, 1, 1, true);
    light(x, y + h + 0.05, z, 0.22, 1.4);
  };

  /** Two or three candles on a brass tray. */
  const candles = (x: number, z: number, y = 0, s = 1) => {
    piece(solid, cyl12, local(x, y + 0.02 * s, z, 0, 0, 0, 0.24 * s, 0.04 * s, 0.24 * s), jitter(BRASS));
    const n = 2 + Math.floor(R(0, 2));
    for (let k = 0; k < n; k++) candle(x + R(-0.12, 0.12) * s, y + 0.04 * s, z + R(-0.12, 0.12) * s, R(0.12, 0.38) * s, s);
    glow(x, y + 0.3 * s, z, 1.1 * s, 0.07, 0, 0.5, true);
    if (y < 1 && z < strip - 0.5) pool(x, z, Math.min(1.0, strip + 0.3 - z), 0.12);
  };

  /** A little group of red toadstools with white dots, ~0.3 tall. */
  const mushrooms = (x: number, z: number) => {
    const n = 2 + Math.floor(R(0, 2));
    for (let k = 0; k < n; k++) {
      const s = k === 0 ? R(1.5, 1.8) : R(0.9, 1.4);
      const mx = x + (k ? R(-0.3, 0.3) : 0);
      const mz = z + (k ? R(-0.22, 0.22) : 0);
      const h = 0.2 * s;
      piece(solid, cyl, local(mx, h / 2, mz, R(-0.1, 0.1), 0, R(-0.1, 0.1), 0.045 * s, h, 0.045 * s), jitter(0xeadcc0, 0.04));
      piece(solid, hemi, local(mx, h - 0.02, mz, 0, 0, 0, 0.15 * s, 0.075 * s, 0.15 * s), jitter(0xb03a28, 0.05));
      for (let d = 0; d < 2; d++) {
        const a = R(0, Math.PI * 2);
        const rr = R(0.02, 0.1) * s;
        piece(solid, dot, local(mx + Math.cos(a) * rr, h - 0.02 + 0.07 * s * Math.sqrt(Math.max(0, 1 - (rr / (0.15 * s)) ** 2)), mz + Math.sin(a) * rr, 0, 0, 0, 0.022 * s, 0.01 * s, 0.022 * s), 0xfff4e0);
      }
    }
  };

  /** A book lying flat with its centre at (cx, cy, cz), yaw about y. */
  const lyingBook = (cx: number, cy: number, cz: number, yaw: number, h: number, t: number, d: number) => {
    const ox = cx + (h / 2) * Math.cos(yaw);
    const oz = cz - (h / 2) * Math.sin(yaw);
    const m = local(ox, cy, oz, 0, yaw, Math.PI / 2, t, h, d);
    const c = jitter(pick(BOOK_COLORS));
    piece(solid, bookGeo, m, c, { pivot: true, tex: 'atlas', uvShift: Math.floor(R(0, 4)) });
  };

  const bookStack = (x: number, z: number, y0 = 0, maxN = 7, s = 1) => {
    const n = 2 + Math.floor(R(0, maxN - 1));
    const baseYaw = R(-0.5, 0.5);
    let y = y0;
    let w = R(0.62, 0.82) * s;
    for (let k = 0; k < n; k++) {
      const t = R(0.08, 0.14) * s;
      w = Math.max(0.4 * s, w - R(0, 0.06) * s);
      lyingBook(x + R(-0.04, 0.04) * s, y + t / 2, z + R(-0.04, 0.04) * s, baseYaw + R(-0.2, 0.2), w, t, w * R(0.66, 0.8));
      y += t;
    }
    return y;
  };

  /** An open book lying on its back, about 0.62 s wide. */
  const openBook = (x: number, z: number, y = 0, s = 1) => {
    const m = local(x, y, z, 0, R(-0.45, 0.45) + Math.PI, 0, 0.62 * s, 1, 0.62 * s);
    piece(solid, openBookGeo, m, jitter(pick(BOOK_COLORS)), { pivot: true, tex: 'atlas' });
  };

  /** A plump square cushion with a gold border and star, s units across. */
  const cushion = (x: number, z: number, y = 0, s = R(0.75, 1.05)) => {
    const m = local(x, y, z, R(-0.04, 0.04), R(-0.5, 0.5), R(-0.04, 0.04), s, s, s);
    piece(solid, cushionGeo, m, jitter(pick(CUSHION_COLORS), 0.06), { pivot: true, tex: 'cushion' });
    return y + 0.34 * s;
  };

  const leaf = (x: number, y: number, z: number, rx: number, ry: number, rz: number, s: number) => {
    _e.set(rx, ry, rz, 'YXZ');
    _q.setFromEuler(_e);
    _l.compose(_p.set(x, y, z), _q, _s.set(s * 0.85, s, s));
    _e.order = 'XYZ';
    const c = jitter(pick(LEAF_COLORS), 0.06, 0.02);
    if (keep(layer === 0 ? LOW_KEEP.wallLeaf : LOW_KEEP.stripLeaf)) piece(foliage, layer === 0 ? ivyGeo : leafGeo, _l, c, { pivot: true, lit: layer === 0 ? 0.22 : 0.2 });
  };

  const flower = (x: number, y: number, z: number, s: number, tiltX = 0, tiltZ = 0) => {
    const m = local(x, y, z, tiltX, R(0, 6.3), tiltZ, s, s, s);
    const c = jitter(0xfffaf0, 0.03, 0.01);
    if (keep(LOW_KEEP.flower)) piece(foliage, flowerGeo, m, c, { pivot: true, lit: 0.3 });
  };
  /** A tight bunch of white five-petal stars (the reference groups them, it does not sprinkle them). */
  const flowerCluster = (x: number, y: number, z: number, n: number, tiltX: number, s = 1) => {
    const wall = tiltX > 0.5;
    for (let k = 0; k < n; k++) {
      const a = R(0, Math.PI * 2);
      const r = R(0.04, 0.17) * s;
      const dx = Math.cos(a) * r;
      const dd = Math.sin(a) * r;
      flower(x + dx, y + (wall ? dd : R(0, 0.05)), z + (wall ? R(0, 0.05) : dd), R(0.1, 0.15) * s, tiltX + R(-0.3, 0.3), R(-0.3, 0.3));
    }
  };

  /** A round bush of big heart leaves with white flowers on top. */
  const bush = (x: number, z: number, size: number, flowersN = 2) => {
    const n = Math.round(12 * size * size + 6);
    for (let k = 0; k < n; k++) {
      const yaw = R(0, Math.PI * 2);
      const tilt = R(0.5, 1.35);
      const r = R(0, 0.25) * size;
      leaf(x + Math.sin(yaw) * r, R(0, 0.35) * size, z + Math.cos(yaw) * r, tilt, yaw, R(-0.3, 0.3), R(0.4, 0.52) * (0.75 + 0.25 * size));
    }
    for (let k = 0; k < flowersN; k++) {
      const yaw = R(0, Math.PI * 2);
      const r = R(0.1, 0.35) * size;
      flowerCluster(x + Math.sin(yaw) * r, R(0.4, 0.55) * size, z + Math.cos(yaw) * r, 3 + Math.floor(R(0, 2)), 0, 1.5);
    }
  };

  /** A terracotta pot with a fountain of big heart leaves and, now and then, white flowers. */
  const pottedPlant = (x: number, z: number, y = 0, s = 1, flowers = 0) => {
    piece(solid, cyl12, local(x, y + 0.16 * s, z, 0, 0, 0, 0.2 * s, 0.32 * s, 0.2 * s), jitter(0xa45a36, 0.06));
    piece(solid, cyl12, local(x, y + 0.33 * s, z, 0, 0, 0, 0.23 * s, 0.05 * s, 0.23 * s), jitter(0x8e4a2c, 0.05));
    const n = Math.round(12 * s);
    for (let k = 0; k < n; k++) {
      const yaw = (k / n) * Math.PI * 2 + R(-0.3, 0.3);
      leaf(x, y + 0.32 * s, z, R(0.3, 1.3), yaw, R(-0.3, 0.3), R(0.36, 0.46) * (0.55 + 0.45 * s));
    }
    for (let k = 0; k < flowers; k++) {
      const yaw = R(0, Math.PI * 2);
      flowerCluster(x + Math.sin(yaw) * 0.22 * s, y + 0.55 * s, z + Math.cos(yaw) * 0.22 * s, 3, 0, 1.5);
    }
  };

  /** A few books dropped flat on the floor, one maybe propped open. */
  const spill = (x: number, z: number, s = 1) => {
    const n = 2 + Math.floor(R(0, 2));
    for (let k = 0; k < n; k++) {
      const t = R(0.09, 0.13) * s;
      const h = R(0.55, 0.75) * s;
      lyingBook(x + R(-0.4, 0.4) * s, t / 2 + (k > 1 ? t : 0), z + R(-0.25, 0.25) * s, R(-0.8, 0.8), h, t, h * R(0.66, 0.8));
    }
    if (rng() < 0.4) openBook(x + R(-0.3, 0.3), z + R(-0.2, 0.2), 0, R(1.3, 1.5));
  };

  /** One or two plump cushions, an open book or a few books on top now and then. */
  const cushionPile = (x: number, z: number, s = 1.3) => {
    let top = cushion(x, z, 0, s * R(0.95, 1.05));
    if (rng() < 0.5) top = cushion(x + R(-0.1, 0.1), z + R(-0.1, 0.1), top - 0.05, s * R(0.72, 0.82));
    const r = rng();
    if (r < 0.35) openBook(x, z, top - 0.03, 1.25);
    else if (r < 0.55) bookStack(x, z, top - 0.03, 3, 1.2);
  };

  /** A wooden crate with two dark bands; returns its top. */
  const crate = (x: number, z: number, s = 1) => {
    const h = 0.5 * s;
    const w = 0.62 * s;
    const yaw = R(-0.25, 0.25);
    piece(solid, box, local(x, h / 2, z, 0, yaw, 0, w, h, w), jitter(0x7a5030, 0.06));
    for (const f of [0.2, 0.8]) piece(solid, box, local(x, h * f, z, 0, yaw, 0, w + 0.02, 0.06 * s, w + 0.02), jitter(0x4a2e18, 0.04));
    return h;
  };

  const globe = (x: number, z: number, s = 1) => {
    const brass = jitter(BRASS, 0.03);
    piece(solid, cyl12, local(x, 0.04 * s, z, 0, 0, 0, 0.32 * s, 0.08 * s, 0.32 * s), jitter(WOOD_DARK));
    piece(solid, cyl, local(x, 0.45 * s, z, 0, 0, 0, 0.04 * s, 0.8 * s, 0.04 * s), brass);
    const cy = 1.2 * s;
    const rr = 0.42 * s;
    piece(solid, ring, local(x, cy, z, 0, 0, 0.4, rr, rr, rr), brass);
    piece(solid, ring, local(x, cy, z, Math.PI / 2, 0, 0.4, rr, rr, rr), brass);
    piece(solid, ring, local(x, cy, z, Math.PI / 2, Math.PI / 2, 0.4, rr * 0.92, rr * 0.92, rr * 0.92), brass);
    piece(solid, ring, local(x, cy, z, Math.PI / 2, 0.8, 0, rr * 1.12, rr * 1.12, rr * 1.12), jitter(BRASS_DARK));
    piece(solid, ball, local(x, cy, z, 0, 0, 0, 0.12 * s, 0.12 * s, 0.12 * s), 0xffd890, { tex: 'unlit' });
    glow(x, cy, z, 1.1 * s, 0.22, 0);
    light(x, cy, z, 0.4, 2.6);
  };

  /** Low ivy on the floor around a prop's foot; `clusterP` adds a bunch of white stars. */
  const ivyPatch = (cx: number, cz: number, n: number, spread: number, clusterP = 0.3) => {
    for (let k = 0; k < n; k++)
      leaf(cx + R(-spread, spread), R(0.01, 0.12), cz + R(-spread, spread) * 0.6, -Math.PI / 2 + R(0.2, 0.9), R(0, 6.3), 0, R(0.38, 0.5));
    if (rng() < clusterP) flowerCluster(cx + R(-0.3, 0.3) * spread, R(0.1, 0.18), cz, 3 + Math.floor(R(0, 2)), 0, 1.5);
  };

  // -- walls --

  /** Fills one shelf from x0 to x1 with standing books, little stacks and the odd lantern or plant. */
  const fillShelf = (x0: number, x1: number, y0: number, gap: number) => {
    let x = x0;
    let run = 0;
    let runColor = 0;
    let runH = 0;
    while (x < x1 - 0.08) {
      const r = rng();
      if (run <= 0 && r < 0.025 && gap > 0.7 && x1 - x > 0.5) {
        lantern(x + 0.22, y0, -0.32, R(0.85, 1.0));
        x += 0.48;
        continue;
      }
      if (run <= 0 && r < 0.1 && x1 - x > 0.75) {
        const w = R(0.5, 0.7);
        bookStack(x + w / 2 + 0.03, -0.45, y0, 4);
        x += w + 0.08;
        continue;
      }
      if (run <= 0 && r < 0.13 && x1 - x > 0.5) {
        pottedPlant(x + 0.24, -0.4, y0, R(0.65, 0.85));
        x += 0.5;
        continue;
      }
      if (run <= 0 && r < 0.16) {
        x += R(0.1, 0.35);
        continue;
      }
      if (run <= 0 && rng() < 0.3) {
        run = 3 + Math.floor(R(0, 5));
        runColor = pick(BOOK_COLORS);
        runH = R(0.66, 0.9);
      }
      const t = R(0.1, 0.22);
      if (x + t > x1) break;
      const inRun = run > 0;
      const h = gap * (inRun ? runH : R(0.6, 0.93));
      const d = R(0.5, 0.78);
      const lean = rng() < 0.06 && !inRun ? R(-0.2, 0.2) : 0;
      const color = jitter(inRun ? runColor : pick(BOOK_COLORS), inRun ? 0.03 : 0.08);
      const m = local(x + t / 2, y0, -0.05 - d / 2 - R(0, 0.06), 0, 0, lean, t, h, d);
      piece(solid, shelfBookGeo, m, color, { pivot: true, tex: 'atlas', uvShift: inRun ? runColor % 4 : Math.floor(R(0, 4)) });
      x += t + (lean ? 0.06 : R(0, 0.012));
      run--;
    }
  };

  /** Arched window filling a bay from y0 up to just under the cornice, with mullions and a deep sill. */
  const windowBay = (x0: number, x1: number, y0: number) => {
    const cx = (x0 + x1) / 2;
    const r = (x1 - x0) / 2 - 0.02;
    const top = HEIGHT - 0.25;
    const rectH = top - y0 - r;
    const shape = new THREE.Shape();
    shape.moveTo(-r, 0);
    shape.lineTo(r, 0);
    shape.lineTo(r, rectH);
    shape.absarc(0, rectH, r, 0, Math.PI, false);
    shape.lineTo(-r, 0);
    const sg = new THREE.ShapeGeometry(shape, 10);
    const uv = sg.attributes.uv as THREE.BufferAttribute;
    const sp = sg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (sp.getX(i) + r) / (2 * r), sp.getY(i) / (rectH + r));
    piece(skyBag, sg, local(cx, y0, -DEPTH + 0.06), 0xffffff, { tex: 'raw' });
    sg.dispose();
    const fz = -DEPTH + 0.14;
    const frame = jitter(WOOD_EDGE, 0.04);
    piece(solid, box, local(x0 + 0.06, y0 + rectH / 2, fz, 0, 0, 0, 0.14, rectH, 0.16), frame);
    piece(solid, box, local(x1 - 0.06, y0 + rectH / 2, fz, 0, 0, 0, 0.14, rectH, 0.16), frame);
    const arch = new THREE.TorusGeometry(r - 0.04, 0.08, 4, 14, Math.PI);
    piece(solid, arch, local(cx, y0 + rectH, fz), frame);
    arch.dispose();
    piece(solid, box, local(cx, y0 + (rectH + r * 0.9) / 2, fz, 0, 0, 0, 0.08, rectH + r * 0.9, 0.1), frame);
    for (const f of [0.38, 0.75]) piece(solid, box, local(cx, y0 + rectH * f, fz, 0, 0, 0, 2 * r, 0.07, 0.1), frame);
    // Deep sill with a candle or a plant.
    piece(solid, box, local(cx, y0 + 0.04, -DEPTH / 2 + 0.05, 0, 0, 0, x1 - x0, 0.1, DEPTH + 0.1), jitter(WOOD_EDGE, 0.04));
    if (rng() < 0.5) candles(cx + R(-0.4, 0.4), -0.45, y0 + 0.09);
    else pottedPlant(cx + R(-0.4, 0.4), -0.45, y0 + 0.09, 0.8);
  };

  /**
   * Ivy along a curve on the shelf front: a quadratic Bezier from (x0, y0) through the control (cx, cy) to (x1, y1).
   * 6-12 overlapping heart leaves hang tip down along it, alternating sides of the stem; a bunch of stars now and then.
   */
  const vine = (x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, flowerP = 0.3, z0 = 0) => {
    const len = Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy);
    const n = Math.max(6, Math.min(10, Math.round(len / 0.17)));
    const pt = (t: number) => {
      const u = 1 - t;
      return [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1];
    };
    for (let k = 0; k < n; k++) {
      const [x, y] = pt((k + R(0.2, 0.6)) / n);
      const s = k % 2 ? 1 : -1;
      leaf(x + s * 0.05, y, z0 + R(0.1, 0.2), R(-0.8, -0.35), R(-0.3, 0.3), Math.PI + s * R(0.25, 0.7), R(0.23, 0.29));
    }
    if (rng() < flowerP) {
      const [x, y] = pt(R(0.3, 0.9));
      flowerCluster(x, y, z0 + 0.3, 3, Math.PI / 2 - 0.4);
    }
  };

  /** Ivy for one bay hanging from the cornice: a swag across part of it and a few strands, shorter over windows. */
  const bayIvy = (x0: number, x1: number, win: boolean) => {
    const n = 3 + Math.floor(R(0, 2));
    const top = HEIGHT + 0.12;
    const a = R(x0 - 0.1, x0 + 0.5);
    const b = R(x1 - 0.5, x1 + 0.1);
    vine(a, top, (a + b) / 2 + R(-0.3, 0.3), top - R(0.7, win ? 1.0 : 1.4), b, top, 0.35);
    for (let k = 1; k < n; k++) {
      const hx = R(x0, x1);
      const drop = R(0.9, win ? 1.3 : 2.0);
      vine(hx, top, hx + R(-0.35, 0.35), top - drop * 0.5, hx + R(-0.25, 0.25), top - drop, 0.3);
    }
  };

  /** A library ladder leaning on the shelves at x, hooked on the brass rail under the cornice. */
  const ladder = (x: number) => {
    const top = HEIGHT - 0.1;
    const lean = 0.85;
    const ang = Math.atan2(lean, top);
    const len = Math.hypot(lean, top);
    const c = jitter(0x8a5530, 0.04);
    for (const s of [-1, 1]) {
      piece(solid, box, local(x + s * 0.27, top / 2, 0.14 + lean / 2, -ang, 0, 0, 0.07, len, 0.08), c);
      piece(solid, box, local(x + s * 0.27, top + 0.02, 0.1, 0, 0, 0, 0.05, 0.12, 0.12), jitter(BRASS));
    }
    for (let y = 0.35; y < top - 0.1; y += 0.36)
      piece(solid, box, local(x, y, 0.14 + lean * (1 - y / top), 0, 0, 0, 0.54, 0.05, 0.07), c);
  };

  /** A shelf of painted books from x0 to x1 at depth z: one quad per run of spines, each run its own colour. */
  const paintedRow = (x0: number, x1: number, y0: number, gap: number, z: number) => {
    let x = x0;
    while (x < x1 - 0.05) {
      const w = Math.min(x1 - x, R(0.4, 0.9));
      const du = w / 1.7;
      const u0 = R(0, 1 - du);
      piece(solid, quad, local(x + w / 2, y0, z, 0, 0, 0, w, gap, 1), jitter(pick(BOOK_COLORS), 0.06), { tex: 'spines', uvRect: [u0, u0 + du] });
      x += w;
    }
  };

  /** Along the current side wall from x0 to x1, a box cut where the wall chunks meet (tight culling bounds). */
  const span = (x0: number, x1: number, y: number, z: number, h: number, d: number, color: THREE.Color | number) => {
    const cuts = [x0, x1];
    for (const zb of WALL_BANDS) {
      const x = (zb - W.elements[14]) / W.elements[2];
      if (x > x0 && x < x1) cuts.push(x);
    }
    cuts.sort((p, q) => p - q);
    for (let k = 0; k + 1 < cuts.length; k++)
      piece(solid, box, local((cuts[k] + cuts[k + 1]) / 2, y, z, 0, 0, 0, cuts[k + 1] - cuts[k], h, d), color);
  };

  /**
   * Galleries stepping up and back behind a side wall's cornice, like a library several storeys tall: each tier a
   * ledge with a brass rail, then two shelves of painted books (a quad per run of spines, so a whole tier costs a few
   * hundred triangles). They fill wide and ultrawide screens out to the edges, where a lone wall would leave a void,
   * and run well past both ends of the room for the same reason.
   */
  const galleries = () => {
    // Far from the floor lanterns: a little more flat light, so the upper storeys read warm brown, not black.
    wallAmbient = AMBIENT_GALLERY;
    const TD = 2.2;
    const TH = 2.3;
    const toX = (z: number) => (z - W.elements[14]) / W.elements[2];
    const xa = Math.min(toX(opts.lineZ + 40), toX(zBack - 4));
    const xb = Math.max(toX(opts.lineZ + 40), toX(zBack - 4));
    let zFront = -DEPTH;
    for (let k = 0; k < GALLERIES; k++) {
      const base = HEIGHT + 0.44 + k * TH;
      const zf = -(DEPTH + 0.25 + k * TD);
      // Ledge (the roof of the tier below), its front edge and a brass rail.
      span(xa, xb, base - 0.04, (zf + zFront) / 2, 0.08, zFront - zf, jitter(0x3e2a1a, 0.02));
      if (k > 0) {
        span(xa, xb, base - 0.08, zFront - 0.03, 0.16, 0.08, jitter(WOOD_EDGE, 0.03));
        span(xa, xb, base + 0.5, zFront - 0.12, 0.04, 0.04, jitter(BRASS, 0.03));
      }
      span(xa, xb, base + TH / 2, zf - 0.4, TH, 0.1, jitter(WOOD_DARK, 0.02));
      for (const y of [base + 0.04, base + TH / 2]) span(xa, xb, y, zf, 0.08, 0.06, jitter(WOOD_EDGE, 0.03));
      const nb = Math.max(1, Math.round((xb - xa) / BAY));
      const bw = (xb - xa) / nb;
      for (let i = 0; i <= nb; i++) {
        const x = xa + i * bw;
        piece(solid, box, local(x, base + TH / 2, zf - 0.15, 0, 0, 0, 0.2, TH, 0.3), jitter(WOOD_EDGE, 0.04));
        if (i < nb) {
          for (const y of [base + 0.08, base + TH / 2 + 0.04]) paintedRow(x + 0.1, x + bw - 0.1, y, TH / 2 - 0.16, zf - 0.3);
          // Now and then a lantern on the ledge and ivy hanging over it.
          if (rng() < 0.3) {
            // A lamp on the ledge: from this far up a lit pane and its glow are all that reads.
            const lx = x + bw * R(0.3, 0.7);
            piece(solid, box, local(lx, base + 0.22, zf + 0.35, 0, 0.4, 0, 0.16, 0.3, 0.16), 0xffb85a, { tex: 'unlit' });
            piece(solid, cone, local(lx, base + 0.45, zf + 0.35, 0, 0.4, 0, 0.16, 0.14, 0.16), jitter(BRASS_DARK));
            glow(lx, base + 0.24, zf + 0.35, 1.0, 0.14, 0);
            light(lx, base + 0.3, zf + 0.35, 0.35, 2.4);
          }
          if (k === 0 && rng() < 0.4) {
            const hx = x + bw * R(0.2, 0.8);
            vine(hx, base + 0.02, hx + R(-0.3, 0.3), base - 0.5, hx + R(-0.2, 0.2), base - R(0.6, 1.1), 0.2);
          }
        }
      }
      zFront = zf;
    }
    // Roof over the top tier.
    wallAmbient = AMBIENT_WALL;
    span(xa, xb, HEIGHT + 0.4 + GALLERIES * TH, zFront - 10, 0.08, 20, jitter(0x3a2414, 0.02));
  };

  interface WallExtras {
    /** Where ladders lean on the wall (x along it; moved to the next bay without a window). */
    ladders?: number[];
    /** x of a brass globe on the floor strip. */
    globe?: number;
  }

  /**
   * One wall of shelves along the current frame from x = 0 to `len`, with a floor strip `depth` deep in front.
   * `windows(bay, nb)` says which bays are windows.
   */
  const buildWall = (len: number, depth: number, windows: (j: number, nb: number) => boolean, ends: boolean, extras: WallExtras = {}) => {
    layer = 0;
    strip = depth;
    const wood = (l = 0.06) => jitter(WOOD, l);
    // The pieces running the whole length are cut where the chunks meet, so each chunk keeps tight bounds.
    const cuts = [0, len];
    if (side !== 2)
      for (const zb of WALL_BANDS) {
        const x = (zb - W.elements[14]) / W.elements[2];
        if (x > 0 && x < len) cuts.push(x);
      }
    cuts.sort((p, q) => p - q);
    /** A box along the whole wall; `ext` sticks out past both ends. */
    const long = (y: number, z: number, h: number, d: number, color: THREE.Color | number, ext = 0) => {
      for (let k = 0; k + 1 < cuts.length; k++) {
        const a = cuts[k] - (k === 0 ? ext : 0);
        const b = cuts[k + 1] + (k + 2 === cuts.length ? ext : 0);
        piece(solid, box, local((a + b) / 2, y, z, 0, 0, 0, b - a, h, d), color);
      }
    };
    long(HEIGHT / 2, -DEPTH - 0.05, HEIGHT, 0.1, jitter(WOOD_DARK, 0.02));
    long(0.25, -DEPTH / 2, 0.5, DEPTH, jitter(0x4a2c18, 0.02));
    long(0.06, 0.02, 0.12, 0.06, jitter(0x3a2414, 0.02));
    long(HEIGHT + 0.16, -DEPTH / 2 + 0.12, 0.32, DEPTH + 0.34, jitter(0x5c3a20, 0.02));
    long(HEIGHT + 0.38, -DEPTH / 2 + 0.06, 0.12, DEPTH + 0.5, jitter(0x7a4c2a, 0.02));
    if (side === 2) {
      // Roof beyond the far wall's top, so the camera never sees the void behind the shelves.
      long(HEIGHT + 0.42, -DEPTH - 12, 0.05, 24, 0x4a2e1a, 12);
    } else galleries();
    // Brass rail under the cornice that the ladders hang on.
    if (extras.ladders?.length && side !== 2) long(HEIGHT - 0.04, 0.1, 0.05, 0.05, jitter(BRASS, 0.03));

    const nb = Math.max(1, Math.round(len / BAY));
    const bw = len / nb;
    const ladderBays = (extras.ladders ?? []).map((x) => {
      let j = Math.min(nb - 1, Math.floor(x / bw));
      while (j < nb - 1 && windows(j, nb)) j++;
      return j;
    });
    for (let i = 0; i <= nb; i++) {
      const x = i * bw;
      if (!ends && (i === 0 || i === nb)) continue;
      piece(solid, box, local(x, HEIGHT / 2, -DEPTH / 2 + 0.02, 0, 0, 0, 0.2, HEIGHT, DEPTH + 0.04), wood());
      piece(solid, box, local(x, HEIGHT / 2, 0.04, 0, 0, 0, 0.26, HEIGHT, 0.06), jitter(WOOD_EDGE, 0.04));
      const offScreen = side !== 2 && toWorld(x, 0, 0).z > opts.lineZ + PAINTED_FROM + 2;
      // Ivy climbing the post from the floor.
      if (!offScreen && rng() < 0.7) {
        const top = R(1.3, 2.4);
        vine(x + R(-0.1, 0.1), top, x + R(-0.3, 0.3), top * 0.5, x + R(-0.1, 0.1), 0.15, 0.4);
      }
      // Hanging lanterns on brackets in front of every inner post, at alternating heights.
      if (i > 0 && i < nb && !offScreen) {
        const y = (i % 2 ? ROWS[1] + 0.55 : ROWS[2] + 0.3) + R(0, 0.2);
        piece(solid, box, local(x, y + 0.95, 0.22, 0, 0, 0, 0.05, 0.05, 0.4), jitter(BRASS_DARK));
        lantern(x, y, 0.4, R(1.0, 1.15), true);
      }
    }
    for (let j = 0; j < nb; j++) {
      const x0 = j * bw + 0.1;
      const x1 = (j + 1) * bw - 0.1;
      const win = windows(j, nb);
      const winRow = 1;
      const painted = side !== 2 && toWorld((x0 + x1) / 2, 0, 0).z > opts.lineZ + PAINTED_FROM;
      for (let r = 0; r < ROWS.length; r++) {
        const y0 = ROWS[r];
        const next = r + 1 < ROWS.length ? ROWS[r + 1] : HEIGHT;
        if (win && r >= winRow) {
          if (r === winRow) windowBay(x0, x1, y0);
          continue;
        }
        if (r > 0) piece(solid, box, local((x0 + x1) / 2, y0 - 0.04, -DEPTH / 2, 0, 0, 0, x1 - x0, 0.08, DEPTH), wood(0.05));
        // A lighter front edge on every board, so the shelf grid reads from above.
        piece(solid, box, local((x0 + x1) / 2, y0 - 0.045, 0.01, 0, 0, 0, x1 - x0, 0.09, 0.04), jitter(WOOD_EDGE, 0.05));
        if (painted) paintedRow(x0, x1, y0, next - y0 - 0.08, -0.4);
        else fillShelf(x0, x1, y0, next - y0 - 0.08);
      }
      if (!painted) bayIvy(x0, x1, win);
      if (ladderBays.includes(j)) ladder((x0 + x1) / 2 + R(-0.3, 0.3));
    }
    // A garland along the cornice front: short swags end to end, so it reads as one continuous vine.
    for (let x = R(-0.3, 0.3); x < len; ) {
      const w = R(1.3, 1.8);
      vine(x, HEIGHT + 0.42, x + w / 2, HEIGHT + R(0.05, 0.2), x + w, HEIGHT + 0.42, 0.15, 0.22);
      x += w;
    }

    // Floor strip: a few large, readable props per bay with floor showing between them, like the reference. A back
    // row against the shelves (a lantern on a crate or a book stack, potted plants, flowering bushes, cushions), a
    // middle row of flat things (big embroidered cushions, open books, spilled books) and a low front row along the
    // field edge (toadstools, flowers, candles) that is all a narrow phone sees of the walls. The corners by the
    // defenders get a second middle prop.
    layer = 1;
    const zs = depth / STRIP;
    /** Keeps a prop of radius r inside the strip, off the play field. */
    const inStrip = (z: number, r: number) => Math.min(z * zs, depth - 0.25 - r);
    const backProp = (x: number, z: number) => {
      const r = rng();
      if (r < 0.33) pottedPlant(x, z, 0, R(1.3, 1.6), rng() < 0.6 ? 2 : 0);
      else if (r < 0.66) bush(x, z + 0.1, R(1.1, 1.35), 2);
      else if (r < 0.86) {
        const top = bookStack(x, z, 0, 4, 1.4);
        if (rng() < 0.5) candles(x, z, top, 1.2);
        else openBook(x, z, top, 1.2);
      } else cushionPile(x, z + 0.1);
    };
    const backLantern = (x: number, z: number) => {
      const r = rng();
      if (r < 0.55) lantern(x, crate(x, z, R(0.95, 1.1)), z, R(1.55, 1.7));
      else if (r < 0.85) lantern(x, bookStack(x, z, 0, 3, 1.35), z, R(1.45, 1.6));
      else lantern(x, 0, z, R(1.8, 2.0));
      if (rng() < 0.85) ivyPatch(x + R(-0.3, 0.3), z + 0.5, 5, 0.35, 0.6);
    };
    const midProp = (x: number, z: number) => {
      const r = rng();
      if (r < 0.24) {
        const top = cushion(x, inStrip(z, 0.7), 0, R(1.25, 1.4));
        if (rng() < 0.35) openBook(x, inStrip(z, 0.7), top - 0.03, 1.25);
      } else if (r < 0.48) {
        openBook(x, inStrip(z, 0.55), 0, R(1.5, 1.7));
        ivyPatch(x + R(-0.5, 0.5), inStrip(z, 0.4) + R(-0.3, 0.3), 3, 0.25, 0.5);
      } else if (r < 0.62) bush(x, inStrip(z, 0.55), R(1.0, 1.2), 2);
      else if (r < 0.72) pottedPlant(x, inStrip(z, 0.4), 0, R(1.2, 1.4), 2);
      else if (r < 0.84) spill(x, inStrip(z, 0.7), 1.4);
      else if (r < 0.94) cushionPile(x, inStrip(z, 0.7));
      else mushrooms(x, inStrip(z, 0.4));
    };
    const frontProp = (x: number, z: number) => {
      const r = rng();
      if (r < 0.35) mushrooms(x, inStrip(z, 0.35));
      else if (r < 0.65) ivyPatch(x, inStrip(z, 0.35), 6, 0.35, 1);
      else if (r < 0.72) candles(x, inStrip(z, 0.35), 0, 1.3);
      else if (r < 0.82) openBook(x, inStrip(z, 0.45), 0, 1.25);
    };
    for (let j = 0; j < nb; j++) {
      const x0 = j * bw;
      const wz = toWorld(x0 + bw / 2, 0, 0).z;
      const near = side !== 2 && wz > opts.lineZ - 9;
      // Bays past the defenders sit below the bottom of every screen.
      if (side !== 2 && Math.min(toWorld(x0, 0, 0).z, toWorld(x0 + bw, 0, 0).z) > opts.lineZ + 8) continue;
      const hasLadder = ladderBays.includes(j);
      const lanternSlot = rng() < 0.5 ? 0 : 1;
      for (let k = 0; k < 2; k++) {
        if (hasLadder && k === 0) continue;
        const x = x0 + bw * (k ? 0.73 : 0.27) + R(-0.12, 0.12);
        const z = R(0.6, 0.8) * Math.min(1, zs + 0.1);
        if (k === lanternSlot || (hasLadder && k === 1)) backLantern(x, z);
        else backProp(x, z);
      }
      const gx = extras.globe;
      const globeHere = gx !== undefined && gx >= x0 - 0.6 && gx < x0 + bw + 0.6;
      if (!globeHere) {
        if (near) {
          midProp(x0 + bw * R(0.15, 0.35), R(1.8, 2.2));
          midProp(x0 + bw * R(0.65, 0.85), R(1.8, 2.2));
        } else midProp(x0 + bw * R(0.3, 0.7), R(1.8, 2.2));
      }
      frontProp(x0 + bw * R(0.15, 0.85), R(2.9, 3.3));
      if (rng() < 0.5) ivyPatch(x0 + R(-0.15, 0.15), 0.3, 4, 0.3, 0.3);
    }
    if (extras.globe !== undefined) globe(extras.globe, inStrip(1.75, 0.5), 1.1);
  };

  // Left wall: x = -wallX, running from the near end (z = zNear) to the far wall.
  side = 0;
  W.copy(wallFrame(-wallX, zNear, 0, -1, 1, 0));
  buildWall(sideLen, STRIP, (j, nb) => j % 3 === 1 && j < nb - 1, true, {
    globe: zNear - (opts.lineZ - opts.length * 0.7),
    ladders: [zNear - (opts.lineZ - 13)],
  });
  // Right wall: x = +wallX, running from the far wall to the near end.
  side = 1;
  W.copy(wallFrame(wallX, zBack, 0, 1, -1, 0));
  buildWall(sideLen, STRIP, (j, nb) => j % 3 === 2 && j < nb - 1, true, {
    globe: opts.lineZ - 4.5 - zBack,
    ladders: [opts.lineZ - opts.length * 0.62 - zBack],
  });
  // Far wall across the end, a wide window in the middle.
  side = 2;
  W.copy(wallFrame(-wallX - DEPTH, zBack, 1, 0, 0, 1));
  buildWall(2 * (wallX + DEPTH), FAR_GAP, (j, nb) => Math.abs(j - (nb - 1) / 2) < 0.6 || j === 1 || j === nb - 2, false);
  {
    // A great wooden arch over the middle of the far wall, a lantern hanging from its keystone.
    layer = 0;
    const cx = wallX + DEPTH;
    const r = 2.7;
    const base = HEIGHT - r - 0.1;
    const wood = jitter(WOOD, 0.03);
    for (const s of [-1, 1]) {
      piece(solid, box, local(cx + s * r, base / 2, 0.3, 0, 0, 0, 0.5, base, 0.5), wood);
      piece(solid, box, local(cx + s * r, base + 0.06, 0.3, 0, 0, 0, 0.66, 0.14, 0.62), jitter(WOOD_EDGE, 0.03));
      vine(cx + s * r, base + 0.1, cx + s * (r + 0.3), base * 0.6, cx + s * r, 0.4, 0.4);
    }
    const arch = new THREE.TorusGeometry(r, 0.26, 5, 18, Math.PI);
    piece(solid, arch, local(cx, base, 0.3, 0, 0, 0, 1, 1, 0.9), wood);
    arch.dispose();
    piece(solid, box, local(cx, base + r + 0.05, 0.36, 0, 0, 0, 0.4, 0.5, 0.5), jitter(WOOD_EDGE, 0.03));
    piece(solid, box, local(cx, base + r - 0.6, 0.6, 0, 0, 0, 0.03, 0.9, 0.03), jitter(BRASS_DARK));
    lantern(cx, base + r - 1.7, 0.6, 1.4, false);
    vine(cx - 1.4, base + r + 0.1, cx, base + r - 0.9, cx + 1.4, base + r + 0.1, 0.4);
  }

  // (No floor strips of its own: the field floor in world.ts reaches x = ±15 and covers the whole room.)

  // Corner posts where the side walls meet the far wall.
  for (const s of [-1, 1]) {
    W.identity();
    piece(solid, box, local(s * (wallX + DEPTH / 2), HEIGHT / 2 + 0.2, zBack - DEPTH / 2, 0, 0, 0, DEPTH + 0.1, HEIGHT + 0.4, DEPTH + 0.1), jitter(WOOD_DARK));
  }

  // ---- bake the lantern light ----

  // Bucket lights along z so each vertex only checks its neighbours.
  const BUCKET = 4;
  const buckets = new Map<number, LightSpot[]>();
  for (const L of lights) {
    const k = Math.floor(L.z / BUCKET);
    for (let d = -1; d <= 1; d++) {
      const arr = buckets.get(k + d) ?? [];
      arr.push(L);
      buckets.set(k + d, arr);
    }
  }
  const bakeAt = (x: number, y: number, z: number) => {
    let b = 0.03;
    const arr = buckets.get(Math.floor(z / BUCKET));
    if (arr)
      for (const L of arr) {
        const dx = x - L.x;
        const dy = y - L.y;
        const dz = z - L.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < L.r * L.r) {
          const f = 1 - Math.sqrt(d2) / L.r;
          b += L.i * f * f;
        }
      }
    return Math.min(b, 0.95);
  };

  const group = new THREE.Group();
  group.name = 'library';

  /** Chunk meshes with their bounds per wall; `cull` hides the ones outside the view. */
  const culled: { mesh: THREE.Mesh; boxes: THREE.Box3[] }[] = [];
  const addBag = (bag: Bag, mat: THREE.Material, bake?: typeof bakeAt) => {
    for (const { geo, boxes } of bag.build(bake)) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      culled.push({ mesh, boxes });
      group.add(mesh);
    }
  };
  const atlas = bookAtlas();
  addBag(solid, libMaterial('solid', { map: atlas, trim: true, lit: true }), bakeAt);
  addBag(foliage, libMaterial('foliage', { foliage: true, side: THREE.DoubleSide }), bakeAt);
  addBag(skyBag, new THREE.MeshBasicMaterial({ map: skyTexture(), vertexColors: true }));

  group.add(glowMesh(glowC, glowD));
  if (poolD.length) group.add(poolMesh(poolD));

  for (const g of [quad, box, cyl, cyl12, cone, hemi, ball, dot, ring, bookGeo, shelfBookGeo, openBookGeo, cushionGeo, leafGeo, ivyGeo, flowerGeo]) g.dispose();
  scene.add(group);

  // Frustum culling by boxes: three's bounding-sphere test cannot drop a long thin wall, a box test can. It runs at the
  // start of every render of this scene, before three gathers what to draw, for whichever camera renders it. Culled
  // chunks get an empty layer mask (`visible` is left alone for whoever else toggles it).
  const frustum = new THREE.Frustum();
  const vp = new THREE.Matrix4();
  const prevBefore = scene.onBeforeRender;
  scene.onBeforeRender = function (...args) {
    prevBefore.apply(this, args);
    const camera = args[2];
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(vp);
    for (const c of culled) {
      let vis = false;
      for (const b of c.boxes)
        if (frustum.intersectsBox(b)) {
          vis = true;
          break;
        }
      c.mesh.layers.mask = vis ? 1 : 0;
    }
  };

  return {
    update(_dt: number, t: number) {
      time.value = t;
    },
  };
}
