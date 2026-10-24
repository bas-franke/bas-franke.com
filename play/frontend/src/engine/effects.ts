// Comic-book effects: particle bursts pooled in one Points object so explosions cost next to nothing, inked toon smoke
// puffs and debris on instanced meshes (two draw calls each: fill and outline), solid inked fireballs and shockwave
// rings (instanced too, so any number of blasts costs the same few draws), scorch decals and pop-art "BOOM!" words.
// Everything is pooled up front, so nothing allocates per frame or per event, and lights come from a fixed pool so the
// shader light count never changes.
//
// Live particles, puffs and chunks are kept packed at the front of their pools, so a draw covers exactly the live
// ones and an idle pool draws nothing. Effects that go off right at the camera (your own rocket jump) back off: they
// shrink and fade instead of filling the screen.

import * as THREE from 'three';
import { hullGeometry, INK, inkMaterial, toonRamp } from './toon';

const MAX = 1500;
/** Smoke puffs (rocket trails, explosion clouds, dust). When full, slots are reused in turn. */
const PUFFS = 384;
const DEBRIS = 96;
const DECALS = 32;
const RINGS = 8;
const FIREBALLS = 8;
const WORD_SPRITES = 6;
/** How long a scorch mark stays, and how much of that is the fade at the end. */
const DECAL_LIFE = 9;
const DECAL_FADE = 3;
/** Distance between trail puffs for `trailSegment`. */
export const TRAIL_STEP = 0.4;
/** Blasts closer to the camera than their radius plus this fade out (metres). */
const NEAR_BLAST = 3;
/** Comic words fade out from this distance to NEAR_WORD - NEAR_WORD_RANGE, and never get taller than this share of their distance. */
const NEAR_WORD = 5;
const NEAR_WORD_RANGE = 2;
const WORD_MAX_HEIGHT = 0.6;

type P3 = { x: number; y: number; z: number };

/**
 * A fixed set of point lights that live in the scene for good. three.js compiles shaders per light count, so adding
 * and removing lights mid-game causes hitches; borrowing from a pool keeps the count constant.
 */
export class LightPool {
  private readonly free: THREE.PointLight[] = [];

  constructor(scene: THREE.Scene, count: number) {
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 8, 2);
      light.position.set(0, -500, 0);
      scene.add(light);
      this.free.push(light);
    }
  }

  /** A light to use, or null when all are busy (the effect then simply goes without one). */
  take(color: number, intensity: number, distance: number): THREE.PointLight | null {
    const light = this.free.pop();
    if (!light) return null;
    light.color.setHex(color);
    light.intensity = intensity;
    light.distance = distance;
    return light;
  }

  give(light: THREE.PointLight) {
    light.intensity = 0;
    light.position.set(0, -500, 0);
    this.free.push(light);
  }
}

/**
 * The outward normal of the box face nearest to `pos`, if one is within `maxDist`. Explosion events carry only a
 * point, so this is how a scorch mark finds the wall or floor it belongs on. Works with any `{ min, max }` boxes;
 * ones with `kind: 'clip'` are skipped.
 */
export function nearestSurface(pos: P3, boxes: readonly { min: P3; max: P3 }[], maxDist: number, out: P3): boolean {
  let best = maxDist;
  let found = false;
  for (const b of boxes) {
    // Invisible collision boxes (Rockets' `clip` kind) have no surface to scorch.
    if ((b as { kind?: string }).kind === 'clip') continue;
    const cx = Math.min(Math.max(pos.x, b.min.x), b.max.x);
    const cy = Math.min(Math.max(pos.y, b.min.y), b.max.y);
    const cz = Math.min(Math.max(pos.z, b.min.z), b.max.z);
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    const dz = pos.z - cz;
    const d = Math.hypot(dx, dy, dz);
    if (d > best) continue;
    if (d > 1e-5) {
      // Outside: the axis with the largest offset is the face we are in front of.
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const az = Math.abs(dz);
      out.x = out.y = out.z = 0;
      if (ay >= ax && ay >= az) out.y = Math.sign(dy);
      else if (ax >= az) out.x = Math.sign(dx);
      else out.z = Math.sign(dz);
    } else {
      // Inside (the rocket tunnelled a little): leave through the closest face.
      const faces = [pos.x - b.min.x, b.max.x - pos.x, pos.y - b.min.y, b.max.y - pos.y, pos.z - b.min.z, b.max.z - pos.z];
      let f = 0;
      for (let i = 1; i < 6; i++) if (faces[i] < faces[f]) f = i;
      out.x = f === 0 ? -1 : f === 1 ? 1 : 0;
      out.y = f === 2 ? -1 : f === 3 ? 1 : 0;
      out.z = f === 4 ? -1 : f === 5 ? 1 : 0;
    }
    best = d;
    found = true;
  }
  return found;
}

interface Fireball {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  light: THREE.PointLight | null;
  life: number;
  max: number;
  radius: number;
  intensity: number;
}

interface Word {
  sprite: THREE.Sprite;
  life: number;
  max: number;
  size: number;
}

interface Ring {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  life: number;
  max: number;
  radius: number;
}

