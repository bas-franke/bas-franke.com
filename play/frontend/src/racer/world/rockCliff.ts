// Sandstone cliff strips: a vertical rock face extruded along a line of columns (the canyon walls beside the track,
// the walls of a gorge). The cross-section follows the world-space strata: hard pale layers stand proud, soft dark
// layers are cut back under them (overhangs), every layer steps back a little (chunky ledges), and along the strip the
// face is broken into big blocky pillars with erosion clefts between them and smaller vertical flutes. The top is a
// lip that runs back into the plateau behind so the heightfield there joins without a seam.

import * as THREE from 'three';
import type { GeoBuilder } from './terrainGeo';
import { hash, noise1, smoothstep, strataIndex, strataWarp, type Strata } from './terrainNoise';

export interface CliffColumn {
  /** Foot of the face (horizontal position). */
  x: number;
  z: number;
  /** Horizontal unit normal pointing out of the rock (towards the open air). */
  ox: number;
  oz: number;
  /** Distance along the strip, for noise. */
  along: number;
  /** World y of the ground at the foot and of the top edge. */
  bottom: number;
  top: number;
  /** How far behind the foot the top lip ends (where the plateau heightfield takes over). */
  back: number;
}

export interface CliffOpts {
  /** Horizontal setback per metre of height. */
  lean: number;
  /** Size of the blocky pillars (metres in and out) and depth of the clefts between them. */
  buttress: number;
  cleft: number;
  /** Depth of the small vertical flutes. */
  flutes: number;
  /** Pillar width. */
  period: number;
  /** Height of the lip above `top` (negative tucks it under the ground ribbon). */
  lift: number;
  seed: number;
  /** Length of a closed loop whose `along` wraps (track walls), so the noise joins up at the start line. */
  wrapLen?: number;
}

/** Horizontal setback of layer k (hardness h) at `a` along the strip: pillars, clefts, wobble and flutes. */
function lateral(a: number, k: number, h: number, o: CliffOpts) {
  const u = a / o.period + 1.2 * noise1(a * 0.009, o.seed);
  const cell = Math.floor(u);
  const f = u - cell;
  const w = smoothstep(0.03, 0.1, f) * (1 - smoothstep(0.88, 0.95, f));
  const amp = (hash(cell + o.seed * 31) - 0.35) * o.buttress;
  const jitter = (hash(cell * 7.3 + k * 1.7 + o.seed) - 0.5) * 0.4 * o.buttress * w;
  const wobble = (noise1(a * 0.045, o.seed + 3) - 0.5) * 2.5;
  const g = 0.5 + 0.5 * Math.cos((a / 6.5) * Math.PI * 2 + 3 * noise1(a * 0.05, o.seed + 7));
  return w * amp + (1 - w) * o.cleft + jitter + wobble + o.flutes * g * g * (h > 0.75 ? 0.4 : 1);
}

