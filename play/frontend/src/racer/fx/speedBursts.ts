// One-shot and state effects: sparks (wall scrapes and impacts, embers, paint flecks, electrical crackle and the
// segments of binder arcs), expanding glow rings (boost pads on the ground, the boost kick behind a pod) and the
// translucent shock cone wrapped around a boosting pod. Three draw calls in total.

import * as THREE from 'three';
import { ADDITIVE_FOG, InstanceRing, fxMaterial, quadGeometry } from './particles';

const SPARK_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aT; // spawn time, life, width, seed
attribute vec4 aC; // colour (black = hot metal), gravity scale
attribute vec3 aSeg; // non-zero: a straight segment (an arc's stroke) riding along at aVel instead of a flying spark
uniform float uTime;
uniform vec3 uCamVel;
varying float vV;
varying float vU;
varying float vTail;
varying vec3 vCol;
varying float vSeg;
void main() {
  float age = uTime - aT.x;
  float u = age / aT.y;
  if (u < 0.0 || u > 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec3 p;
  vec3 streak;
  vSeg = dot(aSeg, aSeg) > 0.0 ? 1.0 : 0.0;
  if (vSeg > 0.5) {
    // Arc strokes keep their shape and move with the pod they belong to, so a bolt stays on the binder at 150 m/s.
    p = aPos + aVel * age;
    streak = aSeg;
  } else {
    vec3 g = vec3(0.0, -16.0 * aC.w, 0.0);
    float drag = exp(-1.5 * age);
    p = aPos + aVel * (1.0 - drag) / 1.5 + 0.5 * g * age * age;
    vec3 vel = aVel * drag + g * age;
    streak = -(vel - uCamVel) * 0.022;
    float l = length(streak);
    if (l > 2.5) streak *= 2.5 / l;
  }
  float sl = length(streak);
  vec3 a = p + (position.x > 0.0 ? streak : vec3(0.0));
  vec3 view = normalize(cameraPosition - a);
  vec3 sdir = sl > 1e-3 ? streak / max(sl, 1e-3) : vec3(0.0, 1.0, 0.0);
  vec3 side = normalize(cross(sdir, view) + vec3(1e-4));
  float dist = length(cameraPosition - a);
  a += side * position.y * max(aT.z, dist * 0.0015);
  vV = position.y;
  vU = u;
  vTail = position.x > 0.0 ? 1.0 : 0.0;
  vCol = aC.rgb;
  vec4 mvPosition = viewMatrix * vec4(a, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SPARK_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
varying float vV;
varying float vU;
varying float vTail;
varying vec3 vCol;
varying float vSeg;
void main() {
  float a = (1.0 - vV * vV) * mix((1.0 - vU) * (1.0 - 0.9 * vTail), 1.0 - vU * vU, vSeg);
  vec3 hot = mix(vec3(4.0, 3.2, 1.6), vec3(3.0, 0.9, 0.2), smoothstep(0.0, 0.6, vU + vTail * 0.3));
  // Coloured sparks (paint flecks, binder crackle) keep their colour, with a white-hot core on arc strokes.
  vec3 col = vCol.r + vCol.g + vCol.b > 0.0 ? mix(vCol, vec3(3.5), vSeg * (1.0 - vV * vV) * 0.45) : hot;
  gl_FragColor = vec4(col, a);
  ${ADDITIVE_FOG}
}
`;

const RING_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 aPos;
attribute vec3 aAx;
attribute vec3 aAy;
attribute vec4 aT; // spawn time, life, radius, unused
attribute vec3 aCol;
uniform float uTime;
varying vec2 vC;
varying float vU;
varying vec3 vCol;
void main() {
  float age = uTime - aT.x;
  float u = age / aT.y;
  if (u < 0.0 || u > 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float grow = aT.z * (0.25 + 0.75 * (1.0 - pow(1.0 - u, 3.0)));
  vec3 wp = aPos + (aAx * position.x + aAy * position.y) * grow;
  vC = position.xy;
  vU = u;
  vCol = aCol;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const RING_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
varying vec2 vC;
varying float vU;
varying vec3 vCol;
void main() {
  float r = length(vC);
  if (r > 1.0) discard;
  float bd = (r - 0.86) / 0.09;
  float band = exp(-bd * bd);
  float flash = (1.0 - r) * (1.0 - smoothstep(0.0, 0.35, vU)) * 0.8;
  float a = (band + flash) * (1.0 - vU) * (1.0 - vU);
  gl_FragColor = vec4(vCol * (1.0 + band), a);
  ${ADDITIVE_FOG}
}
`;

const CONE_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float aI;
attribute vec3 aCol;
varying float vAlong;
varying float vI;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vView;
varying float vAng;
void main() {
  vAlong = clamp((position.z + 5.0) / 17.0, 0.0, 1.0);
  vAng = atan(position.y, position.x);
  vI = aI;
  vCol = aCol;
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vN = normalize(mat3(m) * normal);
  vView = normalize(cameraPosition - wp.xyz);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const CONE_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
varying float vAlong;
varying float vI;
varying vec3 vCol;
varying vec3 vN;
varying vec3 vView;
varying float vAng;
void main() {
  float fres = clamp(1.0 - abs(dot(normalize(vN), normalize(vView))), 0.0, 1.0);
  float rings = 0.55 + 0.45 * sin(vAlong * 34.0 - uTime * 55.0);
  float streaks = 0.6 + 0.4 * sin(vAng * 9.0 + vAlong * 3.0);
  float a = vI * pow(fres, 1.6) * smoothstep(0.0, 0.25, vAlong) * pow(1.0 - vAlong, 1.4) * rings * streaks * 0.22;
  if (a < 0.003) discard;
  gl_FragColor = vec4(mix(vec3(1.0), vCol, 0.75), a);
  ${ADDITIVE_FOG}
}
`;

export class BurstSystem {
  readonly sparks: THREE.Mesh;
  readonly rings: THREE.Mesh;
  readonly cones: THREE.InstancedMesh;
  private readonly sparkRing: InstanceRing;
  private readonly ringRing: InstanceRing;
  private readonly sa: Record<string, THREE.InstancedBufferAttribute>;
  private readonly ra: Record<string, THREE.InstancedBufferAttribute>;
  private readonly coneI: THREE.InstancedBufferAttribute;
  private readonly coneCol: THREE.InstancedBufferAttribute;
  private readonly mats: THREE.ShaderMaterial[];
  private time = 0;

  constructor(sparkCount: number, ringCount: number, podCount: number) {
    const s = quadGeometry(sparkCount, { aPos: 3, aVel: 3, aT: 4, aC: 4, aSeg: 3 });
    const r = quadGeometry(ringCount, { aPos: 3, aAx: 3, aAy: 3, aT: 4, aCol: 3 });
    for (const [attr, n] of [[s.attr.aT, sparkCount], [r.attr.aT, ringCount]] as const) {
      for (let i = 0; i < n; i++) attr.setXY(i, -1e6, 1);
    }
    this.sa = s.attr;
    this.ra = r.attr;
    this.sparkRing = new InstanceRing(sparkCount, s.attr);
    this.ringRing = new InstanceRing(ringCount, r.attr);
    const sparkMat = fxMaterial({
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      additive: true,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uCamVel: { value: new THREE.Vector3() } },
    });
    const ringMat = fxMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      additive: true,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
    });
    this.sparks = new THREE.Mesh(s.geo, sparkMat);
    this.rings = new THREE.Mesh(r.geo, ringMat);

    // Shock cone: apex just ahead of the pod's nose, flaring open behind it (local -Z is forward).
    const coneGeo = new THREE.CylinderGeometry(6.5, 1.2, 17, 28, 1, true);
    coneGeo.rotateX(Math.PI / 2);
    coneGeo.translate(0, 0.3, 3.5);
    this.coneI = new THREE.InstancedBufferAttribute(new Float32Array(podCount), 1).setUsage(THREE.DynamicDrawUsage);
    this.coneCol = new THREE.InstancedBufferAttribute(new Float32Array(podCount * 3), 3).setUsage(THREE.DynamicDrawUsage);
    coneGeo.setAttribute('aI', this.coneI);
    coneGeo.setAttribute('aCol', this.coneCol);
    const coneMat = fxMaterial({
      vertexShader: CONE_VERT,
      fragmentShader: CONE_FRAG,
      additive: true,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
    });
    this.cones = new THREE.InstancedMesh(coneGeo, coneMat, podCount);
    this.cones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mats = [sparkMat, ringMat, coneMat];
    for (const m of [this.sparks, this.rings, this.cones]) {
      m.frustumCulled = false;
      m.renderOrder = 3;
    }
  }

  setTime(time: number, camVel: THREE.Vector3) {
    this.time = time;
    for (const m of this.mats) m.uniforms.uTime.value = time;
    this.mats[0].uniforms.uCamVel.value.copy(camVel);
  }

  /** A spark flying from `pos` at `vel`; `color` (linear, may exceed 1 to bloom) replaces the hot-metal ramp. */
  spark(pos: THREE.Vector3, vel: THREE.Vector3, life: number, width: number, color?: THREE.Color, gravity = 1) {
    const i = this.sparkRing.next();
    this.sa.aPos.setXYZ(i, pos.x, pos.y, pos.z);
    this.sa.aVel.setXYZ(i, vel.x, vel.y, vel.z);
    this.sa.aT.setXYZW(i, this.time, life, width, Math.random());
    if (color) this.sa.aC.setXYZW(i, color.r, color.g, color.b, gravity);
    else this.sa.aC.setXYZW(i, 0, 0, 0, gravity);
    this.sa.aSeg.setXYZ(i, 0, 0, 0);
  }

  /** One straight stroke of an electric arc from `a` to `b`, carried along at `vel` (the pod's velocity). */
  stroke(a: THREE.Vector3, b: THREE.Vector3, vel: THREE.Vector3, life: number, width: number, color: THREE.Color) {
    const i = this.sparkRing.next();
    this.sa.aPos.setXYZ(i, a.x, a.y, a.z);
    this.sa.aVel.setXYZ(i, vel.x, vel.y, vel.z);
    this.sa.aT.setXYZW(i, this.time, life, width, Math.random());
    this.sa.aC.setXYZW(i, color.r, color.g, color.b, 0);
    // A zero-length stroke would read as a spark; nudge it.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    this.sa.aSeg.setXYZ(i, dx || 1e-3, dy, dz);
  }

  /** A ring centred on `pos` spanning the plane of `ax`/`ay` (unit vectors), growing to `radius`. */
  ring(pos: THREE.Vector3, ax: THREE.Vector3, ay: THREE.Vector3, radius: number, life: number, color: THREE.Color) {
    const i = this.ringRing.next();
    this.ra.aPos.setXYZ(i, pos.x, pos.y, pos.z);
    this.ra.aAx.setXYZ(i, ax.x, ax.y, ax.z);
    this.ra.aAy.setXYZ(i, ay.x, ay.y, ay.z);
    this.ra.aT.setXYZW(i, this.time, life, radius, 0);
    this.ra.aCol.setXYZ(i, color.r, color.g, color.b);
  }

  /** Shock cone of pod `k`: its world matrix (null hides it), 0..1 intensity and colour. */
  cone(k: number, matrix: THREE.Matrix4 | null, intensity: number, color: THREE.Color) {
    this.cones.setMatrixAt(k, matrix ?? ZERO);
    this.coneI.setX(k, intensity);
    this.coneCol.setXYZ(k, color.r, color.g, color.b);
  }

  flush() {
    this.sparkRing.flush();
    this.ringRing.flush();
    this.cones.instanceMatrix.needsUpdate = true;
    this.coneI.needsUpdate = true;
    this.coneCol.needsUpdate = true;
  }

  dispose() {
    this.sparks.geometry.dispose();
    this.rings.geometry.dispose();
    this.cones.geometry.dispose();
    this.cones.dispose();
    for (const m of this.mats) m.dispose();
  }
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