/** A round dot with a dark rim, so particles read as inked blobs rather than squares. */
function dotTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#16121c';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 9, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A jagged ink splat with a few spatter dots: the scorch mark a rocket leaves on a wall. */
function scorchTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const splat = (r: number, spikes: number, jag: number, fill: string) => {
    ctx.beginPath();
    for (let i = 0; i <= spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2;
      const k = i % 2 ? 1 - jag * (0.6 + Math.random() * 0.4) : 0.85 + Math.random() * 0.15;
      const x = c + Math.cos(a) * r * k;
      const y = c + Math.sin(a) * r * k;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  splat(c - 4, 11, 0.45, 'rgba(22,18,28,0.55)');
  splat(c * 0.62, 9, 0.3, 'rgba(22,18,28,0.85)');
  splat(c * 0.3, 7, 0.25, 'rgba(58,30,20,0.95)');
  ctx.fillStyle = 'rgba(22,18,28,0.8)';
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = c * (0.7 + Math.random() * 0.25);
    ctx.beginPath();
    ctx.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, 2 + Math.random() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const WORDS = ['BOOM!', 'POW!', 'KABLAM!', 'WHAM!', 'BAM!'];

/** A jagged starburst with a word on it, in the style of a comic sound effect. */
function wordTexture(text: string, fill: string, burst: string): THREE.CanvasTexture {
  const w = 512;
  const h = 320;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const spikes = 14;
  ctx.beginPath();
  for (let i = 0; i <= spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const r = i % 2 ? 0.62 : 1;
    const x = w / 2 + Math.cos(a) * (w / 2 - 12) * r;
    const y = h / 2 + Math.sin(a) * (h / 2 - 12) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = burst;
  ctx.fill();
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#16121c';
  ctx.stroke();
  ctx.font = `900 ${text.length > 5 ? 92 : 112}px Impact, "Arial Black", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-0.12);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 18;
  ctx.strokeStyle = '#16121c';
  ctx.strokeText(text, 0, 6);
  ctx.fillStyle = fill;
  ctx.fillText(text, 0, 6);
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Toon shading with a per-instance `glow` attribute added as emission, so a fresh puff burns bright yellow even on
 * its shadow side and cools into ordinary lit smoke.
 */
function glowToonMaterial(): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp() });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * vGlow;');
  };
  m.customProgramCacheKey = () => 'fx-glow-toon';
  return m;
}

/**
 * inkMaterial() for instanced meshes: the depth that sets the line width includes the instance transform, and the
 * push is divided by the instance scale so small and large puffs get the same line. Capped so a tiny puff does not
 * turn into a black dot.
 */
function instancedInkMaterial(perDepth = 0.0042, minWorld = 0.006): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec4 inkView = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
        float inkScale = max( length( instanceMatrix[0].xyz ), 1e-4 );
      #else
        vec4 inkView = modelViewMatrix * vec4( position, 1.0 );
        float inkScale = 1.0;
      #endif
      transformed += normalize( normal ) * min( 0.35, max( ${minWorld.toFixed(4)}, -inkView.z * ${perDepth.toFixed(5)} ) / inkScale );`,
    );
  };
  m.customProgramCacheKey = () => `fx-ink-instanced${perDepth}:${minWorld}`;
  return m;
}

/** Alpha blended, with a per-instance `fade` attribute multiplied into the alpha. */
function fadeDecalMaterial(map: THREE.Texture): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float fade;\nvarying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFade = fade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.a *= vFade;');
  };
  m.customProgramCacheKey = () => 'fx-fade-decal';
  return m;
}

/** Unlit and alpha blended, with a per-instance `alpha` attribute (times the instance colour, when there is one). */
function instancedAlphaMaterial(color: number, side: THREE.Side = THREE.FrontSide, depthWrite = true): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, side, depthWrite });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float alpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vAlpha = alpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= vAlpha;');
  };
  m.customProgramCacheKey = () => 'fx-alpha';
  return m;
}

/** Writes position, rotation and uniform scale into a column-major 4x4 at `o`, the same as Matrix4.compose. */
function writeTRS(a: Float32Array, o: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, s: number) {
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  a[o] = (1 - (yy + zz)) * s;
  a[o + 1] = (xy + wz) * s;
  a[o + 2] = (xz - wy) * s;
  a[o + 3] = 0;
  a[o + 4] = (xy - wz) * s;
  a[o + 5] = (1 - (xx + zz)) * s;
  a[o + 6] = (yz + wx) * s;
  a[o + 7] = 0;
  a[o + 8] = (xz + wy) * s;
  a[o + 9] = (yz - wx) * s;
  a[o + 10] = (1 - (xx + yy)) * s;
  a[o + 11] = 0;
  a[o + 12] = x;
  a[o + 13] = y;
  a[o + 14] = z;
  a[o + 15] = 1;
}

/** A uniformly random rotation (Shoemake), written into `q` at `o`. */
function randomQuat(q: Float32Array, o: number) {
  const u = Math.random();
  const v = Math.random() * Math.PI * 2;
  const w = Math.random() * Math.PI * 2;
  const a = Math.sqrt(1 - u);
  const b = Math.sqrt(u);
  q[o] = a * Math.sin(v);
  q[o + 1] = a * Math.cos(v);
  q[o + 2] = b * Math.sin(w);
  q[o + 3] = b * Math.cos(w);
}

/** Copies item `from` over item `to` in an array of `size`-float items. */
function move(a: Float32Array, size: number, from: number, to: number) {
  a.copyWithin(to * size, from * size, from * size + size);
}

