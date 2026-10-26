// Standing dust of the canyon, after the concept art: glowing plumes billowing off the foot of the canyon walls all
// along the course, low haze sheets lying over the ground further ahead, and warm motes drifting round the camera.
// Plumes and sheets are camera-facing puffs from the shared puff atlas, baked once per ~240 m chunk of course (one
// instanced draw per chunk, only the chunks round the player are drawn); the vertex shader loops each puff through a
// slow rise-and-swell cycle so the dust rolls, and swells it when the player's pod tears past that wall. The fragment
// shader lights the lumps from the sun: orange-gold on the sunny side, pink-violet in shade, glowing when backlit.
// Puffs fade out near the camera and never reach the middle of the course. Motes are one more additive draw.

import * as THREE from 'three';
import { ADDITIVE_FOG, fxMaterial, linear, puffAtlas, quadGeometry } from '../fx/particles';
import { rng } from '../core/track';
import type { Quality, WorldBuilder } from './types';
import { zonesFor } from './zones';

const UP = new THREE.Vector3(0, 1, 0);
const CHUNK = 240;

const PUFF_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aP; // base position (wall foot / ground), size
attribute vec4 aD; // seed, kind (0 plume, 1 sheet), sun on that wall 0..1, opacity
attribute vec4 aQ; // horizontal unit towards the road, track s
uniform float uTime;
uniform float uPlayerS;
uniform float uWake[2];
uniform vec4 uNear; // plume fade-in distances, sheet fade-in distances
uniform vec3 uSun;
varying vec2 vUv;
varying vec2 vC;
varying float vAlpha;
varying float vLit;
varying float vKind;
varying vec3 vView;
varying vec3 vSunV;
void main() {
  float seed = aD.x;
  float kind = aD.y;
  vKind = kind;
  vLit = aD.z;
  float size0 = aP.w;
  vec3 base = aP.xyz;
  vec3 inward = aQ.xyz;
  float period = mix(10.0, 17.0, fract(seed * 5.31));
  float u = fract(uTime / period + seed * 7.13);
  float size;
  vec3 p;
  float alpha;
  vec2 stretch;
  if (kind < 0.5) {
    // Plume: swells and rises off the wall foot, rolls a little towards the road, fades in and out over its cycle.
    // A pod passing at speed on this side whips it up for a few seconds behind it.
    float behind = uPlayerS - aQ.w;
    float wakeAmt = (seed > 0.5 ? uWake[1] : uWake[0]);
    float wake = wakeAmt * smoothstep(-15.0, 2.0, behind) * (1.0 - smoothstep(20.0, 110.0, behind));
    size = size0 * (0.55 + 0.75 * u) * (1.0 + 0.55 * wake);
    p = base + vec3(0.0, size * 0.45 + u * size0 * 0.6, 0.0) + inward * (u * size0 * 0.3 + wake * size0 * 0.35);
    p.x += sin(uTime * 0.21 + seed * 40.0) * size0 * 0.12;
    p.z += cos(uTime * 0.17 + seed * 31.0) * size0 * 0.12;
    alpha = aD.w * smoothstep(0.0, 0.22, u) * (1.0 - smoothstep(0.55, 1.0, u)) * (1.0 + 0.9 * wake);
    stretch = vec2(1.25, 1.0);
  } else {
    // Ground sheet: a wide, low, slowly sliding band of haze.
    size = size0;
    p = base + inward * sin(uTime * 0.05 + seed * 20.0) * size0 * 0.6 + vec3(0.0, size0 * 0.12, 0.0);
    alpha = aD.w * (0.6 + 0.4 * sin(uTime * 0.13 + seed * 17.0));
    stretch = vec2(2.6, 0.32);
  }
  // Upright billboard: right is horizontal so the puff stays seated on the ground.
  vec3 toCam = cameraPosition - p;
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec2 c = position.xy;
  vec3 wp = p + right * c.x * size * stretch.x + vec3(0.0, 1.0, 0.0) * c.y * size * stretch.y;
  vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);
  float dist = -mvPosition.z;
  vec2 nf = kind < 0.5 ? uNear.xy : uNear.zw;
  alpha *= smoothstep(nf.x, nf.y, dist);
  // Whole puff invisible (between cycles, or right at the lens): skip it. Per instance, not per corner, so a
  // half-faded quad keeps its shape.
  if (alpha < 0.002) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  // Seat it: the part below the ground fades instead of cutting a hard line.
  alpha *= kind < 0.5 ? smoothstep(-0.15, 0.35, c.y + 0.6) : smoothstep(-1.0, -0.2, c.y);
  vAlpha = alpha;
  float flip = fract(seed * 3.7) > 0.5 ? -1.0 : 1.0;
  float cell = floor(fract(seed * 11.13) * 4.0);
  vUv = (vec2(c.x * flip, c.y) * 0.5 + 0.5 + vec2(mod(cell, 2.0), floor(cell / 2.0))) * 0.5;
  vC = vec2(c.x * flip, c.y);
  vView = mvPosition.xyz;
  vSunV = normalize(mat3(viewMatrix) * uSun);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const PUFF_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uTex;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uGlow;
