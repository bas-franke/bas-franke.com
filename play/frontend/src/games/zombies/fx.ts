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
import { ATLAS_COLS, ATLAS_ROWS, D, decalAtlas } from './holes';
import { HOLE_INFO, type HoleKind } from './holes';
import type { Mat } from '@shared/zombies/maps';
import { bentGeometry, ChunkParts, clumpGeometry, cushionGeometry, leafGeometry, LOOK, potShardGeometry, scrapGeometry, sliverGeometry, springGeometry, type Theme } from './wreck';
import { faceAB, faceNormal, facePoint, STONE_TINT, type Stone, type Tile, TILE_HITS, TileDamage, tilePieceGeometry, tilePieceMaterial } from './tiles';

const GRAVITY = 14;
/** Thickness of a broken-off piece of tile (a 3 cm stone tile). */
const TILE_T = 0.03;

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
#elif ZFX_KIND == 7
  // Marble: white with thin grey veins wandering through it.
  float vein = abs(sin(q.x * 14.0 + q.y * 9.0 + q.z * 6.0 + sNoise(q * 5.0) * 7.0));
  diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(0.02, 0.16, vein)) * (0.95 + n1 * 0.08);
#elif ZFX_KIND == 8
  // Travertine: honey bands and small dark pores.
  diffuseColor.rgb *= 0.88 + sin(q.y * 40.0 + n2 * 4.0) * 0.06 + n1 * 0.1;
  diffuseColor.rgb *= sNoise(q * 90.0) > 0.82 ? 0.55 : 1.0;
#elif ZFX_KIND == 9
  // Glass, glazed clay: almost plain.
  diffuseColor.rgb *= 0.94 + n2 * 0.1;
#elif ZFX_KIND == 10
  // Upholstery: a fine woven texture.
  diffuseColor.rgb *= 0.85 + (sin(q.x * 400.0) * sin(q.z * 400.0 + q.y * 400.0)) * 0.06 + n1 * 0.12;
#elif ZFX_KIND == 11
  // Leather: creased and worn paler in patches.
  diffuseColor.rgb *= 0.85 + n1 * 0.2 + smoothstep(0.6, 0.8, n2) * 0.25;
  sRough = (n1 - 0.5) * 0.2;
#elif ZFX_KIND == 12
  // Brass: polished with dark tarnish in patches.
  diffuseColor.rgb *= mix(1.05, 0.55, smoothstep(0.55, 0.8, n2 * 0.8 + n1 * 0.3));
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
  /** Angle settled pieces snap to: a quarter turn for blocks, half a turn for flat pieces (face up or face down). */
  restStep = Math.PI / 2;

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
    this.mesh.visible = true;
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

  /** Sets a piece's orientation (tile pieces start flat against the face they came off). */
  setRot(i: number, x: number, y: number, z: number) {
    this.rot[i * 3] = x;
    this.rot[i * 3 + 1] = y;
    this.rot[i * 3 + 2] = z;
    if (this.state[i] === 3) {
      this.write(i, 1);
      this.mesh.instanceMatrix.needsUpdate = true;
    }
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
    // An idle pool costs no draw call (most materials' pools are idle most of the time).
    this.mesh.visible = this.active > 0;
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
              rot[i3] = Math.round(rot[i3] / this.restStep) * this.restStep;
              rot[i3 + 2] = Math.round(rot[i3 + 2] / this.restStep) * this.restStep;
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
    /** `sway`: side-to-side drift (stuffing, fluff); `twinkle`: alpha glints on and off (glass glitter). */
    private readonly opts: { stretch: number; drag: number; bounce: number; fade: boolean; gravity: number; onLand?: Landed; sway?: number; twinkle?: boolean },
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
      if (opts.sway && pos[i3 + 1] > size[i]) {
        vel[i3] += Math.cos(age[i] * 2.7 + i * 1.3) * opts.sway * dt;
        vel[i3 + 2] += Math.sin(age[i] * 2.1 + i * 2.9) * opts.sway * dt;
      }
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
      if (this.alpha) this.alpha.array[i] = opts.twinkle ? k * (0.25 + 0.75 * Math.pow(Math.abs(Math.sin(age[i] * (9 + (i % 7) * 3) + i)), 6)) : k * k;
      this.dirty = true;
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.alpha) this.alpha.needsUpdate = true;
      this.dirty = false;
    }
  }
}

/**
 * Flat cards that flutter down: leaves, torn cloth and paper, lacquer flakes. Strong air drag holds them to a slow
 * fall, they rock and sway from side to side as they go, and land flat on the floor or on whatever stands below.
 */
