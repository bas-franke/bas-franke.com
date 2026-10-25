// Garden Sentinels world: the garden boards built from a map's ASCII grid (see @shared/garden/maps).
//
// Per map (shared by every board, since versus boards are copies):
//   - a mask texture (8 px per cell, blurred): R = path, G = water, B = soil (beds, foliage), A = buildable grass.
//     The blur rounds path corners and water banks; shaders threshold it with smoothstep for soft clean edges.
//   - one ground mesh (0.5 m vertex grid) whose height dips into the water channel (recessed streams and ponds),
//     shaded by a MeshStandardMaterial patched with onBeforeCompile: grass with soft colour variation, faint lighter
//     buildable cells, cream paving slabs with a stone curb, mulch under beds, damp stony banks, a lush darker border.
// Per board:
//   - a water plane just below the bank line (the ground hides it everywhere else): stylised shader with depth
//     tint, caustics, sun glints, sparkle (HDR, feeds the bloom) and a soft foam line at the shore
//   - kit pieces: one InstancedMesh per kit part per board (cull per board), scattered from the grid chars plus a
//     border ring of hedges and trees; foliage sways in the wind (vertex shader on cloned materials)
//   - portals, greenhouse and bridges as kit copies; fake light pools (additive ground discs) under lamps, portals
//     and the greenhouse; a real point light in the greenhouse on high only
// Shared: a warm sun with soft shadows (its shadow frustum follows the camera focus, see post.ts setFocus via
// scene.userData.gardenFocus), a cool hemisphere fill, and a canopy-noise background plane with warm haze, so the
// space around and between boards reads as an out-of-focus garden, never a void.

import * as THREE from 'three';
import { G } from '@shared/garden/constants';
import { cellToWorld, type BoardOrigin } from '@shared/garden/board';
import type { GMapDef } from '@shared/garden/maps';
import type { CreateWorldView, GardenModels, KitName, P3, Quality, WorldView } from './api';

const CELL = G.cell;
/** Ground margin around each board's grid (half the versus gap, so neighbouring boards meet). */
const MARGIN = G.boardGap / 2;
const PX = 8;
const TEXEL = CELL / PX;
const WATER_Y = -0.16;
const BED_DEPTH = 0.75;
/** The background canopy plane sits this far below the ground (below the stream beds). */
const CANOPY_DROP = BED_DEPTH + 0.15;
/** Border ring depth (metres outside the grid) filled with hedges and trees. */
const RING = 7;

const SWAY: Partial<Record<KitName, number>> = {
  bush_a: 0.6,
  bush_b: 0.6,
  fern: 1,
  tree_a: 0.35,
  tree_b: 0.35,
  flowers_a: 1,
  flowers_b: 1,
  flowers_c: 1,
  grass_tuft: 1.4,
  reeds: 1.2,
  hedge_strip: 0.25,
};
const CASTS = new Set<KitName>(['rock_a', 'rock_b', 'rock_c', 'bush_a', 'bush_b', 'tree_a', 'tree_b', 'lamp', 'solar', 'fern', 'hedge_strip']);
const DENSITY: Record<Quality, number> = { low: 0.35, medium: 0.7, high: 1 };

/** Concatenates simple geometries (position + normal) into one non-indexed geometry. */
function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  for (const g of list) {
    const n = g.index ? g.toNonIndexed() : g;
    pos.push(...(n.attributes.position.array as Float32Array));
    nor.push(...(n.attributes.normal.array as Float32Array));
    if (n !== g) n.dispose();
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}

const glslColor = (hex: number) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

// ---- shared GLSL ------------------------------------------------------------------------------------------------

const NOISE = /* glsl */ `
float gHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float gNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float gFbm(vec2 p) { return gNoise(p) * 0.55 + gNoise(p * 2.07 + 13.1) * 0.3 + gNoise(p * 4.3 - 7.7) * 0.15; }
// Out-of-focus canopy seen from above: blobs of dark and sunlit foliage.
vec3 gCanopy(vec2 w) {
  float n = gFbm(w * 0.09);
  float m = gFbm(w * 0.35 + 3.0);
  float b = smoothstep(0.35, 0.8, n * 0.7 + m * 0.5);
  vec3 c = mix(${glslColor(0x1e3a1c)}, ${glslColor(0x2f5a27)}, b);
  c = mix(c, ${glslColor(0x4a7a30)}, smoothstep(0.78, 0.95, m) * 0.25);
  return c;
}
`;

// ---- mask -------------------------------------------------------------------------------------------------------

interface MapMask {
  tex: THREE.DataTexture;
  /** Ground / mask extent in metres. */
  sizeX: number;
  sizeZ: number;
  w: number;
  h: number;
  path: Float32Array;
  water: Float32Array;
}

function blur(src: Float32Array<ArrayBuffer>, w: number, h: number, r: number, passes = 2): Float32Array<ArrayBuffer> {
  let a = src;
  let b = new Float32Array(a.length);
  const n = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[y * w + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        b[y * w + x] = s / n;
        s += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
      }
    }
    [a, b] = [b, a];
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        b[y * w + x] = s / n;
        s += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

const pathy = (c: string | undefined) => c === '#' || c === '=';
/** A buildable cell within one step (8-neighbourhood) of a path: kept clear as a build spot, the rest is planted. */
function nearPath(def: GMapDef, c: number, r: number) {
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (pathy(def.grid[r + dr]?.[c + dc])) return true;
  return false;
}

function buildMask(def: GMapDef): MapMask {
  const W = def.grid[0].length;
  const H = def.grid.length;
  const sizeX = W * CELL + 2 * MARGIN;
  const sizeZ = H * CELL + 2 * MARGIN;
  const w = Math.round(sizeX / TEXEL);
  const h = Math.round(sizeZ / TEXEL);
  const path = new Float32Array(w * h);
  const water = new Float32Array(w * h);
  const soil = new Float32Array(w * h);
  const build = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = Math.floor(((y + 0.5) * TEXEL - MARGIN) / CELL);
    for (let x = 0; x < w; x++) {
      const col = Math.floor(((x + 0.5) * TEXEL - MARGIN) / CELL);
      const c = def.grid[row]?.[col];
      const i = y * w + x;
      if (c === undefined) {
        // Water that touches the grid edge runs on under the border.
        const cc = def.grid[Math.min(H - 1, Math.max(0, row))]?.[Math.min(W - 1, Math.max(0, col))];
        const d = Math.max(col < 0 ? -col : col >= W ? col - W + 1 : 0, row < 0 ? -row : row >= H ? row - H + 1 : 0);
        if ((cc === '~' || cc === 'o') && d <= 1) water[i] = 1;
        soil[i] = 0.35;
        continue;
      }
      if (c === '#' || c === '=') path[i] = 1;
      if (c === '~' || c === 'o' || c === '=') water[i] = 1;
      if (c === 'f' || c === 'T') soil[i] = 1;
      else if (c === 'R' || c === 'l' || c === 's') soil[i] = 0.4;
      if (c === '.') {
        build[i] = 1;
        // Planted buildable cells away from the paths: a little mulch under the shrubs.
        if (!nearPath(def, col, row)) soil[i] = 0.55;
      }
    }
  }
  const pb = blur(path, w, h, 3);
  const wb = blur(water, w, h, 3);
  const sb = blur(soil, w, h, 4);
  const bb = blur(build, w, h, 1, 1);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = Math.round(pb[i] * 255);
    data[i * 4 + 1] = Math.round(wb[i] * 255);
    data[i * 4 + 2] = Math.round(sb[i] * 255);
    data[i * 4 + 3] = Math.round(bb[i] * 255);
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { tex, sizeX, sizeZ, w, h, path: pb, water: wb };
}

