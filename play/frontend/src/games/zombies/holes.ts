// Last Light bullet-hole and damage atlas: 8 x 4 cells of procedural decals, each with colour + alpha, a height field
// (turned into a tangent-space normal map) and roughness. fx.ts builds the decal material from decalAtlas() and picks
// cells through D; HOLE_INFO says which cells are tinted per instance and how big one bullet's mark should be.
//
// Tinted cells are drawn in neutral greys where 255 means "the surface's own colour" (fx multiplies the instance colour),
// so one masonry crater serves brick, plaster, concrete, marble and travertine. Self-coloured cells (blood, scorch,
// walnut, glass, ceramic, brass) carry their colour and want a white tint.
//
// Speed: ~600k pixels evaluated on the main thread at load. Noise uses a lookup table instead of sin() hashing, every
// cell returns early outside its footprint, and the pixel loop writes into one scratch record (no allocation).

import * as THREE from 'three';

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;
const CELL = 144;

export const D = {
  hole: 0,
  hole2: 1,
  wood: 2,
  metal: 3,
  blood: 4,
  blood2: 5,
  scorch: 6,
  smear: 7,
  plaster: 8,
  concrete: 9,
  marble: 10,
  travertine: 11,
  walnut: 12,
  glass: 13,
  glass2: 14,
  fabric: 15,
  leather: 16,
  ceramic: 17,
  brass: 18,
  brassHole: 19,
  plaster2: 20,
  wood2: 21,
  crack: 22,
  graze: 23,
  marble2: 24,
  concrete2: 25,
  fabric2: 26,
  metal2: 27,
  dust: 28,
  scorch2: 29,
  blood3: 30,
  ash: 31,
} as const;
export type HoleKind = keyof typeof D;

/**
 * Per cell: `tinted` = drawn neutral, multiply by the surface colour (fabric/leather read best with the colour lerped
 * ~30% towards white so the foam and tufts stay pale); otherwise the cell has its own colour and wants a white tint.
 * `size` = recommended world size range in metres for a single bullet (scorch/ash/blood: one splash or blast).
 * `graze` is meant to be stretched (DecalPool stretch 2-3) for glancing hits.
 */
export const HOLE_INFO: Record<HoleKind, { tinted: boolean; size: [number, number] }> = {
  hole: { tinted: true, size: [0.07, 0.11] },
  hole2: { tinted: true, size: [0.07, 0.11] },
  wood: { tinted: true, size: [0.07, 0.1] },
  metal: { tinted: true, size: [0.045, 0.065] },
  blood: { tinted: false, size: [0.15, 0.4] },
  blood2: { tinted: false, size: [0.15, 0.4] },
  scorch: { tinted: false, size: [1.6, 3.4] },
  smear: { tinted: false, size: [0.15, 0.5] },
  plaster: { tinted: true, size: [0.11, 0.17] },
  concrete: { tinted: true, size: [0.09, 0.14] },
  marble: { tinted: true, size: [0.07, 0.11] },
  travertine: { tinted: true, size: [0.08, 0.12] },
  walnut: { tinted: false, size: [0.07, 0.1] },
  glass: { tinted: false, size: [0.18, 0.32] },
  glass2: { tinted: false, size: [0.22, 0.4] },
  fabric: { tinted: true, size: [0.07, 0.1] },
  leather: { tinted: true, size: [0.06, 0.09] },
  ceramic: { tinted: false, size: [0.06, 0.1] },
  brass: { tinted: false, size: [0.04, 0.06] },
  brassHole: { tinted: false, size: [0.045, 0.065] },
  plaster2: { tinted: true, size: [0.11, 0.17] },
  wood2: { tinted: true, size: [0.09, 0.14] },
  crack: { tinted: true, size: [0.2, 0.4] },
  graze: { tinted: true, size: [0.06, 0.09] },
  marble2: { tinted: true, size: [0.07, 0.11] },
  concrete2: { tinted: true, size: [0.09, 0.14] },
  fabric2: { tinted: true, size: [0.1, 0.15] },
  metal2: { tinted: true, size: [0.045, 0.065] },
  dust: { tinted: true, size: [0.18, 0.3] },
  scorch2: { tinted: false, size: [0.3, 1] },
  blood3: { tinted: false, size: [0.3, 0.6] },
  ash: { tinted: false, size: [0.4, 1.2] },
};

// ---- noise (table based) --------------------------------------------------------------------------------------------

const RT = new Float32Array(65536);
{
  let s = 0x2f6b1d3;
  for (let i = 0; i < RT.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    RT[i] = (s >>> 8) / 16777216;
  }
}
/** Lattice random in [0, 1) for integer-ish coordinates (fractions are truncated). */
const hash = (x: number, y: number) => RT[(((y | 0) & 255) << 8) | ((x | 0) & 255)];
function vnoise(x: number, y: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, oct = 3) {
  let s = 0;
  let a = 0.5;
  for (let i = 0; i < oct; i++) {
    s += vnoise(x, y) * a;
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 3.7;
    a *= 0.5;
  }
  return s;
}
/** Noise around a circle (seamless in angle). */
const anoise = (ang: number, f: number, seed: number) => vnoise(Math.cos(ang) * f + seed * 7.3 + 40, Math.sin(ang) * f + seed * 3.1 + 40);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---- shared shapes --------------------------------------------------------------------------------------------------

