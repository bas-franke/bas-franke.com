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
const STRIP = 2.4;
/** Floor between the far end of the field and the far wall. */
const FAR_GAP = 2.6;
/** Shelf depth (front face to back panel). */
const DEPTH = 1.0;
/** Height of the shelf walls (cornice on top). */
const HEIGHT = 7.4;
/** Tops of the shelf boards; the first is the plinth. */
const ROWS = [0.5, 1.64, 2.78, 3.92, 5.06, 6.2];
/** Target bay width between two posts. */
const BAY = 2.3;
/** How far the side walls continue behind the defence line. */
const NEAR_EXTRA = 5;

const BOOK_COLORS = [
  0x66342a, 0x58302e, 0x3a4636, 0x35423e, 0x343c52, 0x7e6238, 0x4a3424, 0x463640, 0xa8916c, 0x664630, 0x434b3c,
  0x723e2e, 0x33392f, 0x54343a, 0x3a4458,
];
const CUSHION_COLORS = [0x80382e, 0x70342c, 0x4c5e3c, 0x405438, 0x3a4c6a, 0x36524e];
const LEAF_COLORS = [0x2a481c, 0x34521f, 0x405a26, 0x24401a, 0x4a6228, 0x2e4c1e];
const WOOD = 0x54331c;
const WOOD_DARK = 0x24160d;
const BRASS = 0x9a6c34;
const BRASS_DARK = 0x4e3418;

/** Share of foliage and faint glows kept on the 'low' quality tier. */
const LOW_KEEP = { wallLeaf: 0.7, stripLeaf: 0.85, flower: 0.75 };

/** Colour of the faked lantern light (linear, multiplied by albedo and the baked amount). */
const WARM = new THREE.Vector3(1.5, 0.86, 0.32);

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
 * of the defence line: over every aspect ratio and HUD inset it lands at y 21..58 and z 9..40 (computed offline from
 * placeCamera). This box is a generous margin around that. A triangle whose front faces away from every point of the
 * box can never be seen, so the merged meshes leave it out: bottoms of everything, the sides of books and boxes that
 * face the far end or the outside, the backs of the shelves. That is about 40% of the room's triangles.
 */
const CAM_BOX = { cx: 0, cy: 50, cz: 34, hx: 1.5, hy: 34, hz: 28 };

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
  tex?: 'atlas' | 'cushion' | 'plain' | 'unlit' | 'raw';
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
  constructor(private readonly o: { uv?: boolean; sway?: boolean; doubleSided?: boolean; single?: boolean } = {}) {}

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
            if (tex === 'atlas') u *= ATLAS_BOOKS;
            else if (tex === 'cushion') {
              u = ATLAS_BOOKS + u * (1 - ATLAS_BOOKS);
              v = 0.5 + v * 0.5;
            } else if (tex !== 'raw') {
              u = tex === 'plain' ? -1 : -2;
              v = 0;
            }
            ch.uv.push(u, v);
          }
          if (x.pivot) ch.bp.push(ox, oy, oz);
          else ch.bp.push(px, py, pz);
          if (this.o.sway) {
            ch.sway.push(ox, oy, oz, P.getY(i) * sy);
            ch.lit.push(x.lit ?? 0);
          }
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
      if (this.o.sway) {
        g.setAttribute('sway', new THREE.Float32BufferAttribute(ch.sway, 4));
        g.setAttribute('lit', new THREE.Float32BufferAttribute(ch.lit, 1));
      }
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
    if (o.foliage) vs += 'attribute vec4 sway;\nattribute float lit;\n';
    vs += sh.vertexShader;
    let begin = '#include <begin_vertex>\n\tvBake = bake;';
    if (o.foliage)
      begin += `
	vLit = lit;
	transformed.x += sin( uTime * 1.3 + sway.x * 0.9 + sway.z * 0.6 + sway.y * 1.7 ) * 0.07 * sway.w;
	transformed.z += cos( uTime * 1.05 + sway.z * 0.8 + sway.x * 0.4 ) * 0.05 * sway.w;`;
    else begin += '\n\tvLit = 0.0;';
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

/**
 * Atlas 448x256. Books (u 0..320 px): four spine patterns (columns 0-3), then paper (top half) and plain cover (bottom
 * half). Then the cushion mask (128x128, top right; repeated below so mip levels never blend in anything else).
 */
