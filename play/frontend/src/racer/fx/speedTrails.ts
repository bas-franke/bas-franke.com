// Exhaust heat trails: a camera-facing ribbon behind every nozzle, built on the CPU each frame from a short history of
// nozzle positions and drawn additively in one draw call for all pods. Hot glow colour at the nozzle, shifting to a
// violet/magenta tail that fades out; longer and brighter while boosting.

import * as THREE from 'three';
import { ADDITIVE_FOG, fxMaterial } from './particles';

/** Samples kept per trail (one per frame). */
const N = 26;

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aCol;
attribute float aV;
varying vec4 vCol;
varying float vV;
void main() {
  vCol = aCol;
  vV = aV;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
varying vec4 vCol;
varying float vV;
void main() {
  float edge = max(1.0 - vV * vV, 0.0);
  float a = vCol.a * edge * edge;
  // White-hot core along the middle of the ribbon.
  vec3 col = vCol.rgb + vec3(0.35, 0.4, 0.5) * pow(edge, 10.0);
  gl_FragColor = vec4(col, a);
  ${ADDITIVE_FOG}
}
`;

interface Trail {
  pos: Float32Array;
  t: Float32Array;
  head: number;
  len: number;
}

export interface TrailInput {
  nozzle: THREE.Vector3;
  glow: THREE.Color;
  /** 0..1.4 */
  speed01: number;
  boost: number;
}

export class TrailSystem {
  readonly mesh: THREE.Mesh;
  private readonly trails: Trail[] = [];
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly mat: THREE.ShaderMaterial;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tail = new THREE.Color();
  private readonly c = new THREE.Color();
  private used = 0;

  constructor(readonly max: number) {
    const verts = max * N * 2;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(verts * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const v = new Float32Array(verts);
    const idx: number[] = [];
    for (let t = 0; t < max; t++) {
      for (let i = 0; i < N; i++) {
        const b = (t * N + i) * 2;
        v[b] = -1;
        v[b + 1] = 1;
        if (i < N - 1) idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
      this.trails.push({ pos: new Float32Array(N * 3), t: new Float32Array(N), head: 0, len: 0 });
    }
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aCol', this.colAttr);
    geo.setAttribute('aV', new THREE.BufferAttribute(v, 1));
    geo.setIndex(idx);
    this.mat = fxMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: {}, additive: true, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /** Writes trail `k` for this frame. Call for k = 0..n-1, then `finish(n)`. */
  update(k: number, time: number, inp: TrailInput, camPos: THREE.Vector3) {
    const tr = this.trails[k];
    tr.head = (tr.head + 1) % N;
    tr.pos[tr.head * 3] = inp.nozzle.x;
    tr.pos[tr.head * 3 + 1] = inp.nozzle.y;
    tr.pos[tr.head * 3 + 2] = inp.nozzle.z;
    tr.t[tr.head] = time;
    tr.len = Math.min(N, tr.len + 1);

    const s = Math.min(1.3, inp.speed01);
    const maxAge = 0.1 + 0.1 * s + 0.12 * inp.boost;
    const width0 = 0.55 + 0.35 * inp.boost;
    const bright = (0.22 + 0.3 * s) * (1 + 0.9 * inp.boost);
    this.tail.copy(inp.glow).lerp(this.c.setRGB(0.75, 0.25, 1.0), 0.55);

    const P = this.posAttr.array as Float32Array;
    const C = this.colAttr.array as Float32Array;
    const base = k * N * 2;
    for (let i = 0; i < N; i++) {
      const j = (tr.head - i + N) % N;
      const age = time - tr.t[j];
      const u = i < tr.len ? age / maxAge : 2;
      const o = (base + i * 2) * 3;
      const oc = (base + i * 2) * 4;
      if (u >= 1) {
        // Collapse the rest of the ribbon onto the last live point.
        const prev = i > 0 ? o - 6 : o;
        for (let q = 0; q < 6; q++) P[o + q] = i > 0 ? P[prev + (q % 3)] : tr.pos[j * 3 + (q % 3)];
        for (let q = 0; q < 8; q++) C[oc + q] = 0;
        continue;
      }
      const p = this.tmpA.fromArray(tr.pos, j * 3);
      // Tangent from neighbours, ribbon side = tangent x view direction.
      const jn = (j + 1) % N;
      const jp = (j - 1 + N) % N;
      const a = this.tmpB.fromArray(tr.pos, (i > 0 ? jn : j) * 3);
      const b = this.tmpC.fromArray(tr.pos, (i < tr.len - 1 ? jp : j) * 3);
      const tan = a.sub(b);
      if (tan.lengthSq() < 1e-6) tan.set(0, 0, 1);
      const toCam = b.copy(camPos).sub(p);
      const side = tan.cross(toCam).normalize();
      const w = width0 * (1 - u * 0.65) * (0.5 + 0.5 * Math.min(1, i / 2));
      P[o] = p.x - side.x * w;
      P[o + 1] = p.y - side.y * w;
      P[o + 2] = p.z - side.z * w;
      P[o + 3] = p.x + side.x * w;
      P[o + 4] = p.y + side.y * w;
      P[o + 5] = p.z + side.z * w;
      const f = (1 - u) * (1 - u) * bright;
      this.c.copy(inp.glow).lerp(this.tail, Math.min(1, u * 1.6));
      for (let q = 0; q < 2; q++) {
        C[oc + q * 4] = this.c.r * 1.2;
        C[oc + q * 4 + 1] = this.c.g * 1.2;
        C[oc + q * 4 + 2] = this.c.b * 1.2;
        C[oc + q * 4 + 3] = f;
      }
    }
    this.used = Math.max(this.used, k + 1);
  }

  finish(n: number) {
    this.mesh.geometry.setDrawRange(0, Math.max(0, n * (N - 1) * 6));
    this.posAttr.clearUpdateRanges();
    this.posAttr.addUpdateRange(0, n * N * 2 * 3);
    this.posAttr.needsUpdate = true;
    this.colAttr.clearUpdateRanges();
    this.colAttr.addUpdateRange(0, n * N * 2 * 4);
    this.colAttr.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
