// Garden Sentinels attack and ability effects: laser beams, missiles, explosions, slow / shield / beacon fields, zaps,
// disrupt bolts, crystal-shard deaths, "+gold" popups, leak / build / upgrade / sell / spawn / ping, sprinkler water bombs
// and splashes, Bloomkin heal pulses, the Sunburst strike and its aiming reticle.
//
// Everything is batched so dozens of beams and thousands of particles cost a handful of draw calls:
//   Particles   GPU-analytic billboards in a ring buffer (one additive, one alpha-blended, one for popup glyphs). The
//               CPU only writes a particle once at spawn; the vertex shader integrates drag + gravity from its age.
//   Shards      the same idea for small tumbling 3D crystal shards (instanced octahedra that bounce to rest).
//   Rings       GPU-analytic ground decals (shock rings, flashes, portal swirls, ping pulses).
//   Segments    camera-facing capsule ribbons rebuilt each frame (laser beams, chain arcs, disrupt bolts).
//   Sprites     glow billboards rebuilt each frame (beam impacts, muzzles, missile exhaust).
//   Fields      one disc / dome mesh per slow, shield or beacon tower (a few dozen at most).
// No per-frame allocations: all state lives in preallocated pools and typed arrays.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FLY_HEIGHT, type EnemyKind } from '@shared/garden/enemies';
import type { Level } from '@shared/garden/towers';
import type { CreateFx, Fx, P3, Quality } from './api';

/**
 * Optional extra on top of Fx (api.ts): a slow field plays its rings / fill / motes only while an enemy is inside its
 * radius. Call `fieldActive(towerId, true|false)` when that changes (calling every frame is fine); fields never told
 * stay idle (a faint rim). Ignored for shield / beacon fields and unknown towers.
 */
export interface FxFieldActive {
  fieldActive(tw: number, active: boolean): void;
}

// ---- colours --------------------------------------------------------------------------------------------------------

type RGB = [number, number, number];
const tmpColor = new THREE.Color();
/** sRGB hex to linear RGB, times an HDR intensity. */
const lin = (hex: number, k = 1): RGB => {
  tmpColor.setHex(hex);
  return [tmpColor.r * k, tmpColor.g * k, tmpColor.b * k];
};

const AMBER = lin(0xffa940);
const MINT = lin(0x4ee6d9);
const VIOLET = lin(0xa869ff);
const CREAM = lin(0xf5e7d6);
const GOLD = lin(0xffcf5a);
const VIOLET_HDR = lin(0xa060ff, 2.2);
const ARC_CORE = lin(0xe0c8ff, 1.6);
const HOT_WHITE: RGB = [1, 0.93, 0.78];
const CHAIN_WHITE: RGB = [0.9, 1, 1];
const VIOLET_PALE: RGB = [0.9, 0.8, 1];
const FIRE_A: RGB = [1, 0.7, 0.3];
const FIRE_B: RGB = [1, 0.3, 0.05];
const BOOM_FLASH: RGB = [1, 0.75, 0.45];
const BOOM_SPARK: RGB = [1, 0.62, 0.25];
const BOOM_RING: RGB = [2, 0.9, 0.25];
const BOOM_DISC: RGB = [1.6, 0.6, 0.15];
const PINK = lin(0xff5c8a, 2.6);
const PETALS = [lin(0xff8fb1, 1.3), lin(0xffb3c8, 1.3), lin(0xff6f9a, 1.3), CREAM];
const LEAVES = [lin(0x9be05a, 1.3), lin(0xc7f07a, 1.3), lin(0xffd36a, 1.2), lin(0x7fd65a, 1.3)];
const BOOM_LEAVES = [lin(0x7ccf5a), lin(0x9fdc6a)];
const DUST = lin(0xf0e2c8);
const SPAWN_V = lin(0xa869ff, 1.6);
const SPAWN_M = lin(0x4ee6d9, 1.6);
const COLOSSUS_FLASH = lin(0xd6b8ff, 1.6);
const WATER = lin(0x2eb3ff);
const WATER_HDR = lin(0x2eb3ff, 1.9);
const WATER_PALE = lin(0xbfeaff, 1.3);
const WET = lin(0x1f4a5c, 0.55);
const HEAL_GREEN = lin(0x9be05a, 1.5);
const HEAL_GOLD = lin(0xffd36a, 1.5);
const HEAL_MOTES = [lin(0x9be05a, 1.3), lin(0xc7f07a, 1.3), lin(0xffd36a, 1.2), lin(0xffb3c8, 1.2)];
const SUN_GOLD = lin(0xffb43a, 2.3);
const SUN_RING = lin(0xffc048, 2.6);
const SUN_CORE: RGB = [1, 0.9, 0.66];
const SUN_SCORCH = lin(0x7a5418, 0.75);
const SUN_PETALS = [lin(0xffd36a, 1.2), lin(0xffb84a, 1.2), CREAM, lin(0xffe39a, 1.2)];
const AIM_COL = lin(0xffc65a, 1.5);
const MOTH_WINGS = [lin(0xffa940, 1.2), lin(0x4ee6d9, 1.2), lin(0xffd27a, 1.2)];

const BEAM_COL: Record<Level, RGB> = { 1: lin(0xff8a24, 2.1), 2: lin(0xffa040, 2.6), 3: lin(0xffc048, 3.0) };
const BEAM_W: Record<Level, number> = { 1: 0.19, 2: 0.23, 3: 0.27 };
const CHAIN_COL = lin(0x5cffe8, 2.8);

const KIND_COLS: Record<EnemyKind, RGB[]> = {
  runner: [lin(0xffa940), lin(0xff7a2e), lin(0xffd27a)],
  skitter: [lin(0x4ee6d9), lin(0x9bfff2), lin(0x2ec4b6)],
  disruptor: [lin(0xa869ff), lin(0xd3a8ff), lin(0x7a3dff)],
  brute: [lin(0x3fd8e8), lin(0x2eb3ff), lin(0x8af4ff)],
  colossus: [],
  moth: [lin(0xffa940), lin(0x4ee6d9), lin(0xffd27a)],
  bloomkin: [lin(0x6bba4b), lin(0x9be05a), lin(0xff8fb1)],
};
const KIND_SHARDS: Record<EnemyKind, number> = { runner: 11, skitter: 7, disruptor: 12, brute: 24, colossus: 46, moth: 6, bloomkin: 14 };
/** Half the body height (m): where the burst centres relative to the feet. */
const KIND_HALF: Record<EnemyKind, number> = { runner: 0.4, skitter: 0.25, disruptor: 0.45, brute: 0.9, colossus: 1.5, moth: 0.35, bloomkin: 0.5 };

const QUALITY_MULT: Record<Quality, number> = { low: 0.35, medium: 0.7, high: 1 };

// ---- small helpers --------------------------------------------------------------------------------------------------

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]) => a[(Math.random() * a.length) | 0];
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/** Random unit vector written into D (upper hemisphere when `up`). */
const D = { x: 0, y: 0, z: 0 };
const randDir = (up = false) => {
  const u = Math.random() * 2 - 1;
  const th = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  D.x = r * Math.cos(th);
  D.y = up ? Math.abs(u) : u;
  D.z = r * Math.sin(th);
};
/** HSL (h 0..1) to linear RGB, written into a shared scratch triple (read it before the next call). */
const HSL: RGB = [0, 0, 0];
const hsl = (h: number, s: number, l: number, k: number): RGB => {
  tmpColor.setHSL(h, s, l);
  HSL[0] = tmpColor.r * k;
  HSL[1] = tmpColor.g * k;
  HSL[2] = tmpColor.b * k;
  return HSL;
};

// ---- atlas: 8 x 8 cells of 64 px ------------------------------------------------------------------------------------

const S_GLOW = 0;
const S_SPARK = 1;
const S_SMOKE = 2;
const S_PETAL = 3;
const S_LEAF = 4;
const S_STAR = 5;
const S_COIN = 6;
const S_RING = 7;
const S_PIN = 8;
const S_SHARD = 9;
const S_DOT = 10;
const S_PLUS = 16;
const S_DIGIT = 17; // 17..26

function makeAtlas(): THREE.CanvasTexture {
  const C = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = C * 8;
  const g = cv.getContext('2d')!;
  const cell = (i: number, draw: (cx: number, cy: number) => void) => {
    g.save();
    const x = (i % 8) * C;
    const y = Math.floor(i / 8) * C;
    g.beginPath();
    g.rect(x, y, C, C);
    g.clip();
    draw(x + C / 2, y + C / 2);
    g.restore();
  };
  const radial = (cx: number, cy: number, r: number, stops: [number, number][]) => {
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [o, a] of stops) gr.addColorStop(o, `rgba(255,255,255,${a})`);
    g.fillStyle = gr;
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
  };
  cell(S_GLOW, (x, y) => radial(x, y, 31, [[0, 1], [0.15, 0.75], [0.4, 0.28], [0.7, 0.07], [1, 0]]));
  cell(S_SPARK, (x, y) => radial(x, y, 31, [[0, 1], [0.18, 0.9], [0.45, 0.25], [1, 0]]));
  cell(S_SMOKE, (x, y) => {
    let s = 7;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 9; i++) {
      const a = r() * Math.PI * 2;
      const d = r() * 10;
      radial(x + Math.cos(a) * d, y + Math.sin(a) * d, 14 + r() * 8, [[0, 0.42], [0.6, 0.2], [1, 0]]);
    }
  });
  cell(S_PETAL, (x, y) => {
    g.translate(x, y);
    const gr = g.createLinearGradient(0, -26, 0, 26);
    gr.addColorStop(0, '#fff');
    gr.addColorStop(1, '#d9d9d9');
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(0, 26);
    g.bezierCurveTo(22, 10, 18, -20, 0, -26);
    g.bezierCurveTo(-18, -20, -22, 10, 0, 26);
    g.fill();
  });
  cell(S_LEAF, (x, y) => {
    g.translate(x, y);
    g.rotate(0.6);
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(0, 28);
    g.quadraticCurveTo(24, 0, 0, -28);
    g.quadraticCurveTo(-24, 0, 0, 28);
    g.fill();
    g.strokeStyle = 'rgba(150,150,150,0.9)';
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(0, 26);
    g.lineTo(0, -22);
    g.stroke();
  });
  cell(S_STAR, (x, y) => {
    radial(x, y, 20, [[0, 0.9], [0.5, 0.2], [1, 0]]);
    g.fillStyle = '#fff';
    for (const rot of [0, Math.PI / 2]) {
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      g.beginPath();
      g.moveTo(0, -30);
      g.quadraticCurveTo(2.5, 0, 0, 30);
      g.quadraticCurveTo(-2.5, 0, 0, -30);
      g.fill();
      g.restore();
    }
  });
  cell(S_COIN, (x, y) => {
    g.fillStyle = '#9a9a9a';
    g.beginPath();
    g.arc(x, y + 2, 25, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f2f2f2';
    g.beginPath();
    g.arc(x, y, 24, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#b5b5b5';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(x, y, 17, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(x - 8, y - 9, 6, 3.5, -0.7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#c4c4c4';
    g.font = 'bold 22px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('✿', x, y + 1);
  });
  cell(S_RING, (x, y) => {
    g.strokeStyle = '#fff';
    g.shadowColor = '#fff';
    g.shadowBlur = 6;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(x, y, 24, 0, Math.PI * 2);
    g.stroke();
  });
  cell(S_PIN, (x, y) => {
    g.translate(x, y);
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(0, 30);
    g.bezierCurveTo(-6, 16, -20, 4, -20, -10);
    g.arc(0, -10, 20, Math.PI, 0);
    g.bezierCurveTo(20, 4, 6, 16, 0, 30);
    g.fill();
    g.fillStyle = 'rgba(70,70,70,1)';
    g.beginPath();
    g.arc(0, -10, 8, 0, Math.PI * 2);
    g.fill();
  });
  cell(S_SHARD, (x, y) => {
    g.translate(x, y);
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(0, -28);
    g.lineTo(12, 0);
    g.lineTo(0, 28);
    g.lineTo(-12, 0);
    g.fill();
    g.fillStyle = '#bdbdbd';
    g.beginPath();
    g.moveTo(0, -28);
    g.lineTo(12, 0);
    g.lineTo(0, 28);
    g.fill();
  });
  cell(S_DOT, (x, y) => radial(x, y, 14, [[0, 1], [0.55, 1], [1, 0]]));
  const glyph = (i: number, ch: string) =>
    cell(i, (x, y) => {
      g.font = '900 54px system-ui, "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.lineWidth = 10;
      g.strokeStyle = 'rgb(70,40,12)';
      g.strokeText(ch, x, y + 3);
      g.fillStyle = '#fff';
      g.fillText(ch, x, y + 3);
    });
  glyph(S_PLUS, '+');
  for (let d = 0; d < 10; d++) glyph(S_DIGIT + d, String(d));
  const tex = new THREE.CanvasTexture(cv);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

// ---- instanced buffers ----------------------------------------------------------------------------------------------

/** A unit quad (x, y in -0.5..0.5) as an instanced geometry. */
function quadGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

/** Instanced interleaved attributes: `layout` lists [name, size] in order; returns the float array. */
function instance(geo: THREE.InstancedBufferGeometry, cap: number, layout: [string, number][]) {
  const stride = layout.reduce((s, l) => s + l[1], 0);
  const data = new Float32Array(cap * stride);
  const buf = new THREE.InstancedInterleavedBuffer(data, stride, 1);
  buf.setUsage(THREE.DynamicDrawUsage);
  let off = 0;
  for (const [name, size] of layout) {
    geo.setAttribute(name, new THREE.InterleavedBufferAttribute(buf, size, off));
    off += size;
  }
  geo.instanceCount = 0;
  return { data, buf, stride };
}

/** Ring buffer of spawn-once GPU-analytic instances. */
class SpawnRing {
  head = 0;
  private n = 0;
  private start = 0;
  private hi = 0;
  readonly data: Float32Array;
  readonly stride: number;
  private buf: THREE.InstancedInterleavedBuffer;
  constructor(
    private geo: THREE.InstancedBufferGeometry,
    readonly cap: number,
    layout: [string, number][],
  ) {
    const r = instance(geo, cap, layout);
    this.data = r.data;
    this.buf = r.buf;
    this.stride = r.stride;
  }
  /** Float offset of the next slot (overwrites the oldest when full). */
  alloc(): number {
    if (this.n === 0) this.start = this.head;
    const i = this.head;
    this.head = i + 1 === this.cap ? 0 : i + 1;
    this.n++;
    if (i + 1 > this.hi) {
      this.hi = i + 1;
      this.geo.instanceCount = this.hi;
    }
    return i * this.stride;
  }
  flush() {
    if (!this.n) return;
    const { buf, stride, cap, start, n } = this;
    buf.clearUpdateRanges();
    if (n >= cap) buf.addUpdateRange(0, cap * stride);
    else if (start + n <= cap) buf.addUpdateRange(start * stride, n * stride);
    else {
      buf.addUpdateRange(start * stride, (cap - start) * stride);
      buf.addUpdateRange(0, (n - (cap - start)) * stride);
    }
    buf.needsUpdate = true;
    this.n = 0;
  }
}

/** Instances rebuilt from scratch every frame. */
class FrameBatch {
  n = 0;
  readonly data: Float32Array;
  readonly stride: number;
  private buf: THREE.InstancedInterleavedBuffer;
  constructor(
    private geo: THREE.InstancedBufferGeometry,
    readonly cap: number,
    layout: [string, number][],
  ) {
    const r = instance(geo, cap, layout);
    this.data = r.data;
    this.buf = r.buf;
    this.stride = r.stride;
  }
  /** Float offset of the next slot, or -1 when full. */
  alloc(): number {
    if (this.n >= this.cap) return -1;
    return this.n++ * this.stride;
  }
  flush() {
    this.geo.instanceCount = this.n;
    if (this.n) {
      this.buf.clearUpdateRanges();
      this.buf.addUpdateRange(0, this.n * this.stride);
      this.buf.needsUpdate = true;
    }
    this.n = 0;
  }
}

// ---- shaders --------------------------------------------------------------------------------------------------------

const GLSL_TAIL = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

const PARTICLE_VS = /* glsl */ `
  attribute vec4 iP; // xyz, t0
  attribute vec4 iV; // velocity, life
  attribute vec4 iC; // rgb, alpha
  attribute vec4 iS; // size0, size1, drag, gravity
  attribute vec4 iM; // shape, spin, stretch, offset x (in sizes)
  attribute vec4 iF; // fade in, fade out start, floor y, rotation
  uniform float uTime;
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    float age = uTime - iP.w;
    float u = age / max(iV.w, 1e-4);
    if (iV.w <= 0.0 || u < 0.0 || u > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float k = iS.z;
    float e = exp(-k * age);
    float dist = k > 0.0 ? (1.0 - e) / k : age;
    vec3 p = iP.xyz + iV.xyz * dist;
    p.y -= 0.5 * iS.w * age * age;
    p.y = max(p.y, iF.z);
    vec3 vel = iV.xyz * e - vec3(0.0, iS.w * age, 0.0);
    float su = 1.0 - (1.0 - u) * (1.0 - u);
    float size = mix(iS.x, iS.y, su);
    vec4 mv = viewMatrix * vec4(p, 1.0);
    #ifdef DIST_SCALE
    size *= clamp(-mv.z / 18.0, 1.0, 3.5);
    #endif
    vec2 c = position.xy;
    vec2 off = vec2(0.0);
    if (iM.z > 0.0) {
      // Stretched along the screen-space velocity (sparks, droplets). The side axis is (dir.y, -dir.x) so the basis
      // is a rotation (det +1): the mirrored one flipped the quad's winding and back-face culling hid every spark.
      vec2 sv = (mat3(viewMatrix) * vel).xy;
      float sp = length(sv);
      vec2 dir = sp > 1e-4 ? sv / sp : vec2(0.0, 1.0);
      float stretch = 1.0 + iM.z * min(sp, 12.0);
      off = (vec2(dir.y, -dir.x) * c.x + dir * (c.y * stretch)) * size;
    } else {
      float r = iF.w + iM.y * age;
      float cs = cos(r), sn = sin(r);
      off = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
    }
    off.x += iM.w * size;
    mv.xy += off;
    gl_Position = projectionMatrix * mv;
    float a = iC.a * smoothstep(0.0, max(iF.x, 1e-4), u) * (1.0 - smoothstep(iF.y, 1.0, u));
    vCol = vec4(iC.rgb, a);
    float cx = mod(iM.x, 8.0);
    float cy = floor(iM.x / 8.0);
    vUv = vec2((cx + c.x + 0.5) / 8.0, 1.0 - (cy + 0.5 - c.y) / 8.0);
  }
`;
const PARTICLE_FS = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float a = t.a * vCol.a;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vCol.rgb * t.rgb, a);
    ${GLSL_TAIL}
  }
