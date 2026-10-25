// The packed-dirt road ribbon from -(width/2 + 2) to +(width/2 + 2): chunked indexed meshes (frustum culled) with UVs
// in track space (u across, v = s) so the drag streaks of the dirt texture run along the direction of travel. Vertex
// colours paint the lighter worn racing line (pulled to the inside of corners) and the darker edges and shoulders; the
// shader breaks up the texture tiling with a second, larger sample and low-frequency mottling.

import * as THREE from 'three';
import type { Track } from '../core/track';
import type { Quality } from './types';
import { ROAD_TILE_U, ROAD_TILE_V, roadTextures } from './trackTextures';

/** Frames per chunk (2 m each). */
export const CHUNK_FRAMES = 100;

const NOISE_GLSL = /* glsl */ `
float trHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float trNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = trHash(i), b = trHash(i + vec2(1.0, 0.0)), c = trHash(i + vec2(0.0, 1.0)), d = trHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
uniform float trMean;
`;

const MAP_GLSL = /* glsl */ `
#ifdef USE_MAP
{
  // Anti-tiling: a second, larger and offset sample of the same texture, plus slow mottling in track space.
  vec4 big = texture2D(map, vMapUv * vec2(0.31, 0.23) + vec2(0.37, 0.11));
  float lum = dot(big.rgb, vec3(0.333));
  diffuseColor.rgb *= mix(1.0, lum / trMean, 0.45);
  vec2 m = vMapUv * vec2(${ROAD_TILE_U.toFixed(1)}, ${ROAD_TILE_V.toFixed(1)});
  float macro = trNoise(m * vec2(0.09, 0.03)) * 0.6 + trNoise(m * vec2(0.35, 0.11)) * 0.4;
  diffuseColor.rgb *= 0.86 + 0.26 * macro;
  // Slight warm/cool patches: redder clay vs paler dust.
  float hue = trNoise(m * vec2(0.05, 0.017) + 7.3);
  diffuseColor.rgb *= mix(vec3(1.04, 0.97, 0.92), vec3(0.97, 1.0, 1.04), hue);
}
#endif
`;

export function buildRoad(track: Track, quality: Quality, anisotropy: number) {
  const tex = roadTextures(quality === 'low' ? 256 : 512, anisotropy);
  const mat = new THREE.MeshStandardMaterial({
    color: track.def.theme.dirt,
    map: tex.map,
    normalMap: quality === 'low' ? null : tex.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 0.96,
    metalness: 0,
    vertexColors: true,
  });
  const brighten = new THREE.Color(track.def.theme.dirt);
  // The texture averages ~0.8; nudge the base colour back up so the theme colour is what you see on average.
  mat.color.copy(brighten).multiplyScalar(1.12);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.trMean = { value: tex.mean };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${MAP_GLSL}`);
  };
  mat.customProgramCacheKey = () => 'track-road';

  // Lateral profile: offsets as (fraction of half width, extra metres). Shoulders beyond the wall drop a little so the
  // terrain can meet them.
  const inner = quality === 'low' ? 8 : 14;
  const prof: { f: number; add: number; h: number }[] = [
    { f: -1, add: -2, h: -0.12 },
    { f: -1, add: -0.9, h: -0.02 },
  ];
  for (let k = 0; k <= inner; k++) prof.push({ f: -1 + (2 * k) / inner, add: 0, h: 0 });
  prof.push({ f: 1, add: 0.9, h: -0.02 }, { f: 1, add: 2, h: -0.12 });
  const cols = prof.length;

  const frames = track.frames;
  const n = frames.length;
  const group = new THREE.Group();
  group.name = 'road';
  const tmp = new THREE.Vector3();
  for (let i0 = 0; i0 < n - 1; i0 += CHUNK_FRAMES) {
    const i1 = Math.min(n - 1, i0 + CHUNK_FRAMES);
    const rows = i1 - i0 + 1;
    const pos = new Float32Array(rows * cols * 3);
    const nrm = new Float32Array(rows * cols * 3);
    const uv = new Float32Array(rows * cols * 2);
    const col = new Float32Array(rows * cols * 3);
    for (let j = 0; j < rows; j++) {
      const i = i0 + j;
      const f = frames[i];
      const s = f.s;
      const hw = f.width / 2;
      // Racing line: pulled towards the inside of the corner (kappa > 0 turns left = negative x).
      const line = THREE.MathUtils.clamp(-f.kappa * 160, -0.42, 0.42);
      for (let k = 0; k < cols; k++) {
        const p = prof[k];
        const x = p.f * hw + Math.sign(p.f) * p.add;
        tmp.copy(f.pos).addScaledVector(f.right, x).addScaledVector(f.up, p.h);
        const o = (j * cols + k) * 3;
        pos[o] = tmp.x;
        pos[o + 1] = tmp.y;
        pos[o + 2] = tmp.z;
        nrm[o] = f.up.x;
        nrm[o + 1] = f.up.y;
        nrm[o + 2] = f.up.z;
        uv[(j * cols + k) * 2] = x / ROAD_TILE_U;
        uv[(j * cols + k) * 2 + 1] = s / ROAD_TILE_V;
        let r: number, g: number, b: number;
        if (p.add > 0) {
          // Behind the barrier: loose, darker, redder sand.
          r = 0.78;
          g = 0.68;
          b = 0.62;
        } else {
          const t = p.f;
          const worn = Math.exp(-(((t - line) / 0.36) ** 2));
          const edge = THREE.MathUtils.smoothstep(Math.abs(t), 0.62, 1);
          const l = (0.9 + 0.17 * worn) * (1 - 0.2 * edge);
          r = l * (1 + 0.02 * edge);
          g = l * (1 - 0.03 * edge + 0.01 * worn);
          b = l * (1 - 0.06 * edge + 0.02 * worn);
        }
        col[o] = r;
        col[o + 1] = g;
        col[o + 2] = b;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < rows - 1; j++) {
      for (let k = 0; k < cols - 1; k++) {
        const a = j * cols + k;
        const b = (j + 1) * cols + k;
        // Winding so the face normal points along f.up (right x tangent ordering).
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return {
    object: group,
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      mat.dispose();
      tex.map.dispose();
      tex.normalMap.dispose();
    },
  };
}