/** A star of radial cracks: angles + reach, evaluated as tapered wiggly lines from the centre. */
interface Rays {
  ang: Float32Array;
  cos: Float32Array;
  sin: Float32Array;
  len: Float32Array;
  max: number;
  w: number;
  wig: number;
  seed: number;
}
function makeRays(seed: number, n: number, reach: number, w: number, jitter = 0.7, wig = 0.36): Rays {
  const ang = new Float32Array(n);
  const len = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ang[i] = ((i + (hash(i * 7 + 3, seed * 31) - 0.5) * jitter) / n) * Math.PI * 2 - Math.PI;
    len[i] = reach * (0.45 + hash(i * 5 + 1, seed * 17 + 5) * 0.55);
  }
  return { ang, len, max: Math.max(...len), w, wig, seed, cos: ang.map(Math.cos), sin: ang.map(Math.sin) };
}
/** 0..1 crack intensity at (u, v) in half-cell units (radius 1 = cell edge). */
function rays(R: Rays, u: number, v: number, r: number) {
  if (r > R.max) return 0;
  let best = 0;
  for (let i = 0; i < R.ang.length; i++) {
    const L = R.len[i];
    if (r > L) continue;
    const along = u * R.cos[i] + v * R.sin[i];
    if (along <= 0) continue;
    const p0 = -u * R.sin[i] + v * R.cos[i];
    if (Math.abs(p0) > R.w + R.wig * 0.5 * along) continue;
    // Wiggle sideways along the crack; width tapers to a hairline at the tip.
    const perp = p0 - (vnoise(along * 9 + i * 13.7, R.seed + i) - 0.5) * R.wig * along;
    const w = R.w * (1 - (r / L) * 0.75);
    const k = 1 - Math.abs(perp) / w;
    if (k > best) best = k;
  }
  return best;
}
/** Distance to a wiggly crack segment from (x0, y0) in direction a over len (for branching networks). */
function seg(u: number, v: number, x0: number, y0: number, ca: number, sa: number, len: number, w: number, seed: number) {
  const dx = u - x0;
  const dy = v - y0;
  const along = dx * ca + dy * sa;
  if (along < 0 || along > len) return 0;
  const perp = -dx * sa + dy * ca - (fbm(along * 7 + seed, seed * 3, 2) - 0.5) * 0.12;
  const t = along / len;
  return clamp01(1 - Math.abs(perp) / (w * (1 - t * 0.8)));
}

// ---- cell painters --------------------------------------------------------------------------------------------------

/** Output of one pixel: colour 0-255, alpha 0-255, height ~-1..1, roughness 0-255. */
const O = { r: 0, g: 0, b: 0, a: 0, h: 0, ro: 255 };
function P(r: number, g: number, b: number, a: number, h: number, ro: number) {
  O.r = r;
  O.g = g;
  O.b = b;
  O.a = a;
  O.h = h;
  O.ro = ro;
}
/** u, v in -0.5..0.5 (v down), x, y = pixel coordinates offset per cell (for noise). */
type Fn = (u: number, v: number, x: number, y: number) => void;

interface Crater {
  seed: number;
  bore: number; // radius of the dark bore (radius 1 = cell edge)
  crater: number;
  halo: number;
  haloA: number;
  haloL: number;
  inL: number;
  outL: number;
  nl: number;
  facets: number;
  ro: number;
  tone?: [number, number, number];
  cracks?: Rays;
  crackA?: number;
  paint?: boolean;
  conch?: boolean;
  star?: number;
  aggregate?: boolean;
  pores?: boolean;
}

