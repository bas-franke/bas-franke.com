// The air rushing past the camera: speed lines (streaks converging on the vanishing point, kept to the edges of the
// frame and strongest when boosting) and sand grains / dust motes whipping past with real parallax. Both are fully
// shader-driven instanced quads with static per-instance seeds; the CPU only sets a few uniforms per frame.

import * as THREE from 'three';
import { ADDITIVE_FOG, fxMaterial, quadGeometry } from './particles';

const LINES_VERT = /* glsl */ `
attribute vec4 aSeed; // angle, radius, phase, speed
uniform float uTime;
uniform float uFlow;
uniform float uLen;
uniform float uAspect;
uniform float uTanHalf;
varying float vV;
varying float vT;
varying float vA;
void main() {
  float z = fract(aSeed.z + uFlow * (0.7 + 0.6 * aSeed.w));
  float depth = mix(70.0, 3.0, z);
  float ang = aSeed.x * 6.2831853;
  vec2 dir = vec2(cos(ang), sin(ang));
  // Radius in screen units (1 = frame edge on that axis), so lines live in a ring at the edges of the image.
  float r = mix(0.78, 1.3, aSeed.y);
  vec2 xy = dir * r * vec2(uAspect, 1.0) * uTanHalf;
  float len = uLen * (0.6 + 0.8 * aSeed.w);
  float d = position.x > 0.0 ? depth + len : depth;
  vec3 p = vec3(xy * d, -d);
  vec2 side = vec2(-dir.y, dir.x);
  p.xy += side * position.y * 0.0009 * d * (0.6 + aSeed.y);
  vV = position.y;
  vT = position.x;
  vA = smoothstep(0.0, 0.25, z) * (1.0 - smoothstep(0.8, 1.0, z));
  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;

const LINES_FRAG = /* glsl */ `
uniform float uIntensity;
uniform vec3 uColor;
varying float vV;
varying float vT;
varying float vA;
void main() {
  // Brightest a third of the way from the near end, fading out at both ends: a streak, not a laser.
  float t = vT * 0.5 + 0.5;
  float a = vA * (1.0 - vV * vV) * smoothstep(0.0, 0.3, t) * (1.0 - t) * 1.6 * uIntensity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

const MOTES_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uCamVel;
uniform vec3 uWind;
uniform vec3 uBox;
uniform float uShutter;
varying float vV;
varying float vA;
varying float vTone;
void main() {
  // World-fixed grains in a box that wraps around the camera: true parallax, no respawning.
  vec3 local = mod(aSeed.xyz * uBox + uWind * uTime * (0.6 + aSeed.w) - uCam, uBox) - uBox * 0.5;
  local.y -= uBox.y * 0.3;
  vec3 p = uCam + local;
  vec3 edge = abs(local) / (uBox * 0.5);
  float fade = 1.0 - smoothstep(0.65, 1.0, max(edge.x, max(edge.y, edge.z)));
  vec3 rel = uWind * (0.6 + aSeed.w) - uCamVel;
  vec3 streak = -rel * uShutter;
  float sl = length(streak);
  if (sl > 1.8) streak *= 1.8 / sl;
  vec3 a = p + (position.x > 0.0 ? streak : vec3(0.0));
  vec3 view = normalize(cameraPosition - a);
  vec3 sdir = sl > 1e-3 ? normalize(streak) : vec3(1.0, 0.0, 0.0);
  vec3 side = normalize(cross(sdir, view) + vec3(1e-4));
  float dist = length(cameraPosition - a);
  float w = max(0.01 + 0.025 * aSeed.w, dist * 0.0009);
  a += side * position.y * w;
  vV = position.y;
  vA = fade * smoothstep(0.6, 3.0, dist) * (position.x > 0.0 ? 0.15 : 1.0);
  vTone = aSeed.w;
  vec4 mvPosition = viewMatrix * vec4(a, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const MOTES_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uIntensity;
uniform vec3 uColor;
varying float vV;
varying float vA;
varying float vTone;
void main() {
  float a = vA * (1.0 - vV * vV) * uIntensity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor * (0.7 + 0.5 * vTone), a);
  ${ADDITIVE_FOG}
}
`;

export class AirSystem {
  readonly lines: THREE.Mesh;
  readonly motes: THREE.Mesh;
  private readonly lineMat: THREE.ShaderMaterial;
  private readonly moteMat: THREE.ShaderMaterial;
  private flow = 0;

  constructor(lineCount: number, moteCount: number, sand: THREE.Color, sun: THREE.Color) {
    const l = quadGeometry(lineCount, { aSeed: 4 });
    fillRandom(l.attr.aSeed.array as Float32Array);
    this.lineMat = new THREE.ShaderMaterial({
      vertexShader: LINES_VERT,
      fragmentShader: LINES_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uFlow: { value: 0 },
        uLen: { value: 10 },
        uAspect: { value: 1.6 },
        uTanHalf: { value: 0.7 },
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Color(1, 0.93, 0.82).multiplyScalar(1.1) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.lines = new THREE.Mesh(l.geo, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;

    const m = quadGeometry(moteCount, { aSeed: 4 });
    fillRandom(m.attr.aSeed.array as Float32Array);
    this.moteMat = fxMaterial({
      vertexShader: MOTES_VERT,
      fragmentShader: MOTES_FRAG,
      additive: true,
      side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: new THREE.Vector3() },
        uCamVel: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector3(1.5, 0.4, 0.8) },
        uBox: { value: new THREE.Vector3(34, 9, 34) },
        uShutter: { value: 0.03 },
        uIntensity: { value: 0 },
        uColor: { value: sand.clone().lerp(new THREE.Color(1, 1, 1), 0.35).multiply(sun).multiplyScalar(0.9) },
      },
    });
    this.motes = new THREE.Mesh(m.geo, this.moteMat);
    this.motes.frustumCulled = false;
    this.motes.renderOrder = 4;
  }

  update(dt: number, time: number, camera: THREE.PerspectiveCamera, camVel: THREE.Vector3, speed01: number, boost: number) {
    const s = THREE.MathUtils.clamp(speed01, 0, 1.5);
    const lu = this.lineMat.uniforms;
    // Lines flow towards the camera faster the faster we go.
    this.flow += dt * (0.4 + 1.6 * s + 1.2 * boost);
    lu.uFlow.value = this.flow;
    lu.uTime.value = time;
    lu.uLen.value = 6 + 22 * s + 20 * boost;
    lu.uAspect.value = camera.aspect;
    lu.uTanHalf.value = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    lu.uIntensity.value = THREE.MathUtils.smoothstep(s, 0.6, 1.1) * 0.03 + boost * 0.06;

    const mu = this.moteMat.uniforms;
    mu.uTime.value = time;
    mu.uCam.value.copy(camera.position);
    mu.uCamVel.value.copy(camVel);
    mu.uIntensity.value = 0.05 + 0.12 * Math.min(1, s) + 0.1 * boost;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.lineMat.dispose();
    this.motes.geometry.dispose();
    this.moteMat.dispose();
  }
}

function fillRandom(a: Float32Array) {
  for (let i = 0; i < a.length; i++) a[i] = Math.random();
}
