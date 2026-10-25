// Last Light effects: everything that flies, drips, sparks and sticks. All pooled in InstancedMeshes that are
// allocated once; updates write straight into typed arrays, so a firefight allocates nothing per frame.
//
// - Fragments: irregular chunks of brick, concrete, plaster, splintered wood, bent metal, gore, dirt and whole
//   boards, with gravity, spin, bounces on the floor and on standing chunks, friction, settling, and a slow fade.
//   Settled pieces stop costing anything until a chunk breaks (they may have lost their support) or they fade.
// - Grit, sparks and blood droplets: small, short-lived particles; droplets that land leave splats.
// - Decals: bullet holes per material, blood and scorch marks from one atlas (colour, normal and roughness),
//   in a ring buffer; holes on a chunk go when the chunk breaks.
// - Smoke and fire billboards for when the volumetric fog is reduced, plus pipeline.puff() dust that the fog lights.
// - Tracers, muzzle flashes and the short-lived lights the fog pass reads through flashes().

import * as THREE from 'three';
import type { Vec3 } from '@shared/math';
import type { ImpactMat } from '@shared/zombies/protocol';
import type { WeaponKind } from '@shared/zombies/weapons';
import { firstBlock, raycast, type World } from '@shared/zombies/world';
import { type CreateFx, type Fx, type FrameParams, type Pipeline, VIEWMODEL_LAYER } from './api';

const GRAVITY = 14;

// ---- small helpers --------------------------------------------------------------------------------------------------

/** Deterministic-enough cheap random in [a, b). */
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);

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
function fbm(x: number, y: number, oct = 4) {
  let s = 0;
  let a = 0.5;
  for (let i = 0; i < oct; i++) {
    s += vnoise(x, y) * a;
    x *= 2.03;
    y *= 2.03;
    a *= 0.5;
  }
  return s;
}

/** Adds a per-instance alpha (`aAlpha`) and optionally a per-instance atlas rect (`aUv`) to a material. */
function instanced(mat: THREE.Material, opts: { alpha?: boolean; atlas?: boolean }) {
  mat.onBeforeCompile = (sh) => {
    let vert = sh.vertexShader;
    let frag = sh.fragmentShader;
    if (opts.alpha) {
      vert = vert.replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;');
      vert = vert.replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
      frag = frag.replace('#include <common>', '#include <common>\nvarying float vAlpha;');
      frag = frag.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;');
    }
    if (opts.atlas) {
      vert = vert.replace('#include <common>', '#include <common>\nattribute vec4 aUv;');
      vert = vert.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
#ifdef USE_MAP
vMapUv = uv * aUv.zw + aUv.xy;
#endif
#ifdef USE_NORMALMAP
vNormalMapUv = uv * aUv.zw + aUv.xy;
#endif
#ifdef USE_ROUGHNESSMAP
vRoughnessMapUv = uv * aUv.zw + aUv.xy;
#endif`,
      );
    }
    sh.vertexShader = vert;
    sh.fragmentShader = frag;
  };
  mat.customProgramCacheKey = () => `zfx-${opts.alpha ? 1 : 0}${opts.atlas ? 1 : 0}`;
  return mat;
}

/**
 * Procedural surface for debris, in the piece's own metres (geometry position times the instance scale), so a
 * fragment reads as a piece of the material it came from: mortar crust on brick, aggregate in concrete, grain in wood,
 * paint and grime on plaster, rust on steel. Instance colour still tints the result.
 */
const SURFACE_KIND = { brick: 0, plaster: 1, concrete: 2, wood: 3, metal: 4, flesh: 5, dirt: 6 } as const;

function surfaced(mat: THREE.MeshStandardMaterial, kind: number) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurf;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 sSc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
vSurf = position * sSc + vec3(instanceMatrix[3].x * 3.1, instanceMatrix[3].y * 1.7, instanceMatrix[3].z * 2.3);
#else
vSurf = position;
#endif`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vSurf;
float sHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float sNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sHash(i), sHash(i + vec3(1, 0, 0)), f.x), mix(sHash(i + vec3(0, 1, 0)), sHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(sHash(i + vec3(0, 0, 1)), sHash(i + vec3(1, 0, 1)), f.x), mix(sHash(i + vec3(0, 1, 1)), sHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 q = vSurf;
  float n1 = sNoise(q * 38.0);
  float n2 = sNoise(q * 9.0);
  float sRough = 0.0;
#if ZFX_KIND == 0
  // Brick: fired clay speckle, burnt patches, crusts of grey mortar stuck on.
  float crust = smoothstep(0.7, 0.8, sNoise(q * 8.0 + 4.0)) * 0.85;
  diffuseColor.rgb *= 0.82 + n1 * 0.32;
  diffuseColor.rgb *= mix(1.0, 0.7, smoothstep(0.6, 0.85, n2));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.4, 0.37), crust);
#elif ZFX_KIND == 1
  // Plaster: chalky white core, a dirty painted skin in patches.
  float skin = smoothstep(0.45, 0.6, n2);
  diffuseColor.rgb *= 0.9 + n1 * 0.16;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.7, 0.62), skin);
#elif ZFX_KIND == 2
  // Concrete: grey paste with dark and light aggregate.
  float agg = sNoise(q * 70.0);
  diffuseColor.rgb *= 0.86 + n2 * 0.18;
  diffuseColor.rgb *= agg > 0.78 ? 0.55 : agg < 0.12 ? 1.35 : 1.0;
#elif ZFX_KIND == 3
  // Wood: grain along the piece's length (z), raw light fibres where it split.
  float grain = sin(q.x * 260.0 + q.y * 90.0 + sNoise(q * vec3(6.0, 6.0, 1.5)) * 9.0) * 0.5 + 0.5;
  diffuseColor.rgb *= 0.78 + grain * 0.3;
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.45, 1.35, 1.2), smoothstep(0.7, 0.9, n1) * 0.5);
#elif ZFX_KIND == 4
  // Steel: grey paint flaking to orange rust.
  float rust = smoothstep(0.5, 0.75, n2 * 0.7 + n1 * 0.4);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.17, 0.07), rust);
  sRough = rust * 0.5;
#elif ZFX_KIND == 5
  // Flesh: wet dark red with paler fat and tissue.
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.9, 1.5, 1.4), smoothstep(0.65, 0.85, n1));
  diffuseColor.rgb *= 0.75 + n2 * 0.4;
#else
  diffuseColor.rgb *= 0.7 + n1 * 0.45;
#endif
  vSurfRough = sRough;
}`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + vSurfRough, 0.0, 1.0);')
      .replace('varying vec3 vSurf;', `#define ZFX_KIND ${kind}\nvarying vec3 vSurf;\nfloat vSurfRough = 0.0;`);
  };
  mat.customProgramCacheKey = () => `zfx-surf-${kind}`;
  return mat;
}

function canvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

function tex(c: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ---- textures -------------------------------------------------------------------------------------------------------

/** Soft, lumpy smoke blob (white; tinted per instance). */
function smokeTexture() {
  const S = 128;
  const { c, g } = canvas(S);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5;
      const dy = (y + 0.5) / S - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const n = fbm(x / 22, y / 22, 5);
      const a = Math.max(0, 1 - r * (1.1 + (0.5 - n) * 0.9));
      const i = (y * S + x) * 4;
      const l = 200 + n * 55;
      img.data[i] = l;
      img.data[i + 1] = l;
      img.data[i + 2] = l;
      img.data[i + 3] = Math.min(255, a * a * (0.6 + n * 0.8) * 255);
    }
  g.putImageData(img, 0, 0);
  return tex(c);
}

function fireTexture() {
  const S = 128;
  const { c, g } = canvas(S);
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5;
      const dy = (y + 0.5) / S - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const n = fbm(x / 14 + 3, y / 14, 4);
      const k = Math.max(0, 1 - r * (1 + (0.5 - n) * 1.2));
      const i = (y * S + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = Math.min(255, 90 + k * 200);
      img.data[i + 2] = Math.min(255, 20 + k * k * 200);
      img.data[i + 3] = Math.min(255, k * 255);
    }
  g.putImageData(img, 0, 0);
  return tex(c);
}

/** Muzzle flash star: a hot core and a few uneven rays. */
function starTexture() {
  const S = 128;
  const { c, g } = canvas(S);
  g.translate(S / 2, S / 2);
  const core = g.createRadialGradient(0, 0, 0, 0, 0, S * 0.32);
  core.addColorStop(0, 'rgba(255,255,240,1)');
  core.addColorStop(0.25, 'rgba(255,215,140,0.95)');
  core.addColorStop(0.6, 'rgba(255,140,40,0.35)');
  core.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = core;
  g.fillRect(-S / 2, -S / 2, S, S);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + hash(i, 3) * 0.5;
    const len = S * (0.28 + hash(i, 9) * 0.2);
    const w = 3 + hash(i, 5) * 5;
    g.save();
    g.rotate(a);
    const grd = g.createLinearGradient(0, 0, len, 0);
    grd.addColorStop(0, 'rgba(255,230,170,0.9)');
    grd.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(0, -w);
    g.lineTo(len, 0);
    g.lineTo(0, w);
    g.fill();
    g.restore();
  }
  return tex(c);
}

/** A tongue of flame along +x, hot at the base (left edge, v centre), ragged and tapering towards the tip. */
function flameTexture() {
  const W = 128;
  const H = 64;
  const { c, g } = canvas(W, H);
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const v = ((y + 0.5) / H - 0.5) * 2;
      const width = 0.95 * Math.pow(1 - u, 0.7) * (0.75 + fbm(u * 6, y / 10, 3) * 0.5);
      const k = Math.max(0, 1 - Math.abs(v) / Math.max(0.02, width)) * Math.pow(1 - u, 0.6);
      const i = (y * W + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = Math.min(255, 110 + k * 160);
      img.data[i + 2] = Math.min(255, 30 + k * k * 190);
      img.data[i + 3] = Math.min(255, k * 270);
    }
  g.putImageData(img, 0, 0);
  return tex(c);
}

/**
 * Decal atlas, 4 x 2 cells: 0-1 masonry holes, 2 wood hole, 3 metal dent, 4-5 blood splats, 6 scorch, 7 blood smear.
 * Masonry, wood and metal are drawn in neutral tones and tinted per instance; blood and scorch carry their colour.
 */
const ATLAS_COLS = 4;
const ATLAS_ROWS = 2;
const CELL = 256;
const D = { hole: 0, hole2: 1, wood: 2, metal: 3, blood: 4, blood2: 5, scorch: 6, smear: 7 } as const;