/** Stone-like crater: bore, faceted chipped cone, dust halo, optional cracks / paint layers / aggregate / pores. */
function crater(o: Crater): Fn {
  const s = o.seed;
  const tone = o.tone ?? [1, 0.97, 0.93];
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    const crack = o.cracks ? rays(o.cracks, u * 2, v * 2, r) : 0;
    if (r > o.halo && crack <= 0) return;
    const ang = Math.atan2(v, u);
    const j = 0.8 + anoise(ang, 2.5, s) * 0.42 + (vnoise(x / 7, y / 7) - 0.5) * 0.18;
    const bore = o.bore * (0.85 + anoise(ang, 4, s + 3) * 0.3);
    const cr = o.crater * j;
    const n = fbm(x / 6 + s * 9, y / 6, 3);
    let l = 0;
    let a = 0;
    let h = 0;
    let ro = 255;
    if (r < bore) {
      const k = r / bore;
      l = 6 + k * k * 34;
      a = 255;
      h = -1.15 + k * k * 0.4;
      ro = 235;
    } else if (r < cr) {
      const k = (r - bore) / (cr - bore);
      // Flat chipped planes: quantised angular noise steps the height and the shading.
      const f = Math.floor(vnoise(ang * 2.2 + s * 5, k * 2.4 + s) * 4) / 3;
      l = o.inL + (o.outL - o.inL) * k + (n - 0.5) * o.nl + (f - 0.5) * 46 * o.facets;
      h = -0.8 + Math.pow(k, 0.75) * 0.82 + (n - 0.5) * 0.22 + (f - 0.5) * 0.32 * o.facets;
      a = 255;
      ro = o.ro;
      if (o.paint && k > 0.7) {
        // Paint skim and plaster coats show as stepped bands at the rim.
        const b = (k - 0.7) / 0.3 + (n - 0.5) * 0.25;
        if (b > 0.72) {
          l = 246;
          h += 0.14;
          ro = 200;
        } else if (b > 0.42) {
          l = 212 + n * 20;
          h += 0.07;
        }
      }
      if (o.conch) {
        // Conchoidal fracture: shell-like ripples, glassy.
        const rip = Math.sin(k * 20 + n * 4 + anoise(ang, 3, s + 9) * 6);
        h += rip * 0.07;
        l += rip * 14;
        ro = 150 + k * 60;
      }
      if (o.aggregate) {
        // Gravel in the cement: jittered grid of stones, raised and in their own tones.
        const gs = 13;
        const gx = Math.floor(x / gs);
        const gy = Math.floor(y / gs);
        let best = 9;
        let id = 0;
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++) {
            const hx = gx + ox;
            const hy = gy + oy;
            const hr = hash(hx * 3 + 11, hy * 5 + s);
            if (hr < 0.35) continue;
            const cx = (hx + 0.2 + hash(hx, hy + 91) * 0.6) * gs;
            const cy = (hy + 0.2 + hash(hx + 53, hy) * 0.6) * gs;
            const d = Math.hypot(x - cx, y - cy) / (gs * (0.3 + hr * 0.32));
            if (d < best) {
              best = d;
              id = hr;
            }
          }
        if (best < 1) {
          l = 70 + id * 130 + n * 20;
          h += (1 - best * best) * 0.4;
          ro = 205;
        }
      }
    } else if (r < o.halo) {
      const k = (r - cr) / (o.halo - cr);
      a = (1 - k) * (1 - k) * o.haloA * (0.5 + n * 0.7);
      l = o.haloL + n * 40;
      h = (1 - k) * 0.06;
      ro = 250;
    }
    if (o.pores && a > 0 && r >= bore) {
      const p = fbm(x / 3.2 + s * 4, y / 3.2, 2);
      if (p < 0.3) {
        const d = (0.3 - p) / 0.3;
        l *= 1 - d * 0.7;
        h -= d * 0.5;
        a = Math.max(a, 255 * d);
      }
    }
    if (o.star && r < cr * 1.5 && r >= bore * 0.8) {
      // White crushed bruise around the impact, star-shaped.
      const st = Math.pow(Math.abs(Math.cos((ang * o.star) / 2 + s)), 5);
      const sb = clamp01(1 - r / (bore * (1.8 + st * 3.2)));
      l += (252 - l) * sb;
      a = Math.max(a, sb * 255);
      h += sb * 0.12;
      ro = Math.max(ro, 230 * sb);
    }
    if (crack > 0 && r >= bore) {
      l = (a > 0 ? l : 60) * (1 - crack * 0.65);
      a = Math.max(a, crack * (o.crackA ?? 220));
      h -= crack * 0.35;
    }
    P(l * tone[0], l * tone[1], l * tone[2], a, h, ro);
  };
}

/** Wood: bore, fibres torn along the grain (vertical). Exit holes splinter outwards and stand up. */
function woodHole(seed: number, exit: boolean, own?: { dark: [number, number, number]; pale: [number, number, number] }): Fn {
  return (u, v, x, y) => {
    const r = Math.hypot(u * 1.5, v * 0.72) * 2;
    const grain = fbm(x / 2.6, y / 38 + seed, 3);
    const sf = (u + 0.5) * 34;
    const strip = Math.floor(sf);
    const sl = hash(strip * 3 + 7, seed * 11);
    // Each fibre tears off to a point.
    const reach = ((exit ? 0.22 : 0.12) + sl * (exit ? 0.26 : 0.2)) * (1 - Math.abs(sf - strip - 0.5) * 0.7);
    const sw = (exit ? 0.17 : 0.1) * (0.6 + grain * 0.8);
    const splinter = Math.abs(u) < sw && Math.abs(v) < reach && sl > 0.3;
    const bore = (exit ? 0.2 : 0.13) * (0.85 + anoise(Math.atan2(v, u), 3, seed) * 0.3);
    const torn = (exit ? 0.5 : 0.36) * (0.8 + grain * 0.4);
    if (r > 0.75 && !splinter) return;
    const pale = own?.pale ?? [1, 0.85, 0.66];
    if (r < bore) {
      P(14, 9, 6, 255, -1.1 + (r / bore) ** 2 * 0.3, 225);
      return;
    }
    if (r < torn || splinter) {
      const fib = Math.sin(u * 220 + grain * 9) * 0.5 + 0.5;
      const l = 150 + grain * 70 + fib * 25;
      const k = Math.min(1, r / torn);
      let h = exit ? 0.15 + (1 - Math.abs(v) / Math.max(reach, 0.01)) * 0.55 * sl + fib * 0.15 : -0.45 + k * 0.4 + fib * 0.12;
      if (splinter && r >= torn) h += exit ? 0.25 : 0.05;
      const pr = own ? pale[0] * 255 : l;
      P(own ? pr * (0.85 + fib * 0.15) : l * pale[0], own ? pale[1] * 255 * (0.85 + fib * 0.15) : l * pale[1], own ? pale[2] * 255 * (0.85 + fib * 0.15) : l * pale[2], 255, h, 235);
      return;
    }
    const k = (r - torn) / (0.75 - torn);
    const a = (1 - k) * (1 - k) * 150;
    const d = own?.dark;
    if (d) {
      // Lacquer flakes: small angular chips of glossy finish lifted around the hole.
      const fl = fbm(x / 7 + seed * 5, y / 5, 2) - k * 0.25;
      if (fl > 0.5) {
        // Edge of the flake catches the light; the bare wood under it shows pale.
        const e = fl > 0.54 ? 1.9 : 3.2;
        P(d[0] * e, d[1] * e, d[2] * e, 235, fl > 0.54 ? 0.3 : 0.15, 30);
        return;
      }
      P(d[0], d[1], d[2], a, -0.05 * (1 - k), 60);
      return;
    }
    P(70, 52, 36, a, -0.08 * (1 - k), 240);
  };
}

