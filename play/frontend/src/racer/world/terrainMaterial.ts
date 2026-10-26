// The terrain shader: MeshStandardMaterial (so it gets the sun, shadows and fog like everything else) with its albedo
// and normal replaced by procedural world-space patterns. Rock is blocky fractured sandstone: wide vertical columns
// split by deep joints, narrower columns inside them, and blocks stacked in each column with staggered horizontal
// joints, every block a slightly tilted chiselled plane (bump from a per-block facet height) with its own tone. The
// strata only tint the blocks faintly. Painterly light: faces turned to the sun are deep vermilion, ledge tops and
// sun-catching edges burnt orange, faces turned away and the feet of the walls go violet-magenta, and the joints and
// undersides get a faint cool blue-violet fill (the cool bounce in the concept art). Flat ground is rusty red-brown
// packed sand with long soft wind streaks, drifts and pebbles; plateau tops mix sand, rock and scrub. Slopes turn to
// rock by their normal, so the heightfield needs no texture.

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
uniform vec3 uLitDeep;
uniform vec3 uTop;
uniform vec3 uShade;
uniform vec3 uStrata;
uniform vec3 uSand;
uniform vec3 uDirt;
uniform vec3 uScrub;
uniform vec3 uCool;
uniform vec3 uSunDir;
uniform float uHard[${STRATA_COUNT}];
varying vec3 vTW;
varying float vRock;
varying float vShade;

float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tH1(float n) { return fract(sin(n * 91.345 + 0.17) * 47453.5453); }
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

// Irregular 1D cells (boundaries at k + 0.4 * (hash(k) - 0.5)): returns the cell index, f = 0..1 across it, w = width.
float jCell(float x, float salt, out float f, out float w) {
  float k = floor(x);
  float b0 = k + 0.4 * (tH1(k + salt) - 0.5);
  if (x < b0) { k -= 1.0; b0 = k + 0.4 * (tH1(k + salt) - 0.5); }
  float b1 = k + 1.0 + 0.4 * (tH1(k + 1.0 + salt) - 0.5);
  if (x >= b1) { k += 1.0; b0 = b1; b1 = k + 1.0 + 0.4 * (tH1(k + 1.0 + salt) - 0.5); }
  w = b1 - b0;
  f = (x - b0) / w;
  return k;
}

// Blocky fracture of a vertical face at (u along the face, y up), px = metres per pixel. Returns (block id 0..1,
// crack 0..1, groove depth in metres); major = 1 in the deep joints between the wide columns, tilt = the block's facet
// slope (along the face, up).
vec3 fracture(float u, float y, float px, out float major, out vec2 tilt) {
  float fM, wM, fm, wm;
  float M = jCell(u / 21.0, 3.1, fM, wM);
  float dM = min(fM, 1.0 - fM) * wM * 21.0;
  float m = jCell(u / 6.5, 7.7, fm, wm);
  float cw = wm * 6.5;
  float dm = min(fm, 1.0 - fm) * cw;
  // Tall blocks stacked in each narrow column (vertical columnar joints dominate), joints staggered column to column.
  float bh = 6.0 + 20.0 * tH1(m * 1.73 + M * 0.37);
  float Y = (y + tH1(m * 3.1 + 0.5) * bh) / bh;
  float row = floor(Y);
  float fy = Y - row;
  float dy = min(fy, 1.0 - fy) * bh;
  // Block id: mostly the column's own (so the columns read as tall vertical pillars), varied per block.
  float id = fract(tH1(m * 5.3 + M * 1.1) + 0.35 * tH1(m * 13.1 + row * 7.7 + M * 3.3));
  // Anti-aliased crack widths: the minor joints fade out once they get thinner than a couple of pixels.
  float jw = max(0.22, px * 1.3);
  float minorFade = 1.0 - smoothstep(0.35, 1.4, px);
  // Not every joint is open: each vertical and horizontal joint gets its own width, many stay hairline-closed.
  float openV = smoothstep(0.35, 0.9, tH1((fm < 0.5 ? m : m + 1.0) * 2.7 + 0.3));
  float openH = smoothstep(0.3, 0.9, tH1(m * 4.1 + (fy < 0.5 ? row : row + 1.0) * 1.9));
  float crack = max((1.0 - smoothstep(0.0, jw, dm)) * openV, (1.0 - smoothstep(0.0, jw, dy)) * openH) * minorFade;
  major = 1.0 - smoothstep(0.0, max(0.7, px * 1.6), dM);
  major *= 1.0 - smoothstep(3.0, 9.0, px);
  // Each block is a chiselled plane tilted its own way (the wide column adds a common lean); the joints are grooves.
  tilt = vec2(tH1(id * 3.1) - 0.5, (tH1(id * 5.7) - 0.5) * 0.7) * 0.75 * (0.4 + 0.6 * minorFade);
  tilt.x += (tH1(M * 1.9) - 0.5) * 0.5;
  float h = -0.3 * crack - 0.8 * major;
  return vec3(id, max(crack, major), h);
}