varying vec2 vUv;
varying vec2 vC;
varying float vAlpha;
varying float vLit;
varying float vKind;
varying vec3 vView;
varying vec3 vSunV;
void main() {
  vec4 t = texture2D(uTex, vUv);
  float d = t.r;
  float a = smoothstep(0.0, 0.85, d) * vAlpha;
  if (a < 0.004) discard;
  // Lumpy puff normal from the atlas gradient plus the round body, lit by the sun in view space.
  vec2 g = (t.gb - 0.5) * 2.2;
  vec2 q = vC * 0.7 - g;
  vec3 n = normalize(vec3(q, 0.55));
  float l = dot(n, vSunV);
  float lit = smoothstep(-0.7, 0.9, l) * mix(0.5, 1.0, vLit);
  vec3 col = mix(uShade, uLit, lit);
  // Billow tops catch the light, the feet sink into the shade.
  col *= mix(0.75, 1.15, smoothstep(-0.8, 0.9, vC.y));
  // Backlit dust glows: forward scattering towards the sun, strongest in the thin edges.
  float fwd = pow(max(dot(normalize(vView), vSunV), 0.0), 3.0);
  col += uGlow * fwd * (1.2 - d) * 0.9;
  // Sheets are flatter and paler, they read as air, not as clouds.
  col = mix(col, mix(uShade, uLit, 0.65), vKind * 0.6);
  gl_FragColor = vec4(col, min(a, 0.85));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const MOTE_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute vec4 aM; // box position 0..1 (xyz), seed
uniform float uTime;
uniform vec3 uBox;
uniform vec3 uCenter;
uniform vec3 uSun;
varying vec2 vC;
varying float vB;
void main() {
  float seed = aM.w;
  vec3 drift = vec3(sin(seed * 31.0) * 0.6 + 0.9, 0.25 + fract(seed * 7.0) * 0.35, cos(seed * 17.0) * 0.6);
  vec3 q = aM.xyz * uBox + drift * uTime + vec3(sin(uTime * 0.7 + seed * 50.0), sin(uTime * 0.5 + seed * 20.0), cos(uTime * 0.6 + seed * 9.0)) * 0.6;
  // Wrap the field round the camera so it is always there, with no popping at the box edges (fade instead).
  vec3 rel = mod(q - uCenter + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 edge = abs(rel) / (uBox * 0.5);
  float fade = 1.0 - smoothstep(0.7, 1.0, max(edge.x, max(edge.y, edge.z)));
  vec3 p = uCenter + rel;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  vec4 mv = mvPosition;
  float dist = -mv.z;
  float size = (0.05 + 0.09 * fract(seed * 13.0)) + dist * 0.0018;
  mv.xy += position.xy * size;
  vC = position.xy;
  vec3 v = normalize(mv.xyz);
  float back = pow(max(dot(v, normalize(mat3(viewMatrix) * uSun)), 0.0), 2.0);
  float tw = 0.55 + 0.45 * sin(uTime * (1.5 + fract(seed * 3.0) * 3.0) + seed * 60.0);
  vB = fade * tw * (0.45 + 1.6 * back) * smoothstep(1.5, 5.0, dist);
  gl_Position = projectionMatrix * mv;
  #include <fog_vertex>
}
`;

const MOTE_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform vec3 uCol;
varying vec2 vC;
varying float vB;
void main() {
  float r = dot(vC, vC);
  float a = exp(-r * 4.0) * vB;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uCol * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  ${ADDITIVE_FOG}
}
`;

function settings(q: Quality) {
  // Plume spacing along each wall (m), puffs per plume site, tall billows, sheet spacing (0 = none), mote count.
  if (q === 'high') return { every: 8, per: 2, tall: true, sheets: 22, motes: 700 };
  if (q === 'medium') return { every: 11, per: 2, tall: false, sheets: 34, motes: 400 };
  return { every: 18, per: 1, tall: false, sheets: 0, motes: 150 };
}

interface Chunk {
  mesh: THREE.Mesh;
  s0: number;
  s1: number;
}

export const buildDustHaze: WorldBuilder = (ctx) => {
  const { track, theme, quality } = ctx;
  const zones = zonesFor(track);
  const r = rng(track.def.seed * 31 + 5);
  const S = settings(quality);
  const group = new THREE.Group();
  group.name = 'dustHaze';

  const sunDir = new THREE.Vector3(Math.sin(theme.sunAzimuth), Math.tan(theme.sunElevation), Math.cos(theme.sunAzimuth)).normalize();
  const sunFlat = sunDir.clone().setY(0).normalize();
  // Warm painted dust: the sun's colour pushed to orange-gold on the lit side, the sky's violet in the shade.
  const sun = linear(theme.sunColor);
  const lit = linear('#ff9446').lerp(linear(theme.sand).multiply(sun), 0.15).multiplyScalar(1.45);
  const shade = linear('#ec8070').lerp(linear(theme.skyTop), 0.15).multiplyScalar(1.05);
  const glow = linear('#ffc070').multiply(sun).multiplyScalar(1.6);

  const tex = puffAtlas();
  const mat = fxMaterial({
    vertexShader: PUFF_VERT,
    fragmentShader: PUFF_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPlayerS: { value: 0 },
      uWake: { value: [0, 0] },
      uNear: { value: new THREE.Vector4(6, 22, 45, 110) },
      uSun: { value: sunDir },
      uTex: { value: tex },
      uLit: { value: lit },
      uShade: { value: shade },
      uGlow: { value: glow },
    },
  });
  // fxMaterial merges uniforms by copy: point the texture back at our instance.
  mat.uniforms.uTex.value = tex;

  // ------------------------------------------------------------------ puffs, baked per chunk
  type P = number[];
  const chunks: Chunk[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const tmp = new THREE.Vector3();
  for (let c0 = 0; c0 < track.length; c0 += CHUNK) {
    const c1 = Math.min(track.length, c0 + CHUNK);
    const items: { p: P; d: P; q: P }[] = [];
    // Plumes at both wall feet. The seed's top half marks the right side (so the wake knows which wall it is on).
    for (const side of [-1, 1] as const) {
      for (let s = c0 + r() * S.every; s < c1; s += S.every * (0.7 + r() * 0.6)) {
        const wall = zones.wallOffset(s, side);
        if (!Number.isFinite(wall)) continue;
        const f = track.frameAt(s);
        const half = f.width / 2;
        const right = f.tangent.clone().setY(0).normalize().cross(UP).normalize();
        const out = right.clone().multiplyScalar(side);
        // How square the wall faces the sun: walls facing it glow, the others sit in their own shade.
        const sunny = THREE.MathUtils.clamp(0.5 - out.dot(sunFlat) * 0.8, 0, 1);
        const room = wall - half;
        const y = track.toWorld(s, side * half, 0, tmp).y;
        for (let k = 0; k < S.per + (S.tall && r() < 0.7 ? 1 : 0); k++) {
          // Keep the plume's inner edge outside the racing line: size limited by the room between road edge and wall.
          // Out in front of the rubble at the wall foot, but its inner edge stays near the road edge.
          // The extra puff on high is a tall, faint billow riding higher up the wall.
          const tall = k >= S.per;
          const size = THREE.MathUtils.clamp(4 + r() * 6 + room * 0.2, 4, Math.max(4, room * 0.55 + 2)) * (tall ? 1.8 : k ? 0.75 : 1);
          const off = THREE.MathUtils.clamp(wall - size * 0.7 - r() * 2, half + size * 0.9, wall);
          const base = f.pos.clone().addScaledVector(out, off).addScaledVector(f.tangent.clone().setY(0).normalize(), (r() - 0.5) * S.every * 0.6);
          base.y = y + 0.3 + (tall ? size * 0.5 : 0);
          const seed = (side > 0 ? 0.5 : 0) + r() * 0.4999;
          items.push({ p: [base.x, base.y, base.z, size], d: [seed, 0, sunny, (0.55 + r() * 0.25) * (tall ? 0.4 : 1)], q: [-out.x, 0, -out.z, s] });
        }
      }
    }
    // Low haze sheets across the floor, wide and faint; only seen beyond the near fade.
    if (S.sheets) {
      for (let s = c0 + r() * S.sheets; s < c1; s += S.sheets * (0.7 + r() * 0.6)) {
        const f = track.frameAt(s);
        const half = f.width / 2;
        const lat = (r() * 2 - 1) * (half + 6);
        const base = track.toWorld(s, lat, 0, new THREE.Vector3());
        const right = f.tangent.clone().setY(0).normalize().cross(UP).normalize();
        items.push({ p: [base.x, base.y, base.z, 6 + r() * 5], d: [r(), 1, 0.7, 0.22 + r() * 0.12], q: [right.x, 0, right.z, s] });
      }
    }
    if (!items.length) continue;
    const { geo, attr } = quadGeometry(items.length, { aP: 4, aD: 4, aQ: 4 });
    items.forEach((it, i) => {
      attr.aP.setXYZW(i, it.p[0], it.p[1], it.p[2], it.p[3]);
      attr.aD.setXYZW(i, it.d[0], it.d[1], it.d[2], it.d[3]);
      attr.aQ.setXYZW(i, it.q[0], it.q[1], it.q[2], it.q[3]);
    });
    for (const a of Object.values(attr)) a.setUsage(THREE.StaticDrawUsage);
    // Bounds for frustum culling: the chunk's puffs plus their size.
    const box = new THREE.Box3();
    for (const it of items) box.expandByPoint(tmp.set(it.p[0], it.p[1], it.p[2]));
    geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    geo.boundingSphere.radius += 30;
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    mesh.visible = false;
    group.add(mesh);
    chunks.push({ mesh, s0: c0, s1: c1 });
  }

  // ------------------------------------------------------------------ motes
  const motes = (() => {
    const { geo, attr } = quadGeometry(S.motes, { aM: 4 });
    for (let i = 0; i < S.motes; i++) attr.aM.setXYZW(i, Math.random(), Math.random(), Math.random(), Math.random());
    const m = fxMaterial({
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      additive: true,
      uniforms: {
        uTime: { value: 0 },
        uBox: { value: new THREE.Vector3(90, 22, 90) },
        uCenter: { value: new THREE.Vector3() },
        uSun: { value: sunDir },
        uCol: { value: linear('#ffb45a').multiply(sun).multiplyScalar(1.8) },
      },
    });
    const mesh = new THREE.Mesh(geo, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    return { geo, mat: m, mesh };
  })();
  group.add(motes.mesh);

  const wake = [0, 0];
  const pf = new THREE.Vector3();
  return {
    object: group,
    update(view) {
      const u = mat.uniforms;
      u.uTime.value = view.time;
      u.uPlayerS.value = view.playerS;
      // Wake per side: fast and near that wall, eased so it swells and settles instead of switching.
      const f = track.frameAt(view.playerS);
      const lat = pf.copy(view.playerPos).sub(f.pos).dot(f.right);
      const half = f.width / 2;
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        const near = THREE.MathUtils.clamp((lat * side) / Math.max(1, half), 0, 1);
        const target = THREE.MathUtils.clamp((view.speed01 - 0.35) * 1.6, 0, 1.3) * (0.35 + 0.65 * near);
        wake[i] += (target - wake[i]) * Math.min(1, view.dt * 1.5);
      }
      u.uWake.value = wake;
      for (const c of chunks) c.mesh.visible = c.s1 > view.playerS - 140 && c.s0 < view.playerS + 900;
      const m = motes.mat.uniforms;
      m.uTime.value = view.time;
      // Field centred a little ahead of the camera, sitting low over the ground.
      m.uCenter.value.copy(view.camera.position).addScaledVector(view.playerForward, 30);
      m.uCenter.value.y = view.playerPos.y + 6;
    },
    dispose() {
      for (const g of geos) g.dispose();
      mat.dispose();
      tex.dispose();
      motes.geo.dispose();
      motes.mat.dispose();
    },
  };
};