/** Uploads only the first `count` items of an attribute this frame. */
function upload(attr: THREE.BufferAttribute, count: number) {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

/** Smoke colour ramp, by phase 0..1: flash yellow, orange, cream smoke, grey. */
const RAMP_AT = [0, 0.14, 0.4, 1];
const RAMP = [new THREE.Color(0xffd21f), new THREE.Color(0xff7a1f), new THREE.Color(0xf4ead2), new THREE.Color(0x8a8592)];
const DEBRIS_COLORS = [new THREE.Color(0x3a3440), new THREE.Color(0x5a5060), new THREE.Color(0x6b5a48), new THREE.Color(0xff8a1f)];

const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const Z = new THREE.Vector3(0, 0, 1);
const UP = { x: 0, y: 1, z: 0 };

/** Sets `q` to turn +Z onto the unit vector `n`, then spin `spin` radians around it. */
function alignZ(q: THREE.Quaternion, n: P3, spin: number) {
  _n.set(n.x, n.y, n.z);
  q.setFromUnitVectors(Z, _n);
  _q2.setFromAxisAngle(Z, spin);
  q.multiply(_q2);
}

export class Effects {
  private readonly positions = new Float32Array(MAX * 3);
  private readonly colors = new Float32Array(MAX * 3);
  private readonly velocities = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX);
  private readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly dot = dotTexture();
  private next = 0;
  private liveDots = 0;
  private readonly words: Word[] = [];
  private readonly wordTextures: THREE.CanvasTexture[];
  private readonly lights: LightPool;
  gravity = 12;
  /** Where the camera was at the last render (captured in scene.onBeforeRender), so blasts at the camera can back off. */
  private readonly cam = new THREE.Vector3(0, -1e4, 0);
  private readonly sceneBeforeRender: THREE.Scene['onBeforeRender'];

  // Smoke puffs: fill and ink share one instanceMatrix. Live puffs are slots 0..livePuffs-1.
  private readonly puffGeo = new THREE.IcosahedronGeometry(1, 1);
  private readonly puffHull = hullGeometry(this.puffGeo);
  private readonly toonMat = glowToonMaterial();
  private readonly inkMat = instancedInkMaterial(0.0065, 0.012);
  private readonly puffs: THREE.InstancedMesh;
  private readonly puffInk: THREE.InstancedMesh;
  private readonly puffGlow = new Float32Array(PUFFS);
  private readonly pPos = new Float32Array(PUFFS * 3);
  private readonly pVel = new Float32Array(PUFFS * 3);
  private readonly pQuat = new Float32Array(PUFFS * 4);
  private readonly pLife = new Float32Array(PUFFS);
  private readonly pMax = new Float32Array(PUFFS);
  private readonly pSize = new Float32Array(PUFFS);
  private readonly pHeat = new Float32Array(PUFFS);
  private readonly pRise = new Float32Array(PUFFS);
  /** 1 for rocket-trail puffs: they shrink away sooner, so a trail reads as a line rather than a cloud. */
  private readonly pTrail = new Float32Array(PUFFS);
  private nextPuff = 0;
  private livePuffs = 0;

  // Debris chunks: same materials, their own instanced pair. Live chunks are slots 0..liveChunks-1.
  private readonly chunkGeo = new THREE.TetrahedronGeometry(1, 0);
  private readonly chunkHull = hullGeometry(this.chunkGeo);
  private readonly chunks: THREE.InstancedMesh;
  private readonly chunkInk: THREE.InstancedMesh;
  private readonly chunkGlow = new Float32Array(DEBRIS);
  private readonly dPos = new Float32Array(DEBRIS * 3);
  private readonly dVel = new Float32Array(DEBRIS * 3);
  private readonly dRot = new Float32Array(DEBRIS * 3);
  private readonly dSpin = new Float32Array(DEBRIS * 3);
  private readonly dLife = new Float32Array(DEBRIS);
  private readonly dMax = new Float32Array(DEBRIS);
  private readonly dSize = new Float32Array(DEBRIS);
  private readonly dFloor = new Float32Array(DEBRIS);
  private readonly dHot = new Float32Array(DEBRIS);
  private nextChunk = 0;
  private liveChunks = 0;

  // Scorch decals.
  private readonly scorchTex = scorchTexture();
  private readonly decalGeo = new THREE.PlaneGeometry(1, 1);
  private readonly decalMat = fadeDecalMaterial(this.scorchTex);
  private readonly decals: THREE.InstancedMesh;
  private readonly decalFade = new Float32Array(DECALS);
  private readonly decalLife = new Float32Array(DECALS);
  private nextDecal = 0;

  // Shockwave rings: one instanced draw, per-instance colour and alpha.
  private readonly ringGeo = new THREE.RingGeometry(0.8, 1, 32);
  private readonly ringMat = instancedAlphaMaterial(0xffffff, THREE.DoubleSide, false);
  private readonly ringAlpha = new Float32Array(RINGS);
  private readonly ringMesh: THREE.InstancedMesh;
  private readonly rings: Ring[] = [];

  // Fireballs: a hot core, a coloured shell and an ink hull, each one instanced draw for all of them.
  private readonly ballGeo = new THREE.IcosahedronGeometry(1, 1);
  private readonly coreGeo = this.ballGeo.clone();
  private readonly ballHull = hullGeometry(this.ballGeo);
  private readonly shellMat = instancedAlphaMaterial(0xffffff);
  private readonly coreMat = instancedAlphaMaterial(0xfff3b0);
  private readonly shellAlpha = new Float32Array(FIREBALLS);
  private readonly coreAlpha = new Float32Array(FIREBALLS);
  private readonly cores: THREE.InstancedMesh;
  private readonly shells: THREE.InstancedMesh;
  private readonly ballInk: THREE.InstancedMesh;
  private readonly fireballs: Fireball[] = [];

  private readonly wordSprites: THREE.Sprite[] = [];
  private nextWord = 0;
  private nextFireball = 0;

  constructor(
    private readonly scene: THREE.Scene,
    flashLights = 3,
  ) {
    this.lights = new LightPool(scene, flashLights);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);
    const material = new THREE.PointsMaterial({
      size: 0.22,
      map: this.dot,
      vertexColors: true,
      alphaTest: 0.5,
      sizeAttenuation: true,
    });
    // Cap the on-screen size so a puff right in front of the camera does not fill the view.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', '#include <fog_vertex>\n  gl_PointSize = min( gl_PointSize, 36.0 );');
    };
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);

    [this.puffs, this.puffInk] = this.instancedPair(this.puffGeo, this.puffHull, this.puffGlow, PUFFS);
    [this.chunks, this.chunkInk] = this.instancedPair(this.chunkGeo, this.chunkHull, this.chunkGlow, DEBRIS);

    this.decalGeo.setAttribute('fade', new THREE.InstancedBufferAttribute(this.decalFade, 1).setUsage(THREE.DynamicDrawUsage));
    this.decals = new THREE.InstancedMesh(this.decalGeo, this.decalMat, DECALS);
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decals.frustumCulled = false;
    this.decals.renderOrder = 1;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < DECALS; i++) this.decals.setMatrixAt(i, _m);
    scene.add(this.decals);

    this.ringMesh = this.instancedAlpha(this.ringGeo, this.ringMat, this.ringAlpha, RINGS, true);
    this.ringMesh.renderOrder = 2;
    for (let i = 0; i < RINGS; i++) this.rings.push({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), life: 0, max: 1, radius: 1 });

    // The core draws first so it shows through the shell as the shell fades.
    this.cores = this.instancedAlpha(this.coreGeo, this.coreMat, this.coreAlpha, FIREBALLS, false);
    this.shells = this.instancedAlpha(this.ballGeo, this.shellMat, this.shellAlpha, FIREBALLS, true);
    this.ballInk = new THREE.InstancedMesh(this.ballHull, inkMaterial(), FIREBALLS);
    this.ballInk.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < FIREBALLS; i++) this.ballInk.setMatrixAt(i, _m);
    this.ballInk.frustumCulled = false;
    this.ballInk.visible = false;
    scene.add(this.ballInk);
    for (let i = 0; i < FIREBALLS; i++) this.fireballs.push({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), light: null, life: 0, max: 1, radius: 1, intensity: 0 });

    // Built up front: drawing five canvases on the first explosion caused a visible hitch. Each sprite starts out
    // with a texture, so the shader variant and every texture upload happen during warmup, not on the first boom.
    this.wordTextures = WORDS.map((w, i) => wordTexture(w, ['#ffe14d', '#ffffff', '#ffe14d', '#7cf4ff', '#ffb0d8'][i], ['#ff4b2e', '#2e7bff', '#ff8a1f', '#e8392e', '#8d4bff'][i]));
    for (let i = 0; i < WORD_SPRITES; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.wordTextures[i % this.wordTextures.length], transparent: true, depthTest: false }));
      sprite.renderOrder = 20;
      sprite.visible = false;
      scene.add(sprite);
      this.wordSprites.push(sprite);
      this.words.push({ sprite, life: 0, max: 0.6, size: 1 });
    }

    this.sceneBeforeRender = scene.onBeforeRender;
    const before = this.sceneBeforeRender;
    const cam = this.cam;
    scene.onBeforeRender = function (this: THREE.Scene, ...args) {
      before.apply(this, args);
      cam.setFromMatrixPosition(args[2].matrixWorld);
    };
  }

  /** A toon fill mesh and an ink hull mesh drawing the same instances. Hidden until something is alive. */
  private instancedPair(geo: THREE.BufferGeometry, hull: THREE.BufferGeometry, glow: Float32Array, count: number): [THREE.InstancedMesh, THREE.InstancedMesh] {
    geo.setAttribute('glow', new THREE.InstancedBufferAttribute(glow, 1).setUsage(THREE.DynamicDrawUsage));
    const fill = new THREE.InstancedMesh(geo, this.toonMat, count);
    fill.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _m.makeScale(0, 0, 0);
    _c.setRGB(1, 1, 1);
    for (let i = 0; i < count; i++) {
      fill.setMatrixAt(i, _m);
      fill.setColorAt(i, _c);
    }
    fill.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    const ink = new THREE.InstancedMesh(hull, this.inkMat, count);
    ink.instanceMatrix = fill.instanceMatrix;
    fill.frustumCulled = ink.frustumCulled = false;
    fill.count = ink.count = 0;
    fill.visible = ink.visible = false;
    this.scene.add(fill, ink);
    return [fill, ink];
  }

  /** An instanced mesh with a per-instance `alpha` (and colour when `colored`), all instances parked at scale 0. */
  private instancedAlpha(geo: THREE.BufferGeometry, mat: THREE.Material, alpha: Float32Array, count: number, colored: boolean): THREE.InstancedMesh {
    geo.setAttribute('alpha', new THREE.InstancedBufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    _m.makeScale(0, 0, 0);
    _c.setRGB(1, 1, 1);
    for (let i = 0; i < count; i++) {
      mesh.setMatrixAt(i, _m);
      if (colored) mesh.setColorAt(i, _c);
    }
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.scene.add(mesh);
    return mesh;
  }

  /** 0 when the camera is within `inner` metres of the point, rising to 1 at `inner + range`. */
  private nearCamera(x: number, y: number, z: number, inner: number, range: number) {
    const d = Math.hypot(x - this.cam.x, y - this.cam.y, z - this.cam.z);
    return Math.min(1, Math.max(0, (d - inner) / range));
  }

  burst(pos: THREE.Vector3 | P3, color: number, count = 40, speed = 7, lifetime = 0.7, up = 0.4) {
    if (document.hidden) return;
    const c = _c.setHex(color);
    for (let n = 0; n < count; n++) {
      let i: number;
      if (this.liveDots < MAX) i = this.liveDots++;
      else {
        i = this.next;
        this.next = (this.next + 1) % MAX;
      }
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.3 + Math.random() * 0.7);
      this.positions[i * 3] = pos.x;
      this.positions[i * 3 + 1] = pos.y;
      this.positions[i * 3 + 2] = pos.z;
      this.velocities[i * 3] = Math.sin(phi) * Math.cos(theta) * s;
      this.velocities[i * 3 + 1] = Math.cos(phi) * s + up * speed;
      this.velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * s;
      const tint = 0.85 + Math.random() * 0.25;
      this.colors[i * 3] = Math.min(1, c.r * tint);
      this.colors[i * 3 + 1] = Math.min(1, c.g * tint);
      this.colors[i * 3 + 2] = Math.min(1, c.b * tint);
      this.life[i] = lifetime * (0.6 + Math.random() * 0.6);
    }
    upload(this.geometry.attributes.color as THREE.BufferAttribute, this.liveDots);
  }

  /**
   * One inked smoke puff that swells to `size` (radius, metres), then shrinks away over `life` seconds while it
   * drifts with `vel` and rises. `heat` 1 starts as a yellow flash and cools through orange; 0 starts as cream smoke.
   */
  smoke(pos: P3, size = 0.5, life = 1.2, vel?: P3, heat = 0) {
    this.puff(pos, size, life, vel, heat);
  }

  /** smoke(), returning the slot (or -1 when hidden). */
  private puff(pos: P3, size: number, life: number, vel: P3 | undefined, heat: number): number {
    if (document.hidden) return -1;
    let i: number;
    if (this.livePuffs < PUFFS) i = this.livePuffs++;
    else {
      // Full: reuse slots in turn, which takes roughly the oldest.
      i = this.nextPuff;
      this.nextPuff = (i + 1) % PUFFS;
    }
    this.pPos[i * 3] = pos.x;
    this.pPos[i * 3 + 1] = pos.y;
    this.pPos[i * 3 + 2] = pos.z;
    this.pVel[i * 3] = vel ? vel.x : 0;
    this.pVel[i * 3 + 1] = vel ? vel.y : 0;
    this.pVel[i * 3 + 2] = vel ? vel.z : 0;
    randomQuat(this.pQuat, i * 4);
    this.pLife[i] = this.pMax[i] = life;
    this.pSize[i] = size;
    this.pHeat[i] = heat;
    this.pRise[i] = 0.6 + Math.random() * 0.6;
    this.pTrail[i] = 0;
    return i;
  }

  /** One rocket-trail puff at `pos`. Call it every TRAIL_STEP metres of travel (or use trailSegment). */
  trail(pos: P3, heat = 1) {
    _v.set((Math.random() - 0.5) * 0.4, 0.15 + Math.random() * 0.3, (Math.random() - 0.5) * 0.4);
    const i = this.puff(
      { x: pos.x + (Math.random() - 0.5) * 0.08, y: pos.y + (Math.random() - 0.5) * 0.08, z: pos.z + (Math.random() - 0.5) * 0.08 },
      0.2 + Math.random() * 0.1,
      0.52 + Math.random() * 0.25,
      _v,
      heat,
    );
    if (i >= 0) this.pTrail[i] = 1;
  }

  /**
   * Trail puffs every TRAIL_STEP metres from `from` to `to`, so the spacing stays even at any frame rate. `carry` is
   * the distance already travelled since the last puff; store the return value and pass it back next frame.
   */
  trailSegment(from: P3, to: P3, carry: number, heat = 1): number {
    if (document.hidden) return 0;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    // A teleport or a fresh rocket: do not draw a line of smoke across the map.
    if (len > 6) return 0;
    let d = TRAIL_STEP - carry;
    let emitted = 0;
    while (d <= len && emitted < 16) {
      const t = d / len;
      const p = _s.set(from.x + dx * t, from.y + dy * t, from.z + dz * t);
      this.trail(p, heat);
      d += TRAIL_STEP;
      emitted++;
    }
    return len - (d - TRAIL_STEP);
  }

  /** Tumbling inked chunks thrown out around `normal`. Chunks that start above a floor bounce once on `floorY`. */
  debris(pos: P3, normal: P3 = UP, count = 10, speed = 8, floorY = -Infinity) {
    if (document.hidden) return;
    for (let n = 0; n < count; n++) {
      let i: number;
      if (this.liveChunks < DEBRIS) i = this.liveChunks++;
      else {
        i = this.nextChunk;
        this.nextChunk = (i + 1) % DEBRIS;
      }
      // Random direction in the hemisphere around the normal, biased outward.
      let x = Math.random() * 2 - 1;
      let y = Math.random() * 2 - 1;
      let z = Math.random() * 2 - 1;
      const len = Math.hypot(x, y, z) || 1;
      x /= len;
      y /= len;
      z /= len;
      const dot = x * normal.x + y * normal.y + z * normal.z;
      if (dot < 0) {
        x -= 2 * dot * normal.x;
        y -= 2 * dot * normal.y;
        z -= 2 * dot * normal.z;
      }
      const s = speed * (0.45 + Math.random() * 0.55);
      this.dPos[i * 3] = pos.x + normal.x * 0.15;
      this.dPos[i * 3 + 1] = pos.y + normal.y * 0.15;
      this.dPos[i * 3 + 2] = pos.z + normal.z * 0.15;
      this.dVel[i * 3] = (x + normal.x * 0.5) * s;
      this.dVel[i * 3 + 1] = (y + normal.y * 0.5) * s + 2;
      this.dVel[i * 3 + 2] = (z + normal.z * 0.5) * s;
      for (let k = 0; k < 3; k++) {
        this.dRot[i * 3 + k] = Math.random() * Math.PI * 2;
        this.dSpin[i * 3 + k] = (Math.random() - 0.5) * 18;
      }
      this.dLife[i] = this.dMax[i] = 0.8 + Math.random() * 0.6;
      this.dSize[i] = 0.07 + Math.random() * 0.09;
      this.dFloor[i] = floorY;
      const hot = Math.random() < 0.3;
      this.dHot[i] = hot ? 1 : 0;
      this.chunks.setColorAt(i, DEBRIS_COLORS[hot ? 3 : Math.floor(Math.random() * 3)]);
    }
    upload(this.chunks.instanceColor!, this.liveChunks);
  }

  /** A flat ring that races outward from `pos`, facing `normal`. */
  shockwave(pos: P3, normal: P3 = UP, radius = 3, color = 0xfff3d0, duration = 0.32) {
    if (document.hidden) return;
    let k = 0;
    for (let i = 1; i < RINGS; i++) if (this.rings[i].life < this.rings[k].life) k = i;
    const ring = this.rings[k];
    ring.life = ring.max = duration;
    ring.radius = radius;
    ring.pos.set(pos.x + normal.x * 0.08, pos.y + normal.y * 0.08, pos.z + normal.z * 0.08);
    alignZ(ring.quat, normal, 0);
    this.ringMesh.setColorAt(k, _c.setHex(color));
    this.ringMesh.instanceColor!.needsUpdate = true;
  }

  /** An ink-splat scorch mark on the surface at `pos` facing `normal`; fades after a while. Oldest is reused. */
  scorch(pos: P3, normal: P3, size = 1.8) {
    if (document.hidden) return;
    const i = this.nextDecal;
    this.nextDecal = (i + 1) % DECALS;
    // Each slot sits at its own tiny offset so overlapping marks do not z-fight.
    const off = 0.012 + (i % 8) * 0.0025;
    _v.set(pos.x + normal.x * off, pos.y + normal.y * off, pos.z + normal.z * off);
    alignZ(_q, normal, Math.random() * Math.PI * 2);
    const s = size * (0.8 + Math.random() * 0.4);
    _m.compose(_v, _q, _s.set(s, s, 1));
    this.decals.setMatrixAt(i, _m);
    this.decals.instanceMatrix.needsUpdate = true;
    this.decalLife[i] = DECAL_LIFE;
    this.decalFade[i] = 1;
    (this.decalGeo.attributes.fade as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /**
   * A full rocket explosion: fireball and light, hot inner cloud, rising smoke column, shockwave, debris, sparks and
   * (when `normal` is given, i.e. it hit a surface) a scorch mark. The "BOOM!" word is separate: see boom().
   */
  explode(pos: P3, normal: P3 | null = null, scale = 1) {
    if (document.hidden) return;
    const n = normal ?? UP;
    this.flash({ x: pos.x + n.x * 0.3, y: pos.y + n.y * 0.3, z: pos.z + n.z * 0.3 }, 0xff7a1f, 1.7 * scale, 0.45, 30);
    this.burst(pos, 0xffc23a, 30, 9 * scale, 0.5, 0.4);
    this.burst(pos, 0xffffff, 10, 6 * scale, 0.35, 0.3);
    // Hot inner cloud, pushed off the surface.
    for (let k = 0; k < 8; k++) {
      const ox = (Math.random() - 0.5) * 1.4 * scale + n.x * 0.5;
      const oy = (Math.random() - 0.5) * 1.4 * scale + n.y * 0.5;
      const oz = (Math.random() - 0.5) * 1.4 * scale + n.z * 0.5;
      _v.set(ox * 2.2, oy * 2.2 + 0.6, oz * 2.2);
      this.smoke({ x: pos.x + ox * 0.5, y: pos.y + oy * 0.5, z: pos.z + oz * 0.5 }, (0.45 + Math.random() * 0.35) * scale, 0.55 + Math.random() * 0.35, _v, 1);
    }
    // Smoke column: bigger, cooler puffs that climb and hang around.
    for (let k = 0; k < 7; k++) {
      const h = k / 6;
      _v.set((Math.random() - 0.5) * 0.8 + n.x * 1.5, 1.4 + h * 2.4 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8 + n.z * 1.5);
      this.smoke(
        { x: pos.x + n.x * 0.6 + (Math.random() - 0.5) * 0.6, y: pos.y + n.y * 0.6 + h * 0.6, z: pos.z + n.z * 0.6 + (Math.random() - 0.5) * 0.6 },
        (0.55 + Math.random() * 0.4) * scale * (1 - h * 0.35),
        1.4 + Math.random() * 0.8,
        _v,
        0.35 - h * 0.35,
      );
    }
    this.shockwave(pos, n, 3.2 * scale);
    this.debris(pos, n, 10, 8 * scale, normal && normal.y > 0.7 ? pos.y : -Infinity);
    if (normal) this.scorch(pos, normal, 1.9 * scale);
  }

  /** Jump pad launch: a coloured ring and puffs blown outward along the pad. */
  padBurst(pos: P3, color: number) {
    this.shockwave(pos, UP, 2.2, color, 0.35);
    this.burst({ x: pos.x, y: pos.y + 0.2, z: pos.z }, color, 22, 5, 0.5, 1.1);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + Math.random() * 0.4;
      _v.set(Math.cos(a) * 3.2, 0.6 + Math.random() * 0.6, Math.sin(a) * 3.2);
      this.smoke({ x: pos.x + Math.cos(a) * 0.4, y: pos.y + 0.15, z: pos.z + Math.sin(a) * 0.4 }, 0.26 + Math.random() * 0.14, 0.6 + Math.random() * 0.25, _v, 0);
    }
  }

  /** Landing dust at the feet. `strength` 0..1 scales the number, size and spread of the puffs. */
  dust(pos: P3, strength = 0.5) {
    const s = Math.min(1, Math.max(0, strength));
    const count = 4 + Math.round(s * 6);
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + Math.random() * 0.5;
      const sp = 1.2 + s * 2.2;
      _v.set(Math.cos(a) * sp, 0.25 + Math.random() * 0.35, Math.sin(a) * sp);
      this.smoke({ x: pos.x + Math.cos(a) * 0.25, y: pos.y + 0.08, z: pos.z + Math.sin(a) * 0.25 }, (0.14 + Math.random() * 0.08) * (0.7 + s * 0.8), 0.45 + Math.random() * 0.2, _v, 0);
    }
  }

  /** A quick spray of hit sparks, mostly along `dir` when given. */
  sparks(pos: P3, dir?: P3) {
    const at = dir ? { x: pos.x + dir.x * 0.1, y: pos.y + dir.y * 0.1, z: pos.z + dir.z * 0.1 } : pos;
    this.burst(at, 0xffe14d, 14, 7, 0.3, 0.25);
    this.burst(at, 0xffffff, 6, 5, 0.22, 0.2);
    for (let k = 0; k < 2; k++) {
      _v.set(dir ? dir.x * 2 : 0, 0.5, dir ? dir.z * 2 : 0);
      this.smoke(at, 0.12 + Math.random() * 0.06, 0.25, _v, 1);
    }
  }

  /** A solid, inked fireball that swells to `radius` and shrinks away, with a pooled light while it lasts. */
  flash(pos: P3, color: number, radius = 1, duration = 0.35, intensity = 20) {
    if (document.hidden) return;
    const i = this.nextFireball;
    const f = this.fireballs[i];
    this.nextFireball = (i + 1) % FIREBALLS;
    if (f.light) this.lights.give(f.light);
    f.light = this.lights.take(color, intensity, radius * 8);
    f.light?.position.set(pos.x, pos.y, pos.z);
    this.shells.setColorAt(i, _c.setHex(color));
    this.shells.instanceColor!.needsUpdate = true;
    f.pos.set(pos.x, pos.y, pos.z);
    f.quat.setFromEuler(_e.set(Math.random() * 3, Math.random() * 3, 0));
    f.life = f.max = duration;
    f.radius = radius;
    f.intensity = intensity;
  }

  /** A comic sound-effect word that pops up at `pos`. */
  boom(pos: P3, size = 2.2) {
    if (document.hidden) return;
    const w = this.words[this.nextWord];
    this.nextWord = (this.nextWord + 1) % WORD_SPRITES;
    const mat = w.sprite.material;
    mat.map = this.wordTextures[Math.floor(Math.random() * this.wordTextures.length)];
    mat.rotation = (Math.random() - 0.5) * 0.4;
    mat.opacity = 1;
    w.sprite.position.set(pos.x, pos.y + 0.8, pos.z);
    w.sprite.scale.set(0.01, 0.01, 1);
    w.sprite.visible = true;
    w.life = w.max = 0.6;
    w.size = size;
  }

  update(dt: number) {
    if (this.liveDots > 0) this.updateDots(dt);
    this.updatePuffs(dt);
    this.updateDebris(dt);
    this.updateDecals(dt);
    this.updateRings(dt);
    this.updateFireballs(dt);

    for (const w of this.words) {
      if (w.life <= 0) continue;
      w.life -= dt;
      if (w.life <= 0) {
        w.sprite.visible = false;
        continue;
      }
      const t = 1 - w.life / w.max;
      const pop = t < 0.15 ? (t / 0.15) * 1.15 : t < 0.25 ? 1.15 - ((t - 0.15) / 0.1) * 0.15 : 1;
      w.sprite.position.y += dt * 0.6;
      // Never taller than a share of its distance, and gone when it is right at the camera (a blast on yourself).
      const p = w.sprite.position;
      const d = Math.hypot(p.x - this.cam.x, p.y - this.cam.y, p.z - this.cam.z);
      const h = Math.min(w.size * pop, d * WORD_MAX_HEIGHT);
      w.sprite.scale.set(h * 1.6, h, 1);
      const near = Math.min(1, Math.max(0, (d - (NEAR_WORD - NEAR_WORD_RANGE)) / NEAR_WORD_RANGE));
      w.sprite.material.opacity = (t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3) * near;
    }
  }

  private updateDots(dt: number) {
    const p = this.positions;
    const v = this.velocities;
    const col = this.colors;
    const drag = 1 - 1.5 * dt;
    let n = this.liveDots;
    let moved = false;
    let i = 0;
    while (i < n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // Keep the live ones packed: the last one takes this slot (and gets its step on the next pass).
        n--;
        if (i < n) {
          move(p, 3, n, i);
          move(v, 3, n, i);
          move(col, 3, n, i);
          this.life[i] = this.life[n];
          moved = true;
        }
        this.life[n] = 0;
        continue;
      }
      v[i * 3 + 1] -= this.gravity * dt;
      v[i * 3] *= drag;
      v[i * 3 + 2] *= drag;
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      i++;
    }
    this.liveDots = n;
    if (this.next >= n) this.next = 0;
    this.geometry.setDrawRange(0, n);
    this.points.visible = n > 0;
    upload(this.geometry.attributes.position as THREE.BufferAttribute, n);
    if (moved) upload(this.geometry.attributes.color as THREE.BufferAttribute, n);
  }

  private movePuff(from: number, to: number) {
    move(this.pPos, 3, from, to);
    move(this.pVel, 3, from, to);
    move(this.pQuat, 4, from, to);
    this.pLife[to] = this.pLife[from];
    this.pMax[to] = this.pMax[from];
    this.pSize[to] = this.pSize[from];
    this.pHeat[to] = this.pHeat[from];
    this.pRise[to] = this.pRise[from];
    this.pTrail[to] = this.pTrail[from];
  }

  private updatePuffs(dt: number) {
    if (this.livePuffs <= 0) return;
    const m = this.puffs.instanceMatrix.array as Float32Array;
    const col = this.puffs.instanceColor!.array as Float32Array;
    const pos = this.pPos;
    const vel = this.pVel;
    const q = this.pQuat;
    const cam = this.cam;
    const drag = Math.max(0, 1 - 2.2 * dt);
    let n = this.livePuffs;
    let i = 0;
    while (i < n) {
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) {
        n--;
        if (i < n) this.movePuff(n, i);
        this.pLife[n] = 0;
        continue;
      }
      const t = 1 - this.pLife[i] / this.pMax[i];
      vel[i * 3] *= drag;
      vel[i * 3 + 1] = vel[i * 3 + 1] * drag + this.pRise[i] * dt;
      vel[i * 3 + 2] *= drag;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      // Pop out, keep billowing a little, then shrink away at the end: opaque comic smoke that never needs alpha
      // sorting. Trail puffs shrink sooner, so a trail stays a clean line.
      let s: number;
      if (t < 0.18) s = 0.35 + 0.65 * (t / 0.18);
      else {
        const k = (t - 0.18) / 0.82;
        s = this.pTrail[i] ? (1 + 0.1 * k) * (1 - k * k) : (1 + 0.25 * k) * (1 - k * k * k);
      }
      let r = s * this.pSize[i];
      // A puff never swallows the camera (its ink hull would black out the screen): it stays clear of the eye.
      const d = Math.hypot(pos[i * 3] - cam.x, pos[i * 3 + 1] - cam.y, pos[i * 3 + 2] - cam.z);
      const room = (d - 0.35) * 0.6;
      if (r > room) r = Math.max(0, room);
      writeTRS(m, i * 16, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3], r);
      // Colour phase: hot puffs run the whole ramp, cool ones start at cream.
      const heat = this.pHeat[i];
      const c = Math.min(1, t * (0.7 + heat * 0.3) + (1 - heat) * RAMP_AT[2]);
      let k = 1;
      while (k < 3 && c > RAMP_AT[k]) k++;
      const a = RAMP[k - 1];
      const b = RAMP[k];
      const f = (c - RAMP_AT[k - 1]) / (RAMP_AT[k] - RAMP_AT[k - 1]);
      col[i * 3] = a.r + (b.r - a.r) * f;
      col[i * 3 + 1] = a.g + (b.g - a.g) * f;
      col[i * 3 + 2] = a.b + (b.b - a.b) * f;
      this.puffGlow[i] = c < RAMP_AT[2] ? (1 - c / RAMP_AT[2]) * 1.4 : 0;
      i++;
    }
    this.livePuffs = n;
    if (this.nextPuff >= n) this.nextPuff = 0;
    this.puffs.count = this.puffInk.count = n;
    this.puffs.visible = this.puffInk.visible = n > 0;
    upload(this.puffs.instanceMatrix, n);
    upload(this.puffs.instanceColor!, n);
    upload(this.puffGeo.attributes.glow as THREE.InstancedBufferAttribute, n);
  }

  private moveChunk(from: number, to: number) {
    move(this.dPos, 3, from, to);
    move(this.dVel, 3, from, to);
    move(this.dRot, 3, from, to);
    move(this.dSpin, 3, from, to);
    move(this.chunks.instanceColor!.array as Float32Array, 3, from, to);
    this.dLife[to] = this.dLife[from];
    this.dMax[to] = this.dMax[from];
    this.dSize[to] = this.dSize[from];
    this.dFloor[to] = this.dFloor[from];
    this.dHot[to] = this.dHot[from];
  }

  private updateDebris(dt: number) {
    if (this.liveChunks <= 0) return;
    const m = this.chunks.instanceMatrix.array as Float32Array;
    const pos = this.dPos;
    const vel = this.dVel;
    const rot = this.dRot;
    let n = this.liveChunks;
    let moved = false;
    let i = 0;
    while (i < n) {
      this.dLife[i] -= dt;
      if (this.dLife[i] <= 0) {
        n--;
        if (i < n) {
          this.moveChunk(n, i);
          moved = true;
        }
        this.dLife[n] = 0;
        continue;
      }
      vel[i * 3 + 1] -= 18 * dt;
      pos[i * 3] += vel[i * 3] * dt;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < this.dFloor[i] + this.dSize[i] && vel[i * 3 + 1] < 0) {
        pos[i * 3 + 1] = this.dFloor[i] + this.dSize[i];
        vel[i * 3 + 1] *= -0.35;
        vel[i * 3] *= 0.6;
        vel[i * 3 + 2] *= 0.6;
        this.dSpin[i * 3] *= 0.5;
        this.dSpin[i * 3 + 2] *= 0.5;
      }
      for (let k = 0; k < 3; k++) rot[i * 3 + k] += this.dSpin[i * 3 + k] * dt;
      _q.setFromEuler(_e.set(rot[i * 3], rot[i * 3 + 1], rot[i * 3 + 2]));
      const t = 1 - this.dLife[i] / this.dMax[i];
      const s = this.dSize[i] * (t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25);
      writeTRS(m, i * 16, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], _q.x, _q.y, _q.z, _q.w, s);
      this.chunkGlow[i] = this.dHot[i] * Math.max(0, 1 - t * 2.5);
      i++;
    }
    this.liveChunks = n;
    if (this.nextChunk >= n) this.nextChunk = 0;
    this.chunks.count = this.chunkInk.count = n;
    this.chunks.visible = this.chunkInk.visible = n > 0;
    upload(this.chunks.instanceMatrix, n);
    upload(this.chunkGeo.attributes.glow as THREE.InstancedBufferAttribute, n);
    if (moved) upload(this.chunks.instanceColor!, n);
  }

  private updateDecals(dt: number) {
    let changed = false;
    for (let i = 0; i < DECALS; i++) {
      if (this.decalLife[i] <= 0) continue;
      this.decalLife[i] -= dt;
      const fade = this.decalLife[i] <= 0 ? 0 : Math.min(1, this.decalLife[i] / DECAL_FADE);
      if (fade !== this.decalFade[i]) {
        this.decalFade[i] = fade;
        changed = true;
      }
    }
    if (changed) (this.decalGeo.attributes.fade as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  private updateRings(dt: number) {
    if (!this.ringMesh.visible && this.rings.every((r) => r.life <= 0)) return;
    const m = this.ringMesh.instanceMatrix.array as Float32Array;
    let live = 0;
    for (let i = 0; i < RINGS; i++) {
      const r = this.rings[i];
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) {
        writeTRS(m, i * 16, 0, 0, 0, 0, 0, 0, 1, 0);
        continue;
      }
      live++;
      const t = 1 - r.life / r.max;
      const e = 1 - (1 - t) * (1 - t) * (1 - t);
      const p = r.pos;
      writeTRS(m, i * 16, p.x, p.y, p.z, r.quat.x, r.quat.y, r.quat.z, r.quat.w, r.radius * (0.15 + 0.85 * e));
      // A ring going off at your own feet fades out instead of sweeping across the view.
      this.ringAlpha[i] = (1 - t * t) * this.nearCamera(p.x, p.y, p.z, 1, 2.5);
    }
    this.ringMesh.visible = live > 0;
    this.ringMesh.instanceMatrix.needsUpdate = true;
    (this.ringGeo.attributes.alpha as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  private updateFireballs(dt: number) {
    if (!this.shells.visible && this.fireballs.every((f) => f.life <= 0)) return;
    const shell = this.shells.instanceMatrix.array as Float32Array;
    const core = this.cores.instanceMatrix.array as Float32Array;
    const ink = this.ballInk.instanceMatrix.array as Float32Array;
    let live = 0;
    for (let i = 0; i < FIREBALLS; i++) {
      const f = this.fireballs[i];
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) {
        writeTRS(shell, i * 16, 0, 0, 0, 0, 0, 0, 1, 0);
        writeTRS(core, i * 16, 0, 0, 0, 0, 0, 0, 1, 0);
        writeTRS(ink, i * 16, 0, 0, 0, 0, 0, 0, 1, 0);
        if (f.light) this.lights.give(f.light);
        f.light = null;
        continue;
      }
      live++;
      const t = 1 - f.life / f.max;
      // Pop out fast, then sag and shrink: reads as a cartoon explosion rather than a glow.
      let s = f.radius * (t < 0.3 ? 0.3 + (t / 0.3) * 0.75 : 1.05 - (t - 0.3) * 0.9);
      const fade = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      // Right at the camera (your own rocket jump) it shrinks and fades fast, and the hot core goes first.
      const p = f.pos;
      const near = this.nearCamera(p.x, p.y, p.z, s, NEAR_BLAST);
      s *= 0.5 + 0.5 * near;
      const q = f.quat;
      writeTRS(shell, i * 16, p.x, p.y, p.z, q.x, q.y, q.z, q.w, s);
      // An opaque outline cannot fade, so it goes once the shell is see-through.
      writeTRS(ink, i * 16, p.x, p.y, p.z, q.x, q.y, q.z, q.w, near < 0.7 ? 0 : s);
      _v.set(0, 0.08 * s, 0).applyQuaternion(q);
      writeTRS(core, i * 16, p.x + _v.x, p.y + _v.y, p.z + _v.z, q.x, q.y, q.z, q.w, s * 0.62);
      this.shellAlpha[i] = fade * near;
      this.coreAlpha[i] = fade * near * near;
      if (f.light) f.light.intensity = f.intensity * (1 - t) * (1 - t);
    }
    this.shells.visible = this.cores.visible = this.ballInk.visible = live > 0;
    this.shells.instanceMatrix.needsUpdate = true;
    this.cores.instanceMatrix.needsUpdate = true;
    this.ballInk.instanceMatrix.needsUpdate = true;
    (this.ballGeo.attributes.alpha as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.coreGeo.attributes.alpha as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  dispose() {
    this.scene.onBeforeRender = this.sceneBeforeRender;
    this.scene.remove(this.points, this.puffs, this.puffInk, this.chunks, this.chunkInk, this.decals, this.ringMesh, this.cores, this.shells, this.ballInk);
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.dot.dispose();
    for (const f of this.fireballs) if (f.light) this.lights.give(f.light);
    for (const w of this.words) {
      this.scene.remove(w.sprite);
      w.sprite.material.dispose();
    }
    for (const t of this.wordTextures) t.dispose();
    for (const g of [this.ballGeo, this.coreGeo, this.ballHull, this.puffGeo, this.puffHull, this.chunkGeo, this.chunkHull, this.decalGeo, this.ringGeo]) g.dispose();
    for (const m of [this.puffs, this.puffInk, this.chunks, this.chunkInk, this.decals, this.ringMesh, this.cores, this.shells, this.ballInk]) m.dispose();
    for (const m of [this.toonMat, this.inkMat, this.decalMat, this.ringMat, this.shellMat, this.coreMat]) m.dispose();
    this.scorchTex.dispose();
  }
}