export function addCliff(geo: GeoBuilder, cols: CliffColumn[], strata: Strata, o: CliffOpts) {
  const n = cols.length;
  if (n < 2) return;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const c of cols) {
    ymin = Math.min(ymin, c.bottom - 3);
    ymax = Math.max(ymax, c.top);
  }
  if (ymax - ymin < 1) return;
  const k0 = strataIndex(ymin - 3.5);
  const k1 = strataIndex(ymax + 3.5);
  const layers = k1 - k0 + 1;
  // Profile points per column: 2 per layer (face bottom, face top) + 3 for the lip.
  const P = layers * 2 + 3;
  const pts = new Float32Array(n * P * 2); // (offset into the rock, y)
  const shade = new Float32Array(n * P);

  for (let i = 0; i < n; i++) {
    const c = cols[i];
    const colBottom = c.bottom - 3;
    const warp = strataWarp(c.x, c.z);
    let crestOt = 0;
    let row = i * P;
    for (let L = 0; L < layers; L++) {
      const k = k0 + L;
      const ya = L === 0 ? colBottom : strata.bottom[k] + warp;
      const yb = L === layers - 1 ? Math.max(c.top, strata.bottom[k + 1] + warp) : strata.bottom[k + 1] + warp;
      const yA = THREE.MathUtils.clamp(ya, colBottom, c.top);
      const yB = THREE.MathUtils.clamp(yb, colBottom, c.top);
      const h = strata.hard[k];
      let ob: number;
      let ot: number;
      let sh = 1;
      if (ya >= c.top) {
        ob = ot = crestOt;
      } else {
        let lat = lateral(c.along, k, h, o);
        // Closed loops: blend into the start of the strip over the last stretch so the start line has no seam.
        if (o.wrapLen && c.along > o.wrapLen - 120) lat = THREE.MathUtils.lerp(lat, lateral(c.along - o.wrapLen, k, h, o), smoothstep(o.wrapLen - 120, o.wrapLen, c.along));
        const base = o.lean * Math.max(0, yA - c.bottom) + lat;
        if (h > 0.75) {
          ob = ot = base - 0.5;
        } else if (h < 0.3) {
          ob = base + 0.3;
          ot = base + 2.8;
          sh = 0.72;
        } else {
          ob = base + 0.2;
          ot = base + 1.0;
        }
        crestOt = ot;
      }
      const lowDim = 0.78 + 0.22 * smoothstep(0, 12, yA - c.bottom);
      pts[(row + 0) * 2] = ob;
      pts[(row + 0) * 2 + 1] = yA;
      pts[(row + 1) * 2] = ot;
      pts[(row + 1) * 2 + 1] = yB;
      shade[row] = sh * lowDim;
      shade[row + 1] = sh * (0.78 + 0.22 * smoothstep(0, 12, yB - c.bottom));
      row += 2;
    }
    const lip = c.top + o.lift;
    pts[row * 2] = crestOt + 1.2;
    pts[row * 2 + 1] = lip;
    pts[(row + 1) * 2] = Math.max(c.back, crestOt + 3);
    pts[(row + 1) * 2 + 1] = lip;
    pts[(row + 2) * 2] = Math.max(c.back, crestOt + 3) + 1.5;
    pts[(row + 2) * 2 + 1] = c.top - 4;
    shade[row] = shade[row + 1] = shade[row + 2] = 1;
  }

  // Which way is "out" relative to the column direction decides the winding.
  const mid = cols[n >> 1];
  const dx = cols[n - 1].x - cols[0].x;
  const dz = cols[n - 1].z - cols[0].z;
  const flip: 1 | -1 = -dz * mid.ox + dx * mid.oz >= 0 ? 1 : -1;
  const fallback = new THREE.Vector3(mid.ox, 0, mid.oz);

  // One 2-row grid per profile segment so the creases between faces and ledges stay sharp.
  const seg = new Float32Array(n * 2 * 3);
  const segShade = new Float32Array(n * 2);
  for (let k = 0; k < P - 1; k++) {
    for (let i = 0; i < n; i++) {
      const c = cols[i];
      // A ledge whose far end sticks out further than its near end is the underside of an overhang: darker.
      const under = k % 2 === 1 && k < layers * 2 - 1 && pts[(i * P + k + 1) * 2] < pts[(i * P + k) * 2] - 0.5 ? 0.55 : 1;
      for (let j = 0; j < 2; j++) {
        const q = (i * P + k + j) * 2;
        const off = pts[q];
        seg[(i * 2 + j) * 3] = c.x - c.ox * off;
        seg[(i * 2 + j) * 3 + 1] = pts[q + 1];
        seg[(i * 2 + j) * 3 + 2] = c.z - c.oz * off;
        segShade[i * 2 + j] = shade[i * P + k + j] * under;
      }
    }
    geo.addGrid(seg, n, 2, flip, 1, segShade, fallback);
  }
}
