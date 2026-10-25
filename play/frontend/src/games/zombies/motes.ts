// Dust motes drifting through the lobby air, catching the street-light shafts. One THREE.Points cloud filling the
// atrium (denser near the floor and the glass), animated entirely in the vertex shader from `time`: a slow coherent
// wander (layered sines of position, so neighbours drift together like air currents) plus a slow settle that fades
// each mote out and back in at the top of its fall. Every mote is lit per vertex by up to 4 street lights (cone,
// distance falloff, Henyey-Greenstein forward scattering so the shafts sparkle when you look toward a lamp) and is
// almost invisible outside the cones. post.ts's shaft shadow maps can't be read here, so the brass mullions and the
// wall above the facade are approximated analytically: the ray from the mote to the lamp is cut at the glass plane.
//
// Rendered into the HDR scene (layer 0) with additive blending and no depth writes (SSR and the fog read depth);
// `userData.noMoonShadow` + isPoints keep it out of post.ts's depth passes.

import * as THREE from 'three';
import type { Quality } from './api';
import type { StreetLight } from './world';

export interface MotesOpts {
  /** Interior box of the atrium (where the motes live) and its ceiling height. */
  interior: { minX: number; maxX: number; minZ: number; maxZ: number };
  ceiling: number;
  /** The street lights shining in; read every frame (flicker). */
  streetLights: StreetLight[];
  quality: Quality;
}

export interface Motes {
  group: THREE.Group;
  update(dt: number, time: number, camera?: THREE.Camera): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

const COUNT: Record<Quality, number> = { low: 1200, medium: 2800, high: 6000 };
const MAX_LIGHTS = 4;
/** Brass mullion spacing in the facade (x = ±3, ±6, ±9) and their half width plus a soft edge. */
const MULLION_STEP = 3;

const vert = /* glsl */ `
  #define NL ${MAX_LIGHTS}
  attribute vec4 aSeed; // xyz: rest position, w: random 0..1
  uniform float uTime;
  uniform float uPx;      // projection scale in pixels per metre at 1 m
  uniform float uFacadeZ;
  uniform float uCeil;
  uniform vec2 uXRange;
  uniform vec3 uLPos[NL];
  uniform vec3 uLDir[NL];
  uniform vec3 uLCol[NL];  // colour * level * gain
  uniform vec4 uLCone[NL]; // cosOuter, cosInner, range, 0
  varying vec3 vCol;
  varying float vAlpha;

  // Mote -> lamp line through the glass: 0 where the facade (mullions, wall above, side walls) blocks it.
  float facadeOpen(vec3 p, vec3 l) {
    float t = (uFacadeZ - p.z) / (l.z - p.z);
    vec3 c = p + (l - p) * t;
    float open = step(c.y, uCeil - 0.05) * step(uXRange.x, c.x) * step(c.x, uXRange.y);
    float k = clamp(floor(c.x / ${MULLION_STEP}.0 + 0.5), -3.0, 3.0);
    float m = abs(c.x - k * ${MULLION_STEP}.0);
    return open * mix(1.0, smoothstep(0.1, 0.17, m), step(0.5, abs(k)));
  }

  void main() {
    float r = aSeed.w;
    float t = uTime;
    // Settle: each mote sinks ~1.2 m over a ~70-110 s life, fading at both ends so the wrap never pops.
    float life = fract(t / (70.0 + 40.0 * r) + r * 7.31);
    vec3 p = aSeed.xyz;
    p.y -= life * (0.8 + 0.8 * r);
    // Wander: coherent layered sines of position (air currents), plus a small per-mote jitter.
    vec3 q = p * 0.45;
    vec3 w = vec3(
      sin(0.13 * t + q.z * 1.7 + q.y * 1.1) + 0.5 * sin(0.29 * t + q.y * 2.9 + r * 6.0),
      0.45 * sin(0.11 * t + q.x * 1.9 + q.z * 0.7) + 0.25 * sin(0.37 * t + r * 17.0),
      sin(0.17 * t + q.x * 1.3 + q.y * 1.6) + 0.5 * cos(0.23 * t + q.x * 2.3 + r * 9.0)
    );
    p += w * 0.32;
    p.y = max(p.y, 0.03);
    float fade = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.88, 1.0, life));
    // Never on the far side of the glass.
    fade *= smoothstep(uFacadeZ + 0.05, uFacadeZ + 0.35, p.z);

    vec3 v = normalize(p - cameraPosition);
    vec3 col = vec3(0.004, 0.005, 0.007); // faint cold glimmer outside the shafts
    for (int i = 0; i < NL; i++) {
      vec3 L = p - uLPos[i];
      float d = length(L);
      vec3 ld = L / d;
      vec4 cone = uLCone[i];
      float c = smoothstep(cone.x, cone.y, dot(ld, uLDir[i]));
      float x = clamp(d / cone.z, 0.0, 1.0);
      float att = (1.0 - x * x) * (1.0 - x * x) / (d * d + 1.0);
      // Henyey-Greenstein (g = 0.7) towards the eye, mixed with a little isotropic scatter.
      float ct = dot(ld, -v);
      float g = 0.7;
      float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * ct, 1.5);
      float ph = 0.25 + 0.75 * hg;
      float vis = c * att;
      if (vis > 0.0) vis *= facadeOpen(p, uLPos[i]);
      col += uLCol[i] * vis * ph;
    }
    // Tiny twinkle: a mote's flat face catching the light now and then.
    float tw = sin(t * (1.3 + 2.1 * r) + r * 40.0);
    col *= 0.75 + 0.9 * pow(max(tw, 0.0), 12.0);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = -mv.z;
    // No sprites in your face, gone into the haze far away.
    fade *= smoothstep(0.35, 1.2, dist) * (1.0 - smoothstep(16.0, 30.0, dist));
    float px = (0.010 + 0.012 * fract(r * 13.7)) * uPx / max(dist, 0.1);
    // Sub-pixel motes keep their energy as a dimmer 1.6 px dot instead of shimmering.
    float sz = max(px, 1.6);
    fade *= min(1.0, (px * px) / (sz * sz));
    gl_PointSize = min(sz, 18.0);
    gl_Position = projectionMatrix * mv;
    vCol = col;
    vAlpha = fade;
    if (fade < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // cull
  }
`;

const frag = /* glsl */ `
  varying vec3 vCol;
  varying float vAlpha;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float a = exp(-r2 * 3.5) * (1.0 - r2);
    gl_FragColor = vec4(vCol * (a * vAlpha), 1.0);
  }
`;

export function buildMotes(o: MotesOpts): Motes {
  const group = new THREE.Group();
  group.name = 'motes';
  const { interior: b, ceiling } = o;
  const lights = o.streetLights.slice(0, MAX_LIGHTS);

  // Rest positions, built once at the max count; quality only changes the draw range. Sampling favours the floor,
  // the glass and the lamp cones (rejection-weighted), so the visible motes aren't wasted on the dark back of the hall.
  const max = COUNT.high;
  const seeds = new Float32Array(max * 4);
  let rs = 0x9e3779b9;
  const rnd = () => {
    rs ^= rs << 13;
    rs ^= rs >>> 17;
    rs ^= rs << 5;
    return (rs >>> 0) / 4294967296;
  };
  const p = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const coneAt = (v: THREE.Vector3) => {
    let s = 0;
    for (const l of lights) {
      tmp.copy(v).sub(l.pos).normalize();
      const c = tmp.dot(l.dir);
      s = Math.max(s, THREE.MathUtils.smoothstep(c, l.cosOuter, l.cosInner));
    }
    return s;
  };
  for (let i = 0; i < max; ) {
    p.set(
      THREE.MathUtils.lerp(b.minX + 0.3, b.maxX - 0.3, rnd()),
      // +1.2 m headroom: motes sink while they live.
      0.1 + Math.pow(rnd(), 1.7) * (ceiling - 0.3) + 1.2 * rnd(),
      b.minZ + 0.3 + Math.pow(rnd(), 1.8) * (b.maxZ - b.minZ - 0.6),
    );
    if (rnd() > 0.3 + 0.7 * coneAt(p)) continue;
    seeds.set([p.x, p.y, p.z, rnd()], i * 4);
    i++;
  }
  // Shuffle-free: sampling is already uniform in order, so any prefix (draw range) is a fair subset.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3((b.minX + b.maxX) / 2, ceiling / 2, (b.minZ + b.maxZ) / 2),
    Math.hypot(b.maxX - b.minX, ceiling, b.maxZ - b.minZ) / 2 + 2,
  );

