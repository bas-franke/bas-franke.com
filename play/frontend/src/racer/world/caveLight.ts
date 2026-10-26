// Light inside the caves and the tunnel shortcuts (rockFormations.ts builds the rock and hands the layout over):
// - the cave rock material: MeshStandardMaterial (sun, shadows, fog like the terrain) with flat chiselled facets,
//   per-vertex albedo and a baked per-vertex glow added as emission: warm orange where the light shafts and the mouths
//   light the rock, cool violet/blue in the recessed blocks and crevices, so the inside reads warm key vs cool fill;
// - god rays: slanted additive light cones from each skylight in a cave roof down to the floor, brightest face-on and
//   near the roof, with slow streaks; a soft warm pool of light where each one lands, and dust motes drifting in them;
// - mouth glows: a big soft additive disc just outside each mouth facing in, so the way out blooms;
// - embers: orange sparks drifting down a tunnel.
// All of it is a handful of meshes per cave, animated in the shaders (time comes from onBeforeRender), no lights.

import * as THREE from 'three';
import type { Track } from '../core/track';
import type { Quality } from './types';

// ---------------------------------------------------------------------------------------------------------------
// Rock material and geometry

/** The cave rock: vertex colours (linear albedo) and baked light: aWarm, the warm key's radiance, coming from aKey (a
 * world direction towards the light), and aCool, the cool fill from the other way. Both are shaded on the flat facet
 * normal, so every chiselled plane of a block takes the light differently. Facets, both sides, less haze than outside. */
export function createCaveRockMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.93, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aWarm;
attribute vec3 aCool;
attribute vec3 aKey;
varying vec3 vWarm;
varying vec3 vCool;
varying vec3 vKey;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vWarm = aWarm;
vCool = aCool;
vKey = aKey;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWarm;
varying vec3 vCool;
varying vec3 vKey;`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 kl = (viewMatrix * vec4(vKey, 0.0)).xyz;
          float kn = length(kl);
          float nl = kn > 1e-4 ? dot(normal, kl / kn) : 0.0;
          totalEmissiveRadiance += vWarm * (0.12 + 1.2 * max(nl, 0.0)) + vCool * (0.3 + 0.9 * max(-nl, 0.0));
        }`,
      )
      .replace(
        '#include <fog_fragment>',
        THREE.ShaderChunk.fog_fragment.replace(/mix\(\s*gl_FragColor\.rgb\s*,\s*fogColor\s*,\s*fogFactor\s*\)/, 'mix( gl_FragColor.rgb, fogColor, fogFactor * 0.55 )'),
      );
  };
  mat.customProgramCacheKey = () => 'cave-rock';
  return mat;
}

/** Accumulates cave rock: grids with cells left out (skylights) and loose quads, each vertex with albedo and light. */
export class CaveRockBuilder {
  pos: number[] = [];
  col: number[] = [];
  warm: number[] = [];
  cool: number[] = [];
  key: number[] = [];
  idx: number[] = [];

  vertex(x: number, y: number, z: number, c: THREE.Color, warm: THREE.Color, cool: THREE.Color, key: THREE.Vector3): number {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    this.warm.push(warm.r, warm.g, warm.b);
    this.cool.push(cool.r, cool.g, cool.b);
    this.key.push(key.x, key.y, key.z);
    return this.pos.length / 3 - 1;
  }