function sampleField(m: MapMask, f: Float32Array, lx: number, lz: number) {
  const fx = Math.min(m.w - 1.001, Math.max(0, (lx + m.sizeX / 2) / TEXEL - 0.5));
  const fz = Math.min(m.h - 1.001, Math.max(0, (lz + m.sizeZ / 2) / TEXEL - 0.5));
  const x = Math.floor(fx);
  const z = Math.floor(fz);
  const tx = fx - x;
  const tz = fz - z;
  const i = z * m.w + x;
  return (f[i] * (1 - tx) + f[i + 1] * tx) * (1 - tz) + (f[i + m.w] * (1 - tx) + f[i + m.w + 1] * tx) * tz;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Ground height at a board-local point. */
function groundHeight(m: MapMask, lx: number, lz: number) {
  const w = sampleField(m, m.water, lx, lz);
  const p = sampleField(m, m.path, lx, lz);
  const bed = -BED_DEPTH * smooth(0.3, 0.78, w) * (1 - smooth(0.5, 0.9, p) * (1 - smooth(0.6, 1, w)));
  // The margin slopes down to the canopy plane so the seam between them never shows.
  const ex = Math.max(Math.abs(lx) - (m.sizeX / 2 - MARGIN), Math.abs(lz) - (m.sizeZ / 2 - MARGIN), 0);
  return Math.min(bed, -CANOPY_DROP * smooth(MARGIN * 0.45, MARGIN, ex));
}

function buildGround(m: MapMask): THREE.BufferGeometry {
  const sx = Math.round(m.sizeX / 0.5);
  const sz = Math.round(m.sizeZ / 0.5);
  const g = new THREE.PlaneGeometry(m.sizeX, m.sizeZ, sx, sz).rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, groundHeight(m, x, z));
    uv.setXY(i, (x + m.sizeX / 2) / m.sizeX, (z + m.sizeZ / 2) / m.sizeZ);
  }
  g.computeVertexNormals();
  return g;
}

// ---- materials --------------------------------------------------------------------------------------------------

interface GroundU {
  uMask: { value: THREE.Texture };
  uGridHalf: { value: THREE.Vector2 };
  uWilt: { value: number };
}

function groundMaterial(u: GroundU): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGUv;\nvarying vec3 vGLocal;\nvarying vec3 vGWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGUv = uv;\nvGLocal = position;\nvGWorld = (modelMatrix * vec4(position, 1.0)).xyz;',
      );
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uMask;
uniform vec2 uGridHalf;
uniform float uWilt;
varying vec2 vGUv;
varying vec3 vGLocal;
varying vec3 vGWorld;
${NOISE}`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
vec4 mk = texture2D(uMask, vGUv);
float gPath = mk.r;
float gWater = mk.g;
float gSoil = mk.b;
float gBuild = mk.a;
vec2 wp = vGWorld.xz;
vec2 lp = vGLocal.xz;
// Grass: broad patches, finer mottling and streaks.
float n1 = gFbm(wp * 0.11);
float n2 = gNoise(wp * 1.1);
float n3 = gNoise(wp * vec2(7.0, 2.5));
vec3 grass = mix(${glslColor(0x2f6b2a)}, ${glslColor(0x4f8f35)}, smoothstep(0.2, 0.85, n1));
grass = mix(grass, ${glslColor(0x7fb04a)}, smoothstep(0.62, 0.95, n2) * 0.2);
grass = mix(grass, ${glslColor(0x285c25)}, smoothstep(0.55, 0.9, gNoise(wp * 0.45 + 5.0)) * 0.3);
grass *= 0.92 + 0.12 * n3;
// Buildable cells: a faint lighter rounded square in every cell.
vec2 cp = (lp + uGridHalf) / ${CELL.toFixed(1)};
vec2 cf = abs(fract(cp) - 0.5);
float sq = 1.0 - smoothstep(0.36, 0.44, max(cf.x, cf.y));
grass *= 1.0 + gBuild * (0.06 * sq - 0.05 * (1.0 - sq) * smoothstep(0.47, 0.5, max(cf.x, cf.y)));
// Outside the grid: a lusher, darker border blending into the canopy background.
vec2 outD = max(abs(lp) - uGridHalf, 0.0);
float edge = length(outD);
vec3 col = mix(grass, mix(grass * 0.78, gCanopy(wp), smoothstep(1.0, 6.5, edge)), smoothstep(0.0, 2.0, edge));
// Mulch under beds and foliage.
vec3 soil = mix(${glslColor(0x4a3a22)}, ${glslColor(0x5f5a2c)}, gNoise(wp * 3.0)) * (0.85 + 0.3 * gNoise(wp * 11.0));
col = mix(col, soil, smoothstep(0.45, 0.9, gSoil) * (1.0 - smoothstep(0.0, 3.0, edge)) * 0.6);
// Banks: damp earth and pebbles down to the stream bed.
float bank = smoothstep(0.18, 0.42, gWater);
vec3 bankC = mix(${glslColor(0x8a8270)}, ${glslColor(0x6d6a5e)}, gNoise(wp * 5.0));
bankC *= 0.8 + 0.35 * smoothstep(0.55, 0.8, gNoise(wp * 9.0));
col = mix(col * (1.0 - 0.25 * smoothstep(0.08, 0.2, gWater)), bankC, bank);
col = mix(col, ${glslColor(0x3f6d6a)}, smoothstep(0.55, 0.85, gWater));
// Paths: cream paving slabs (1 m running bond) inside a lighter stone curb, with a soft shadow line on the grass.
float onPath = smoothstep(0.4, 0.47, gPath);
col *= 1.0 - 0.28 * smoothstep(0.22, 0.4, gPath) * (1.0 - onPath);
vec2 tp = lp + uGridHalf;
float row = floor(tp.y / 1.0);
vec2 tq = vec2(tp.x / 1.0 + 0.5 * mod(row, 2.0), tp.y / 1.0);
vec2 tid = floor(tq);
vec2 tf = fract(tq);
float tr = gHash(tid + 3.7);
vec3 slab = mix(${glslColor(0xf2c9a4)}, ${glslColor(0xfbd9b8)}, tr);
slab = mix(slab, ${glslColor(0xe3b48a)}, smoothstep(0.75, 1.0, gHash(tid + 9.1)) * 0.6);
slab *= 0.93 + 0.1 * gNoise(wp * 6.0) + 0.04 * gNoise(wp * 23.0);
float grout = smoothstep(0.035, 0.0, min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y)));
float bevel = smoothstep(0.14, 0.03, min(min(tf.x, 1.0 - tf.x), min(tf.y, 1.0 - tf.y)));
slab *= 1.0 - 0.06 * bevel;
slab = mix(slab, ${glslColor(0xc29a78)}, grout * 0.7);
// Narrow tan kerb with a darker outer line where it meets the planting.
float curb = onPath * (1.0 - smoothstep(0.53, 0.56, gPath));
vec3 curbC = mix(${glslColor(0x8a6b4e)}, ${glslColor(0xb8946c)}, smoothstep(0.455, 0.49, gPath)) * (0.92 + 0.1 * gNoise(wp * 8.0));
vec3 pathC = mix(slab, curbC, curb);
col = mix(col, pathC, onPath * (1.0 - smoothstep(0.5, 0.8, gWater) * (1.0 - step(0.9, gPath))));
// Eliminated board: wilted and grey-brown.
float lum = dot(col, vec3(0.3, 0.55, 0.15));
col = mix(col, vec3(lum) * vec3(1.05, 0.95, 0.8) * 0.8, uWilt);
vec4 diffuseColor = vec4(col, opacity);
float gRough = mix(0.95, 0.82, onPath);
`,
      )
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', '')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;');
  };
  mat.customProgramCacheKey = () => 'garden-ground';
  return mat;
}

function canopyMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGWorld = (modelMatrix * vec4(position, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGWorld;\n${NOISE}`)
      .replace('#include <map_fragment>', 'vec4 diffuseColor = vec4(gCanopy(vGWorld.xz), opacity);')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', '');
  };
  mat.customProgramCacheKey = () => 'garden-canopy';
  return mat;
}

interface WaterU {
  uMask: { value: THREE.Texture };
  uTime: { value: number };
  uWilt: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uSunCol: { value: THREE.Color };
  uTint: { value: number };
}

function waterMaterial(u: WaterU): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u as unknown as Record<string, THREE.IUniform>,
    vertexShader: /* glsl */ `
varying vec2 vUv;
varying vec3 vW;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`,
    fragmentShader: /* glsl */ `
uniform sampler2D uMask;
uniform float uTime;
uniform float uWilt;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform float uTint;
varying vec2 vUv;
varying vec3 vW;
${NOISE}
vec2 h22(vec2 p) { p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
// Animated cellular caustics: bright thin lines where cells meet.
float caustic(vec2 p, float t) {
  vec2 i = floor(p); vec2 f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = h22(i + g);
    o = 0.5 + 0.45 * sin(t + 6.2831 * o);
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return 1.0 - smoothstep(0.0, 0.12, d2 - d1);
}
void main() {
  float w = texture2D(uMask, vUv).g;
  float depth = smoothstep(0.45, 0.8, w);
  vec2 p = vW.xz;
  float t = uTime;
  vec3 shallow = mix(${glslColor(0x3cc4e6)}, ${glslColor(0x5fdccf)}, uTint * 0.3);
  vec3 deep = mix(${glslColor(0x1577d6)}, ${glslColor(0x2a9ff0)}, gNoise(p * 0.2 + t * 0.05) * 0.5);
  vec3 col = mix(shallow, deep, depth);
  col *= 0.85 + 0.15 * gNoise(p * 0.6 + vec2(t * 0.15, -t * 0.1));
  // Caustics: two layers drifting against each other.
  float c = caustic(p * 0.9 + vec2(t * 0.12, t * 0.05), t * 0.9) * 0.6 + caustic(p * 1.6 - vec2(t * 0.07, t * 0.11), t * 1.3) * 0.4;
  col += c * mix(vec3(0.3, 0.7, 1.0), vec3(0.4, 0.9, 0.95), 1.0 - depth) * 0.1;
  // Ripple normal for the sun glint: a few smooth directional waves (analytic slope).
  vec2 sl = vec2(0.0);
  vec2 dirs[4];
  dirs[0] = vec2(0.8, 0.6); dirs[1] = vec2(-0.5, 0.86); dirs[2] = vec2(0.96, -0.28); dirs[3] = vec2(-0.2, -0.98);
  for (int i = 0; i < 4; i++) {
    float f = 5.0 + float(i) * 2.7;
    float ph = dot(p, dirs[i]) * f + t * (1.1 + float(i) * 0.35) + gNoise(p * 0.3 + float(i)) * 3.0;
    sl += dirs[i] * cos(ph) * 0.09;
  }
  vec3 n = normalize(vec3(-sl.x, 1.0, -sl.y));
  vec3 v = normalize(cameraPosition - vW);
  vec3 hv = normalize(uSunDir + v);
  float spec = smoothstep(0.9965, 0.9995, dot(n, hv));
  float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
  col = mix(col, ${glslColor(0xbfe2ff)}, fres * 0.3);
  col += uSunCol * spec * smoothstep(0.55, 0.8, gNoise(p * 7.0 + t * 0.8)) * 1.2;
  // Sparkle: tiny glints that twinkle (HDR so the bloom catches them).
  vec2 sp = floor(p * 9.0);
  float tw = gHash(sp);
  float sparkle = step(0.992, tw) * pow(max(0.0, sin(t * (2.0 + tw * 3.0) + tw * 40.0)), 12.0);
  col += sparkle * vec3(1.6, 1.8, 2.0) * (0.4 + 0.6 * depth);
  // Soft foam line along the shore.
  float shore = smoothstep(0.54, 0.44, w);
  float foam = shore * smoothstep(0.3, 0.7, gNoise(p * 3.0 + vec2(t * 0.3, -t * 0.2)) * 0.5 + shore * 0.5);
  col = mix(col, vec3(0.9, 0.97, 1.0), foam * 0.6);
  float lum = dot(col, vec3(0.3, 0.55, 0.15));
  col = mix(col, vec3(lum) * vec3(0.9, 0.9, 0.85) * 0.75, uWilt);
  gl_FragColor = vec4(col, 1.0);
}`,
  });
}

/** Additive light pools on the ground (lamps, portals, greenhouse): colour * intensity per instance. */
function poolMaterial(time: { value: number }, wilt: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: time, uWilt: wilt },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying float vPhase;
void main() {
  vUv = uv * 2.0 - 1.0;
  vCol = instanceColor;
  vPhase = instanceMatrix[3][0] * 1.7 + instanceMatrix[3][2] * 2.3;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform float uTime;
uniform float uWilt;
varying vec2 vUv;
varying vec3 vCol;
varying float vPhase;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float k = (1.0 - r) * (1.0 - r);
  float fl = 0.92 + 0.05 * sin(uTime * 7.3 + vPhase) + 0.03 * sin(uTime * 13.1 + vPhase * 1.7);
  gl_FragColor = vec4(vCol * k * fl * (1.0 - uWilt), 1.0);
}`,
  });
}

/** Soft direction chevrons painted on the paths: a slow brightness wave runs along each route towards the greenhouse. */
function chevronMaterial(time: { value: number }, wilt: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: time, uWilt: wilt },
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    vertexShader: /* glsl */ `
attribute float aPhase;
varying vec2 vUv;
varying float vPhase;
void main() {
  vUv = uv;
  vPhase = aPhase;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
}`,
    fragmentShader: /* glsl */ `
uniform float uTime;
uniform float uWilt;
varying vec2 vUv;
varying float vPhase;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  // A rounded V pointing along +v (the walking direction).
  float y = p.y + abs(p.x) * 0.8 - 0.3;
  float band = smoothstep(0.26, 0.16, abs(y)) * (1.0 - smoothstep(0.66, 0.82, abs(p.x)));
  float wave = 0.5 + 0.5 * sin(vPhase * 0.6 - uTime * 2.2);
  float a = band * (0.34 + 0.36 * wave * wave) * (1.0 - uWilt);
  if (a < 0.003) discard;
  // Warm tan on the peach paving, a touch lighter as the wave passes.
  gl_FragColor = vec4(mix(${glslColor(0xb7764a)}, ${glslColor(0xd99a66)}, wave * wave), a);
}`,
  });
}

const ENTRY_TINT = [0xff8a3d, 0x2fc6c8, 0xa869ff, 0xf0c33c, 0x6bbf4b, 0xff6f9a];