/** Metal dent: polished crater, a pinhole, a raised lip and a scuffed ring. `tone` != null = own colour. */
function dent(seed: number, tone: [number, number, number] | null): Fn {
  const t = tone ?? [1, 1, 1.02];
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    if (r > 0.66) return;
    const n = fbm(x / 5 + seed, y / 5, 3);
    if (r < 0.085) {
      P(tone ? 40 : 20, tone ? 28 : 20, tone ? 12 : 22, 255, -0.9, 120);
      return;
    }
    if (r < 0.4) {
      const k = r / 0.4;
      const l = 235 - k * 55 + n * 20;
      P(l * t[0], l * t[1], l * t[2], 255, -(1 - k) * (1 - k) * 0.9, 40 + k * 50);
      return;
    }
    if (r < 0.48) {
      // Polished, raised lip pushed up around the dent.
      const k = (r - 0.4) / 0.08;
      const l = 255;
      P(l * t[0], l * t[1], l * t[2], 255, Math.sin(k * Math.PI) * 0.35, 25);
      return;
    }
    const k = (r - 0.48) / 0.18;
    const sc = Math.pow(vnoise(Math.atan2(v, u) * 14 + seed, r * 40), 2);
    P(205 * t[0], 205 * t[1], 205 * t[2], (1 - k) * (tone ? 90 : 170) * (0.4 + sc), 0, 80);
  };
}

/** Pierced sheet: a dark hole with jagged petals bent outwards (raised, bright). */
function petals(seed: number, tone: [number, number, number] | null): Fn {
  const t = tone ?? [1, 1, 1.02];
  const N = 6;
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    if (r > 0.7) return;
    const ang = Math.atan2(v, u);
    const n = fbm(x / 5 + seed, y / 5, 2);
    const sec = ((ang + Math.PI) / (Math.PI * 2)) * N + hash(seed, 3);
    const si = Math.floor(sec);
    const tt = (sec - si) * 2 - 1; // -1..1 across the petal
    const len = 0.22 + hash(si + seed * 7, 9) * 0.18;
    const hole = 0.14 * (0.85 + anoise(ang, 5, seed) * 0.3);
    const tip = hole + len * (1 - Math.pow(Math.abs(tt), 1.6));
    if (r < hole) {
      P(5, 5, 6, 255, -1.2, 240);
      return;
    }
    if (r < tip && Math.abs(tt) < 0.88) {
      const k = (r - hole) / (tip - hole);
      const l = 170 + (1 - Math.abs(tt)) * 70 + n * 20 - k * 30;
      // Bent outwards: rises from the hole, curls over at the torn tip; the fold catches light.
      P(l * t[0], l * t[1], l * t[2], 255, 0.25 + Math.sin(k * Math.PI * 0.8) * 0.75 - Math.abs(tt) * 0.3, 35 + k * 40);
      return;
    }
    if (r < tip + 0.03 && Math.abs(tt) < 0.95) {
      P(30 * t[0], 30 * t[1], 30 * t[2], 220, 0, 120);
      return;
    }
    const k = clamp01((r - hole - 0.2) / 0.5);
    const sc = Math.pow(vnoise(ang * 16 + seed, r * 30), 2);
    P(190 * t[0], 190 * t[1], 190 * t[2], (1 - k) * 160 * (0.3 + sc), -0.04 * (1 - k), 70);
  };
}

/** Glass: a clean core, a frosted crushed ring, radial cracks and polygonal concentric rings between them. */
function glass(seed: number, n: number, rings: number[], crush: number): Fn {
  const R = makeRays(seed, n, 1.0, 0.018, 0.5, 0.12);
  // Sorted angles for sector lookup (rays are built in order already).
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    const ang = Math.atan2(v, u);
    const core = 0.075 * (0.85 + anoise(ang, 4, seed) * 0.3);
    if (r < core) {
      P(30, 34, 36, 40, -0.6, 10);
      return;
    }
    if (r < core + 0.03) {
      P(40, 46, 50, 210, -0.3, 40);
      return;
    }
    let line = rays(R, u * 2, v * 2, r);
    // Ring chords between neighbouring rays.
    let i = 0;
    while (i < n - 1 && ang >= R.ang[i + 1]) i++;
    const wrap = ang < R.ang[0];
    if (wrap) i = n - 1;
    const a0 = wrap ? R.ang[n - 1] - Math.PI * 2 : R.ang[i];
    const a1 = wrap ? R.ang[0] : i === n - 1 ? R.ang[0] + Math.PI * 2 : R.ang[i + 1];
    const mid = (a0 + a1) / 2;
    const half = (a1 - a0) / 2;
    const reff = r * Math.cos(ang - mid);
    // A ring segment only spans between two cracks that both reach it.
    const reach = Math.min(R.len[i], R.len[(i + 1) % n]);
    for (let k = 0; k < rings.length; k++) {
      const rr = rings[k] * (0.88 + hash(i + 3, k + seed) * 0.24);
      if (rr > reach || hash(i * 13 + k * 7, seed) < 0.25) continue;
      const rk = rr * Math.cos(half);
      const lk = 1 - Math.abs(reff - rk) / 0.014;
      if (lk > line) line = lk;
    }
    const frost = r < crush ? (1 - r / crush) * (0.55 + fbm(x / 2.2, y / 2.2, 2) * 0.6) : 0;
    if (line <= 0 && frost <= 0) return;
    const sparkle = vnoise(x / 1.6, y / 1.6);
    if (line > 0 && line >= frost) {
      // Bright refracting line, ridge in the height so the normal map flips across it.
      P(225, 240, 250, 90 + line * 160, line * 0.7, 15);
      return;
    }
    P(235, 240, 242, frost * 190, (sparkle - 0.5) * 0.5 * frost, 255);
  };
}

