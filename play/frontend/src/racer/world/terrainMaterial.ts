// The terrain shader: MeshStandardMaterial (so it gets the sun, shadows and fog like everything else) with its albedo
// and normal replaced by procedural world-space patterns. Rock gets the strata layers (pale hard caps, orange body,
// dark soft layers, matching the ledges in the cliff geometry), fine sub-layers, dark vertical streaks and flutes
// (triplanar on the vertical planes), and a painterly hue shift: faces turned to the sun are warm orange-peach,
// faces turned away go deep red-brown with a violet tint. Flat ground gets sand with drifts, ripples and pebbles;
// plateau tops mix sand, rock and scrub. Slopes turn to rock by their normal, so the heightfield needs no texture.

import * as THREE from 'three';
import type { Theme } from '../core/tracks';
import type { Quality } from './types';
import { STRATA_COUNT, STRATA_K0, type Strata } from './terrainNoise';

const PARS_VERTEX = /* glsl */ `
attribute float aRock;
attribute float aShade;
varying vec3 vTW;
varying float vRock;
varying float vShade;
`;

const MAIN_VERTEX = /* glsl */ `
{
  vec4 tw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  tw = instanceMatrix * tw;
  #endif
  vTW = (modelMatrix * tw).xyz;
  vRock = aRock;
  vShade = aShade;
}
`;

const PARS_FRAGMENT = /* glsl */ `
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uStrata;
uniform vec3 uSand;
uniform vec3 uDirt;
uniform vec3 uScrub;
uniform vec3 uSunDir;
uniform float uHard[${STRATA_COUNT}];
varying vec3 vTW;
varying float vRock;
varying float vShade;

float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float tFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * tNoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s / 0.875;
}
float strataT(float y) { return y / 14.0 + 0.25 * sin(y * 0.11) + 0.12 * sin(y * 0.27); }
float strataWarp(vec2 p) { return 1.8 * sin(p.x * 0.021 + p.y * 0.013) + 1.1 * sin(p.y * 0.037 - p.x * 0.029) + 0.5 * sin(p.x * 0.071 + p.y * 0.053); }

// Rock albedo at p with world normal n; h receives a bump height (metres-ish).
vec3 rockAlbedo(vec3 p, vec3 n, out float h) {
  float t = strataT(p.y - strataWarp(p.xz));
  float k = floor(t);
  float f = t - k;
  float hard = uHard[int(clamp(k - (${STRATA_K0}.0), 0.0, ${STRATA_COUNT - 1}.0))];
  vec3 soft = mix(uLit, uShade, 0.5);
  vec3 pale = mix(uLit, uStrata, 0.6);
  vec3 c = hard < 0.3 ? soft : (hard > 0.75 ? pale : uLit * mix(0.92, 1.04, fract(hard * 7.31)));
  // Thin wavy sub-layers.
  float wav = tNoise(p.xz * 0.04) * 2.0;
  float fine = sin((p.y + wav) * 2.6) * 0.5 + 0.5;
  float fine2 = sin((p.y - wav) * 7.3) * 0.5 + 0.5;
  c *= 0.9 + 0.07 * fine + 0.03 * fine2;
  // Pale weathered rim at the top of each layer, dark seam at its base.
  c = mix(c, uStrata, smoothstep(0.88, 0.97, f) * 0.4);
  c *= mix(0.72, 1.0, smoothstep(0.0, 0.05, f));
  // Vertical streaks and flutes, triplanar over the two vertical planes.
  vec2 w = abs(n.xz) / (abs(n.x) + abs(n.z) + 1e-4);
  float sx = tNoise(vec2(p.z * 0.35, p.y * 0.02));
  float sz = tNoise(vec2(p.x * 0.35, p.y * 0.02));
  float streak = sx * w.x + sz * w.y;
  float fx = tNoise(vec2(p.z * 1.3, p.y * 0.08));
  float fz = tNoise(vec2(p.x * 1.3, p.y * 0.08));
  float flute = fx * w.x + fz * w.y;
  c *= 1.0 - smoothstep(0.55, 0.92, streak) * 0.32;
  c = mix(c, c * vec3(1.1, 1.0, 0.92), smoothstep(0.35, 0.05, streak) * 0.5);
  float blotch = tNoise(vec2((p.x + p.z) * 0.02, p.y * 0.012));
  c *= 0.9 + 0.2 * blotch;
  h = streak * 0.5 + flute * 0.25 + fine * 0.12 + smoothstep(0.0, 0.06, f) * 0.25;
  return c;
}

vec3 sandAlbedo(vec3 p, out float h) {
  float big = tFbm(p.xz * 0.012);
  vec3 c = mix(uSand, uDirt, 0.45 + smoothstep(0.35, 0.72, big) * 0.45) * 0.8;
  float rip = sin(dot(p.xz, vec2(0.9, 0.45)) * 1.4 + tNoise(p.xz * 0.07) * 7.0) * 0.5 + 0.5;
  c *= 0.95 + 0.05 * rip;
  float peb = tNoise(p.xz * 1.9);
  c *= 1.0 - smoothstep(0.78, 0.97, peb) * 0.2;
  c *= 0.94 + 0.12 * tNoise(p.xz * 0.15);
  h = rip * 0.04 + peb * 0.03;
  return c;
}
`;

