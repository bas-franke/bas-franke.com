// The checkered start and finish lines across the sand, 3.2 m deep, in the barrier atlas. There are no barriers: the
// edges of the course are rocks (rockFormations.ts). Also where the gorge bridge stretches are, which the bridge, the
// rocks and the terrain all skip.

import * as THREE from 'three';
import type { Track } from '../core/track';
import { GeoBuilder, type UV } from './trackGeo';
import { ROW, rowV } from './trackTextures';
import type { Zones } from './zones';

/** True when s lies in one of the gorge bridge stretches (plus `margin` metres either side). */
export function onBridge(track: Track, zones: Zones, s: number, margin = 4) {
  for (const g of zones.gorges) {
    if (s >= g.s0 - margin && s <= g.s1 + margin) return true;
  }
  return false;
}

function uvRow(row: number, u0: number, u1: number): [UV, UV, UV, UV] {
  const [v0, v1] = rowV(row);
  return [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
}

export function buildLines(track: Track, decalMat: THREE.Material) {
  const decal = new GeoBuilder(true, false);
  const fa = track.frameAt(0);
  const fb = track.frameAt(0);
  const v = () => new THREE.Vector3();

  // Squares of 0.8 m, just above the sand.
  for (const line of [track.startS, track.finishS]) {
    const segs = 8;
    const s0 = line - 1.6;
    const s1 = line + 1.6;
    track.frameAt(s0, fa);
    track.frameAt(s1, fb);
    const p = Array.from({ length: 4 }, v);
    for (let i = 0; i < segs; i++) {
      const xa = -1 + (2 * i) / segs;
      const xb = -1 + (2 * (i + 1)) / segs;
      const put = (f: typeof fa, xf: number, out: THREE.Vector3) => out.copy(f.pos).addScaledVector(f.right, (xf * f.width) / 2).addScaledVector(f.up, 0.03);
      put(fa, xa, p[0]);
      put(fa, xb, p[1]);
      put(fb, xb, p[2]);
      put(fb, xa, p[3]);
      const ua = ((xa + 1) * fa.width) / 2 / 6.4;
      const ub = ((xb + 1) * fa.width) / 2 / 6.4;
      decal.quad(p[0], p[1], p[2], p[3], uvRow(ROW.checker, ua, ub), fa.up);
    }
  }

  const mesh = new THREE.Mesh(decal.build(), decalMat);
  mesh.name = 'lines';
  mesh.receiveShadow = true;
  return mesh;
}