/** Upholstery: torn hole with frayed threads, foam inside, a faint scorch ring. */
function fabric(seed: number): Fn {
  const T = makeRays(seed, 26, 0.62, 0.016, 0.9);
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    if (r > 0.7) return;
    const ang = Math.atan2(v, u);
    const hole = 0.2 * (0.7 + anoise(ang, 6, seed) * 0.6);
    if (r < hole) {
      const k = r / hole;
      const pore = fbm(x / 1.8, y / 1.8, 2);
      const l = k < 0.4 ? 45 + k * 200 : 200 + pore * 50;
      P(l, l * 0.98, l * 0.9, 255, -0.9 + k * 0.5 + (pore - 0.5) * 0.3, 255);
      return;
    }
    const th = rays(T, u * 2, v * 2, r);
    if (th > 0.2 && r < 0.62) {
      const l = 175 + th * 60;
      P(l, l, l, 255, 0.2 + th * 0.2, 250);
      return;
    }
    const k = (r - hole) / (0.7 - hole);
    const n = fbm(x / 5 + seed, y / 5, 2);
    P(25, 22, 20, (1 - k) * (1 - k) * 110 * (0.4 + n), -0.05, 255);
  };
}

/** Upholstery burst: a torn flap folded down and white tufts of stuffing around a big hole. */
function fabricBurst(seed: number): Fn {
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    if (r > 0.95) return;
    const ang = Math.atan2(v, u);
    const hole = 0.26 * (0.7 + anoise(ang, 5, seed) * 0.6);
    // Flap hanging down from the hole's lower edge (v grows downwards).
    const fv = v - 0.1;
    const fw = 0.2 * (1 - fv / 0.3) + (vnoise(x / 6, y / 6) - 0.5) * 0.04;
    if (fv > 0 && fv < 0.3 && Math.abs(u) < fw) {
      const e = 1 - Math.abs(u) / fw;
      // The flap's torn edge (top) is shadowed where it folds; the weave shows as fine ribs.
      const rib = Math.sin(x * 1.3) * 0.5 + 0.5;
      const l = 150 + Math.min(1, e * 3) * 60 + rib * 15 - (fv < 0.035 ? 80 : 0);
      P(l, l, l, 255, 0.3 + Math.min(1, e * 3) * 0.3 - fv * 0.8, 245);
      return;
    }
    // Stuffing: a few soft clumps bursting out of the hole.
    const tuft = fbm(x / 13 + seed * 3, y / 13, 3) + (0.42 - r) * 0.5;
    if (r < 0.55 && tuft > 0.56) {
      const k = clamp01((tuft - 0.56) * 6);
      const l = 228 + k * 27 - fbm(x / 2.5, y / 2.5, 2) * 25;
      P(l, l, l * 0.98, 255, 0.15 + k * 0.7, 255);
      return;
    }
    if (r < hole) {
      const k = r / hole;
      P(30 + k * 120, 28 + k * 118, 26 + k * 105, 255, -1 + k * 0.6, 255);
      return;
    }
    const k = (r - hole) / (0.95 - hole);
    P(30, 28, 26, (1 - k) * (1 - k) * 70, 0, 255);
  };
}

/** Leather puncture: a 3-4 point star tear, glossy curled edges, foam inside. */
function leather(seed: number, points: number): Fn {
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    if (r > 0.6) return;
    const ang = Math.atan2(v, u) + seed;
    const st = Math.pow(Math.abs(Math.cos((ang * points) / 2)), 10);
    const tear = 0.08 + st * 0.24 + (anoise(ang, 6, seed) - 0.5) * 0.04;
    if (r < tear) {
      const k = r / tear;
      const pore = fbm(x / 1.8, y / 1.8, 2);
      const l = k < 0.35 ? 30 + k * 300 : 190 + pore * 50;
      P(l, l * 0.97, l * 0.88, 255, -0.85 + k * 0.4 + (pore - 0.5) * 0.25, 250);
      return;
    }
    if (r < tear + 0.07) {
      // Curled lip: rolls up out of the surface, highlight on the crest.
      const k = (r - tear) / 0.07;
      const crest = Math.sin(k * Math.PI);
      const l = 150 + crest * 105;
      P(l, l, l, 255, crest * 0.7, 30);
      return;
    }
    const k = (r - tear - 0.07) / (0.6 - tear - 0.07);
    P(40, 36, 34, (1 - k) * (1 - k) * 90, -(1 - k) * 0.12, 70);
  };
}