function bookAtlas() {
  const W = 320;
  const H = 256;
  const c = canvas(448, H);
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
        r = 0.86 + 0.1 * noise[y * W + x] - (y % 6 === 0 ? 0.12 : 0);
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
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
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
  const cover = new THREE.BoxGeometry(1, 0.03, 0.7);
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

/** A pointed leaf with a centre fold, length 1 along +y, normal +z, vertex-shaded darker at the base. */
function leafGeometry() {
  const P = [
    [0, 0, 0],
    [-0.46, 0.4, 0.08],
    [0.46, 0.4, 0.08],
    [0, 1, 0],
  ];
  // Two triangles: a broad heart-ish leaf folded along its midrib (base to tip), the right half a bit brighter.
  const tris = [
    [0, 3, 1],
    [0, 2, 3],
  ];
  const pos: number[] = [];
  const col: number[] = [];
  for (const t of tris)
    for (const k of t) {
      pos.push(...P[k]);
      const s = (0.6 + 0.4 * P[k][1]) * (P[k][0] > 0 ? 1.1 : 1);
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
    const r = pt(0.5, -0.3);
    const l = pt(0.5, 0.3);
    const tip = pt(1.05, 0);
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
  const leafGeo = leafGeometry();
  const flowerGeo = flowerGeometry();

  // 'low' (phones, weak machines) thins the foliage and the faintest glows. The thinning draws from its own random
  // stream, so the room's layout is the same on both tiers.
  const low = detectQuality() === 'low';
  const thinRng = mulberry32(4242);
  const keep = (p: number) => !low || thinRng() < p;

  // Everything solid (wood, brass, books, cushions, lantern glass) shares one material, so each chunk is one draw.
  const solid = new Bag({ uv: true });
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
    bag.add(geo, w, color, chunkAt(w.elements[14]), side, x);
  };
  const toWorld = (x: number, y: number, z: number) => _v.set(x, y, z).applyMatrix4(W);

  const glow = (x: number, y: number, z: number, size: number, intensity: number, hue: number, keepP = 1) => {
    const p = toWorld(x, y, z);
    const ph = rng() * 100;
    if (!keep(keepP)) return;
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

  // -- props, all in the current wall frame (x along, y up, z towards the field) --

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
    glow(x, y + 0.22 * s, z, 1.6 * Math.min(s, 1.2), 0.26, 0);
    glow(x, y + 0.22 * s, z, 0.42 * s, 0.6, 1);
    light(x, y + 0.25 * s, z, 0.45, 2.8 * Math.min(1.6, s));
    if (y + 0.25 * s < 2 && z < 1.3) pool(x, z, Math.min(1.3 + s * 0.7, STRIP + 0.3 - z), 0.2);
  };

  const candle = (x: number, y: number, z: number, h: number) => {
    piece(solid, cyl, local(x, y + h / 2, z, 0, 0, 0, 0.05, h, 0.05), jitter(0xeee0c0, 0.04));
    piece(solid, cone, local(x, y + h + 0.05, z, 0, 0, 0, 0.03, 0.1, 0.03), 0xffd27a, { tex: 'unlit' });
    glow(x, y + h + 0.06, z, 0.45, 0.55, 1);
    light(x, y + h + 0.05, z, 0.3, 1.6);
  };

  const candles = (x: number, z: number, y = 0) => {
    piece(solid, cyl12, local(x, y + 0.02, z, 0, 0, 0, 0.24, 0.04, 0.24), jitter(BRASS));
    const n = 2 + Math.floor(R(0, 2));
    for (let k = 0; k < n; k++) candle(x + R(-0.12, 0.12), y + 0.04, z + R(-0.12, 0.12), R(0.12, 0.38));
    glow(x, y + 0.3, z, 1.1, 0.12, 0, 0.5);
    if (y < 1 && z < 1.6) pool(x, z, Math.min(1.1, STRIP + 0.3 - z), 0.16);
  };

  const mushrooms = (x: number, z: number) => {
    const n = 2 + Math.floor(R(0, 3));
    for (let k = 0; k < n; k++) {
      const s = R(1.0, 1.9);
      const mx = x + R(-0.35, 0.35);
      const mz = z + R(-0.3, 0.3);
      const h = 0.2 * s;
      piece(solid, cyl, local(mx, h / 2, mz, R(-0.1, 0.1), 0, R(-0.1, 0.1), 0.045 * s, h, 0.045 * s), jitter(0xeadcc0, 0.04));
      piece(solid, hemi, local(mx, h - 0.02, mz, 0, 0, 0, 0.15 * s, 0.075 * s, 0.15 * s), jitter(0xa83a2a, 0.06));
      for (let d = 0; d < 3; d++) {
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
    const baseYaw = R(0, Math.PI * 2);
    let y = y0;
    let w = R(0.62, 0.82) * s;
    for (let k = 0; k < n; k++) {
      const t = R(0.08, 0.16) * s;
      w = Math.max(0.4 * s, w - R(0, 0.06) * s);
      lyingBook(x + R(-0.04, 0.04), y + t / 2, z + R(-0.04, 0.04), baseYaw + R(-0.25, 0.25), w, t, w * R(0.66, 0.8));
      y += t;
    }
    return y;
  };

  const openBook = (x: number, z: number, y = 0, s = 1) => {
    const m = local(x, y, z, 0, R(-0.6, 0.6) + Math.PI, 0, 0.62 * s, 1, 0.62 * s);
    piece(solid, openBookGeo, m, jitter(pick(BOOK_COLORS)), { pivot: true, tex: 'atlas' });
  };

  const cushion = (x: number, z: number, y = 0, s = R(0.75, 1.05)) => {
    const m = local(x, y, z, R(-0.06, 0.06), R(0, Math.PI), R(-0.06, 0.06), s, s, s);
    piece(solid, cushionGeo, m, jitter(pick(CUSHION_COLORS), 0.06), { pivot: true, tex: 'cushion' });
    return y + 0.34 * s;
  };

  const leaf = (x: number, y: number, z: number, rx: number, ry: number, rz: number, s: number) => {
    _e.set(rx, ry, rz, 'YXZ');
    _q.setFromEuler(_e);
    _l.compose(_p.set(x, y, z), _q, _s.set(s * 0.8, s, s));
    _e.order = 'XYZ';
    const c = jitter(pick(LEAF_COLORS), 0.06, 0.02);
    if (keep(layer === 0 ? LOW_KEEP.wallLeaf : LOW_KEEP.stripLeaf)) piece(foliage, leafGeo, _l, c, { pivot: true, lit: 0.12 });
  };

  const flower = (x: number, y: number, z: number, s: number, tiltX = 0, tiltZ = 0) => {
    const m = local(x, y, z, tiltX, R(0, 6.3), tiltZ, s, s, s);
    const c = jitter(0xfffaf0, 0.03, 0.01);
    if (keep(LOW_KEEP.flower)) piece(foliage, flowerGeo, m, c, { pivot: true, lit: 0.3 });
  };
  /** A tight bunch of white stars (the reference groups them, it does not sprinkle them). */
  const flowerCluster = (x: number, y: number, z: number, n: number, tiltX: number) => {
    const wall = tiltX > 0.5;
    for (let k = 0; k < n; k++) {
      const a = R(0, Math.PI * 2);
      const r = R(0.04, 0.17);
      const dx = Math.cos(a) * r;
      const dd = Math.sin(a) * r;
      flower(x + dx, y + (wall ? dd : R(0, 0.05)), z + (wall ? R(0, 0.05) : dd), R(0.1, 0.15), tiltX + R(-0.3, 0.3), R(-0.3, 0.3));
    }
  };

  const bush = (x: number, z: number, size: number, flowersN = 2) => {
    const n = Math.round(15 * size * size + 6);
    for (let k = 0; k < n; k++) {
      const yaw = R(0, Math.PI * 2);
      const tilt = R(0.5, 1.35);
      const r = R(0, 0.25) * size;
      leaf(x + Math.sin(yaw) * r, R(0, 0.35) * size, z + Math.cos(yaw) * r, tilt, yaw, R(-0.3, 0.3), R(0.26, 0.4) * size);
    }
    for (let k = 0; k < flowersN; k++) {
      const yaw = R(0, Math.PI * 2);
      const r = R(0.15, 0.5) * size;
      flowerCluster(x + Math.sin(yaw) * r, R(0.35, 0.55) * size, z + Math.cos(yaw) * r, 3 + Math.floor(R(0, 3)), 0);
    }
  };

  const pottedPlant = (x: number, z: number, y = 0, s = 1) => {
    piece(solid, cyl12, local(x, y + 0.16 * s, z, 0, 0, 0, 0.2 * s, 0.32 * s, 0.2 * s), jitter(0xa45a36, 0.06));
    piece(solid, cyl12, local(x, y + 0.33 * s, z, 0, 0, 0, 0.23 * s, 0.05 * s, 0.23 * s), jitter(0x8e4a2c, 0.05));
    const n = Math.round(16 * s);
    for (let k = 0; k < n; k++) {
      const yaw = R(0, Math.PI * 2);
      leaf(x, y + 0.32 * s, z, R(0.2, 1.4), yaw, R(-0.3, 0.3), R(0.28, 0.42) * s);
    }
  };

  /** Broad ivy spilling over a shelf edge at height y (a dense clump), with strands trailing down and white stars. */
  const ivyCascade = (x: number, y: number, width: number, drop: number, flowerP = 0.3) => {
    const n = Math.round(6 + width * 10);
    for (let k = 0; k < n; k++) {
      const lx = x + R(-0.5, 0.5) * width;
      const lz = R(-0.05, 0.3);
      leaf(lx, y + R(-0.08, 0.12), lz, R(-1.4, -0.4), R(-0.6, 0.6), Math.PI + R(-1.0, 1.0), R(0.3, 0.46));
    }
    if (rng() < flowerP * 2) flowerCluster(x + R(-0.3, 0.3) * width, y - R(0, 0.25), 0.32, 3 + Math.floor(R(0, 2)), Math.PI / 2 - 0.4);
    const strands = 1 + Math.floor(R(0, 2.6));
    for (let k = 0; k < strands; k++) {
      let vx = x + R(-0.45, 0.45) * width;
      const end = Math.max(0.25, y - drop * R(0.5, 1));
      for (let yy = y - 0.12; yy > end; yy -= R(0.13, 0.2)) {
        vx += R(-0.06, 0.06);
        leaf(vx + R(-0.08, 0.08), yy, R(0.08, 0.26), R(-0.9, -0.2), R(-0.5, 0.5), Math.PI + R(-0.9, 0.9), R(0.24, 0.34));
      }
    }
  };

  /** A few books dropped on the floor at odd angles, one maybe propped open. */
  const spill = (x: number, z: number, s = 1) => {
    const n = 2 + Math.floor(R(0, 2));
    for (let k = 0; k < n; k++) {
      const t = R(0.09, 0.15) * s;
      const h = R(0.5, 0.75) * s;
      lyingBook(x + R(-0.45, 0.45) * s, t / 2 + (k > 1 ? t : 0), z + R(-0.3, 0.3) * s, R(0, Math.PI * 2), h, t, h * R(0.66, 0.8));
    }
    if (rng() < 0.4) openBook(x + R(-0.3, 0.3), z + R(-0.2, 0.2), 0, R(0.9, 1.15));
  };

  /** One or two plump cushions, a book or candle on top now and then. */
  const cushionPile = (x: number, z: number) => {
    let top = cushion(x, z, 0, R(1.05, 1.3));
    if (rng() < 0.55) top = cushion(x + R(-0.12, 0.12), z + R(-0.12, 0.12), top - 0.04, R(0.8, 1.0));
    const r = rng();
    if (r < 0.35) openBook(x, z, top - 0.03, 0.85);
    else if (r < 0.6) bookStack(x, z, top - 0.03, 3, 0.9);
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
    glow(x, cy, z, 1.3 * s, 0.32, 0);
    light(x, cy, z, 0.5, 2.8);
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

  /** Arched window filling a bay from y0 up to just under the cornice. */
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
    const frame = jitter(WOOD, 0.04);
    piece(solid, box, local(x0 + 0.06, y0 + rectH / 2, fz, 0, 0, 0, 0.14, rectH, 0.16), frame);
    piece(solid, box, local(x1 - 0.06, y0 + rectH / 2, fz, 0, 0, 0, 0.14, rectH, 0.16), frame);
    const arch = new THREE.TorusGeometry(r - 0.04, 0.08, 4, 14, Math.PI);
    piece(solid, arch, local(cx, y0 + rectH, fz), frame);
    arch.dispose();
    piece(solid, box, local(cx, y0 + (rectH + r * 0.9) / 2, fz, 0, 0, 0, 0.08, rectH + r * 0.9, 0.1), frame);
    for (const f of [0.38, 0.75]) piece(solid, box, local(cx, y0 + rectH * f, fz, 0, 0, 0, 2 * r, 0.07, 0.1), frame);
    // Deep sill with a candle or a plant.
    piece(solid, box, local(cx, y0 + 0.04, -DEPTH / 2 + 0.05, 0, 0, 0, x1 - x0, 0.1, DEPTH + 0.1), jitter(WOOD, 0.04));
    if (rng() < 0.5) candles(cx + R(-0.4, 0.4), -0.45, y0 + 0.09);
    else pottedPlant(cx + R(-0.4, 0.4), -0.45, y0 + 0.09, 0.8);
  };

  /** Vine of ivy hanging from the cornice down the shelf front. */
  const vine = (x: number, length: number) => {
    let y = HEIGHT + 0.1;
    let vx = x;
    const end = Math.max(0.6, HEIGHT - length);
    while (y > end) {
      vx += R(-0.07, 0.07);
      const z = R(0.08, 0.28);
      leaf(vx + R(-0.1, 0.1), y, z, R(-0.9, -0.2), R(-0.5, 0.5), Math.PI + R(-0.9, 0.9), R(0.2, 0.3));
      y -= R(0.12, 0.2);
    }
    if (rng() < 0.4) flowerCluster(vx, R(end, HEIGHT), 0.3, 3, Math.PI / 2 - 0.4);
  };

  /**
   * One wall of shelves along the current frame from x = 0 to `len`, with a floor strip `strip` deep in front.
   * `windows(bay, nb)` says which bays are windows.
   */
  const buildWall = (len: number, strip: number, windows: (j: number, nb: number) => boolean, ends: boolean) => {
    layer = 0;
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
    long(0.25, -DEPTH / 2, 0.5, DEPTH, jitter(0x342012, 0.02));
    long(0.06, 0.02, 0.12, 0.06, jitter(0x2e1b10, 0.02));
    long(HEIGHT + 0.16, -DEPTH / 2 + 0.12, 0.32, DEPTH + 0.34, jitter(0x3e2616, 0.02));
    long(HEIGHT + 0.38, -DEPTH / 2 + 0.06, 0.12, DEPTH + 0.5, jitter(0x4e321e, 0.02));
    // Dark roof beyond the wall top, so the camera never sees the void behind the shelves.
    long(HEIGHT + 0.42, -DEPTH - 12, 0.05, 24, 0x1c120c, 12);

    const nb = Math.max(1, Math.round(len / BAY));
    const bw = len / nb;
    for (let i = 0; i <= nb; i++) {
      const x = i * bw;
      if (!ends && (i === 0 || i === nb)) continue;
      piece(solid, box, local(x, HEIGHT / 2, -DEPTH / 2 + 0.02, 0, 0, 0, 0.2, HEIGHT, DEPTH + 0.04), wood());
      piece(solid, box, local(x, HEIGHT / 2, 0.04, 0, 0, 0, 0.26, HEIGHT, 0.06), jitter(0x553722, 0.04));
      // Ivy climbing the post from the floor, thick at the bottom.
      if (rng() < 0.85) {
        const top = R(1.0, 3.2);
        for (let y = 0.1; y < top; y += R(0.12, 0.19)) {
          const w = y < 1 ? 0.3 : 0.2;
          leaf(x + R(-w, w), y, R(0.08, 0.32), R(-0.6, 0.2), R(-0.5, 0.5), R(-1.2, 1.2), R(0.28, 0.42));
        }
        if (rng() < 0.6) flowerCluster(x + R(-0.15, 0.15), R(0.3, top), 0.36, 3 + Math.floor(R(0, 2)), Math.PI / 2 - 0.4);
      }
      // Hanging lanterns on brackets in front of every inner post, at alternating heights.
      if (i > 0 && i < nb) {
        const y = (i % 2 ? ROWS[2] : ROWS[3]) + R(0.05, 0.3);
        piece(solid, box, local(x, y + 0.95, 0.22, 0, 0, 0, 0.05, 0.05, 0.4), jitter(BRASS_DARK));
        lantern(x, y, 0.4, R(1.0, 1.15), true);
      }
    }
    for (let j = 0; j < nb; j++) {
      const x0 = j * bw + 0.1;
      const x1 = (j + 1) * bw - 0.1;
      const win = windows(j, nb);
      const winRow = 1;
      for (let r = 0; r < ROWS.length; r++) {
        const y0 = ROWS[r];
        const next = r + 1 < ROWS.length ? ROWS[r + 1] : HEIGHT;
        if (win && r >= winRow) {
          if (r === winRow) windowBay(x0, x1, y0);
          continue;
        }
        if (r > 0) piece(solid, box, local((x0 + x1) / 2, y0 - 0.04, -DEPTH / 2, 0, 0, 0, x1 - x0, 0.08, DEPTH), wood(0.05));
        fillShelf(x0, x1, y0, next - y0 - 0.08);
        // Ivy spilling over the shelf edge.
        if (r > 0 && rng() < 0.32) ivyCascade(R(x0 + 0.3, x1 - 0.3), y0, R(0.4, 0.9), R(0.4, 1.4));
      }
      // Ivy pouring over the cornice and hanging down.
      if (rng() < 0.75) ivyCascade(R(x0 + 0.2, x1 - 0.2), HEIGHT + 0.3, R(0.8, 1.4), R(1.0, win ? 2.0 : 3.6), 0.35);
      if (rng() < 0.4) vine(R(x0, x1), R(1.2, win ? 2.2 : 4.2));
    }
    // Garland of leaves along the cornice top.
    for (let x = 0; x < len; x += R(0.25, 0.45))
      leaf(x, HEIGHT + 0.46, R(-0.2, 0.35), R(-1.6, -0.6), R(-0.4, 0.4), R(-2, 2), R(0.22, 0.34));

    // Floor strip props, densely packed like the reference: a back row against the shelves (book stacks with
    // lanterns at regular intervals, deep-green bushes with clusters of white stars, potted plants, cushions), a
    // middle row (cushion piles, open books, spilled books, candles), and a front row of ivy, flower clusters and
    // the odd candle that stays just off the play field (|x| > halfW + 0.3) and is all a phone sees of the walls.
    // The corners by the defenders get extra props and lanterns.
    layer = 1;
    const P = 1.35;
    /** Keeps a prop of radius r inside the strip, off the play field. */
    const inStrip = (z: number, r: number) => Math.min(z, strip - 0.3 - r);
    const ivyPatch = (cx: number, cz: number, n: number, spread: number, clusterP = 0.3) => {
      for (let k = 0; k < n; k++)
        leaf(cx + R(-spread, spread), R(0.01, 0.2), cz + R(-spread, spread) * 0.6, -Math.PI / 2 + R(0.2, 1.0), R(0, 6.3), 0, R(0.32, 0.5));
      if (rng() < clusterP) flowerCluster(cx + R(-0.3, 0.3) * spread, R(0.12, 0.22), cz, 3 + Math.floor(R(0, 3)), 0);
    };
    let x = R(0.2, 0.6);
    let nextLantern = R(0.5, 1.5);
    while (x < len - 0.3) {
      const wz = toWorld(x, 0, 0).z;
      const near = strip > 1.8 && wz > opts.lineZ - 8 && wz < zNear - 1;
      const zb = R(0.4, 0.65);
      if (x >= nextLantern) {
        const top = rng() < 0.75 ? bookStack(x, zb, 0, 5, P) : 0;
        lantern(x + R(-0.1, 0.1), top, zb, top ? R(1.3, 1.5) : R(1.7, 2.0));
        ivyPatch(x, zb + 0.35, 4, 0.45);
        nextLantern = x + (near ? R(1.5, 1.9) : R(2.4, 3.0));
      } else {
        const back = rng();
        if (back < 0.38) bush(x, zb + 0.1, R(1.2, 1.6), 1);
        else if (back < 0.54) {
          const top = bookStack(x, zb, 0, 5, P);
          if (rng() < 0.45) candles(x, zb, top);
          else if (rng() < 0.5) openBook(x, zb, top, 0.9);
        } else if (back < 0.64) pottedPlant(x, zb, 0, R(1.2, 1.5));
        else if (back < 0.84) cushionPile(x, zb + 0.15);
        else if (back < 0.9) mushrooms(x, zb + 0.2);
        else bush(x, zb + 0.1, R(0.9, 1.2), 1);
      }
      ivyPatch(x, R(0.1, 0.5), 2 + Math.floor(R(0, 3)), 0.55, 0.15);

      if (strip > 1.8 && (near || rng() < 0.65)) {
        const xm = x + R(-0.35, 0.35);
        const zm = R(1.1, 1.35);
        const mid = rng();
        if (mid < 0.24) cushionPile(xm, inStrip(zm, 0.7));
        else if (mid < 0.42) openBook(xm, inStrip(zm, 0.45), 0, R(1.0, 1.15));
        else if (mid < 0.62) spill(xm, inStrip(zm, 0.65), P * 0.8);
        else if (mid < 0.78) candles(xm, zm);
        else if (mid < 0.9) bush(xm, inStrip(zm, 0.5), R(0.8, 1.0), 1);
        else bookStack(xm, inStrip(zm, 0.5), 0, 4, P);
      }
      // Front row along the field edge: low ivy, star clusters, a candle tray now and then.
      {
        const zf = R(1.75, strip - 0.45);
        const f = rng();
        if (f < 0.2) candles(x + R(-0.3, 0.3), zf);
        else if (f < 0.27) mushrooms(x + R(-0.3, 0.3), Math.min(zf, strip - 0.6));
        ivyPatch(x + R(-0.3, 0.3), Math.min(zf, strip - 0.55), 3 + Math.floor(R(0, 3)), 0.4, 0.45);
      }
      if (near) {
        // A second layer of clutter in the corners by the defenders: cushions, stacks with lanterns, spilled books.
        const xn = x + R(-0.5, 0.5);
        const zn = R(0.9, 1.4);
        const k = rng();
        if (k < 0.3) cushionPile(xn, inStrip(zn, 0.7));
        else if (k < 0.55) spill(xn, inStrip(zn, 0.7), 1.15);
        else if (k < 0.8) {
          const top = bookStack(xn, inStrip(zn, 0.5), 0, 5, P);
          if (rng() < 0.5) lantern(xn, top, inStrip(zn, 0.5), 1.15);
          else candles(xn, inStrip(zn, 0.5), top);
        } else candles(xn, zn);
      }
      x += near ? R(0.75, 1.0) : R(0.85, 1.2);
    }
  };

  // Left wall: x = -wallX, running from the near end (z = zNear) to the far wall.
  side = 0;
  W.copy(wallFrame(-wallX, zNear, 0, -1, 1, 0));
  buildWall(sideLen, STRIP, (j, nb) => j % 3 === 1 && j < nb - 1, true);
  {
    // A globe on the left, a bit beyond the middle.
    const x = zNear - (opts.lineZ - opts.length * 0.7);
    globe(x, 1.7, 1.0);
  }
  // Right wall: x = +wallX, running from the far wall to the near end.
  side = 1;
  W.copy(wallFrame(wallX, zBack, 0, 1, -1, 0));
  buildWall(sideLen, STRIP, (j, nb) => j % 3 === 2 && j < nb - 1, true);
  {
    const x = opts.lineZ - 4.5 - zBack;
    globe(x, 1.9, 1.15);
  }
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
      piece(solid, box, local(cx + s * r, base + 0.06, 0.3, 0, 0, 0, 0.66, 0.14, 0.62), jitter(0x5a3a22, 0.03));
      ivyCascade(cx + s * r, base + 0.1, 0.6, 2.4, 0.4);
    }
    const arch = new THREE.TorusGeometry(r, 0.26, 5, 18, Math.PI);
    piece(solid, arch, local(cx, base, 0.3, 0, 0, 0, 1, 1, 0.9), wood);
    arch.dispose();
    piece(solid, box, local(cx, base + r + 0.05, 0.36, 0, 0, 0, 0.4, 0.5, 0.5), jitter(0x5a3a22, 0.03));
    piece(solid, box, local(cx, base + r - 0.6, 0.6, 0, 0, 0, 0.03, 0.9, 0.03), jitter(BRASS_DARK));
    lantern(cx, base + r - 1.7, 0.6, 1.4, false);
    ivyCascade(cx, base + r + 0.2, 1.6, 1.5, 0.4);
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
  addBag(solid, libMaterial('solid', { map: atlas, trim: true }), bakeAt);
  addBag(foliage, libMaterial('foliage', { foliage: true, side: THREE.DoubleSide }), bakeAt);
  addBag(skyBag, new THREE.MeshBasicMaterial({ map: skyTexture(), vertexColors: true }));

  group.add(glowMesh(glowC, glowD));
  if (poolD.length) group.add(poolMesh(poolD));

  for (const g of [box, cyl, cyl12, cone, hemi, ball, dot, ring, bookGeo, shelfBookGeo, openBookGeo, cushionGeo, leafGeo, flowerGeo]) g.dispose();
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
