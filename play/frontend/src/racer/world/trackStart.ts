// The start/finish gantry over s = 0: two hazard-striped pylons behind the barriers, a deep beam with the race banner
// on both faces, and a row of start lamps on each side that run a red countdown, flash green, then go dark (looping).
// The structure uses the barrier atlas; the lamps get a tiny per-lamp emissive DataTexture updated on state changes.

import * as THREE from 'three';
import type { Track } from '../core/track';
import { GeoBuilder, type UV } from './trackGeo';
import { ROW, rowV } from './trackTextures';

const LAMPS = 5;
const CYCLE = 8;

export function buildStartGantry(track: Track, atlasGeo: GeoBuilder) {
  const f = track.frameAt(0);
  const hw = f.width / 2;
  const right = new THREE.Vector3(f.right.x, 0, f.right.z).normalize();
  const fwd = new THREE.Vector3(f.tangent.x, 0, f.tangent.z).normalize();
  const base = f.pos.clone();
  const P = (x: number, y: number, t: number) => base.clone().addScaledVector(right, x).addScaledVector(fwd, t).setY(base.y + y);
  const ring = (x0: number, x1: number, t0: number, t1: number, y: number) => [P(x0, y, t0), P(x1, y, t0), P(x1, y, t1), P(x0, y, t1)];
  const row = (r: number, u0: number, u1: number, alongV = false): [UV, UV, UV, UV] => {
    const [v0, v1] = rowV(r);
    // alongV: u runs up the face (for the pylons' diagonal stripes).
    return alongV
      ? [
          [u0, v0],
          [u0, v1],
          [u1, v1],
          [u1, v0],
        ]
      : [
          [u0, v0],
          [u1, v0],
          [u1, v1],
          [u0, v1],
        ];
  };

  const H = 15;
  const pylonX = hw + 1.9;
  for (const side of [-1, 1]) {
    const x = side * pylonX;
    const c = [...ring(x - 0.85, x + 0.85, -0.85, 0.85, -0.6), ...ring(x - 0.85, x + 0.85, -0.85, 0.85, H)];
    atlasGeo.box(c, (face) => (face < 2 ? row(ROW.grate, 0, 0.3) : row(ROW.hazard, 0, H / 2.2, true)));
    // Plinth.
    const p = [...ring(x - 1.3, x + 1.3, -1.3, 1.3, -0.6), ...ring(x - 1.3, x + 1.3, -1.3, 1.3, 1.2)];
    atlasGeo.box(p, (face) => (face === 1 ? row(ROW.steel, 0, 0.5, false) : row(ROW.steel, 0, 0.7)));
  }
  // Banner beam: faces 2 and 4 (towards and away from the approaching racers) carry the banner.
  const bx = pylonX + 0.9;
  const beam = [...ring(-bx, bx, -1, 1, 11.6), ...ring(-bx, bx, -1, 1, 14.6)];
  atlasGeo.box(beam, (face) => (face === 2 || face === 4 ? row(ROW.banner, 0, 3) : face < 2 ? row(ROW.grate, 0, 4) : row(ROW.steel, 0, 0.6)));
  // Lamp housing under the beam.
  const lw = 1.5 * LAMPS + 0.6;
  const housing = [...ring(-lw / 2, lw / 2, -0.7, 0.7, 10.2), ...ring(-lw / 2, lw / 2, -0.7, 0.7, 11.6)];
  atlasGeo.box(housing, () => row(ROW.grate, 0, 1));

  // Lamps on both faces of the housing.
  const lamps = new GeoBuilder(true, false);
  for (let i = 0; i < LAMPS; i++) {
    const x = -lw / 2 + 0.3 + 1.5 * i + 0.75;
    const u = (i + 0.5) / LAMPS;
    const uv: [UV, UV, UV, UV] = [
      [u, 0.5],
      [u, 0.5],
      [u, 0.5],
      [u, 0.5],
    ];
    for (const t of [-1, 1]) {
      const t0 = t * 0.7;
      const t1 = t * 0.95;
      const c = [...ring(x - 0.5, x + 0.5, t0, t1, 10.4), ...ring(x - 0.5, x + 0.5, t0, t1, 11.4)];
      lamps.box(c, () => uv);
    }
  }
  const data = new Uint8Array(LAMPS * 4);
  const tex = new THREE.DataTexture(data, LAMPS, 1, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({ color: '#1a1a1a', roughness: 0.3, metalness: 0.2, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 1.6 });
  const mesh = new THREE.Mesh(lamps.build(), mat);
  mesh.name = 'start-lamps';

  let state = -1;
  const update = (time: number) => {
    const t = time % CYCLE;
    // 0..5 s: lamps come on red one by one; 5..7 s: all green; 7..8 s: off.
    const next = t < 5 ? Math.floor(t) : t < 7 ? 10 : 11;
    if (next === state) return;
    state = next;
    for (let i = 0; i < LAMPS; i++) {
      const o = i * 4;
      const on = state === 10 || (state < 10 && i <= state);
      const green = state === 10;
      data[o] = on ? (green ? 40 : 255) : 10;
      data[o + 1] = on ? (green ? 255 : 8) : 6;
      data[o + 2] = on ? (green ? 60 : 0) : 4;
      data[o + 3] = 255;
    }
    tex.needsUpdate = true;
  };
  update(0);
  return {
    object: mesh,
    update,
    dispose() {
      mesh.geometry.dispose();
      mat.dispose();
      tex.dispose();
    },
  };
}