/** Ceramic: glaze chipped off showing white biscuit, a few cracks, a glossy glaze lip. */
function ceramic(seed: number): Fn {
  const R = makeRays(seed, 5, 0.95, 0.014);
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    const crack = rays(R, u * 2, v * 2, r);
    if (r > 0.5 && crack <= 0) return;
    const ang = Math.atan2(v, u);
    const cr = 0.36 * (0.75 + anoise(ang, 3, seed) * 0.5);
    if (r < 0.06) {
      P(70, 66, 60, 255, -0.8, 235);
      return;
    }
    if (r < cr) {
      const k = r / cr;
      const f = Math.floor(vnoise(ang * 2.5 + seed, k * 2) * 4) / 3;
      const l = 222 + f * 22 + (fbm(x / 3, y / 3, 2) - 0.5) * 18;
      P(l, l * 0.98, l * 0.94, 255, -0.6 + k * 0.6 + (f - 0.5) * 0.25, 235);
      return;
    }
    if (r < cr + 0.035) {
      const k = (r - cr) / 0.035;
      P(255, 255, 255, 130 * (1 - k), 0.2 * (1 - k), 8);
      return;
    }
    if (crack > 0) P(70, 64, 58, crack * 210, -crack * 0.3, 60);
  };
}

/** A hairline crack network with branches, no hole. */
function crackNet(seed: number): Fn {
  const main = { a: hash(seed, 1) * Math.PI };
  const ca = Math.cos(main.a);
  const sa = Math.sin(main.a);
  const br: number[][] = [];
  for (let i = 0; i < 6; i++) {
    const t = (hash(i, seed + 3) - 0.5) * 0.7;
    const a = main.a + (hash(i, seed + 7) < 0.5 ? 1 : -1) * (0.5 + hash(i, seed + 9) * 0.7);
    br.push([ca * t, sa * t, Math.cos(a), Math.sin(a), 0.12 + hash(i, seed + 11) * 0.22]);
  }
  return (u, v) => {
    const r = Math.hypot(u, v) * 2;
    if (r > 0.98) return;
    let c = seg(u, v, -ca * 0.46, -sa * 0.46, ca, sa, 0.92, 0.012, seed);
    for (const b of br) c = Math.max(c, seg(u, v, b[0], b[1], b[2], b[3], b[4], 0.008, seed + b[4] * 50));
    if (c <= 0) return;
    P(35, 33, 31, c * 230 * (1 - r * 0.4), -c * 0.4, 200);
  };
}

/** Glancing hit: a gouge along v with raised lips, scratches and a dust fan at the far end. */
function graze(seed: number): Fn {
  return (u, v, x, y) => {
    const t = (v + 0.42) / 0.84; // 0 at entry, 1 at exit
    if (t < 0 || t > 1.1) return;
    const w = 0.13 * Math.sin(Math.min(1, t) * Math.PI * 0.9 + 0.15) * (0.85 + vnoise(y / 10, seed) * 0.3);
    const uu = Math.abs(u);
    const n = fbm(x / 4 + seed, y / 9, 2);
    if (uu < w) {
      const k = uu / w;
      const scr = Math.sin(u * 300 + n * 6) * 0.5 + 0.5;
      const l = 110 + k * 70 + n * 40 + scr * 20;
      P(l, l * 0.98, l * 0.95, 255, -0.75 * (1 - k * k) * Math.min(1, t * 4) + scr * 0.06, 220);
      return;
    }
    if (uu < w + 0.035) {
      const k = (uu - w) / 0.035;
      const l = 200 + n * 40;
      P(l, l, l, 230 * (1 - k), Math.sin((1 - k) * Math.PI * 0.5) * 0.35, 245);
      return;
    }
    if (t > 0.65) {
      const fan = 1 - uu / (0.06 + (t - 0.65) * 0.7);
      if (fan > 0) P(200, 197, 192, fan * 80 * (0.4 + n), 0.02, 250);
    }
  };
}

function blood(seed: number): Fn {
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    const ang = Math.atan2(v, u);
    const edge = 0.45 + fbm(Math.cos(ang) * 2 + seed + 20, Math.sin(ang) * 2 + seed + 20, 4) * 0.45 + Math.pow(Math.max(0, Math.sin(ang * 5 + seed * 3)), 16) * 0.14 * (0.5 + vnoise(ang * 3 + 20, seed));
    let a = r < edge ? 1 : 0;
    // Satellite drops.
    if (!a) {
      const gx = Math.floor((u + 0.5) * 14);
      const gy = Math.floor((v + 0.5) * 14);
      const h = hash(gx + seed * 13, gy);
      if (h > 0.86 && r < 0.98) {
        const cx = (gx + 0.5) / 14 - 0.5;
        const cy = (gy + 0.5) / 14 - 0.5;
        if (Math.hypot(u - cx, v - cy) < 0.012 + (h - 0.86) * 0.25) a = 1;
      }
    }
    if (!a) return;
    const n = fbm(x / 12, y / 12, 3);
    const depth = Math.min(1, (edge - r) * 4);
    P(70 + n * 30 - depth * 25, 4 + n * 4, 4, 235, 0.15 + depth * 0.2, 35 + n * 40);
  };
}

