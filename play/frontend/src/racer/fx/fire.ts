// Flames: burning engine parts on damaged pods and burning debris. One instanced draw of additive, camera-facing
// flame tongues in a ring buffer, flown by the vertex shader like the dust (drag towards rest, buoyant rise) and
// stretched along their motion relative to the camera, so a burning engine at speed licks a tongue of fire back
// behind it. Colour runs white-yellow at birth through orange to a dim red as each tongue cools, bright enough at
// the core to bloom.

import * as THREE from 'three';
import { ADDITIVE_FOG, InstanceRing, fxMaterial, puffAtlas, quadGeometry } from './particles';

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 aPos;
attribute vec3 aVel;
attribute vec4 aT; // spawn time, life, start size, end size
attribute vec4 aM; // seed, buoyancy, drag, heat
uniform float uTime;
uniform vec3 uCamVel;
varying vec2 vUv;
varying vec2 vC;
varying float vU;
varying float vHeat;
varying float vSeed;
void main() {
  float age = uTime - aT.x;
  float u = age / aT.y;
  if (u < 0.0 || u > 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float k = aM.z;
  float e = exp(-k * age);
  // Hot gas accelerates upwards as it rises; the tongue swells fast, then thins out as it burns away.
  vec3 p = aPos + aVel * (1.0 - e) / k + vec3(0.0, aM.y * age * (0.5 + age), 0.0);
  vec3 vel = aVel * e + vec3(0.0, aM.y * (0.5 + 2.0 * age), 0.0);
  float size = mix(aT.z, aT.w, sqrt(u)) * (1.0 - 0.45 * u * u);
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  // Buoyancy always draws a slow flame up into a tongue; speed drags it back along the motion.
  vec3 rel = vel - uCamVel + vec3(0.0, size * 12.0, 0.0);
  vec2 sv = vec2(dot(rel, camR), dot(rel, camU)) * 0.035;
  float sl = clamp(length(sv), size * 2.2, size * 5.0);
  vec2 dir = length(sv) > 1e-4 ? normalize(sv) : vec2(0.0, 1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 c = position.xy;
  // Stretched backwards from the head (the flame trails off its source rather than smearing both ways).
  vec2 off = dir * (c.x * (size + sl * 0.5) - sl * 0.5) + nrm * c.y * size;
  vec3 wp = p + camR * off.x + camU * off.y;
  float flip = fract(aM.x * 3.7) > 0.5 ? -1.0 : 1.0;
  float cell = floor(fract(aM.x * 7.13) * 4.0);
  vUv = (vec2(c.x * flip, c.y) * 0.5 + 0.5 + vec2(mod(cell, 2.0), floor(cell / 2.0))) * 0.5;
  vC = c;
  vU = u;
  vHeat = aM.w * size / (size + sl * 0.4);
  vSeed = aM.x;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uTex;
uniform float uTime;
varying vec2 vUv;
varying vec2 vC;
varying float vU;
varying float vHeat;
varying float vSeed;
void main() {
  float d = texture2D(uTex, vUv).r;
  // Flicker: each tongue pulses on its own fast rhythm.
  float flick = 0.75 + 0.25 * sin(uTime * 47.0 + vSeed * 40.0) * sin(uTime * 23.0 + vSeed * 17.0);
  // Tongue: full width at the head, narrowing to a lick at the tail.
  float taper = 1.0 - smoothstep(0.2 + 0.6 * (vC.x * 0.5 + 0.5), 1.0, abs(vC.y));
  float a = d * taper * smoothstep(0.0, 0.06, vU) * pow(1.0 - vU, 1.3) * flick;
  if (a < 0.004) discard;
  // Thin edges and old tongues are cooler than the dense young core.
  float t = clamp(vU * 1.25 + (1.0 - d) * 0.45, 0.0, 1.0);
  // A pale core that does not blow out: only the very centre of a young tongue reaches bloom.
  vec3 col = mix(vec3(2.6, 2.0, 1.2), vec3(2.0, 0.8, 0.2), smoothstep(0.0, 0.4, t));
  col = mix(col, vec3(0.6, 0.12, 0.04), smoothstep(0.4, 1.0, t));
  gl_FragColor = vec4(col * vHeat, min(a, 1.0));
  ${ADDITIVE_FOG}
}
`;

export interface Flame {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  size0: number;
  size1: number;
  life: number;
  /** Upward acceleration of the hot gas, m/s^2. */
  rise: number;
  drag: number;
  /** Brightness, ~0.7 (burning debris) .. 1.25 (an engine fully alight). */
  heat: number;
}

export class FireSystem {
  readonly mesh: THREE.Mesh;
  private readonly ring: InstanceRing;
  private readonly a: Record<string, THREE.InstancedBufferAttribute>;
  private readonly mat: THREE.ShaderMaterial;
  private readonly tex: THREE.DataTexture;
  private time = 0;

  constructor(count: number) {
    const { geo, attr } = quadGeometry(count, { aPos: 3, aVel: 3, aT: 4, aM: 4 });
    for (let i = 0; i < count; i++) {
      attr.aT.setXY(i, -1e6, 1);
      attr.aM.setZ(i, 1);
    }
    this.a = attr;
    this.ring = new InstanceRing(count, attr);
    this.tex = puffAtlas();
    this.mat = fxMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      additive: true,
      uniforms: { uTime: { value: 0 }, uCamVel: { value: new THREE.Vector3() }, uTex: { value: null } },
    });
    this.mat.uniforms.uTex.value = this.tex;
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  emit(f: Flame) {
    const i = this.ring.next();
    const { aPos, aVel, aT, aM } = this.a;
    aPos.setXYZ(i, f.pos.x, f.pos.y, f.pos.z);
    aVel.setXYZ(i, f.vel.x, f.vel.y, f.vel.z);
    aT.setXYZW(i, this.time, f.life, f.size0, f.size1);
    aM.setXYZW(i, Math.random(), f.rise, f.drag, f.heat);
  }

  /** Call before emitting this frame's flames (spawn times use it). */
  setTime(time: number, camVel: THREE.Vector3) {
    this.time = time;
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uCamVel.value.copy(camVel);
  }

  flush() {
    this.ring.flush();
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