// Rock albedo at p with world normal n; h receives a bump height (metres), cr the crack amount, dn a world-space
// normal offset (the block facets).
vec3 rockAlbedo(vec3 p, vec3 n, float px, out float h, out float cr, out vec3 dn) {
  // Triplanar over the two vertical planes, sharply blended so facets stay crisp.
  vec2 w = pow(abs(n.xz) + 1e-3, vec2(6.0));
  w /= w.x + w.y;
  float mjA = 0.0, mjB = 0.0;
  vec2 tA = vec2(0.0), tB = vec2(0.0);
  vec3 fa = w.x > 0.02 ? fracture(p.z, p.y, px, mjA, tA) : vec3(0.0);
  vec3 fb = w.y > 0.02 ? fracture(p.x + 31.0, p.y, px, mjB, tB) : vec3(0.0);
  vec3 f = fa * w.x + fb * w.y;
  float id = w.x > w.y ? fa.x : fb.x;
  cr = f.y;
  // Facet tilt: along the face (the plane's horizontal tangent) and up, fading out on flat ledges.
  float vert = 1.0 - smoothstep(0.5, 0.85, abs(n.y));
  dn = (vec3(0.0, 0.0, tA.x) * w.x + vec3(tB.x, 0.0, 0.0) * w.y + vec3(0.0, tA.y * w.x + tB.y * w.y, 0.0)) * vert;
  // Per-block tone: vermilion to deeper red, brightness jitter.
  vec3 c = mix(uLit, uLitDeep, tH1(id * 9.7));
  c *= 0.88 + 0.2 * tH1(id * 4.3);
  // Faint strata tint: hard layers a touch paler and oranger, soft ones deeper.
  float t = strataT(p.y - strataWarp(p.xz));
  float hard = uHard[int(clamp(floor(t) - (${STRATA_K0}.0), 0.0, ${STRATA_COUNT - 1}.0))];
  c = mix(c, hard > 0.75 ? uTop : uLitDeep, (hard > 0.75 ? 0.22 : (hard < 0.3 ? 0.25 : 0.0)));
  // Big soft variation so wide faces are not one flat tone, plus faint vertical varnish streaks.
  c *= 0.9 + 0.2 * tNoise(vec2((p.x + p.z) * 0.015, p.y * 0.01));
  float sx = tNoise(vec2(p.z * 0.3, p.y * 0.015));
  float sz = tNoise(vec2(p.x * 0.3, p.y * 0.015));
  c *= 1.0 - smoothstep(0.6, 0.95, sx * w.x + sz * w.y) * 0.18;
  // Cracks: dark violet-red.
  c = mix(c, uShade * 0.55, cr * 0.7);
  h = f.z;
  return c;
}

