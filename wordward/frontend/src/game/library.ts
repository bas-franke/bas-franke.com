// The enchanted library around the play field: tall bookshelves on both sides and at the far end, arched windows on a
// starry night, brass lanterns, ivy, flowers, mushrooms, cushions, globes and piles of books spilling onto the floor.
//
// Everything is procedural and seeded, so the room is the same every time. To stay cheap on phones the whole room is
// about a dozen draw calls: static pieces are merged into a few vertex-coloured meshes, repeated props (books, leaves,
// flowers, cushions, open books) are InstancedMeshes, and lantern light is faked: it is baked into a per-vertex /
// per-instance `bake` value that the materials add as warm emissive light, plus additive camera-facing glow quads
// that flicker in the vertex shader. No real lights are added here, and `update` only advances one time uniform.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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
const STRIP = 3.0;
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
const NEAR_EXTRA = 9;

const BOOK_COLORS = [
  0x8e3a2c, 0x74303a, 0x3d6648, 0x2f5e5a, 0x34477a, 0xa87c3c, 0x6a4a30, 0x5c3d5e, 0xc8aa78, 0x8a5a34, 0x4a7a66,
  0x9c4c34, 0x2e5444, 0x6e3644, 0x3d5a86,
];
const CUSHION_COLORS = [0xb0403a, 0x9c3434, 0x58884e, 0x4a7a4a, 0x3d5f96, 0x3a7a78];
const LEAF_COLORS = [0x3d6a2a, 0x4c7d31, 0x5b8f3a, 0x34602a, 0x6b9c44, 0x2f5526];
const WOOD = 0x5e3d27;
const WOOD_DARK = 0x3b2415;
const BRASS = 0xc8913a;
const BRASS_DARK = 0x7d5524;

/** Colour of the faked lantern light (linear, multiplied by albedo and the baked amount). */
const WARM = new THREE.Vector3(1.0, 0.62, 0.3);

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

/** Collects static pieces with a vertex colour and merges them into one geometry. */
class Bag {
  private parts: THREE.BufferGeometry[] = [];
  constructor(private readonly keepUv = false) {}
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color | number) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m);
    for (const k of Object.keys(g.attributes))
      if (k !== 'position' && k !== 'normal' && !(this.keepUv && k === 'uv')) g.deleteAttribute(k);
    g.clearGroups();
    const c = typeof color === 'number' ? new THREE.Color(color) : color;
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    this.parts.push(g);
  }
  build(): THREE.BufferGeometry | null {
    if (!this.parts.length) return null;
    const g = mergeGeometries(this.parts);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return g;
  }
}

/** Collects instances (matrix, colour, atlas variant) for one InstancedMesh. */
class Inst {
  mats: number[] = [];
  cols: number[] = [];
  vars: number[] = [];
  push(m: THREE.Matrix4, c: THREE.Color, v = 0) {
    m.toArray(this.mats, this.mats.length);
    this.cols.push(c.r, c.g, c.b);
    this.vars.push(v);
  }
  get count() {
    return this.vars.length;
  }
}

// ---- materials ----------------------------------------------------------------------------------------------------

const time = { value: 0 };
const warm = { value: WARM };

interface MatOpts {
  map?: THREE.Texture;
  /** The map is a mask: r = shade, g = gold trim, b = paper (books and cushions). */
  trim?: boolean;
  /** Per-instance `bvar` shifts spine uvs to one of four atlas columns. */
  atlas?: boolean;
  /** Leaves and flowers sway a little. */
  sway?: boolean;
  side?: THREE.Side;
}

