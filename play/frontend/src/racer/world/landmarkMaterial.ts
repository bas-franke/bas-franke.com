// Sandstone material for the skyline rocks and the great arch: a MeshStandardMaterial (so sun, sky light, shadows and
// tone mapping match the rest of the world) with the albedo replaced by world-space strata: wavy horizontal bands of
// pale and deep-red rock, vertical erosion grooves and varnish streaks, sand on flat tops and rubble on the talus.
// Shadowed faces get a violet bounce tint, and the fog is replaced by layered aerial perspective: the scene fog (or
// the theme haze if there is none), never fully opaque, drifting towards lavender with distance so far ridges stay
// readable as pale silhouettes.

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
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat rockDist = length(vRockPos - cameraPosition);\ndiffuseColor.rgb *= rockAlbedo(vRockPos, normalize(vRockN), rockDist);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // Violet bounce light in the shade, like the painted shadows in the concept art.
          float away = smoothstep(0.15, -0.35, dot(normalize(vRockN), uSunDir));
          totalEmissiveRadiance += uRockShade * vec3(0.55, 0.5, 1.0) * away * 0.16;
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
float rBand(float y, float period, float w) {
  float f = fract(y / period);
  return smoothstep(0.0, w, f) * smoothstep(w * 2.5, w * 1.5, f);
}

vec3 rockAlbedo(vec3 p, vec3 n, float dist) {
  float detail = uDetail * (1.0 - smoothstep(700.0, 2600.0, dist));
  // Strata follow the height but wander gently over the landscape, as real bedding planes do.
  float y = p.y + (rNoise(p.xz * 0.0035) - 0.5) * 14.0 + (rNoise(p.xz * 0.02) - 0.5) * 3.0;
  // Big alternating formations: brighter orange and deeper red layers tens of metres thick.
  float form = rNoise(vec2(y / 38.0, 3.7));
  vec3 c = mix(uRockLit, mix(uRockLit, uRockShade, 0.45), smoothstep(0.35, 0.8, form));
  // Pale beds of varying thickness (some barely there), and soft darker partings between them.
  float bedN = rNoise(vec2(y / 21.0, 1.3));
  float pale = rBand(y, 21.0, 0.05 + 0.1 * bedN) * smoothstep(0.1, 0.55, bedN);
  c = mix(c, uRockStrata, pale * 0.6);
  c = mix(c, uRockStrata, smoothstep(0.55, 0.95, rNoise(vec2(y / 6.0, 7.1))) * 0.18);
  c *= 1.0 - rBand(y + 2.0, 7.3, 0.08) * 0.12 * detail * rNoise(vec2(y / 7.3, 4.0));
  // Painterly light: sunlit faces warm and bright, faces turned away deep red-brown, so forms read even in flat light.
  float sunF = dot(n, uSunDir);
  vec3 shadeTint = uRockShade / max(uRockLit, vec3(0.02)) * vec3(0.95, 0.92, 1.1);
  c *= mix(mix(vec3(1.0), shadeTint, 0.55), vec3(1.08, 1.04, 1.0), smoothstep(-0.25, 0.45, sunF));
  // Horizontal coordinate along the face: vertical grooves and dark desert-varnish streaks run down the cliffs.
  vec2 h = normalize(vec2(-n.z, n.x) + 1e-4);
  float u = dot(p.xz, h);
  // Close up (the great arch, near spires): thin bedding lines and blocky weathering, faded out with distance.
  float nearD = 1.0 - smoothstep(120.0, 450.0, dist);
  float bed = fract(y / 2.7 + rNoise(vec2(u * 0.05, y * 0.1)) * 0.3);
  c *= 1.0 - smoothstep(0.85, 0.95, bed) * 0.1 * nearD;
  c *= 1.0 + (rNoise(vec2(u / 5.0, y / 2.7)) - 0.5) * 0.18 * nearD;
  float groove = rNoise(vec2(u * 0.16, p.y * 0.004));
  c *= mix(1.0, 0.9 + 0.17 * groove, 0.4 + 0.6 * detail);
  float streak = smoothstep(0.7, 0.95, rNoise(vec2(u * 0.35, p.y * 0.002)));
  c *= 1.0 - streak * 0.2 * detail;
  // Flat tops and ledges catch sand and scrub; the talus slopes are lighter rubble.
  float top = smoothstep(0.72, 0.9, n.y);
  float talus = smoothstep(0.25, 0.5, n.y) * (1.0 - top);
  vec3 sandy = mix(uSand, uScrub, smoothstep(0.6, 0.85, rNoise(p.xz * 0.05)) * 0.5);
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
