// Painterly cumulus: camera-centred billboards (one instanced draw call) sampling a procedural atlas of cloud shapes.
// Each shape is a union of spheres ("cauliflower" mounds piled on a flat base) roughened with noise; the atlas stores
// its normal (RG), thickness (B) and coverage (A), so the shader can light every puff from the theme's sun: warm
// sunlit tops, soft blue-grey undersides, a silver lining when the cloud is in front of the sun, and haze near the
// horizon. Drawn right after the sky dome without depth, so terrain always covers them.

import * as THREE from 'three';
import { rng } from '../core/track';
import type { Quality } from './types';

const VARIANTS = 4; // 2 x 2 atlas

function valueNoise(seed: number, w: number, h: number, cell: number): (x: number, y: number) => number {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const r = rng(seed);
  const g = new Float32Array(gw * gh).map(() => r());
  return (x, y) => {
    const fx = x / cell;
    const fy = y / cell;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    // Quintic fade: smooth enough that normals taken from it show no grid.
    const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const a = g[iy * gw + ix];
    const b = g[iy * gw + ix + 1];
    const c = g[(iy + 1) * gw + ix];
    const d = g[(iy + 1) * gw + ix + 1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

/** One cloud shape into the atlas at (ox, oy), w x h pixels. */
function paintCloud(data: Uint8Array, stride: number, ox: number, oy: number, w: number, h: number, seed: number) {
  const r = rng(seed);
  const height = new Float32Array(w * h);
  // y grows downwards here; the base line sits low in the tile. Odd variants are towering cumulus, even ones are
  // wider banks.
  const base = h * 0.82;
  const tower = seed % 2 === 1;
  type Puff = { x: number; y: number; r: number; z: number };
  const puffs: Puff[] = [];
  const span = tower ? 0.5 + r() * 0.1 : 0.72 + r() * 0.1;
  const n = tower ? 3 + Math.floor(r() * 2) : 5 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const bell = Math.sin(Math.PI * u);
    const pr = w * ((tower ? 0.1 : 0.07) + (tower ? 0.08 : 0.07) * bell + r() * 0.03);
    const x = w * (0.5 + (u - 0.5) * span) + (r() - 0.5) * pr * 0.4;
    puffs.push({ x, y: base - pr * (0.5 + r() * 0.2), r: pr, z: r() * pr * 0.3 });
  }
  // Pile smaller puffs on the upper rims of existing ones: the billowing cauliflower tops. Towers pile higher.
  const gens = tower ? 4 : 2;
  for (let gen = 0; gen < gens; gen++) {
    const parents = puffs.slice(gen === 0 ? 0 : -Math.max(1, Math.floor(puffs.length / 2)));
    for (const p of parents) {
      const kids = gen === 0 ? 2 + Math.floor(r() * 2) : Math.floor(r() * (tower ? 2.6 : 2.2));
      for (let k = 0; k < kids; k++) {
        const spread = tower ? 1.4 : 2.2;
        const a = -Math.PI / 2 + (r() - 0.5) * spread;
        const kr = p.r * (tower ? 0.55 + r() * 0.3 : 0.4 + r() * 0.3);
        const d = p.r * (0.6 + r() * 0.25);
        const y = p.y + Math.sin(a) * d;
        const x = p.x + Math.cos(a) * d;
        if (y - kr < h * 0.03 || x - kr < w * 0.02 || x + kr > w * 0.98) continue;
        puffs.push({ x, y, r: kr, z: p.z + p.r * 0.2 });
      }
    }
  }
  for (const p of puffs) {
    const x0 = Math.max(0, Math.floor(p.x - p.r));
    const x1 = Math.min(w - 1, Math.ceil(p.x + p.r));
    const y0 = Math.max(0, Math.floor(p.y - p.r));
    const y1 = Math.min(h - 1, Math.ceil(p.y + p.r));
    const r2 = p.r * p.r;
    const k = p.r * 0.2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dz = r2 - (x - p.x) ** 2 - (y - p.y) ** 2;
        if (dz <= 0) continue;
        const v = Math.sqrt(dz) + p.z;
        const i = y * w + x;
        // Smooth union: soft creases between puffs instead of hard sphere seams.
        const o = height[i];
        const q = Math.max(k - Math.abs(o - v), 0) / k;
        height[i] = Math.max(o, v) + q * q * k * 0.25;
      }
    }
  }
  // Roughen: broad lumps on the surface and a slightly ragged edge.
  const lump = valueNoise(seed * 7 + 1, w, h, h * 0.12);
  let max = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (height[i] <= 0) continue;
      height[i] = (height[i] + (lump(x, y) - 0.5) * h * 0.035);
      if (height[i] > max) max = height[i];
    }
  }
  const edge = h * 0.05;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hc = height[i];
      const o = ((oy + y) * stride + ox + x) * 4;
      if (hc <= 0) {
        data[o] = 128;
        data[o + 1] = 128;
        data[o + 2] = 0;
        data[o + 3] = 0;
        continue;
      }
      const hl = x > 0 ? height[i - 1] : 0;
      const hr = x < w - 1 ? height[i + 1] : 0;
      const hu = y > 0 ? height[i - w] : 0;
      const hd = y < h - 1 ? height[i + w] : 0;
      // Normal of the height field; image y is down, the texture's "up" is +y.
      let nx = (hl - hr) * 0.5;
      let ny = (hd - hu) * 0.5;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      // Soft flat base: the round puff bottoms dissolve just below the base line.
      const fade = Math.min(1, Math.max(0, (base + h * 0.035 - y) / (h * 0.07)));
      const a = Math.min(1, hc / edge) * fade;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round(Math.min(1, hc / max) * 255);
      data[o + 3] = Math.round(a * a * (3 - 2 * a) * 255);
    }
  }
}