/** Fine mist spatter: many tiny droplets, denser towards the centre. */
function mist(seed: number): Fn {
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    if (r > 0.98) return;
    const dens = (1 - r) * (1 - r);
    for (let s = 0; s < 2; s++) {
      const g = s ? 46 : 22;
      const gx = Math.floor((u + 0.5) * g);
      const gy = Math.floor((v + 0.5) * g);
      const h = hash(gx + seed * 17 + s * 101, gy + s * 57);
      if (h < 1 - dens * (s ? 0.9 : 0.55)) continue;
      const cx = (gx + 0.2 + hash(gx + 9, gy + s) * 0.6) / g - 0.5;
      const cy = (gy + 0.2 + hash(gx, gy + 13 + s) * 0.6) / g - 0.5;
      const rad = (0.15 + hash(gx + 31, gy + 7) * 0.3) / g;
      const d = Math.hypot(u - cx, v - cy) / rad;
      if (d < 1) {
        P(85 - d * 20, 5, 5, 235, 0.12 * (1 - d), 40);
        return;
      }
    }
  };
}

function scorch(seed: number, streaks: boolean): Fn {
  return (u, v, x, y) => {
    const r = Math.hypot(u, v) * 2;
    if (r > 1) return;
    const n = fbm(x / 18 + seed, y / 18, 4);
    let k = Math.max(0, 1 - r * (0.9 + (0.5 - n) * 0.8));
    if (streaks) {
      // Powder burn: streaks fanning out plus unburnt grains peppered around.
      const st = Math.pow(anoise(Math.atan2(v, u), 9, seed), 2);
      k = Math.max(0, 1 - r * (1.3 - st * 0.6)) * (0.55 + st * 0.6);
      if (hash(Math.floor(x / 3), Math.floor(y / 3) + seed) > 0.93 && r < 0.8) k = Math.max(k, 0.9);
    }
    if (k <= 0) return;
    const l = 8 + (1 - k) * 25 + n * 10;
    P(l, l * 0.95, l * 0.9, Math.min(1, k * 1.6) * 235, -k * 0.15, 250);
  };
}

const PAINTERS: Fn[] = [];
PAINTERS[D.hole] = crater({ seed: 1.3, bore: 0.12, crater: 0.42, halo: 0.95, haloA: 105, haloL: 160, inL: 60, outL: 145, nl: 45, facets: 0.8, ro: 245, cracks: makeRays(1, 4, 0.8, 0.02) });
PAINTERS[D.hole2] = crater({ seed: 7.9, bore: 0.11, crater: 0.46, halo: 0.95, haloA: 110, haloL: 165, inL: 55, outL: 150, nl: 50, facets: 1, ro: 245 });
PAINTERS[D.wood] = woodHole(2, false);
PAINTERS[D.metal] = dent(3, null);
PAINTERS[D.blood] = blood(2.1);
PAINTERS[D.blood2] = blood(5.7);
PAINTERS[D.scorch] = scorch(0, false);
PAINTERS[D.smear] = (u, v, x, y) => {
  const w = 0.18 * (1 - Math.abs(v) * 1.6) + fbm(x / 30, y / 8, 3) * 0.06;
  if (!(Math.abs(u - 0.05 * Math.sin(v * 9)) < w && Math.abs(v) < 0.46)) return;
  P(60 + fbm(x / 10, y / 10, 3) * 30, 3, 3, 220, 0.2, 40);
};
PAINTERS[D.plaster] = crater({ seed: 3.3, bore: 0.09, crater: 0.5, halo: 1, haloA: 210, haloL: 235, inL: 175, outL: 238, nl: 30, facets: 0.4, ro: 252, paint: true, tone: [1, 0.99, 0.97] });
PAINTERS[D.concrete] = crater({ seed: 4.4, bore: 0.12, crater: 0.48, halo: 0.9, haloA: 95, haloL: 150, inL: 70, outL: 135, nl: 55, facets: 0.9, ro: 248, aggregate: true, tone: [1, 1, 0.98] });
PAINTERS[D.marble] = crater({ seed: 5.5, bore: 0.07, crater: 0.38, halo: 0.75, haloA: 80, haloL: 235, inL: 175, outL: 225, nl: 25, facets: 0.7, ro: 170, conch: true, star: 5, cracks: makeRays(5, 5, 0.95, 0.012), crackA: 170, tone: [1, 1, 1] });
PAINTERS[D.travertine] = crater({ seed: 6.6, bore: 0.11, crater: 0.42, halo: 0.85, haloA: 90, haloL: 200, inL: 110, outL: 190, nl: 40, facets: 0.8, ro: 240, pores: true, tone: [1, 0.98, 0.95] });
PAINTERS[D.walnut] = woodHole(12, false, { dark: [38, 22, 12], pale: [0.86, 0.7, 0.5] });
PAINTERS[D.glass] = glass(13, 11, [0.32, 0.55, 0.8], 0.24);
PAINTERS[D.glass2] = glass(14, 6, [0.5], 0.3);
PAINTERS[D.fabric] = fabric(15);
PAINTERS[D.leather] = leather(16, 4);
PAINTERS[D.ceramic] = ceramic(17);
PAINTERS[D.brass] = dent(18, [1, 0.8, 0.45]);
PAINTERS[D.brassHole] = petals(19, [1, 0.8, 0.45]);
PAINTERS[D.plaster2] = crater({ seed: 20.2, bore: 0.1, crater: 0.56, halo: 1, haloA: 190, haloL: 232, inL: 165, outL: 235, nl: 35, facets: 0.6, ro: 252, paint: true, cracks: makeRays(20, 3, 0.9, 0.016), crackA: 160, tone: [1, 0.99, 0.97] });
PAINTERS[D.wood2] = woodHole(21, true);
PAINTERS[D.crack] = crackNet(22);
PAINTERS[D.graze] = graze(23);
PAINTERS[D.marble2] = crater({ seed: 24.4, bore: 0.06, crater: 0.34, halo: 0.7, haloA: 70, haloL: 240, inL: 185, outL: 230, nl: 22, facets: 1, ro: 160, conch: true, star: 3, cracks: makeRays(24, 3, 1, 0.012), crackA: 170, tone: [1, 1, 1] });
PAINTERS[D.concrete2] = crater({ seed: 25.5, bore: 0.14, crater: 0.55, halo: 0.95, haloA: 100, haloL: 145, inL: 65, outL: 130, nl: 60, facets: 1, ro: 248, aggregate: true, cracks: makeRays(25, 3, 0.85, 0.02), tone: [1, 1, 0.98] });
PAINTERS[D.fabric2] = fabricBurst(26);
PAINTERS[D.metal2] = petals(27, null);
PAINTERS[D.dust] = (u, v, x, y) => {
  const r = Math.hypot(u, v) * 2;
  if (r > 0.98) return;
  const n = fbm(x / 7 + 28, y / 7, 3);
  const ring = Math.exp(-(((r - 0.5) / 0.2) ** 2));
  const a = (ring * 190 + (1 - r) * 60) * (0.4 + n * 0.8);
  P(205 + n * 40, 202 + n * 40, 196 + n * 38, a, ring * 0.05, 252);
};
PAINTERS[D.scorch2] = scorch(29, true);
PAINTERS[D.blood3] = mist(30);
PAINTERS[D.ash] = (u, v, x, y) => {
  const r = Math.hypot(u, v) * 2;
  if (r > 1) return;
  const n = fbm(x / 14 + 31, y / 14, 4);
  const k = Math.max(0, 1 - r * (1 + (0.5 - n) * 1.4));
  if (k <= 0) return;
  const l = 22 + n * 25;
  P(l, l * 0.97, l * 0.94, Math.min(1, k * 1.3) * 200 * (0.6 + n * 0.5), 0, 255);
};