const MAIN_FRAGMENT = /* glsl */ `
{
  vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  float hR;
  float hS;
  vec3 rockC = rockAlbedo(vTW, wN, hR);
  vec3 sandC = sandAlbedo(vTW, hS);
  // Rockiness: slopes are rock; cliff geometry (aRock = 1) is rock with sand settling on its ledges; plateau tops
  // (0 < aRock < 1) mix sand, broken rock and scrub.
  float slopeR = smoothstep(0.84, 0.6, wN.y);
  float r = vRock > 0.99 ? 1.0 - 0.7 * smoothstep(0.75, 0.97, wN.y) : slopeR;
  vec3 flatC = sandC;
  if (vRock > 0.01 && vRock < 0.99) {
    flatC = mix(sandC, mix(uLit, uSand, 0.45), vRock * (0.6 + 0.4 * tNoise(vTW.xz * 0.03)));
    flatC = mix(flatC, uScrub, smoothstep(0.62, 0.8, tNoise(vTW.xz * 0.09)) * 0.45);
  }
  vec3 albedo = mix(flatC, rockC, r);
  if (vRock > 1.5) {
    // Loose rocks: aRock 2 = the boulders along the course's edges, dark with desert varnish; 3 = the formations on the
    // course, warmer with pale weathered caps (vShade is ~1 at the top of a rock). Both stand out from the walls.
    float n = tNoise(vTW.xz * 0.07 + vTW.y * 0.05);
    if (vRock < 2.5) albedo *= mix(vec3(0.62, 0.55, 0.55), vec3(0.8, 0.7, 0.66), n);
    else albedo = mix(albedo * vec3(1.15, 0.92, 0.74), uStrata * 1.08, smoothstep(0.9, 0.985, vShade) * 0.85);
  }
  // Painterly light: faces turned from the sun shift to deep red-brown with a violet tint.
  float sunF = dot(wN, uSunDir);
  float lit = smoothstep(-0.25, 0.4, sunF);
  vec3 ratio = uShade / max(uLit, vec3(0.05));
  vec3 shaded = albedo * mix(vec3(1.0), sqrt(ratio) * vec3(1.0, 0.93, 1.2), 0.75 * r);
  albedo = mix(shaded, albedo, lit);
  diffuseColor.rgb = albedo * vShade;
  #ifndef TERRAIN_LOW
  // Bump from the procedural height (three's perturbNormalArb, in view space).
  float hb = mix(hS, hR, r) * 0.35;
  vec3 dpdx = dFdx(-vViewPosition);
  vec3 dpdy = dFdy(-vViewPosition);
  float dhx = dFdx(hb);
  float dhy = dFdy(hb);
  vec3 r1 = cross(dpdy, normal);
  vec3 r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  normal = normalize(abs(det) * normal - grad);
  #endif
}
`;

export function sunDirection(theme: Theme) {
  const el = theme.sunElevation;
  const az = theme.sunAzimuth;
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
}

export function createTerrainMaterial(theme: Theme, strata: Strata, quality: Quality): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
  const low = quality === 'low';
  if (low) m.defines = { TERRAIN_LOW: '' };
  const lin = (c: string) => new THREE.Color(c);
  const uniforms = {
    uLit: { value: lin(theme.rockLit) },
    uShade: { value: lin(theme.rockShade) },
    uStrata: { value: lin(theme.rockStrata) },
    uSand: { value: lin(theme.sand) },
    uDirt: { value: lin(theme.dirt) },
    uScrub: { value: lin(theme.scrub) },
    uSunDir: { value: sunDirection(theme) },
    uHard: { value: strata.hard },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS_VERTEX}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${MAIN_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS_FRAGMENT}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${MAIN_FRAGMENT}`);
  };
  m.customProgramCacheKey = () => `dustrunners-terrain-${low ? 'low' : 'full'}`;
  return m;
}
