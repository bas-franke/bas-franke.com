// Small deterministic noise helpers for the terrain (CPU side): hashes, 1D/2D value noise and fbm, plus the rock
// strata: horizontal layers at fixed world heights that both the cliff geometry (ledges, overhangs) and the rock shader
// (pale, mid and dark bands) use, so colour bands line up with the steps in the rock.

import { rng } from '../core/track';

export function hash(n: number) {
  const x = Math.sin(n * 12.9898 + 4.1414) * 43758.5453123;
  return x - Math.floor(x);
}

export function hash2(x: number, y: number) {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return v - Math.floor(v);
}

const smooth = (f: number) => f * f * (3 - 2 * f);

/** 1D value noise, 0..1. */
export function noise1(x: number, seed = 0) {
  const i = Math.floor(x);
  const u = smooth(x - i);
  const a = hash(i + seed * 101.7);
  const b = hash(i + 1 + seed * 101.7);
  return a + (b - a) * u;
}

/** 2D value noise, 0..1. */
export function noise2(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ux = smooth(x - ix);
  const uy = smooth(y - iy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** 2D fbm, roughly 0..1. */
export function fbm2(x: number, y: number, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x + o * 17.13, y - o * 31.71);
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Strata coordinate: integer steps of strataT(y) are layer boundaries. Monotonic (derivative > 0), layers 10-20 m thick.
 * The GLSL copy lives in terrainMaterial.ts.
 */
export function strataT(y: number) {
  return y / 14 + 0.25 * Math.sin(y * 0.11) + 0.12 * Math.sin(y * 0.27);
}

/** Gentle undulation of the strata (metres up/down by world xz) so the layers are not ruler-straight. GLSL copy in
 * terrainMaterial.ts. */
export function strataWarp(x: number, z: number) {
  return 1.8 * Math.sin(x * 0.021 + z * 0.013) + 1.1 * Math.sin(z * 0.037 - x * 0.029) + 0.5 * Math.sin(x * 0.071 + z * 0.053);
}

export const STRATA_K0 = -26;
export const STRATA_COUNT = 72;

export interface Strata {
  /** Per layer k (index k - STRATA_K0): 0 = soft dark layer, ~0.5 = regular, 1 = hard pale cap rock. */
  hard: Float32Array;
  /** World y of the bottom of layer k (index k - STRATA_K0), one extra entry for the top of the last. */
  bottom: Float32Array;
}

export function makeStrata(seed: number): Strata {
  const r = rng(seed * 13 + 5);
  const hard = new Float32Array(STRATA_COUNT);
  for (let i = 0; i < STRATA_COUNT; i++) {
    const v = r();
    // Mostly regular orange layers, with soft dark layers often sitting right under a pale hard one (overhangs).
    hard[i] = v < 0.3 ? 0.1 + r() * 0.15 : v < 0.72 ? 0.42 + r() * 0.2 : 0.82 + r() * 0.18;
  }
  const bottom = new Float32Array(STRATA_COUNT + 1);
  for (let i = 0; i <= STRATA_COUNT; i++) {
    const k = STRATA_K0 + i;
    // strataT is monotonic: bisect for the height where it equals k.
    let lo = -400;
    let hi = 600;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (strataT(mid) < k) lo = mid;
      else hi = mid;
    }
    bottom[i] = (lo + hi) / 2;
  }
  return { hard, bottom };
}

/** Layer index (k - STRATA_K0, clamped) of world height y. */
export function strataIndex(y: number) {
  return Math.min(STRATA_COUNT - 1, Math.max(0, Math.floor(strataT(y)) - STRATA_K0));
}