function decalAtlas() {
  const W = CELL * ATLAS_COLS;
  const H = CELL * ATLAS_ROWS;
  const col = new Uint8ClampedArray(W * H * 4);
  const height = new Float32Array(W * H);
  const rough = new Uint8ClampedArray(W * H * 4);
  const put = (cell: number, fn: (u: number, v: number, x: number, y: number) => [number, number, number, number, number, number]) => {
    const cx = (cell % ATLAS_COLS) * CELL;
    const cy = Math.floor(cell / ATLAS_COLS) * CELL;
    for (let y = 0; y < CELL; y++)
      for (let x = 0; x < CELL; x++) {
        const u = (x + 0.5) / CELL - 0.5;
        const v = (y + 0.5) / CELL - 0.5;
        const [r, g, b, a, h, ro] = fn(u, v, x + cell * 97, y);
        const i = (cy + y) * W + cx + x;
        col[i * 4] = r;
        col[i * 4 + 1] = g;
        col[i * 4 + 2] = b;
        col[i * 4 + 3] = a;
        height[i] = h;
        rough[i * 4] = ro;
        rough[i * 4 + 1] = ro;
        rough[i * 4 + 2] = ro;
        rough[i * 4 + 3] = 255;
      }
  };
  // Masonry: a dark bore, a jagged chipped crater, a ring of pale dust.
  const masonry = (seed: number) => (u: number, v: number, x: number, y: number): [number, number, number, number, number, number] => {
    const r = Math.hypot(u, v) * 2;
    const ang = Math.atan2(v, u);
    const jag = 0.75 + vnoise(ang * 2.5 + seed, seed) * 0.5 + fbm(x / 9, y / 9, 3) * 0.25;
    const bore = 0.12 * jag;
    const crater = 0.42 * jag;
    const dust = 0.95;
    const n = fbm(x / 6 + seed, y / 6, 4);
    if (r < bore) return [12, 10, 9, 255, -1, 230];
    if (r < crater) {
      const k = (r - bore) / (crater - bore);
      const l = 60 + k * 85 + n * 45;
      return [l, l * 0.96, l * 0.92, 255, -0.75 + k * 0.85 + (n - 0.5) * 0.3, 245];
    }
    if (r < dust) {
      const k = (r - crater) / (dust - crater);
      const a = (1 - k) * (1 - k) * 105 * (0.5 + n * 0.6);
      const l = 160 + n * 45;
      return [l, l * 0.97, l * 0.93, a, (1 - k) * 0.08, 250];
    }
    return [0, 0, 0, 0, 0, 255];
  };
  put(D.hole, masonry(1.3));
  put(D.hole2, masonry(7.9));
  // Wood: small bore, splinters torn along the grain (vertical), raw light wood inside.
  put(D.wood, (u, v, x, y) => {
    const r = Math.hypot(u * 1.6, v * 0.75) * 2;
    const grain = fbm(x / 40, y / 3, 3);
    const splinter = Math.abs(u) < 0.06 + grain * 0.12 && Math.abs(v) < 0.42 * (0.4 + grain);
    if (r < 0.14) return [14, 9, 6, 255, -1, 220];
    if (r < 0.38 || splinter) {
      const l = 150 + grain * 80;
      return [l, l * 0.8, l * 0.58, 255, -0.3 + grain * 0.6, 235];
    }
    if (r < 0.6) {
      const a = (1 - (r - 0.38) / 0.22) * 120;
      return [70, 50, 32, a, 0, 240];
    }
    return [0, 0, 0, 0, 0, 255];
  });
  // Metal: a bright, smooth dent with a dark pin hole and a scuffed ring.
  put(D.metal, (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    const n = fbm(x / 5, y / 5, 3);
    if (r < 0.08) return [20, 20, 22, 255, -0.6, 120];
    if (r < 0.42) {
      const k = r / 0.42;
      const l = 235 - k * 60 + n * 20;
      return [l, l, l * 1.02, 255, -(1 - k) * (1 - k), 50 + k * 60];
    }
    if (r < 0.62) {
      const a = (1 - (r - 0.42) / 0.2) * 160 * n;
      return [200, 200, 205, a, 0, 90];
    }
    return [0, 0, 0, 0, 0, 255];
  });
  // Blood: a thick pool with tendrils, satellite drops, wet and glossy.
  const blood = (seed: number) => (u: number, v: number, x: number, y: number): [number, number, number, number, number, number] => {
    const r = Math.hypot(u, v) * 2;
    const ang = Math.atan2(v, u);
    const edge = 0.45 + fbm(Math.cos(ang) * 2 + seed, Math.sin(ang) * 2 + seed, 4) * 0.45 + Math.pow(Math.max(0, Math.sin(ang * 5 + seed * 3)), 16) * 0.14 * (0.5 + vnoise(ang * 3, seed));
    let a = r < edge ? 1 : 0;
    // Satellite drops.
    if (!a) {
      const gx = Math.floor((u + 0.5) * 14);
      const gy = Math.floor((v + 0.5) * 14);
      const h = hash(gx + seed * 13, gy);
      if (h > 0.86 && r < 0.98) {
        const cx = (gx + 0.5) / 14 - 0.5;
        const cy = (gy + 0.5) / 14 - 0.5;
        if (Math.hypot(u - cx, v - cy) < 0.012 + (h - 0.86) * 0.25) a = 1;
      }
    }
    if (!a) return [0, 0, 0, 0, 0, 255];
    const n = fbm(x / 12, y / 12, 3);
    const depth = Math.min(1, (edge - r) * 4);
    const rr = 70 + n * 30 - depth * 25;
    return [rr, 4 + n * 4, 4, 235, 0.15 + depth * 0.2, 35 + n * 40];
  };
  put(D.blood, blood(2.1));
  put(D.blood2, blood(5.7));
  put(D.scorch, (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    const n = fbm(x / 18, y / 18, 5);
    const k = Math.max(0, 1 - r * (0.9 + (0.5 - n) * 0.8));
    const a = Math.min(1, k * 1.6) * 235;
    const l = 8 + (1 - k) * 25 + n * 10;
    return [l, l * 0.95, l * 0.9, a, -k * 0.15, 250];
  });
  put(D.smear, (u, v, x, y) => {
    const w = 0.18 * (1 - Math.abs(v) * 1.6) + fbm(x / 30, y / 8, 3) * 0.06;
    const drip = Math.abs(u - 0.05 * Math.sin(v * 9)) < w && Math.abs(v) < 0.46;
    if (!drip) return [0, 0, 0, 0, 0, 255];
    const n = fbm(x / 10, y / 10, 3);
    return [60 + n * 30, 3, 3, 220, 0.2, 40];
  });

  const cc = canvas(W, H);
  cc.g.putImageData(new ImageData(col, W, H), 0, 0);
  // Normal map from the height field (Sobel), tangent space.
  const nrm = new Uint8ClampedArray(W * H * 4);
  const hAt = (x: number, y: number) => height[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * 3;
      const dy = (hAt(x, y + 1) - hAt(x, y - 1)) * 3;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * W + x) * 4;
      nrm[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      nrm[i + 1] = ((dy / l) * 0.5 + 0.5) * 255;
      nrm[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
    }
  const nc = canvas(W, H);
  nc.g.putImageData(new ImageData(nrm, W, H), 0, 0);
  const rc = canvas(W, H);
  rc.g.putImageData(new ImageData(rough, W, H), 0, 0);
  return { color: tex(cc.c), normal: tex(nc.c, false), rough: tex(rc.c, false) };
}

// ---- geometry -------------------------------------------------------------------------------------------------------

/** A unit-sized irregular rock: an icosahedron with every vertex pushed in or out. */
function rockGeometry(seed: number, detail = 0, squash = 1) {
  const g = new THREE.IcosahedronGeometry(0.5, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 0.7 + hash(Math.round(x * 97) + seed, Math.round(y * 89) + Math.round(z * 83)) * 0.55;
    p.setXYZ(i, x * k, y * k * squash, z * k);
  }
  return flat(g);
}

/** A chipped brick: a box with jittered corners and one broken end. */
function brickGeometry(seed: number) {
  const g = new THREE.BoxGeometry(1, 0.32, 0.48, 2, 1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const h = hash(Math.round(x * 50) + seed, Math.round(y * 40) * 3 + Math.round(z * 30));
    const broken = x > 0.3 ? 0.25 * h : 0.04 * h;
    p.setXYZ(i, x - (x > 0 ? broken : 0), y * (1 - 0.12 * h), z * (1 - 0.1 * hash(i, seed)));
  }
  return flat(g);
}

/** A flat, sharp shard (plaster, metal plate, tile). */
function shardGeometry(seed: number, thick = 0.12) {
  const pts: number[] = [];
  const n = 5 + Math.floor(hash(seed, 1) * 3);
  const ring: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + hash(seed, i) * 0.6;
    const r = 0.3 + hash(i, seed) * 0.25;
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const t = thick / 2;
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % n];
    pts.push(0, t, 0, bx, t * 0.6, bz, ax, t * 0.6, az);
    pts.push(0, -t, 0, ax, -t * 0.6, az, bx, -t * 0.6, bz);
    pts.push(ax, t * 0.6, az, bx, t * 0.6, bz, bx, -t * 0.6, bz);
    pts.push(ax, t * 0.6, az, bx, -t * 0.6, bz, ax, -t * 0.6, az);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.computeVertexNormals();
  return g;
}

/** A long splinter of wood with a ragged, tapered end. */
function splinterGeometry(seed: number) {
  const g = new THREE.BoxGeometry(0.16, 0.12, 1, 1, 1, 4);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const taper = 1 - Math.max(0, z) * 1.6 * (0.5 + hash(seed, Math.round(x * 20)));
    p.setXYZ(i, x * Math.max(0.05, taper), y * Math.max(0.1, taper), z + (z > 0.4 ? hash(i, seed) * 0.15 : 0));
  }
  return flat(g);
}

function flat(g: THREE.BufferGeometry) {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.computeVertexNormals();
  return ng;
}

// ---- pools ----------------------------------------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _box = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };

/**
 * Rough height of the debris lying on the floor, on a 0.25 m grid over the map: settled pieces add to it, so new
 * pieces land on top of a pile instead of sinking into it. Loose by design; it is only ever a few centimetres off.
 */
class Piles {
  private readonly h: Float32Array;
  private readonly nx: number;
  private readonly nz: number;
  private readonly x0: number;
  private readonly z0: number;
  static readonly CELL = 0.25;

  constructor(world: World) {
    const b = world.bounds;
    this.x0 = b.minX - 1;
    this.z0 = b.minZ - 1;
    this.nx = Math.ceil((b.maxX - b.minX + 2) / Piles.CELL);
    this.nz = Math.ceil((b.maxZ - b.minZ + 2) / Piles.CELL);
    this.h = new Float32Array(this.nx * this.nz);
  }

  private cell(x: number, z: number) {
    const i = Math.floor((x - this.x0) / Piles.CELL);
    const k = Math.floor((z - this.z0) / Piles.CELL);
    return i < 0 || k < 0 || i >= this.nx || k >= this.nz ? -1 : i * this.nz + k;
  }

  get(x: number, z: number) {
    const c = this.cell(x, z);
    return c < 0 ? 0 : this.h[c];
  }

  add(x: number, z: number, dh: number) {
    const c = this.cell(x, z);
    if (c >= 0) this.h[c] = Math.max(0, Math.min(0.7, this.h[c] + dh));
  }

  clear() {
    this.h.fill(0);
  }
}

/** Called when a flying piece lands hard; return true to remove it (it shattered). */
type Impact = (i: number, x: number, y: number, z: number, speed: number, size: number) => boolean;