`;

const SPRITE_VS = /* glsl */ `
  attribute vec4 iP; // xyz, size
  attribute vec4 iC; // rgb, alpha
  attribute vec4 iM; // shape, rotation
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    vec4 mv = viewMatrix * vec4(iP.xyz, 1.0);
    vec2 c = position.xy;
    float cs = cos(iM.y), sn = sin(iM.y);
    mv.xy += vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * iP.w;
    gl_Position = projectionMatrix * mv;
    vCol = iC;
    float cx = mod(iM.x, 8.0);
    float cy = floor(iM.x / 8.0);
    vUv = vec2((cx + c.x + 0.5) / 8.0, 1.0 - (cy + 0.5 - c.y) / 8.0);
  }
`;

const RING_VS = /* glsl */ `
  attribute vec4 iP; // centre, t0
  attribute vec4 iR; // r0, r1, life, thickness
  attribute vec4 iC; // rgb, alpha
  attribute vec4 iX; // style, fade in, spin
  uniform float uTime;
  varying vec2 vL;
  varying float vU;
  varying vec4 vCol;
  varying vec4 vR;
  varying vec4 vX;
  void main() {
    float u = (uTime - iP.w) / max(iR.z, 1e-4);
    if (iR.z <= 0.0 || u < 0.0 || u > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float ext = max(iR.x, iR.y) + iR.w * 2.0;
    vL = position.xy * 2.0 * ext;
    vec3 p = iP.xyz + vec3(vL.x, 0.0, vL.y);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    vU = u;
    vCol = iC;
    vR = iR;
    vX = iX;
  }
`;
const RING_FS = /* glsl */ `
  uniform float uTime;
  varying vec2 vL;
  varying float vU;
  varying vec4 vCol;
  varying vec4 vR;
  varying vec4 vX;
  void main() {
    float u = vU;
    float e = 1.0 - (1.0 - u) * (1.0 - u) * (1.0 - u);
    float r = mix(vR.x, vR.y, e);
    float d = length(vL);
    float th = vR.w;
    float a;
    if (vX.x < 0.5) {
      float q = (d - r) / th;
      a = exp(-q * q * 2.0) + 0.25 * exp(-q * q * 0.25) * step(d, r);
    } else if (vX.x < 1.5) {
      a = 1.0 - smoothstep(r * 0.25, r, d);
      a *= a;
    } else if (vX.x < 2.5) {
      float ang = atan(vL.y, vL.x);
      float arms = 0.5 + 0.5 * sin(ang * 3.0 + d * 5.0 / max(r, 0.1) * 3.0 - (uTime * vX.z));
      float band = exp(-pow((d - r * 0.62) / (r * 0.32), 2.0));
      float rim = exp(-pow((d - r) / th, 2.0));
      a = band * arms * 0.9 + rim * 0.7;
    } else {
      // Blotch: a soft patch with a wobbly edge (wet ground, scorch); vX.z is a per-patch seed.
      float ang = atan(vL.y, vL.x);
      float wob = 1.0 + 0.12 * sin(ang * 5.0 + vX.z) + 0.07 * sin(ang * 11.0 + vX.z * 2.3);
      float rr = r * wob;
      a = (1.0 - smoothstep(rr * 0.5, rr, d)) * (0.8 + 0.2 * sin(d * 9.0 / max(r, 0.1) + vX.z));
    }
    a *= vCol.a * smoothstep(0.0, max(vX.y, 1e-4), u) * (1.0 - smoothstep(0.35, 1.0, u));
    if (a < 0.003) discard;
    gl_FragColor = vec4(vCol.rgb, min(a, 1.0));
    ${GLSL_TAIL}
  }
`;

const SEG_VS = /* glsl */ `
  attribute vec4 iA; // start, half width
  attribute vec4 iB; // end, seed
  attribute vec4 iC; // rgb, alpha
  attribute vec4 iK; // core ratio, scroll speed, pulse amount
  varying float vL;
  varying float vX;
  varying float vLen;
  varying float vHW;
  varying vec4 vCol;
  varying vec4 vK;
  varying float vSeed;
  void main() {
    vec3 a = iA.xyz;
    vec3 b = iB.xyz;
    float hw = iA.w;
    vec3 ax = b - a;
    float len = length(ax);
    vec3 d = len > 1e-5 ? ax / len : vec3(0.0, 1.0, 0.0);
    float along = mix(-hw, len + hw, position.y + 0.5);
    vec3 p = a + d * along;
    vec3 toCam = cameraPosition - p;
    vec3 side = cross(d, toCam);
    float sl = length(side);
    side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);
    p += side * position.x * 2.0 * hw;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    vL = along;
    vX = position.x * 2.0 * hw;
    vLen = len;
    vHW = hw;
    vCol = iC;
    vK = iK;
    vSeed = iB.w;
  }
`;
const SEG_FS = /* glsl */ `
  uniform float uTime;
  varying float vL;
  varying float vX;
  varying float vLen;
  varying float vHW;
  varying vec4 vCol;
  varying vec4 vK;
  varying float vSeed;
  void main() {
    float dl = max(0.0, max(-vL, vL - vLen));
    float d = length(vec2(dl, vX)) / vHW;
    if (d >= 1.0) discard;
    float s = vL * 2.4 - uTime * vK.y + vSeed * 13.0;
    float n = 0.5 + 0.3 * sin(s * 2.7) + 0.2 * sin(s * 6.9 + 1.3);
    float pulse = 0.5 + 0.5 * sin(vL * 4.5 - uTime * vK.y * 1.7 + vSeed);
    float coreR = vK.x * (0.8 + 0.4 * n);
    float core = 1.0 - smoothstep(coreR * 0.45, coreR, d);
    float g = 1.0 - d;
    float glow = (g * g * 1.1 + g * 0.25) * (0.6 + 0.4 * n) * (1.0 - vK.z + vK.z * (0.55 + 0.9 * pulse));
    float m = max(max(vCol.r, vCol.g), vCol.b);
    vec3 hot = mix(vCol.rgb, vec3(m), 0.5);
    vec3 c = vCol.rgb * glow * 1.2 + hot * core * 0.95;
    gl_FragColor = vec4(c, vCol.a);
    ${GLSL_TAIL}
  }
`;

const SHARD_VS = /* glsl */ `
  attribute vec4 iP; // xyz, t0
  attribute vec4 iV; // velocity, life
  attribute vec4 iA; // spin axis, spin rate
  attribute vec4 iC; // rgb, scale
  attribute vec4 iF; // floor, gravity
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vCol;
  varying vec3 vW;
  vec3 rot(vec3 v, vec3 k, float a) {
    float c = cos(a), s = sin(a);
    return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
  }
  void main() {
    float age = uTime - iP.w;
    float u = age / max(iV.w, 1e-4);
    if (iV.w <= 0.0 || u < 0.0 || u > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float g = iF.y;
    float h0 = iP.y - iF.x;
    float th = (iV.y + sqrt(iV.y * iV.y + 2.0 * g * max(h0, 0.0))) / g;
    float t = min(age, th);
    vec3 p = iP.xyz + iV.xyz * t;
    p.y -= 0.5 * g * t * t;
    p.y = max(p.y, iF.x);
    float sc = iC.w * (1.0 - smoothstep(0.7, 1.0, u)) * smoothstep(0.0, 0.06, u);
    vec3 ax = normalize(iA.xyz);
    float ang = iA.w * t + iP.w * 3.0;
    vec3 lp = rot(position * sc, ax, ang);
    vN = rot(normal, ax, ang);
    vW = p + lp;
    gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
    vCol = iC.rgb;
  }
`;
const SHARD_FS = /* glsl */ `
  varying vec3 vN;
  varying vec3 vCol;
  varying vec3 vW;
  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(cameraPosition - vW);
    float l = max(dot(n, normalize(vec3(0.4, 0.9, 0.3))), 0.0);
    float rim = pow(1.0 - abs(dot(n, v)), 2.0);
    float spec = pow(max(dot(reflect(-v, n), normalize(vec3(0.4, 0.9, 0.3))), 0.0), 18.0);
    vec3 c = vCol * (0.45 + 0.75 * l) + vCol * rim * 1.4 + vec3(spec) * 1.6;
    gl_FragColor = vec4(c, 1.0);
    ${GLSL_TAIL}
  }