  const uniforms = {
    uTime: { value: 0 },
    uPx: { value: 600 },
    uFacadeZ: { value: b.minZ },
    uCeil: { value: ceiling },
    uXRange: { value: new THREE.Vector2(b.minX, b.maxX) },
    uLPos: { value: Array.from({ length: MAX_LIGHTS }, (_, i) => lights[i]?.pos.clone() ?? new THREE.Vector3(0, -100, 0)) },
    uLDir: { value: Array.from({ length: MAX_LIGHTS }, (_, i) => lights[i]?.dir.clone() ?? new THREE.Vector3(0, -1, 0)) },
    uLCol: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    uLCone: { value: Array.from({ length: MAX_LIGHTS }, (_, i) => (lights[i] ? new THREE.Vector4(lights[i].cosOuter, lights[i].cosInner, lights[i].range, 0) : new THREE.Vector4(1, 1, 1, 0))) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
    toneMapped: false,
  });
  const points = new THREE.Points(geo, mat);
  points.name = 'dustMotes';
  points.castShadow = false;
  points.receiveShadow = false;
  points.userData.noMoonShadow = true;
  points.renderOrder = 10;
  group.add(points);

  // Pixel scale for size attenuation, from whichever target the scene is drawn into (post renders below 1x).
  const size = new THREE.Vector2();
  points.onBeforeRender = (renderer, _scene, camera) => {
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : renderer.getDrawingBufferSize(size).y;
    const proj = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
    uniforms.uPx.value = (proj * h) / 2;
  };

  // HDR gain: the motes' brightness per unit of lamp colour (tuned against the shaft fog in shots).
  const GAIN = 9;
  const setQuality = (q: Quality) => geo.setDrawRange(0, COUNT[q]);
  setQuality(o.quality);

  return {
    group,
    update(_dt, time) {
      uniforms.uTime.value = time;
      for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        const c = l.color;
        const k = l.level * GAIN;
        uniforms.uLCol.value[i].set(c.r * k, c.g * k, c.b * k);
        uniforms.uLPos.value[i].copy(l.pos);
        uniforms.uLDir.value[i].copy(l.dir);
      }
    },
    setQuality,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
