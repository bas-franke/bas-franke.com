// Sandstone material for the skyline rocks and the great arch: a MeshStandardMaterial (so sun, sky light, shadows and
// tone mapping match the rest of the world) with the albedo replaced by world-space blocky fracturing: tall vertical
// columns split by deep joints, blocks stacked in them with staggered horizontal joints, each block its own tone and
// a slightly tilted chiselled facet; only a faint trace of bedding. Sunlit faces and tops go burnt orange, faces turned
// away violet-magenta with a cool blue-violet bounce, and the fog is replaced by layered aerial perspective: the scene
// fog (or the theme haze if there is none), never fully opaque, drifting towards lavender with distance so far ridges
// stay readable as pale silhouettes.

import * as THREE from 'three';
import type { Theme } from '../core/tracks';

export interface RockMaterialOpts {
  /** Fades out fine detail with distance (no shimmering bands on 3 km mesas). */
  detail?: number;
  /** Cap on how far the haze may go (0..1). */
  maxHaze?: number;
}

export function createRockMaterial(theme: Theme, opts: RockMaterialOpts = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  const sun = new THREE.Vector3(
    Math.sin(theme.sunAzimuth) * Math.cos(theme.sunElevation),
    Math.sin(theme.sunElevation),
    Math.cos(theme.sunAzimuth) * Math.cos(theme.sunElevation),
  ).normalize();
  const lavender = new THREE.Color(theme.haze).lerp(new THREE.Color('#9d94c8'), 0.55);
  const uniforms = {
    uRockLit: { value: new THREE.Color(theme.rockLit) },
    uRockShade: { value: new THREE.Color(theme.rockShade) },
    uRockStrata: { value: new THREE.Color(theme.rockStrata) },
    uSand: { value: new THREE.Color(theme.sand) },
    uScrub: { value: new THREE.Color(theme.scrub) },
    uHaze: { value: new THREE.Color(theme.haze) },
    uLavender: { value: lavender },
    uSunDir: { value: sun },
    uHazeDist: { value: theme.hazeDistance * 1.45 },
    uMaxHaze: { value: opts.maxHaze ?? 0.9 },
    uDetail: { value: opts.detail ?? 1 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRockPos;\nvarying vec3 vRockN;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvRockPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvRockN = normalize(mat3(modelMatrix) * objectNormal);',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\nfloat rockDist = length(vRockPos - cameraPosition);\nvec3 rockTilt;\ndiffuseColor.rgb *= rockAlbedo(vRockPos, normalize(vRockN), rockDist, length(fwidth(vRockPos)), rockTilt);',
      )
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(normal + (viewMatrix * vec4(rockTilt, 0.0)).xyz);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // Violet-blue bounce light in the shade, like the painted shadows in the concept art.
          float away = smoothstep(0.15, -0.35, dot(normalize(vRockN), uSunDir));
          totalEmissiveRadiance += (uRockShade * vec3(0.55, 0.5, 1.0) * 0.16 + vec3(0.02, 0.025, 0.08)) * away;
        }`,
      )
      .replace('#include <fog_fragment>', FOG);
  };
  mat.customProgramCacheKey = () => 'dustrunners-rock';
  return mat;
}

const FRAG_HEAD = /* glsl */ `
varying vec3 vRockPos;
varying vec3 vRockN;
uniform vec3 uRockLit;
uniform vec3 uRockShade;
uniform vec3 uRockStrata;
uniform vec3 uSand;
uniform vec3 uScrub;
uniform vec3 uHaze;
uniform vec3 uLavender;
uniform vec3 uSunDir;
uniform float uHazeDist;
uniform float uMaxHaze;
uniform float uDetail;

float rHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float rNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rHash(i), rHash(i + vec2(1.0, 0.0)), f.x), mix(rHash(i + vec2(0.0, 1.0)), rHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float rH1(float n) { return fract(sin(n * 91.345 + 0.17) * 47453.5453); }
// Irregular 1D cells (boundaries at k + 0.4 * (hash(k) - 0.5)): returns the cell index, f = 0..1 across it, w = width.
float rCell(float x, float salt, out float f, out float w) {
  float k = floor(x);
  float b0 = k + 0.4 * (rH1(k + salt) - 0.5);
  if (x < b0) { k -= 1.0; b0 = k + 0.4 * (rH1(k + salt) - 0.5); }
  float b1 = k + 1.0 + 0.4 * (rH1(k + 1.0 + salt) - 0.5);
  if (x >= b1) { k += 1.0; b0 = b1; b1 = k + 1.0 + 0.4 * (rH1(k + 1.0 + salt) - 0.5); }
  w = b1 - b0;
  f = (x - b0) / w;
  return k;
}

// Blocky fracture of a vertical face at (u along it, y up), px metres per pixel: (block id, crack 0..1), tilt = the
// block's facet slope (along, up). Far away only the wide columns remain.
vec2 rFracture(float u, float y, float px, out vec2 tilt) {
  float fM, wM, fm, wm;
  float M = rCell(u / 34.0, 3.1, fM, wM);
  float dM = min(fM, 1.0 - fM) * wM * 34.0;
  float m = rCell(u / 9.0, 7.7, fm, wm);
  float dm = min(fm, 1.0 - fm) * wm * 9.0;
  float bh = 7.0 + 20.0 * rH1(m * 1.73 + M * 0.37);
  float Y = (y + rH1(m * 3.1 + 0.5) * bh) / bh;
  float row = floor(Y);
  float fy = Y - row;
  float dy = min(fy, 1.0 - fy) * bh;
  float minorFade = 1.0 - smoothstep(0.5, 2.0, px);
  float id = minorFade > 0.0 ? rH1(m * 13.1 + row * 7.7 + M * 3.3) : rH1(M * 4.7);
  float crack = (1.0 - smoothstep(0.0, max(0.3, px * 1.3), min(dm, dy))) * minorFade;
  float major = (1.0 - smoothstep(0.0, max(1.0, px * 1.6), dM)) * (1.0 - smoothstep(4.0, 12.0, px));
  tilt = vec2(rH1(id * 3.1) - 0.5, (rH1(id * 5.7) - 0.5) * 0.7) * 0.7 * minorFade + vec2((rH1(M * 1.9) - 0.5) * 0.45, 0.0);
  return vec2(id, max(crack, major));
}

vec3 rockAlbedo(vec3 p, vec3 n, float dist, float px, out vec3 tilt) {
  float detail = uDetail * (1.0 - smoothstep(700.0, 2600.0, dist));
  // Triplanar over the two vertical planes, sharply blended so the facets stay crisp.
  vec2 w = pow(abs(n.xz) + 1e-3, vec2(6.0));
  w /= w.x + w.y;
  vec2 tA = vec2(0.0), tB = vec2(0.0);
  vec2 fa = w.x > 0.02 ? rFracture(p.z, p.y, px, tA) : vec2(0.0);
  vec2 fb = w.y > 0.02 ? rFracture(p.x + 31.0, p.y, px, tB) : vec2(0.0);
  float id = w.x > w.y ? fa.x : fb.x;
  float crack = (fa.y * w.x + fb.y * w.y) * (0.4 + 0.6 * detail);
  float vert = 1.0 - smoothstep(0.5, 0.85, abs(n.y));
  tilt = (vec3(0.0, 0.0, tA.x) * w.x + vec3(tB.x, 0.0, 0.0) * w.y + vec3(0.0, tA.y * w.x + tB.y * w.y, 0.0)) * vert * (0.3 + 0.7 * detail);
  vec3 deep = mix(uRockLit, uRockShade, 0.35);
  vec3 c = mix(uRockLit, deep, rH1(id * 9.7));
  c *= 0.84 + 0.28 * rH1(id * 4.3);
  // A faint trace of bedding (thick, wandering) so tall faces are not uniform.
  float y = p.y + (rNoise(p.xz * 0.0035) - 0.5) * 14.0;
  c = mix(c, uRockStrata, smoothstep(0.6, 0.95, rNoise(vec2(y / 30.0, 1.3))) * 0.18);
  c *= 0.9 + 0.2 * rNoise(vec2((p.x + p.z) * 0.012, p.y * 0.008));
  vec2 h = normalize(vec2(-n.z, n.x) + 1e-4);
  float u = dot(p.xz, h);
  float streak = smoothstep(0.7, 0.95, rNoise(vec2(u * 0.3, p.y * 0.002)));
  c *= 1.0 - streak * 0.15 * detail;
  c = mix(c, uRockShade * 0.55, crack * 0.85);
  // Painterly light: sunlit faces burnt orange, faces turned away violet-magenta, so forms read even in flat light.
  float sunF = dot(normalize(n + tilt), uSunDir);
  float lit = smoothstep(-0.2, 0.45, sunF);
  c = mix(c, mix(c, uRockStrata, 0.4) * 1.1, smoothstep(0.15, 0.7, sunF) * 0.7);
  vec3 violet = uRockShade * vec3(1.1, 0.9, 1.3) + deep * 0.12;
  c = mix(c, violet * (0.85 + 0.3 * rH1(id * 2.3)), (1.0 - lit) * 0.7);
  // Flat tops and ledges: burnt orange with a little sand and scrub; the talus slopes are lighter rubble.
  float top = smoothstep(0.72, 0.9, n.y);
  float talus = smoothstep(0.25, 0.5, n.y) * (1.0 - top);
  vec3 sandy = mix(mix(uRockStrata, uSand, 0.5), uScrub, smoothstep(0.6, 0.85, rNoise(p.xz * 0.05)) * 0.4);
  c = mix(c, mix(c, mix(uRockStrata, uSand, 0.4), 0.45) * (0.85 + 0.25 * rNoise(p.xz * 0.15)), talus);
  c = mix(c, sandy, top * 0.85);
  return c;
}
`;

// Layered aerial perspective: the scene fog up close, a gentler curve further out, capped so the far layers keep their
// silhouettes, and shifted towards lavender with distance.
const FOG = /* glsl */ `
{
  float d = length(vRockPos - cameraPosition);
  // Own haze curve: gentler than the scene's exp2 fog, so 1, 2 and 3 km ridges still differ instead of all
  // vanishing into the same flat colour. Close in, follow the scene fog so near rocks match the terrain.
  float haze = 1.0 - exp(-d / uHazeDist);
  vec3 hz = uHaze;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float sf = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float sf = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    haze = mix(sf, haze, smoothstep(250.0, 1100.0, d));
    hz = fogColor;
  #endif
  haze = min(haze, uMaxHaze);
  // Lift the colour of the far layers a little towards a cool lavender, and let height above the ground thin the haze
  // slightly so mesa tops stay a touch crisper than their feet.
  float far = smoothstep(900.0, 3200.0, d);
  hz = mix(hz, uLavender, far * 0.45);
  haze *= 1.0 - clamp((vRockPos.y - 120.0) / 900.0, 0.0, 0.2);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, hz, haze);
}
`;
