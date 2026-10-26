// Sandstone cliff strips: a vertical rock face extruded along a line of columns (the canyon walls beside the track,
// the walls of a gorge). Along the strip the face is broken into sheer blocky columns with clefts between them; up the
// face the world-space strata cut it into blocks, each (column, layer) block standing in or out by its own amount, so
// the wall reads as stacked fractured blocks rather than even bands. Only now and then does a layer step back into a
// ledge or a soft layer cut back under a hard one. Some columns rise above the rim as blocky towers (`crown`), which
// makes the walls look taller and their skyline stepped. The top is a lip that runs back into the plateau behind so
// the heightfield there joins without a seam.

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
  /** Tallest tower rising above the rim (0 = flat rim). */
  crown?: number;
  seed: number;
}

/** Horizontal setback of layer k (hardness h) at `a` along the strip: pillars, clefts, wobble and flutes. */
function lateral(a: number, k: number, h: number, o: CliffOpts) {
  const u = a / o.period + 1.2 * noise1(a * 0.009, o.seed);
  const cell = Math.floor(u);
  const f = u - cell;
  // Sheer sides: the column edges turn in over a few percent of its width.
  const w = smoothstep(0.02, 0.07, f) * (1 - smoothstep(0.92, 0.97, f));
  const amp = (hash(cell + o.seed * 31) - 0.35) * o.buttress;
  // Every block of the column (one per layer) stands in or out on its own: chunky fracture blocks.
  const jb = hash(cell * 7.3 + k * 1.7 + o.seed);
  const jitter = (jb - 0.5) * 0.55 * o.buttress * w;
  const g = 0.5 + 0.5 * Math.cos((a / 6.5) * Math.PI * 2 + 3 * noise1(a * 0.05, o.seed + 7));
  return w * amp + (1 - w) * o.cleft + jitter + o.flutes * 0.35 * g * g * (h > 0.75 ? 0.4 : 1);
}

/** Extra height of the rim at `a` along the strip: some columns rise as blocky towers, flat-topped and sheer. */
function crownAt(a: number, o: CliffOpts) {
  if (!o.crown) return 0;
  const u = a / (o.period * 0.8) + 0.9 * noise1(a * 0.011, o.seed + 9);
  const cell = Math.floor(u);
  const f = u - cell;
  const hc = hash(cell * 3.7 + o.seed * 11);
  if (hc < 0.45) return 0;
  const w = smoothstep(0.04, 0.16, f) * (1 - smoothstep(0.84, 0.96, f));
  return w * o.crown * (0.3 + 0.7 * ((hc - 0.45) / 0.55));
}

export function addCliff(geo: GeoBuilder, cols: CliffColumn[], strata: Strata, o: CliffOpts) {
  const n = cols.length;
  if (n < 2) return;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const c of cols) {
    ymin = Math.min(ymin, c.bottom - 3);
    ymax = Math.max(ymax, c.top + (o.crown ?? 0));
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
    const top = c.top + crownAt(c.along, o);
    const colBottom = c.bottom - 3;
    const warp = strataWarp(c.x, c.z);
    let crestOt = 0;
    let row = i * P;
    for (let L = 0; L < layers; L++) {
      const k = k0 + L;
      const ya = L === 0 ? colBottom : strata.bottom[k] + warp;
      const yb = L === layers - 1 ? Math.max(top, strata.bottom[k + 1] + warp) : strata.bottom[k + 1] + warp;
      const yA = THREE.MathUtils.clamp(ya, colBottom, top);
      const yB = THREE.MathUtils.clamp(yb, colBottom, top);
      const h = strata.hard[k];
      let ob: number;
      let ot: number;
      let sh = 1;
      if (ya >= top) {
        ob = ot = crestOt;
      } else {
        const lat = lateral(c.along, k, h, o);
        const base = o.lean * Math.max(0, yA - c.bottom) + lat;
        // Mostly sheer faces; a soft layer under a hard one is cut back into an overhang only in some columns, and
        // a few layers step back into a ledge.
        const r = hash(k * 5.1 + Math.floor(c.along / o.period) * 1.3 + o.seed * 7);
        if (h < 0.3 && r < 0.25) {
          ob = base + 0.3;
          ot = base + 2.2;
          sh = 0.72;
        } else {
          ob = base;
          ot = base + (r > 0.88 ? 2.5 : 0.25);
        }
        crestOt = ot;
      }
      const lowDim = 0.72 + 0.28 * smoothstep(0, 28, yA - c.bottom);
      pts[(row + 0) * 2] = ob;
      pts[(row + 0) * 2 + 1] = yA;
      pts[(row + 1) * 2] = ot;
      pts[(row + 1) * 2 + 1] = yB;
      shade[row] = sh * lowDim;
      shade[row + 1] = sh * (0.72 + 0.28 * smoothstep(0, 28, yB - c.bottom));
      row += 2;
    }
    const lip = top + o.lift;
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