`;

// Ground discs: 0 slow flower field, 1 beacon rune ring, 2 shield ground rim.
const DISC_VS = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// Idle fields are a faint rim only; slow rings / fill play only while uAct (an enemy inside) is up. Slow and beacon
// discs use MAX blending (MAXBLEND): overlapping fields cap at one field's brightness instead of stacking to white.
const DISC_FS = /* glsl */ `
  uniform float uTime;
  uniform float uMode;
  uniform float uLv;
  uniform float uAlpha;
  uniform float uR;
  uniform vec3 uCol;
  uniform float uFlash;
  uniform float uAct;
  varying vec2 vP;
  float hash(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
  float line(float d, float at, float w) { float q = (d - at) / w; return exp(-q * q); }
  void main() {
    float d = length(vP);
    if (d > 1.0) discard;
    float ang = atan(vP.y, vP.x);
    float px = 1.0 / max(uR, 0.5); // one metre in disc units
    float a = 0.0;
    if (uMode < 0.5) {
      // Slow field: scalloped rim at rest; while active a faint fill and rings that bloom outward from the flower.
      float edge = 1.0 - smoothstep(0.86, 1.0, d);
      float petals = 0.5 + 0.5 * cos(ang * 18.0 + uTime * 0.25);
      float rim = line(d, 0.965 - 0.012 * petals, 0.016 + 0.05 * px) * (0.75 + 0.35 * petals);
      float rings = 0.0;
      for (int k = 0; k < 3; k++) {
        float rp = fract(uTime * 0.22 + float(k) / 3.0);
        rings += line(d, rp, 0.05 * px + 0.012) * sin(rp * 3.14159) * 0.55;
      }
      float inner = line(d, 0.72, 0.012) * (0.5 + 0.5 * sin(ang * 6.0 - uTime * 0.6)) * 0.35;
      a = rim * (0.2 + 0.15 * uAct) + uAct * (edge * (0.03 + 0.01 * sin(uTime * 1.6)) + rings * edge * (0.25 + 0.1 * uLv) + inner * 0.5);
    } else if (uMode < 1.5) {
      // Beacon: one thin, slowly turning rune row between two hairline borders.
      float rot = uTime * 0.2;
      float band = smoothstep(0.88, 0.89, d) * (1.0 - smoothstep(0.92, 0.93, d));
      float aa = (ang + rot) / 6.28318 * 48.0;
      float cell = floor(aa);
      float f = fract(aa);
      float on = step(0.45, hash(cell * 3.7));
      float bar = step(0.2, f) * step(f, 0.8) * on;
      float tick = step(0.42, f) * step(f, 0.58) * (1.0 - on);
      float runes = band * max(bar, tick * 0.7);
      float borders = line(d, 0.875, 0.006) + line(d, 0.94, 0.006);
      float inner = 0.0;
      if (uLv > 2.5) {
        float a2 = (ang - rot * 0.8) / 6.28318 * 22.0;
        inner = line(d, 0.42, 0.02) * step(0.3, fract(a2)) * step(fract(a2), 0.7) * step(0.4, hash(floor(a2) + 9.0)) * 0.3;
      }
      float shimmer = 0.85 + 0.15 * sin(uTime * 1.2 + ang * 3.0);
      a = (runes * 0.35 + borders * 0.4 + inner) * shimmer * (0.85 + 0.05 * uLv) + line(d, 0.99, 0.02) * 0.25;
    } else {
      // Shield: warm line where the bubble meets the ground.
      a = line(d, 0.99, 0.014 + 0.1 * px) * (0.5 + uFlash) + (1.0 - smoothstep(0.8, 1.0, d)) * 0.09 * uFlash;
    }
    a *= uAlpha;
    if (a < 0.003) discard;
    #ifdef MAXBLEND
    // MAX blending ignores alpha: the colour itself is the strength (a lighten blend over the ground).
    // A little white keeps it reading as pale mint over green grass (MAX would otherwise only lift the blue channel).
    float s = min(a * 1.8, 1.0);
    gl_FragColor = vec4(uCol * s + s * 0.3, a);
    #else
    gl_FragColor = vec4(uCol * 0.85, a);
    #endif
    ${GLSL_TAIL}
  }
`;

const DOME_VS = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  varying vec3 vLocal;
  void main() {
    vLocal = position;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const DOME_FS = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  uniform float uLv;
  uniform float uFlash;
  uniform float uHex;
  uniform vec3 uCol;
  uniform vec4 uRip[4];
  varying vec3 vN;
  varying vec3 vW;
  varying vec3 vLocal;
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(cameraPosition - vW);
    float ndv = abs(dot(n, v));
    float fres = pow(1.0 - ndv, 3.0);
    // Hex grid on a gently warped top-down projection.
    vec2 q = vLocal.xz * (1.0 + (1.0 - vLocal.y) * 0.55) * uHex;
    vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 ga = mod(q, r) - h;
    vec2 gb = mod(q - h, r) - h;
    vec2 gv = dot(ga, ga) < dot(gb, gb) ? ga : gb;
    vec2 id = q - gv;
    vec2 ag = abs(gv);
    float hd = max(dot(ag, normalize(vec2(1.0, 1.7320508))), ag.x);
    float edge = 0.5 - hd;
    float ln = 1.0 - smoothstep(0.0, 0.05, edge);
    float cellR = hash2(id);
    float shimmer = 0.5 + 0.5 * sin(uTime * 1.3 + cellR * 6.2832);
    float lit = step(0.86, cellR) * (0.5 + 0.5 * sin(uTime * 0.9 + cellR * 40.0));
    vec3 dir = normalize(vLocal);
    float rip = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 R = uRip[i];
      float t = uTime - R.w;
      if (t >= 0.0 && t < 1.1) {
        float ang = acos(clamp(dot(dir, R.xyz), -1.0, 1.0));
        float front = t * 2.8;
        float k = (ang - front) / 0.16;
        rip += exp(-k * k) * (1.0 - t / 1.1) * (1.0 + 2.0 * exp(-ang * 5.0) * (1.0 - t / 0.3));
      }
    }
    float base = 0.015 + 0.008 * uLv;
    float a = base + ln * (0.03 + 0.08 * fres) * (0.55 + 0.45 * shimmer) + lit * 0.025 + pow(fres, 2.2) * 0.08;
    a += rip * (0.25 + ln * 1.2) + uFlash * (0.08 + ln * 0.35 + fres * 0.4);
    float foot = smoothstep(0.0, 0.08, vLocal.y);
    a *= uAlpha * mix(1.1, 1.0, foot);
    if (!gl_FrontFacing) a *= 0.45;
    vec3 c = uCol * (1.0 + fres * 0.3 + rip * 0.8 + uFlash * 0.5);
    gl_FragColor = vec4(c, a);
    ${GLSL_TAIL}
  }
`;

// Sprinkler water bomb: translucent blue with a pale fresnel rim and a white highlight (instanced spheres).
const BOMB_VS = /* glsl */ `
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vec4 w = m * vec4(position, 1.0);
    vN = normalize(mat3(m) * normal);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const BOMB_FS = /* glsl */ `
  uniform vec3 uCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(cameraPosition - vW);
    vec3 l = normalize(vec3(0.4, 0.9, 0.3));
    float ndv = abs(dot(n, v));
    float fres = pow(1.0 - ndv, 2.2);
    float diff = max(dot(n, l), 0.0);
    float spec = pow(max(dot(reflect(-l, n), v), 0.0), 40.0);
    vec3 c = uCol * (0.55 + 0.45 * diff) + vec3(0.75, 0.93, 1.0) * fres * 0.9 + vec3(spec) * 2.2;
    gl_FragColor = vec4(c, min(1.0, 0.62 + 0.33 * fres + spec));
    ${GLSL_TAIL}
  }
`;

// Sunburst aiming reticle: a warm dashed rim turning slowly, inner ring, four ticks and a soft fill, pulsing.
const AIM_FS = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  uniform float uR;
  uniform vec3 uCol;
  varying vec2 vP;
  float line(float d, float at, float w) { float q = (d - at) / w; return exp(-q * q); }
  void main() {
    float d = length(vP);
    if (d > 1.0) discard;
    float ang = atan(vP.y, vP.x);
    float px = 1.0 / max(uR, 0.5);
    float pulse = 0.82 + 0.18 * sin(uTime * 4.2);
    float dash = step(0.42, fract(ang / 6.28318 * 28.0 + uTime * 0.35));
    float rim = line(d, 0.96, 0.012 + 0.02 * px) * dash + line(d, 0.985, 0.006 + 0.01 * px) * 0.35;
    float inner = line(d, 0.62 + 0.03 * sin(uTime * 4.2), 0.008 + 0.012 * px) * 0.45;
    float cr = abs(cos(ang * 2.0));
    float ticks = smoothstep(0.996, 0.999, cr) * step(0.74, d) * step(d, 0.88);
    float dot0 = 1.0 - smoothstep(0.015, 0.025 + 0.03 * px, d);
    float fill = (1.0 - smoothstep(0.3, 1.0, d)) * 0.12 + (1.0 - smoothstep(0.85, 0.97, d)) * 0.05;
    float a = (rim * 0.85 + inner + ticks * 0.7 + dot0 * 0.6) * pulse + fill;
    a *= uAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uCol, min(a, 1.0));
    ${GLSL_TAIL}
  }
`;

// ---- pools ----------------------------------------------------------------------------------------------------------

interface BeamState {
  tw: number;
  seen: number;
  alpha: number;
  lv: Level;
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
  chain: number[]; // up to 4 points, xyz
  chainN: number;
  sparkAcc: number;
  seed: number;
}

interface Missile {
  active: boolean;
  mid: number;
  fx: number;
  fy: number;
  fz: number;
  cx: number;
  cy: number;
  cz: number;
  tx: number;
  ty: number;
  tz: number;
  px: number;
  py: number;
  pz: number;
  dx: number;
  dy: number;
  dz: number;
  target: () => P3 | null;
  ft: number;
  age: number;
  side: number;
  lift: number;
  trail: number;
}

interface Bomb {
  active: boolean;
  mid: number;
  fx: number;
  fy: number;
  fz: number;
  tx: number;
  ty: number;
  tz: number;
  px: number;
  py: number;
  pz: number;
  target: () => P3 | null;
  ft: number;
  age: number;
  apex: number;
  trail: number;
  phase: number;
}

interface Sunburst {
  active: boolean;
  x: number;
  y: number;
  z: number;
  r: number;
  t0: number;
  acc: number;
}

interface Arc {
  active: boolean;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  col: RGB;
  w: number;
  t0: number;
  life: number;
  seed: number;
  segs: number;
  amp: number;
}

interface Field {
  tw: number;
  kind: 'slow' | 'shield' | 'beacon';
  x: number;
  y: number;
  z: number;
  r: number;
  target: number;
  lv: Level;
  alpha: number;
  dying: boolean;
  acc: number;
  disc: THREE.Mesh;
  discMat: THREE.ShaderMaterial;
  dome: THREE.Mesh | null;
  domeMat: THREE.ShaderMaterial | null;
  ripN: number;
  flash: number;
  /** Slow field: an enemy is inside (set by Fx.fieldActive); act eases towards it. */
  active: boolean;
  act: number;
}

interface Disabled {
  x: number;
  y: number;
  z: number;
  acc: number;
  arc: number;
}

/** Particle spawn template (mutated in place; `emit` reads it). */
interface PSpec {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  r: number;
  g: number;
  b: number;
  a: number;
  s0: number;
  s1: number;
  drag: number;
  grav: number;
  shape: number;
  spin: number;
  stretch: number;
  offX: number;
  fadeIn: number;
  fadeOut: number;
  floor: number;
  rot: number;
  delay: number;
}

// ---- the effects ----------------------------------------------------------------------------------------------------