/** Small cream plaque with the entry number, ringed in the entry's tint (canvas texture for a sprite). */
function entryPlaque(n: number): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  if (!g) return null;
  const tint = '#' + new THREE.Color(ENTRY_TINT[(n - 1) % ENTRY_TINT.length]).getHexString();
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.44, 0, Math.PI * 2);
  g.fillStyle = tint;
  g.fill();
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.36, 0, Math.PI * 2);
  g.fillStyle = '#fbf1e2';
  g.fill();
  g.fillStyle = '#4a3a2a';
  g.font = `bold ${Math.round(S * 0.46)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(n), S / 2, S / 2 + S * 0.03);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---- view -------------------------------------------------------------------------------------------------------

interface Inst {
  name: KitName;
  b: number;
  x: number;
  y: number;
  z: number;
  ry: number;
  s: number;
  /** Optional local-space scale multipliers (x, y, z) before rotation. */
  sv?: [number, number, number];
  /** Kept when below the quality density (scatter only; 0 = always). */
  keep: number;
  cast: boolean;
}

interface Board {
  o: BoardOrigin;
  ground: THREE.Mesh;
  water: THREE.Mesh;
  groundU: GroundU;
  waterU: WaterU;
  wilt: { value: number };
  pools: THREE.InstancedMesh | null;
  meshes: THREE.InstancedMesh[];
  green: THREE.Object3D;
  greenGlow: { m: THREE.MeshStandardMaterial; base: number }[];
  portalGlow: { m: THREE.MeshStandardMaterial; base: number }[];
  light: THREE.PointLight;
  chevrons: THREE.InstancedMesh | null;
  plaques: THREE.Sprite[];
  health: number;
  out: boolean;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function glowMats(root: THREE.Object3D, boost = 1): { m: THREE.MeshStandardMaterial; base: number }[] {
  const out: { m: THREE.MeshStandardMaterial; base: number }[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cloned = list.map((m) => {
      const sm = m as THREE.MeshStandardMaterial;
      if (sm.emissive && (sm.emissiveIntensity > 0 && sm.emissive.getHex() !== 0)) {
        const c = sm.clone();
        out.push({ m: c, base: c.emissiveIntensity * boost });
        return c;
      }
      return m;
    });
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
  });
  return out;
}

export const createWorldView: CreateWorldView = (scene, def, origins, models, quality) => {
  const group = new THREE.Group();
  group.name = 'garden-world';
  scene.add(group);
  const W = def.grid[0].length;
  const H = def.grid.length;
  const halfX = (W * CELL) / 2;
  const halfZ = (H * CELL) / 2;
  const cell = (c: number, r: number) => def.grid[r]?.[c];
  const warmth = def.mood?.warmth ?? 0.6;

  const mask = buildMask(def);
  const groundGeo = buildGround(mask);
  const time = { value: 0 };

  // ---- light ----
  const sunDir = new THREE.Vector3(-0.55, 1.15, -0.75).normalize();
  const sun = new THREE.DirectionalLight(new THREE.Color().setHSL(0.09, 0.5 + warmth * 0.35, 0.85), 2.7);
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  group.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xc4dcff, 0x56703a, 1.0);
  group.add(hemi);

  const xs = origins.map((o) => o.x);
  const zs = origins.map((o) => o.z);
  const bounds = {
    minX: Math.min(...xs) - halfX - 2,
    maxX: Math.max(...xs) + halfX + 2,
    minZ: Math.min(...zs) - halfZ - 2,
    maxZ: Math.max(...zs) + halfZ + 2,
  };
  const centre = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);

  // Shadow frustum: fitted around the camera focus (post.ts calls this from setFocus), snapped to texels.
  const tmpV = new THREE.Vector3();
  const focusShadows = (target: P3, distance: number) => {
    const ext = Math.min(span * 0.75 + 10, Math.max(22, distance * 0.62));
    const cam = sun.shadow.camera;
    const texel = (2 * ext) / sun.shadow.mapSize.x;
    // Snap the focus in light space so the shadow edges do not crawl while panning.
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), sunDir);
    tmpV.set(target.x, 0, target.z).applyQuaternion(q.clone().invert());
    tmpV.x = Math.round(tmpV.x / texel) * texel;
    tmpV.y = Math.round(tmpV.y / texel) * texel;
    tmpV.applyQuaternion(q);
    sun.target.position.copy(tmpV);
    sun.position.copy(tmpV).addScaledVector(sunDir, 150);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
    if (cam.right !== ext) {
      cam.left = -ext;
      cam.right = ext;
      cam.top = ext;
      cam.bottom = -ext;
      cam.far = 320;
      cam.updateProjectionMatrix();
    }
  };
  focusShadows(centre, span * 0.9);
  scene.userData.gardenFocus = focusShadows;

  // ---- sky / background ----
  const haze = new THREE.Color(0xd9e2c0);
  const prevBg = scene.background;
  const prevFog = scene.fog;
  scene.background = haze;
  scene.fog = new THREE.Fog(haze, span * 1.2 + 120, span * 3 + 500);
  const canopy = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), canopyMaterial());
  canopy.scale.set(span * 6 + 1600, 1, span * 6 + 1600);
  canopy.position.set(centre.x, -CANOPY_DROP, centre.z);
  canopy.receiveShadow = true;
  group.add(canopy);

  // ---- kit instancing ----
  const swayMats = new Map<THREE.Material, THREE.Material>();
  const hotMats = new Map<THREE.Material, THREE.Material>();
  const matFor = (m: THREE.Material, sway: number): THREE.Material => {
    if (!sway) {
      // Instanced glow (lamp bulbs, solar LEDs): a little hotter so the bloom picks it up.
      const sm = m as THREE.MeshStandardMaterial;
      if (!sm.emissive || sm.emissive.getHex() === 0) return m;
      let c = hotMats.get(m);
      if (!c) {
        const g = sm.clone();
        g.emissiveIntensity *= 2.2;
        hotMats.set(m, (c = g));
      }
      return c;
    }
    const key = swayMats.get(m);
    if (key) return key;
    const c = m.clone();
    c.onBeforeCompile = (s) => {
      s.uniforms.uTime = time;
      s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 swIp = instanceMatrix[3].xyz;
float swS = length(instanceMatrix[1].xyz);
#else
vec3 swIp = vec3(0.0); float swS = 1.0;
#endif
float swH = max(position.y, 0.0) * swS;
float swA = sin(uTime * 1.6 + swIp.x * 0.37 + swIp.z * 0.29) + 0.4 * sin(uTime * 3.7 + swIp.x * 1.3);
transformed.x += swA * swH * 0.045;
transformed.z += cos(uTime * 1.3 + swIp.z * 0.41) * swH * 0.03;`,
      );
    };
    c.customProgramCacheKey = () => `garden-sway-${m.type}`;
    swayMats.set(m, c);
    return c;
  };

  // Kit parts, with local stand-ins for pieces kit.glb may not have yet (hedge_strip, pad).
  type Part = { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 };
  const fallback = new Map<KitName, Part[]>();
  const fallbackOwned: { dispose(): void }[] = [];
  const partsFor = (name: KitName): Part[] => {
    const real = models.kitParts(name);
    if (real.length) return real;
    let f = fallback.get(name);
    if (f) return f;
    const list: Part[] = [];
    const add = (geometry: THREE.BufferGeometry, color: number) => {
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
      fallbackOwned.push(geometry, material);
      list.push({ geometry, material, matrix: new THREE.Matrix4() });
    };
    if (name === 'hedge_strip') {
      add(new THREE.CapsuleGeometry(0.17, 1.66, 3, 8).rotateZ(Math.PI / 2).scale(1, 1, 1.15).translate(0, 0.17, 0), 0x3e7a33);
      const dots: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 7; i++) dots.push(new THREE.IcosahedronGeometry(0.05, 0).translate(-0.85 + i * 0.28, 0.33, (i % 2 ? 1 : -1) * 0.08));
      add(mergeGeos(dots), 0xf3a6c8);
    } else if (name === 'pad') {
      add(new THREE.RingGeometry(0.62, 0.8, 40).rotateX(-Math.PI / 2).translate(0, 0.025, 0), 0xf5e7d6);
      add(new THREE.CircleGeometry(0.3, 5).scale(0.6, 1, 1).rotateX(-Math.PI / 2).translate(0, 0.02, 0), 0x6baf4b);
    }
    f = list;
    fallback.set(name, f);
    return f;
  };
  /** True when a kit piece's long horizontal axis is its local Z. */
  const longAlongZ = (name: KitName) => {
    const box = new THREE.Box3();
    const b = new THREE.Box3();
    for (const p of partsFor(name)) {
      p.geometry.computeBoundingBox();
      box.union(b.copy(p.geometry.boundingBox!).applyMatrix4(p.matrix));
    }
    return !box.isEmpty() && box.max.z - box.min.z > box.max.x - box.min.x;
  };

  const poolGeo = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const swirlGeo = new THREE.PlaneGeometry(1, 1);
  const swirlMat = new THREE.ShaderMaterial({
    uniforms: { uTime: time },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
uniform float uTime;
varying vec2 vUv;
${NOISE}
void main() {
  // Arch-shaped opening: a rectangle with a round top.
  vec2 p = vec2(vUv.x * 2.0 - 1.0, vUv.y * 2.0 - 1.0);
  float arch = p.y < 0.0 ? abs(p.x) : length(vec2(p.x, p.y * 1.0));
  float inside = 1.0 - smoothstep(0.75, 1.0, arch);
  vec2 q = vec2(p.x, p.y + 0.15);
  float r = length(q);
  float a = atan(q.y, q.x);
  float sw = gNoise(vec2(a * 2.0 + r * 4.0 - uTime * 1.8, r * 3.0 - uTime * 0.6));
  float core = exp(-r * 2.2);
  vec3 col = mix(${glslColor(0xd2601c)}, ${glslColor(0xffa940)}, smoothstep(0.1, 0.7, core + sw * 0.4));
  col = mix(col, ${glslColor(0xffe2a8)}, smoothstep(0.75, 1.0, core));
  col = mix(col, ${glslColor(0xa869ff)}, smoothstep(0.62, 0.85, sw) * (1.0 - core) * 0.45);
  float k = inside * (0.35 + 0.9 * core + 0.5 * smoothstep(0.45, 0.8, sw));
  float pulse = 0.5 + 0.5 * sin(uTime * 2.0);
  gl_FragColor = vec4(col * k * (1.25 + 0.6 * pulse * pulse), 1.0);
}`,
  });
  const boards: Board[] = [];
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpS = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const fixed: Inst[] = [];
  const scatter: Inst[] = [];
  const pools: { b: number; x: number; y: number; z: number; r: number; color: THREE.Color }[] = [];
  const goals: P3[] = [];
  const portals: P3[][] = [];
  const AMBER = new THREE.Color(0xffa940);

  // Versus overviews show every board at once: thin the border greenery when there are many.
  const ringDensity = origins.length > 3 ? 0.42 : origins.length > 1 ? 0.75 : 1;
  // ... and the optional scatter inside the boards (applied on top of the quality density), with fewer shadow casters.
  const many = origins.length > 3;
  const crowd = many ? 0.55 : origins.length > 1 ? 0.8 : 1;
  const isWater = (c: string | undefined) => c === '~' || c === 'o';
  const isPathy = (c: string | undefined) => c === '#' || c === '=';

  // Direction chevrons (board-local): every ~2.6 m along each route, skipping bridges, the portal mouth and the
  // greenhouse door, and where a chevron of another route already points the same way nearby (shared trunks).
  const chevLocal: { x: number; z: number; yaw: number; phase: number }[] = [];
  {
    const o0 = { x: 0, z: 0 };
    for (const rt of def.routes) {
      const pts = rt.pts.map(([x, y]) => cellToWorld(def, o0, x, y));
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      let along = 0;
      let next = 2.2;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b2 = pts[i];
        const len = Math.hypot(b2.x - a.x, b2.z - a.z);
        if (len < 1e-3) continue;
        const dx = (b2.x - a.x) / len;
        const dz = (b2.z - a.z) / len;
        while (next <= along + len) {
          const t = next - along;
          const x = a.x + dx * t;
          const z = a.z + dz * t;
          const d = next;
          next += 3.2;
          if (total - d < 2.5) continue;
          const col = Math.floor(x / CELL + W / 2);
          const row = Math.floor(z / CELL + H / 2);
          if (cell(col, row) !== '#') continue;
          // Keep clear of corners (the polyline bends there).
          if (t < 0.9 || len - t < 0.9) continue;
          if (chevLocal.some((cv) => Math.hypot(cv.x - x, cv.z - z) < 2)) continue;
          chevLocal.push({ x, z, yaw: Math.atan2(-dx, -dz), phase: d });
        }
        along += len;
      }
    }
  }
  const chevGeo = new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2);
  const plaqueTex = def.entries.map((_, i) => entryPlaque(i + 1));
  const plaqueMats = plaqueTex.map((t) => (t ? new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: false }) : null)) as THREE.SpriteMaterial[];

  // "Build here" pads: on buildable cells beside a path, spaced out (at least 3 cells apart) so they read as a
  // scattering of invitations rather than a bead chain. Same cells on every board.
  const padCells = new Set<number>();
  {
    const taken: [number, number][] = [];
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        if (cell(c, r) !== '.' || ![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => isPathy(cell(c + dc, r + dr)))) continue;
        if (taken.some(([tc, tr]) => Math.max(Math.abs(tc - c), Math.abs(tr - r)) < 4)) continue;
        taken.push([c, r]);
        padCells.add(r * W + c);
      }
  }

  origins.forEach((o, b) => {
    const R = rng(1013 + b * 7919);
    const wp = (cx: number, cy: number) => cellToWorld(def, o, cx, cy);
    const put = (list: Inst[], name: KitName, x: number, z: number, s = 1, y?: number, ry = R() * Math.PI * 2, keep = 0, cast = true, sv?: [number, number, number]) =>
      list.push({ name, b, x, z, y: y ?? groundHeight(mask, x - o.x, z - o.z), ry, s, keep, cast: cast && CASTS.has(name), sv });
    const FLOWERS: KitName[] = ['flowers_a', 'flowers_b', 'flowers_c'];
    const flower = () => FLOWERS[Math.floor(R() * 3)];

    // Ground + water.
    const groundU: GroundU = { uMask: { value: mask.tex }, uGridHalf: { value: new THREE.Vector2(halfX, halfZ) }, uWilt: { value: 0 } };
    const ground = new THREE.Mesh(groundGeo, groundMaterial(groundU));
    ground.position.set(o.x, 0, o.z);
    ground.receiveShadow = true;
    group.add(ground);
    const wilt = groundU.uWilt;
    const waterU: WaterU = {
      uMask: { value: mask.tex },
      uTime: time,
      uWilt: wilt,
      uSunDir: { value: sunDir },
      uSunCol: { value: sun.color },
      uTint: { value: def.mood?.water ?? 0.5 },
    };
    const wGeo = new THREE.PlaneGeometry(W * CELL + 4, H * CELL + 4).rotateX(-Math.PI / 2);
    {
      const pos = wGeo.attributes.position as THREE.BufferAttribute;
      const uv = wGeo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + mask.sizeX / 2) / mask.sizeX, (pos.getZ(i) + mask.sizeZ / 2) / mask.sizeZ);
    }
    const water = new THREE.Mesh(wGeo, waterMaterial(waterU));
    water.position.set(o.x, WATER_Y, o.z);
    water.renderOrder = 1;
    group.add(water);

    // Cells.
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        const ch = cell(c, r);
        const p = wp(c + 0.5, r + 0.5);
        const j = (k = 0.5) => (R() - 0.5) * k * CELL;
        switch (ch) {
          case 'R': {
            const k = R();
            put(fixed, k < 0.33 ? 'rock_a' : k < 0.66 ? 'rock_b' : 'rock_c', p.x + j(0.2), p.z + j(0.2), 0.85 + R() * 0.4);
            if (R() < 0.6) put(scatter, 'fern', p.x + j(0.8), p.z + j(0.8), 0.7 + R() * 0.4, undefined, undefined, R());
            for (let i = 0; i < 2; i++) put(scatter, 'pebble', p.x + j(0.9), p.z + j(0.9), 0.8 + R() * 0.8, undefined, undefined, R());
            break;
          }
          case 'T': {
            if (R() < 0.32) {
              put(fixed, R() < 0.75 ? 'tree_a' : 'tree_b', p.x + j(0.3), p.z + j(0.3), 0.75 + R() * 0.35);
              put(scatter, 'fern', p.x + j(0.8), p.z + j(0.8), 0.8 + R() * 0.3, undefined, undefined, R());
            } else {
              put(fixed, R() < 0.7 ? 'bush_a' : 'bush_b', p.x + j(0.4), p.z + j(0.4), 1.05 + R() * 0.4);
              if (R() < 0.35) put(scatter, R() < 0.7 ? 'bush_a' : 'bush_b', p.x + j(0.7), p.z + j(0.7), 0.7 + R() * 0.3, undefined, undefined, R());
              put(scatter, 'fern', p.x + j(0.8), p.z + j(0.8), 0.7 + R() * 0.4, undefined, undefined, R());
              if (R() < 0.5) put(scatter, (['flowers_a', 'flowers_b', 'flowers_c'] as KitName[])[Math.floor(R() * 3)], p.x + j(0.8), p.z + j(0.8), 0.8, undefined, undefined, R());
            }
            break;
          }
          case 'f': {
            const n = 3;
            for (let i = 0; i < n; i++)
              put(i === 0 ? fixed : scatter, (['flowers_a', 'flowers_b', 'flowers_c'] as KitName[])[Math.floor(R() * 3)], p.x + j(0.7), p.z + j(0.7), 0.9 + R() * 0.4, undefined, undefined, i === 0 ? 0 : R());
            if (R() < 0.5) put(scatter, 'fern', p.x + j(0.7), p.z + j(0.7), 0.6, undefined, undefined, R());
            break;
          }
          case 'l': {
            put(fixed, 'lamp', p.x, p.z, 1, 0);
            pools.push({ b, x: p.x, y: 0.03, z: p.z, r: 3.2, color: AMBER.clone().multiplyScalar(0.55) });
            put(scatter, 'grass_tuft', p.x + j(0.8), p.z + j(0.8), 1, undefined, undefined, R());
            break;
          }
          case 's':
            put(fixed, 'solar', p.x, p.z, 1, 0, Math.PI * 0.75 + (R() - 0.5) * 0.3);
            break;
          case 'o': {
            const n = 2 + Math.floor(R() * 2);
            for (let i = 0; i < n; i++) put(fixed, 'lilypad', p.x + j(0.8), p.z + j(0.8), 0.7 + R() * 0.6, WATER_Y + 0.012);
            break;
          }
          case '~':
            if (R() < 0.08) put(scatter, 'lilypad', p.x + j(0.6), p.z + j(0.6), 0.6 + R() * 0.5, WATER_Y + 0.012, undefined, R());
            break;
          case '.': {
            if (!nearPath(def, c, r)) {
              // Away from the paths: planted at roughly 0.5-0.7 cover, shrubs towards the corners so a tower's
              // planter in the middle still sits clear, with ferns and flowers between.
              const corners = [0, 1, 2, 3].sort(() => R() - 0.5);
              const nb = !many && R() < 0.55 ? 2 : 1;
              for (let i = 0; i < nb; i++) {
                const k = corners[i];
                const cx = (k & 1 ? 1 : -1) * (0.5 + R() * 0.15);
                const cz = (k & 2 ? 1 : -1) * (0.5 + R() * 0.15);
                put(i === 0 ? fixed : scatter, R() < 0.75 ? 'bush_a' : 'bush_b', p.x + cx, p.z + cz, 0.7 + R() * 0.3, undefined, undefined, i === 0 ? 0 : R(), i === 0 && !many);
              }
              for (let i = 0; i < 4 - nb; i++) {
                const k = corners[nb + i];
                const cx = (k & 1 ? 1 : -1) * (0.45 + R() * 0.2);
                const cz = (k & 2 ? 1 : -1) * (0.45 + R() * 0.2);
                put(scatter, i === 0 || R() < 0.4 ? 'fern' : flower(), p.x + cx, p.z + cz, 0.8 + R() * 0.4, undefined, undefined, R() * 0.8, false);
              }
              for (let i = 0; i < 2; i++) put(scatter, flower(), p.x + j(0.7), p.z + j(0.7), 0.6 + R() * 0.3, undefined, undefined, i === 0 ? 0 : R());
              if (R() < 0.5) put(scatter, 'grass_tuft', p.x + j(0.6), p.z + j(0.6), 0.9 + R() * 0.4, undefined, undefined, R());
              break;
            }
            // Next to a path: a clear build spot with a cream "build here" pad; sparse tufts near the cell edges.
            if (padCells.has(r * W + c))
              put(fixed, 'pad', p.x, p.z, 1, groundHeight(mask, p.x - o.x, p.z - o.z) + 0.01, 0, 0, false);
            for (let i = 0; i < 2; i++) {
              const a = R() * Math.PI * 2;
              const d = 0.62 + R() * 0.3;
              put(scatter, 'grass_tuft', p.x + Math.cos(a) * d, p.z + Math.sin(a) * d, 0.8 + R() * 0.5, undefined, undefined, R() * 1.4);
            }
            if (R() < 0.12) put(scatter, (['flowers_a', 'flowers_b', 'flowers_c'] as KitName[])[Math.floor(R() * 3)], p.x + j(0.85), p.z + j(0.85), 0.35 + R() * 0.15, undefined, undefined, R());
            if (R() < 0.12) put(scatter, 'pebble', p.x + j(0.9), p.z + j(0.9), 0.8 + R(), undefined, undefined, R());
            break;
          }
        }
        // Stony banks: rocks along every water edge that meets land.
        if (isWater(ch) || ch === '=') {
          const nb: [number, number][] = [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ];
          for (const [dc, dr] of nb) {
            const n = cell(c + dc, r + dr);
            if (n === undefined || isWater(n) || isPathy(n) || n === '=' || n === 'G' || n === 'E') continue;
            if (ch === '=') continue;
            for (let i = 0; i < 2; i++) {
              if (R() > 0.9) continue;
              const along = (i - 0.5) * 0.5 + (R() - 0.5) * 0.35;
              const ex = p.x + dc * CELL * 0.45 + (dr !== 0 ? along * CELL : 0);
              const ez = p.z + dr * CELL * 0.45 + (dc !== 0 ? along * CELL : 0);
              const k = R();
              put(i === 0 ? fixed : scatter, k < 0.4 ? 'rock_b' : k < 0.75 ? 'rock_a' : 'rock_c', ex, ez, 0.7 + R() * 0.3, -0.14, undefined, i === 0 ? 0 : R());
            }
            if (R() < 0.25) put(scatter, 'reeds', p.x + dc * CELL * 0.35, p.z + dr * CELL * 0.35, 0.8 + R() * 0.4, WATER_Y, undefined, R());
          }
        }
      }

    // Hedge edging along every path edge: a full flowered hedge where the path borders planting (beds, trees,
    // rocks, lamps), a low flowered edging (~0.2 m) next to buildable cells so it never hides towers.
    const hedgeZ = longAlongZ('hedge_strip');
    const TALL = new Set(['T', 'f', 'R', 'l', 's']);
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        if (cell(c, r) !== '#') continue;
        for (const [dc, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const n = cell(c + dc, r + dr);
          if (n === undefined) continue;
          const tall = TALL.has(n);
          if (!tall && n !== '.') continue;
          // Along the edge (ax/az): trim the ends where the neighbour cell's sides also meet a path (the path's
          // rounded inner corner reaches in there).
          const ax = dr !== 0 ? 1 : 0;
          const az = dc !== 0 ? 1 : 0;
          const tA = isPathy(cell(c + dc - ax, r + dr - az)) ? 0.55 : 0;
          const tB = isPathy(cell(c + dc + ax, r + dr + az)) ? 0.55 : 0;
          const len = CELL - tA - tB;
          if (len < 0.8) continue;
          const shift = (tA - tB) / 2;
          const off = tall ? 0.26 : 0.18;
          const e = wp(c + 0.5 + dc * 0.5, r + 0.5 + dr * 0.5);
          const x = e.x + dc * off + ax * shift;
          const z = e.z + dr * off + az * shift;
          const ry = (ax ? 0 : Math.PI / 2) + (hedgeZ ? Math.PI / 2 : 0) + (R() < 0.5 ? Math.PI : 0);
          const L = (len / CELL) * 1.04;
          const sy = tall ? 1 : 0.58;
          const sw = tall ? 1 : 0.8;
          const sv: [number, number, number] = hedgeZ ? [sw, sy, L] : [L, sy, sw];
          // Low edging is dropped as a whole on low quality (never patchy).
          put(fixed, 'hedge_strip', x, z, 1, undefined, ry, tall ? 0 : 0.5, tall && !many, sv);
        }
      }

    const portalLocal = def.entries.map((e) => cellToWorld(def, { x: 0, z: 0 }, e.x, e.y));
    // Border ring: low hedges and flowers hugging the grid, trees further out.
    const ringArea = (2 * halfX + RING) * (2 * halfZ + RING) * 4 - 4 * halfX * halfZ;
    const n = Math.round((ringArea / 6.5) * ringDensity);
    for (let i = 0; i < n; i++) {
      const x = (R() * 2 - 1) * (halfX + RING);
      const z = (R() * 2 - 1) * (halfZ + RING);
      const dx = Math.abs(x) - halfX;
      const dz = Math.abs(z) - halfZ;
      const d = Math.max(dx, dz);
      if (d < 0.3) continue;
      // Leave the water running out under the border visible, and the portals' surroundings clear.
      if (sampleField(mask, mask.water, x, z) > 0.2) continue;
      if (portalLocal.some((p) => Math.hypot(p.x - x, p.z - z) < 4.2)) continue;
      const k = R();
      // Low quality keeps the hedge line hugging the grid and drops most of the deeper ring (keep = drop order).
      // (x crowd: the ring is already thinned by count above, so the in-board crowd factor must not thin it again.)
      const keep = (d < 1.6 ? 0.3 * R() : 0.3 + 0.7 * R()) * crowd;
      // Mostly green: pink blossom trees about 1 in 4, big fern / broadleaf clumps between the shrubs.
      if (d > 2.8 && k < 0.26) put(scatter, R() < 0.75 ? 'tree_a' : 'tree_b', o.x + x, o.z + z, 1.1 + R() * 0.7, undefined, undefined, keep, d < 3.5);
      else if (k < 0.66) put(scatter, R() < 0.8 ? 'bush_a' : 'bush_b', o.x + x, o.z + z, 1.5 + R() * 0.9, undefined, undefined, keep, d < 1.8);
      else if (k < 0.8) put(scatter, 'fern', o.x + x, o.z + z, 1.8 + R() * 0.8, undefined, undefined, keep, d < 1.8);
      else if (k < 0.9) put(scatter, flower(), o.x + x, o.z + z, 1 + R() * 0.4, undefined, undefined, R() * crowd);
      else put(scatter, 'fern', o.x + x, o.z + z, 1 + R() * 0.5, undefined, undefined, R() * crowd);
    }

    // Bridges: one per connected run of '=' cells, along the path direction.
    const seen = new Set<number>();
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        if (cell(c, r) !== '=' || seen.has(r * W + c)) continue;
        let c0 = c,
          c1 = c,
          r0 = r,
          r1 = r;
        const stack = [[c, r]];
        seen.add(r * W + c);
        while (stack.length) {
          const [x, y] = stack.pop()!;
          c0 = Math.min(c0, x);
          c1 = Math.max(c1, x);
          r0 = Math.min(r0, y);
          r1 = Math.max(r1, y);
          for (const [dx, dy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            const k = (y + dy) * W + x + dx;
            if (cell(x + dx, y + dy) === '=' && !seen.has(k)) {
              seen.add(k);
              stack.push([x + dx, y + dy]);
            }
          }
        }
        let hz = 0;
        let vt = 0;
        for (let y = r0; y <= r1; y++) hz += (isPathy(cell(c0 - 1, y)) ? 1 : 0) + (isPathy(cell(c1 + 1, y)) ? 1 : 0);
        for (let x = c0; x <= c1; x++) vt += (isPathy(cell(x, r0 - 1)) ? 1 : 0) + (isPathy(cell(x, r1 + 1)) ? 1 : 0);
        const along = hz > vt ? 'x' : 'z';
        const len = (along === 'x' ? c1 - c0 + 1 : r1 - r0 + 1) * CELL;
        const wid = (along === 'x' ? r1 - r0 + 1 : c1 - c0 + 1) * CELL;
        const p = wp((c0 + c1 + 1) / 2, (r0 + r1 + 1) / 2);
        const br = models.kit('bridge');
        br.position.set(p.x, 0, p.z);
        br.rotation.y = along === 'x' ? Math.PI / 2 : 0;
        br.scale.set(wid / (2 * CELL), 1, len / (2 * CELL));
        glowMats(br);
        group.add(br);
      }

    // Portals.
    const pl: P3[] = [];
    const portalGlow: { m: THREE.MeshStandardMaterial; base: number }[] = [];
    def.entries.forEach((e, i) => {
      const route = def.routes.find((rt) => rt.entry === i);
      const mouth = route ? route.pts[0] : [e.x + Math.sin(e.facing), e.y + Math.cos(e.facing)];
      let dx = mouth[0] - e.x;
      let dy = mouth[1] - e.y;
      if (Math.hypot(dx, dy) < 1e-3) {
        dx = Math.sin(e.facing);
        dy = Math.cos(e.facing);
      }
      const c = wp(e.x, e.y);
      const m = wp(mouth[0], mouth[1]);
      const yaw = Math.atan2(-dx, -dy);
      const portal = models.kit('portal');
      const pb = new THREE.Box3().setFromObject(portal);
      portal.position.set(c.x, 0, c.z);
      portal.rotation.y = yaw;
      portalGlow.push(...glowMats(portal, 1.6));
      group.add(portal);
      // A swirling glow card a little way inside the tunnel mouth.
      if (!pb.isEmpty()) {
        const sz = pb.getSize(new THREE.Vector3());
        const card = new THREE.Mesh(swirlGeo, swirlMat);
        card.scale.set(sz.x * 0.46, sz.y * 0.62, 1);
        card.position.set((pb.min.x + pb.max.x) / 2, sz.y * 0.33, pb.min.z + sz.z * 0.3);
        card.rotation.y = Math.PI;
        card.renderOrder = 3;
        portal.add(card);
      }
      pl.push({ x: m.x, y: 0, z: m.z });
      pools.push({ b, x: m.x, y: 0.035, z: m.z, r: 4, color: AMBER.clone().multiplyScalar(0.5) });
    });
    portals.push(pl);

    // Greenhouse, door towards where the routes end.
    const gc = wp(def.goal.x, def.goal.y);
    const end = def.routes[0]?.pts[def.routes[0].pts.length - 1] ?? [def.goal.x, def.goal.y + 2];
    const gyaw = Math.atan2(-(end[0] - def.goal.x), -(end[1] - def.goal.y));
    const green = models.kit('greenhouse');
    green.position.set(gc.x, 0, gc.z);
    green.rotation.y = gyaw;
    const greenGlow = glowMats(green, 2.4);
    group.add(green);
    goals.push({ x: gc.x, y: 0, z: gc.z });
    pools.push({ b, x: gc.x, y: 0.04, z: gc.z, r: 9, color: AMBER.clone().multiplyScalar(0.5) });
    const light = new THREE.PointLight(0xffb357, 0, 16, 1.6);
    light.position.set(gc.x, 2.2, gc.z);
    group.add(light);

    // Direction chevrons along the routes.
    let chevrons: THREE.InstancedMesh | null = null;
    if (chevLocal.length) {
      const geo = chevGeo.clone();
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(Float32Array.from(chevLocal, (cv) => cv.phase), 1));
      const im = new THREE.InstancedMesh(geo, chevronMaterial(time, wilt), chevLocal.length);
      chevLocal.forEach((cv, i) => {
        tmpQ.setFromAxisAngle(yAxis, cv.yaw);
        tmpM.compose(tmpP.set(o.x + cv.x, 0.03, o.z + cv.z), tmpQ, tmpS.setScalar(1));
        im.setMatrixAt(i, tmpM);
      });
      chevrons = im;
      chevrons.renderOrder = 2;
      chevrons.computeBoundingSphere();
      group.add(chevrons);
    }
    // Numbered entry plaques floating beside each portal mouth.
    const plaques: THREE.Sprite[] = [];
    def.entries.forEach((e, i) => {
      const tex = plaqueTex[i];
      if (!tex) return;
      const route = def.routes.find((rt) => rt.entry === i);
      const mouth = route ? route.pts[0] : [e.x + Math.sin(e.facing), e.y + Math.cos(e.facing)];
      const c = wp(e.x, e.y);
      const m = wp(mouth[0], mouth[1]);
      // Between the portal and the mouth, lifted above the arch.
      const sp = new THREE.Sprite(plaqueMats[i]);
      sp.position.set(c.x * 0.2 + m.x * 0.8, 3.3, c.z * 0.2 + m.z * 0.8);
      sp.scale.setScalar(2.4);
      sp.renderOrder = 4;
      sp.userData.baseY = sp.position.y;
      sp.userData.ph = i * 1.7;
      group.add(sp);
      plaques.push(sp);
    });

    boards.push({ o, ground, water, groundU, waterU, wilt, pools: null, meshes: [], green, greenGlow, portalGlow, light, chevrons, plaques, health: 1, out: false });
  });

  // ---- build instanced meshes (rebuilt on quality change) ----
  const WHITE = new THREE.Color(1, 1, 1);
  const WILT = new THREE.Color(0.62, 0.55, 0.45);

  const buildInstances = (q: Quality) => {
    const dens = DENSITY[q] * crowd;
    for (const bd of boards) {
      for (const m of bd.meshes) {
        group.remove(m);
        m.dispose();
      }
      bd.meshes = [];
      if (bd.pools) {
        group.remove(bd.pools);
        bd.pools.material instanceof THREE.Material && bd.pools.material.dispose();
        bd.pools.dispose();
        bd.pools = null;
      }
    }
    const byBoard = new Map<number, Map<string, Inst[]>>();
    for (const it of [...fixed, ...scatter]) {
      if (it.keep && it.keep > dens) continue;
      let m = byBoard.get(it.b);
      if (!m) byBoard.set(it.b, (m = new Map()));
      const key = `${it.name}|${it.cast ? 1 : 0}`;
      const l = m.get(key) ?? [];
      l.push(it);
      m.set(key, l);
    }
    boards.forEach((bd, b) => {
      const byName = byBoard.get(b);
      if (byName)
        for (const list of byName.values()) {
          const name = list[0].name;
          const sway = SWAY[name] ?? 0;
          for (const part of partsFor(name)) {
            const im = new THREE.InstancedMesh(part.geometry, matFor(part.material, sway), list.length);
            list.forEach((it, i) => {
              tmpQ.setFromAxisAngle(yAxis, it.ry);
              if (it.sv) tmpS.set(it.s * it.sv[0], it.s * it.sv[1], it.s * it.sv[2]);
              else tmpS.setScalar(it.s);
              tmpM.compose(tmpP.set(it.x, it.y, it.z), tmpQ, tmpS).multiply(part.matrix);
              im.setMatrixAt(i, tmpM);
              im.setColorAt(i, bd.out ? WILT : WHITE);
            });
            im.castShadow = q !== 'low' && list[0].cast;
            im.name = `kit_${name}`;
            im.receiveShadow = q !== 'low';
            im.computeBoundingSphere();
            group.add(im);
            bd.meshes.push(im);
          }
        }
      const bp = pools.filter((p) => p.b === b);
      if (bp.length) {
        const im = new THREE.InstancedMesh(poolGeo, poolMaterial(time, bd.wilt), bp.length);
        bp.forEach((p, i) => {
          tmpM.compose(tmpP.set(p.x, p.y, p.z), tmpQ.identity(), tmpS.set(p.r, 1, p.r));
          im.setMatrixAt(i, tmpM);
          im.setColorAt(i, p.color);
        });
        im.renderOrder = 2;
        im.computeBoundingSphere();
        group.add(im);
        bd.pools = im;
      }
    });
  };

  let q = quality;
  const applyQuality = () => {
    sun.castShadow = q !== 'low';
    sun.shadow.mapSize.setScalar(q === 'high' ? 2048 : 1536);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    for (const bd of boards) {
      bd.light.visible = q === 'high' && !bd.out;
      bd.green.traverse((o) => (o.castShadow = q !== 'low'));
    }
    buildInstances(q);
  };
  applyQuality();

  const setGlow = (bd: Board, t: number) => {
    const hp = bd.out ? 0 : bd.health;
    const flick = hp < 0.35 && !bd.out ? 0.75 + 0.25 * Math.sin(t * 17) * Math.sin(t * 5.3) : 1;
    const k = bd.out ? 0.05 : (0.35 + 0.65 * hp) * flick * (0.94 + 0.06 * Math.sin(t * 1.4));
    for (const g of bd.greenGlow) g.m.emissiveIntensity = g.base * k;
    bd.light.intensity = 22 * k;
    const pw = 0.5 + 0.5 * Math.sin(t * 2.0);
    const pk = bd.out ? 0.05 : 0.9 + 0.6 * pw * pw;
    for (const g of bd.portalGlow) g.m.emissiveIntensity = g.base * pk;
  };

  const view: WorldView = {
    group,
    sun,
    bounds,
    goals,
    portals,
    setHealth(b, frac) {
      const bd = boards[b];
      if (bd) bd.health = Math.max(0, Math.min(1, frac));
    },
    setOut(b) {
      const bd = boards[b];
      if (!bd || bd.out) return;
      bd.out = true;
      bd.wilt.value = 1;
      bd.light.visible = false;
      for (const m of bd.meshes) {
        for (let i = 0; i < m.count; i++) m.setColorAt(i, WILT);
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    },
    update(_dt, t) {
      time.value = t;
      for (const bd of boards) {
        setGlow(bd, t);
        for (const sp of bd.plaques) {
          sp.visible = !bd.out;
          sp.position.y = sp.userData.baseY + Math.sin(t * 1.6 + sp.userData.ph) * 0.12;
        }
      }
    },
    setQuality(nq) {
      if (nq === q) return;
      q = nq;
      applyQuality();
    },
    dispose() {
      scene.remove(group);
      if (scene.userData.gardenFocus === focusShadows) delete scene.userData.gardenFocus;
      scene.background = prevBg;
      scene.fog = prevFog;
      for (const bd of boards) {
        for (const m of bd.meshes) m.dispose();
        bd.pools?.dispose();
        (bd.ground.material as THREE.Material).dispose();
        (bd.water.material as THREE.Material).dispose();
        bd.water.geometry.dispose();
        for (const g of [...bd.greenGlow, ...bd.portalGlow]) g.m.dispose();
      }
      for (const m of [...swayMats.values(), ...hotMats.values()]) m.dispose();
      for (const d of fallbackOwned) d.dispose();
      for (const bd of boards) {
        if (bd.chevrons) {
          bd.chevrons.geometry.dispose();
          (bd.chevrons.material as THREE.Material).dispose();
          bd.chevrons.dispose();
        }
      }
      chevGeo.dispose();
      for (const t of plaqueTex) t?.dispose();
      for (const m of plaqueMats) m?.dispose();
      groundGeo.dispose();
      poolGeo.dispose();
      swirlGeo.dispose();
      swirlMat.dispose();
      canopy.geometry.dispose();
      (canopy.material as THREE.Material).dispose();
      mask.tex.dispose();
      sun.shadow.map?.dispose();
    },
  };
  return view;
};