vec3 sandAlbedo(vec3 p, out float h) {
  float big = tFbm(p.xz * 0.011);
  // Rusty packed sand: dirt base, warmer sand in the drifts, long soft streaks combed by the wind. A touch warmer than
  // the theme colours so the dusk sky light does not turn it pink.
  vec3 c = mix(uDirt, uSand, smoothstep(0.3, 0.75, big) * 0.75) * vec3(0.94, 1.1, 0.52);
  vec2 q = vec2(dot(p.xz, vec2(0.8, 0.6)), dot(p.xz, vec2(-0.6, 0.8)));
  float st = tNoise(vec2(q.x * 0.006, q.y * 0.09)) * 0.6 + tNoise(vec2(q.x * 0.02, q.y * 0.35)) * 0.4;
  c *= 0.78 + 0.38 * st;
  c *= 0.86 + 0.24 * smoothstep(0.2, 0.8, tFbm(q * vec2(0.004, 0.03) + 5.0));
  c = mix(c, uDirt * vec3(0.8, 0.62, 0.5), smoothstep(0.45, 0.15, st) * 0.3);
  float rip = sin(dot(p.xz, vec2(0.9, 0.45)) * 1.4 + tNoise(p.xz * 0.07) * 7.0) * 0.5 + 0.5;
  c *= 0.96 + 0.04 * rip;
  float peb = tNoise(p.xz * 1.9);
  c *= 1.0 - smoothstep(0.78, 0.97, peb) * 0.22;
  c *= 0.95 + 0.1 * tNoise(p.xz * 0.15);
  h = rip * 0.04 + peb * 0.03;
  return c;
}
`;

const MAIN_FRAGMENT = /* glsl */ `
{
  vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  float px = length(fwidth(vTW));
  // Rockiness: slopes are rock; cliff geometry (aRock = 1) is rock with sand settling on its ledges; plateau tops
  // (0 < aRock < 1) mix sand, broken rock and scrub.
  float slopeR = smoothstep(0.84, 0.6, wN.y);
  float r = vRock > 0.99 ? 1.0 - 0.75 * smoothstep(0.78, 0.97, wN.y) : slopeR;
  float hR = 0.0;
  float hS = 0.0;
  float cr = 0.0;
  vec3 dn = vec3(0.0);
  vec3 rockC = vec3(0.0);
  if (r > 0.004) rockC = rockAlbedo(vTW, wN, px, hR, cr, dn);
  #ifndef TERRAIN_LOW
  // Chiselled facets: tilt the shading normal per block (analytic, so no derivative sparkle at the block edges).
  if (r > 0.004) {
    normal = normalize(normal + (viewMatrix * vec4(dn * r, 0.0)).xyz);
    wN = normalize(wN + dn * r);
  }
  #endif
  vec3 sandC = r < 0.996 ? sandAlbedo(vTW, hS) : vec3(0.0);
  vec3 flatC = sandC;
  if (vRock > 0.01 && vRock < 0.99) {
    flatC = mix(sandC, mix(uLit, uSand, 0.45), vRock * (0.6 + 0.4 * tNoise(vTW.xz * 0.03)));
    flatC = mix(flatC, uScrub, smoothstep(0.62, 0.8, tNoise(vTW.xz * 0.09)) * 0.45);
  }
  vec3 albedo = mix(flatC, rockC, r);
  if (vRock > 1.5) {
    // Loose rocks: aRock 2 = the boulders along the course's edges, a little darker with desert varnish; 3 = the
    // formations on the course, with burnt-orange weathered caps (vShade is ~1 at the top of a rock).
    float n = tNoise(vTW.xz * 0.07 + vTW.y * 0.05);
    if (vRock < 2.5) albedo *= mix(vec3(0.78, 0.7, 0.74), vec3(0.92, 0.84, 0.84), n);
    else albedo = mix(albedo * vec3(1.08, 0.95, 0.9), uTop, smoothstep(0.9, 0.985, vShade) * 0.7);
  }
  // Painterly light. Sun-facing rock and ledge tops warm to burnt orange; faces turned away and the low walls (aShade
  // falls off towards the foot) shift to violet-magenta.
  float sunF = dot(wN, uSunDir);
  float lit = smoothstep(-0.2, 0.45, sunF);
  float top = smoothstep(0.35, 0.8, wN.y) * r;
  albedo = mix(albedo, uTop * (0.9 + 0.2 * tNoise(vTW.xz * 0.2)), top * (0.35 + 0.3 * lit));
  albedo = mix(albedo, mix(albedo, uTop, 0.4) * 1.1, smoothstep(0.15, 0.7, sunF) * r * 0.7);
  float foot = vRock > 0.99 && vRock < 1.5 ? smoothstep(0.98, 0.7, vShade) : 0.0;
  vec3 violet = uShade * vec3(1.1, 0.9, 1.3) + uLitDeep * 0.12;
  albedo = mix(albedo, violet * (0.7 + 0.3 * tNoise(vTW.xz * 0.05 + vTW.y * 0.03)), r * max((1.0 - lit) * 0.7, foot * 0.5));
  diffuseColor.rgb = albedo * vShade;
  // Cool blue-violet fill in the joints, on undersides and on shaded faces (the sky bounce in the concept art).
  float under = smoothstep(-0.1, -0.6, wN.y);
  totalEmissiveRadiance += uCool * r * vShade * (cr * 0.035 + under * 0.06 + (1.0 - lit) * 0.035 + foot * 0.02);
  #ifndef TERRAIN_LOW
  // Bump from the procedural height (three's perturbNormalArb, in view space): rock facets at full strength, the
  // sand's ripples gently.
  float hb = mix(hS * 0.35, hR, r);
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

/** Rock colours derived from the theme: the deeper red of the shadier blocks and the cool crevice fill. */
export function rockPalette(theme: Theme) {
  const lit = new THREE.Color(theme.rockLit);
  const shade = new THREE.Color(theme.rockShade);
  return {
    lit,
    litDeep: lit.clone().lerp(shade, 0.35),
    top: new THREE.Color(theme.rockStrata),
    shade,
    cool: new THREE.Color('#6a6cff').lerp(shade, 0.25),
  };
}

export function createTerrainMaterial(theme: Theme, strata: Strata, quality: Quality): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0 });
  const low = quality === 'low';
  if (low) m.defines = { TERRAIN_LOW: '' };
  const lin = (c: string) => new THREE.Color(c);
  const pal = rockPalette(theme);
  const uniforms = {
    uLit: { value: pal.lit },
    uLitDeep: { value: pal.litDeep },
    uTop: { value: pal.top },
    uShade: { value: pal.shade },
    uStrata: { value: lin(theme.rockStrata) },
    uSand: { value: lin(theme.sand) },
    uDirt: { value: lin(theme.dirt) },
    uScrub: { value: lin(theme.scrub) },
    uCool: { value: pal.cool },
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