export const createFx: CreateFx = (scene: THREE.Scene, quality: Quality) => {
  let q = QUALITY_MULT[quality];
  let time = 0;
  const group = new THREE.Group();
  group.name = 'garden-fx';
  scene.add(group);
  const atlas = makeAtlas();
  const uTime = { value: 0 };

  const transparent = (m: THREE.ShaderMaterial, additive: boolean) => {
    m.transparent = true;
    m.depthWrite = false;
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    return m;
  };
  const addMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, order: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = order;
    group.add(m);
    return m;
  };

  // Particle systems.
  const PLAYOUT: [string, number][] = [
    ['iP', 4],
    ['iV', 4],
    ['iC', 4],
    ['iS', 4],
    ['iM', 4],
    ['iF', 4],
  ];
  const makeParticles = (cap: number, additive: boolean, order: number, overlay = false) => {
    const geo = quadGeometry();
    const ring = new SpawnRing(geo, cap, PLAYOUT);
    const mat = transparent(new THREE.ShaderMaterial({ uniforms: { uTime, uMap: { value: atlas } }, vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS }), additive);
    if (overlay) {
      mat.depthTest = false;
      mat.defines = { DIST_SCALE: 1 };
    }
    addMesh(geo, mat, order);
    return { ring, geo, mat };
  };
  const add = makeParticles(14000, true, 6);
  const soft = makeParticles(6000, false, 5);
  const text = makeParticles(1536, false, 20, true);

  const P: PSpec = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, r: 1, g: 1, b: 1, a: 1, s0: 0.1, s1: 0.1, drag: 0, grav: 0, shape: 0, spin: 0, stretch: 0, offX: 0, fadeIn: 0.05, fadeOut: 0.6, floor: -1e4, rot: 0, delay: 0 };
  const reset = (x: number, y: number, z: number, shape: number, life: number) => {
    P.x = x;
    P.y = y;
    P.z = z;
    P.vx = P.vy = P.vz = 0;
    P.life = life;
    P.r = P.g = P.b = P.a = 1;
    P.s0 = P.s1 = 0.1;
    P.drag = P.grav = P.spin = P.stretch = P.offX = P.rot = P.delay = 0;
    P.shape = shape;
    P.fadeIn = 0.05;
    P.fadeOut = 0.6;
    P.floor = -1e4;
  };
  const col = (c: RGB, k = 1) => {
    P.r = c[0] * k;
    P.g = c[1] * k;
    P.b = c[2] * k;
  };
  const emit = (sys: { ring: SpawnRing }) => {
    const r = sys.ring;
    const o = r.alloc();
    const d = r.data;
    d[o] = P.x;
    d[o + 1] = P.y;
    d[o + 2] = P.z;
    d[o + 3] = time + P.delay;
    d[o + 4] = P.vx;
    d[o + 5] = P.vy;
    d[o + 6] = P.vz;
    d[o + 7] = P.life;
    d[o + 8] = P.r;
    d[o + 9] = P.g;
    d[o + 10] = P.b;
    d[o + 11] = P.a;
    d[o + 12] = P.s0;
    d[o + 13] = P.s1;
    d[o + 14] = P.drag;
    d[o + 15] = P.grav;
    d[o + 16] = P.shape;
    d[o + 17] = P.spin;
    d[o + 18] = P.stretch;
    d[o + 19] = P.offX;
    d[o + 20] = P.fadeIn;
    d[o + 21] = P.fadeOut;
    d[o + 22] = P.floor;
    d[o + 23] = P.rot;
  };
  const n = (count: number) => Math.max(1, Math.round(count * q));

  // Ground rings.
  // Rings and swirls use normal blending (it keeps the hue: additive amber on green grass turns yellow; HDR colours
  // still bloom); soft disc flashes are additive (a translucent pink disc over grass would read brown).
  const makeRings = (additive: boolean) => {
    const geo = quadGeometry();
    const r = new SpawnRing(geo, 512, [
      ['iP', 4],
      ['iR', 4],
      ['iC', 4],
      ['iX', 4],
    ]);
    const mat = transparent(new THREE.ShaderMaterial({ uniforms: { uTime }, vertexShader: RING_VS, fragmentShader: RING_FS }), additive);
    mat.side = THREE.DoubleSide;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -4;
    addMesh(geo, mat, 2);
    return { r, geo, mat };
  };
  const ringsN = makeRings(false);
  const ringsA = makeRings(true);
  /** style 0 ring, 1 soft disc flash, 2 swirl. */
  const ring = (x: number, y: number, z: number, r0: number, r1: number, life: number, thick: number, c: RGB, a: number, style = 0, delay = 0, spin = 6) => {
    const rings = style === 1 ? ringsA.r : ringsN.r;
    const o = rings.alloc();
    const d = rings.data;
    d[o] = x;
    d[o + 1] = y + 0.04;
    d[o + 2] = z;
    d[o + 3] = time + delay;
    d[o + 4] = r0;
    d[o + 5] = r1;
    d[o + 6] = life;
    d[o + 7] = thick;
    d[o + 8] = c[0];
    d[o + 9] = c[1];
    d[o + 10] = c[2];
    d[o + 11] = a;
    d[o + 12] = style;
    d[o + 13] = 0.06;
    d[o + 14] = spin;
    d[o + 15] = 0;
  };

  // Crystal shards.
  const shardGeo = new THREE.InstancedBufferGeometry();
  {
    const oct = new THREE.OctahedronGeometry(1, 0);
    oct.scale(0.55, 1.2, 0.55);
    oct.computeVertexNormals();
    shardGeo.setAttribute('position', oct.getAttribute('position'));
    shardGeo.setAttribute('normal', oct.getAttribute('normal'));
  }
  const shards = new SpawnRing(shardGeo, 2048, [
    ['iP', 4],
    ['iV', 4],
    ['iA', 4],
    ['iC', 4],
    ['iF', 4],
  ]);
  const shardMat = new THREE.ShaderMaterial({ uniforms: { uTime }, vertexShader: SHARD_VS, fragmentShader: SHARD_FS });
  addMesh(shardGeo, shardMat, 0);
  const shard = (x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, cr: number, cg: number, cb: number, scale: number, floor: number) => {
    const o = shards.alloc();
    const d = shards.data;
    randDir();
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = time;
    d[o + 4] = vx;
    d[o + 5] = vy;
    d[o + 6] = vz;
    d[o + 7] = life;
    d[o + 8] = D.x;
    d[o + 9] = D.y;
    d[o + 10] = D.z;
    d[o + 11] = rnd(6, 14) * (Math.random() < 0.5 ? -1 : 1);
    d[o + 12] = cr;
    d[o + 13] = cg;
    d[o + 14] = cb;
    d[o + 15] = scale;
    d[o + 16] = floor;
    d[o + 17] = 14;
  };

  // Segments (beams, arcs) and glow sprites, rebuilt each frame.
  const segGeo = quadGeometry();
  const segs = new FrameBatch(segGeo, 2048, [
    ['iA', 4],
    ['iB', 4],
    ['iC', 4],
    ['iK', 4],
  ]);
  const segMat = transparent(new THREE.ShaderMaterial({ uniforms: { uTime }, vertexShader: SEG_VS, fragmentShader: SEG_FS }), true);
  segMat.side = THREE.DoubleSide;
  addMesh(segGeo, segMat, 4);
  const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, hw: number, c: RGB, a: number, core: number, scroll: number, pulse: number, seed: number) => {
    const o = segs.alloc();
    if (o < 0) return;
    const d = segs.data;
    d[o] = ax;
    d[o + 1] = ay;
    d[o + 2] = az;
    d[o + 3] = hw;
    d[o + 4] = bx;
    d[o + 5] = by;
    d[o + 6] = bz;
    d[o + 7] = seed;
    d[o + 8] = c[0];
    d[o + 9] = c[1];
    d[o + 10] = c[2];
    d[o + 11] = a;
    d[o + 12] = core;
    d[o + 13] = scroll;
    d[o + 14] = pulse;
    d[o + 15] = 0;
  };

  const spriteGeo = quadGeometry();
  const sprites = new FrameBatch(spriteGeo, 2048, [
    ['iP', 4],
    ['iC', 4],
    ['iM', 4],
  ]);
  const spriteMat = transparent(new THREE.ShaderMaterial({ uniforms: { uMap: { value: atlas } }, vertexShader: SPRITE_VS, fragmentShader: PARTICLE_FS }), true);
  addMesh(spriteGeo, spriteMat, 7);
  const sprite = (x: number, y: number, z: number, size: number, c: RGB, k: number, a: number, shape = S_GLOW, rot = 0) => {
    const o = sprites.alloc();
    if (o < 0) return;
    const d = sprites.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = size;
    d[o + 4] = c[0] * k;
    d[o + 5] = c[1] * k;
    d[o + 6] = c[2] * k;
    d[o + 7] = a;
    d[o + 8] = shape;
    d[o + 9] = rot;
  };

  /** A crackling arc from a to b: `count` jittered sub-segments that re-roll ~24 times a second. */
  const arc = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: RGB, hw: number, a: number, count: number, amp: number, seed: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1;
    // Two unit vectors perpendicular to the arc.
    let ux = -dz;
    let uy = 0;
    let uz = dx;
    let ul = Math.hypot(ux, uz);
    if (ul < 1e-4) {
      ux = 1;
      uz = 0;
      ul = 1;
    }
    ux /= ul;
    uz /= ul;
    const vx = (dy * uz - dz * uy) / len;
    const vy = (dz * ux - dx * uz) / len;
    const vz = (dx * uy - dy * ux) / len;
    const tick = Math.floor(time * 24);
    let px = ax;
    let py = ay;
    let pz = az;
    const am = amp * Math.min(1, len * 0.35);
    for (let i = 1; i <= count; i++) {
      const t = i / count;
      let qx = ax + dx * t;
      let qy = ay + dy * t;
      let qz = az + dz * t;
      if (i < count) {
        const env = Math.sin(t * Math.PI) * am;
        const h1 = (hash(seed * 7.1 + i * 3.3 + tick * 1.7) - 0.5) * 2 * env;
        const h2 = (hash(seed * 3.9 + i * 5.1 + tick * 2.3) - 0.5) * 2 * env;
        qx += ux * h1 + vx * h2;
        qy += uy * h1 + vy * h2;
        qz += uz * h1 + vz * h2;
      }
      seg(px, py, pz, qx, qy, qz, hw, c, a, 0.32, 0, 0, seed + i);
      px = qx;
      py = qy;
      pz = qz;
    }
  };

  // Missiles: one instanced mesh.
  const MISSILES = 256;
  const missileGeo = (() => {
    const tint = (g: THREE.BufferGeometry, hex: number) => {
      const c = new THREE.Color(hex);
      const cnt = g.getAttribute('position').count;
      const a = new Float32Array(cnt * 3);
      for (let i = 0; i < cnt; i++) a.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g;
    };
    const body = tint(new THREE.CylinderGeometry(0.065, 0.075, 0.3, 10).rotateX(Math.PI / 2), 0xf5e7d6);
    const band = tint(new THREE.CylinderGeometry(0.078, 0.078, 0.05, 10).rotateX(Math.PI / 2).translate(0, 0, 0.06), 0xffa940);
    const nose = tint(new THREE.ConeGeometry(0.065, 0.14, 10).rotateX(Math.PI / 2).translate(0, 0, 0.22), 0xffa940);
    const fin1 = tint(new THREE.BoxGeometry(0.26, 0.02, 0.09).translate(0, 0, -0.12), 0xc9773a);
    const fin2 = tint(new THREE.BoxGeometry(0.02, 0.26, 0.09).translate(0, 0, -0.12), 0xc9773a);
    const g = mergeGeometries([body, band, nose, fin1, fin2])!;
    for (const p of [body, band, nose, fin1, fin2]) p.dispose();
    return g;
  })();
  const missileMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15, emissive: 0x3a1e05 });
  const missileMesh = new THREE.InstancedMesh(missileGeo, missileMat, MISSILES);
  missileMesh.frustumCulled = false;
  missileMesh.count = 0;
  group.add(missileMesh);
  const missiles: Missile[] = [];
  const noTarget = () => null;
  for (let i = 0; i < MISSILES; i++)
    missiles.push({ active: false, mid: 0, fx: 0, fy: 0, fz: 0, cx: 0, cy: 0, cz: 0, tx: 0, ty: 0, tz: 0, px: 0, py: 0, pz: 0, dx: 0, dy: 0, dz: 1, target: noTarget, ft: 1, age: 0, side: 0, lift: 0, trail: 0 });
  const missileById = new Map<number, Missile>();
  const mtx = new THREE.Matrix4();
  const mq = new THREE.Quaternion();
  const mpos = new THREE.Vector3();
  const mdir = new THREE.Vector3();
  const mscale = new THREE.Vector3(1, 1, 1);
  const FWD = new THREE.Vector3(0, 0, 1);

  // Sprinkler water bombs: one instanced mesh of wobbling translucent spheres.
  const BOMBS = 192;
  const bombGeo = new THREE.SphereGeometry(0.2, 18, 12);
  const bombMat = new THREE.ShaderMaterial({ uniforms: { uCol: { value: new THREE.Vector3(WATER[0], WATER[1], WATER[2]) } }, vertexShader: BOMB_VS, fragmentShader: BOMB_FS });
  bombMat.transparent = true;
  bombMat.depthWrite = false;
  const bombMesh = new THREE.InstancedMesh(bombGeo, bombMat, BOMBS);
  bombMesh.frustumCulled = false;
  bombMesh.count = 0;
  bombMesh.renderOrder = 4;
  group.add(bombMesh);
  const bombs: Bomb[] = [];
  for (let i = 0; i < BOMBS; i++) bombs.push({ active: false, mid: 0, fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, px: 0, py: 0, pz: 0, target: noTarget, ft: 1, age: 0, apex: 3, trail: 0, phase: 0 });
  const bombById = new Map<number, Bomb>();
  const UP = new THREE.Vector3(0, 1, 0);

  // Sunbursts in flight (the beam lasts ~0.45 s; everything else is spawn-once).
  const suns: Sunburst[] = [];
  for (let i = 0; i < 6; i++) suns.push({ active: false, x: 0, y: 0, z: 0, r: 4, t0: 0, acc: 0 });
  let sunHead = 0;

  // Beams.
  const beamPool: BeamState[] = [];
  const beamsById = new Map<number, BeamState>();
  const newBeam = (): BeamState => ({ tw: 0, seen: 0, alpha: 0, lv: 1, fx: 0, fy: 0, fz: 0, tx: 0, ty: 0, tz: 0, chain: new Array(12).fill(0), chainN: 0, sparkAcc: 0, seed: 0 });

  // Timed arcs (disrupt bolts, static).
  const arcs: Arc[] = [];
  for (let i = 0; i < 96; i++) arcs.push({ active: false, ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, col: VIOLET, w: 0.05, t0: 0, life: 0.3, seed: 0, segs: 8, amp: 0.3 });
  let arcHead = 0;
  const timedArc = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: RGB, w: number, life: number, count: number, amp: number) => {
    const a = arcs[arcHead];
    arcHead = (arcHead + 1) % arcs.length;
    a.active = true;
    a.ax = ax;
    a.ay = ay;
    a.az = az;
    a.bx = bx;
    a.by = by;
    a.bz = bz;
    a.col = c;
    a.w = w;
    a.t0 = time;
    a.life = life;
    a.seed = Math.random() * 1000;
    a.segs = count;
    a.amp = amp;
  };

  // Fields.
  const fields = new Map<number, Field>();
  const dyingFields: Field[] = [];
  const discGeo = new THREE.PlaneGeometry(2, 2, 1, 1).rotateX(-Math.PI / 2);
  const domeGeo = new THREE.SphereGeometry(1, 56, 20, 0, Math.PI * 2, 0, Math.PI / 2);
  const SLOW_COL = lin(0x4ee6d9, 0.9);
  const BEACON_COL = lin(0x3ff0c8, 1.7);
  const SHIELD_COL = lin(0xff9a30, 1.25);
  const SHIELD_COL3 = lin(0xffc65a, 1.4);
  const makeField = (tw: number, kind: Field['kind'], at: P3, radius: number, lv: Level): Field => {
    const mode = kind === 'slow' ? 0 : kind === 'beacon' ? 1 : 2;
    const c = kind === 'slow' ? SLOW_COL : kind === 'beacon' ? BEACON_COL : lv === 3 ? SHIELD_COL3 : SHIELD_COL;
    const discMat = transparent(
      new THREE.ShaderMaterial({
        uniforms: { uTime, uMode: { value: mode }, uLv: { value: lv }, uAlpha: { value: 0 }, uR: { value: radius }, uCol: { value: new THREE.Vector3(c[0], c[1], c[2]) }, uFlash: { value: 0 }, uAct: { value: 0 } },
        defines: kind === 'shield' ? {} : { MAXBLEND: 1 },
        vertexShader: DISC_VS,
        fragmentShader: DISC_FS,
      }),
      true,
    );
    if (kind === 'shield') discMat.blending = THREE.NormalBlending;
    else {
      // Lighten, not add: overlapping slow / beacon discs never get brighter than one of them.
      discMat.blending = THREE.CustomBlending;
      discMat.blendEquation = THREE.MaxEquation;
      discMat.blendEquationAlpha = THREE.MaxEquation;
    }
    discMat.polygonOffset = true;
    discMat.polygonOffsetFactor = -1;
    discMat.polygonOffsetUnits = -2;
    const disc = addMesh(discGeo, discMat, 1);
    disc.position.set(at.x, at.y + 0.035, at.z);
    disc.scale.setScalar(0.001);
    let dome: THREE.Mesh | null = null;
    let domeMat: THREE.ShaderMaterial | null = null;
    if (kind === 'shield') {
      const rip: THREE.Vector4[] = [];
      for (let i = 0; i < 4; i++) rip.push(new THREE.Vector4(0, 1, 0, -100));
      domeMat = transparent(
        new THREE.ShaderMaterial({
          uniforms: { uTime, uAlpha: { value: 0 }, uLv: { value: lv }, uFlash: { value: 0 }, uHex: { value: 7 }, uCol: { value: new THREE.Vector3(c[0], c[1], c[2]) }, uRip: { value: rip } },
          vertexShader: DOME_VS,
          fragmentShader: DOME_FS,
        }),
        false,
      );
      domeMat.side = THREE.DoubleSide;
      dome = addMesh(domeGeo, domeMat, 3);
      dome.position.set(at.x, at.y, at.z);
      dome.scale.setScalar(0.001);
    }
    return { tw, kind, x: at.x, y: at.y, z: at.z, r: 0, target: radius, lv, alpha: 0, dying: false, acc: 0, disc, discMat, dome, domeMat, ripN: 0, flash: 0, active: false, act: 0 };
  };
  const disposeField = (f: Field) => {
    group.remove(f.disc);
    f.discMat.dispose();
    if (f.dome) group.remove(f.dome);
    f.domeMat?.dispose();
  };
  const ripple = (f: Field, dx: number, dy: number, dz: number) => {
    if (!f.domeMat) return;
    const l = Math.hypot(dx, dy, dz) || 1;
    const v = (f.domeMat.uniforms.uRip.value as THREE.Vector4[])[f.ripN];
    f.ripN = (f.ripN + 1) % 4;
    v.set(dx / l, dy / l, dz / l, time);
  };
  const DOME_H = 0.62;
  /** Shield covering a point (horizontal distance), if any. */
  const shieldAt = (x: number, z: number): Field | null => {
    let best: Field | null = null;
    let bd = Infinity;
    for (const f of fields.values()) {
      if (f.kind !== 'shield') continue;
      const d = Math.hypot(x - f.x, z - f.z);
      if (d < f.target + 0.3 && d < bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  };

  const disabledMap = new Map<number, Disabled>();

  // Sunburst aiming reticle (one disc, hidden until sunAim gets a point).
  const aimMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uAlpha: { value: 0 }, uR: { value: 4 }, uCol: { value: new THREE.Vector3(AIM_COL[0], AIM_COL[1], AIM_COL[2]) } },
    vertexShader: DISC_VS,
    fragmentShader: AIM_FS,
  });
  transparent(aimMat, false);
  aimMat.polygonOffset = true;
  aimMat.polygonOffsetFactor = -3;
  aimMat.polygonOffsetUnits = -6;
  const aim = addMesh(discGeo, aimMat, 3);
  aim.visible = false;
  let aimOn = false;
  let aimAlpha = 0;

  // ---- effect recipes -------------------------------------------------------------------------------------------

  const sparkBurst = (x: number, y: number, z: number, count: number, c: RGB, k: number, speed: number, life: number, size: number, up = false, floor = -1e4) => {
    for (let i = 0; i < count; i++) {
      randDir(up);
      const s = speed * rnd(0.4, 1);
      reset(x, y, z, S_SPARK, life * rnd(0.6, 1.1));
      P.vx = D.x * s;
      P.vy = D.y * s + (up ? speed * 0.3 : 0);
      P.vz = D.z * s;
      P.drag = 2.5;
      P.grav = 6;
      P.stretch = 0.09;
      P.s0 = size;
      P.s1 = size * 0.3;
      P.fadeOut = 0.4;
      P.floor = floor;
      col(c, k * rnd(0.8, 1.3));
      emit(add);
    }
  };
  const flash = (x: number, y: number, z: number, size: number, c: RGB, k: number, life: number) => {
    reset(x, y, z, S_GLOW, life);
    P.s0 = size * 0.6;
    P.s1 = size;
    P.fadeIn = 0.02;
    P.fadeOut = 0.15;
    col(c, k);
    emit(add);
  };
  const puff = (x: number, y: number, z: number, count: number, c: RGB, k: number, size: number, speed: number, life: number, rise: number, alpha = 0.55) => {
    for (let i = 0; i < count; i++) {
      randDir(true);
      reset(x + D.x * size * 0.3, y + D.y * size * 0.2, z + D.z * size * 0.3, S_SMOKE, life * rnd(0.7, 1.2));
      const s = speed * rnd(0.4, 1);
      P.vx = D.x * s;
      P.vy = D.y * s * 0.5 + rise;
      P.vz = D.z * s;
      P.drag = 2.2;
      P.grav = -rise * 0.3;
      P.s0 = size * rnd(0.4, 0.7);
      P.s1 = size * rnd(1.2, 1.7);
      P.spin = rnd(-1, 1);
      P.rot = Math.random() * 6.28;
      P.a = alpha;
      P.fadeIn = 0.08;
      P.fadeOut = 0.35;
      col(c, k * rnd(0.9, 1.05));
      emit(soft);
    }
  };
  const confetti = (x: number, y: number, z: number, count: number, shape: number, cols: RGB[], speed: number, life: number, size: number, floor: number) => {
    for (let i = 0; i < count; i++) {
      randDir(true);
      reset(x, y, z, shape, life * rnd(0.7, 1.2));
      const s = speed * rnd(0.5, 1);
      P.vx = D.x * s;
      P.vy = D.y * s * 0.8 + speed * 0.5;
      P.vz = D.z * s;
      P.drag = 1.6;
      P.grav = 3.2;
      P.s0 = P.s1 = size * rnd(0.7, 1.2);
      P.spin = rnd(-7, 7);
      P.rot = Math.random() * 6.28;
      P.floor = floor;
      P.fadeOut = 0.75;
      col(pick(cols), rnd(0.85, 1.05));
      emit(soft);
    }
  };
  const goldText = (x: number, y: number, z: number, gold: number) => {
    // Digits right to left, then layout: coin, '+', digits.
    let v = Math.max(1, Math.round(gold));
    let digits = 0;
    for (let t = v; t > 0; t = Math.floor(t / 10)) digits++;
    const glyphs = digits + 2;
    const adv = 0.58;
    const x0 = -((glyphs - 1) * adv) / 2;
    const put = (i: number, shape: number, c: RGB, k: number, sz: number) => {
      reset(x, y, z, shape, 1.25);
      P.vy = 1.7;
      P.drag = 2.4;
      P.s0 = sz * 1.35;
      P.s1 = sz;
      P.offX = (x0 + i * adv) / sz * 0.42;
      P.fadeIn = 0.06;
      P.fadeOut = 0.62;
      col(c, k);
      emit(text);
    };
    put(0, S_COIN, GOLD, 1.25, 0.48);
    put(1, S_PLUS, GOLD, 1.15, 0.42);
    for (let i = digits - 1; i >= 0; i--) {
      put(2 + i, S_DIGIT + (v % 10), GOLD, 1.15, 0.42);
      v = Math.floor(v / 10);
    }
  };
  const boomAt = (x: number, y: number, z: number, radius: number) => {
    const s = Math.max(0.6, radius);
    const gy = Math.max(0, y - 0.5);
    const cy = gy + 0.35 * s;
    flash(x, cy + 0.3 * s, z, s * 2, BOOM_FLASH, 1.4, 0.13);
    // Fireball: solid warm puffs that swell, then cream smoke rolling up after them.
    for (let i = 0; i < n(9); i++) {
      randDir(true);
      reset(x + D.x * s * 0.15, cy + D.y * s * 0.2, z + D.z * s * 0.15, S_SMOKE, rnd(0.28, 0.42));
      const sp = s * rnd(2, 3.4);
      P.vx = D.x * sp;
      P.vy = D.y * sp * 0.6 + 0.8;
      P.vz = D.z * sp;
      P.drag = 6;
      P.s0 = s * 0.35;
      P.s1 = s * rnd(0.8, 1.05);
      P.rot = Math.random() * 6.28;
      P.spin = rnd(-2, 2);
      P.a = 0.95;
      P.fadeIn = 0.03;
      P.fadeOut = 0.45;
      col(i % 4 === 0 ? FIRE_A : i % 4 === 1 ? AMBER : FIRE_B, rnd(1.05, 1.35));
      emit(soft);
    }
    for (let i = 0; i < n(3); i++) {
      reset(x + rnd(-0.2, 0.2) * s, cy + 0.2 * s, z + rnd(-0.2, 0.2) * s, S_GLOW, 0.22);
      P.s0 = s * 0.9;
      P.s1 = s * 1.4;
      P.fadeIn = 0.02;
      P.fadeOut = 0.2;
      col(AMBER, 1.2);
      emit(add);
    }
    sparkBurst(x, cy, z, n(20 + s * 6), BOOM_SPARK, 4, 8 * Math.sqrt(s), 0.6, 0.18, true, gy + 0.02);
    ring(x, gy, z, s * 0.25, s * 1.25, 0.45, 0.09 * s, BOOM_RING, 0.9, 0);
    ring(x, gy, z, 0, s * 1.0, 0.35, 0.3, BOOM_DISC, 0.45, 1);
    for (let i = 0; i < n(8); i++) {
      randDir(true);
      reset(x + D.x * s * 0.4, cy + D.y * s * 0.3, z + D.z * s * 0.4, S_SMOKE, rnd(1, 1.5));
      P.delay = rnd(0.08, 0.16);
      P.vx = D.x * s * 1.2;
      P.vy = 0.7 + D.y * s * 0.6;
      P.vz = D.z * s * 1.2;
      P.drag = 2.5;
      P.grav = -0.2;
      P.s0 = s * 0.55;
      P.s1 = s * rnd(1.1, 1.5);
      P.rot = Math.random() * 6.28;
      P.spin = rnd(-0.8, 0.8);
      P.a = 0.5;
      P.fadeIn = 0.12;
      P.fadeOut = 0.4;
      col(CREAM, rnd(0.8, 0.95));
      emit(soft);
    }
    confetti(x, y + 0.2, z, n(5), S_LEAF, BOOM_LEAVES, 3.5, 1.4, 0.16, gy + 0.02);
  };

  /** Water droplets: small stretched blue dots thrown out and falling to `floor`. */
  const droplets = (x: number, y: number, z: number, count: number, speed: number, up: number, size: number, floor: number, spread: number) => {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * 6.283;
      const rr = Math.random() * spread;
      reset(x + Math.cos(a) * rr, y, z + Math.sin(a) * rr, S_DOT, rnd(0.45, 0.8));
      const sp = speed * rnd(0.5, 1);
      P.vx = Math.cos(a) * sp;
      P.vy = up * rnd(0.6, 1.15);
      P.vz = Math.sin(a) * sp;
      P.drag = 1.2;
      P.grav = 11;
      P.s0 = size * rnd(0.7, 1.2);
      P.s1 = P.s0 * 0.6;
      P.stretch = 0.05;
      P.floor = floor;
      P.a = 0.85;
      P.fadeIn = 0.02;
      P.fadeOut = 0.7;
      col(Math.random() < 0.3 ? WATER_PALE : WATER, rnd(1, 1.25));
      emit(soft);
    }
  };

  const splashAt = (x: number, y: number, z: number, radius: number) => {
    const s = Math.max(0.8, radius);
    const gy = Math.max(0, y - 0.5);
    // Crown: a tight ring of droplets shooting up and out, then a wider, lower spray.
    droplets(x, gy + 0.1, z, n(16 + s * 5), 2.2 * s, 5.5, 0.3, gy + 0.02, 0.25 * s);
    droplets(x, gy + 0.15, z, n(10 + s * 3), 4 * s, 2.5, 0.22, gy + 0.02, 0.3);
    // A splash column of pale glints.
    for (let i = 0; i < n(8); i++) {
      reset(x + rnd(-0.2, 0.2), gy + 0.2, z + rnd(-0.2, 0.2), S_SPARK, rnd(0.25, 0.4));
      P.vx = rnd(-0.6, 0.6);
      P.vy = rnd(3, 5.5);
      P.vz = rnd(-0.6, 0.6);
      P.drag = 2;
      P.grav = 10;
      P.s0 = 0.12;
      P.s1 = 0.04;
      P.stretch = 0.1;
      col(WATER_PALE, 1.4);
      emit(add);
    }
    flash(x, gy + 0.4, z, s * 1.3, WATER, 1.1, 0.14);
    ring(x, gy, z, s * 0.2, s * 1.05, 0.4, 0.055 * s, WATER_HDR, 0.6, 0);
    ring(x, gy, z, s * 0.1, s * 0.75, 0.55, 0.05 * s, WATER_PALE, 0.5, 0, 0.08);
    // Wet patch: darker ground that dries over ~2 s.
    ring(x, gy - 0.01, z, s * 0.45, s * 0.85, 2.2, 0.1, WET, 0.5, 3, 0, Math.random() * 6.28);
    // Blue sparkles left hanging.
    for (let i = 0; i < n(6); i++) {
      const a = Math.random() * 6.283;
      const d = s * Math.sqrt(Math.random()) * 0.8;
      reset(x + Math.cos(a) * d, gy + rnd(0.1, 0.5), z + Math.sin(a) * d, S_STAR, rnd(0.5, 0.9));
      P.delay = rnd(0.05, 0.2);
      P.vy = rnd(0.2, 0.5);
      P.drag = 1;
      P.s0 = rnd(0.18, 0.28);
      P.s1 = 0.03;
      P.spin = rnd(-3, 3);
      col(WATER_HDR, rnd(0.9, 1.2));
      emit(add);
    }
  };

  const healAt = (x: number, y: number, z: number, radius: number) => {
    const r = Math.max(0.8, radius);
    const gy = Math.max(0, y - 0.5);
    ring(x, gy, z, 0.3, r, 0.95, 0.14 + 0.02 * r, HEAL_GREEN, 0.75, 0);
    ring(x, gy, z, 0.2, r * 0.8, 1.1, 0.08 + 0.015 * r, HEAL_GOLD, 0.45, 0, 0.12);
    ring(x, gy, z, 0, r * 0.9, 0.8, 0.3, HEAL_GREEN, 0.12, 1);
    flash(x, gy + 0.7, z, 1.6, HEAL_GOLD, 0.7, 0.3);
    // Petals and leaves drifting up out of the ring.
    for (let i = 0; i < n(12); i++) {
      const a = Math.random() * 6.283;
      const d = r * rnd(0.2, 0.9);
      reset(x + Math.cos(a) * d, gy + rnd(0.1, 0.4), z + Math.sin(a) * d, Math.random() < 0.5 ? S_PETAL : S_LEAF, rnd(1.1, 1.7));
      P.delay = (d / r) * 0.4;
      P.vx = Math.cos(a) * 0.3;
      P.vy = rnd(0.9, 1.6);
      P.vz = Math.sin(a) * 0.3;
      P.drag = 1.4;
      P.grav = -0.2;
      P.s0 = rnd(0.13, 0.2);
      P.s1 = P.s0 * 0.7;
      P.spin = rnd(-3, 3);
      P.rot = Math.random() * 6.28;
      P.a = 0.9;
      P.fadeIn = 0.15;
      P.fadeOut = 0.55;
      col(pick(HEAL_MOTES), rnd(0.95, 1.1));
      emit(soft);
    }
    // Soft glowing motes.
    for (let i = 0; i < n(16); i++) {
      const a = Math.random() * 6.283;
      const d = r * Math.sqrt(Math.random()) * 0.95;
      reset(x + Math.cos(a) * d, gy + rnd(0.1, 0.6), z + Math.sin(a) * d, i % 3 === 0 ? S_STAR : S_GLOW, rnd(0.9, 1.5));
      P.delay = (d / r) * 0.45;
      P.vy = rnd(0.6, 1.3);
      P.drag = 0.8;
      P.s0 = rnd(0.12, 0.22);
      P.s1 = 0.04;
      P.spin = rnd(-2, 2);
      P.fadeIn = 0.2;
      P.fadeOut = 0.5;
      col(i % 2 ? HEAL_GREEN : HEAL_GOLD, rnd(0.9, 1.3));
      emit(add);
    }
  };

  const sunburstAt = (x: number, y: number, z: number, radius: number) => {
    const r = Math.max(1, radius);
    const gy = Math.max(0, y);
    const s = suns[sunHead];
    sunHead = (sunHead + 1) % suns.length;
    s.active = true;
    s.x = x;
    s.y = gy;
    s.z = z;
    s.r = r;
    s.t0 = time;
    s.acc = 0;
    // Impact lands ~0.1 s after the beam starts.
    const hit = 0.1;
    reset(x, gy + r * 0.45, z, S_GLOW, 0.4);
    P.delay = hit;
    P.s0 = r * 0.7;
    P.s1 = r * 1.3;
    P.fadeIn = 0.02;
    P.fadeOut = 0.12;
    col(SUN_CORE, 1.6);
    emit(add);
    ring(x, gy, z, 0, r * 1.05, 0.55, 0.3, SUN_GOLD, 0.55, 1, hit);
    ring(x, gy, z, r * 0.15, r * 1.12, 0.7, 0.1 * r, SUN_RING, 0.95, 0, hit);
    ring(x, gy, z, r * 0.1, r * 0.7, 0.85, 0.05 * r, SUN_CORE, 0.6, 0, hit + 0.1);
    // Scorched-golden ground: a warm burnt patch and a glow over it, both fading over ~2.5 s.
    ring(x, gy - 0.01, z, r * 0.55, r * 0.85, 2.6, 0.1, SUN_SCORCH, 0.38, 3, hit, Math.random() * 6.28);
    ring(x, gy, z, r * 0.3, r * 0.75, 1.8, 0.3, SUN_GOLD, 0.16, 1, hit + 0.05);
    // Embers shooting up, petals tossed out.
    for (let i = 0; i < n(36); i++) {
      const a = Math.random() * 6.283;
      const d = r * Math.sqrt(Math.random()) * 0.7;
      reset(x + Math.cos(a) * d, gy + 0.2, z + Math.sin(a) * d, S_SPARK, rnd(0.7, 1.4));
      P.delay = hit + rnd(0, 0.12);
      const sp = rnd(2, 6);
      P.vx = Math.cos(a) * sp * 0.6;
      P.vy = rnd(3, 8);
      P.vz = Math.sin(a) * sp * 0.6;
      P.drag = 2.2;
      P.grav = 2.5;
      P.s0 = rnd(0.12, 0.2);
      P.s1 = 0.03;
      P.stretch = 0.1;
      P.fadeOut = 0.5;
      col(i % 3 ? SUN_GOLD : SUN_CORE, rnd(1, 1.5));
      emit(add);
    }
    for (let i = 0; i < n(24); i++) {
      randDir(true);
      reset(x + D.x * r * 0.3, gy + 0.4, z + D.z * r * 0.3, i % 3 ? S_PETAL : S_LEAF, rnd(1.4, 2.2));
      P.delay = hit;
      const sp = rnd(3, 7);
      P.vx = D.x * sp;
      P.vy = rnd(2.5, 5);
      P.vz = D.z * sp;
      P.drag = 1.6;
      P.grav = 3;
      P.s0 = P.s1 = rnd(0.16, 0.26);
      P.spin = rnd(-7, 7);
      P.rot = Math.random() * 6.28;
      P.floor = gy + 0.03;
      P.fadeOut = 0.75;
      col(pick(SUN_PETALS), rnd(0.95, 1.1));
      emit(soft);
    }
    // Warm dust rolling out low along the ground.
    const dusts = n(12);
    for (let i = 0; i < dusts; i++) {
      const a = (i / dusts) * 6.283 + rnd(-0.2, 0.2);
      reset(x + Math.cos(a) * r * 0.3, gy + 0.25, z + Math.sin(a) * r * 0.3, S_SMOKE, rnd(0.9, 1.4));
      P.delay = hit;
      P.vx = Math.cos(a) * r * 1.6;
      P.vy = rnd(0.2, 0.6);
      P.vz = Math.sin(a) * r * 1.6;
      P.drag = 3;
      P.s0 = 0.5;
      P.s1 = rnd(1.1, 1.6);
      P.spin = rnd(-1, 1);
      P.rot = Math.random() * 6.28;
      P.a = 0.4;
      P.fadeOut = 0.35;
      col(DUST, rnd(1, 1.1));
      emit(soft);
    }
  };

  // ---- update helpers -------------------------------------------------------------------------------------------

  const updateMissiles = (dt: number) => {
    let count = 0;
    for (const m of missiles) {
      if (!m.active) continue;
      m.age += dt;
      const t = m.target();
      if (t) {
        m.tx = t.x;
        m.ty = t.y;
        m.tz = t.z;
      }
      if (m.age > m.ft + 0.6) {
        m.active = false;
        missileById.delete(m.mid);
        puff(m.px, m.py, m.pz, 3, CREAM, 0.8, 0.4, 0.6, 0.8, 0.3, 0.4);
        continue;
      }
      const s = Math.min(1, m.age / m.ft);
      if (s >= 1) continue;
      // Quadratic arc: up out of the pod, over and down onto the target, bending sideways.
      const ex = m.tx - m.fx;
      const ez = m.tz - m.fz;
      const dist = Math.hypot(ex, ez) || 1;
      m.cx = m.fx + ex * 0.35 + (-ez / dist) * m.side;
      m.cz = m.fz + ez * 0.35 + (ex / dist) * m.side;
      m.cy = Math.max(m.fy, m.ty) + m.lift + dist * 0.18;
      const e = s * (0.55 + 0.45 * s);
      const i = 1 - e;
      const nx = i * i * m.fx + 2 * i * e * m.cx + e * e * m.tx;
      const ny = i * i * m.fy + 2 * i * e * m.cy + e * e * m.ty;
      const nz = i * i * m.fz + 2 * i * e * m.cz + e * e * m.tz;
      const ddx = nx - m.px;
      const ddy = ny - m.py;
      const ddz = nz - m.pz;
      const step = Math.hypot(ddx, ddy, ddz);
      if (step > 1e-5) {
        m.dx = ddx / step;
        m.dy = ddy / step;
        m.dz = ddz / step;
      }
      // Smoke trail every ~12 cm, plus embers.
      m.trail += step;
      const gap = 0.14 / Math.max(0.4, q);
      while (m.trail > gap) {
        m.trail -= gap;
        const back = m.trail;
        const sx = nx - m.dx * (back + 0.18);
        const sy = ny - m.dy * (back + 0.18);
        const sz = nz - m.dz * (back + 0.18);
        reset(sx, sy, sz, S_SMOKE, rnd(0.7, 1.1));
        P.vx = rnd(-0.15, 0.15);
        P.vy = rnd(0.15, 0.4);
        P.vz = rnd(-0.15, 0.15);
        P.drag = 1;
        P.s0 = 0.1;
        P.s1 = rnd(0.42, 0.6);
        P.spin = rnd(-1.5, 1.5);
        P.rot = Math.random() * 6.28;
        P.a = 0.42;
        P.fadeIn = 0.05;
        P.fadeOut = 0.25;
        col(CREAM, 0.92);
        emit(soft);
        if (Math.random() < 0.5 * q + 0.2) {
          reset(sx, sy, sz, S_SPARK, rnd(0.15, 0.3));
          P.vx = -m.dx * 1.5 + rnd(-0.5, 0.5);
          P.vy = -m.dy * 1.5 + rnd(-0.2, 0.6);
          P.vz = -m.dz * 1.5 + rnd(-0.5, 0.5);
          P.s0 = 0.07;
          P.s1 = 0.02;
          P.stretch = 0.08;
          col(AMBER, 3);
          emit(add);
        }
      }
      m.px = nx;
      m.py = ny;
      m.pz = nz;
      mpos.set(nx, ny, nz);
      mdir.set(m.dx, m.dy, m.dz);
      mq.setFromUnitVectors(FWD, mdir);
      mtx.compose(mpos, mq, mscale);
      missileMesh.setMatrixAt(count++, mtx);
      const flick = 0.85 + 0.3 * Math.random();
      sprite(nx - m.dx * 0.2, ny - m.dy * 0.2, nz - m.dz * 0.2, 0.42 * flick, AMBER, 3.2, 1);
      sprite(nx - m.dx * 0.18, ny - m.dy * 0.18, nz - m.dz * 0.18, 0.16, HOT_WHITE, 4, 1);
    }
    missileMesh.count = count;
    if (count) missileMesh.instanceMatrix.needsUpdate = true;
  };

  const updateBombs = (dt: number) => {
    let count = 0;
    for (const b of bombs) {
      if (!b.active) continue;
      b.age += dt;
      const t = b.target();
      if (t) {
        b.tx = t.x;
        b.ty = t.y;
        b.tz = t.z;
      }
      if (b.age > b.ft + 0.6) {
        // Never told to splash: a small drip where it came down.
        b.active = false;
        bombById.delete(b.mid);
        droplets(b.px, b.py, b.pz, n(6), 1.5, 2, 0.2, Math.max(0, b.py - 0.6), 0.1);
        continue;
      }
      const s = Math.min(1, b.age / b.ft);
      if (s >= 1) continue;
      // High lob: linear across the ground, a parabola over it that lands exactly on the target at s = 1.
      const nx = b.fx + (b.tx - b.fx) * s;
      const nz = b.fz + (b.tz - b.fz) * s;
      const ny = b.fy + (b.ty - b.fy) * s + 4 * b.apex * s * (1 - s);
      const step = Math.hypot(nx - b.px, ny - b.py, nz - b.pz);
      // A thin trail of droplets every ~18 cm.
      b.trail += step;
      const gap = 0.18 / Math.max(0.4, q);
      while (b.trail > gap) {
        b.trail -= gap;
        reset(nx + rnd(-0.06, 0.06), ny + rnd(-0.06, 0.06), nz + rnd(-0.06, 0.06), S_DOT, rnd(0.3, 0.5));
        P.vx = rnd(-0.3, 0.3);
        P.vy = rnd(-0.2, 0.3);
        P.vz = rnd(-0.3, 0.3);
        P.grav = 7;
        P.s0 = rnd(0.13, 0.2);
        P.s1 = 0.05;
        P.a = 0.75;
        P.fadeOut = 0.4;
        col(Math.random() < 0.35 ? WATER_PALE : WATER, 1.1);
        emit(soft);
      }
      b.px = nx;
      b.py = ny;
      b.pz = nz;
      // Wobble: squash and stretch around a slowly turning axis.
      const w = 0.16 * Math.sin(b.age * 19 + b.phase);
      const w2 = 0.1 * Math.sin(b.age * 13 + b.phase * 1.7);
      mpos.set(nx, ny, nz);
      mq.setFromAxisAngle(UP, b.age * 2.5 + b.phase);
      mscale.set(1 + w, 1 - w + w2, 1 + w2);
      mtx.compose(mpos, mq, mscale);
      bombMesh.setMatrixAt(count++, mtx);
      sprite(nx, ny, nz, 0.75, WATER, 0.55, 0.8);
      sprite(nx - 0.06, ny + 0.08, nz + 0.04, 0.13, HOT_WHITE, 1.4, 0.9);
    }
    mscale.set(1, 1, 1);
    bombMesh.count = count;
    if (count) bombMesh.instanceMatrix.needsUpdate = true;
  };

  const updateSuns = (dt: number) => {
    for (const s of suns) {
      if (!s.active) continue;
      const u = time - s.t0;
      if (u > 0.5) {
        s.active = false;
        continue;
      }
      // Beam: snaps down in 0.08 s, holds, thins out by 0.5 s.
      const env = u < 0.08 ? u / 0.08 : 1 - Math.min(1, Math.max(0, (u - 0.14) / 0.36)) ** 1.5;
      const top = s.y + 34;
      const hw = s.r * (0.22 + 0.12 * env) * (0.6 + 0.4 * env);
      const bot = s.y + 0.15;
      const reach = u < 0.08 ? top - (top - bot) * (u / 0.08) : bot;
      seg(s.x, top, s.z, s.x, reach, s.z, hw, SUN_GOLD, 0.55 * env, 0.2, -14, 0.4, 7);
      seg(s.x, top, s.z, s.x, reach, s.z, hw * 0.36, SUN_CORE, 0.7 * env, 0.5, -20, 0.3, 3);
      sprite(s.x, reach + s.r * 0.3, s.z, s.r * 0.85 * env, SUN_GOLD, 0.6, env);
      // Light motes drifting down the column.
      s.acc += dt * 90 * q * env;
      while (s.acc >= 1) {
        s.acc -= 1;
        const a = Math.random() * 6.283;
        const d = hw * Math.sqrt(Math.random()) * 0.8;
        reset(s.x + Math.cos(a) * d, s.y + rnd(1, 9), s.z + Math.sin(a) * d, Math.random() < 0.3 ? S_STAR : S_SPARK, rnd(0.3, 0.5));
        P.vy = -rnd(4, 9);
        P.drag = 0.5;
        P.s0 = rnd(0.1, 0.18);
        P.s1 = 0.03;
        P.stretch = 0.06;
        P.spin = 3;
        col(Math.random() < 0.5 ? SUN_CORE : SUN_GOLD, 1.2);
        emit(add);
      }
    }
  };

  const updateAim = (dt: number) => {
    aimAlpha += ((aimOn ? 1 : 0) - aimAlpha) * (1 - Math.exp(-dt * 14));
    if (!aimOn && aimAlpha < 0.01) aimAlpha = 0;
    aim.visible = aimAlpha > 0;
    aimMat.uniforms.uAlpha.value = aimAlpha;
  };

  const updateBeams = (dt: number) => {
    for (const b of beamsById.values()) {
      const live = time - b.seen < 0.12;
      b.alpha = live ? Math.min(1, b.alpha + dt * 14) : b.alpha - dt / 0.14;
      if (b.alpha <= 0) {
        beamsById.delete(b.tw);
        beamPool.push(b);
        continue;
      }
      const c = BEAM_COL[b.lv];
      const flick = 1 + 0.12 * Math.sin(time * 37 + b.seed) + 0.08 * Math.sin(time * 91 + b.seed * 2);
      const hw = BEAM_W[b.lv] * flick * (0.6 + 0.4 * b.alpha);
      seg(b.fx, b.fy, b.fz, b.tx, b.ty, b.tz, hw, c, b.alpha, 0.24 + b.lv * 0.03, 9, 0.6, b.seed);
      // Muzzle and impact glows.
      sprite(b.fx, b.fy, b.fz, hw * 5, c, 1.2, b.alpha);
      const pulse = 0.85 + 0.3 * Math.sin(time * 30 + b.seed);
      sprite(b.tx, b.ty, b.tz, (1.1 + b.lv * 0.15) * pulse, c, 1.1, b.alpha);
      sprite(b.tx, b.ty, b.tz, 0.42 * pulse, HOT_WHITE, 3.2, b.alpha);
      sprite(b.tx, b.ty, b.tz, (0.95 + b.lv * 0.15) * pulse, c, 1.3, b.alpha, S_STAR, time * 1.5 + b.seed);
      if (!live) continue;
      // Sparks spraying back off the target.
      b.sparkAcc += dt * (22 + b.lv * 10) * q;
      let ddx = b.fx - b.tx;
      let ddy = b.fy - b.ty;
      let ddz = b.fz - b.tz;
      const dl = Math.hypot(ddx, ddy, ddz) || 1;
      ddx /= dl;
      ddy /= dl;
      ddz /= dl;
      while (b.sparkAcc >= 1) {
        b.sparkAcc -= 1;
        randDir();
        const sp = rnd(1.5, 4.5);
        reset(b.tx, b.ty, b.tz, S_SPARK, rnd(0.18, 0.4));
        P.vx = (ddx * 0.7 + D.x) * sp;
        P.vy = (ddy * 0.7 + Math.abs(D.y) + 0.3) * sp;
        P.vz = (ddz * 0.7 + D.z) * sp;
        P.drag = 3;
        P.grav = 9;
        P.s0 = 0.07;
        P.s1 = 0.02;
        P.stretch = 0.08;
        P.floor = 0.02;
        col(c, rnd(0.9, 1.4));
        emit(add);
      }
      // Level 3: gold-mint chain arcs.
      let px = b.tx;
      let py = b.ty;
      let pz = b.tz;
      for (let i = 0; i < b.chainN; i++) {
        const cx = b.chain[i * 3];
        const cy = b.chain[i * 3 + 1];
        const cz = b.chain[i * 3 + 2];
        arc(px, py, pz, cx, cy, cz, CHAIN_COL, 0.1, b.alpha, 7, 0.45, b.seed + i * 17);
        arc(px, py, pz, cx, cy, cz, BEAM_COL[3], 0.045, b.alpha * 0.8, 5, 0.3, b.seed + i * 31);
        sprite(cx, cy, cz, 0.6 * pulse, CHAIN_COL, 1.1, b.alpha);
        sprite(cx, cy, cz, 0.22, CHAIN_WHITE, 3, b.alpha);
        if (Math.random() < dt * 14 * q) sparkBurst(cx, cy, cz, 1, CHAIN_COL, 1.2, 3, 0.3, 0.06);
        px = cx;
        py = cy;
        pz = cz;
      }
    }
  };

  const updateArcs = () => {
    for (const a of arcs) {
      if (!a.active) continue;
      const u = (time - a.t0) / a.life;
      if (u >= 1) {
        a.active = false;
        continue;
      }
      const al = u < 0.15 ? 1 : 1 - (u - 0.15) / 0.85;
      arc(a.ax, a.ay, a.az, a.bx, a.by, a.bz, a.col, a.w * 2.2, al * 0.9, a.segs, a.amp, a.seed);
      arc(a.ax, a.ay, a.az, a.bx, a.by, a.bz, ARC_CORE, a.w * 0.7, al, a.segs, a.amp * 0.7, a.seed + 3);
    }
  };

  const camPos = new THREE.Vector3();
  /** Field strength from camera distance: full at board zoom, barely there in the versus overview. */
  const farFade = (f: Field) => {
    const d = Math.hypot(camPos.x - f.x, camPos.y - f.y, camPos.z - f.z);
    const t = Math.min(1, Math.max(0, (d - 60) / 80));
    return 1 - 0.75 * t * t * (3 - 2 * t);
  };
  const updateFields = (dt: number, camera: THREE.Camera) => {
    camera.getWorldPosition(camPos);
    const k = 1 - Math.exp(-dt * 4.5);
    for (let i = dyingFields.length - 1; i >= 0; i--) {
      const f = dyingFields[i];
      f.r += (f.target - f.r) * k;
      f.alpha += (0 - f.alpha) * k * 1.5;
      f.disc.scale.set(Math.max(0.001, f.r), 1, Math.max(0.001, f.r));
      f.dome?.scale.set(f.r, f.r * DOME_H, f.r);
      f.discMat.uniforms.uAlpha.value = f.alpha;
      if (f.domeMat) f.domeMat.uniforms.uAlpha.value = f.alpha;
      if (f.alpha < 0.02) {
        disposeField(f);
        dyingFields[i] = dyingFields[dyingFields.length - 1];
        dyingFields.pop();
      }
    }
    for (const f of fields.values()) {
      f.r += (f.target - f.r) * k;
      f.alpha += (1 - f.alpha) * k;
      f.flash = Math.max(0, f.flash - dt * 2.5);
      f.act += ((f.active ? 1 : 0) - f.act) * (1 - Math.exp(-dt * (f.active ? 5 : 1.6)));
      const r = Math.max(0.001, f.r);
      const fade = farFade(f);
      f.disc.scale.set(r, 1, r);
      f.discMat.uniforms.uAlpha.value = f.alpha * fade;
      f.discMat.uniforms.uR.value = r;
      f.discMat.uniforms.uFlash.value = f.flash;
      f.discMat.uniforms.uAct.value = f.act;
      if (f.dome && f.domeMat) {
        f.dome.scale.set(r, r * DOME_H, r);
        f.domeMat.uniforms.uAlpha.value = f.alpha * fade * fade;
        f.domeMat.uniforms.uFlash.value = f.flash;
        f.domeMat.uniforms.uHex.value = Math.max(3, r * 1.15);
      }
      // Ambient particles.
      const lvk = 0.6 + 0.2 * f.lv;
      if (f.kind === 'slow') {
        f.acc += dt * r * r * 0.3 * lvk * q * f.act;
        while (f.acc >= 1) {
          f.acc -= 1;
          const a = Math.random() * 6.283;
          const d = r * Math.sqrt(Math.random()) * 0.95;
          reset(f.x + Math.cos(a) * d, f.y + rnd(0.05, 0.4), f.z + Math.sin(a) * d, Math.random() < 0.3 ? S_STAR : S_GLOW, rnd(1.8, 3.2));
          P.vx = rnd(-0.12, 0.12);
          P.vy = rnd(0.25, 0.55);
          P.vz = rnd(-0.12, 0.12);
          P.drag = 0.4;
          P.s0 = rnd(0.08, 0.16);
          P.s1 = P.s0 * 0.6;
          P.spin = rnd(-1, 1);
          P.fadeIn = 0.25;
          P.fadeOut = 0.55;
          col(Math.random() < 0.7 ? MINT : CREAM, rnd(0.9, 1.4));
          emit(add);
        }
      } else if (f.kind === 'beacon') {
        f.acc += dt * r * 0.9 * lvk * q;
        while (f.acc >= 1) {
          f.acc -= 1;
          const a = Math.random() * 6.283;
          const d = r * (Math.random() < 0.75 ? rnd(0.8, 0.92) : rnd(0, 0.35));
          reset(f.x + Math.cos(a) * d, f.y + 0.08, f.z + Math.sin(a) * d, S_SPARK, rnd(1.2, 2));
          P.vy = rnd(0.7, 1.4);
          P.drag = 0.3;
          P.s0 = rnd(0.06, 0.1);
          P.s1 = 0.02;
          P.stretch = 0.25;
          P.fadeIn = 0.15;
          P.fadeOut = 0.5;
          col(BEACON_COL, rnd(0.7, 1.1));
          emit(add);
        }
      } else {
        f.acc += dt * r * 0.35 * q;
        while (f.acc >= 1) {
          f.acc -= 1;
          randDir(true);
          D.y = Math.max(D.y, 0.12);
          const l = Math.hypot(D.x, D.y * DOME_H, D.z);
          reset(f.x + (D.x / l) * r, f.y + ((D.y * DOME_H) / l) * r, f.z + (D.z / l) * r, S_STAR, rnd(0.5, 0.9));
          P.s0 = rnd(0.14, 0.24);
          P.s1 = 0.02;
          P.spin = rnd(-2, 2);
          P.fadeIn = 0.3;
          P.fadeOut = 0.4;
          col(f.lv === 3 ? SHIELD_COL3 : SHIELD_COL, 1.1);
          emit(add);
        }
      }
    }
  };

  const updateDisabled = (dt: number) => {
    for (const d of disabledMap.values()) {
      // Static crawling over a shell just outside the tower (towers are ~1.8 m wide, up to ~2.5 m tall).
      d.acc += dt * 30 * q;
      while (d.acc >= 1) {
        d.acc -= 1;
        const a = Math.random() * 6.283;
        const rr = rnd(0.85, 1.05);
        reset(d.x + Math.cos(a) * rr, d.y + rnd(0.3, 2.4), d.z + Math.sin(a) * rr, Math.random() < 0.5 ? S_SPARK : S_DOT, rnd(0.1, 0.25));
        P.vx = Math.cos(a) * rnd(0, 1.5) + rnd(-1.5, 1.5);
        P.vy = rnd(-1, 2.5);
        P.vz = Math.sin(a) * rnd(0, 1.5) + rnd(-1.5, 1.5);
        P.drag = 6;
        P.s0 = rnd(0.05, 0.1);
        P.s1 = 0.02;
        P.stretch = 0.15;
        col(Math.random() < 0.8 ? VIOLET : VIOLET_PALE, rnd(2, 3.4));
        emit(add);
      }
      d.arc -= dt;
      if (d.arc <= 0) {
        d.arc = rnd(0.1, 0.28);
        const a0 = Math.random() * 6.283;
        const a1 = a0 + rnd(0.6, 1.6) * (Math.random() < 0.5 ? -1 : 1);
        timedArc(d.x + Math.cos(a0) * 0.95, d.y + rnd(0.4, 2.2), d.z + Math.sin(a0) * 0.95, d.x + Math.cos(a1) * 0.95, d.y + rnd(0.4, 2.2), d.z + Math.sin(a1) * 0.95, VIOLET_HDR, 0.035, 0.14, 5, 0.3);
        if (Math.random() < 0.4) ring(d.x, d.y, d.z, 0.7, 1.25, 0.35, 0.08, VIOLET_HDR, 0.6, 0);
      }
      const fl = 0.6 + 0.4 * Math.sin(time * 41) * Math.sin(time * 17);
      sprite(d.x, d.y + 2.7, d.z, 1.1 * fl, VIOLET, 1.1, 0.8);
      sprite(d.x, d.y + 2.7, d.z, 0.6, VIOLET, 2 * fl, 0.9, S_STAR, time * 3);
    }
  };

  // ---- the interface ----------------------------------------------------------------------------------------------

  const fx: Fx & FxFieldActive = {
    beams(list) {
      for (const e of list) {
        let b = beamsById.get(e.tw);
        if (!b) {
          b = beamPool.pop() ?? newBeam();
          b.tw = e.tw;
          b.alpha = 0;
          b.sparkAcc = 0;
          b.seed = Math.random() * 100;
          beamsById.set(e.tw, b);
          // Muzzle flash on beam start.
          flash(e.from.x, e.from.y, e.from.z, 0.9, BEAM_COL[e.lv], 1.2, 0.16);
          sparkBurst(e.to.x, e.to.y, e.to.z, n(6), BEAM_COL[e.lv], 1.4, 3, 0.3, 0.07);
        }
        b.seen = time;
        b.lv = e.lv;
        b.fx = e.from.x;
        b.fy = e.from.y;
        b.fz = e.from.z;
        b.tx = e.to.x;
        b.ty = e.to.y;
        b.tz = e.to.z;
        const cn = Math.min(4, e.chain.length);
        for (let i = 0; i < cn; i++) {
          b.chain[i * 3] = e.chain[i].x;
          b.chain[i * 3 + 1] = e.chain[i].y;
          b.chain[i * 3 + 2] = e.chain[i].z;
        }
        b.chainN = cn;
      }
    },

    missile(mid, from, target, ft) {
      let m: Missile | undefined;
      for (const c of missiles)
        if (!c.active) {
          m = c;
          break;
        }
      if (!m) return;
      const t = target();
      m.active = true;
      m.mid = mid;
      m.fx = m.px = from.x;
      m.fy = m.py = from.y;
      m.fz = m.pz = from.z;
      m.tx = t ? t.x : from.x;
      m.ty = t ? t.y : from.y;
      m.tz = t ? t.z : from.z;
      m.target = target;
      m.ft = Math.max(0.05, ft);
      m.age = 0;
      m.side = rnd(0.6, 1.8) * (Math.random() < 0.5 ? -1 : 1);
      m.lift = rnd(1.2, 2.2);
      m.trail = 0;
      m.dx = 0;
      m.dy = 1;
      m.dz = 0;
      missileById.set(mid, m);
      flash(from.x, from.y, from.z, 0.8, AMBER, 2.2, 0.14);
      puff(from.x, from.y, from.z, n(4), CREAM, 0.9, 0.35, 1.2, 0.7, 0.4, 0.45);
    },

    boom(mid, at, radius) {
      const m = missileById.get(mid);
      if (m) {
        m.active = false;
        missileById.delete(mid);
      }
      boomAt(at.x, at.y, at.z, radius);
    },

    field(tw, kind, at, radius, lv) {
      const f = fields.get(tw);
      if (f && (kind === null || f.kind !== kind)) {
        f.dying = true;
        f.target = f.r * 0.6;
        fields.delete(tw);
        dyingFields.push(f);
      }
      if (!kind) return;
      const cur = fields.get(tw);
      if (cur && cur.kind === kind) {
        const grew = lv > cur.lv;
        cur.target = radius;
        cur.lv = lv;
        cur.x = at.x;
        cur.y = at.y;
        cur.z = at.z;
        cur.disc.position.set(at.x, at.y + 0.035, at.z);
        cur.dome?.position.set(at.x, at.y, at.z);
        cur.discMat.uniforms.uLv.value = lv;
        if (cur.domeMat) {
          cur.domeMat.uniforms.uLv.value = lv;
          const c = lv === 3 ? SHIELD_COL3 : SHIELD_COL;
          (cur.domeMat.uniforms.uCol.value as THREE.Vector3).set(c[0], c[1], c[2]);
          (cur.discMat.uniforms.uCol.value as THREE.Vector3).set(c[0], c[1], c[2]);
        }
        if (grew) {
          cur.flash = 1;
          ripple(cur, 0, 1, 0);
        }
        return;
      }
      const nf = makeField(tw, kind, at, radius, lv);
      fields.set(tw, nf);
      const c = kind === 'slow' ? MINT : kind === 'beacon' ? BEACON_COL : AMBER;
      ring(at.x, at.y, at.z, 0.5, radius, 0.9, 0.25, c, 1.6, 0);
      if (kind === 'shield') ripple(nf, 0, 1, 0);
    },

    fieldActive(tw, active) {
      const f = fields.get(tw);
      if (f) f.active = active;
    },

    zap(tw) {
      const f = fields.get(tw);
      if (!f) return;
      f.flash = Math.min(1, f.flash + 0.7);
      if (f.kind === 'shield') {
        ripple(f, rnd(-0.2, 0.2), 1, rnd(-0.2, 0.2));
        ring(f.x, f.y, f.z, f.r * 0.15, f.r, 0.55, 0.25, f.lv === 3 ? SHIELD_COL3 : SHIELD_COL, 1.8, 0);
        // A few crackles over the bubble.
        for (let i = 0; i < n(10); i++) {
          randDir(true);
          D.y = Math.max(D.y, 0.15);
          const l = Math.hypot(D.x, D.y * DOME_H, D.z);
          reset(f.x + (D.x / l) * f.r, f.y + ((D.y * DOME_H) / l) * f.r, f.z + (D.z / l) * f.r, S_STAR, rnd(0.3, 0.5));
          P.s0 = rnd(0.25, 0.4);
          P.s1 = 0.05;
          P.spin = 3;
          col(AMBER, 2.4);
          emit(add);
        }
      } else ring(f.x, f.y, f.z, 0.2, f.r, 0.5, 0.2, AMBER, 1.4, 0);
    },

    disrupt(from, to, blocked) {
      let ex = to.x;
      let ey = to.y;
      let ez = to.z;
      if (blocked) {
        const f = shieldAt(to.x, to.z);
        if (f) {
          // Where the bolt meets the bubble: ray from `from` towards `to`, in the dome's unit-sphere space.
          const r = Math.max(0.5, f.target);
          const ox = (from.x - f.x) / r;
          const oy = (from.y - f.y) / (r * DOME_H);
          const oz = (from.z - f.z) / r;
          let dx = (to.x - from.x) / r;
          let dy = (to.y - from.y) / (r * DOME_H);
          let dz = (to.z - from.z) / r;
          const dl = Math.hypot(dx, dy, dz) || 1;
          dx /= dl;
          dy /= dl;
          dz /= dl;
          const bq = ox * dx + oy * dy + oz * dz;
          const cq = ox * ox + oy * oy + oz * oz - 1;
          const disc = bq * bq - cq;
          let t = 0;
          if (cq > 0 && disc > 0) t = -bq - Math.sqrt(disc);
          else t = Math.max(0, dl - 0.15);
          let hx = ox + dx * t;
          let hy = Math.max(0.05, oy + dy * t);
          let hz = oz + dz * t;
          const hl = Math.hypot(hx, hy, hz) || 1;
          hx /= hl;
          hy /= hl;
          hz /= hl;
          ex = f.x + hx * r;
          ey = f.y + hy * r * DOME_H;
          ez = f.z + hz * r;
          ripple(f, hx, hy, hz);
          f.flash = Math.min(1, f.flash + 0.35);
          // Splash off the bubble: violet and amber sparks spraying back outward.
          for (let i = 0; i < n(18); i++) {
            randDir();
            const sp = rnd(2, 5);
            reset(ex, ey, ez, S_SPARK, rnd(0.25, 0.5));
            P.vx = (hx * 1.2 + D.x) * sp;
            P.vy = (hy * 1.2 + D.y) * sp;
            P.vz = (hz * 1.2 + D.z) * sp;
            P.drag = 3.5;
            P.grav = 5;
            P.s0 = 0.08;
            P.s1 = 0.02;
            P.stretch = 0.09;
            col(i % 3 === 0 ? AMBER : VIOLET, 3);
            emit(add);
          }
          flash(ex, ey, ez, 1.3, AMBER, 2.2, 0.22);
        }
      }
      timedArc(from.x, from.y, from.z, ex, ey, ez, VIOLET_HDR, 0.06, 0.32, 10, 0.5);
      flash(from.x, from.y, from.z, 0.7, VIOLET, 2.4, 0.2);
      flash(ex, ey, ez, 1.1, VIOLET, 2.6, 0.25);
      if (!blocked) {
        sparkBurst(ex, ey, ez, n(16), VIOLET, 2.8, 3.5, 0.4, 0.08);
        ring(to.x, Math.max(0, to.y - 1.2), to.z, 0.1, 1.3, 0.45, 0.15, VIOLET, 2, 0);
      }
    },

    disabled(tw, at, on) {
      if (!on) {
        disabledMap.delete(tw);
        return;
      }
      const d = disabledMap.get(tw);
      if (d) {
        d.x = at.x;
        d.y = at.y;
        d.z = at.z;
      } else disabledMap.set(tw, { x: at.x, y: at.y, z: at.z, acc: 0, arc: 0 });
    },

    death(at, kind, gold) {
      const half = KIND_HALF[kind];
      const big = kind === 'brute' || kind === 'colossus';
      // Glow Moths die in the air: their pieces fall all the way to the ground.
      const floor = Math.max(0, at.y - half - (kind === 'moth' ? FLY_HEIGHT : 0)) + 0.03;
      const cy = Math.max(at.y, floor + half * 0.8);
      const cols = KIND_COLS[kind];
      const count = n(KIND_SHARDS[kind]);
      const sz = 0.075 + half * 0.07;
      for (let i = 0; i < count; i++) {
        randDir(true);
        const sp = rnd(1.5, 4) * (0.8 + half * 0.4);
        const c = kind === 'colossus' ? hsl(Math.random(), 0.85, 0.6, 1.6) : pick(cols);
        const k = kind === 'colossus' ? 1 : rnd(1.1, 1.7);
        shard(at.x + D.x * half * 0.4, cy + D.y * half * 0.4, at.z + D.z * half * 0.4, D.x * sp, D.y * sp * 0.9 + 2, D.z * sp, rnd(1.4, 2.2), c[0] * k, c[1] * k, c[2] * k, sz * rnd(0.6, 1.4), floor);
      }
      // Glints, a flash and a small puff.
      const glints = n(big ? 14 : 7);
      for (let i = 0; i < glints; i++) {
        randDir(true);
        reset(at.x + D.x * half * 0.6, cy + D.y * half * 0.5, at.z + D.z * half * 0.6, S_STAR, rnd(0.35, 0.6));
        P.vx = D.x * 1.5;
        P.vy = D.y * 1.5 + 0.5;
        P.vz = D.z * 1.5;
        P.drag = 3;
        P.s0 = rnd(0.2, 0.35) * (big ? 1.5 : 1);
        P.s1 = 0.02;
        P.spin = rnd(-4, 4);
        const c = kind === 'colossus' ? hsl(Math.random(), 0.8, 0.65, 1) : pick(cols);
        col(c, 2.6);
        emit(add);
      }
      const fc = kind === 'colossus' ? COLOSSUS_FLASH : cols[0];
      flash(at.x, cy, at.z, half * 3.2, fc, 2, 0.2);
      puff(at.x, cy - half * 0.3, at.z, n(big ? 8 : 4), CREAM, 0.9, half * 1.1, 1.6 * half + 0.5, 0.9, 0.35, 0.4);
      ring(at.x, floor - 0.03, at.z, half * 0.4, half * (big ? 2.6 : 3), big ? 0.6 : 0.4, (big ? 0.2 : 0.3) * half, fc, big ? 0.9 : 0.6, 0);
      if (kind === 'moth') {
        // Wing shards fluttering down: amber and mint flakes spinning as they fall.
        for (let i = 0; i < n(14); i++) {
          randDir(true);
          reset(at.x + D.x * 0.3, cy + D.y * 0.2, at.z + D.z * 0.3, i % 4 === 0 ? S_SHARD : S_PETAL, rnd(1.6, 2.4));
          P.vx = D.x * rnd(1, 2.5);
          P.vy = rnd(0.5, 2);
          P.vz = D.z * rnd(1, 2.5);
          P.drag = 2.6;
          P.grav = 1.4;
          P.s0 = P.s1 = rnd(0.14, 0.22);
          P.spin = rnd(5, 10) * (Math.random() < 0.5 ? -1 : 1);
          P.rot = Math.random() * 6.28;
          P.floor = floor;
          P.fadeOut = 0.8;
          col(pick(MOTH_WINGS), rnd(0.95, 1.15));
          emit(soft);
        }
        // Its glow dust drifting off.
        for (let i = 0; i < n(10); i++) {
          randDir();
          reset(at.x, cy, at.z, S_GLOW, rnd(0.6, 1));
          P.vx = D.x * 1.2;
          P.vy = D.y * 1.2 - 0.3;
          P.vz = D.z * 1.2;
          P.drag = 2;
          P.s0 = rnd(0.1, 0.18);
          P.s1 = 0.03;
          P.fadeOut = 0.5;
          col(i % 2 ? AMBER : MINT, 1.6);
          emit(add);
        }
      } else if (kind === 'bloomkin') {
        confetti(at.x, cy, at.z, n(18), S_PETAL, PETALS, 4, 1.8, 0.24, floor);
        confetti(at.x, cy, at.z, n(8), S_LEAF, LEAVES, 3.5, 1.6, 0.22, floor);
        ring(at.x, floor - 0.03, at.z, 0.2, 2.2, 0.7, 0.1, HEAL_GREEN, 0.5, 0, 0.05);
      }
      if (gold > 0) goldText(at.x, cy + half + 0.35, at.z, gold);
    },

    water(mid, from, target, ft) {
      let b: Bomb | undefined;
      for (const c of bombs)
        if (!c.active) {
          b = c;
          break;
        }
      if (!b) return;
      const t = target();
      b.active = true;
      b.mid = mid;
      b.fx = b.px = from.x;
      b.fy = b.py = from.y;
      b.fz = b.pz = from.z;
      b.tx = t ? t.x : from.x;
      b.ty = t ? t.y : from.y;
      b.tz = t ? t.z : from.z;
      b.target = target;
      b.ft = Math.max(0.05, ft);
      b.age = 0;
      b.apex = 1.6 + Math.hypot(b.tx - b.fx, b.tz - b.fz) * 0.32;
      b.trail = 0;
      b.phase = Math.random() * 6.28;
      bombById.set(mid, b);
      // A wet "pop" out of the nozzle.
      flash(from.x, from.y, from.z, 0.7, WATER, 0.9, 0.12);
      droplets(from.x, from.y, from.z, n(6), 1.2, 2.5, 0.18, Math.max(0, from.y - 1.5), 0.08);
    },

    splash(mid, at, radius) {
      const b = bombById.get(mid);
      if (b) {
        b.active = false;
        bombById.delete(mid);
      }
      splashAt(at.x, at.y, at.z, radius);
    },

    heal(at, radius) {
      healAt(at.x, at.y, at.z, radius);
    },

    sunburst(at, radius) {
      sunburstAt(at.x, at.y, at.z, radius);
    },

    sunAim(at, radius) {
      if (!at) {
        aimOn = false;
        return;
      }
      aimOn = true;
      aim.position.set(at.x, at.y + 0.05, at.z);
      const r = Math.max(0.5, radius);
      aim.scale.set(r, 1, r);
      aimMat.uniforms.uR.value = r;
    },

    leak(at) {
      const gy = Math.max(0, at.y - 0.5);
      flash(at.x, at.y + 1, at.z, 4.5, PINK, 1.6, 0.35);
      ring(at.x, gy, at.z, 0, 2.4, 0.45, 0.4, PINK, 0.45, 1);
      ring(at.x, gy, at.z, 0.5, 4.5, 0.8, 0.14, PINK, 0.9, 0);
      ring(at.x, gy, at.z, 0.2, 3.2, 0.8, 0.1, PINK, 0.7, 0, 0.14);
      confetti(at.x, at.y + 1, at.z, n(40), S_PETAL, PETALS, 5.5, 2.2, 0.3, gy + 0.03);
      sparkBurst(at.x, at.y + 1, at.z, n(16), PINK, 1.3, 5, 0.5, 0.09, true, gy);
    },

    build(at, lv) {
      const gy = at.y;
      if (lv <= 1) {
        ring(at.x, gy, at.z, 0.3, 1.8, 0.5, 0.2, CREAM, 1.2, 0);
        // Dust kicked out low around the base.
        for (let i = 0; i < n(16); i++) {
          const a = Math.random() * 6.283;
          reset(at.x + Math.cos(a) * 0.6, gy + 0.15, at.z + Math.sin(a) * 0.6, S_SMOKE, rnd(0.8, 1.3));
          const sp = rnd(1.5, 3);
          P.vx = Math.cos(a) * sp;
          P.vy = rnd(0.2, 0.8);
          P.vz = Math.sin(a) * sp;
          P.drag = 3;
          P.s0 = 0.3;
          P.s1 = rnd(0.7, 1);
          P.spin = rnd(-1, 1);
          P.rot = Math.random() * 6.28;
          P.a = 0.5;
          P.fadeOut = 0.3;
          col(DUST, rnd(1, 1.15));
          emit(soft);
        }
        confetti(at.x, gy + 0.6, at.z, n(20), S_LEAF, LEAVES, 4.5, 1.6, 0.26, gy + 0.02);
        sparkBurst(at.x, gy + 0.8, at.z, n(8), MINT, 1.5, 2.5, 0.6, 0.07, true, gy);
        return;
      }
      // Upgrade: a golden sparkle spiral climbing the tower, then a burst.
      const turns = lv === 3 ? 3 : 2;
      const cnt = n(lv === 3 ? 90 : 60);
      for (let i = 0; i < cnt; i++) {
        const t = i / cnt;
        const a = t * turns * Math.PI * 2;
        const rr = 0.95 - t * 0.35;
        reset(at.x + Math.cos(a) * rr, gy + 0.1 + t * 2.6, at.z + Math.sin(a) * rr, i % 3 === 0 ? S_STAR : S_SPARK, rnd(0.7, 1.1));
        P.delay = t * 0.6;
        P.vx = -Math.sin(a) * 1.2;
        P.vy = 0.8;
        P.vz = Math.cos(a) * 1.2;
        P.drag = 2;
        P.s0 = i % 3 === 0 ? 0.45 : 0.2;
        P.s1 = 0.03;
        P.spin = 4;
        P.stretch = i % 3 === 0 ? 0 : 0.2;
        col(lv === 3 && i % 4 === 1 ? MINT : GOLD, rnd(2.2, 3.2));
        emit(add);
      }
      // Top burst.
      for (let i = 0; i < n(lv === 3 ? 26 : 16); i++) {
        randDir(true);
        reset(at.x, gy + 2.7, at.z, S_STAR, rnd(0.5, 0.9));
        P.delay = 0.6;
        P.vx = D.x * 3;
        P.vy = D.y * 2 + 1;
        P.vz = D.z * 3;
        P.drag = 2.5;
        P.grav = 2;
        P.s0 = rnd(0.3, 0.45);
        P.s1 = 0.03;
        P.spin = rnd(-4, 4);
        col(GOLD, 2.8);
        emit(add);
      }
      reset(at.x, gy + 2.7, at.z, S_GLOW, 0.3);
      P.delay = 0.6;
      P.s0 = 1;
      P.s1 = 2.2;
      P.fadeIn = 0.02;
      P.fadeOut = 0.2;
      col(GOLD, 2.6);
      emit(add);
      ring(at.x, gy, at.z, 0.4, 2.2, 0.7, 0.18, GOLD, 2.2, 0, 0.55);
      ring(at.x, gy, at.z, 0.2, 1.4, 0.9, 0.12, GOLD, 1.4, 0);
    },

    sell(at) {
      const gy = at.y;
      puff(at.x, gy + 0.6, at.z, n(14), CREAM, 1, 0.9, 2.8, 1.1, 0.5, 0.6);
      ring(at.x, gy, at.z, 0.3, 2, 0.5, 0.2, CREAM, 1.2, 0);
      flash(at.x, gy + 0.8, at.z, 2, CREAM, 1.3, 0.2);
      for (let i = 0; i < n(12); i++) {
        randDir(true);
        reset(at.x, gy + 0.9, at.z, S_COIN, rnd(1, 1.4));
        P.vx = D.x * rnd(1.2, 2.5);
        P.vy = rnd(3.5, 5.5);
        P.vz = D.z * rnd(1.2, 2.5);
        P.grav = 9;
        P.drag = 0.4;
        P.s0 = P.s1 = 0.28;
        P.spin = rnd(-6, 6);
        P.floor = gy + 0.12;
        P.fadeOut = 0.75;
        col(GOLD, 1.5);
        emit(soft);
        if (i % 2 === 0) {
          reset(at.x + D.x * 0.3, gy + 1.2, at.z + D.z * 0.3, S_STAR, 0.5);
          P.delay = rnd(0.1, 0.4);
          P.s0 = 0.25;
          P.s1 = 0.02;
          col(GOLD, 2.5);
          emit(add);
        }
      }
    },

    spawn(at) {
      const gy = at.y;
      ring(at.x, gy, at.z, 1.7, 1.1, 1.0, 0.18, SPAWN_V, 0.75, 2, 0, 9);
      ring(at.x, gy, at.z, 2.4, 0.3, 0.7, 0.12, SPAWN_M, 0.8, 0);
      flash(at.x, gy + 0.6, at.z, 2.4, VIOLET, 1.6, 0.35);
      // Motes drawn inward along a spiral, then a little upward puff.
      for (let i = 0; i < n(24); i++) {
        const a = Math.random() * 6.283;
        const d = rnd(1.4, 2.2);
        reset(at.x + Math.cos(a) * d, gy + rnd(0.1, 1), at.z + Math.sin(a) * d, S_SPARK, rnd(0.45, 0.7));
        const sp = d * 2.6;
        P.vx = (-Math.cos(a) - Math.sin(a) * 0.8) * sp;
        P.vy = rnd(0.3, 1.2);
        P.vz = (-Math.sin(a) + Math.cos(a) * 0.8) * sp;
        P.drag = 3;
        P.s0 = 0.1;
        P.s1 = 0.03;
        P.stretch = 0.15;
        col(Math.random() < 0.6 ? VIOLET : MINT, rnd(2, 3));
        emit(add);
      }
      sparkBurst(at.x, gy + 0.4, at.z, n(10), MINT, 2, 3, 0.6, 0.08, true, gy);
    },

    ping(at, color) {
      const c = lin(color, 2.2);
      const gy = at.y;
      for (let i = 0; i < 3; i++) ring(at.x, gy, at.z, 0.2, 2.2, 1.0, 0.16, c, 2, 0, i * 0.7);
      ring(at.x, gy, at.z, 0, 0.9, 3.2, 0.2, c, 0.6, 1);
      reset(at.x, gy + 1.3, at.z, S_PIN, 3.4);
      P.s0 = 0.5;
      P.s1 = 0.95;
      P.fadeIn = 0.03;
      P.fadeOut = 0.85;
      col(lin(color), 1.5);
      emit(text);
      reset(at.x, gy + 1.45, at.z, S_GLOW, 3.4);
      P.s0 = 2;
      P.s1 = 1.4;
      P.fadeIn = 0.03;
      P.fadeOut = 0.8;
      P.a = 0.8;
      col(c, 0.8);
      emit(add);
    },

    update(dt, _camera) {
      const step = Math.min(0.1, Math.max(0, dt));
      time += step;
      uTime.value = time;
      updateMissiles(step);
      updateBombs(step);
      updateSuns(step);
      updateAim(step);
      updateFields(step, _camera);
      updateDisabled(step);
      updateBeams(step);
      updateArcs();
      add.ring.flush();
      soft.ring.flush();
      text.ring.flush();
      ringsN.r.flush();
      ringsA.r.flush();
      shards.flush();
      segs.flush();
      sprites.flush();
    },

    setQuality(qq) {
      q = QUALITY_MULT[qq];
    },

    dispose() {
      for (const f of fields.values()) disposeField(f);
      for (const f of dyingFields) disposeField(f);
      fields.clear();
      dyingFields.length = 0;
      scene.remove(group);
      for (const g of [add.geo, soft.geo, text.geo, ringsN.geo, ringsA.geo, shardGeo, segGeo, spriteGeo, missileGeo, bombGeo, discGeo, domeGeo]) g.dispose();
      for (const m of [add.mat, soft.mat, text.mat, ringsN.mat, ringsA.mat, shardMat, segMat, spriteMat, missileMat, bombMat, aimMat]) m.dispose();
      missileMesh.dispose();
      bombMesh.dispose();
      atlas.dispose();
    },
  };
  return fx;
};