class FlutterPool {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly size: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  /** 0 free, 1 falling, 2 resting. */
  private readonly state: Uint8Array;
  private active = 0;
  private dirty = false;

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    private readonly n: number,
    private readonly world: World,
    private readonly piles: Piles,
    /** Air drag per second, sideways sway and rocking. */
    private readonly drag = 3.2,
    private readonly sway = 2.2,
  ) {
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.setColorAt(0, _c.set(1, 1, 1));
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.rot = new Float32Array(n * 3);
    this.spin = new Float32Array(n * 3);
    this.size = new Float32Array(n * 2);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.state = new Uint8Array(n);
  }

  spawn(px: number, py: number, pz: number, vx: number, vy: number, vz: number, w: number, len: number, tint: THREE.Color, life: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    if (!this.state[i]) this.active++;
    this.mesh.visible = true;
    const i3 = i * 3;
    this.pos[i3] = px;
    this.pos[i3 + 1] = py;
    this.pos[i3 + 2] = pz;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.rot[i3] = rand(-1.2, 1.2);
    this.rot[i3 + 1] = rand(0, 6.28);
    this.rot[i3 + 2] = rand(-1.2, 1.2);
    this.spin[i3] = rand(-5, 5);
    this.spin[i3 + 1] = rand(-3, 3);
    this.spin[i3 + 2] = rand(-5, 5);
    this.size[i * 2] = w;
    this.size[i * 2 + 1] = len;
    this.age[i] = 0;
    this.life[i] = life;
    this.state[i] = 1;
    this.mesh.setColorAt(i, tint);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Something below may have gone: cards resting above the floor fall again. */
  wake() {
    for (let i = 0; i < this.n; i++) if (this.state[i] === 2 && this.pos[i * 3 + 1] > 0.05) this.state[i] = 1;
  }

  clear() {
    this.state.fill(0);
    this.active = 0;
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    this.mesh.visible = this.active > 0;
    if (!this.active) return;
    const { pos, vel, rot, spin, size, age, life, state } = this;
    const drag = Math.max(0, 1 - this.drag * dt);
    for (let i = 0; i < this.n; i++) {
      const st = state[i];
      if (!st) continue;
      age[i] += dt;
      const left = life[i] - age[i];
      if (left <= 0) {
        state[i] = 0;
        this.active--;
        this.mesh.setMatrixAt(i, ZERO);
        this.dirty = true;
        continue;
      }
      const i3 = i * 3;
      const fading = left < 1;
      if (st === 2 && !fading) continue;
      if (st === 1) {
        vel[i3 + 1] -= GRAVITY * dt;
        vel[i3] *= drag;
        vel[i3 + 1] *= drag;
        vel[i3 + 2] *= drag;
        // Side-to-side: a card falls in swoops, faster the flatter it lies.
        const ph = age[i] * 3.4 + i * 1.7;
        vel[i3] += Math.cos(ph) * this.sway * dt * 2;
        vel[i3 + 2] += Math.sin(ph * 0.8 + i) * this.sway * dt * 2;
        const oy = pos[i3 + 1];
        pos[i3] += vel[i3] * dt;
        pos[i3 + 1] += vel[i3 + 1] * dt;
        pos[i3 + 2] += vel[i3 + 2] * dt;
        rot[i3] = Math.sin(ph) * 0.7 + spin[i3] * 0.05;
        rot[i3 + 1] += spin[i3 + 1] * dt;
        rot[i3 + 2] = Math.cos(ph * 0.9) * 0.6 + spin[i3 + 2] * 0.05;
        let ground = this.piles.get(pos[i3], pos[i3 + 2]) + 0.004 + (i % 9) * 0.0006;
        if (oy > 0.15 && pos[i3 + 1] > ground) {
          _box.min.x = pos[i3] - 0.01;
          _box.min.y = pos[i3 + 1] - 0.01;
          _box.min.z = pos[i3 + 2] - 0.01;
          _box.max.x = pos[i3] + 0.01;
          _box.max.y = pos[i3 + 1] + 0.01;
          _box.max.z = pos[i3 + 2] + 0.01;
          const hit = firstBlock(this.world, _box, 'nade');
          if (hit) {
            if (oy >= hit.max.y - 0.04 && vel[i3 + 1] <= 0) ground = hit.max.y + 0.004;
            else {
              pos[i3] -= vel[i3] * dt;
              pos[i3 + 2] -= vel[i3 + 2] * dt;
              vel[i3] *= -0.3;
              vel[i3 + 2] *= -0.3;
            }
          }
        }
        if (pos[i3 + 1] <= ground) {
          pos[i3 + 1] = ground;
          rot[i3] = (i & 1) * Math.PI;
          rot[i3 + 2] = 0;
          state[i] = 2;
        }
      }
      const k = fading ? Math.max(0.001, left) : 1;
      _p.set(pos[i3], pos[i3 + 1], pos[i3 + 2]);
      _q.setFromEuler(_e.set(rot[i3], rot[i3 + 1], rot[i3 + 2]));
      _s.set(size[i * 2] * k, size[i * 2] * k, size[i * 2 + 1] * k);
      this.mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
      this.dirty = true;
    }
    if (this.dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
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

const _al = new THREE.Vector3();

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

  /** `along`: lay the decal's stretched axis along this direction (a graze runs the way the bullet went). */
  add(p: Vec3, n: Vec3, size: number, cell: number, tint: THREE.Color, chunk: number, alpha = 1, stretch = 1, along?: Vec3) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    _v.set(n.x, n.y, n.z).normalize();
    // Float just off the surface; floor decals stacked by age so overlapping splats never fight.
    _p.set(p.x + _v.x * 0.004, p.y + _v.y * (0.004 + (i % 7) * 0.0004), p.z + _v.z * 0.004);
    _q.setFromUnitVectors(_z, _v);
    let ang = rand(0, 6.28);
    if (along) {
      // The direction in the decal's own plane, then the turn that brings local +y onto it.
      _al.set(along.x, along.y, along.z).applyQuaternion(_q2.copy(_q).invert());
      if (_al.x * _al.x + _al.y * _al.y > 1e-6) ang = Math.atan2(-_al.x, _al.y);
    }
    _q.multiply(_q2.setFromAxisAngle(_z, ang));
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

// The table and the shapes live in wreck.ts; every material has its own fragments and slabs now.
type Debris = Mat;
const MAT_LOOK = LOOK;
const MATS = Object.keys(LOOK) as Mat[];

/** Hole cells that are drawn neutral and take the surface colour; upholstery is lerped towards white (holes.ts). */
const holeTint = (m: Mat, cell: HoleKind, out: THREE.Color) => {
  if (!HOLE_INFO[cell].tinted) return out.set(1, 1, 1);
  out.set(LOOK[m].surface);
  if (m === 'fabric' || m === 'leather') out.lerp(_white, 0.3);
  return out;
};
const _white = new THREE.Color(1, 1, 1);
/** Wet patches: the neutral dust cell tinted dark and cool. */
const WET = 0x30383c;

/** Materials that crack around a cluster of holes. */
/** Fragments of the classic five are tinted by their colour on top of it (their tuned look); the rest are not. */
const CLASSIC_TINT: Partial<Record<Mat, 1>> = { brick: 1, plaster: 1, concrete: 1, wood: 1, metal: 1 };

/** Grit chips per bullet impact. */
const IMPACT_CHIPS: Record<Mat, number> = { brick: 6, plaster: 4, concrete: 6, wood: 6, metal: 2, marble: 6, travertine: 6, walnut: 4, glass: 0, fabric: 0, leather: 3, ceramic: 4, brass: 1, foliage: 0 };
const CRACKS: Partial<Record<Mat, number>> = { glass: 1, marble: 1, travertine: 1, concrete: 1, ceramic: 1, plaster: 0.6, brick: 0.4 };

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
  /** Furniture wreckage (wreck.ts): walnut planks, sofa springs, flutter cards (leaves, scraps), stuffing, glitter, water. */
  private readonly walnutPlanks: FragmentPool;
  private readonly springs: FragmentPool;
  private readonly leaves: FlutterPool;
  private readonly scraps: FlutterPool;
  private readonly fluff: ParticlePool;
  private readonly glitter: ParticlePool;
  private readonly water: ParticlePool;
  private readonly parts: ChunkParts;
  /** The last few bullet holes, so a cluster on stone or glass cracks (x, y, z, chunk). */
  private readonly holes = new Float32Array(32 * 3);
  private readonly holeChunk = new Int32Array(32).fill(-9);
  private holeNext = 0;
  /** Puff budget of the current debris() call, shared by every theme. */
  private puffsLeft = 0;
  /** Chipped and cracked tiles on the marble floor and the travertine columns (tiles.ts). */
  private readonly tiles: TileDamage;
  /** Tile chips and broken-off pieces of tile, per stone. They never fade: a fought-over lobby keeps its litter. */
  private readonly tileChips: Record<Stone, FragmentPool[]>;
  private readonly tilePieces: Record<Stone, FragmentPool[]>;
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
    for (const m of MATS) mats[m] = fragMat(look(m).color, look(m).rough, look(m).metal, look(m).surf);
    // Glass: clear, glossy, faintly lit from inside so a shard still reads in the dark; no shadows from it.
    mats.glass = own(
      surfaced(
        new THREE.MeshStandardMaterial({ color: 0xd8eef2, roughness: 0.03, metalness: 0.25, transparent: true, opacity: 0.55, depthWrite: false, emissive: 0x22333a, flatShading: true }),
        9,
      ),
    );
    // Pot shards carry glaze and clay in their vertex colours.
    mats.ceramic = own(surfaced(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1, vertexColors: true, flatShading: true }), 9));
    this.frags = {
      brick: make([brickGeometry(1), rockGeometry(2)], mats.brick, 90),
      plaster: make([shardGeometry(3, 0.16), rockGeometry(4, 0, 0.6)], mats.plaster, 90),
      concrete: make([rockGeometry(5), rockGeometry(6, 1)], mats.concrete, 90),
      wood: make([splinterGeometry(7), shardGeometry(8, 0.22)], mats.wood, 70),
      metal: make([shardGeometry(9, 0.06), shardGeometry(10, 0.1)], mats.metal, 48, 0.4),
      gore: make([rockGeometry(11, 1, 0.8)], own(surfaced(new THREE.MeshStandardMaterial({ color: 0x5a0c0a, roughness: 0.28, metalness: 0 }), SURFACE_KIND.flesh)), 48, 0.15),
      dirt: make([rockGeometry(12, 0, 0.8)], fragMat(0x2f271e, 0.98, 0, SURFACE_KIND.dirt), 60, 0.12),
      // Sharp-edged white chips and chunks; honey-coloured pitted lumps; dark lacquered splinters.
      marble: make([shardGeometry(13, 0.3), rockGeometry(14, 0, 0.7)], mats.marble, 70, 0.3),
      travertine: make([rockGeometry(15), rockGeometry(16, 0, 0.7)], mats.travertine, 60),
      walnut: make([splinterGeometry(17), shardGeometry(18, 0.2)], mats.walnut, 60),
      // Slivers: a lively, tinkling bounce, and they lie flat once they stop.
      glass: make([sliverGeometry(19), sliverGeometry(20, 0.5)], mats.glass, 130, 0.5),
      // Lumps of padding torn out with the cover on.
      fabric: make([rockGeometry(26, 1, 0.7)], mats.fabric, 40, 0.1),
      leather: make([rockGeometry(27, 1, 0.6)], mats.leather, 40, 0.12),
      ceramic: make([potShardGeometry(21), potShardGeometry(22)], mats.ceramic, 60, 0.32),
      brass: make([bentGeometry(23), bentGeometry(24)], mats.brass, 50, 0.45),
      // Broken branches and twigs.
      foliage: make([splinterGeometry(25)], fragMat(0x4a3622, 0.9, 0, SURFACE_KIND.wood), 60, 0.25),
    };
    for (const p of this.frags.glass) p.mesh.castShadow = false;
    for (const p of [...this.frags.glass, ...this.frags.ceramic, ...this.frags.marble, ...this.frags.brass]) p.restStep = Math.PI;
    for (const p of this.frags.glass) p.onImpact = (_i, x, y, z, speed, size) => this.tinkle(x, y, z, speed, size);
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
    // Per material: how a whole falling piece is shaped and how many can be in the air (cushions are soft and
    // bulge, canopy pieces are leafy clumps that burst when they land).
    const cushionGeo = own(cushionGeometry());
    const clumpGeo = own(clumpGeometry(41));
    const slabShape: Partial<Record<Debris, [THREE.BufferGeometry, number, number]>> = {
      metal: [slabGeoFlat, 24, 0.12],
      fabric: [cushionGeo, 28, 0.08],
      leather: [cushionGeo, 20, 0.1],
      foliage: [clumpGeo, 24, 0.05],
      glass: [slabGeoFlat, 24, 0.1],
      ceramic: [slabGeoFlat, 16, 0.1],
      brass: [slabGeoFlat, 24, 0.3],
      walnut: [slabGeoFlat, 24, 0.2],
      marble: [slabGeoFlat, 32, 0.1],
      travertine: [slabGeoFlat, 32, 0.12],
    };
    this.slabs = {} as Record<Debris, FragmentPool>;
    for (const m of MATS) {
      const [geo, n, bounce] = slabShape[m] ?? [slabGeoFlat, 48, 0.12];
      const pool = new FragmentPool(geo, m === 'foliage' ? own(fragMat(0x34501f, 0.8, 0, 6)) : mats[m], n, world, this.piles, bounce, 0.4, 12);
      pool.onImpact = (_i, x, y, z, speed, size) => this.shatter(m, x, y, z, speed, size);
      if (m === 'glass') pool.mesh.castShadow = false;
      this.slabMat.set(pool, m);
      this.root.add(pool.mesh);
      this.slabs[m] = pool;
    }
    this.walnutPlanks = new FragmentPool(own(new THREE.BoxGeometry(1, 1, 1, 4, 1, 1)), mats.walnut, 24, world, this.piles, 0.28);
    this.springs = new FragmentPool(own(springGeometry()), own(new THREE.MeshStandardMaterial({ color: 0x9a9da0, roughness: 0.35, metalness: 0.9 })), 16, world, this.piles, 0.55, 0.7, 4);
    this.springs.snapRest = false;
    this.root.add(this.walnutPlanks.mesh, this.springs.mesh);
    // Flutter cards: leaves and petals (double-sided, a little translucent-looking with emissive), scraps of cloth,
    // paper and lacquer.
    const leafMat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, side: THREE.DoubleSide, emissive: 0x0a1004 }));
    this.leaves = new FlutterPool(own(leafGeometry(51)), leafMat, 260, world, this.piles, 3.4, 2.4);
    const scrapMat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide }));
    this.scraps = new FlutterPool(own(scrapGeometry(52)), scrapMat, 180, world, this.piles, 2.6, 1.8);
    this.root.add(this.leaves.mesh, this.scraps.mesh);
    this.parts = new ChunkParts(world);
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

    this.tiles = new TileDamage(world, this.root);
    this.tileChips = {} as Record<Stone, FragmentPool[]>;
    this.tilePieces = {} as Record<Stone, FragmentPool[]>;
    for (const stone of ['marble', 'travertine'] as const) {
      const mat = own(tilePieceMaterial(stone));
      const seed = stone === 'marble' ? 31 : 37;
      // Thin flat chips: a low bounce and a long skid on the polished stone before they stop, face up or face down.
      this.tileChips[stone] = [0, 1].map((k) => {
        const pool = new FragmentPool(own(tilePieceGeometry(seed + k * 3, 5 + k, 1)), mat, 160, world, this.piles, 0.22, 0.88, 2.4);
        pool.restStep = Math.PI;
        this.root.add(pool.mesh);
        return pool;
      });
      // Pieces of a whole tile: squarish, they slap down flat and break up when they fall from any height.
      this.tilePieces[stone] = [4, 5, 7].map((sides, k) => {
        const big = new FragmentPool(own(tilePieceGeometry(seed + 20 + k * 5, sides, 0.2)), mat, 40, world, this.piles, 0.14, 0.55, 5);
        big.restStep = Math.PI;
        big.onImpact = (_i, x, y, z, speed, size) => this.tileLand(stone, x, y, z, speed, size);
        this.root.add(big.mesh);
        return big;
      });
    }

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
    // Stuffing: soft tufts that drift down slowly, swaying, and shrink away on the floor.
    const fluffMat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }));
    this.fluff = new ParticlePool(own(rockGeometry(53, 1, 0.75)), fluffMat, 220, { stretch: 0, drag: 2.6, bounce: 0.05, fade: false, gravity: 2.4, sway: 1.6 });
    // Glitter: tiny glass glints that twinkle as they fall.
    this.glitter = new ParticlePool(own(new THREE.OctahedronGeometry(0.5)), sparkMat, 260, { stretch: 0.004, drag: 1.4, bounce: 0.3, fade: true, gravity: 8, twinkle: true });
    // Water from a vase: clear droplets; a share leaves a wet patch where it lands.
    this.water = new ParticlePool(own(new THREE.IcosahedronGeometry(0.5, 0)), own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.6 })), 140, {
      stretch: 0.025,
      drag: 0.3,
      bounce: 0,
      fade: false,
      gravity: GRAVITY,
      onLand: (x, _y, z) => {
        if (Math.random() < 0.18) this.decals.add({ x, y: 0, z }, { x: 0, y: 1, z: 0 }, rand(0.08, 0.22), D.dust, _c.set(WET), -1, 0.55);
      },
    });
    this.root.add(this.fluff.mesh, this.glitter.mesh, this.water.mesh);
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

  // ---- wreckage helpers (wreck.ts themes): every one spawns into preallocated pools only ---------------------------

  /** Sparks off steel or brass: a fan around (nx, ny, nz), brass ones golden. */
  private sparkBurst(x: number, y: number, z: number, nx: number, ny: number, nz: number, count: number, speed: number, brass: boolean) {
    for (let i = 0; i < count; i++) {
      const s = rand(0.3, 1) * speed;
      // A white-hot share, the rest cooling to orange (brass: yellow-gold).
      if (Math.random() < 0.3) _c.setRGB(1, 0.95, 0.8).multiplyScalar(6);
      else if (brass) _c.setRGB(1, rand(0.72, 0.9), rand(0.25, 0.4)).multiplyScalar(4.5);
      else _c.setRGB(1, rand(0.55, 0.85), rand(0.2, 0.4)).multiplyScalar(4.5);
      this.sparks.spawn(x, y, z, (nx + rand(-0.9, 0.9)) * s, (ny + rand(-0.3, 1)) * s, (nz + rand(-0.9, 0.9)) * s, rand(0.007, 0.015), rand(0.12, 0.45), _c);
    }
  }

  /** Tufts of stuffing (white wadding, or yellow foam for leather) bursting out and drifting down. */
  private stuffing(x: number, y: number, z: number, count: number, foam: boolean, power: number, nx = 0, nz = 0) {
    for (let i = 0; i < count; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.4, 1.6) * power;
      if (foam) _c.setRGB(rand(0.85, 0.95), rand(0.72, 0.82), rand(0.38, 0.5));
      else _c.setRGB(rand(0.92, 1), rand(0.9, 0.98), rand(0.84, 0.92));
      const sz = foam ? rand(0.015, 0.035) : rand(0.025, 0.06);
      this.fluff.spawn(x + rand(-0.05, 0.05), y + rand(-0.05, 0.05), z + rand(-0.05, 0.05), nx * s + Math.cos(th) * s * 0.6, rand(0.4, 1.4) * power, nz * s + Math.sin(th) * s * 0.6, sz, rand(4, 8), _c);
    }
  }

  /** Torn scraps of cloth, paper or lacquer: `color` with a little variation, `w0`..`w1` the size. */
  private scrapBurst(x: number, y: number, z: number, count: number, color: number, w0: number, w1: number, power: number, life = 14) {
    for (let i = 0; i < count; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.3, 1.4) * power;
      _c.set(color).multiplyScalar(rand(0.8, 1.1));
      const w = rand(w0, w1);
      this.scraps.spawn(x + rand(-0.1, 0.1), y + rand(-0.1, 0.1), z + rand(-0.1, 0.1), Math.cos(th) * s, rand(0.5, 2) * power, Math.sin(th) * s, w, w * rand(0.7, 1.4), _c, rand(life * 0.7, life * 1.3));
    }
  }

  /** Leaves (or white petals) shaken loose: they flutter down and stay on the floor a while. */
  private leafBurst(x: number, y: number, z: number, spread: number, count: number, flowers: boolean, power: number) {
    for (let i = 0; i < count; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.2, 1.2) * power;
      const petal = flowers && Math.random() < 0.65;
      if (petal) _c.setRGB(rand(0.92, 1), rand(0.9, 0.97), rand(0.85, 0.93));
      else if (Math.random() < 0.15) _c.setRGB(rand(0.45, 0.6), rand(0.4, 0.5), 0.12);
      else _c.setRGB(rand(0.16, 0.28), rand(0.3, 0.45), rand(0.08, 0.14));
      const w = petal ? rand(0.035, 0.06) : rand(0.05, 0.1);
      this.leaves.spawn(x + rand(-0.5, 0.5) * spread, y + rand(-0.4, 0.4) * spread, z + rand(-0.5, 0.5) * spread, Math.cos(th) * s, rand(0, 1.2) * power, Math.sin(th) * s, w, w * rand(1.3, 1.9), _c, rand(14, 24));
    }
  }

  /** Broken branches and twigs. */
  private branches(x: number, y: number, z: number, count: number, power: number) {
    for (let i = 0; i < count; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.4, 1.4) * power;
      _c.setRGB(rand(0.8, 1.15), rand(0.8, 1.1), rand(0.8, 1));
      const big = i === 0;
      this.frags.foliage[0].spawn(x, y, z, Math.cos(th) * s, rand(0.3, 1.5) * power, Math.sin(th) * s, big ? rand(0.025, 0.04) : rand(0.008, 0.016), big ? rand(0.02, 0.035) : rand(0.008, 0.014), big ? rand(0.25, 0.5) : rand(0.06, 0.16), _c, rand(14, 22));
    }
  }

  /** Glass: slivers flung out with (ax, az), plus a cascade of twinkling glitter. */
  private glassBurst(x: number, y: number, z: number, spread: number, count: number, ax: number, az: number, power: number) {
    for (let i = 0; i < count; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.3, 1.2) * power;
      _c.setRGB(rand(0.85, 1), rand(0.95, 1.05), rand(0.95, 1.05));
      const w = i < 3 ? rand(0.06, 0.13) : rand(0.02, 0.06);
      this.fragPool('glass').spawn(x + rand(-0.4, 0.4) * spread, y + rand(0, 0.3) * spread, z + rand(-0.4, 0.4) * spread, ax * s + Math.cos(th) * s * 0.7, rand(0.3, 1.8) * power, az * s + Math.sin(th) * s * 0.7, w, w * 0.08, w * rand(0.8, 1.4), _c, rand(16, 26));
    }
    this.glints(x, y, z, spread, Math.round(count * 1.6), power);
  }

  /** Twinkling glass glitter. */
  private glints(x: number, y: number, z: number, spread: number, count: number, power: number) {
    for (let i = 0; i < count; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.2, 1.4) * power;
      _c.setRGB(0.8, 0.92, 1).multiplyScalar(rand(1.5, 3.5));
      this.glitter.spawn(x + rand(-0.4, 0.4) * spread, y + rand(-0.2, 0.4) * spread, z + rand(-0.4, 0.4) * spread, Math.cos(th) * s, rand(-0.2, 1.5) * power, Math.sin(th) * s, rand(0.006, 0.014), rand(0.8, 2.2), _c);
    }
  }

  /** A glass sliver landed: it tinkles (glints off the floor) and a big one breaks into smaller ones. */
  private tinkle(x: number, y: number, z: number, speed: number, size: number): boolean {
    this.glints(x, y + 0.02, z, 0.05, 2, 0.6);
    if (speed < 3.5 || size < 0.07) return false;
    for (let i = 0; i < 3; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.4, 1.4);
      const w = size * rand(0.3, 0.5);
      _c.setRGB(rand(0.85, 1), 1, 1);
      this.fragPool('glass').spawn(x, y + 0.02, z, Math.cos(th) * s, rand(0.5, 1.6), Math.sin(th) * s, w, w * 0.08, w * rand(0.8, 1.3), _c, rand(14, 22));
    }
    return true;
  }

  /** Curved shards of a glazed pot (dark outside, clay inside), big ones first. */
  private potShards(x: number, y: number, z: number, spread: number, count: number, ax: number, az: number, power: number) {
    for (let i = 0; i < count; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.4, 1.3) * power;
      _c.setRGB(1, 1, 1).multiplyScalar(rand(0.85, 1.05));
      const w = i < 3 ? rand(0.12, 0.24) : rand(0.03, 0.08);
      this.fragPool('ceramic').spawn(x + rand(-0.3, 0.3) * spread, y + rand(-0.3, 0.3) * spread, z + rand(-0.3, 0.3) * spread, ax * s + Math.cos(th) * s * 0.7, rand(0.4, 2) * power, az * s + Math.sin(th) * s * 0.7, w, w * 0.3, w * rand(0.8, 1.2), _c, rand(16, 26));
    }
    _c.set(LOOK.ceramic.grit);
    for (let i = 0; i < 6; i++) this.grit.spawn(x, y, z, rand(-1.5, 1.5) * power, rand(0.2, 1.6), rand(-1.5, 1.5) * power, rand(0.008, 0.02), rand(1, 2.5), _c);
  }

  /** Potting soil: clods and crumbs pouring out, a dark spill on the floor and a cloud of earthy dust. */
  private soil(x: number, y: number, z: number, size: number, amount: number) {
    const pool = this.frags.dirt[0];
    const n = Math.round(4 + amount * 8);
    for (let i = 0; i < n; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.3, 1.6);
      _c.setRGB(rand(0.8, 1.2), rand(0.8, 1.15), rand(0.8, 1.1));
      const w = rand(0.03, 0.08);
      pool.spawn(x + rand(-0.2, 0.2), y + rand(0, 0.2), z + rand(-0.2, 0.2), Math.cos(th) * s, rand(0, 1.5), Math.sin(th) * s, w, w * 0.7, w, _c, rand(16, 26));
    }
    _c.set(0x3a2e22);
    for (let i = 0; i < Math.round(10 + amount * 14); i++) {
      const th = rand(0, 6.28);
      const s = rand(0.2, 2);
      this.grit.spawn(x + rand(-0.2, 0.2), y + rand(0, 0.3), z + rand(-0.2, 0.2), Math.cos(th) * s, rand(-0.3, 1.5), Math.sin(th) * s, rand(0.008, 0.022), rand(1.5, 3), _c);
    }
    _c.set(0x6a5a46);
    this.smoke.spawn(x, y + 0.2, z, rand(-0.2, 0.2), 0.1, rand(-0.2, 0.2), 0.3, 0.8, rand(2, 3.5), 0.4 * amount + 0.15, _c);
    this.decals.add({ x: x + rand(-0.15, 0.15), y: 0, z: z + rand(-0.15, 0.15) }, { x: 0, y: 1, z: 0 }, rand(0.4, 0.7) * (0.6 + size), D.dust, _c.set(0x2a2016), -1, 0.85);
    if (this.puffsLeft > 0) {
      this.puffsLeft--;
      this.puff({ x, y: y + 0.3, z }, 0.4 + size * 0.5, 0.35, rand(3, 5), 0.4);
    }
  }

  /** Dust cloud of a material: fog blob (budgeted per debris() call) plus sprites. */
  private dustOf(m: Debris, x: number, y: number, z: number, r: number, k = 1) {
    const L = MAT_LOOK[m];
    if (this.puffsLeft > 0 && L.dust > 0.05) {
      this.puffsLeft--;
      this.puff({ x, y, z }, r, L.dust * k, rand(4, 7), 0.5);
    }
    if (L.dust > 0.2) {
      _c.set(L.dustColor);
      for (let i = 0; i < 2; i++) this.smoke.spawn(x + rand(-0.15, 0.15), y + rand(-0.1, 0.15), z + rand(-0.15, 0.15), rand(-0.3, 0.3), rand(0, 0.25), rand(-0.3, 0.3), 0.3 * r + 0.15, 0.7, rand(2.5, 5), 0.5 * L.dust * k, _c);
    }
  }

  /**
   * A falling slab hit the ground hard: it breaks into rubble with a burst of dust. Each material lands its own way:
   * cushions and brass stay whole (a puff of stuffing, a clang of sparks), a leafy clump bursts into leaves, a pane
   * or a pot piece smashes into shards.
   */
  private shatter(m: Debris, x: number, y: number, z: number, speed: number, size: number): boolean {
    const L = MAT_LOOK[m];
    switch (m) {
      case 'fabric':
      case 'leather':
        if (speed > 4) this.stuffing(x, y + size * 0.3, z, 3, m === 'leather', 1);
        return false;
      case 'brass':
        if (speed > 3) this.sparkBurst(x, y + 0.05, z, 0, 1, 0, 6, 4, true);
        return false;
      case 'foliage':
        if (speed < 1.5) return false;
        this.leafBurst(x, y + size * 0.4, z, size, 6 + Math.round(size * 18), false, 1.2);
        this.branches(x, y + size * 0.3, z, 2, 1.5);
        return true;
      case 'glass':
        if (speed < 2) return false;
        this.glassBurst(x, y + 0.05, z, size, 6 + Math.round(size * 14), 0, 0, Math.min(2.5, speed * 0.4));
        return true;
      case 'ceramic':
        if (speed < 2.5) return false;
        this.potShards(x, y + size * 0.3, z, size, 3 + Math.round(size * 6), 0, 0, 1.6);
        this.soil(x, y, z, size, 0.6);
        return true;
    }
    // A gentle drop onto a pile keeps the slab whole; a real fall breaks it.
    const woody = m === 'wood' || m === 'walnut';
    if (speed < (m === 'metal' ? 6 : woody ? 4.5 : 3.2)) return false;
    const pieces = m === 'metal' ? 2 : 4 + Math.round(size * 6);
    for (let i = 0; i < pieces; i++) {
      const pool = this.fragPool(m);
      const th = rand(0, 6.28);
      const s = rand(0.6, 2.2) * Math.min(1.6, speed / 5);
      const f = woody ? 1 : rand(0.3, 0.55);
      _c.set(CLASSIC_TINT[m] ? L.color : 0xffffff).multiplyScalar(rand(0.75, 1.2));
      const fx = woody ? rand(0.05, 0.1) : size * f;
      const fz = woody ? rand(0.2, 0.45) : size * f * rand(0.6, 1.1);
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

  private tileChip(stone: Stone) {
    const pools = this.tileChips[stone];
    return pools[Math.floor(Math.random() * pools.length)];
  }

  /**
   * A piece of tile hit the ground: a puff of stone dust off the impact; a hard landing breaks it into a few big
   * pieces and some small ones, which stay.
   */
  private tileLand(stone: Stone, x: number, y: number, z: number, speed: number, size: number): boolean {
    const k = Math.min(1, speed / 6);
    _c.set(stone === 'marble' ? 0x8a8884 : 0xcabd9f);
    for (let i = 0; i < 4 + Math.round(k * 6); i++) {
      const th = rand(0, 6.28);
      this.grit.spawn(x, y + 0.03, z, Math.cos(th) * rand(0.6, 2.2) * k, rand(0.3, 1.4) * k, Math.sin(th) * rand(0.6, 2.2) * k, rand(0.008, 0.02), rand(1, 2), _c);
    }
    _c.set(0xb8b4ac);
    for (let i = 0; i < 2; i++) {
      const th = rand(0, 6.28);
      this.smoke.spawn(x + Math.cos(th) * size * 0.3, y + 0.06, z + Math.sin(th) * size * 0.3, Math.cos(th) * 0.5, 0.1, Math.sin(th) * 0.5, 0.1 + size * 0.25, 0.5 + k * 0.4, rand(1.4, 2.4), 0.35, _c);
    }
    if (speed < 4 || size < 0.12) return false;
    const pieces = 2 + Math.round(size * 5);
    for (let i = 0; i < pieces; i++) {
      const th = rand(0, 6.28);
      const s = rand(0.4, 1.6) * Math.min(1.5, speed / 6);
      const big = i < 2;
      const w = size * (big ? rand(0.4, 0.6) : rand(0.12, 0.25));
      _c.set(STONE_TINT[stone]).multiplyScalar(rand(0.85, 1.15));
      this.tileChip(stone).spawn(x + Math.cos(th) * size * 0.2, y + TILE_T, z + Math.sin(th) * size * 0.2, Math.cos(th) * s, rand(0.4, 1.4), Math.sin(th) * s, w, TILE_T * rand(big ? 0.85 : 0.5, 1), w * rand(0.6, 1.1), _c, 1e9, 0, 8);
    }
    this.puff({ x, y: y + 0.12, z }, 0.25 + size * 0.3, 0.45, 2.2, 0.5);
    return true;
  }

  /**
   * A bullet (or a blast) on tiled stone: a chip out of the tile down to its concrete bed, cracks, chips flying off;
   * the hit that makes TILE_HITS breaks the whole tile off in pieces and leaves the bed.
   */
  private tileHit(t: Tile, p: Vec3, add = 1) {
    const before = t.hits;
    const hits = this.tiles.hit(t, p, add);
    if (hits === before) return;
    const n = faceNormal(t);
    const floor = t.axis === 1;
    const ox = p.x + n.x * 0.015;
    const oy = p.y + n.y * 0.015;
    const oz = p.z + n.z * 0.015;
    const tint = STONE_TINT[t.stone];
    const chips = hits >= TILE_HITS ? 3 : Math.round(rand(3, 5));
    for (let i = 0; i < chips; i++) {
      const w = rand(0.022, 0.06);
      const th = rand(0.008, 0.014);
      _c.set(tint).multiplyScalar(rand(0.85, 1.2));
      // Off the floor chips skip low and far; off a column they spit out of the face and drop.
      if (floor) {
        const a = rand(0, 6.28);
        const s = rand(0.8, 3.2);
        this.tileChip(t.stone).spawn(ox, oy, oz, Math.cos(a) * s, rand(0.6, 2.4), Math.sin(a) * s, w, th, w * rand(0.6, 1.1), _c, 1e9, 0, 22);
      } else {
        const s = rand(1.2, 3.5);
        this.tileChip(t.stone).spawn(ox, oy, oz, (n.x + rand(-0.6, 0.6)) * s, rand(0, 1.6), (n.z + rand(-0.6, 0.6)) * s, w, th, w * rand(0.6, 1.1), _c, 1e9, 0, 22);
      }
    }
    // Stone dust: pale grit, a jet of powder out of the chip and a cloud that hangs.
    _c.set(t.stone === 'marble' ? 0x9a9792 : 0xd2c6aa);
    for (let i = 0; i < 10; i++) {
      const s = rand(1.2, 3.5);
      this.grit.spawn(ox, oy, oz, (n.x + rand(-0.7, 0.7)) * s, (n.y + rand(-0.2, 0.9)) * s, (n.z + rand(-0.7, 0.7)) * s, rand(0.008, 0.022), rand(0.8, 2), _c);
    }
    _c.setRGB(0.72, 0.7, 0.66);
    for (let i = 0; i < 3; i++) {
      const s = rand(0.6, 1.6);
      this.smoke.spawn(ox + n.x * 0.05, oy + n.y * 0.05, oz + n.z * 0.05, (n.x + rand(-0.4, 0.4)) * s, (n.y + rand(-0.1, 0.4)) * s + 0.12, (n.z + rand(-0.4, 0.4)) * s, 0.08, 0.7, rand(1, 1.8), 0.5, _c);
    }
    if (this.time - this.lastPuff > 0.02) {
      this.lastPuff = this.time;
      this.puff({ x: ox + n.x * 0.15, y: oy + n.y * 0.15, z: oz + n.z * 0.15 }, 0.22, 0.4, 1.8, 0.5);
    }
    if (hits < TILE_HITS) return;

    // The tile comes off: pieces on a rough grid of the tile, the ones by the impact first and fastest.
    const [pa, pb] = faceAB(t.axis, p);
    const w = t.a1 - t.a0;
    const h = t.b1 - t.b0;
    // Big pieces: a floor tile breaks in about four, a wall or column slab in two.
    const na = Math.max(1, Math.round(w / 0.6));
    const nb = Math.max(1, Math.round(h / 0.6));
    const pools = this.tilePieces[t.stone];
    for (let i = 0; i < na; i++)
      for (let j = 0; j < nb; j++) {
        const ca = t.a0 + ((i + 0.5) * w) / na + rand(-0.02, 0.02);
        const cb = t.b0 + ((j + 0.5) * h) / nb + rand(-0.02, 0.02);
        const pool = pools[Math.floor(Math.random() * pools.length)];
        const sa = (w / na) * rand(0.8, 1.25);
        const sb = (h / nb) * rand(0.8, 1.25);
        const c = facePoint(t, ca, cb, TILE_T / 2);
        const da = ca - pa;
        const db = cb - pb;
        const d = Math.hypot(da, db);
        const near = Math.max(0, 1 - d / 0.9);
        _c.set(tint).multiplyScalar(rand(0.9, 1.1));
        if (floor) {
          // Popped up out of the bed, falling back in and around the hole.
          const out = rand(0.5, 1.8) * (0.4 + near);
          const l = d || 1;
          const th = rand(-0.5, 0.5);
          const vx = ((da * Math.cos(th) - db * Math.sin(th)) / l) * out;
          const vz = ((da * Math.sin(th) + db * Math.cos(th)) / l) * out;
          const k = pool.spawn(c.x, c.y, c.z, vx, rand(0.9, 2.4) * (0.5 + near), vz, sa, TILE_T, sb, _c, 1e9, d * 0.06, 7);
          pool.setRot(k, rand(-0.08, 0.08), rand(0, 6.28), rand(-0.08, 0.08));
          continue;
        }
        // Hangs for a beat, peels off the face and drops.
        const out = rand(0.3, 1.3) * (0.5 + near);
        const along = rand(-0.3, 0.3);
        const delay = rand(0, 0.12) + d * 0.1;
        // The thin axis (local y) turns to the face normal: about z for faces across x, about x for faces across z.
        if (t.axis === 0) {
          const k = pool.spawn(c.x, c.y, c.z, n.x * out, rand(-0.2, 0.8), along, sb, TILE_T, sa, _c, 1e9, delay, 3);
          pool.setRot(k, rand(0, 6.28), rand(-0.05, 0.05), Math.PI / 2 + rand(-0.05, 0.05));
        } else {
          const k = pool.spawn(c.x, c.y, c.z, along, rand(-0.2, 0.8), n.z * out, sa, TILE_T, sb, _c, 1e9, delay, 3);
          pool.setRot(k, Math.PI / 2 + rand(-0.05, 0.05), rand(0, 6.28), rand(-0.05, 0.05));
        }
      }
    // A heavier burst of dust out of the bed.
    const mid = facePoint(t, (t.a0 + t.a1) / 2, (t.b0 + t.b1) / 2, 0.1);
    _c.setRGB(0.7, 0.68, 0.64);
    for (let i = 0; i < 3; i++)
      this.smoke.spawn(mid.x + rand(-0.2, 0.2), mid.y + rand(-0.1, 0.1), mid.z + rand(-0.2, 0.2), n.x * 0.6 + rand(-0.3, 0.3), n.y * 0.4 + 0.15, n.z * 0.6 + rand(-0.3, 0.3), 0.2, 0.8, rand(1.6, 2.6), 0.5, _c);
    this.puff(mid, 0.4, 0.5, 3, 0.5);
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

  /** `dir` (optional): the shot's direction, for glancing grazes and what carries on through glass and cloth. */
  impact(p: Vec3, n: Vec3, mat: ImpactMat, chunk: number, dir?: Vec3) {
    if (mat === 'none') return;
    if (mat === 'flesh') {
      this.blood(p, { x: -n.x, y: -n.y, z: -n.z }, 0.35);
      return;
    }
    // Tiled stone chips instead of losing a block; once the tile is gone the bullet hits its concrete bed.
    const tile = this.tiles.tileAt(p, n, mat, chunk);
    if (tile && tile.hits < TILE_HITS) {
      this.tileHit(tile, p);
      return;
    }
    const m: Debris = mat;
    const L = MAT_LOOK[m];
    this.hole(p, n, m, chunk, dir);
    const ox = p.x + n.x * 0.02;
    const oy = p.y + n.y * 0.02;
    const oz = p.z + n.z * 0.02;
    // Where the bullet carries on (through glass, cloth, thin brass): along the shot, or straight through the face.
    const dl = dir ? Math.hypot(dir.x, dir.y, dir.z) || 1 : 1;
    const tx = dir ? dir.x / dl : -n.x;
    const ty = dir ? dir.y / dl : -n.y;
    const tz = dir ? dir.z / dl : -n.z;
    // Chips fly out in a cone around the surface normal, grit falls.
    const chips = IMPACT_CHIPS[m];
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
        this.sparkBurst(ox, oy, oz, n.x, n.y, n.z, 4, 7, false);
        break;
      case 'wood':
      case 'walnut':
        // Splinters torn out along the grain (pale raw wood under walnut's dark lacquer, and flakes of the lacquer).
        for (let i = 0; i < 3; i++) {
          if (m === 'walnut') _c.setRGB(2.4, 2.1, 1.8).multiplyScalar(rand(0.8, 1.1));
          else _c.set(L.chips).multiplyScalar(rand(0.8, 1.1));
          this.fragPool(m)
            .spawn(ox, oy, oz, (n.x + rand(-0.8, 0.8)) * 2.4, rand(0.5, 2.5), (n.z + rand(-0.8, 0.8)) * 2.4, rand(0.008, 0.014), rand(0.008, 0.012), rand(0.05, 0.13), _c, rand(8, 14));
        }
        if (m === 'walnut') this.scrapBurst(ox, oy, oz, 3, 0x24140a, 0.008, 0.016, 0.8, 8);
        break;
      case 'metal':
        // Steel: a hard fan of sparks, a few hot flecks that drift, a flash and sometimes a ricochet.
        this.sparkBurst(ox, oy, oz, n.x, n.y, n.z, 14, 11, false);
        this.hotFlecks(ox, oy, oz, n, 2, false);
        this.flash({ x: p.x + n.x * 0.1, y: p.y + n.y * 0.1, z: p.z + n.z * 0.1 }, 0xffb060, 1.4, 0.05);
        if (Math.random() < 0.3) this.ricochet(p, n);
        break;
      case 'brass':
        // Brass rings bright: golden sparks, a streak off the curve, hot brass flecks. A thin drum or rail is pierced
        // instead, and spits less.
        this.sparkBurst(ox, oy, oz, n.x, n.y, n.z, this.parts.thin(chunk) ? 6 : 12, 10, true);
        this.hotFlecks(ox, oy, oz, n, 3, true);
        this.flash({ x: p.x + n.x * 0.1, y: p.y + n.y * 0.1, z: p.z + n.z * 0.1 }, 0xffc870, 1.6, 0.05);
        if (Math.random() < 0.45) this.ricochet(p, n);
        break;
      case 'marble':
        // Bright white chips that fly fast, and a white dust puff that hangs.
        for (let i = 0; i < 3; i++) {
          _c.set(L.chips).multiplyScalar(rand(0.92, 1.05));
          const w = rand(0.012, 0.03);
          this.fragPool('marble').spawn(ox, oy, oz, (n.x + rand(-0.6, 0.6)) * 3, (n.y + rand(0, 0.8)) * 2.5 + 0.5, (n.z + rand(-0.6, 0.6)) * 3, w, w * 0.5, w, _c, rand(8, 14));
        }
        _c.setRGB(0.93, 0.92, 0.9);
        this.smoke.spawn(ox + n.x * 0.06, oy + n.y * 0.06, oz + n.z * 0.06, n.x * 1.1, n.y * 1.1 + 0.15, n.z * 1.1, 0.11, 0.65, rand(1, 1.8), 0.7, _c);
        this.sparkBurst(ox, oy, oz, n.x, n.y, n.z, 2, 6, false);
        break;
      case 'travertine':
        // Honey dust and a pitted crumb or two.
        _c.setRGB(0.82, 0.72, 0.52);
        this.smoke.spawn(ox + n.x * 0.06, oy + n.y * 0.06, oz + n.z * 0.06, n.x * 1, n.y * 1 + 0.12, n.z * 1, 0.11, 0.6, rand(1, 1.7), 0.6, _c);
        if (Math.random() < 0.6) {
          _c.set(CLASSIC_TINT[m] ? L.color : 0xffffff).multiplyScalar(rand(0.85, 1.1));
          const w = rand(0.02, 0.04);
          this.fragPool('travertine').spawn(ox, oy, oz, (n.x + rand(-0.5, 0.5)) * 2.2, rand(0.5, 2), (n.z + rand(-0.5, 0.5)) * 2.2, w, w * 0.7, w, _c, rand(8, 14));
        }
        break;
      case 'glass': {
        // Glittering slivers out of both faces (most carry on with the bullet), fine sparkle, a pinch of powder.
        for (let i = 0; i < 9; i++) {
          const out = i < 3;
          const s = rand(1, out ? 2.5 : 4);
          const bx = out ? n.x : tx;
          const by = out ? n.y : ty;
          const bz = out ? n.z : tz;
          _c.setRGB(rand(0.85, 1), 1, 1);
          const w = rand(0.01, 0.035);
          this.fragPool('glass').spawn(p.x + bx * 0.03, p.y + by * 0.03, p.z + bz * 0.03, (bx + rand(-0.5, 0.5)) * s, (by + rand(-0.2, 0.6)) * s, (bz + rand(-0.5, 0.5)) * s, w, w * 0.08, w * rand(1, 1.6), _c, rand(10, 18));
        }
        this.glints(p.x, p.y, p.z, 0.08, 10, 1.2);
        _c.setRGB(0.85, 0.9, 0.92);
        this.smoke.spawn(p.x + tx * 0.08, p.y + ty * 0.08, p.z + tz * 0.08, tx * 0.6, 0.05, tz * 0.6, 0.05, 0.3, rand(0.5, 0.9), 0.2, _c);
        break;
      }
      case 'fabric':
        // A tuft of stuffing pulled out after the bullet, threads and lint (a shade or a tablecloth has no stuffing:
        // a few papery flakes instead).
        if (this.parts.name(chunk) === 'shade' || this.parts.name(chunk) === 'cloth') this.scrapBurst(ox, oy, oz, 2, 0xf3e6cc, 0.01, 0.025, 0.6, 8);
        else this.stuffing(ox, oy, oz, Math.round(rand(3, 6)), false, 0.8, n.x * 0.8, n.z * 0.8);
        this.scrapBurst(ox, oy, oz, 3, LOOK.fabric.color, 0.005, 0.012, 0.6, 6);
        _c.set(LOOK.fabric.dustColor);
        this.smoke.spawn(ox + n.x * 0.05, oy, oz + n.z * 0.05, n.x * 0.5, 0.1, n.z * 0.5, 0.07, 0.4, rand(0.8, 1.3), 0.3, _c);
        break;
      case 'leather':
        // Dark flecks of hide and crumbs of yellow foam.
        _c.setRGB(0.85, 0.74, 0.42);
        for (let i = 0; i < 4; i++) {
          const s = rand(1, 2.5);
          this.grit.spawn(ox, oy, oz, (n.x + rand(-0.6, 0.6)) * s, rand(0.3, 1.5), (n.z + rand(-0.6, 0.6)) * s, rand(0.008, 0.016), rand(1.2, 2.5), _c);
        }
        this.stuffing(ox, oy, oz, 2, true, 0.6, n.x * 0.6, n.z * 0.6);
        break;
      case 'ceramic':
        // Glazed shards (dark outside, pale clay inside) and clay dust.
        for (let i = 0; i < 3; i++) {
          const w = rand(0.015, 0.04);
          _c.setRGB(1, 1, 1);
          this.fragPool('ceramic').spawn(ox, oy, oz, (n.x + rand(-0.6, 0.6)) * 2.8, rand(0.5, 2.2), (n.z + rand(-0.6, 0.6)) * 2.8, w, w * 0.3, w, _c, rand(8, 14));
        }
        _c.setRGB(0.76, 0.68, 0.58);
        this.smoke.spawn(ox + n.x * 0.06, oy + n.y * 0.06, oz + n.z * 0.06, n.x * 0.9, n.y * 0.9 + 0.1, n.z * 0.9, 0.09, 0.45, rand(0.8, 1.4), 0.45, _c);
        break;
      case 'foliage':
        // Leaves clipped off, fluttering down, a twig now and then; a faint green mist.
        this.leafBurst(p.x, p.y, p.z, 0.15, Math.round(rand(3, 6)), this.parts.name(chunk) === 'flowers', 0.5);
        if (Math.random() < 0.35) {
          _c.setRGB(1, 1, 1);
          this.frags.foliage[0].spawn(p.x, p.y, p.z, rand(-0.8, 0.8), rand(0.2, 1), rand(-0.8, 0.8), rand(0.006, 0.01), rand(0.006, 0.01), rand(0.05, 0.12), _c, rand(10, 16));
        }
        _c.setRGB(0.32, 0.4, 0.24);
        this.smoke.spawn(p.x, p.y, p.z, tx * 0.4, 0.05, tz * 0.4, 0.06, 0.4, rand(0.6, 1), 0.15, _c);
        break;
    }
    // Dust in the fog, rate-limited (an LMG would otherwise flood the fog with blobs).
    if (L.dust > 0.05 && this.time - this.lastPuff > 0.035) {
      this.lastPuff = this.time;
      const big = m === 'plaster' || m === 'marble' || m === 'travertine';
      this.puff({ x: p.x + n.x * 0.15, y: p.y + n.y * 0.15, z: p.z + n.z * 0.15 }, big ? 0.2 : 0.14, L.dust * (big ? 0.6 : 0.4), 1.6, 0.4);
    }
  }

  /** Ricochet: a bright streak whining off the plate. */
  private ricochet(p: Vec3, n: Vec3) {
    const rx = n.x + rand(-0.7, 0.7);
    const ry = n.y + rand(-0.2, 0.6);
    const rz = n.z + rand(-0.7, 0.7);
    const rl = Math.hypot(rx, ry, rz) || 1;
    this.tracers.spawn({ x: p.x - (rx / rl) * 1.6, y: p.y - (ry / rl) * 1.6, z: p.z - (rz / rl) * 1.6 }, { x: p.x + (rx / rl) * 10, y: p.y + (ry / rl) * 10, z: p.z + (rz / rl) * 10 }, 2.5, 0.7);
  }

  /** Hot metal flecks that drift and glow out (embers pool). */
  private hotFlecks(x: number, y: number, z: number, n: Vec3, count: number, brass: boolean) {
    for (let i = 0; i < count; i++) {
      const s = rand(1, 3);
      _c.setRGB(1, brass ? rand(0.7, 0.85) : rand(0.45, 0.6), brass ? 0.3 : 0.15).multiplyScalar(rand(2, 3));
      this.embers.spawn(x, y, z, (n.x + rand(-0.6, 0.6)) * s, (n.y + rand(0, 0.8)) * s, (n.z + rand(-0.6, 0.6)) * s, rand(0.006, 0.012), rand(0.5, 1.2), _c);
    }
  }

  /**
   * The bullet hole: the material's own cell and size (holes.ts), tinted cells in the surface colour. A glancing shot
   * leaves a stretched graze along its path; thin brass or sheet steel is pierced; a cluster of holes in stone, glass
   * or plaster cracks.
   */
  private hole(p: Vec3, n: Vec3, m: Debris, chunk: number, dir?: Vec3) {
    if (m === 'foliage') return;
    let inc = 1;
    if (dir) inc = Math.abs(dir.x * n.x + dir.y * n.y + dir.z * n.z) / (Math.hypot(dir.x, dir.y, dir.z) || 1);
    if (dir && inc < 0.26 && m !== 'fabric' && m !== 'glass' && m !== 'leather') {
      const [a, b] = HOLE_INFO.graze.size;
      this.decals.add(p, n, rand(a, b), D.graze, holeTint(m, 'graze', _c), chunk, 1, Math.min(3.4, 0.75 / (inc + 0.04)), dir);
      return;
    }
    const r = Math.random() < 0.5;
    const cell: HoleKind =
      m === 'brick'
        ? r ? 'hole' : 'hole2'
        : m === 'plaster'
          ? r ? 'plaster' : 'plaster2'
          : m === 'concrete'
            ? r ? 'concrete' : 'concrete2'
            : m === 'wood'
              ? r ? 'wood' : 'wood2'
              : m === 'metal'
                ? r || this.parts.thin(chunk) ? 'metal2' : 'metal'
                : m === 'marble'
                  ? r ? 'marble' : 'marble2'
                  : m === 'glass'
                    ? Math.random() < 0.6 ? 'glass' : 'glass2'
                    : m === 'fabric'
                      ? r ? 'fabric' : 'fabric2'
                      : m === 'brass'
                        ? this.parts.thin(chunk) ? 'brassHole' : 'brass'
                        : m;
    const [a, b] = HOLE_INFO[cell].size;
    const woody = cell === 'wood' || cell === 'wood2' || cell === 'walnut';
    this.decals.add(p, n, rand(a, b), D[cell], holeTint(m, cell, _c), chunk, 1, woody ? 1.25 : 1);
    // A hole next to an earlier one in brittle stuff runs a crack between them.
    const crack = CRACKS[m];
    if (crack) {
      const reach = m === 'glass' ? 0.32 : 0.16;
      for (let k = 0; k < 32; k++) {
        if (this.holeChunk[k] !== chunk) continue;
        const dx = this.holes[k * 3] - p.x;
        const dy = this.holes[k * 3 + 1] - p.y;
        const dz = this.holes[k * 3 + 2] - p.z;
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
        if (Math.random() < crack) {
          const [c0, c1] = HOLE_INFO.crack.size;
          this.decals.add({ x: p.x + dx * 0.5, y: p.y + dy * 0.5, z: p.z + dz * 0.5 }, n, rand(c0, c1) * (m === 'glass' ? 1.4 : 1), D.crack, holeTint(m, 'crack', _c), chunk, 0.9, 1.3, { x: dx, y: dy, z: dz });
        }
        break;
      }
    }
    const k = this.holeNext;
    this.holeNext = (k + 1) % 32;
    this.holes[k * 3] = p.x;
    this.holes[k * 3 + 1] = p.y;
    this.holes[k * 3 + 2] = p.z;
    this.holeChunk[k] = chunk;
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
    this.puffsLeft = maxPuffs;
    for (let k = 0; k < chunks.length; k++) {
      const c = this.world.chunks[chunks[k]];
      if (!c) continue;
      const m = c.mat;
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
      const theme = this.parts.theme(chunks[k], m);
      if (theme !== 'classic') {
        this.wreck(theme, c, chunks[k], ax, ay, az, speed, per, blast);
        continue;
      }
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
   * One chunk of a non-classic material breaks (wreck.ts Theme): glass panes shatter into flat slivers and a glitter
   * cascade, upholstery bursts its stuffing (and a sofa its springs), a pot spills its soil, a canopy sheds leaves and
   * branches, a lamp shade tears with a bulb pop, a vase splashes its water. `per` scales the counts down when a
   * blast breaks many chunks at once; (ax, ay, az) points away from the hit.
   */
  private wreck(theme: Theme, c: World['chunks'][number], ci: number, ax: number, ay: number, az: number, speed: number, per: number, blast: boolean) {
    const m = c.mat;
    const L = MAT_LOOK[m];
    const sx = c.max.x - c.min.x;
    const sy = c.max.y - c.min.y;
    const sz = c.max.z - c.min.z;
    const cx = (c.min.x + c.max.x) / 2;
    const cy = (c.min.y + c.max.y) / 2;
    const cz = (c.min.z + c.max.z) / 2;
    const big = Math.max(sx, sy, sz);
    const vol = sx * sy * sz;
    // Burst strength: a bullet break pops, a blast flings.
    const pw = blast ? 0.6 + speed * 0.25 : 1;
    const n = (k: number) => Math.max(1, Math.round(k * per));
    const back = !blast ? -0.35 : 1;
    switch (theme) {
      case 'pane': {
        // The pane lets go all at once: slivers hang in place for a beat, then fall out, most of them away from the
        // shot, flat ones flipping as they go; glitter cascades down the opening.
        const thinX = sx < sz;
        const count = n(16) + 2;
        for (let i = 0; i < count; i++) {
          const px = thinX ? cx : c.min.x + rand(0.08, 0.92) * sx;
          const py = c.min.y + rand(0.08, 0.92) * sy;
          const pz = thinX ? c.min.z + rand(0.08, 0.92) * sz : cz;
          const w = i < count * 0.3 ? rand(0.1, 0.18) : rand(0.03, 0.09);
          const out = rand(0.2, 1) * speed * (blast ? 1 : 0.7) * (Math.random() < 0.3 ? -0.5 : 1);
          _c.setRGB(rand(0.85, 1), rand(0.95, 1.05), 1);
          const pool = this.fragPool('glass');
          const k = pool.spawn(px, py, pz, ax * out + rand(-0.3, 0.3), rand(-0.3, 0.6) * pw, az * out + rand(-0.3, 0.3), w, w * 0.08, w * rand(1, 1.8), _c, rand(18, 30), rand(0, 0.12) + (py - c.min.y) * 0.04, 4);
          // Lying in the plane of the pane: the thin axis (local y) across it.
          if (thinX) pool.setRot(k, rand(-0.3, 0.3), rand(-0.3, 0.3), Math.PI / 2 + rand(-0.2, 0.2));
          else pool.setRot(k, Math.PI / 2 + rand(-0.2, 0.2), rand(-0.3, 0.3), rand(-0.3, 0.3));
        }
        this.glints(cx, cy, cz, big, n(34) + 4, pw);
        this.schedule(0.25, () => this.glints(cx, c.min.y + sy * 0.3, cz, big * 0.7, n(14) + 2, 0.6));
        _c.setRGB(0.85, 0.9, 0.92);
        this.smoke.spawn(cx, cy, cz, ax * 0.4, 0.05, az * 0.4, 0.2, 0.6, rand(1, 1.8), 0.15, _c);
        break;
      }
      case 'vase': {
        this.glassBurst(cx, cy, cz, big, n(12) + 3, ax, az, pw * 1.4);
        // The water: a splash of clear droplets, and a wet patch spreading on whatever the vase stood on.
        for (let i = 0; i < n(36) + 6; i++) {
          const th = rand(0, 6.28);
          const s = rand(0.6, 2.8) * pw;
          _c.setRGB(0.7, 0.8, 0.85);
          this.water.spawn(cx + rand(-0.08, 0.08), cy + rand(-0.1, 0.1), cz + rand(-0.08, 0.08), Math.cos(th) * s + ax, rand(0.3, 2.4), Math.sin(th) * s + az, rand(0.01, 0.028), rand(1.5, 3), _c);
        }
        const hit = raycast(this.world, { x: cx, y: c.min.y + 0.02, z: cz }, { x: 0, y: -1, z: 0 }, 2);
        const under = hit ? c.min.y + 0.02 - hit.t : 0;
        const wi = this.decals.add({ x: cx, y: under, z: cz }, hit?.n ?? { x: 0, y: 1, z: 0 }, 0.2, D.dust, _c.set(WET), hit?.chunk ?? -1, 0.7);
        this.decals.grow(wi, rand(0.7, 1), 3);
        // Water running off the edge onto the floor.
        if (under > 0.3) this.schedule(0.5, () => {
          const wf = this.decals.add({ x: cx + rand(-0.4, 0.4), y: 0, z: cz + rand(-0.4, 0.4) }, { x: 0, y: 1, z: 0 }, 0.15, D.dust, _c.set(WET), -1, 0.6);
          this.decals.grow(wf, rand(0.5, 0.8), 4);
        });
        break;
      }
      case 'marble':
      case 'travertine': {
        // Heavy slabs that crack into sharp-edged pieces, and a cloud of white (or honey) dust.
        if (!blast || Math.random() < 0.5) {
          _c.set(CLASSIC_TINT[m] ? L.color : 0xffffff).multiplyScalar(rand(0.9, 1.08));
          const f = rand(0.55, 0.8);
          this.slabs[m].spawn(cx, cy, cz, ax * speed * back * 0.5 + rand(-0.4, 0.4), rand(0.2, 1) * (blast ? 3 : 1), az * speed * back * 0.5 + rand(-0.4, 0.4), sx * f, sy * f, sz * f, _c, rand(16, 26), 0, blast ? 9 : 3);
        }
        for (let i = 0; i < n(5) + 1; i++) {
          _c.set(CLASSIC_TINT[m] ? L.color : 0xffffff).multiplyScalar(rand(0.85, 1.1));
          const w = Math.max(sx, sz) * rand(0.15, 0.32);
          const s = speed * rand(0.5, 1.2);
          this.fragPool(m).spawn(c.min.x + rand(0.15, 0.85) * sx, c.min.y + rand(0.2, 0.9) * sy, c.min.z + rand(0.15, 0.85) * sz, ax * s * back + rand(-1, 1), rand(0.3, 1.8) * pw, az * s * back + rand(-1, 1), w, Math.min(sy, w) * rand(0.4, 0.8), w * rand(0.6, 1.1), _c, rand(14, 22));
        }
        _c.set(L.grit);
        for (let i = 0; i < n(10); i++) this.grit.spawn(cx + rand(-0.2, 0.2), cy, cz + rand(-0.2, 0.2), ax * speed * rand(0.3, 1.2) + rand(-1.5, 1.5), rand(0, 2.5), az * speed * rand(0.3, 1.2) + rand(-1.5, 1.5), rand(0.008, 0.028), rand(1.5, 3.5), _c);
        this.dustOf(m, cx, cy, cz, (0.45 + vol * 3) * (blast ? 1.4 : 1), 1.1);
        break;
      }
      case 'walnut': {
        // Planks and splinters, flakes of the dark lacquer.
        for (let i = 0; i < n(3); i++) {
          _c.setRGB(rand(0.85, 1.1), rand(0.85, 1.05), rand(0.85, 1));
          const len = big * rand(0.55, 0.95);
          const s = speed * rand(0.5, 1.1);
          this.walnutPlanks.spawn(cx + rand(-0.15, 0.15), cy + rand(-0.15, 0.15), cz + rand(-0.15, 0.15), ax * s * back + rand(-0.5, 0.5), rand(0.3, 1.5) * pw, az * s * back + rand(-0.5, 0.5), len, rand(0.025, 0.045), rand(0.08, 0.14), _c, rand(16, 26));
        }
        for (let i = 0; i < n(6); i++) {
          // Dark lacquered outside, pale raw wood where it split.
          if (i % 2) _c.setRGB(1, 1, 1).multiplyScalar(rand(0.8, 1.1));
          else _c.setRGB(2.4, 2.1, 1.8).multiplyScalar(rand(0.8, 1.1));
          const s = speed * rand(0.6, 1.4);
          this.fragPool('walnut').spawn(cx + rand(-0.2, 0.2), cy + rand(-0.2, 0.2), cz + rand(-0.2, 0.2), ax * s + rand(-1, 1), rand(0.3, 2) * pw, az * s + rand(-1, 1), rand(0.02, 0.05), rand(0.015, 0.03), rand(0.12, 0.35), _c, rand(14, 22));
        }
        this.scrapBurst(cx, cy, cz, n(6) + 1, 0x24140a, 0.01, 0.025, pw, 10);
        this.dustOf(m, cx, cy, cz, 0.4 + vol * 2, 0.8);
        break;
      }
      case 'upholstery':
      case 'sofa':
      case 'leather':
      case 'luggage': {
        // The cover tears open: a cloud of stuffing tufts (foam crumbs for leather), torn scraps of the cover, the
        // padding as a soft lump, and out of a sofa seat a spring or two.
        const foam = m === 'leather';
        const tufts = n(blast ? 16 : 22) + 4;
        for (let j = 0; j < 3; j++)
          this.stuffing(c.min.x + rand(0.2, 0.8) * sx, c.min.y + rand(0.3, 0.9) * sy, c.min.z + rand(0.2, 0.8) * sz, Math.ceil(tufts / 3), foam, pw * 1.3, ax * 0.6, az * 0.6);
        const cover = theme === 'luggage' ? 0x6a3a1e : foam ? 0x4a2418 : Math.random() < 0.3 && theme === 'sofa' ? 0x2a2e36 : LOOK.fabric.color;
        this.scrapBurst(cx, cy, cz, n(9) + 2, cover, 0.04, 0.12, pw, 16);
        if (theme === 'luggage') {
          // A burst suitcase: clothes.
          for (const col of [0xe8e4dc, 0x3a4a6a, 0x8a2a24]) this.scrapBurst(cx, cy, cz, n(2) + 1, col, 0.1, 0.2, pw * 0.8, 18);
        }
        if (theme === 'sofa' && Math.random() < 0.8) {
          for (let i = 0; i < (Math.random() < 0.5 ? 1 : 2); i++) {
            const s = rand(1, 2.5) * pw;
            const d = rand(0.07, 0.1);
            _c.setRGB(1, 1, 1).multiplyScalar(rand(0.8, 1));
            this.springs.spawn(cx + rand(-0.1, 0.1), c.max.y - 0.05, cz + rand(-0.1, 0.1), ax * s + rand(-0.6, 0.6), rand(2, 3.5) * pw, az * s + rand(-0.6, 0.6), d, rand(0.1, 0.14), d, _c, rand(18, 28), 0, 8);
          }
        }
        if (!blast || Math.random() < 0.5) {
          _c.set(foam ? 0x5a3020 : cover).multiplyScalar(rand(0.85, 1.05));
          const f = rand(0.5, 0.7);
          this.slabs[m].spawn(cx, cy, cz, ax * speed * 0.4 + rand(-0.3, 0.3), rand(0.3, 1) * pw, az * speed * 0.4 + rand(-0.3, 0.3), sx * f, sy * f, sz * f, _c, rand(16, 26), 0, blast ? 6 : 2);
        }
        _c.set(L.dustColor);
        this.smoke.spawn(cx, cy, cz, ax * 0.3, 0.1, az * 0.3, 0.25, 0.6, rand(1.5, 2.5), 0.2, _c);
        break;
      }
      case 'cloth':
        // A tablecloth tears into big white rags; no stuffing in it.
        this.scrapBurst(cx, cy, cz, n(10) + 2, LOOK.fabric.color, 0.07, 0.2, pw, 18);
        this.scrapBurst(cx, cy, cz, n(4), 0xf2efe8, 0.006, 0.014, pw * 0.6, 8);
        break;
      case 'shade': {
        // A lamp shade: papery scraps flutter off, the bulb pops (a flash, sparks, tinkling glass) and smokes a little.
        this.scrapBurst(cx, cy, cz, n(12) + 3, 0xf3e6cc, 0.04, 0.12, pw, 14);
        this.flash({ x: cx, y: cy, z: cz }, 0xffe2a8, 14, 0.14);
        this.sparkBurst(cx, cy, cz, 0, 0.3, 0, 8, 4, true);
        this.glints(cx, cy, cz, 0.2, 12, 0.8);
        for (let i = 0; i < 4; i++) {
          _c.setRGB(1, 1, 1);
          const w = rand(0.008, 0.02);
          this.fragPool('glass').spawn(cx, cy, cz, rand(-1.5, 1.5), rand(0, 1.5), rand(-1.5, 1.5), w, w * 0.08, w * 1.4, _c, rand(10, 16));
        }
        _c.setRGB(0.35, 0.34, 0.32);
        this.smoke.spawn(cx, cy, cz, 0, 0.25, 0, 0.12, 0.5, rand(1.5, 2.5), 0.3, _c);
        break;
      }
      case 'pot': {
        // Big curved glazed shards, and the soil inside pours out (more from the top of the pot).
        const upper = c.max.y > 0.5;
        this.potShards(cx, cy, cz, big, n(6) + 2, ax * back, az * back, speed * 0.6 * pw + 0.6);
        this.soil(cx, upper ? c.max.y - 0.1 : cy, cz, big, upper ? 1 : 0.5);
        this.dustOf(m, cx, cy, cz, 0.4 + vol * 2, 0.8);
        break;
      }
      case 'canopy':
      case 'flowers': {
        // A shower of leaves (and white petals off the flowers) and broken branches; more leaves slide off after.
        const flowers = theme === 'flowers';
        this.leafBurst(cx, cy, cz, big * 1.4, n(flowers ? 26 : 34) + 6, flowers, pw * 1.3);
        this.branches(cx, cy, cz, flowers ? 1 : n(3) + 1, pw);
        this.schedule(0.3, () => this.leafBurst(cx, cy - 0.1, cz, big * 0.7, n(10) + 2, flowers, 0.4));
        _c.set(L.grit);
        for (let i = 0; i < n(6); i++) this.grit.spawn(cx + rand(-0.2, 0.2), cy, cz + rand(-0.2, 0.2), rand(-1, 1) * pw, rand(0, 1.5), rand(-1, 1) * pw, rand(0.006, 0.014), rand(1, 2), _c);
        break;
      }
      case 'brass': {
        // Bent brass: curled fragments, a hunk of it tumbling, a shower of golden sparks.
        for (let i = 0; i < n(4) + 1; i++) {
          _c.set(CLASSIC_TINT[m] ? L.color : 0xffffff).multiplyScalar(rand(0.85, 1.15));
          const w = big * rand(0.12, 0.3);
          const s = speed * rand(0.6, 1.4);
          this.fragPool('brass').spawn(cx + rand(-0.15, 0.15), cy + rand(-0.15, 0.15), cz + rand(-0.15, 0.15), ax * s + rand(-1, 1), rand(0.5, 2.5) * pw, az * s + rand(-1, 1), w, w * 0.5, w * rand(0.6, 1.2), _c, rand(16, 26));
        }
        if (!blast || Math.random() < 0.4) {
          _c.set(CLASSIC_TINT[m] ? L.color : 0xffffff).multiplyScalar(rand(0.9, 1.1));
          this.slabs.brass.spawn(cx, cy, cz, ax * speed * 0.5, rand(0.3, 1.2) * pw, az * speed * 0.5, sx * 0.8, sy * 0.8, sz * 0.8, _c, rand(18, 28), 0, blast ? 8 : 3);
        }
        this.sparkBurst(cx, cy, cz, ax, ay + 0.3, az, n(12) + 4, speed + 5, true);
        this.hotFlecks(cx, cy, cz, { x: ax, y: 0.4, z: az }, 3, true);
        this.flash({ x: cx, y: cy, z: cz }, 0xffc870, 2.5, 0.06);
        break;
      }
      case 'classic':
        break;
    }
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
      const m = c.mat;
      let sx = c.max.x - c.min.x;
      const sy = c.max.y - c.min.y;
      let sz = c.max.z - c.min.z;
      const cx = (c.min.x + c.max.x) / 2;
      const cy = (c.min.y + c.max.y) / 2;
      const cz = (c.min.z + c.max.z) / 2;
      const delay = 0.04 + (c.min.y - minY) * 0.07 + rand(0, 0.12);
      // Pieces fall as their own material: a lamp shade or a vase comes down and breaks (its theme, as it lands); a
      // pane is a thin sheet that smashes; a canopy is a leafy clump shedding leaves as it drops; cushions stay whole.
      const theme = this.parts.theme(chunks[k], m);
      if (theme === 'shade' || theme === 'vase') {
        const ci = chunks[k];
        this.schedule(delay + Math.sqrt((2 * Math.max(0.1, c.min.y)) / GRAVITY), () => this.wreck(theme, c, ci, lx, 0, lz, 1.5, 1, false));
        continue;
      }
      if (m === 'glass') {
        if (sx < sz) sx *= 0.15;
        else sz *= 0.15;
      }
      if (m === 'foliage') this.schedule(delay + 0.1, () => this.leafBurst(cx, cy, cz, Math.max(sx, sy, sz) * 0.8, 5, theme === 'flowers', 0.4));
      // The classic five tint by their colour again (their tuned, weathered look); the rest keep their material's.
      _c.set(CLASSIC_TINT[m] ? MAT_LOOK[m].color : 0xffffff).multiplyScalar(rand(0.85, 1.1));
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
    // The blast lifts the floor tiles under it and cracks the ones around.
    if (p.y < 1.6)
      for (const { t, d } of this.tiles.floorTilesNear(p, 2.2)) {
        const hp = { x: Math.min(t.a1 - 0.08, Math.max(t.a0 + 0.08, p.x + rand(-0.2, 0.2))), y: 0, z: Math.min(t.b1 - 0.08, Math.max(t.b0 + 0.08, p.z + rand(-0.2, 0.2))) };
        this.tileHit(t, hp, d < 1 ? TILE_HITS : d < 1.7 ? 2 : 1);
      }
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
      _c.setRGB(0.95, 1, 1);
      for (let i = 0; i < 8; i++) {
        const s = rand(2, 6);
        this.fragPool('glass').spawn(w.center.x + along.x * rand(-0.7, 0.7), w.center.y + rand(0.2, 1.4), w.center.z + along.z * rand(-0.7, 0.7), (away.x / al) * s + rand(-1, 1), rand(0.5, 2.5), (away.z / al) * s + rand(-1, 1), rand(0.04, 0.09), 0.006, rand(0.04, 0.09), _c, rand(10, 16));
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
    this.walnutPlanks.wake();
    this.springs.wake();
    this.leaves.wake();
    this.scraps.wake();
    for (const s of ['marble', 'travertine'] as const) {
      for (const p of this.tileChips[s]) p.wake();
      for (const p of this.tilePieces[s]) p.wake();
    }
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
    this.walnutPlanks.update(dt);
    this.springs.update(dt);
    this.leaves.update(dt);
    this.scraps.update(dt);
    this.fluff.update(dt);
    this.glitter.update(dt);
    this.water.update(dt);
    for (const s of ['marble', 'travertine'] as const) {
      for (const p of this.tileChips[s]) p.update(dt);
      for (const p of this.tilePieces[s]) p.update(dt);
    }
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
    for (const s of ['marble', 'travertine'] as const) {
      for (const p of this.tileChips[s]) p.mesh.dispose();
      for (const p of this.tilePieces[s]) p.mesh.dispose();
    }
    this.tiles.dispose();
    for (const x of [this.planks, this.casings, this.walnutPlanks, this.springs, this.leaves, this.scraps, this.fluff, this.glitter, this.water, this.grit, this.sparks, this.embers, this.drops, this.smoke, this.fire, this.decals, this.tracers]) {
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
    this.walnutPlanks.clear();
    this.springs.clear();
    this.leaves.clear();
    this.scraps.clear();
    this.fluff.clear();
    this.glitter.clear();
    this.water.clear();
    for (const s of ['marble', 'travertine'] as const) {
      for (const p of this.tileChips[s]) p.clear();
      for (const p of this.tilePieces[s]) p.clear();
    }
    this.tiles.clear();
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
