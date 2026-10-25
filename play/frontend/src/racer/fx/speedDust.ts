// Billowing sand clouds kicked up under and behind the pods: one instanced draw of camera-facing puffs in a ring
// buffer. The CPU only writes a particle once when it spawns; the vertex shader flies it (drag towards rest, a slow
// rise, growth) and stretches it along its motion relative to the camera, so dust streaks past at speed. The fragment
// shader lights each puff's lumps from the sun (warm sand on top, violet-brown shade below) and fades it into the
// road surface and away near the camera, which stands in for soft particles.

import * as THREE from 'three';
import type { Theme } from '../core/tracks';
import { InstanceRing, fxMaterial, linear, puffAtlas, quadGeometry } from './particles';

const VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec3 aVel;
attribute vec4 aT; // spawn time, life, start size, end size
attribute vec4 aM; // seed, rise speed, opacity, drag
uniform float uTime;
uniform vec3 uCamVel;
uniform float uShutter;
uniform vec3 uSun;
uniform vec2 uNear;
varying vec2 vUv;
varying vec2 vSph;
varying vec2 vDir;
varying float vAlpha;
varying float vH;
varying float vSize;
varying float vTone;
varying vec3 vSunV;
void main() {
  float age = uTime - aT.x;
  float u = age / aT.y;
  if (u < 0.0 || u > 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float k = aM.w;
  float e = exp(-k * age);
  float size = mix(aT.z, aT.w, 1.0 - pow(1.0 - u, 3.0));
  vec3 p = aPos + aVel * (1.0 - e) / k + aNrm * (size * 0.22 + aM.y * age);
  vec3 vel = aVel * e + aNrm * aM.y;
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 rel = vel - uCamVel;
  vec2 sv = vec2(dot(rel, camR), dot(rel, camU)) * uShutter;
  float sl = min(length(sv), size * 2.2);
  vec2 dir = length(sv) > 1e-4 ? normalize(sv) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 c = position.xy;
  vec2 off = dir * c.x * (size + sl * 0.5) + nrm * c.y * size;
  vec3 wp = p + camR * off.x + camU * off.y;
  vH = dot(wp - aPos, aNrm);
  vSize = size;
  float flip = fract(aM.x * 3.7) > 0.5 ? -1.0 : 1.0;
  float cell = floor(fract(aM.x * 7.13) * 4.0);
  vUv = (vec2(c.x * flip, c.y) * 0.5 + 0.5 + vec2(mod(cell, 2.0), floor(cell / 2.0))) * 0.5;
  vSph = c;
  vDir = dir * flip;
  vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);
  // Puffs right in front of the lens fade out early, so the pack's dust never hides the course.
  float near = smoothstep(uNear.x, uNear.y, -mvPosition.z);
  vAlpha = aM.z * smoothstep(0.0, 0.04, u) * (1.0 - smoothstep(0.25, 1.0, u)) * near * size / (size + sl * 0.7);
  vTone = fract(aM.x * 13.7);
  vSunV = normalize(mat3(viewMatrix) * uSun);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uTex;
uniform vec3 uLit;
uniform vec3 uShade;
varying vec2 vUv;
varying vec2 vSph;
varying vec2 vDir;
varying float vAlpha;
varying float vH;
varying float vSize;
varying float vTone;
varying vec3 vSunV;
void main() {
  vec4 t = texture2D(uTex, vUv);
  float a = t.r * vAlpha * smoothstep(-0.1 * vSize, 0.4 * vSize, vH);
  if (a < 0.004) discard;
  // Puff-space normal: the round body of the puff plus the lumps from the atlas gradient, turned into view space.
  vec2 g = (t.gb - 0.5) * 2.2;
  vec2 q = vSph * 0.75 - g;
  vec2 nrm = vec2(-vDir.y, vDir.x);
  vec3 n = normalize(vec3(vDir * q.x + nrm * q.y, 0.6));
  float l = dot(n, vSunV);
  vec3 col = mix(uShade, uLit, smoothstep(-0.45, 0.7, l));
  col *= 0.9 + 0.2 * vTone;
  gl_FragColor = vec4(col, min(a, 0.9));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface Puff {
  /** Ground point and normal at spawn; the puff floats above this plane. */
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  vel: THREE.Vector3;
  size0: number;
  size1: number;
  life: number;
  opacity: number;
  rise: number;
  drag: number;
}

export class DustSystem {
  readonly mesh: THREE.Mesh;
  private readonly ring: InstanceRing;
  private readonly a: Record<string, THREE.InstancedBufferAttribute>;
  private readonly mat: THREE.ShaderMaterial;
  private readonly tex: THREE.DataTexture;
  private time = 0;

  /**
   * `tint` replaces the sand colours (lit side, shade side), for smoke; `near` is the distance range over which puffs
   * fade in from the camera (the pack's dust fades early so it never hides the course).
   */
  constructor(count: number, theme: Theme, sunDir: THREE.Vector3, tint?: { lit: THREE.Vector3; shade: THREE.Vector3 }, near: [number, number] = [4, 22]) {
    const { geo, attr } = quadGeometry(count, { aPos: 3, aNrm: 3, aVel: 3, aT: 4, aM: 4 });
    const t = attr.aT.array as Float32Array;
    for (let i = 0; i < count; i++) {
      t[i * 4] = -1e6;
      t[i * 4 + 1] = 1;
    }
    for (let i = 0; i < count; i++) (attr.aM.array as Float32Array)[i * 4 + 3] = 1;
    this.a = attr;
    this.ring = new InstanceRing(count, attr);
    this.tex = puffAtlas();
    // Sunlit sand is paler than the road and takes the sun's colour; the shade side picks up the violet sky bounce.
    const sand = linear(theme.sand);
    const dirt = linear(theme.dirt);
    const sun = linear(theme.sunColor);
    const sky = linear(theme.skyTop);
    const lit = saturate(sand.clone().lerp(dirt, 0.15).multiply(sun), 1.08).multiplyScalar(1.3);
    const shade = saturate(dirt.clone().multiplyScalar(0.78).lerp(sky.multiplyScalar(0.6), 0.08), 1.1).add(new THREE.Vector3(0.02, 0.0, 0.025));
    this.mat = fxMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uCamVel: { value: new THREE.Vector3() },
        uShutter: { value: 0.03 },
        uSun: { value: sunDir.clone() },
        uNear: { value: new THREE.Vector2(...near) },
        uTex: { value: null },
        uLit: { value: tint?.lit ?? lit },
        uShade: { value: tint?.shade ?? shade },
      },
    });
    this.mat.uniforms.uTex.value = this.tex;
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  emit(p: Puff) {
    const i = this.ring.next();
    const { aPos, aNrm, aVel, aT, aM } = this.a;
    aPos.setXYZ(i, p.pos.x, p.pos.y, p.pos.z);
    aNrm.setXYZ(i, p.normal.x, p.normal.y, p.normal.z);
    aVel.setXYZ(i, p.vel.x, p.vel.y, p.vel.z);
    aT.setXYZW(i, this.time, p.life, p.size0, p.size1);
    aM.setXYZW(i, Math.random(), p.rise, p.opacity, p.drag);
  }

  /** Call before emitting this frame's puffs (spawn times use it). */
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

/** Pushes a linear colour away from its luminance (ACES tone mapping washes warm dust out otherwise). */
function saturate(c: THREE.Vector3, k: number): THREE.Vector3 {
  const l = c.x * 0.2126 + c.y * 0.7152 + c.z * 0.0722;
  return c.set(Math.max(0, l + (c.x - l) * k), Math.max(0, l + (c.y - l) * k), Math.max(0, l + (c.z - l) * k));
}