export function makeCloudAtlas(tile: number): THREE.DataTexture {
  const w = tile * 2;
  const h = tile * 2;
  // Each variant is a tile x tile square; atlas is 2 x 2 variants.
  const data = new Uint8Array(w * h * 4);
  for (let v = 0; v < VARIANTS; v++) {
    const col = v % 2;
    const row = Math.floor(v / 2);
    paintCloud(data, w, col * tile, row * tile, tile, tile, 100 + v * 31);
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  // Image row 0 is the top of each tile; flip so uv.y = 1 is the top.
  tex.flipY = false;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

const vertexShader = /* glsl */ `
attribute vec4 aCloud;   // azimuth, elevation of the base, angular width, variant
attribute vec2 aExtra;   // mirror (+-1), height stretch
uniform float uTime;
uniform float uRadius;
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec3 vL;
varying float vMu;
varying float vElev;
varying float vY;

void main() {
  vY = uv.y;
  float az = aCloud.x + uTime * (0.0012 + 0.0008 * fract(aCloud.x * 3.7));
  float el = aCloud.y;
  vec3 dir = vec3(sin(az) * cos(el), sin(el), cos(az) * cos(el));
  vec3 toCam = -dir;
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec3 up = cross(toCam, right);
  float W = aCloud.z * uRadius;
  float H = W * aExtra.y;
  // The tile's base line is 18% up from its bottom edge; put that on the cloud's elevation.
  vec3 world = cameraPosition + dir * uRadius + right * (position.x * W) + up * ((position.y + 0.32) * H);
  vec3 vdir = normalize(world - cameraPosition);
  vElev = vdir.y;
  vMu = dot(vdir, uSunDir);
  // Light direction in the billboard's frame (x right, y up, z towards the viewer).
  vL = vec3(dot(uSunDir, right) * aExtra.x, dot(uSunDir, up), dot(uSunDir, toCam));
  float v = aCloud.w;
  vec2 tuv = vec2(aExtra.x > 0.0 ? uv.x : 1.0 - uv.x, 1.0 - uv.y);
  vUv = (tuv + vec2(mod(v, 2.0), floor(v / 2.0))) * 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uSun;
uniform vec3 uHaze;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vL;
varying float vMu;
varying float vElev;
varying float vY;

void main() {
  vec4 t = texture2D(uMap, vUv);
  if (t.a < 0.01) discard;
  vec3 n = vec3(t.rg * 2.0 - 1.0, 0.0);
  n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
  // Painted, not simulated: the light is kept a little in front of the cloud even when the sun is behind it, so a
  // backlit cloud reads as a bright rim over a soft grey body rather than a dark blob.
  vec3 L = normalize(vec3(vL.x, vL.y + 0.25, max(vL.z, 0.45)));
  float ndl = dot(n, L);
  // Soft but definite terminator, like brushed-in light and shadow shapes.
  float lit = smoothstep(-0.15, 0.5, ndl);
  // Cumulus bellies are in their own shadow whatever the sun does: the lower part of the shape goes blue-grey.
  float belly = smoothstep(0.2, 0.5, vY + n.y * 0.1);
  lit *= mix(0.15, 1.0, belly);
  vec3 col = mix(uShade, uLit, lit);
  // Gold rim: thin, sun-facing edges catch the light like a brushed highlight.
  float rim = (1.0 - t.b) * smoothstep(0.2, 0.8, ndl) * belly;
  col += uSun * rim * rim * 0.45;
  // Silver lining: thin edges glow when the cloud is between us and the sun.
  float back = pow(max(vMu, 0.0), 5.0);
  col += uSun * back * (1.0 - t.b) * 1.4;
  // Sink into the horizon haze.
  float hz = 1.0 - smoothstep(0.0, 0.22, vElev);
  col = mix(col, uHaze, hz * 0.65);
  float a = t.a * smoothstep(-0.005, 0.03, vElev) * uOpacity;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface Clouds {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  dispose(): void;
}

export function createClouds(opts: {
  coverage: number;
  quality: Quality;
  sunDir: THREE.Vector3;
  lit: THREE.Color;
  shade: THREE.Color;
  sun: THREE.Color;
  haze: THREE.Color;
  seed: number;
}): Clouds {
  const { coverage, quality } = opts;
  const map = makeCloudAtlas(quality === 'low' ? 192 : 384);
  const r = rng(opts.seed);
  const clusters = Math.round((quality === 'low' ? 6 : 10) + coverage * (quality === 'low' ? 12 : 26));
  type C = { az: number; el: number; size: number; v: number; flip: number; stretch: number };
  const list: C[] = [];
  for (let i = 0; i < clusters; i++) {
    const az = r() * Math.PI * 2;
    // Mostly low banks along the horizon, some higher, smaller ones.
    const high = r();
    const el = 0.005 + Math.pow(high, 1.7) * 0.55;
    const size = (0.36 + r() * 0.42) * (1 - high * 0.45);
    const parts = 1 + Math.floor(r() * (quality === 'low' ? 2 : 3.5));
    for (let k = 0; k < parts; k++) {
      list.push({
        az: az + (k === 0 ? 0 : (r() - 0.5) * size * 1.2),
        el: Math.max(0.003, el + (k === 0 ? 0 : (r() - 0.3) * size * 0.25)),
        size: size * (k === 0 ? 1 : 0.5 + r() * 0.4),
        v: Math.floor(r() * VARIANTS),
        flip: r() < 0.5 ? -1 : 1,
        stretch: 0.8 + r() * 0.35,
      });
    }
  }
  // Low (far) clouds first so higher, nearer ones are blended over them.
  list.sort((a, b) => a.el - b.el);
  const plane = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = plane.index;
  geo.setAttribute('position', plane.getAttribute('position'));
  geo.setAttribute('uv', plane.getAttribute('uv'));
  const a1 = new Float32Array(list.length * 4);
  const a2 = new Float32Array(list.length * 2);
  list.forEach((c, i) => {
    a1.set([c.az, c.el, c.size, c.v], i * 4);
    a2.set([c.flip, c.stretch], i * 2);
  });
  geo.setAttribute('aCloud', new THREE.InstancedBufferAttribute(a1, 4));
  geo.setAttribute('aExtra', new THREE.InstancedBufferAttribute(a2, 2));
  geo.instanceCount = list.length;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uTime: { value: 0 },
      uRadius: { value: 4000 },
      uSunDir: { value: opts.sunDir },
      uLit: { value: opts.lit },
      uShade: { value: opts.shade },
      uSun: { value: opts.sun },
      uHaze: { value: opts.haze },
      uOpacity: { value: 1 },
    },
    vertexShader,
    fragmentShader,
    // Not in the transparent list: drawn straight after the dome, before any opaque geometry, with explicit
    // (custom) blending since three turns normal blending off for opaque materials.
    transparent: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'skyClouds';
  mesh.frustumCulled = false;
  mesh.renderOrder = -999;
  return {
    mesh,
    material,
    dispose: () => {
      geo.dispose();
      plane.dispose();
      material.dispose();
      map.dispose();
    },
  };
}