/** Rigid pieces with spin, bounces, settling and a fade. */
class FragmentPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly n: number;
  private next = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly size: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  /** Seconds before a spawned piece starts to move (staggered collapses). */
  private readonly delay: Float32Array;
  /** Height this piece added to the pile while settled. */
  private readonly piled: Float32Array;
  /** 0 free, 1 flying, 2 settled, 3 waiting to fall. */
  private readonly state: Uint8Array;
  private dirty = false;
  private active = 0;
  onImpact?: Impact;
  /** Settled pieces snap to a face; casings instead lie on their side (axis horizontal). */
  snapRest = true;

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    n: number,
    private readonly world: World,
    private readonly piles: Piles,
    private readonly bounce = 0.28,
    /** Share of the slide kept on a hard bounce (casings roll, rubble does not). */
    private readonly slide = 0.62,
    /** Slide decay per second while resting on the ground. */
    private readonly rollFriction = 9,
  ) {
    this.n = n;
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.setColorAt(0, _c.set(1, 1, 1));
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.rot = new Float32Array(n * 3);
    this.spin = new Float32Array(n * 3);
    this.size = new Float32Array(n * 3);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.delay = new Float32Array(n);
    this.piled = new Float32Array(n);
    this.state = new Uint8Array(n);
  }

  spawn(
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
    sx: number,
    sy: number,
    sz: number,
    tint: THREE.Color,
    life: number,
    delay = 0,
    spinMax = -1,
    upright = false,
  ) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    if (this.state[i] === 2) this.unpile(i);
    if (!this.state[i]) this.active++;
    const i3 = i * 3;
    this.pos[i3] = px;
    this.pos[i3 + 1] = py;
    this.pos[i3 + 2] = pz;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.rot[i3] = upright ? rand(-0.04, 0.04) : rand(0, 6.28);
    this.rot[i3 + 1] = upright ? rand(-0.04, 0.04) : rand(0, 6.28);
    this.rot[i3 + 2] = upright ? rand(-0.04, 0.04) : rand(0, 6.28);
    const spin = spinMax >= 0 ? spinMax : 4 + Math.hypot(vx, vy, vz) * 1.5;
    this.spin[i3] = rand(-spin, spin);
    this.spin[i3 + 1] = rand(-spin, spin);
    this.spin[i3 + 2] = rand(-spin, spin);
    this.size[i3] = sx;
    this.size[i3 + 1] = sy;
    this.size[i3 + 2] = sz;
    this.age[i] = 0;
    this.life[i] = life;
    this.delay[i] = delay;
    this.piled[i] = 0;
    this.state[i] = delay > 0 ? 3 : 1;
    this.mesh.setColorAt(i, tint);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    // Waiting pieces are drawn where they spawned (the slab still hangs in the wall for a moment).
    if (delay > 0) {
      this.write(i, 1);
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    return i;
  }

  private unpile(i: number) {
    if (this.piled[i] > 0) {
      this.piles.add(this.pos[i * 3], this.pos[i * 3 + 2], -this.piled[i]);
      this.piled[i] = 0;
    }
  }

  /** Something below may have gone: let settled pieces fall again. */
  wake() {
    for (let i = 0; i < this.n; i++)
      if (this.state[i] === 2) {
        this.unpile(i);
        this.state[i] = 1;
      }
  }

  clear() {
    this.state.fill(0);
    this.piled.fill(0);
    this.active = 0;
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private kill(i: number) {
    if (this.state[i] === 2) this.unpile(i);
    this.state[i] = 0;
    this.active--;
    this.mesh.setMatrixAt(i, ZERO);
    this.dirty = true;
  }

  private write(i: number, k: number) {
    const i3 = i * 3;
    _p.set(this.pos[i3], this.pos[i3 + 1], this.pos[i3 + 2]);
    _q.setFromEuler(_e.set(this.rot[i3], this.rot[i3 + 1], this.rot[i3 + 2]));
    _s.set(this.size[i3] * k, this.size[i3 + 1] * k, this.size[i3 + 2] * k);
    this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    this.dirty = true;
  }

  update(dt: number) {
    if (!this.active) return;
    const { pos, vel, rot, spin, size, age, life, state, piles } = this;
    for (let i = 0; i < this.n; i++) {
      const st = state[i];
      if (!st) continue;
      if (st === 3) {
        this.delay[i] -= dt;
        if (this.delay[i] <= 0) state[i] = 1;
        continue;
      }
      age[i] += dt;
      const left = life[i] - age[i];
      if (left <= 0) {
        this.kill(i);
        continue;
      }
      const i3 = i * 3;
      const fading = left < 1.5;
      if (st === 2 && !fading) continue;
      const r = Math.min(size[i3], size[i3 + 1], size[i3 + 2]) * 0.4;
      if (st === 1) {
        vel[i3 + 1] -= GRAVITY * dt;
        const ox = pos[i3];
        const oy = pos[i3 + 1];
        const oz = pos[i3 + 2];
        pos[i3] += vel[i3] * dt;
        pos[i3 + 1] += vel[i3 + 1] * dt;
        pos[i3 + 2] += vel[i3 + 2] * dt;
        rot[i3] += spin[i3] * dt;
        rot[i3 + 1] += spin[i3 + 1] * dt;
        rot[i3 + 2] += spin[i3 + 2] * dt;
        let landed = false;
        const ground = piles.get(pos[i3], pos[i3 + 2]);
        if (pos[i3 + 1] < ground + r) {
          pos[i3 + 1] = ground + r;
          landed = true;
        } else if (oy > 0.15) {
          // Off the floor: standing chunks and solids catch the piece.
          _box.min.x = pos[i3] - r;
          _box.min.y = pos[i3 + 1] - r;
          _box.min.z = pos[i3 + 2] - r;
          _box.max.x = pos[i3] + r;
          _box.max.y = pos[i3 + 1] + r;
          _box.max.z = pos[i3 + 2] + r;
          const hit = firstBlock(this.world, _box, 'nade');
          if (hit) {
            if (oy - r >= hit.max.y - 0.06 && vel[i3 + 1] <= 0) {
              pos[i3 + 1] = hit.max.y + r;
              landed = true;
            } else {
              // Side hit: back out and rebound horizontally.
              pos[i3] = ox;
              pos[i3 + 2] = oz;
              pos[i3 + 1] = oy;
              vel[i3] *= -0.35;
              vel[i3 + 2] *= -0.35;
              if (oy - r < hit.min.y && vel[i3 + 1] > 0) vel[i3 + 1] *= -0.2;
            }
          }
        }
        if (landed) {
          const vy = -vel[i3 + 1];
          if (vy > 2 && this.onImpact && this.onImpact(i, pos[i3], pos[i3 + 1] - r, pos[i3 + 2], vy, Math.max(size[i3], size[i3 + 1], size[i3 + 2]))) {
            this.kill(i);
            continue;
          }
          vel[i3 + 1] = vy > 1 ? vy * this.bounce * rand(0.6, 1.2) : 0;
          // Friction: a tumble that loses most of its slide on each contact.
          const f = vy > 1 ? this.slide : Math.max(0, 1 - this.rollFriction * dt);
          vel[i3] *= f;
          vel[i3 + 2] *= f;
          const sf = vy > 1 ? 0.6 : Math.max(0, 1 - this.rollFriction * dt);
          spin[i3] *= sf;
          spin[i3 + 1] *= vy > 1 ? 0.7 : sf;
          spin[i3 + 2] *= sf;
          if (vel[i3 + 1] === 0 && Math.hypot(vel[i3], vel[i3 + 2]) < 0.08) {
            // Lie flat-ish: snap the tumble to a resting angle, and add to the pile below.
            if (this.snapRest) {
              rot[i3] = Math.round(rot[i3] / (Math.PI / 2)) * (Math.PI / 2);
              rot[i3 + 2] = Math.round(rot[i3 + 2] / (Math.PI / 2)) * (Math.PI / 2);
            } else rot[i3] = 0;
            state[i] = 2;
            if (r > 0.015) {
              this.piled[i] = r * 1.1;
              piles.add(pos[i3], pos[i3 + 2], this.piled[i]);
            }
          }
        }
      }
      let k = 1;
      if (fading) {
        k = Math.max(0.001, left / 1.5);
        pos[i3 + 1] -= dt * 0.02;
      }
      this.write(i, k);
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.dirty = false;
    }
  }
}

type Landed = (x: number, y: number, z: number, i: number) => void;

/**
 * Small particles without rotation: grit, sparks, blood droplets. Sparks and droplets stretch along their velocity.
 * `onLand` fires once when a particle hits the floor (blood droplets leave a splat).
 */
class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly size: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly live: Uint8Array;
  private readonly alpha?: THREE.InstancedBufferAttribute;
  private dirty = false;

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    private readonly n: number,
    private readonly opts: { stretch: number; drag: number; bounce: number; fade: boolean; gravity: number; onLand?: Landed },
  ) {
    if (opts.fade) {
      this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
      this.alpha.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAlpha', this.alpha);
    }
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.setColorAt(0, _c.set(1, 1, 1));
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.live = new Uint8Array(n);
  }

  spawn(px: number, py: number, pz: number, vx: number, vy: number, vz: number, size: number, life: number, tint: THREE.Color) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    const i3 = i * 3;
    this.pos[i3] = px;
    this.pos[i3 + 1] = py;
    this.pos[i3 + 2] = pz;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.size[i] = size;
    this.age[i] = 0;
    this.life[i] = life;
    this.live[i] = 1;
    this.mesh.setColorAt(i, tint);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    this.live.fill(0);
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    const { pos, vel, size, age, life, live, opts } = this;
    const drag = Math.max(0, 1 - opts.drag * dt);
    for (let i = 0; i < this.n; i++) {
      if (!live[i]) continue;
      age[i] += dt;
      const i3 = i * 3;
      if (age[i] >= life[i]) {
        live[i] = 0;
        this.mesh.setMatrixAt(i, ZERO);
        this.dirty = true;
        continue;
      }
      vel[i3 + 1] -= opts.gravity * dt;
      vel[i3] *= drag;
      vel[i3 + 1] *= drag;
      vel[i3 + 2] *= drag;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      if (pos[i3 + 1] < size[i] * 0.5) {
        pos[i3 + 1] = size[i] * 0.5;
        if (opts.onLand && vel[i3 + 1] < -0.5) {
          opts.onLand(pos[i3], 0, pos[i3 + 2], i);
          live[i] = 0;
          this.mesh.setMatrixAt(i, ZERO);
          this.dirty = true;
          continue;
        }
        vel[i3 + 1] = -vel[i3 + 1] * opts.bounce;
        vel[i3] *= 0.5;
        vel[i3 + 2] *= 0.5;
      }
      const k = 1 - age[i] / life[i];
      const sz = size[i] * (opts.fade ? 1 : Math.min(1, k * 3));
      _p.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
      if (opts.stretch > 0) {
        _v.set(vel[i3], vel[i3 + 1], vel[i3 + 2]);
        const sp = _v.length();
        if (sp > 1e-3) _q.setFromUnitVectors(_z, _v.multiplyScalar(1 / sp));
        _s.set(sz, sz, sz + sp * opts.stretch);
      } else {
        _q.identity();
        _s.set(sz, sz, sz);
      }
      this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      if (this.alpha) this.alpha.array[i] = k * k;
      this.dirty = true;
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.alpha) this.alpha.needsUpdate = true;
      this.dirty = false;
    }
  }
}

/** Camera-facing soft sprites: smoke, dust, fire. */
class SpritePool {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly size: Float32Array;
  private readonly grow: Float32Array;
  private readonly roll: Float32Array;
  private readonly rollV: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly peak: Float32Array;
  private readonly live: Uint8Array;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private active = 0;

