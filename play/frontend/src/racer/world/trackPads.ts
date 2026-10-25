// Boost pads at track.pads (the same centres the physics uses, the course's own and the shortcut lanes'): a dark grated plate
// with glowing orange chevrons that scroll forward and pulse, set in a raised steel frame, plus a soft additive glow
// on the dirt around it. All pads share one mesh per material.

import * as THREE from 'three';
import type { Track } from '../core/track';
import { GeoBuilder, type UV } from './trackGeo';
import { padTextures } from './trackTextures';

/** Physics triggers within 5.5 m of the pad centre laterally; the plate is a little narrower than that. */
const HALF_W = 5;
const HALF_L = 8;

export function buildPads(track: Track, frameGeo: GeoBuilder, anisotropy: number) {
  const plate = new GeoBuilder(true, false);
  const glow = new GeoBuilder(true, false);
  const steel = new THREE.Color('#4a4440');
  const W = (s: number, x: number, h: number) => track.toWorld(s, x, h, new THREE.Vector3());
  for (const { s, x } of track.pads) {
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const s0 = s - HALF_L + (2 * HALF_L * i) / steps;
      const s1 = s - HALF_L + (2 * HALF_L * (i + 1)) / steps;
      const v0 = (s0 - (s - HALF_L)) / 8;
      const v1 = (s1 - (s - HALF_L)) / 8;
      const up = track.frameAt(s0).up;
      const uv: [UV, UV, UV, UV] = [
        [0, v0],
        [1, v0],
        [1, v1],
        [0, v1],
      ];
      plate.quad(W(s0, x - HALF_W, 0.06), W(s0, x + HALF_W, 0.06), W(s1, x + HALF_W, 0.06), W(s1, x - HALF_W, 0.06), uv, up);
      // Frame rails along both sides.
      frameGeo.setColor(steel);
      for (const side of [-1, 1]) {
        frameGeo.beam(W(s0, x + side * (HALF_W + 0.25), 0.05), W(s1, x + side * (HALF_W + 0.25), 0.05), 0.5, 0.18, up);
      }
    }
    for (const end of [-1, 1]) {
      const se = s + end * (HALF_L + 0.25);
      frameGeo.beam(W(se, x - HALF_W - 0.5, 0.05), W(se, x + HALF_W + 0.5, 0.05), 0.5, 0.18, track.frameAt(se).up);
    }
    // Glow halo: a larger quad around the pad, radial falloff from the uv.
    const g = 4;
    const gs = 6;
    for (let i = 0; i < gs; i++) {
      const s0 = s - HALF_L - g + ((2 * (HALF_L + g)) * i) / gs;
      const s1 = s - HALF_L - g + ((2 * (HALF_L + g)) * (i + 1)) / gs;
      const v0 = i / gs;
      const v1 = (i + 1) / gs;
      glow.quad(W(s0, x - HALF_W - g, 0.04), W(s0, x + HALF_W + g, 0.04), W(s1, x + HALF_W + g, 0.04), W(s1, x - HALF_W - g, 0.04), [
        [0, v0],
        [1, v0],
        [1, v1],
        [0, v1],
      ], track.frameAt(s0).up);
    }
  }

  const tex = padTextures(anisotropy);
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    emissiveMap: tex.emissiveMap,
    emissive: '#ff6a10',
    emissiveIntensity: 2.6,
    roughness: 0.55,
    metalness: 0.4,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const plateMesh = new THREE.Mesh(plate.build(), mat);
  plateMesh.receiveShadow = true;

  // Halo: rounded-rectangle falloff, additive, no depth write.
  const haloTex = (() => {
    const n = 64;
    const d = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = Math.abs(x / (n - 1) - 0.5) * 2;
        const v = Math.abs(y / (n - 1) - 0.5) * 2;
        const q = Math.pow(Math.pow(u, 4) + Math.pow(v, 4), 0.25);
        const a = Math.pow(THREE.MathUtils.clamp(1 - q, 0, 1), 1.4);
        const o = (y * n + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = a * 255;
        d[o + 3] = 255;
      }
    }
    const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  })();
  const haloMat = new THREE.MeshBasicMaterial({
    color: '#ff8a30',
    map: haloTex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    fog: false,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  const haloMesh = new THREE.Mesh(glow.build(), haloMat);
  haloMesh.renderOrder = 1;

  const group = new THREE.Group();
  group.name = 'boost-pads';
  group.add(plateMesh, haloMesh);
  return {
    object: group,
    update(time: number) {
      tex.emissiveMap.offset.y = -((time * 1.4) % 1);
      const pulse = 0.5 + 0.5 * Math.sin(time * 7);
      mat.emissiveIntensity = 2 + 1.4 * pulse;
      haloMat.opacity = 0.35 + 0.25 * pulse;
    },
    dispose() {
      plateMesh.geometry.dispose();
      haloMesh.geometry.dispose();
      mat.dispose();
      haloMat.dispose();
      tex.map.dispose();
      tex.emissiveMap.dispose();
      haloTex.dispose();
    },
  };
}