/** Soft lit material with the baked lantern light added as warm emissive. Expects a `bake` attribute. */
function libMaterial(key: string, o: MatOpts = {}) {
  const m = new THREE.MeshLambertMaterial({ map: o.map ?? null, vertexColors: true, side: o.side ?? THREE.FrontSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.uniforms.uWarm = warm;
    let vs = 'attribute float bake;\nvarying float vBake;\nuniform float uTime;\n' + (o.atlas ? 'attribute float bvar;\n' : '');
    vs += sh.vertexShader;
    let begin = '#include <begin_vertex>\n\tvBake = bake;';
    if (o.sway)
      begin += `
	#ifdef USE_INSTANCING
		vec3 swP = instanceMatrix[3].xyz;
	#else
		vec3 swP = vec3( 0.0 );
	#endif
	transformed.x += sin( uTime * 1.3 + swP.x * 0.9 + swP.z * 0.6 + swP.y * 1.7 ) * 0.07 * position.y;
	transformed.z += cos( uTime * 1.05 + swP.z * 0.8 + swP.x * 0.4 ) * 0.05 * position.y;`;
    vs = vs.replace('#include <begin_vertex>', begin);
    if (o.atlas) vs = vs.replace('#include <uv_vertex>', '#include <uv_vertex>\n\tif ( vMapUv.x < 0.79 ) vMapUv.x += bvar * 0.2;');
    sh.vertexShader = vs;
    let fs = 'varying float vBake;\nuniform vec3 uWarm;\n' + sh.fragmentShader;
    if (o.trim)
      fs = fs.replace('#include <color_fragment>', '').replace(
        '#include <map_fragment>',
        `#include <color_fragment>
#ifdef USE_MAP
	vec4 tx = texture2D( map, vMapUv );
	diffuseColor.rgb = mix( diffuseColor.rgb * tx.r, vec3( 0.86, 0.52, 0.16 ) * ( 0.75 + 0.35 * tx.r ), tx.g );
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.80, 0.68, 0.46 ) * tx.r, tx.b );
#endif`,
      );
    fs = fs.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * vBake * uWarm;',
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

/** Book atlas 320x256: four spine patterns (columns 0-3), then paper (top half) and plain cover (bottom half). */
function bookAtlas() {
  const W = 320;
  const H = 256;
  const c = canvas(W, H);
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
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/** Cushion mask 128x128: r = shade (puffy vignette), g = gold border and star motif. */
function cushionTexture() {
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
  return new THREE.CanvasTexture(c);
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

/** Mossy stone tiles for the floor strips beside the field (repeats every 2 units). */
function stoneTexture() {
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#4a4a3c';
  ctx.fillRect(0, 0, S, S);
  const rnd = mulberry32(5);
  const tiles = [
    [0, 0, 128, 128],
    [128, 0, 128, 128],
    [0, 128, 128, 128],
    [128, 128, 128, 128],
  ];
  for (const [x, y, w, h] of tiles) {
    const l = 92 + rnd() * 26;
    ctx.fillStyle = `rgb(${l},${l + 4},${l - 10})`;
    ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
    for (let k = 0; k < 60; k++) {
      const d = (rnd() - 0.5) * 22;
      ctx.fillStyle = `rgba(${l + d},${l + d + 6},${l + d - 12},0.5)`;
      ctx.fillRect(x + 3 + rnd() * (w - 16), y + 3 + rnd() * (h - 16), 4 + rnd() * 14, 4 + rnd() * 14);
    }
  }
  for (let k = 0; k < 90; k++) {
    // moss in the grout
    const onX = rnd() < 0.5;
    const x = onX ? Math.round(rnd() * 2) * 128 : rnd() * S;
    const y = onX ? rnd() * S : Math.round(rnd() * 2) * 128;
    ctx.fillStyle = `rgba(${70 + rnd() * 30},${100 + rnd() * 30},${40 + rnd() * 20},0.75)`;
    ctx.beginPath();
    ctx.arc(x, y, 2 + rnd() * 5, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ---- geometry -----------------------------------------------------------------------------------------------------

/** Sets a box face's uvs to a rectangle of the atlas. Face order: +x, -x, +y, -y, +z, -z. */
function boxUv(g: THREE.BufferGeometry, face: number, u0: number, v0: number, u1: number, v1: number) {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = face * 4; i < face * 4 + 4; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
}

/** A book standing on its bottom: thickness along x, height y, depth z, spine at +z. Origin bottom centre. */
function bookGeometry() {
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
  const g = new THREE.SphereGeometry(0.5, 12, 8);
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
    [-0.34, 0.2, 0.05],
    [-0.42, 0.52, 0.07],
    [0, 0.48, -0.04],
    [0.42, 0.52, 0.07],
    [0.34, 0.2, 0.05],
    [0, 1, 0],
  ];
  const tris = [
    [0, 3, 1],
    [1, 3, 2],
    [2, 3, 6],
    [0, 5, 3],
    [5, 4, 3],
    [3, 4, 6],
  ];
  const pos: number[] = [];
  const col: number[] = [];
  for (const t of tris)
    for (const k of t) {
      pos.push(...P[k]);
      const s = 0.72 + 0.28 * P[k][1];
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
    const c0 = pt(0.15, 0);
    const l = pt(0.55, 0.32);
    const tip = pt(1, 0);
    const r = pt(0.55, -0.32);
    push(c0[0], 0.02, c0[1], white);
    push(r[0], 0.05, r[1], white);
    push(l[0], 0.05, l[1], white);
    push(l[0], 0.05, l[1], white);
    push(r[0], 0.05, r[1], white);
    push(tip[0], 0.1, tip[1], white);
  }
  for (let k = 0; k < 6; k++) {
    const a0 = (k / 6) * Math.PI * 2;
    const a1 = ((k + 1) / 6) * Math.PI * 2;
    push(0, 0.12, 0, yellow);
    push(Math.cos(a1) * 0.22, 0.07, Math.sin(a1) * 0.22, yellow);
    push(Math.cos(a0) * 0.22, 0.07, Math.sin(a0) * 0.22, yellow);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 0; i < nrm.length; i += 3) nrm[i + 1] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

/** Camera-facing additive glow quads; flicker per instance in the vertex shader. */
function glowMesh(centers: number[], data: number[]) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
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
        mv.xy += position.xy * s;
        mv.z += s * 0.7;
        gl_Position = projectionMatrix * mv;
        vUv = position.xy;
        vI = gdata.z * f;
        vHue = gdata.w;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vI;
      varying float vHue;
      void main() {
        float d = length( vUv );
        float a = max( 0.0, 1.0 - d );
        float halo = a * a * 0.55;
        float core = pow( a, 10.0 ) * 1.6;
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

  // Primitives (unit sized).
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 8);
  const cyl12 = new THREE.CylinderGeometry(1, 1, 1, 12);
  const cone = new THREE.ConeGeometry(1, 1, 8);
  const hemi = new THREE.SphereGeometry(1, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  const ball = new THREE.SphereGeometry(1, 10, 7);
  const dot = new THREE.SphereGeometry(1, 5, 3);
  const ring = new THREE.TorusGeometry(1, 0.06, 4, 24);
  const ringLow = new THREE.TorusGeometry(1, 0.18, 3, 8);

  const props = new Bag();
  const glowBag = new Bag();
  const skyBag = new Bag(true);
  const books = new Inst();
  const openBooks = new Inst();
  const cushions = new Inst();
  const leaves = new Inst();
  const flowers = new Inst();
  const lights: LightSpot[] = [];
  const glowC: number[] = [];
  const glowD: number[] = [];

  const W = new THREE.Matrix4();
  /** world = W * local */
  const at = (m: THREE.Matrix4) => _w.multiplyMatrices(W, m);
  /** Adds a piece to a bag in the current wall frame. */
  const piece = (bag: Bag, geo: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color | number) => bag.add(geo, at(m), color);
  const toWorld = (x: number, y: number, z: number) => _v.set(x, y, z).applyMatrix4(W);

  const glow = (x: number, y: number, z: number, size: number, intensity: number, hue: number) => {
    const p = toWorld(x, y, z);
    glowC.push(p.x, p.y, p.z);
    glowD.push(size, rng() * 100, intensity, hue);
  };
  const light = (x: number, y: number, z: number, i: number, r: number) => {
    const p = toWorld(x, y, z);
    lights.push({ x: p.x, y: p.y, z: p.z, i, r });
  };

  // -- props, all in the current wall frame (x along, y up, z towards the field) --

  const lantern = (x: number, y: number, z: number, s: number, hanging = false) => {
    const brass = jitter(BRASS, 0.05);
    const dark = jitter(BRASS_DARK, 0.05);
    piece(props, cyl, local(x, y + 0.03 * s, z, 0, 0, 0, 0.17 * s, 0.06 * s, 0.17 * s), dark);
    piece(glowBag, cyl, local(x, y + 0.2 * s, z, 0, 0.4, 0, 0.1 * s, 0.26 * s, 0.1 * s), 0xf0a848);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      piece(props, box, local(x + Math.cos(a) * 0.12 * s, y + 0.2 * s, z + Math.sin(a) * 0.12 * s, 0, -a, 0, 0.05 * s, 0.3 * s, 0.05 * s), dark);
    }
    piece(props, cyl, local(x, y + 0.36 * s, z, 0, 0, 0, 0.16 * s, 0.04 * s, 0.16 * s), brass);
    piece(props, cone, local(x, y + 0.44 * s, z, 0, 0.4, 0, 0.15 * s, 0.14 * s, 0.15 * s), brass);
    piece(props, ringLow, local(x, y + 0.56 * s, z, 0, 0, 0, 0.06 * s, 0.06 * s, 0.06 * s), dark);
    if (hanging) piece(props, box, local(x, y + 0.6 * s + 0.25, z, 0, 0, 0, 0.02, 0.5, 0.02), dark);
    glow(x, y + 0.2 * s, z, 1.25 * s, 0.38, 0);
    glow(x, y + 0.2 * s, z, 0.3 * s, 0.6, 1);
    light(x, y + 0.25 * s, z, 0.5, 2.6 * Math.min(1.6, s));
  };

  const candle = (x: number, y: number, z: number, h: number) => {
    piece(props, cyl, local(x, y + h / 2, z, 0, 0, 0, 0.05, h, 0.05), jitter(0xeee0c0, 0.04));
    piece(glowBag, cone, local(x, y + h + 0.05, z, 0, 0, 0, 0.03, 0.1, 0.03), 0xffd27a);
    glow(x, y + h + 0.06, z, 0.4, 0.55, 1);
    light(x, y + h + 0.05, z, 0.22, 1.4);
  };

  const candles = (x: number, z: number, y = 0) => {
    piece(props, cyl12, local(x, y + 0.02, z, 0, 0, 0, 0.24, 0.04, 0.24), jitter(BRASS_DARK));
    const n = 2 + Math.floor(R(0, 2));
    for (let k = 0; k < n; k++) candle(x + R(-0.12, 0.12), y + 0.04, z + R(-0.12, 0.12), R(0.12, 0.38));
  };

  const mushrooms = (x: number, z: number) => {
    const n = 2 + Math.floor(R(0, 3));
    for (let k = 0; k < n; k++) {
      const s = R(1.0, 1.9);
      const mx = x + R(-0.35, 0.35);
      const mz = z + R(-0.3, 0.3);
      const h = 0.2 * s;
      piece(props, cyl, local(mx, h / 2, mz, R(-0.1, 0.1), 0, R(-0.1, 0.1), 0.045 * s, h, 0.045 * s), jitter(0xeadcc0, 0.04));
      piece(props, hemi, local(mx, h - 0.02, mz, 0, 0, 0, 0.15 * s, 0.075 * s, 0.15 * s), jitter(0xc8402e, 0.06));
      for (let d = 0; d < 5; d++) {
        const a = R(0, Math.PI * 2);
        const rr = R(0.02, 0.1) * s;
        piece(props, dot, local(mx + Math.cos(a) * rr, h - 0.02 + 0.07 * s * Math.sqrt(Math.max(0, 1 - (rr / (0.15 * s)) ** 2)), mz + Math.sin(a) * rr, 0, 0, 0, 0.022 * s, 0.01 * s, 0.022 * s), 0xfff4e0);
      }
    }
  };

  /** A book lying flat with its centre at (cx, cy, cz), yaw about y. */
  const lyingBook = (inst: Inst, cx: number, cy: number, cz: number, yaw: number, h: number, t: number, d: number) => {
    const ox = cx + (h / 2) * Math.cos(yaw);
    const oz = cz - (h / 2) * Math.sin(yaw);
    inst.push(at(local(ox, cy, oz, 0, yaw, Math.PI / 2, t, h, d)), jitter(pick(BOOK_COLORS)), Math.floor(R(0, 4)));
  };

  const bookStack = (x: number, z: number, y0 = 0, maxN = 7, s = 1) => {
    const n = 2 + Math.floor(R(0, maxN - 1));
    const baseYaw = R(0, Math.PI * 2);
    let y = y0;
    let w = R(0.62, 0.82) * s;
    for (let k = 0; k < n; k++) {
      const t = R(0.08, 0.16) * s;
      w = Math.max(0.4 * s, w - R(0, 0.06) * s);
      lyingBook(books, x + R(-0.04, 0.04), y + t / 2, z + R(-0.04, 0.04), baseYaw + R(-0.25, 0.25), w, t, w * R(0.66, 0.8));
      y += t;
    }
    return y;
  };

  const openBook = (x: number, z: number, y = 0, s = 1) => {
    openBooks.push(at(local(x, y, z, 0, R(-0.6, 0.6) + Math.PI, 0, 0.62 * s, 1, 0.62 * s)), jitter(pick(BOOK_COLORS)));
  };

  const cushion = (x: number, z: number, y = 0, s = R(0.75, 1.05)) => {
    cushions.push(at(local(x, y, z, R(-0.06, 0.06), R(0, Math.PI), R(-0.06, 0.06), s, s, s)), jitter(pick(CUSHION_COLORS), 0.06));
    return y + 0.34 * s;
  };

  const leaf = (x: number, y: number, z: number, rx: number, ry: number, rz: number, s: number) => {
    _e.set(rx, ry, rz, 'YXZ');
    _q.setFromEuler(_e);
    _l.compose(_p.set(x, y, z), _q, _s.set(s * 0.8, s, s));
    _e.order = 'XYZ';
    leaves.push(at(_l), jitter(pick(LEAF_COLORS), 0.06, 0.02));
  };

  const flower = (x: number, y: number, z: number, s: number, tiltX = 0, tiltZ = 0) => {
    flowers.push(at(local(x, y, z, tiltX, R(0, 6.3), tiltZ, s, s, s)), jitter(0xfffaf0, 0.03, 0.01));
  };

  const bush = (x: number, z: number, size: number, flowersN = 5) => {
    const n = Math.round(22 * size * size + 8);
    for (let k = 0; k < n; k++) {
      const yaw = R(0, Math.PI * 2);
      const tilt = R(0.5, 1.35);
      const r = R(0, 0.25) * size;
      leaf(x + Math.sin(yaw) * r, R(0, 0.35) * size, z + Math.cos(yaw) * r, tilt, yaw, R(-0.3, 0.3), R(0.26, 0.4) * size);
    }
    for (let k = 0; k < flowersN; k++) {
      const yaw = R(0, Math.PI * 2);
      const r = R(0.15, 0.5) * size;
      flower(x + Math.sin(yaw) * r, R(0.3, 0.6) * size, z + Math.cos(yaw) * r, R(0.08, 0.12), R(-0.4, 0.4), R(-0.4, 0.4));
    }
  };

  const pottedPlant = (x: number, z: number, y = 0, s = 1) => {
    piece(props, cyl12, local(x, y + 0.16 * s, z, 0, 0, 0, 0.2 * s, 0.32 * s, 0.2 * s), jitter(0xa45a36, 0.06));
    piece(props, cyl12, local(x, y + 0.33 * s, z, 0, 0, 0, 0.23 * s, 0.05 * s, 0.23 * s), jitter(0x8e4a2c, 0.05));
    const n = Math.round(16 * s);
    for (let k = 0; k < n; k++) {
      const yaw = R(0, Math.PI * 2);
      leaf(x, y + 0.32 * s, z, R(0.2, 1.4), yaw, R(-0.3, 0.3), R(0.28, 0.42) * s);
    }
  };

  const crate = (x: number, z: number, s = R(0.55, 0.75)) => {
    const yaw = R(-0.3, 0.3);
    piece(props, box, local(x, s / 2, z, 0, yaw, 0, s * 1.1, s, s), jitter(0x7a4c2a, 0.06));
    piece(props, box, local(x, s - 0.02, z, 0, yaw, 0, s * 1.14, 0.06, s * 1.04), jitter(0x5a3820, 0.05));
    return s;
  };

  const globe = (x: number, z: number, s = 1) => {
    const brass = jitter(BRASS, 0.03);
    piece(props, cyl12, local(x, 0.04 * s, z, 0, 0, 0, 0.32 * s, 0.08 * s, 0.32 * s), jitter(WOOD_DARK));
    piece(props, cyl, local(x, 0.45 * s, z, 0, 0, 0, 0.04 * s, 0.8 * s, 0.04 * s), brass);
    const cy = 1.2 * s;
    const rr = 0.42 * s;
    piece(props, ring, local(x, cy, z, 0, 0, 0.4, rr, rr, rr), brass);
    piece(props, ring, local(x, cy, z, Math.PI / 2, 0, 0.4, rr, rr, rr), brass);
    piece(props, ring, local(x, cy, z, Math.PI / 2, Math.PI / 2, 0.4, rr * 0.92, rr * 0.92, rr * 0.92), brass);
    piece(props, ring, local(x, cy, z, Math.PI / 2, 0.8, 0, rr * 1.12, rr * 1.12, rr * 1.12), jitter(BRASS_DARK));
    piece(glowBag, ball, local(x, cy, z, 0, 0, 0, 0.12 * s, 0.12 * s, 0.12 * s), 0xffd890);
    glow(x, cy, z, 1.6 * s, 0.6, 0);
    light(x, cy, z, 0.8, 3.2);
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
      if (run <= 0 && r < 0.05 && gap > 0.7 && x1 - x > 0.5) {
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
      books.push(at(local(x + t / 2, y0, -0.05 - d / 2 - R(0, 0.06), 0, 0, lean, t, h, d)), color, inRun ? runColor % 4 : Math.floor(R(0, 4)));
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
    piece(skyBag, sg, local(cx, y0, -DEPTH + 0.06), 0xffffff);
    sg.dispose();
    const fz = -DEPTH + 0.14;
    const frame = jitter(WOOD, 0.04);
    piece(props, box, local(x0 + 0.06, y0 + rectH / 2, fz, 0, 0, 0, 0.14, rectH, 0.16), frame);
    piece(props, box, local(x1 - 0.06, y0 + rectH / 2, fz, 0, 0, 0, 0.14, rectH, 0.16), frame);
    const arch = new THREE.TorusGeometry(r - 0.04, 0.08, 4, 14, Math.PI);
    piece(props, arch, local(cx, y0 + rectH, fz), frame);
    arch.dispose();
    piece(props, box, local(cx, y0 + (rectH + r * 0.9) / 2, fz, 0, 0, 0, 0.08, rectH + r * 0.9, 0.1), frame);
    for (const f of [0.38, 0.75]) piece(props, box, local(cx, y0 + rectH * f, fz, 0, 0, 0, 2 * r, 0.07, 0.1), frame);
    // Deep sill with a candle or a plant.
    piece(props, box, local(cx, y0 + 0.04, -DEPTH / 2 + 0.05, 0, 0, 0, x1 - x0, 0.1, DEPTH + 0.1), jitter(WOOD, 0.04));
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
      if (rng() < 0.08) flower(vx + R(-0.1, 0.1), y, z + 0.08, R(0.07, 0.1), Math.PI / 2 - 0.4, 0);
      y -= R(0.08, 0.15);
    }
  };

  /**
   * One wall of shelves along the current frame from x = 0 to `len`, with a floor strip `strip` deep in front.
   * `windows(bay, nb)` says which bays are windows.
   */
  const buildWall = (len: number, strip: number, windows: (j: number, nb: number) => boolean, ends: boolean) => {
    const wood = (l = 0.06) => jitter(WOOD, l);
    piece(props, box, local(len / 2, HEIGHT / 2, -DEPTH - 0.05, 0, 0, 0, len, HEIGHT, 0.1), jitter(WOOD_DARK, 0.02));
    piece(props, box, local(len / 2, 0.25, -DEPTH / 2, 0, 0, 0, len, 0.5, DEPTH), jitter(0x4a2c18, 0.02));
    piece(props, box, local(len / 2, 0.06, 0.02, 0, 0, 0, len, 0.12, 0.06), jitter(0x2e1b10, 0.02));
    piece(props, box, local(len / 2, HEIGHT + 0.16, -DEPTH / 2 + 0.12, 0, 0, 0, len, 0.32, DEPTH + 0.34), jitter(0x55321c, 0.02));
    piece(props, box, local(len / 2, HEIGHT + 0.38, -DEPTH / 2 + 0.06, 0, 0, 0, len, 0.12, DEPTH + 0.5), jitter(0x6e4428, 0.02));
    // Dark roof beyond the wall top, so the camera never sees the void behind the shelves.
    piece(props, box, local(len / 2, HEIGHT + 0.42, -DEPTH - 12, 0, 0, 0, len + 24, 0.05, 24), 0x1c120c);

    const nb = Math.max(1, Math.round(len / BAY));
    const bw = len / nb;
    for (let i = 0; i <= nb; i++) {
      const x = i * bw;
      if (!ends && (i === 0 || i === nb)) continue;
      piece(props, box, local(x, HEIGHT / 2, -DEPTH / 2 + 0.02, 0, 0, 0, 0.2, HEIGHT, DEPTH + 0.04), wood());
      piece(props, box, local(x, HEIGHT / 2, 0.04, 0, 0, 0, 0.26, HEIGHT, 0.06), jitter(0x6e4a32, 0.05));
      // Hanging lanterns on brackets in front of the posts.
      if (i > 0 && i < nb && rng() < 0.75) {
        const y = R(ROWS[1] + 0.2, ROWS[4]);
        piece(props, box, local(x, y + 0.95, 0.22, 0, 0, 0, 0.05, 0.05, 0.4), jitter(BRASS_DARK));
        lantern(x, y, 0.4, R(0.95, 1.15), true);
      }
    }
    for (let j = 0; j < nb; j++) {
      const x0 = j * bw + 0.1;
      const x1 = (j + 1) * bw - 0.1;
      const win = windows(j, nb);
      const winRow = 2;
      for (let r = 0; r < ROWS.length; r++) {
        const y0 = ROWS[r];
        const next = r + 1 < ROWS.length ? ROWS[r + 1] : HEIGHT;
        if (win && r >= winRow) {
          if (r === winRow) windowBay(x0, x1, y0);
          continue;
        }
        if (r > 0) piece(props, box, local((x0 + x1) / 2, y0 - 0.04, -DEPTH / 2, 0, 0, 0, x1 - x0, 0.08, DEPTH), wood(0.05));
        fillShelf(x0, x1, y0, next - y0 - 0.08);
      }
      // Ivy hanging from the cornice.
      const vines = rng() < 0.85 ? 1 + Math.floor(R(0, 2.2)) : 0;
      for (let k = 0; k < vines; k++) vine(R(x0, x1), R(1.2, win ? 2.2 : 4.8));
    }
    // Garland of leaves along the cornice top.
    for (let x = 0; x < len; x += R(0.08, 0.2))
      leaf(x, HEIGHT + 0.46, R(-0.2, 0.35), R(-1.6, -0.6), R(-0.4, 0.4), R(-2, 2), R(0.22, 0.34));

    // Floor strip props: a dense back row against the shelves, a middle row and small things at the field edge.
    // Everything here is a bit larger than life (P) so it reads from the high camera, like the reference.
    const P = 1.45;
    const ivyPatch = (cx: number, cz: number, n: number, spread: number) => {
      for (let k = 0; k < n; k++) {
        const lx = cx + R(-spread, spread);
        const lz = cz + R(-spread, spread) * 0.6;
        leaf(lx, R(0.01, 0.12), lz, -Math.PI / 2 + R(0.15, 0.7), R(0, 6.3), 0, R(0.26, 0.4));
        if (rng() < 0.14) flower(lx, R(0.1, 0.2), lz, R(0.1, 0.14));
      }
    };
    let x = R(0.2, 0.5);
    while (x < len - 0.3) {
      const back = rng();
      const zb = R(0.45, 0.85);
      if (back < 0.3) {
        const top = bookStack(x, zb, 0, 8, P);
        if (rng() < 0.45) lantern(x + R(-0.1, 0.1), top, zb, R(1.3, 1.6));
        else if (rng() < 0.4) candles(x, zb, top);
        else if (rng() < 0.4) openBook(x, zb, top, 0.9);
      } else if (back < 0.48) {
        const h = crate(x, zb, R(0.75, 1.0));
        if (rng() < 0.6) lantern(x, h, zb, R(1.3, 1.6));
        else bookStack(x, zb, h, 4, P);
      } else if (back < 0.66) bush(x, zb + 0.2, R(1.4, 2.0), 7);
      else if (back < 0.84) {
        let y = cushion(x, zb + 0.2, 0, R(1.1, 1.4));
        if (rng() < 0.5) y = cushion(x + R(-0.15, 0.15), zb + 0.2, y - 0.08, R(0.9, 1.1));
        if (rng() < 0.35) openBook(x, zb + 0.2, y - 0.05, 1.0);
      } else lantern(x, 0, zb, R(1.7, 2.1));
      ivyPatch(x, R(0.1, 0.6), 5 + Math.floor(R(0, 6)), 0.5);

      if (strip > 1.8 && rng() < 0.85) {
        const xm = x + R(-0.35, 0.35);
        const zm = R(1.5, 2.3);
        const mid = rng();
        if (mid < 0.25) cushion(xm, zm, 0, R(1.0, 1.3));
        else if (mid < 0.45) bookStack(xm, zm, 0, 5, P);
        else if (mid < 0.58) openBook(xm, zm, 0, 1.25);
        else if (mid < 0.7) lantern(xm, 0, zm, R(1.5, 1.8));
        else if (mid < 0.86) bush(xm, zm, R(1.0, 1.5), 6);
        else candles(xm, zm);
      }
      if (rng() < 0.5) {
        const xf = x + R(-0.4, 0.4);
        const zf = R(Math.min(strip - 0.4, 2.4), strip + 0.35);
        const f = rng();
        if (f < 0.35) mushrooms(xf, zf);
        else if (f < 0.55) openBook(xf, zf, 0, 1.1);
        else if (f < 0.75) ivyPatch(xf, zf, 8, 0.45);
        else if (f < 0.85) candles(xf, zf);
        else bush(xf, zf, R(0.7, 1.0), 3);
      }
      x += R(0.6, 1.0);
    }
  };

  // Left wall: x = -wallX, running from the near end (z = zNear) to the far wall.
  W.copy(wallFrame(-wallX, zNear, 0, -1, 1, 0));
  buildWall(sideLen, STRIP, (j, nb) => j % 4 === 1 && j < nb - 1, true);
  {
    // A globe on the left, a bit beyond the middle.
    const x = zNear - (opts.lineZ - opts.length * 0.7);
    globe(x, 1.7, 1.0);
  }
  // Right wall: x = +wallX, running from the far wall to the near end.
  W.copy(wallFrame(wallX, zBack, 0, 1, -1, 0));
  buildWall(sideLen, STRIP, (j, nb) => j % 4 === 3 && j > 0, true);
  {
    const x = opts.lineZ - 4.5 - zBack;
    globe(x, 1.9, 1.15);
  }
  // Far wall across the end, a wide window in the middle.
  W.copy(wallFrame(-wallX - DEPTH, zBack, 1, 0, 0, 1));
  buildWall(2 * (wallX + DEPTH), FAR_GAP, (j, nb) => Math.abs(j - (nb - 1) / 2) < 0.6 || j === 1 || j === nb - 2, false);

  // Floor strips beside the field and at the far end (slightly under the field floor so they never fight it).
  const floorGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    const strip = (x0: number, x1: number, z0: number, z1: number) => {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0, Math.ceil((x1 - x0) / 0.6), Math.ceil((z1 - z0) / 0.6));
      g.rotateX(-Math.PI / 2);
      g.translate((x0 + x1) / 2, -0.02, (z0 + z1) / 2);
      const p = g.attributes.position as THREE.BufferAttribute;
      const uv = g.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 2, -p.getZ(i) / 2);
      parts.push(g);
    };
    strip(-wallX - 0.1, -halfW + 0.8, zBack, zNear);
    strip(halfW - 0.8, wallX + 0.1, zBack, zNear);
    strip(-halfW + 0.8, halfW - 0.8, zBack - 0.1, opts.lineZ - opts.length + 0.8);
    const g = mergeGeometries(parts)!;
    parts.forEach((q) => q.dispose());
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  })();

  // Corner posts where the side walls meet the far wall.
  for (const s of [-1, 1]) {
    W.identity();
    piece(props, box, local(s * (wallX + DEPTH / 2), HEIGHT / 2 + 0.2, zBack - DEPTH / 2, 0, 0, 0, DEPTH + 0.1, HEIGHT + 0.4, DEPTH + 0.1), jitter(WOOD_DARK));
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
    return Math.min(b, 0.9);
  };
  const bakeGeometry = (g: THREE.BufferGeometry, scale = 1) => {
    const p = g.attributes.position as THREE.BufferAttribute;
    const out = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) out[i] = bakeAt(p.getX(i), p.getY(i), p.getZ(i)) * scale;
    g.setAttribute('bake', new THREE.BufferAttribute(out, 1));
  };

  const group = new THREE.Group();
  group.name = 'library';

  const propsGeo = props.build()!;
  bakeGeometry(propsGeo);
  group.add(new THREE.Mesh(propsGeo, libMaterial('props')));

  bakeGeometry(floorGeo, 0.9);
  group.add(new THREE.Mesh(floorGeo, libMaterial('floor', { map: stoneTexture() })));

  const glowGeo = glowBag.build()!;
  group.add(new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ vertexColors: true })));

  const skyGeo = skyBag.build();
  if (skyGeo) group.add(new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ map: skyTexture(), vertexColors: true })));

  const instanced = (inst: Inst, geo: THREE.BufferGeometry, mat: THREE.Material, atlas = false) => {
    if (!inst.count) return;
    const n = inst.count;
    const bake = new Float32Array(n);
    for (let i = 0; i < n; i++) bake[i] = bakeAt(inst.mats[i * 16 + 12], inst.mats[i * 16 + 13], inst.mats[i * 16 + 14]);
    geo.setAttribute('bake', new THREE.InstancedBufferAttribute(bake, 1));
    if (atlas) geo.setAttribute('bvar', new THREE.InstancedBufferAttribute(new Float32Array(inst.vars), 1));
    if (!geo.attributes.color) {
      const c = new Float32Array(geo.attributes.position.count * 3).fill(1);
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    (mesh.instanceMatrix.array as Float32Array).set(inst.mats);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(inst.cols), 3);
    mesh.computeBoundingSphere();
    group.add(mesh);
  };
  const atlas = bookAtlas();
  instanced(books, bookGeometry(), libMaterial('books', { map: atlas, trim: true, atlas: true }), true);
  instanced(openBooks, openBookGeometry(), libMaterial('openbooks', { map: atlas, trim: true, atlas: true }), true);
  instanced(cushions, cushionGeometry(), libMaterial('cushions', { map: cushionTexture(), trim: true }));
  instanced(leaves, leafGeometry(), libMaterial('leaves', { sway: true, side: THREE.DoubleSide }));
  instanced(flowers, flowerGeometry(), libMaterial('flowers', { sway: true, side: THREE.DoubleSide }));

  group.add(glowMesh(glowC, glowD));

  for (const g of [box, cyl, cyl12, cone, hemi, ball, dot, ring, ringLow]) g.dispose();
  scene.add(group);

  return {
    update(_dt: number, t: number) {
      time.value = t;
    },
  };
}