  constructor(
    mat: THREE.Material,
    private readonly n: number,
  ) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alpha);
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.setColorAt(0, _c.set(1, 1, 1));
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.grow = new Float32Array(n);
    this.roll = new Float32Array(n);
    this.rollV = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.peak = new Float32Array(n);
    this.live = new Uint8Array(n);
  }

  spawn(px: number, py: number, pz: number, vx: number, vy: number, vz: number, size: number, grow: number, life: number, peak: number, tint: THREE.Color) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    const i3 = i * 3;
    this.pos[i3] = px;
    this.pos[i3 + 1] = py;
    this.pos[i3 + 2] = pz;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.size[i] = size;
    this.grow[i] = grow;
    this.roll[i] = rand(0, 6.28);
    this.rollV[i] = rand(-0.6, 0.6);
    this.age[i] = 0;
    this.life[i] = life;
    this.peak[i] = peak;
    if (!this.live[i]) this.active++;
    this.live[i] = 1;
    this.mesh.setColorAt(i, tint);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    this.live.fill(0);
    this.active = 0;
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number, camQ: THREE.Quaternion) {
    if (!this.active) return;
    const { pos, vel, size, grow, roll, rollV, age, life, peak, live } = this;
    const a = this.alpha.array as Float32Array;
    const drag = Math.max(0, 1 - 1.6 * dt);
    for (let i = 0; i < this.n; i++) {
      if (!live[i]) continue;
      age[i] += dt;
      if (age[i] >= life[i]) {
        live[i] = 0;
        this.active--;
        this.mesh.setMatrixAt(i, ZERO);
        continue;
      }
      const i3 = i * 3;
      vel[i3] *= drag;
      vel[i3 + 1] = vel[i3 + 1] * drag + 0.06 * dt;
      vel[i3 + 2] *= drag;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      size[i] += grow[i] * dt;
      grow[i] *= Math.max(0, 1 - 0.5 * dt);
      roll[i] += rollV[i] * dt;
      const t = age[i] / life[i];
      // Quick fade-in, long fade-out.
      a[i] = peak[i] * Math.min(1, t * 8) * (1 - t) * (1 - t);
      _p.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
      _q.copy(camQ).multiply(_q2.setFromAxisAngle(_z, roll[i]));
      _s.set(size[i], size[i], size[i]);
      this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}

/** Decals from the atlas, in a ring buffer. */
class DecalPool {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private readonly chunk: Int32Array;
  private readonly growing = Array.from({ length: 24 }, () => ({ i: -1, age: 0, dur: 1, from: 0, to: 0, stretch: 1, p: new THREE.Vector3(), q: new THREE.Quaternion() }));
  private readonly uv: THREE.InstancedBufferAttribute;
  private readonly alpha: THREE.InstancedBufferAttribute;

  constructor(
    mat: THREE.Material,
    private readonly n: number,
  ) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.uv = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1);
    geo.setAttribute('aUv', this.uv);
    geo.setAttribute('aAlpha', this.alpha);
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    this.mesh.setColorAt(0, _c.set(1, 1, 1));
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.chunk = new Int32Array(n).fill(-2);
  }

  add(p: Vec3, n: Vec3, size: number, cell: number, tint: THREE.Color, chunk: number, alpha = 1, stretch = 1) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    _v.set(n.x, n.y, n.z).normalize();
    // Float just off the surface; floor decals stacked by age so overlapping splats never fight.
    _p.set(p.x + _v.x * 0.004, p.y + _v.y * (0.004 + (i % 7) * 0.0004), p.z + _v.z * 0.004);
    _q.setFromUnitVectors(_z, _v).multiply(_q2.setFromAxisAngle(_z, rand(0, 6.28)));
    _s.set(size, size * stretch, 1);
    this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    const cx = cell % ATLAS_COLS;
    const cy = Math.floor(cell / ATLAS_COLS);
    // Canvas row 0 is the top of the texture (flipY): v runs bottom-up.
    this.uv.setXYZW(i, cx / ATLAS_COLS, 1 - (cy + 1) / ATLAS_ROWS, 1 / ATLAS_COLS, 1 / ATLAS_ROWS);
    this.alpha.setX(i, alpha);
    this.mesh.setColorAt(i, tint);
    this.chunk[i] = chunk;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.uv.needsUpdate = true;
    this.alpha.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    // A decal reusing a slot that was still growing stops growing.
    for (const g of this.growing) if (g.i === i) g.i = -1;
    return i;
  }

  /** Grows decal `i` from its current size to `to` over `dur` seconds (blood pooling under a body). */
  grow(i: number, to: number, dur: number) {
    const g = this.growing.find((x) => x.i < 0);
    if (!g) return;
    this.mesh.getMatrixAt(i, _m);
    _m.decompose(g.p, g.q, _s);
    g.i = i;
    g.age = 0;
    g.dur = dur;
    g.from = _s.x;
    g.to = to;
    g.stretch = _s.y / Math.max(1e-4, _s.x);
  }

  update(dt: number) {
    let any = false;
    for (const g of this.growing) {
      if (g.i < 0) continue;
      g.age += dt;
      const t = Math.min(1, g.age / g.dur);
      // Fast at first, then creeping out.
      const k = 1 - (1 - t) * (1 - t) * (1 - t);
      const sz = g.from + (g.to - g.from) * k;
      _s.set(sz, sz * g.stretch, 1);
      this.mesh.setMatrixAt(g.i, _m.compose(g.p, g.q, _s));
      any = true;
      if (t >= 1) g.i = -1;
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }

  removeChunk(c: number) {
    let any = false;
    for (let i = 0; i < this.n; i++)
      if (this.chunk[i] === c) {
        this.chunk[i] = -2;
        for (const g of this.growing) if (g.i === i) g.i = -1;
        this.mesh.setMatrixAt(i, ZERO);
        any = true;
      }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Streaks flying from muzzle to impact. */
class TracerPool {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private readonly from: Float32Array;
  private readonly dir: Float32Array;
  private readonly dist: Float32Array;
  private readonly t: Float32Array;
  private readonly len: Float32Array;
  private readonly live: Uint8Array;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private active = 0;
  static readonly SPEED = 320;

  constructor(
    mat: THREE.Material,
    private readonly n: number,
  ) {
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, -0.5);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alpha);
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.from = new Float32Array(n * 3);
    this.dir = new Float32Array(n * 3);
    this.dist = new Float32Array(n);
    this.t = new Float32Array(n);
    this.len = new Float32Array(n);
    this.live = new Uint8Array(n);
  }

  spawn(a: Vec3, b: Vec3, len: number, alpha: number) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1.5) return;
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    const i3 = i * 3;
    this.from[i3] = a.x;
    this.from[i3 + 1] = a.y;
    this.from[i3 + 2] = a.z;
    this.dir[i3] = dx / d;
    this.dir[i3 + 1] = dy / d;
    this.dir[i3 + 2] = dz / d;
    this.dist[i] = d;
    // Start a little way out of the muzzle so the streak is not glued to the barrel.
    this.t[i] = Math.min(d * 0.5, 1.2);
    this.len[i] = len;
    this.alpha.setX(i, alpha);
    if (!this.live[i]) this.active++;
    this.live[i] = 1;
  }

  update(dt: number) {
    if (!this.active) return;
    for (let i = 0; i < this.n; i++) {
      if (!this.live[i]) continue;
      this.t[i] += TracerPool.SPEED * dt;
      const i3 = i * 3;
      const head = Math.min(this.t[i], this.dist[i]);
      const tail = Math.max(0, this.t[i] - this.len[i]);
      if (tail >= this.dist[i] - 0.01) {
        this.live[i] = 0;
        this.active--;
        this.mesh.setMatrixAt(i, ZERO);
        continue;
      }
      _v.set(this.dir[i3], this.dir[i3 + 1], this.dir[i3 + 2]);
      _p.set(this.from[i3] + _v.x * head, this.from[i3 + 1] + _v.y * head, this.from[i3 + 2] + _v.z * head);
      // The box extends along -z from the head; point -z backwards along the flight.
      _q.setFromUnitVectors(_z, _v);
      _s.set(0.012, 0.012, head - tail);
      this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}

// ---- per-material looks -------------------------------------------------------------------------------------------

type Debris = 'brick' | 'plaster' | 'concrete' | 'wood' | 'metal';

const MAT_LOOK: Record<Debris, { color: number; rough: number; metal: number; dust: number; dustColor: number; grit: number; chips: number }> = {
  brick: { color: 0x84422d, rough: 0.92, metal: 0, dust: 0.85, dustColor: 0x9a7b68, grit: 0x7a4a36, chips: 0xb88a72 },
  plaster: { color: 0xc9c1b0, rough: 0.95, metal: 0, dust: 1, dustColor: 0xc8c2b6, grit: 0xb9b2a4, chips: 0xe4ded2 },
  concrete: { color: 0x7d7a73, rough: 0.9, metal: 0, dust: 0.75, dustColor: 0x8c8982, grit: 0x6e6b65, chips: 0xa8a49b },
  wood: { color: 0x6e4c2e, rough: 0.8, metal: 0, dust: 0.3, dustColor: 0x7a644c, grit: 0x8a6440, chips: 0xc8a272 },
  metal: { color: 0x5c6166, rough: 0.42, metal: 0.85, dust: 0.08, dustColor: 0x5a5a5a, grit: 0x55595e, chips: 0x9aa0a6 },
};

/** The hotel's materials break like their closest classic one: stone like concrete, walnut like wood, glass like plaster (bright, flaky). */
const asDebris = (m: string): Debris =>
  m === 'brick' || m === 'plaster' || m === 'concrete' || m === 'wood' || m === 'metal'
    ? m
    : m === 'walnut'
      ? 'wood'
      : m === 'glass'
        ? 'plaster'
        : 'concrete';

// ---- the effects system ---------------------------------------------------------------------------------------------

interface Flash {
  pos: Vec3;
  color: THREE.Color;
  intensity: number;
  peak: number;
  life: number;
  age: number;
  live: boolean;
  /** Muzzle flashes follow their muzzle. */
  follow: THREE.Object3D | null;
}

interface MuzzleSprite {
  mesh: THREE.Group;
  left: number;
}

class Effects implements Fx {
  private readonly root = new THREE.Group();
  private readonly frags: Record<Debris | 'gore' | 'dirt', FragmentPool[]>;
  /** Whole chunk-sized slabs for collapses: they drop, and shatter when they land hard. */
  private readonly slabs: Record<Debris, FragmentPool>;
  private readonly slabMat = new Map<FragmentPool, Debris>();
  private readonly planks: FragmentPool;
  private readonly casings: FragmentPool;
  private readonly embers: ParticlePool;
  private readonly rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; size: number }[] = [];
  private readonly piles: Piles;
  /** Timed follow-ups (fireball waves, smoke columns, blood pools growing in): a small fixed ring. */
  private readonly later: { at: number; fn: (() => void) | null }[] = Array.from({ length: 96 }, () => ({ at: 0, fn: null }));
  private lastHeavyPuff = 0;
  private readonly grit: ParticlePool;
  private readonly sparks: ParticlePool;
  private readonly drops: ParticlePool;
  private readonly smoke: SpritePool;
  private readonly fire: SpritePool;
  private readonly decals: DecalPool;
  private readonly tracers: TracerPool;
  private readonly muzzles: MuzzleSprite[] = [];
  private readonly flashPool: Flash[] = [];
  private readonly flashOut: FrameParams['flashes'] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly camQ = new THREE.Quaternion();
  private time = 0;
  private lastPuff = 0;
  private tracerN = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
    private readonly pipeline: Pipeline,
  ) {
    this.root.name = 'zombies-fx';
    scene.add(this.root);
    const own = <T extends { dispose(): void }>(x: T) => (this.disposables.push(x), x);

    this.piles = new Piles(world);
    // Fragments: two shapes per material, so a pile never looks cloned. Every material carries its surface pattern.
    const fragMat = (color: number, rough: number, metal: number, kind: number) =>
      own(surfaced(new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, flatShading: true }), kind));
    const make = (geos: THREE.BufferGeometry[], mat: THREE.Material, n: number, bounce?: number) =>
      geos.map((g) => {
        own(g);
        const pool = new FragmentPool(g, mat, n, world, this.piles, bounce);
        this.root.add(pool.mesh);
        return pool;
      });
    const look = (m: Debris) => MAT_LOOK[m];
    const mats = {} as Record<Debris, THREE.Material>;
    for (const m of Object.keys(MAT_LOOK) as Debris[]) mats[m] = fragMat(look(m).color, look(m).rough, look(m).metal, SURFACE_KIND[m]);
    this.frags = {
      brick: make([brickGeometry(1), rockGeometry(2)], mats.brick, 90),
      plaster: make([shardGeometry(3, 0.16), rockGeometry(4, 0, 0.6)], mats.plaster, 90),
      concrete: make([rockGeometry(5), rockGeometry(6, 1)], mats.concrete, 90),
      wood: make([splinterGeometry(7), shardGeometry(8, 0.22)], mats.wood, 70),
      metal: make([shardGeometry(9, 0.06), shardGeometry(10, 0.1)], mats.metal, 48, 0.4),
      gore: make([rockGeometry(11, 1, 0.8)], own(surfaced(new THREE.MeshStandardMaterial({ color: 0x5a0c0a, roughness: 0.28, metalness: 0 }), SURFACE_KIND.flesh)), 48, 0.15),
      dirt: make([rockGeometry(12, 0, 0.8)], fragMat(0x2f271e, 0.98, 0, SURFACE_KIND.dirt), 60, 0.12),
    };
    // Slabs: a chunk-shaped block with chipped corners, so a collapsing wall comes down in recognisable pieces.
    const slabGeo = own(new THREE.BoxGeometry(1, 1, 1, 2, 2, 2));
    {
      const p = slabGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        const corner = Math.abs(x) > 0.45 && Math.abs(y) > 0.45 && Math.abs(z) > 0.45;
        const k = corner ? 0.82 + hash(i, 21) * 0.12 : 0.96 + hash(i, 22) * 0.06;
        p.setXYZ(i, x * k, y * k, z * k);
      }
    }
    const slabGeoFlat = own(flat(slabGeo));
    this.slabs = {} as Record<Debris, FragmentPool>;
    for (const m of Object.keys(MAT_LOOK) as Debris[]) {
      const pool = new FragmentPool(slabGeoFlat, mats[m], m === 'metal' ? 24 : 48, world, this.piles, 0.12, 0.4, 12);
      pool.onImpact = (_i, x, y, z, speed, size) => this.shatter(m, x, y, z, speed, size);
      this.slabMat.set(pool, m);
      this.root.add(pool.mesh);
      this.slabs[m] = pool;
    }
    const plankGeo = own(new THREE.BoxGeometry(1, 1, 1, 6, 1, 1));
    {
      // Weathered plank with a ragged, snapped end.
      const p = plankGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) if (p.getX(i) > 0.45) p.setX(i, p.getX(i) - hash(i, 4) * 0.08);
      plankGeo.computeVertexNormals();
    }
    this.planks = new FragmentPool(plankGeo, mats.wood, 24, world, this.piles, 0.3);
    this.root.add(this.planks.mesh);
    // Brass: casings bounce, roll a little and lie around for a while.
    const casingGeo = own(new THREE.CylinderGeometry(0.5, 0.5, 1, 8).rotateX(Math.PI / 2));
    this.casings = new FragmentPool(casingGeo, own(new THREE.MeshStandardMaterial({ color: 0xc9973f, roughness: 0.32, metalness: 1 })), 140, world, this.piles, 0.42, 0.85, 2.2);
    this.casings.snapRest = false;
    this.root.add(this.casings.mesh);

    const gritMat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }));
    this.grit = new ParticlePool(own(new THREE.TetrahedronGeometry(0.5)), gritMat, 700, { stretch: 0, drag: 0.6, bounce: 0.25, fade: false, gravity: GRAVITY });
    const sparkMat = own(instanced(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), { alpha: true }));
    this.sparks = new ParticlePool(own(new THREE.BoxGeometry(1, 1, 1)), sparkMat, 360, { stretch: 0.025, drag: 1.2, bounce: 0.35, fade: true, gravity: 9 });
    const dropMat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.18, metalness: 0 }));
    this.drops = new ParticlePool(own(new THREE.IcosahedronGeometry(0.5, 0)), dropMat, 420, {
      stretch: 0.02,
      drag: 0.4,
      bounce: 0,
      fade: false,
      gravity: GRAVITY,
      onLand: (x, _y, z) => {
        if (Math.random() < 0.22) this.decals.add({ x, y: 0, z }, { x: 0, y: 1, z: 0 }, rand(0.06, 0.2), Math.random() < 0.5 ? D.blood : D.blood2, _c.set(1, 1, 1), -1, 0.9);
      },
    });
    // Embers: burning bits from explosions that drift, flicker out and barely fall.
    this.embers = new ParticlePool(own(new THREE.BoxGeometry(1, 1, 1)), sparkMat, 160, { stretch: 0.01, drag: 0.9, bounce: 0.2, fade: true, gravity: 2.2 });
    this.root.add(this.grit.mesh, this.sparks.mesh, this.drops.mesh, this.embers.mesh);
    // Shockwave: a flat ring of dust racing out along the floor.
    const ringGeo = own(new THREE.RingGeometry(0.55, 1, 48, 1).rotateX(-Math.PI / 2));
    for (let i = 0; i < 3; i++) {
      const mat = own(new THREE.MeshBasicMaterial({ color: 0x8a8378, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.userData.noMoonShadow = true;
      this.root.add(mesh);
      this.rings.push({ mesh, mat, age: 0, life: 0, size: 0 });
    }

    const smokeTex = own(smokeTexture());
    const smokeMat = own(
      instanced(new THREE.MeshStandardMaterial({ map: smokeTex, color: 0xffffff, roughness: 1, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide }), { alpha: true }),
    );
    this.smoke = new SpritePool(smokeMat, 220);
    const fireMat = own(
      instanced(new THREE.MeshBasicMaterial({ map: own(fireTexture()), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }), { alpha: true }),
    );
    this.fire = new SpritePool(fireMat, 72);
    this.root.add(this.smoke.mesh, this.fire.mesh);

    const atlas = decalAtlas();
    own(atlas.color);
    own(atlas.normal);
    own(atlas.rough);
    const decalMat = own(
      instanced(
        new THREE.MeshStandardMaterial({
          map: atlas.color,
          normalMap: atlas.normal,
          normalScale: new THREE.Vector2(1.4, 1.4),
          roughnessMap: atlas.rough,
          roughness: 1,
          metalness: 0,
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4,
        }),
        { alpha: true, atlas: true },
      ),
    );
    this.decals = new DecalPool(decalMat, 360);
    this.root.add(this.decals.mesh);

    const tracerMat = own(
      instanced(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.82, 0.5).multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), {
        alpha: true,
      }),
    );
    this.tracers = new TracerPool(tracerMat, 64);
    this.root.add(this.tracers.mesh);

    // Muzzle flash: crossed star cards (front, two lengthwise) plus two side vents for muzzle brakes, re-parented to
    // whichever muzzle fires and laid out per weapon kind in muzzle().
    const starMat = own(new THREE.MeshBasicMaterial({ map: own(starTexture()), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    const flameMat = own(new THREE.MeshBasicMaterial({ map: own(flameTexture()), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
    const card = own(new THREE.PlaneGeometry(1, 1));
    // Lengthwise flame card: its base sits at the muzzle and it grows forward (-z).
    const flameCard = own(new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0));
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group();
      const front = new THREE.Mesh(card, starMat);
      const side1 = new THREE.Mesh(flameCard, flameMat);
      side1.rotation.y = Math.PI / 2;
      const side2 = new THREE.Mesh(flameCard, flameMat);
      side2.rotation.order = 'YXZ';
      side2.rotation.set(-Math.PI / 2, Math.PI / 2, 0);
      const ventL = new THREE.Mesh(flameCard, flameMat);
      ventL.rotation.set(-Math.PI / 2, 0, Math.PI);
      const ventR = new THREE.Mesh(flameCard, flameMat);
      ventR.rotation.set(-Math.PI / 2, 0, 0);
      g.add(front, side1, side2, ventL, ventR);
      g.visible = false;
      for (const m of [front, side1, side2, ventL, ventR]) m.frustumCulled = false;
      this.muzzles.push({ mesh: g, left: 0 });
    }
    for (let i = 0; i < 10; i++) this.flashPool.push({ pos: { x: 0, y: 0, z: 0 }, color: new THREE.Color(), intensity: 0, peak: 0, life: 0, age: 0, live: false, follow: null });
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  private flash(p: Vec3, color: number, peak: number, life: number, follow: THREE.Object3D | null = null) {
    let f = this.flashPool.find((x) => !x.live);
    if (!f) {
      f = this.flashPool[0];
      for (const x of this.flashPool) if (x.peak * (1 - x.age / x.life) < f.peak * (1 - f.age / f.life)) f = x;
    }
    f.pos.x = p.x;
    f.pos.y = p.y;
    f.pos.z = p.z;
    f.color.set(color);
    f.peak = peak;
    f.intensity = peak;
    f.life = life;
    f.age = 0;
    f.live = true;
    f.follow = follow;
  }

  private puff(p: Vec3, radius: number, density: number, life: number, grow?: number) {
    this.pipeline.puff(p, radius, density, life, grow);
  }

  private fragPool(kind: keyof Effects['frags']) {
    const pools = this.frags[kind];
    return pools[Math.floor(Math.random() * pools.length)];
  }

  /** Runs `fn` after `delay` seconds (dropped when the ring is full). */
  private schedule(delay: number, fn: () => void) {
    const slot = this.later.find((x) => !x.fn);
    if (!slot) return;
    slot.at = this.time + delay;
    slot.fn = fn;
  }

  /** A falling slab hit the ground hard: it breaks into rubble with a burst of dust. */
  private shatter(m: Debris, x: number, y: number, z: number, speed: number, size: number): boolean {
    const L = MAT_LOOK[m];
    // A gentle drop onto a pile keeps the slab whole; a real fall breaks it.
    if (speed < (m === 'metal' ? 6 : m === 'wood' ? 4.5 : 3.2)) return false;
    const pieces = m === 'metal' ? 2 : 4 + Math.round(size * 6);
    for (let i = 0; i < pieces; i++) {
      const pool = this.fragPool(m);
      const th = rand(0, 6.28);
      const s = rand(0.6, 2.2) * Math.min(1.6, speed / 5);
      const f = m === 'wood' ? 1 : rand(0.3, 0.55);
      _c.set(L.color).multiplyScalar(rand(0.75, 1.2));
      const fx = m === 'wood' ? rand(0.05, 0.1) : size * f;
      const fz = m === 'wood' ? rand(0.2, 0.45) : size * f * rand(0.6, 1.1);
      pool.spawn(x + Math.cos(th) * size * 0.25, y + size * 0.3, z + Math.sin(th) * size * 0.25, Math.cos(th) * s, rand(0.6, 2.4), Math.sin(th) * s, fx, size * f * rand(0.5, 0.9), fz, _c, rand(12, 20));
    }
    _c.set(L.grit);
    for (let i = 0; i < 8; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.8, 3);
      this.grit.spawn(x, y + 0.05, z, Math.cos(th) * s, rand(0.3, 2), Math.sin(th) * s, rand(0.01, 0.03), rand(1, 2.5), _c);
    }
    if (L.dust > 0.2) {
      _c.set(L.dustColor);
      this.smoke.spawn(x, y + 0.15, z, rand(-0.3, 0.3), 0.1, rand(-0.3, 0.3), 0.35, 0.9, rand(2.5, 4.5), 0.45 * L.dust, _c);
      // Low dust skirting out from the impact.
      for (let i = 0; i < 2; i++) {
        const th = rand(0, 6.28);
        this.smoke.spawn(x, y + 0.08, z, Math.cos(th) * 1.4, 0.02, Math.sin(th) * 1.4, 0.25, 0.7, rand(1.5, 2.5), 0.3 * L.dust, _c);
      }
      if (this.time - this.lastHeavyPuff > 0.05) {
        this.lastHeavyPuff = this.time;
        this.puff({ x, y: y + 0.3, z }, 0.5 + size, L.dust * 0.8, rand(4, 7), 0.6);
      }
    }
    if (m === 'metal') {
      for (let i = 0; i < 5; i++) {
        const s = rand(2, 6);
        _c.setRGB(1, rand(0.6, 0.9), 0.3).multiplyScalar(4);
        this.sparks.spawn(x, y + 0.05, z, rand(-1, 1) * s, rand(0.5, 2) * s * 0.4, rand(-1, 1) * s, 0.012, rand(0.15, 0.4), _c);
      }
    }
    return true;
  }

  private ring(p: Vec3, size: number, life: number) {
    const r = this.rings.find((x) => x.age >= x.life) ?? this.rings[0];
    r.mesh.position.set(p.x, Math.max(0.03, p.y < 1.4 ? 0.03 : p.y), p.z);
    r.mesh.visible = true;
    r.age = 0;
    r.life = life;
    r.size = size;
  }

  // ---- Fx -----------------------------------------------------------------------------------------------------------

  impact(p: Vec3, n: Vec3, mat: ImpactMat, chunk: number) {
    if (mat === 'none') return;
    if (mat === 'flesh') {
      this.blood(p, { x: -n.x, y: -n.y, z: -n.z }, 0.35);
      return;
    }
    const m = asDebris(mat);
    const L = MAT_LOOK[m];
    const cell = m === 'wood' ? D.wood : m === 'metal' ? D.metal : Math.random() < 0.5 ? D.hole : D.hole2;
    // Masonry holes are tinted towards the raw inside of the material.
    const tint = m === 'brick' ? _c.setRGB(0.95, 0.66, 0.55) : m === 'plaster' ? _c.setRGB(1, 0.98, 0.94) : m === 'concrete' ? _c.setRGB(0.82, 0.8, 0.77) : _c.setRGB(1, 1, 1);
    const size = m === 'metal' ? rand(0.045, 0.06) : m === 'wood' ? rand(0.07, 0.1) : rand(0.07, 0.11);
    this.decals.add(p, n, size, cell, tint, chunk, 1, m === 'wood' ? 1.4 : 1);
    const ox = p.x + n.x * 0.02;
    const oy = p.y + n.y * 0.02;
    const oz = p.z + n.z * 0.02;
    // Chips fly out in a cone around the surface normal, grit falls.
    const chips = m === 'metal' ? 2 : m === 'plaster' ? 4 : 6;
    _c.set(L.chips);
    for (let i = 0; i < chips; i++) {
      const s = rand(1.5, 4.5);
      this.grit.spawn(ox, oy, oz, (n.x + rand(-0.7, 0.7)) * s, (n.y + rand(-0.2, 0.9)) * s, (n.z + rand(-0.7, 0.7)) * s, rand(0.012, 0.03), rand(1, 2.5), _c);
    }
    switch (m) {
      case 'brick':
        // A fat red-brown puff and a chunk of brick now and then.
        _c.setRGB(0.55, 0.28, 0.2);
        this.smoke.spawn(ox + n.x * 0.06, oy + n.y * 0.06, oz + n.z * 0.06, n.x * 0.9, n.y * 0.9 + 0.12, n.z * 0.9, 0.1, 0.55, rand(0.9, 1.6), 0.5, _c);
        if (Math.random() < 0.4) {
          _c.set(L.color).multiplyScalar(rand(0.85, 1.15));
          this.fragPool('brick').spawn(ox, oy, oz, (n.x + rand(-0.5, 0.5)) * 2.5, rand(0.5, 2.5), (n.z + rand(-0.5, 0.5)) * 2.5, rand(0.04, 0.07), rand(0.025, 0.04), rand(0.03, 0.05), _c, rand(8, 14));
        }
        break;
      case 'plaster':
        // White burst, and flakes of paint that flutter down.
        _c.setRGB(0.88, 0.86, 0.82);
        this.smoke.spawn(ox + n.x * 0.06, oy + n.y * 0.06, oz + n.z * 0.06, n.x * 1.1, n.y * 1.1 + 0.15, n.z * 1.1, 0.12, 0.7, rand(1, 1.8), 0.65, _c);
        for (let i = 0; i < 3; i++) {
          _c.set(L.color).multiplyScalar(rand(0.9, 1.1));
          this.frags.plaster[0].spawn(ox, oy, oz, (n.x + rand(-0.6, 0.6)) * 1.6, rand(0.3, 1.5), (n.z + rand(-0.6, 0.6)) * 1.6, rand(0.03, 0.06), 0.006, rand(0.03, 0.06), _c, rand(6, 12), 0, 12);
        }
        break;
      case 'concrete':
        _c.setRGB(0.5, 0.49, 0.47);
        this.smoke.spawn(ox + n.x * 0.06, oy + n.y * 0.06, oz + n.z * 0.06, n.x * 0.8, n.y * 0.8 + 0.1, n.z * 0.8, 0.09, 0.45, rand(0.8, 1.4), 0.4, _c);
        break;
      case 'wood':
        // Splinters torn out along the grain.
        for (let i = 0; i < 3; i++) {
          _c.set(L.chips).multiplyScalar(rand(0.8, 1.1));
          this.frags.wood[0].spawn(ox, oy, oz, (n.x + rand(-0.8, 0.8)) * 2.4, rand(0.5, 2.5), (n.z + rand(-0.8, 0.8)) * 2.4, rand(0.008, 0.014), rand(0.008, 0.012), rand(0.05, 0.13), _c, rand(8, 14));
        }
        break;
      case 'metal':
        break;
    }
    if (m === 'metal' || m === 'concrete') {
      const k = m === 'metal' ? 12 : 4;
      for (let i = 0; i < k; i++) {
        const s = rand(3, m === 'metal' ? 12 : 8);
        _c.setRGB(1, rand(0.55, 0.85), rand(0.2, 0.4)).multiplyScalar(m === 'metal' ? 5 : 3.5);
        this.sparks.spawn(ox, oy, oz, (n.x + rand(-0.8, 0.8)) * s, (n.y + rand(-0.3, 1)) * s, (n.z + rand(-0.8, 0.8)) * s, rand(0.008, 0.016), rand(0.1, 0.4), _c);
      }
      if (m === 'metal') {
        this.flash({ x: p.x + n.x * 0.1, y: p.y + n.y * 0.1, z: p.z + n.z * 0.1 }, 0xffb060, 1.4, 0.05);
        // Ricochet: a bright streak whining off the plate.
        if (Math.random() < 0.3) {
          const rx = n.x + rand(-0.7, 0.7);
          const ry = n.y + rand(-0.2, 0.6);
          const rz = n.z + rand(-0.7, 0.7);
          const rl = Math.hypot(rx, ry, rz) || 1;
          this.tracers.spawn({ x: p.x - (rx / rl) * 1.6, y: p.y - (ry / rl) * 1.6, z: p.z - (rz / rl) * 1.6 }, { x: p.x + (rx / rl) * 10, y: p.y + (ry / rl) * 10, z: p.z + (rz / rl) * 10 }, 2.5, 0.7);
        }
      }
    }
    // Dust in the fog, rate-limited (an LMG would otherwise flood the fog with blobs).
    if (this.time - this.lastPuff > 0.035) {
      this.lastPuff = this.time;
      this.puff({ x: p.x + n.x * 0.15, y: p.y + n.y * 0.15, z: p.z + n.z * 0.15 }, m === 'plaster' ? 0.2 : 0.14, L.dust * (m === 'plaster' ? 0.6 : 0.4), 1.6, 0.4);
    }
  }

  tracer(from: Vec3, to: Vec3, kind: WeaponKind) {
    this.tracerN++;
    // Most rounds are invisible; tracer rounds in the belt are the exception (every round for the LMG).
    const every = kind === 'lmg' ? 2 : kind === 'rifle' ? 3 : kind === 'sniper' ? 1 : kind === 'smg' ? 4 : kind === 'shotgun' ? 3 : 5;
    if (this.tracerN % every !== 0) return;
    const bright = kind === 'sniper' ? 0.9 : kind === 'lmg' ? 0.6 : kind === 'rifle' ? 0.45 : 0.25;
    this.tracers.spawn(from, to, kind === 'sniper' ? 9 : rand(3, 6), bright);
  }

  muzzle(obj: THREE.Object3D, kind: WeaponKind, viewmodel: boolean) {
    const m = this.muzzles.find((x) => x.left <= 0) ?? this.muzzles[0];
    if (m.mesh.parent !== obj) obj.add(m.mesh);
    const [front, side1, side2, ventL, ventR] = m.mesh.children;
    // Per kind: star size, forward flame length and width, side vents (muzzle brake).
    const L = MUZZLE[kind];
    const j = rand(0.8, 1.2);
    front.scale.set(L.star * j, L.star * j, 1);
    front.rotation.set(0, 0, rand(0, 6.28));
    const len = L.flame * rand(0.75, 1.25);
    side1.scale.set(len, L.width * j, 1);
    side2.scale.set(len, L.width * j, 1);
    side1.rotation.x = rand(-0.3, 0.3);
    ventL.visible = ventR.visible = L.vent > 0;
    if (L.vent > 0) {
      ventL.scale.set(L.vent * rand(0.8, 1.2), L.vent * 0.4, 1);
      ventR.scale.set(L.vent * rand(0.8, 1.2), L.vent * 0.4, 1);
      ventL.position.z = ventR.position.z = 0.04;
    }
    m.mesh.position.set(0, 0, -0.01);
    m.mesh.rotation.set(0, 0, 0);
    m.mesh.scale.setScalar(1);
    m.mesh.visible = true;
    m.left = kind === 'sniper' || kind === 'shotgun' ? 0.065 : 0.045;
    m.mesh.traverse((o) => (viewmodel ? o.layers.set(VIEWMODEL_LAYER) : o.layers.set(0)));
    obj.getWorldPosition(_p);
    const at = { x: _p.x, y: _p.y, z: _p.z };
    this.flash(at, 0xffb46a, kind === 'pistol' ? 6 : kind === 'sniper' ? 16 : kind === 'shotgun' ? 12 : 9, 0.06, obj);
    // Gun smoke: drifts out of the barrel and hangs in the light.
    obj.getWorldDirection(_v);
    if (!viewmodel || Math.random() < 0.6) {
      _c.setRGB(0.6, 0.6, 0.62);
      const big = kind === 'shotgun' || kind === 'sniper';
      this.smoke.spawn(at.x - _v.x * 0.1, at.y - _v.y * 0.1, at.z - _v.z * 0.1, -_v.x * (big ? 1.4 : 0.8), 0.15, -_v.z * (big ? 1.4 : 0.8), big ? 0.14 : 0.08, big ? 0.8 : 0.5, rand(0.9, 1.6), big ? 0.3 : 0.18, _c);
    }
    if (kind === 'shotgun') {
      // Burning wad flakes and a short spray of embers.
      for (let i = 0; i < 6; i++) {
        _c.setRGB(1, rand(0.5, 0.7), 0.2).multiplyScalar(3);
        const s = rand(4, 9);
        this.embers.spawn(at.x, at.y, at.z, -_v.x * s + rand(-0.8, 0.8), -_v.y * s + rand(-0.5, 0.8), -_v.z * s + rand(-0.8, 0.8), rand(0.006, 0.012), rand(0.15, 0.4), _c);
      }
    }
    this.puff(at, kind === 'shotgun' || kind === 'sniper' ? 0.35 : 0.2, 0.3, 1.6, 0.6);
  }

  /**
   * A spent case flies out of the ejection port (to the right of and just behind `from`, usually the muzzle or the
   * gun) and bounces and rolls on the floor. Shotguns throw red hulls, snipers long brass.
   */
  casing(from: THREE.Object3D, kind: WeaponKind) {
    from.updateWorldMatrix(true, false);
    from.getWorldPosition(_p);
    _q.setFromRotationMatrix(from.matrixWorld);
    // Right (+x) and back (+z) of the gun, in the world.
    _v.set(1, 0, 0).applyQuaternion(_q);
    const rx = _v.x;
    const ry = _v.y;
    const rz = _v.z;
    _v.set(0, 0, 1).applyQuaternion(_q);
    const back = kind === 'pistol' || kind === 'smg' ? 0.12 : kind === 'shotgun' ? 0.35 : 0.3;
    const px = _p.x + _v.x * back + rx * 0.03;
    const py = _p.y + _v.y * back + 0.02;
    const pz = _p.z + _v.z * back + rz * 0.03;
    const s = rand(2, 3.4);
    const len = kind === 'pistol' || kind === 'smg' ? 0.021 : kind === 'shotgun' ? 0.068 : kind === 'sniper' ? 0.1 : 0.045;
    const dia = kind === 'shotgun' ? 0.02 : kind === 'sniper' ? 0.02 : kind === 'lmg' || kind === 'rifle' ? 0.011 : 0.0095;
    if (kind === 'shotgun') _c.setRGB(0.9, 0.12, 0.1);
    else _c.setRGB(rand(0.92, 1.05), rand(0.92, 1.02), rand(0.85, 1));
    this.casings.spawn(px, py, pz, rx * s + _v.x * 0.4 + rand(-0.3, 0.3), ry * s + rand(1.2, 2.2), rz * s + _v.z * 0.4 + rand(-0.3, 0.3), dia, dia, len, _c, rand(10, 16), 0, 22);
  }

  blood(p: Vec3, dir: Vec3, amount: number) {
    const a = Math.max(0.1, Math.min(2, amount));
    const n = Math.round(6 + a * 20);
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const dx = dir.x / dl;
    const dy = dir.y / dl;
    const dz = dir.z / dl;
    // Exit spray: carried on with the bullet, fast and narrow.
    for (let i = 0; i < n; i++) {
      const s = rand(1.5, 5.5) * (0.6 + a * 0.4);
      _c.setRGB(rand(0.22, 0.38), rand(0.005, 0.02), rand(0.005, 0.02));
      this.drops.spawn(p.x, p.y, p.z, (dx + rand(-0.4, 0.4)) * s, (dy + rand(-0.15, 0.6)) * s, (dz + rand(-0.4, 0.4)) * s, rand(0.012, 0.03), rand(1.5, 3), _c);
    }
    // Entry back-spatter: a few drops back towards the shooter.
    for (let i = 0; i < Math.round(2 + a * 4); i++) {
      const s = rand(0.8, 2.2);
      _c.setRGB(rand(0.25, 0.4), 0.01, 0.01);
      this.drops.spawn(p.x, p.y, p.z, (-dx + rand(-0.6, 0.6)) * s, rand(0, 1.2) * s, (-dz + rand(-0.6, 0.6)) * s, rand(0.01, 0.02), rand(1, 2), _c);
    }
    // A red mist along the shot that catches the light.
    _c.setRGB(0.35, 0.03, 0.03);
    this.smoke.spawn(p.x + dx * 0.15, p.y, p.z + dz * 0.15, dx * 1.4, 0.05, dz * 1.4, 0.12, 0.7 * a, rand(0.5, 0.9), 0.5, _c);
    this.smoke.spawn(p.x, p.y, p.z, -dx * 0.3, 0.02, -dz * 0.3, 0.08, 0.35 * a, rand(0.4, 0.7), 0.35, _c);
    // Splatter on a wall behind the target.
    const ddy = dy * 0.5 - 0.15;
    const hit = raycast(this.world, p, { x: dx, y: ddy, z: dz }, 2.8);
    if (hit && Math.random() < 0.45 + a * 0.3) {
      const t = hit.t;
      const hp = { x: p.x + dx * t, y: p.y + ddy * t, z: p.z + dz * t };
      const wall = hit.n.y < 0.5;
      this.decals.add(hp, hit.n, rand(0.25, 0.55) * (0.6 + a * 0.4) * Math.max(0.5, 1 - t * 0.2), wall ? (Math.random() < 0.5 ? D.smear : D.blood2) : D.blood, _c.set(1, 1, 1), hit.chunk, 0.95, wall ? 1.6 : 1);
      // Runs down the wall: a second, stretched streak just below.
      if (wall && a > 0.6) this.decals.add({ x: hp.x, y: hp.y - 0.18, z: hp.z }, hit.n, rand(0.12, 0.2), D.smear, _c.set(1, 1, 1), hit.chunk, 0.85, 2.4);
    }
  }

  /**
   * A body hit the floor at `p`: blood pools out under it over several seconds, with a drag smear behind if it was
   * thrown (`dir`, the push).
   */
  corpse(p: Vec3, dir: Vec3) {
    const dl = Math.hypot(dir.x, dir.z) || 1;
    const dx = dir.x / dl;
    const dz = dir.z / dl;
    const at = { x: p.x + dx * 0.5, y: 0, z: p.z + dz * 0.5 };
    this.schedule(rand(0.5, 1), () => {
      const i = this.decals.add(at, { x: 0, y: 1, z: 0 }, 0.12, Math.random() < 0.5 ? D.blood : D.blood2, _c.setRGB(0.85, 0.85, 0.85), -1, 0.96);
      this.decals.grow(i, rand(0.9, 1.4), rand(6, 9));
    });
    if (Math.hypot(dir.x, dir.z) > 0.2) this.decals.add({ x: p.x + dx * 0.15, y: 0, z: p.z + dz * 0.15 }, { x: 0, y: 1, z: 0 }, rand(0.35, 0.5), D.smear, _c.set(1, 1, 1), -1, 0.8, 2.2);
  }

  /**
   * Chunks broke. Bullet and bash breaks (a few chunks, not a blast) crumble in place; a long list without `blast` is
   * a collapse (chunks that lost their support) and comes down as staggered slabs.
   */
  debris(chunks: number[], from: Vec3, blast: boolean) {
    if (!chunks.length) return;
    if (!blast && chunks.length >= 3) {
      this.collapse(chunks, from);
      return;
    }
    // Many chunks at once (a grenade): fewer pieces each, so the pools are never flushed in one go.
    const per = Math.max(0.12, Math.min(1, 14 / chunks.length));
    let puffs = 0;
    const maxPuffs = blast ? 10 : 6;
    for (let k = 0; k < chunks.length; k++) {
      const c = this.world.chunks[chunks[k]];
      if (!c) continue;
      const m = asDebris(c.mat);
      const L = MAT_LOOK[m];
      const sx = c.max.x - c.min.x;
      const sy = c.max.y - c.min.y;
      const sz = c.max.z - c.min.z;
      const cx = (c.min.x + c.max.x) / 2;
      const cy = (c.min.y + c.max.y) / 2;
      const cz = (c.min.z + c.max.z) / 2;
      const vol = sx * sy * sz;
      let ax = cx - from.x;
      let ay = cy - from.y;
      let az = cz - from.z;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      const near = Math.max(0, 1 - al / 5);
      const speed = blast ? 4 + near * 9 : 1.2 + near * 1.6;
      // One big slab-ish lump plus smaller pieces: a broken chunk is mostly a few big bits, not gravel.
      if (!blast || Math.random() < 0.5) {
        _c.set(L.color).multiplyScalar(rand(0.85, 1.1));
        const f = rand(0.5, 0.7);
        const back = !blast && Math.random() < 0.5 ? -0.4 : 1;
        this.slabs[m].spawn(cx, cy, cz, ax * speed * back + rand(-0.5, 0.5), rand(0.2, 1.2) * (blast ? 3 : 1), az * speed * back + rand(-0.5, 0.5), sx * f, sy * f, sz * f, _c, rand(14, 22), 0, blast ? 9 : 4);
      }
      const base = m === 'metal' ? 3 : m === 'wood' ? 5 : 6;
      const count = Math.max(1, Math.round(base * per * Math.min(1.5, 0.4 + vol * 18)));
      for (let i = 0; i < count; i++) {
        const pool = this.fragPool(m);
        const px = c.min.x + rand(0.15, 0.85) * sx;
        const py = c.min.y + rand(0.15, 0.85) * sy;
        const pz = c.min.z + rand(0.15, 0.85) * sz;
        const sp = speed * rand(0.5, 1.2);
        const f = m === 'wood' ? 1 : rand(0.22, 0.42);
        let fx = Math.max(sx, sz) * f;
        let fy = sy * f * rand(0.6, 1);
        let fz = Math.min(sx, sz) * f * rand(0.7, 1.3);
        if (m === 'wood') {
          // Splinters: long along the board, thin across.
          fx = rand(0.04, 0.1);
          fy = rand(0.03, 0.07);
          fz = rand(0.18, 0.45);
        } else if (m === 'brick') {
          fx = rand(0.18, 0.24);
          fy = rand(0.06, 0.08);
          fz = rand(0.09, 0.12);
        }
        _c.set(L.color).multiplyScalar(rand(0.75, 1.2));
        // Spall: a share of a shot-out chunk bursts back towards the shooter and piles up on their side.
        const back = !blast && Math.random() < 0.45 ? -0.45 : 1;
        pool.spawn(px, py, pz, ax * sp * back + rand(-1, 1), ay * sp * 0.5 + rand(0.2, 1.8) * (blast ? 2 : 1), az * sp * back + rand(-1, 1), fx, fy, fz, _c, rand(12, 20));
      }
      // Grit and mortar dust.
      _c.set(L.grit);
      const grit = Math.round((blast ? 12 : 8) * per);
      for (let i = 0; i < grit; i++) {
        const s = speed * rand(0.4, 1.4);
        this.grit.spawn(cx + rand(-0.2, 0.2), cy + rand(-0.2, 0.2), cz + rand(-0.2, 0.2), ax * s + rand(-1.5, 1.5), rand(-0.5, 2.5), az * s + rand(-1.5, 1.5), rand(0.01, 0.035), rand(1.5, 4), _c);
      }
      if (m === 'metal') {
        for (let i = 0; i < 6; i++) {
          const s = rand(3, 8);
          _c.setRGB(1, rand(0.6, 0.9), 0.3).multiplyScalar(4);
          this.sparks.spawn(cx, cy, cz, (ax + rand(-1, 1)) * s, rand(0, 4), (az + rand(-1, 1)) * s, 0.012, rand(0.2, 0.5), _c);
        }
      }
      // Dust clouds: fog blobs lit by everything, plus sprites for the low-quality path. Every few chunks.
      if (puffs < maxPuffs && (k % Math.max(1, Math.floor(chunks.length / maxPuffs)) === 0 || chunks.length <= maxPuffs)) {
        puffs++;
        const r = (0.45 + vol * 3) * (blast ? 1.4 : 1);
        this.puff({ x: cx, y: cy, z: cz }, r, L.dust, rand(5, 8), 0.5);
        if (L.dust > 0.2) {
          _c.set(L.dustColor);
          for (let i = 0; i < 3; i++)
            this.smoke.spawn(cx + rand(-0.2, 0.2), cy + rand(-0.2, 0.2), cz + rand(-0.2, 0.2), ax * 0.6 + rand(-0.3, 0.3), rand(-0.1, 0.25), az * 0.6 + rand(-0.3, 0.3), 0.4, 0.7, rand(3, 6), 0.45 * L.dust, _c);
        }
        // Fine dust trickling from what is left above the hole, for a few seconds.
        if (c.wall && !blast) {
          const top = c.max.y;
          for (let t = 0; t < 4; t++)
            this.schedule(0.3 + t * 0.5, () => {
              _c.set(L.grit);
              for (let i = 0; i < 3; i++) this.grit.spawn(cx + rand(-0.25, 0.25), top, cz + rand(-0.25, 0.25), 0, -0.2, 0, rand(0.006, 0.012), rand(1, 2), _c);
            });
        }
      }
    }
    for (const pools of Object.values(this.frags)) for (const p of pools) p.wake();
    for (const p of Object.values(this.slabs)) p.wake();
  }

  /**
   * Chunks that lost their support come down as whole slabs, lowest first, each held in place for a beat so the
   * section visibly slumps; they shatter when they land hard. Past ~60 slabs the rest crumble as small debris.
   */
  collapse(chunks: number[], from: Vec3) {
    let minY = Infinity;
    for (const i of chunks) minY = Math.min(minY, this.world.chunks[i]?.min.y ?? Infinity);
    // The section leans away from where it was hit.
    let cxs = 0;
    let czs = 0;
    for (const i of chunks) {
      const c = this.world.chunks[i];
      cxs += (c.min.x + c.max.x) / 2;
      czs += (c.min.z + c.max.z) / 2;
    }
    cxs /= chunks.length;
    czs /= chunks.length;
    let lx = cxs - from.x;
    let lz = czs - from.z;
    const ll = Math.hypot(lx, lz) || 1;
    lx /= ll;
    lz /= ll;
    const rest: number[] = [];
    let puffs = 0;
    for (let k = 0; k < chunks.length; k++) {
      const c = this.world.chunks[chunks[k]];
      if (!c) continue;
      if (k >= 60) {
        rest.push(chunks[k]);
        continue;
      }
      const m = asDebris(c.mat);
      const sx = c.max.x - c.min.x;
      const sy = c.max.y - c.min.y;
      const sz = c.max.z - c.min.z;
      const cx = (c.min.x + c.max.x) / 2;
      const cy = (c.min.y + c.max.y) / 2;
      const cz = (c.min.z + c.max.z) / 2;
      const delay = 0.04 + (c.min.y - minY) * 0.07 + rand(0, 0.12);
      _c.set(MAT_LOOK[m].color).multiplyScalar(rand(0.85, 1.1));
      const push = rand(0.2, 0.9);
      this.slabs[m].spawn(cx, cy, cz, lx * push + rand(-0.15, 0.15), rand(-0.2, 0.3), lz * push + rand(-0.15, 0.15), sx * 0.97, sy * 0.97, sz * 0.97, _c, rand(16, 26), delay, 1.6, true);
      // Mortar dust shaken loose as it goes.
      if (puffs < 5 && k % Math.max(1, Math.floor(chunks.length / 5)) === 0) {
        puffs++;
        const L = MAT_LOOK[m];
        this.schedule(delay, () => {
          this.puff({ x: cx, y: cy, z: cz }, 0.6 + sy, L.dust * 0.7, rand(5, 8), 0.4);
          if (L.dust > 0.2) {
            _c.set(L.dustColor);
            this.smoke.spawn(cx, cy, cz, rand(-0.2, 0.2), -0.1, rand(-0.2, 0.2), 0.45, 0.7, rand(3, 5), 0.4 * L.dust, _c);
          }
          _c.set(L.grit);
          for (let i = 0; i < 6; i++) this.grit.spawn(cx + rand(-0.25, 0.25), cy, cz + rand(-0.25, 0.25), rand(-0.4, 0.4), rand(-0.5, 0.3), rand(-0.4, 0.4), rand(0.008, 0.02), rand(1.5, 3), _c);
        });
      }
    }
    if (rest.length) this.debris(rest.slice(0, 2), from, false);
    for (const pools of Object.values(this.frags)) for (const p of pools) p.wake();
  }

  explosion(p: Vec3) {
    this.flash({ x: p.x, y: p.y + 0.3, z: p.z }, 0xffa04a, 60, 0.35);
    // Fireball in waves: a white-hot core, then orange billows, then a dull red that turns to smoke.
    _c.setRGB(1, 0.92, 0.75).multiplyScalar(4);
    for (let i = 0; i < 4; i++) this.fire.spawn(p.x + rand(-0.15, 0.15), p.y + rand(0, 0.3), p.z + rand(-0.15, 0.15), rand(-0.5, 0.5), rand(0.5, 1.5), rand(-0.5, 0.5), 0.5, 7, rand(0.12, 0.2), 1, _c);
    this.schedule(0.04, () => {
      _c.setRGB(1, 0.62, 0.3).multiplyScalar(2.6);
      for (let i = 0; i < 7; i++) this.fire.spawn(p.x + rand(-0.5, 0.5), p.y + rand(0.1, 0.8), p.z + rand(-0.5, 0.5), rand(-1.2, 1.2), rand(1, 2.5), rand(-1.2, 1.2), 0.7, 4, rand(0.25, 0.4), 0.9, _c);
    });
    this.schedule(0.12, () => {
      _c.setRGB(0.9, 0.35, 0.12).multiplyScalar(1.6);
      for (let i = 0; i < 5; i++) this.fire.spawn(p.x + rand(-0.6, 0.6), p.y + rand(0.5, 1.3), p.z + rand(-0.6, 0.6), rand(-0.8, 0.8), rand(1.5, 2.5), rand(-0.8, 0.8), 0.9, 2, rand(0.35, 0.55), 0.6, _c);
    });
    // Sparks and burning embers.
    for (let i = 0; i < 60; i++) {
      const s = rand(4, 16);
      const th = rand(0, 6.28);
      const up = rand(-0.1, 1);
      _c.setRGB(1, rand(0.45, 0.7), rand(0.1, 0.25)).multiplyScalar(2.6);
      this.sparks.spawn(p.x, p.y + 0.1, p.z, Math.cos(th) * s * (1 - up * 0.5), up * s, Math.sin(th) * s * (1 - up * 0.5), rand(0.01, 0.025), rand(0.3, 1.1), _c);
    }
    for (let i = 0; i < 36; i++) {
      const s = rand(2, 8);
      const th = rand(0, 6.28);
      const up = rand(0.2, 1);
      _c.setRGB(1, rand(0.35, 0.6), 0.1).multiplyScalar(rand(2, 3.5));
      this.embers.spawn(p.x, p.y + 0.2, p.z, Math.cos(th) * s * (1 - up * 0.4), up * s, Math.sin(th) * s * (1 - up * 0.4), rand(0.012, 0.026), rand(1.5, 3.5), _c);
    }
    // Dark, slow, rising smoke that hangs around, then a column fed for several seconds.
    _c.setRGB(0.16, 0.15, 0.14);
    for (let i = 0; i < 12; i++) this.smoke.spawn(p.x + rand(-0.6, 0.6), p.y + rand(0, 0.8), p.z + rand(-0.6, 0.6), rand(-0.6, 0.6), rand(0.2, 0.7), rand(-0.6, 0.6), 0.8, 0.9, rand(6, 11), 0.7, _c);
    for (let i = 0; i < 5; i++) this.puff({ x: p.x + rand(-1, 1), y: p.y + rand(0.2, 1.4), z: p.z + rand(-1, 1) }, rand(1.4, 2.4), 1, rand(8, 14), 0.7);
    const drift = { x: rand(-0.25, 0.25), z: rand(-0.25, 0.25) };
    for (let t = 1; t <= 10; t++)
      this.schedule(t * 0.45, () => {
        const h = 0.6 + t * 0.35;
        this.puff({ x: p.x + drift.x * t, y: p.y + h, z: p.z + drift.z * t }, 0.9 + t * 0.12, Math.max(0.3, 0.9 - t * 0.06), rand(6, 10), 0.5);
        _c.setRGB(0.14, 0.13, 0.12);
        this.smoke.spawn(p.x + drift.x * t + rand(-0.2, 0.2), p.y + h * 0.6, p.z + drift.z * t + rand(-0.2, 0.2), drift.x, rand(0.35, 0.6), drift.z, 0.6, 0.5, rand(5, 8), 0.5, _c);
      });
    // Shockwave: a ring racing out along the floor, and dust kicked up behind it.
    this.ring(p, 7, 0.55);
    _c.setRGB(0.42, 0.4, 0.37);
    for (let i = 0; i < 14; i++) {
      const th = (i / 14) * 6.28 + rand(-0.1, 0.1);
      this.smoke.spawn(p.x + Math.cos(th) * 0.3, 0.15, p.z + Math.sin(th) * 0.3, Math.cos(th) * 5, 0.1, Math.sin(th) * 5, 0.5, 1.2, rand(2, 3.5), 0.45, _c);
    }
    _c.set(0x4a3a2a);
    for (let i = 0; i < 40; i++) {
      const s = rand(2, 9);
      const th = rand(0, 6.28);
      this.grit.spawn(p.x, p.y + 0.1, p.z, Math.cos(th) * s, rand(1, 6), Math.sin(th) * s, rand(0.015, 0.04), rand(1.5, 3.5), _c);
    }
    // Scorch on the floor (and on a wall when it went off against one).
    if (p.y < 1.4) this.decals.add({ x: p.x, y: 0, z: p.z }, { x: 0, y: 1, z: 0 }, rand(2.6, 3.4), D.scorch, _c.set(1, 1, 1), -1, 0.95);
    for (const d of EXPLOSION_DIRS) {
      const hit = raycast(this.world, p, d, 1.6);
      if (hit && hit.chunk >= -1) {
        this.decals.add({ x: p.x + d.x * hit.t, y: p.y, z: p.z + d.z * hit.t }, hit.n, rand(1.6, 2.4), D.scorch, _c.set(1, 1, 1), hit.chunk, 0.85);
        break;
      }
    }
    // Near a window: boards and glass blow out.
    for (const w of this.world.windows) {
      const d = Math.hypot(w.center.x - p.x, w.center.z - p.z);
      if (d > 3) continue;
      const along = w.out.x === 0 ? { x: 1, z: 0 } : { x: 0, z: 1 };
      const away = { x: w.center.x - p.x, z: w.center.z - p.z };
      const al = Math.hypot(away.x, away.z) || 1;
      for (let i = 0; i < 3; i++) {
        const s = rand(3, 7) * (1 - d / 3.5);
        _c.setRGB(rand(0.75, 1), rand(0.7, 0.95), rand(0.7, 0.9));
        const rotAlong = Math.abs(along.x) > 0;
        this.planks.spawn(w.center.x + along.x * rand(-0.6, 0.6), w.center.y + rand(0.3, 1.3), w.center.z + along.z * rand(-0.6, 0.6), (away.x / al) * s, rand(1, 3), (away.z / al) * s, rotAlong ? rand(0.5, 1.2) : 0.035, 0.17, rotAlong ? 0.035 : rand(0.5, 1.2), _c, rand(16, 24));
      }
      _c.setRGB(0.6, 0.72, 0.78);
      for (let i = 0; i < 8; i++) {
        const s = rand(2, 6);
        this.frags.metal[0].spawn(w.center.x + along.x * rand(-0.7, 0.7), w.center.y + rand(0.2, 1.4), w.center.z + along.z * rand(-0.7, 0.7), (away.x / al) * s + rand(-1, 1), rand(0.5, 2.5), (away.z / al) * s + rand(-1, 1), rand(0.04, 0.09), 0.006, rand(0.04, 0.09), _c, rand(10, 16));
      }
    }
  }

  gib(p: Vec3, dir: Vec3) {
    const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const dx = dir.x / dl;
    const dz = dir.z / dl;
    const pool = this.frags.gore[0];
    for (let i = 0; i < 5; i++) {
      const s = rand(2, 5);
      _c.setRGB(rand(0.75, 1.1), rand(0.7, 0.9), rand(0.7, 0.9));
      const big = i === 0;
      pool.spawn(p.x, p.y, p.z, (dx + rand(-0.6, 0.6)) * s, rand(1.5, 4), (dz + rand(-0.6, 0.6)) * s, big ? rand(0.12, 0.18) : rand(0.04, 0.09), big ? rand(0.1, 0.16) : rand(0.04, 0.08), big ? rand(0.12, 0.2) : rand(0.04, 0.09), _c, rand(16, 24));
    }
    this.blood(p, { x: dx, y: 0.6, z: dz }, 1.6);
    // Pumping from the stump for a moment.
    for (let t = 1; t <= 4; t++) this.schedule(t * 0.18, () => this.blood(p, { x: dx * 0.3, y: 1, z: dz * 0.3 }, 0.35));
    const i = this.decals.add({ x: p.x + dx * 0.6, y: 0, z: p.z + dz * 0.6 }, { x: 0, y: 1, z: 0 }, rand(0.4, 0.6), D.blood, _c.set(1, 1, 1), -1, 0.95);
    this.decals.grow(i, rand(0.8, 1.1), 4);
  }

  rise(p: Vec3) {
    const pool = this.frags.dirt[0];
    for (let i = 0; i < 9; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.6, 2.2);
      _c.setRGB(rand(0.8, 1.2), rand(0.8, 1.2), rand(0.8, 1.2));
      pool.spawn(p.x + Math.cos(th) * 0.25, 0.05, p.z + Math.sin(th) * 0.25, Math.cos(th) * s, rand(1.5, 3.5), Math.sin(th) * s, rand(0.06, 0.14), rand(0.05, 0.1), rand(0.06, 0.14), _c, rand(10, 16));
    }
    _c.set(0x3a3026);
    for (let i = 0; i < 24; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.5, 2.5);
      this.grit.spawn(p.x, 0.05, p.z, Math.cos(th) * s, rand(1, 4), Math.sin(th) * s, rand(0.012, 0.03), rand(1, 2.5), _c);
    }
    _c.setRGB(0.3, 0.27, 0.23);
    for (let i = 0; i < 3; i++) this.smoke.spawn(p.x + rand(-0.3, 0.3), 0.25, p.z + rand(-0.3, 0.3), rand(-0.3, 0.3), 0.2, rand(-0.3, 0.3), 0.45, 0.5, rand(2, 3.5), 0.45, _c);
    this.puff({ x: p.x, y: 0.4, z: p.z }, 0.8, 0.8, 4, 0.4);
    this.decals.add({ x: p.x, y: 0, z: p.z }, { x: 0, y: 1, z: 0 }, rand(0.9, 1.3), D.scorch, _c.setRGB(0.5, 0.4, 0.3), -1, 0.7);
  }

  board(window: number, tear: boolean) {
    const w = this.world.windows[window];
    if (!w) return;
    const along = w.out.x === 0 ? { x: 1, z: 0 } : { x: 0, z: 1 };
    // Boards are nailed across the inside face of the opening.
    const face = { x: w.center.x - w.out.x * 0.3, z: w.center.z - w.out.z * 0.3 };
    const y = w.center.y + rand(0.15, 1.35);
    if (tear) {
      // Ripped outwards by the zombie: spins off into the yard and clatters to the ground.
      const s = rand(2, 3.5);
      _c.setRGB(rand(0.85, 1.1), rand(0.85, 1.05), rand(0.85, 1));
      const rotAlong = Math.abs(along.x) > 0;
      this.planks.spawn(face.x, y, face.z, w.out.x * s + rand(-0.5, 0.5), rand(1, 2.5), w.out.z * s + rand(-0.5, 0.5), rotAlong ? 1.4 : 0.035, 0.17, rotAlong ? 0.035 : 1.4, _c, rand(18, 26));
      _c.set(MAT_LOOK.wood.chips);
      for (let i = 0; i < 10; i++) {
        const s2 = rand(1, 3);
        this.grit.spawn(face.x + along.x * rand(-0.7, 0.7), y, face.z + along.z * rand(-0.7, 0.7), w.out.x * s2 + rand(-1, 1), rand(0, 2), w.out.z * s2 + rand(-1, 1), rand(0.01, 0.025), rand(1, 2), _c);
      }
      // A couple of splinters and a bent nail.
      for (let i = 0; i < 2; i++) {
        _c.set(MAT_LOOK.wood.chips);
        this.frags.wood[0].spawn(face.x + along.x * rand(-0.6, 0.6), y, face.z + along.z * rand(-0.6, 0.6), w.out.x * rand(1, 3) + rand(-1, 1), rand(0.5, 2), w.out.z * rand(1, 3) + rand(-1, 1), 0.012, 0.01, rand(0.08, 0.16), _c, rand(10, 16));
      }
      this.puff({ x: face.x, y, z: face.z }, 0.35, 0.3, 2, 0.4);
    } else {
      // Slammed on and hammered: a puff of dust and a few splinters falling inside.
      _c.set(0x8a7a66);
      for (let i = 0; i < 3; i++) this.smoke.spawn(face.x + along.x * rand(-0.6, 0.6), y, face.z + along.z * rand(-0.6, 0.6), -w.out.x * 0.3, 0.05, -w.out.z * 0.3, 0.25, 0.4, rand(1.2, 2), 0.35, _c);
      _c.set(MAT_LOOK.wood.grit);
      for (let i = 0; i < 6; i++) this.grit.spawn(face.x + along.x * rand(-0.6, 0.6), y, face.z + along.z * rand(-0.6, 0.6), -w.out.x * rand(0.2, 1), rand(0, 1), -w.out.z * rand(0.2, 1), rand(0.008, 0.02), rand(1, 2), _c);
      this.puff({ x: face.x - w.out.x * 0.2, y, z: face.z - w.out.z * 0.2 }, 0.3, 0.35, 1.8, 0.3);
    }
  }

  chunkBroken(i: number) {
    this.decals.removeChunk(i);
    for (const pools of Object.values(this.frags)) for (const p of pools) p.wake();
    for (const p of Object.values(this.slabs)) p.wake();
    this.planks.wake();
    this.casings.wake();
  }

  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    camera.getWorldQuaternion(this.camQ);
    for (const s of this.later)
      if (s.fn && this.time >= s.at) {
        const fn = s.fn;
        s.fn = null;
        fn();
      }
    for (const pools of Object.values(this.frags)) for (const p of pools) p.update(dt);
    for (const p of Object.values(this.slabs)) p.update(dt);
    this.planks.update(dt);
    this.casings.update(dt);
    this.grit.update(dt);
    this.sparks.update(dt);
    this.embers.update(dt);
    this.drops.update(dt);
    this.smoke.update(dt, this.camQ);
    this.fire.update(dt, this.camQ);
    this.tracers.update(dt);
    this.decals.update(dt);
    for (const r of this.rings) {
      if (r.age >= r.life) continue;
      r.age += dt;
      const t = Math.min(1, r.age / r.life);
      const k = 1 - (1 - t) * (1 - t);
      r.mesh.scale.setScalar(0.4 + r.size * k);
      r.mat.opacity = 0.55 * (1 - t) * (1 - t);
      if (t >= 1) r.mesh.visible = false;
    }
    for (const m of this.muzzles) {
      if (m.left <= 0) continue;
      m.left -= dt;
      if (m.left <= 0) m.mesh.visible = false;
    }
    for (const f of this.flashPool) {
      if (!f.live) continue;
      f.age += dt;
      if (f.age >= f.life) {
        f.live = false;
        f.follow = null;
        continue;
      }
      const k = 1 - f.age / f.life;
      f.intensity = f.peak * k * k;
      if (f.follow) {
        f.follow.getWorldPosition(_p);
        f.pos.x = _p.x;
        f.pos.y = _p.y;
        f.pos.z = _p.z;
      }
    }
  }

  flashes(): FrameParams['flashes'] {
    const out = this.flashOut;
    out.length = 0;
    for (const f of this.flashPool) if (f.live) out.push(f);
    return out;
  }

  dispose() {
    for (const m of this.muzzles) m.mesh.removeFromParent();
    this.root.removeFromParent();
    for (const pools of Object.values(this.frags)) for (const p of pools) p.mesh.dispose();
    for (const p of Object.values(this.slabs)) p.mesh.dispose();
    for (const x of [this.planks, this.casings, this.grit, this.sparks, this.embers, this.drops, this.smoke, this.fire, this.decals, this.tracers]) {
      x.mesh.geometry.dispose();
      x.mesh.dispose();
    }
    for (const d of this.disposables) d.dispose();
  }

  /** Lab aid: empties every pool. */
  clearAll() {
    for (const pools of Object.values(this.frags)) for (const p of pools) p.clear();
    for (const p of Object.values(this.slabs)) p.clear();
    this.planks.clear();
    this.casings.clear();
    this.grit.clear();
    this.sparks.clear();
    this.embers.clear();
    this.drops.clear();
    this.smoke.clear();
    this.fire.clear();
    this.piles.clear();
    for (const s of this.later) s.fn = null;
  }
}

const EXPLOSION_DIRS = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

/** Muzzle flash layout per weapon kind: star size, forward flame length and width, side-vent length (0: none). */
const MUZZLE: Record<WeaponKind, { star: number; flame: number; width: number; vent: number }> = {
  pistol: { star: 0.13, flame: 0.12, width: 0.07, vent: 0 },
  smg: { star: 0.15, flame: 0.2, width: 0.08, vent: 0 },
  rifle: { star: 0.17, flame: 0.42, width: 0.11, vent: 0 },
  lmg: { star: 0.2, flame: 0.5, width: 0.13, vent: 0 },
  shotgun: { star: 0.34, flame: 0.4, width: 0.32, vent: 0 },
  sniper: { star: 0.22, flame: 0.3, width: 0.12, vent: 0.38 },
};

export const createFx: CreateFx = (scene, world, pipeline) => new Effects(scene, world, pipeline);

/** Lab/test hook: the concrete class (clearAll). */
export type EffectsImpl = Effects;