// ---- assembly -------------------------------------------------------------------------------------------------------

/** Raw atlas pixels: colour RGBA, normal RGBA, roughness RGBA, all W x H (top row first). */
export function atlasPixels() {
  const W = CELL * ATLAS_COLS;
  const H = CELL * ATLAS_ROWS;
  const col = new Uint8ClampedArray(W * H * 4);
  const height = new Float32Array(W * H);
  const rough = new Uint8ClampedArray(W * H * 4);
  for (let cell = 0; cell < ATLAS_COLS * ATLAS_ROWS; cell++) {
    const fn = PAINTERS[cell];
    const cx = (cell % ATLAS_COLS) * CELL;
    const cy = Math.floor(cell / ATLAS_COLS) * CELL;
    for (let y = 0; y < CELL; y++)
      for (let x = 0; x < CELL; x++) {
        O.r = O.g = O.b = O.a = O.h = 0;
        O.ro = 255;
        // Pixel coordinates scaled to the original 256 px cell so noise frequencies stay put at any CELL.
        fn((x + 0.5) / CELL - 0.5, (y + 0.5) / CELL - 0.5, ((x * 256) / CELL) + cell * 97, (y * 256) / CELL);
        const i = (cy + y) * W + cx + x;
        col[i * 4] = O.r;
        col[i * 4 + 1] = O.g;
        col[i * 4 + 2] = O.b;
        col[i * 4 + 3] = O.a;
        height[i] = O.h;
        rough[i * 4] = rough[i * 4 + 1] = rough[i * 4 + 2] = O.ro;
        rough[i * 4 + 3] = 255;
      }
  }
  // Normal map from the height field (central differences), tangent space; cells never sample their neighbours.
  const nrm = new Uint8ClampedArray(W * H * 4);
  const s = (3 * CELL) / 256;
  for (let y = 0; y < H; y++) {
    const y0 = y % CELL === 0 ? y : y - 1;
    const y1 = y % CELL === CELL - 1 ? y : y + 1;
    for (let x = 0; x < W; x++) {
      const x0 = x % CELL === 0 ? x : x - 1;
      const x1 = x % CELL === CELL - 1 ? x : x + 1;
      const dx = (height[y * W + x1] - height[y * W + x0]) * s;
      const dy = (height[y1 * W + x] - height[y0 * W + x]) * s;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * W + x) * 4;
      nrm[i] = (-dx / l) * 127.5 + 127.5;
      nrm[i + 1] = (dy / l) * 127.5 + 127.5;
      nrm[i + 2] = (1 / l) * 127.5 + 127.5;
      nrm[i + 3] = 255;
    }
  }
  return { W, H, col, nrm, rough };
}

function canvasTex(data: Uint8ClampedArray<ArrayBuffer>,W: number, H: number, srgb: boolean) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.getContext('2d')!.putImageData(new ImageData(data, W, H), 0, 0);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** The decal textures: colour (sRGB), tangent-space normal and roughness, all ATLAS_COLS x ATLAS_ROWS cells. */
export function decalAtlas() {
  const { W, H, col, nrm, rough } = atlasPixels();
  return { color: canvasTex(col, W, H, true), normal: canvasTex(nrm, W, H, false), rough: canvasTex(rough, W, H, false) };
}