  /** A grid, column-major like GeoBuilder's (p[(i * rows + j) * 3]); `skip(i, j)` leaves out the cell i..i+1, j..j+1.
   * The per-vertex arrays are laid out like `p`. */
  grid(p: ArrayLike<number>, cols: number, rows: number, color: ArrayLike<number>, warm: ArrayLike<number>, cool: ArrayLike<number>, key: ArrayLike<number>, skip?: (i: number, j: number) => boolean) {
    const base = this.pos.length / 3;
    for (let k = 0; k < cols * rows * 3; k++) {
      this.pos.push(p[k]);
      this.col.push(color[k]);
      this.warm.push(warm[k]);
      this.cool.push(cool[k]);
      this.key.push(key[k]);
    }
    for (let i = 0; i < cols - 1; i++) {
      for (let j = 0; j < rows - 1; j++) {
        if (skip?.(i, j)) continue;
        const v00 = base + i * rows + j;
        this.idx.push(v00, v00 + rows + 1, v00 + rows, v00, v00 + 1, v00 + rows + 1);
      }
    }
  }

  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aWarm', new THREE.Float32BufferAttribute(this.warm, 3));
    g.setAttribute('aCool', new THREE.Float32BufferAttribute(this.cool, 3));
    g.setAttribute('aKey', new THREE.Float32BufferAttribute(this.key, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Light effects

/** A light shaft from a skylight (top, on the roof's inside) to the floor, and where it lands in track space. */
export interface Shaft {
  top: THREE.Vector3;
  bottom: THREE.Vector3;
  radius: number;
  s: number;
  x: number;
}

/** A mouth (or skylight) to glow: centre of the opening, unit normal pointing into the cave, half sizes across and up. */
export interface Mouth {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  across: THREE.Vector3;
  width: number;
  height: number;
  color: THREE.Color;
  /** 0: a rim of light hugging the opening (mouths); 1: a filled blaze of sky (skylights seen from below). */
  fill?: number;
}

/** Sparks for a tunnel: points sampled inside it and the direction of travel there. */
export interface EmberSpot {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
}

const time = { value: 0 };
const tick = () => {
  time.value = performance.now() / 1000;
};

const SHAFT_VERT = /* glsl */ `
attribute float aV;
attribute float aAng;
varying float vV;
varying float vAng;
varying vec3 vN;
varying vec3 vView;
void main() {
  vV = aV;
  vAng = aAng;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const SHAFT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
varying float vV;
varying float vAng;
varying vec3 vN;
varying vec3 vView;
void main() {
  float d = length(vView);
  float face = abs(dot(normalize(vN), -vView / d));
  float core = pow(face, 3.0);
  float along = smoothstep(0.0, 0.06, vV) * mix(1.0, 0.45, vV) * (1.0 - smoothstep(0.82, 1.0, vV));
  float streak = 0.6 + 0.4 * sin(vAng * 5.0 + uTime * 0.35 + vV * 2.0) * sin(vAng * 3.0 - uTime * 0.21);
  float fade = smoothstep(6.0, 30.0, d) * (1.0 - smoothstep(260.0, 460.0, d));
  gl_FragColor = vec4(uColor * core * along * streak * fade, 1.0);
}
`;

const POOL_VERT = /* glsl */ `
attribute vec2 aUv;
varying vec2 vUv;
varying float vD;
void main() {
  vUv = aUv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vD = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const POOL_FRAG = /* glsl */ `
uniform vec3 uColor;
varying vec2 vUv;
varying float vD;
void main() {
  float r = length(vUv);
  float k = pow(max(0.0, 1.0 - r * r), 2.0);
  float dapple = 0.8 + 0.2 * sin(vUv.x * 9.0 + sin(vUv.y * 7.0) * 2.0);
  gl_FragColor = vec4(uColor * k * dapple * (1.0 - smoothstep(260.0, 460.0, vD)), 1.0);
}
`;

const MOTE_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
varying float vA;
void main() {
  float t = uTime * (0.15 + aSeed.y * 0.2) + aSeed.x * 6.283;
  vec3 p = position + vec3(sin(t) * 0.9, sin(t * 0.7 + aSeed.z * 5.0) * 0.6 - fract(uTime * 0.02 + aSeed.w) * 1.5, cos(t * 0.8) * 0.9);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vA = (0.55 + 0.45 * sin(uTime * (0.6 + aSeed.z) + aSeed.w * 6.283)) * smoothstep(2.0, 6.0, -mv.z) * (1.0 - smoothstep(90.0, 160.0, -mv.z));
  gl_PointSize = uScale * (0.06 + 0.06 * aSeed.y) / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const MOTE_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float k = max(0.0, 1.0 - dot(c, c));
  gl_FragColor = vec4(uColor * k * k * vA, 1.0);
}
`;

const EMBER_VERT = /* glsl */ `
attribute vec3 aVel;
attribute float aPhase;
uniform float uTime;
uniform float uScale;
varying float vA;
void main() {
  float life = fract(uTime / 2.6 + aPhase);
  vec3 p = position + aVel * life * 2.6 + vec3(0.0, -0.8 * life * life, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vA = sin(life * 3.14159) * (0.6 + 0.4 * sin(uTime * 23.0 + aPhase * 50.0)) * smoothstep(1.0, 4.0, -mv.z);
  gl_PointSize = uScale * (0.09 + 0.07 * fract(aPhase * 7.0)) / -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const MOUTH_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
void main() {
  vUv = uv * 2.0 - 1.0;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const MOUTH_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uFill;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
void main() {
  float d = length(vView);
  float r = length(vUv);
  // A bright rim hugging the opening plus a softer veil over it.
  float k = mix(0.22 * pow(max(0.0, 1.0 - r), 1.5) + 0.4 * exp(-pow((r - 0.8) / 0.3, 2.0)), 1.0 - smoothstep(0.5, 1.0, r), uFill);
  float face = max(0.0, dot(normalize(vN), -vView / d));
  float fade = smoothstep(6.0, 40.0, d) * (1.0 - smoothstep(320.0, 520.0, d));
  gl_FragColor = vec4(uColor * k * face * fade, 1.0);
}
`;

function additive(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, side: THREE.Side = THREE.FrontSide) {
  return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side, fog: false });
}

/** Builds the shafts, pools, motes, mouth glows and embers for one cave or tunnel. */
export function buildCaveFx(track: Track, quality: Quality, shafts: Shaft[], mouths: Mouth[], embers: EmberSpot[]) {
  const meshes: THREE.Object3D[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const scale = { value: 900 };
  const keep = (o: THREE.Mesh | THREE.Points, name: string) => {
    o.name = name;
    o.frustumCulled = true;
    o.renderOrder = 5;
    o.onBeforeRender = (renderer) => {
      tick();
      scale.value = renderer.domElement.height * 0.9;
    };
    geos.push(o.geometry);
    mats.push(o.material as THREE.Material);
    meshes.push(o);
  };

  if (shafts.length) {
    // Cones: SEG sides, open, widening a little towards the floor.
    const SEG = 16;
    const pos: number[] = [];
    const nrm: number[] = [];
    const av: number[] = [];
    const ang: number[] = [];
    const idx: number[] = [];
    const axis = new THREE.Vector3();
    const u = new THREE.Vector3();
    const w = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const sh of shafts) {
      axis.subVectors(sh.bottom, sh.top).normalize();
      u.set(0, 1, 0).cross(axis);
      if (u.lengthSq() < 1e-4) u.set(1, 0, 0);
      u.normalize();
      w.crossVectors(axis, u).normalize();
      const base = pos.length / 3;
      for (let k = 0; k <= SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        n.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a));
        for (const [v, rad] of [[0, sh.radius], [1, sh.radius * 1.3]] as const) {
          const c = v === 0 ? sh.top : sh.bottom;
          pos.push(c.x + n.x * rad, c.y + n.y * rad, c.z + n.z * rad);
          nrm.push(n.x, n.y, n.z);
          av.push(v);
          ang.push(a + sh.s * 0.37);
        }
      }
      for (let k = 0; k < SEG; k++) {
        const a = base + k * 2;
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('aV', new THREE.Float32BufferAttribute(av, 1));
    g.setAttribute('aAng', new THREE.Float32BufferAttribute(ang, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    keep(new THREE.Mesh(g, additive(SHAFT_VERT, SHAFT_FRAG, { uColor: { value: new THREE.Color(0.8, 0.46, 0.19) }, uTime: time }, THREE.DoubleSide)), 'cave-shafts');

    // Pools of light where they land: an ellipse stretched along the shaft's lean, draped over the floor.
    const pp: number[] = [];
    const puv: number[] = [];
    const pidx: number[] = [];
    const N = 9;
    for (const sh of shafts) {
      const f = track.frameAt(sh.s);
      const hx = sh.top.x - sh.bottom.x;
      const hz = sh.top.z - sh.bottom.z;
      const hl = Math.hypot(hx, hz) || 1;
      const rl = Math.hypot(f.right.x, f.right.z) || 1;
      const tl = Math.hypot(f.tangent.x, f.tangent.z) || 1;
      const at = (hx * f.tangent.x + hz * f.tangent.z) / hl / tl;
      const ar = (hx * f.right.x + hz * f.right.z) / hl / rl;
      const len = sh.radius * 1.3 * 1.9;
      const wid = sh.radius * 1.3 * 1.15;
      const base = pp.length / 3;
      const v = new THREE.Vector3();
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const a = (i / (N - 1)) * 2 - 1;
          const b = (j / (N - 1)) * 2 - 1;
          const du = a * len;
          const dw = b * wid;
          track.toWorld(sh.s + du * at - dw * ar, sh.x + du * ar + dw * at, 0.12, v);
          pp.push(v.x, v.y, v.z);
          puv.push(a, b);
        }
      }
      for (let i = 0; i < N - 1; i++) {
        for (let j = 0; j < N - 1; j++) {
          const q = base + i * N + j;
          pidx.push(q, q + N, q + N + 1, q, q + N + 1, q + 1);
        }
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
    pg.setAttribute('aUv', new THREE.Float32BufferAttribute(puv, 2));
    pg.setIndex(pidx);
    pg.computeBoundingSphere();
    const pm = additive(POOL_VERT, POOL_FRAG, { uColor: { value: new THREE.Color(0.9, 0.48, 0.18) } }, THREE.DoubleSide);
    pm.polygonOffset = true;
    pm.polygonOffsetFactor = -2;
    pm.polygonOffsetUnits = -2;
    keep(new THREE.Mesh(pg, pm), 'cave-pools');

    // Dust motes in the shafts.
    const per = quality === 'low' ? 18 : quality === 'medium' ? 40 : 70;
    const mp: number[] = [];
    const ms: number[] = [];
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (const sh of shafts) {
      for (let k = 0; k < per; k++) {
        const t = 0.15 + rnd() * 0.8;
        const a = rnd() * Math.PI * 2;
        const rr = Math.sqrt(rnd()) * sh.radius * (1 + 0.45 * t) * 0.85;
        axis.subVectors(sh.bottom, sh.top).normalize();
        u.set(0, 1, 0).cross(axis).normalize();
        w.crossVectors(axis, u).normalize();
        const p = sh.top.clone().lerp(sh.bottom, t).addScaledVector(u, Math.cos(a) * rr).addScaledVector(w, Math.sin(a) * rr);
        mp.push(p.x, p.y, p.z);
        ms.push(rnd(), rnd(), rnd(), rnd());
      }
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
    mg.setAttribute('aSeed', new THREE.Float32BufferAttribute(ms, 4));
    mg.computeBoundingSphere();
    keep(new THREE.Points(mg, additive(MOTE_VERT, MOTE_FRAG, { uColor: { value: new THREE.Color(2.2, 1.4, 0.6) }, uTime: time, uScale: scale })), 'cave-motes');
  }

  // Mouth glows.
  for (const m of mouths) {
    const g = new THREE.PlaneGeometry(2, 2, 1, 1);
    const mesh = new THREE.Mesh(g, additive(MOUTH_VERT, MOUTH_FRAG, { uColor: { value: m.color }, uFill: { value: m.fill ?? 0 } }));
    const up = new THREE.Vector3().crossVectors(m.normal, m.across).normalize();
    if (up.y < 0) up.negate();
    const across = new THREE.Vector3().crossVectors(up, m.normal).normalize();
    mesh.matrix.makeBasis(across.multiplyScalar(m.width), up.multiplyScalar(m.height), m.normal.clone());
    mesh.matrix.setPosition(m.center);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldNeedsUpdate = true;
    keep(mesh, 'cave-mouth-glow');
  }

  // Embers.
  if (embers.length) {
    const ep: number[] = [];
    const ev: number[] = [];
    const eph: number[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const keepN = quality === 'low' ? 0.35 : quality === 'medium' ? 0.6 : 1;
    for (const e of embers) {
      if (rnd() > keepN) continue;
      ep.push(e.pos.x, e.pos.y, e.pos.z);
      const sp = 3 + rnd() * 9;
      ev.push(e.dir.x * sp + (rnd() - 0.5) * 2.5, 0.4 + rnd() * 1.6, e.dir.z * sp + (rnd() - 0.5) * 2.5);
      eph.push(rnd());
    }
    if (ep.length) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
      eg.setAttribute('aVel', new THREE.Float32BufferAttribute(ev, 3));
      eg.setAttribute('aPhase', new THREE.Float32BufferAttribute(eph, 1));
      eg.computeBoundingSphere();
      if (eg.boundingSphere) eg.boundingSphere.radius += 30;
      keep(new THREE.Points(eg, additive(EMBER_VERT, MOTE_FRAG, { uColor: { value: new THREE.Color(3.2, 1.1, 0.25) }, uTime: time, uScale: scale })), 'tunnel-embers');
    }
  }

  return {
    meshes,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
