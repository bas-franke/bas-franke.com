// Pixel generators for the Last Light texture sets (see textures.ts). No three.js and no DOM here, so the same code
// runs in the texture workers (texworker.ts) and, as a fallback, on the main thread.

export type SetName =
  | 'brick'
  | 'plaster'
  | 'concrete'
  | 'wood'
  | 'metal'
  | 'floorConcrete'
  | 'floorWood'
  | 'floorTile'
  | 'mud'
  | 'marbleFloor'
  | 'marbleSlab'
  | 'travertine'
  | 'walnut'
  | 'brass'
  | 'fabric'
  | 'leather'
  | 'plaza';

/** One pixel's material, filled by a set's generator. Colours are sRGB 0..1. */
interface Px {
  h: number;
  r: number;
  g: number;
  b: number;
  rough: number;
  metal: number;
}

// ---- periodic noise ---------------------------------------------------------------------------------------------

function hash(x: number, y: number, s: number) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const wrap = (i: number, p: number) => ((i % p) + p) % p;
const fade = (t: number) => t * t * (3 - 2 * t);

/** Value noise on a lattice that repeats every `p` cells; x, y in lattice units. */
function vnoise(x: number, y: number, p: number, s: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = fade(x - xi);
  const fy = fade(y - yi);
  const x0 = wrap(xi, p);
  const y0 = wrap(yi, p);
  const x1 = wrap(xi + 1, p);
  const y1 = wrap(yi + 1, p);
  const a = hash(x0, y0, s);
  const b = hash(x1, y0, s);
  const c = hash(x0, y1, s);
  const d = hash(x1, y1, s);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal noise over the tile: u, v in 0..1, `f` lattice cells across the tile at the first octave. */
function fbm(u: number, v: number, f: number, oct: number, s: number) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += vnoise(u * f, v * f, f, s + o * 31) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/**
 * Cached fbm: the field is computed once on a periodic grid just fine enough for its highest octave, then sampled
 * bilinearly. Smooth warp and cloud fields cost one lookup per pixel instead of a full fbm, which keeps the
 * domain-warped sets (marble, travertine, walnut) fast enough for the texture workers.
 */
const fieldCache = new Map<number, { g: number; data: Float32Array }>();
function cfbm(u: number, v: number, f: number, oct: number, s: number) {
  const key = (f * 16 + oct) * 1000003 + s;
  let fld = fieldCache.get(key);
  if (!fld) {
    const top = f * 2 ** (oct - 1);
    let g = 64;
    while (g < top * 3 && g < 512) g *= 2;
    const data = new Float32Array(g * g);
    for (let y = 0; y < g; y++) for (let x = 0; x < g; x++) data[y * g + x] = fbm(x / g, y / g, f, oct, s);
    fld = { g, data };
    fieldCache.set(key, fld);
  }
  const g = fld.g;
  const x = u * g - 0.5;
  const y = v * g - 0.5;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = wrap(xi, g);
  const x1 = wrap(xi + 1, g);
  const y0 = wrap(yi, g) * g;
  const y1 = wrap(yi + 1, g) * g;
  const d = fld.data;
  const a = d[y0 + x0] + (d[y0 + x1] - d[y0 + x0]) * fx;
  const b = d[y1 + x0] + (d[y1 + x1] - d[y1 + x0]) * fx;
  return a + (b - a) * fy;
}

/** Cellular noise over the tile: distances to the nearest and second-nearest feature points (in cell units). */
function worley(u: number, v: number, n: number, s: number): [number, number] {
  const x = u * n;
  const y = v * n;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const px = cx + hash(wrap(cx, n), wrap(cy, n), s);
      const py = cy + hash(wrap(cx, n), wrap(cy, n), s + 7);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  return [f1, f2];
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

function tint(px: Px, r: number, g: number, b: number, t: number) {
  px.r = mix(px.r, r, t);
  px.g = mix(px.g, g, t);
  px.b = mix(px.b, b, t);
}
function shade(px: Px, k: number) {
  px.r *= k;
  px.g *= k;
  px.b *= k;
}

// ---- generators ---------------------------------------------------------------------------------------------------

type Gen = (u: number, v: number, px: Px) => void;

/** Running-bond brick, 4 bricks across and 14 courses per 1.05 m tile, chipped edges, soot and salt bloom. */
const brick: Gen = (u, v, px) => {
  const rows = 14;
  const cols = 4;
  const ry = v * rows;
  const row = Math.floor(ry);
  const rx = u * cols + (row % 2 ? 0.5 : 0);
  const col = Math.floor(rx);
  const bx = rx - col;
  const by = ry - row;
  const W = 1.05 / cols;
  const H = 1.05 / rows;
  const chip = (fbm(u, v, 48, 3, 11) - 0.5) * 0.009;
  const e = Math.min(bx * W, (1 - bx) * W, by * H, (1 - by) * H) - 0.005 + chip;
  const id = hash(wrap(col, cols), row, 3);
  const grain = fbm(u, v, 96, 3, 5);
  const big = fbm(u, v, 3, 4, 9);
  if (e < 0) {
    px.r = 0.3 + grain * 0.08;
    px.g = 0.28 + grain * 0.07;
    px.b = 0.25 + grain * 0.06;
    px.h = 0.15 + grain * 0.12;
    px.rough = 0.97;
  } else {
    const tone = hash(wrap(col, cols), row, 17);
    if (id < 0.14) {
      px.r = 0.22;
      px.g = 0.09;
      px.b = 0.07;
    } else if (id < 0.22) {
      px.r = 0.52;
      px.g = 0.33;
      px.b = 0.24;
    } else if (id < 0.3) {
      px.r = 0.3;
      px.g = 0.16;
      px.b = 0.12;
    } else {
      px.r = mix(0.36, 0.55, tone);
      px.g = mix(0.13, 0.22, tone);
      px.b = mix(0.09, 0.14, tone);
    }
    // Fired unevenly: one end of a brick darker than the other.
    shade(px, 0.75 + grain * 0.4 + (bx - 0.5) * (hash(wrap(col, cols), row, 29) - 0.5) * 0.6);
    const pit = vnoise(u * 220, v * 220, 220, 21);
    const pitted = smooth(0.8, 0.9, pit);
    shade(px, 1 - pitted * 0.5);
    // Each brick sits a little crooked, so it catches light on its own.
    const tiltX = (hash(wrap(col, cols), row, 31) - 0.5) * 0.25;
    const tiltY = (hash(wrap(col, cols), row, 37) - 0.5) * 0.25;
    px.h = 0.62 + smooth(0, 0.008, e) * 0.28 + grain * 0.12 - pitted * 0.2 + (bx - 0.5) * tiltX + (by - 0.5) * tiltY;
    px.rough = 0.8 + grain * 0.12;
    // Salt bloom on some bricks.
    const salt = smooth(0.62, 0.78, fbm(u, v, 5, 4, 41)) * (0.4 + hash(wrap(col, cols), row, 23) * 0.6);
    tint(px, 0.62, 0.6, 0.55, salt * 0.45);
  }
  // Soot and grime across both, with darker runs down the wall.
  shade(px, 0.6 + big * 0.55);
  shade(px, 1 - smooth(0.55, 0.8, fbm(u * 0.25, v, 24, 3, 47)) * 0.35);
  px.metal = 0;
};

/** Stained, peeling plaster with water rings, hairline cracks and mould. */
const plaster: Gen = (u, v, px) => {
  const fine = fbm(u, v, 64, 3, 2);
  const big = fbm(u, v, 2, 5, 4);
  px.r = 0.52;
  px.g = 0.5;
  px.b = 0.45;
  shade(px, 0.7 + big * 0.45);
  // Dirt settling into the texture of the plaster.
  shade(px, 1 - smooth(0.5, 0.8, fbm(u, v, 10, 4, 5)) * 0.25);
  // Yellowing.
  tint(px, 0.55, 0.47, 0.32, smooth(0.45, 0.75, fbm(u, v, 3, 4, 8)) * 0.5);
  px.h = 0.6 + fine * 0.06;
  px.rough = 0.88 + fine * 0.08;
  // Water stains with a darker tide line.
  const w = fbm(u, v, 3, 5, 13);
  const inside = smooth(0.58, 0.6, w);
  tint(px, 0.47, 0.42, 0.33, inside * 0.3);
  const rim = smooth(0.03, 0, Math.abs(w - 0.6)) * (0.4 + 0.6 * fbm(u, v, 20, 2, 14));
  tint(px, 0.36, 0.31, 0.24, rim * 0.3);
  // Peeling: the brown render underneath, recessed, with a lifted lip.
  const p = fbm(u, v, 4, 5, 29);
  const peel = smooth(0.655, 0.665, p);
  if (peel > 0) {
    tint(px, 0.3 + fine * 0.08, 0.26 + fine * 0.06, 0.22, peel);
    px.h -= peel * 0.25;
    px.rough = mix(px.rough, 0.95, peel);
  }
  px.h += smooth(0.012, 0, Math.abs(p - 0.65)) * 0.12;
  // Hairline cracks in a few regions.
  const [f1, f2] = worley(u, v, 6, 51);
  const crack = smooth(0.018, 0.0, f2 - f1) * smooth(0.64, 0.74, fbm(u, v, 3, 3, 61));
  shade(px, 1 - crack * 0.6);
  px.h -= crack * 0.2;
  // Black mould near some stains.
  const mould = smooth(0.66, 0.8, fbm(u, v, 6, 4, 71)) * smooth(0.6, 0.9, vnoise(u * 160, v * 160, 160, 73));
  tint(px, 0.08, 0.09, 0.06, mould * 0.8);
  px.metal = 0;
};

/** Board-formed concrete: tone bands, tie holes with rust runs, pits. */
const concrete: Gen = (u, v, px) => {
  const fine = fbm(u, v, 80, 3, 6);
  const big = fbm(u, v, 3, 5, 12);
  const band = Math.floor(v * 6);
  px.r = px.g = px.b = 0.4;
  px.b -= 0.01;
  shade(px, 0.82 + (hash(band, 0, 3) - 0.5) * 0.1 + big * 0.3 + fine * 0.12);
  px.h = 0.55 + fine * 0.12;
  px.rough = 0.86 + fine * 0.08;
  // Seam between form boards.
  const seam = smooth(0.006, 0, Math.abs(v * 6 - Math.round(v * 6)) / 6);
  shade(px, 1 - seam * 0.35);
  px.h -= seam * 0.1;
  // Tie holes on a 0.6 m grid (tile is 2 m: 3 x 3, offset) with rust streaks below.
  const tx = u * 3;
  const ty = v * 3;
  const dx = (tx - Math.floor(tx) - 0.5) * (2 / 3);
  const dy = (ty - Math.floor(ty) - 0.5) * (2 / 3);
  const hole = smooth(0.016, 0.011, Math.hypot(dx, dy));
  shade(px, 1 - hole * 0.8);
  px.h -= hole * 0.35;
  const run = smooth(0.012, 0, Math.abs(dx)) * (dy < 0 ? smooth(-0.3, 0, dy) : 0) * fbm(u * 0.2, v, 30, 2, 19);
  tint(px, 0.3, 0.17, 0.08, run * 0.9);
  const pit = smooth(0.84, 0.9, vnoise(u * 300, v * 300, 300, 31));
  shade(px, 1 - pit * 0.5);
  px.h -= pit * 0.2;
  tint(px, 0.16, 0.16, 0.15, smooth(0.6, 0.8, fbm(u, v, 4, 4, 43)) * 0.4);
  px.metal = 0;
};

/** Planks along u, 8 per 1 m tile, grain, gaps and nails. */
const wood: Gen = (u, v, px) => {
  const n = 8;
  const pv = v * n;
  const plank = Math.floor(pv);
  const local = pv - plank;
  const tone = hash(plank, 0, 5);
  const warp = fbm(u, v, 6, 3, plank + 3);
  const grain = 0.5 + 0.5 * Math.sin((local * 3 + warp * 5 + fbm(u, v, 40, 2, plank) * 0.8) * Math.PI * 2);
  const fine = vnoise(u * 400, v * 30, 400, plank + 9);
  px.r = mix(0.24, 0.34, tone);
  px.g = mix(0.17, 0.23, tone);
  px.b = mix(0.11, 0.15, tone);
  shade(px, 0.72 + grain * 0.14 + fine * 0.18);
  // Grey, weathered patches.
  tint(px, 0.3, 0.29, 0.27, smooth(0.45, 0.75, fbm(u, v, 3, 4, 17)) * 0.6);
  shade(px, 1 - smooth(0.55, 0.85, fbm(u, v, 5, 4, 18)) * 0.35);
  px.h = 0.6 + grain * 0.06 + fine * 0.05;
  px.rough = 0.72 + fine * 0.12;
  const gap = smooth(0.06, 0.02, Math.min(local, 1 - local));
  shade(px, 1 - gap * 0.85);
  px.h -= gap * 0.5;
  // Nails near both ends of the plank.
  for (const nu of [0.05, 0.95]) {
    const d = Math.hypot((u - nu) * 1, (local - 0.5) / n);
    const nail = smooth(0.006, 0.004, d);
    if (nail > 0) {
      px.r = mix(px.r, 0.18, nail);
      px.g = mix(px.g, 0.16, nail);
      px.b = mix(px.b, 0.14, nail);
      px.metal = nail * 0.8;
      px.rough = mix(px.rough, 0.5, nail);
      px.h += nail * 0.1;
      tint(px, 0.25, 0.12, 0.05, smooth(0.02, 0.006, d) * 0.4 * (1 - nail));
    }
  }
};

/** Painted steel panels with rivets, rust blooms and bare scratches. */
const metal: Gen = (u, v, px) => {
  const fine = fbm(u, v, 60, 3, 8);
  px.r = 0.22;
  px.g = 0.28;
  px.b = 0.25;
  shade(px, 0.85 + fine * 0.25 + fbm(u, v, 3, 3, 9) * 0.2);
  px.metal = 0;
  px.rough = 0.55 + fine * 0.1;
  px.h = 0.6;
  // Panel seams every 0.5 m (tile 1.5 m) with rivets.
  const su = u * 3;
  const sv = v * 3;
  const eu = Math.abs(su - Math.round(su)) / 3;
  const ev = Math.abs(sv - Math.round(sv)) / 3;
  const seam = smooth(0.004, 0.001, Math.min(eu, ev));
  shade(px, 1 - seam * 0.6);
  px.h -= seam * 0.3;
  const rv = Math.abs((u * 30) % 1 - 0.5);
  const rivet = (eu < 0.012 || ev < 0.012) && Math.min(eu, ev) > 0.005 ? smooth(0.25, 0.15, rv) : 0;
  px.h += rivet * 0.25;
  // Rust.
  const r = fbm(u, v, 4, 5, 33);
  const rust = smooth(0.6, 0.66, r + fine * 0.06);
  if (rust > 0) {
    const deep = smooth(0.66, 0.76, r);
    tint(px, mix(0.3, 0.17, deep), mix(0.16, 0.09, deep), mix(0.08, 0.05, deep), rust);
    px.rough = mix(px.rough, 0.95, rust);
    px.h -= rust * 0.15 + vnoise(u * 300, v * 300, 300, 3) * rust * 0.1;
  }
  // Scratches to bare metal.
  const sc = smooth(0.985, 1, vnoise(u * 8, v * 300, 8, 61)) * smooth(0.4, 0.6, fbm(u, v, 3, 2, 62));
  if (sc > 0) {
    tint(px, 0.5, 0.5, 0.5, sc);
    px.metal = sc * 0.9;
    px.rough = mix(px.rough, 0.35, sc);
  }
};

/** Worn floor slab: saw-cut joints, cracks, oil, sand and standing water. */
const floorConcrete: Gen = (u, v, px) => {
  const fine = fbm(u, v, 120, 3, 4);
  const big = fbm(u, v, 3, 5, 6);
  px.r = 0.34;
  px.g = 0.33;
  px.b = 0.31;
  shade(px, 0.72 + big * 0.45 + fine * 0.12);
  px.h = 0.55 + fine * 0.08;
  px.rough = 0.72 + fine * 0.1;
  px.metal = 0;
  const ju = Math.abs(u * 2 - Math.round(u * 2)) * 2;
  const jv = Math.abs(v * 2 - Math.round(v * 2)) * 2;
  const joint = smooth(0.004, 0.0015, Math.min(ju, jv));
  shade(px, 1 - joint * 0.7);
  px.h -= joint * 0.4;
  // Cracks: cell edges, warped hard so they wander, and only in some regions.
  const wu = u + (fbm(u, v, 12, 4, 3) - 0.5) * 0.07;
  const wv = v + (fbm(u, v, 12, 4, 4) - 0.5) * 0.07;
  const [f1, f2] = worley(wu, wv, 5, 77);
  const crack = smooth(0.022, 0.004, f2 - f1) * smooth(0.55, 0.68, fbm(u, v, 3, 3, 78));
  shade(px, 1 - crack * 0.75);
  px.h -= crack * 0.3;
  // Oil stains.
  tint(px, 0.08, 0.075, 0.07, smooth(0.66, 0.74, fbm(u, v, 5, 4, 91)) * 0.7);
  // Sand drifts.
  tint(px, 0.45, 0.42, 0.36, smooth(0.62, 0.8, fbm(u, v, 6, 4, 92)) * 0.35);
  // Specks of grit.
  const grit = smooth(0.9, 0.95, vnoise(u * 500, v * 500, 500, 93));
  tint(px, 0.55, 0.52, 0.48, grit * 0.5);
  px.h += grit * 0.1;
  // Puddles: dark, glassy, flat; damp halo around them.
  const w = fbm(u, v, 3, 5, 97);
  const wet = smooth(0.635, 0.68, w);
  const damp = smooth(0.5, 0.64, w);
  shade(px, 1 - damp * 0.18 - wet * 0.12);
  px.rough = mix(px.rough, 0.38, damp);
  px.rough = mix(px.rough, 0.05, wet);
  px.h = mix(px.h, 0.45, wet);
};

/** Long floorboards with staggered joints, worn paths and dust. */
const floorWood: Gen = (u, v, px) => {
  const rows = 20;
  const pv = v * rows;
  const row = Math.floor(pv);
  const local = pv - row;
  const off = hash(row, 0, 2);
  // Two boards per row across the 3 m tile, joints staggered.
  const along = (u + off) % 1;
  const seg = Math.floor(along * 2);
  const segLocal = along * 2 - seg;
  const id = hash(row, seg, 4);
  const warp = fbm(u, v, 4, 3, row * 3 + seg);
  const grain = 0.5 + 0.5 * Math.sin((local * 3 + warp * 8) * Math.PI * 2);
  const fine = vnoise(u * 600, v * 40, 600, row + 7);
  px.r = mix(0.22, 0.33, id);
  px.g = mix(0.15, 0.22, id);
  px.b = mix(0.1, 0.14, id);
  shade(px, 0.72 + grain * 0.18 + fine * 0.14);
  px.h = 0.6 + grain * 0.04;
  px.rough = 0.62 + fine * 0.15;
  px.metal = 0;
  const gap = Math.max(smooth(0.05, 0.015, Math.min(local, 1 - local)), smooth(0.004, 0.001, Math.min(segLocal, 1 - segLocal) / 2));
  shade(px, 1 - gap * 0.85);
  px.h -= gap * 0.45;
  // Worn path (lighter, rougher) and dust.
  const wear = smooth(0.5, 0.75, fbm(u, v, 2, 4, 15));
  tint(px, 0.42, 0.36, 0.3, wear * 0.25);
  tint(px, 0.38, 0.35, 0.31, smooth(0.6, 0.85, fbm(u, v, 5, 4, 16)) * 0.3);
  px.rough = mix(px.rough, 0.85, wear * 0.5);
};

/** 0.3 m ceramic tiles with dirty grout, cracked and missing tiles and grime. */
const floorTile: Gen = (u, v, px) => {
  const n = 8;
  const tx = u * n;
  const ty = v * n;
  const ix = Math.floor(tx);
  const iy = Math.floor(ty);
  const lx = tx - ix;
  const ly = ty - iy;
  const size = 2.4 / n;
  const e = Math.min(lx, 1 - lx, ly, 1 - ly) * size;
  const id = hash(ix, iy, 8);
  const fine = fbm(u, v, 100, 3, 1);
  const grime = fbm(u, v, 4, 5, 2);
  px.metal = 0;
  if (id < 0.05) {
    // Missing tile: rough mortar bed.
    px.r = 0.3;
    px.g = 0.29;
    px.b = 0.26;
    shade(px, 0.7 + fine * 0.4);
    px.h = 0.2 + fine * 0.15;
    px.rough = 0.95;
  } else if (e < 0.004) {
    px.r = 0.2;
    px.g = 0.19;
    px.b = 0.16;
    shade(px, 0.8 + fine * 0.3);
    px.h = 0.4;
    px.rough = 0.95;
  } else {
    px.r = mix(0.5, 0.56, hash(ix, iy, 9));
    px.g = mix(0.54, 0.58, hash(ix, iy, 9));
    px.b = mix(0.48, 0.52, hash(ix, iy, 10));
    shade(px, 0.88 + fine * 0.1);
    px.h = 0.65 + smooth(0.004, 0.01, e) * 0.05;
    px.rough = 0.18 + fine * 0.1;
    if (id > 0.88) {
      const [f1, f2] = worley(u, v, 24, ix * 13 + iy);
      const c = smooth(0.03, 0.005, f2 - f1);
      shade(px, 1 - c * 0.6);
      px.h -= c * 0.3;
    }
  }
  // Grime (dulls the glaze too).
  const g = smooth(0.4, 0.85, grime);
  tint(px, 0.17, 0.16, 0.12, g * 0.6);
  px.rough = mix(px.rough, 0.8, g * 0.7);
  const wet = smooth(0.66, 0.7, fbm(u, v, 3, 4, 33));
  px.rough = mix(px.rough, 0.05, wet);
  shade(px, 1 - wet * 0.25);
};

/** Dark yard mud with puddles, stones and dead grass. */
const mud: Gen = (u, v, px) => {
  const fine = fbm(u, v, 90, 3, 3);
  const big = fbm(u, v, 3, 5, 5);
  px.r = 0.16;
  px.g = 0.13;
  px.b = 0.1;
  shade(px, 0.7 + big * 0.5 + fine * 0.2);
  px.h = 0.5 + big * 0.2 + fine * 0.1;
  px.rough = 0.88;
  px.metal = 0;
  const [f1] = worley(u, v, 60, 9);
  const stone = smooth(0.32, 0.22, f1) * smooth(0.5, 0.7, vnoise(u * 60, v * 60, 60, 10));
  tint(px, 0.32, 0.31, 0.29, stone * 0.8);
  px.h += stone * 0.25;
  const grass = smooth(0.6, 0.75, fbm(u, v, 5, 4, 12)) * smooth(0.45, 0.8, vnoise(u * 400, v * 120, 400, 13));
  tint(px, 0.2, 0.19, 0.1, grass * 0.8);
  const w = fbm(u, v, 2, 5, 15);
  const wet = smooth(0.62, 0.65, w);
  shade(px, 1 - wet * 0.5);
  px.rough = mix(px.rough, 0.03, wet);
  px.h = mix(px.h, 0.35, wet);
};


// ---- hotel lobby ---------------------------------------------------------------------------------------------------

/**
 * Black marble in the Nero Portoro style: a near-black body with faint warm clouds, cut by a crackle network of bold
 * cream veins with amber halos (cell edges of domain-warped cellular noise at two scales), plus fine hair veins.
 */
function veinNetRaw(u: number, v: number, n: number, warp: number, seed: number) {
  const wu = u + (cfbm(u, v, 3, 4, seed + 1) - 0.5) * warp + (cfbm(u, v, 9, 3, seed + 2) - 0.5) * warp * 0.25;
  const wv = v + (cfbm(u, v, 3, 4, seed + 3) - 0.5) * warp + (cfbm(u, v, 9, 3, seed + 4) - 0.5) * warp * 0.25;
  const [f1, f2] = worley(wu - Math.floor(wu), wv - Math.floor(wv), n, seed + 5);
  return f2 - f1;
}

/** The vein distance field, cached on a 512 grid (it is continuous, so bilinear sampling keeps the edges crisp). */
const veinCache = new Map<number, Float32Array>();
function veinNet(u: number, v: number, n: number, warp: number, seed: number) {
  const g = 512;
  const key = n * 100003 + seed;
  let d = veinCache.get(key);
  if (!d) {
    d = new Float32Array(g * g);
    for (let y = 0; y < g; y++) for (let x = 0; x < g; x++) d[y * g + x] = veinNetRaw((x + 0.5) / g, (y + 0.5) / g, n, warp, seed);
    veinCache.set(key, d);
  }
  const x = u * g - 0.5;
  const y = v * g - 0.5;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = wrap(xi, g);
  const x1 = wrap(xi + 1, g);
  const y0 = wrap(yi, g) * g;
  const y1 = wrap(yi + 1, g) * g;
  const p = d[y0 + x0] + (d[y0 + x1] - d[y0 + x0]) * fx;
  const q = d[y1 + x0] + (d[y1 + x1] - d[y1 + x0]) * fx;
  return p + (q - p) * fy;
}

function marbleBody(u: number, v: number, px: Px, seed: number) {
  const cloud = cfbm(u, v, 3, 5, seed + 1);
  const cloud2 = cfbm(u, v, 12, 4, seed + 2);
  px.r = 0.035 + cloud * 0.07 + cloud2 * 0.02;
  px.g = 0.03 + cloud * 0.055 + cloud2 * 0.016;
  px.b = 0.027 + cloud * 0.042 + cloud2 * 0.013;
  // Bold veins: cell edges of a coarse network, widths wandering along their length; not every edge is a vein.
  const e1 = veinNet(u, v, 3, 0.25, seed + 10);
  const w1 = 0.005 + Math.pow(cfbm(u, v, 6, 3, seed + 20), 2) * 0.05;
  const keep1 = smooth(0.3, 0.45, cfbm(u, v, 3, 3, seed + 21));
  const big = smooth(w1, w1 * 0.25, e1) * keep1;
  const halo1 = smooth(w1 * 1.8, w1 * 0.7, e1) * keep1;
  // Secondary veins: a finer network, thinner and patchier.
  const e2 = veinNet(u, v, 7, 0.14, seed + 30);
  const w2 = 0.005 + Math.pow(cfbm(u, v, 8, 3, seed + 40), 2) * 0.03;
  const keep2 = smooth(0.4, 0.56, cfbm(u, v, 4, 3, seed + 41));
  const mid = smooth(w2, w2 * 0.2, e2) * keep2;
  const halo2 = smooth(w2 * 1.8, w2 * 0.6, e2) * keep2;
  // Hair veins: long warped threads.
  const t = Math.abs(Math.sin((u * 2 + v * 3 + cfbm(u, v, 4, 5, seed + 50) * 1.6) * Math.PI));
  const hair = smooth(0.025, 0.004, t) * smooth(0.45, 0.7, cfbm(u, v, 3, 3, seed + 51)) * 0.6;
  const halo = Math.max(halo1, halo2 * 0.8);
  const core = Math.max(big, mid * 0.85, hair);
  // Amber halo bleeding into the black, then the cream calcite core with a little speckle.
  // Kept dark: under the lobby's warm light and bloom anything brighter glows like lava.
  tint(px, 0.16, 0.1, 0.045, halo * 0.25);
  tint(px, 0.3, 0.22, 0.11, smooth(0.4, 0.9, halo) * 0.2 * (0.4 + cloud2 * 0.9));
  const speck = hash(Math.floor(u * 300), Math.floor(v * 300), seed + 60);
  tint(px, 0.44 + speck * 0.05, 0.41 + speck * 0.04, 0.36 + speck * 0.03, smooth(0.2, 0.8, core) * 0.75);
  px.h = 0.5 + cloud * 0.02 - core * 0.01;
  px.rough = 0.05 + cloud2 * 0.05 + core * 0.06;
  px.metal = 0;
}

/** 1.2 m polished tiles of the black marble, 2 x 2 on a 2.4 m set, each turned so the veins never line up. */
const marbleFloor: Gen = (u, v, px) => {
  const tx = u * 2;
  const ty = v * 2;
  const ix = Math.floor(tx);
  const iy = Math.floor(ty);
  const lx = tx - ix;
  const ly = ty - iy;
  const id = hash(ix, iy, 61);
  const turn = Math.floor(id * 4);
  const [ru, rv] = turn === 0 ? [lx, ly] : turn === 1 ? [ly, 1 - lx] : turn === 2 ? [1 - lx, 1 - ly] : [1 - ly, lx];
  // One shared vein field; each tile is cut from a different part of it (cheap, and no two tiles match).
  const ou = hash(ix, iy, 65);
  const ov = hash(ix, iy, 66);
  marbleBody((ru * 0.6 + ou) % 1, (rv * 0.6 + ov) % 1, px, 100);
  shade(px, 0.85 + hash(ix, iy, 62) * 0.3);
  const e = Math.min(lx, 1 - lx, ly, 1 - ly) * 1.2;
  const joint = smooth(0.0035, 0.001, e);
  tint(px, 0.11, 0.1, 0.09, joint);
  px.h -= joint * 0.25;
  px.rough = Math.max(px.rough, joint * 0.6);
  // Faint scuffs where the polish has worn.
  const scuff = smooth(0.7, 0.85, cfbm(u, v, 18, 3, 63)) * smooth(0.55, 0.8, cfbm(u, v, 3, 3, 64));
  px.rough += scuff * 0.1;
};

const marbleSlab: Gen = (u, v, px) => marbleBody(u, v, px, 300);

/** Cream travertine: horizontal bedding with tan and brown streaks, long open pores, 1.2 x 0.6 m slabs in running bond. */
const travertine: Gen = (u, v, px) => {
  const ry = v * 4;
  const row = Math.floor(ry);
  const rx = u * 2 + (row % 2 ? 0.5 : 0);
  const slab = hash(wrap(Math.floor(rx), 2), row, 76);
  // Bedding: wavy horizontal layers; each slab is cut from a different part of the block.
  const bed = v * 9 + slab * 3.7 + cfbm(u, v, 2, 4, 71) * 0.25 + cfbm(u, v, 8, 3, 70) * 0.03;
  const band = 0.5 + 0.5 * Math.sin(bed * Math.PI * 2);
  const fineBed = v * 21 + slab * 5 + cfbm(u, v, 2, 4, 73) * 0.22;
  const streak = smooth(0.8, 0.97, 0.5 + 0.5 * Math.sin(fineBed * Math.PI * 2)) * smooth(0.3, 0.7, cfbm(u * 0.5, v, 3, 3, 72));
  const thread = smooth(0.975, 0.999, 0.5 + 0.5 * Math.sin((v * 70 + cfbm(u, v, 3, 3, 78) * 0.3) * Math.PI * 2)) * smooth(0.5, 0.7, cfbm(u, v, 6, 3, 79));
  px.r = 0.88 - band * 0.05;
  px.g = 0.82 - band * 0.06;
  px.b = 0.7 - band * 0.075;
  tint(px, 0.74, 0.62, 0.46, streak * 0.45);
  tint(px, 0.56, 0.44, 0.31, thread * 0.4);
  // Pores: small holes squashed along the bedding, clustered in some layers.
  const [f1] = worley(u, v, 48, 74);
  const pore = smooth(0.14, 0.06, f1) * smooth(0.45, 0.7, cfbm(u, v, 7, 3, 75)) * smooth(0.45, 0.75, vnoise(u * 256, v * 24, 256, 77));
  shade(px, 1 - pore * 0.3);
  tint(px, 0.55, 0.45, 0.33, pore * 0.25);
  px.h = 0.6 + band * 0.03 - pore * 0.4;
  px.rough = 0.36 + band * 0.08 + pore * 0.35;
  px.metal = 0;
  const lx = rx - Math.floor(rx);
  const ly = ry - row;
  const e = Math.min(lx * 1.2, (1 - lx) * 1.2, ly * 0.6, (1 - ly) * 0.6);
  const joint = smooth(0.004, 0.0012, e);
  shade(px, 1 - joint * 0.4);
  px.h -= joint * 0.3;
  shade(px, 0.95 + slab * 0.08);
};

/** Book-matched walnut panels, 0.6 m wide: straight vertical grain with a soft cathedral figure, satin lacquer. */
const walnut: Gen = (u, v, px) => {
  const cx = u * 2;
  const col = Math.floor(cx);
  let lx = cx - col;
  if (col % 2) lx = 1 - lx;
  // Mostly straight growth rings, gently drifting; a cathedral arch in the middle of each leaf.
  const drift = cfbm(lx * 0.5, v, 2, 4, 81) * 0.35;
  const arch = Math.max(0, 1 - Math.abs(lx - 0.5) * 3.2) * 0.18 * Math.sin(v * Math.PI * 4 + 1);
  const g = lx * 26 + drift * 2 + arch * 6;
  const ring = Math.pow(0.5 + 0.5 * Math.sin(g * Math.PI * 2), 3);
  const late = Math.pow(0.5 + 0.5 * Math.sin(g * Math.PI * 6 + 1), 6);
  const fine = vnoise(u * 1400, v * 22, 1400, 82);
  const figure = cfbm(u, v, 4, 4, 83);
  const ray = smooth(0.85, 0.98, vnoise(u * 60, v * 900, 60, 84)) * 0.25;
  px.r = 0.36 - ring * 0.13 - late * 0.04 + figure * 0.06;
  px.g = 0.22 - ring * 0.09 - late * 0.03 + figure * 0.035;
  px.b = 0.13 - ring * 0.06 - late * 0.02 + figure * 0.02;
  shade(px, 0.88 + fine * 0.2 + ray * 0.3);
  px.h = 0.55 - ring * 0.02 + fine * 0.015;
  px.rough = 0.3 + fine * 0.1 + ring * 0.05;
  px.metal = 0;
  const e = Math.min(lx, 1 - lx) * 0.6;
  const reveal = smooth(0.006, 0.002, e);
  shade(px, 1 - reveal * 0.8);
  px.h -= reveal * 0.5;
  px.rough = Math.max(px.rough, reveal * 0.7);
};

/** Brushed brass: fine brushing streaks along u, warm gold, faint polish variation (no blotchy tarnish). */
const brass: Gen = (u, v, px) => {
  const brush = vnoise(u * 3, v * 900, 3, 91) * 0.55 + vnoise(u * 12, v * 2200, 12, 92) * 0.45;
  const polish = fbm(u, v, 2, 3, 93);
  px.r = 0.95 - brush * 0.06;
  px.g = 0.74 - brush * 0.06 + polish * 0.02;
  px.b = 0.4 - brush * 0.05;
  px.h = 0.5 + brush * 0.03;
  px.rough = 0.16 + brush * 0.1 + (1 - polish) * 0.06;
  px.metal = 1;
};

/** Cream upholstery: a fine basket weave with soft slubs. */
const fabric: Gen = (u, v, px) => {
  const n = 160;
  const wx = Math.sin(u * n * Math.PI * 2);
  const wy = Math.sin(v * n * Math.PI * 2);
  const over = (Math.floor(u * n) + Math.floor(v * n)) % 2 ? wx : wy;
  const slub = fbm(u, v, 24, 3, 101);
  px.r = 0.74 + over * 0.03 + slub * 0.05;
  px.g = 0.69 + over * 0.03 + slub * 0.05;
  px.b = 0.6 + over * 0.03 + slub * 0.04;
  px.h = 0.5 + over * 0.15;
  px.rough = 0.88;
  px.metal = 0;
};

/** Black pebbled leather with a soft sheen. */
const leather: Gen = (u, v, px) => {
  const [f1, f2] = worley(u, v, 90, 111);
  const crease = smooth(0.08, 0.0, f2 - f1);
  const body = fbm(u, v, 4, 4, 112);
  px.r = 0.045 + body * 0.03;
  px.g = 0.04 + body * 0.027;
  px.b = 0.037 + body * 0.024;
  shade(px, 1 - crease * 0.4);
  px.h = 0.6 - crease * 0.3 + f1 * 0.1;
  px.rough = 0.42 + crease * 0.25 + body * 0.1;
  px.metal = 0;
};

/** Light granite pavers outside: 0.6 m squares, speckled, dusty joints. */
const plaza: Gen = (u, v, px) => {
  const n = 4;
  const tx = u * n;
  const ty = v * n;
  const ix = Math.floor(tx);
  const iy = Math.floor(ty);
  const lx = tx - ix;
  const ly = ty - iy;
  const speck = vnoise(u * 700, v * 700, 700, 121);
  const tone = hash(ix, iy, 122);
  px.r = 0.58 + tone * 0.08;
  px.g = 0.55 + tone * 0.07;
  px.b = 0.5 + tone * 0.06;
  shade(px, 0.85 + speck * 0.3);
  tint(px, 0.15, 0.14, 0.13, smooth(0.86, 0.93, speck) * 0.6);
  px.h = 0.6 + speck * 0.05;
  px.rough = 0.62 + speck * 0.15;
  px.metal = 0;
  const e = Math.min(lx, 1 - lx, ly, 1 - ly) * 0.6;
  const joint = smooth(0.006, 0.002, e);
  shade(px, 1 - joint * 0.5);
  px.h -= joint * 0.4;
  tint(px, 0.42, 0.4, 0.36, smooth(0.6, 0.85, fbm(u, v, 3, 4, 123)) * 0.25);
};

export const SPECS: Record<SetName, { gen: Gen; size: number; meters: number; normal: number }> = {
  brick: { gen: brick, size: 1024, meters: 1.05, normal: 9 },
  plaster: { gen: plaster, size: 1024, meters: 2, normal: 3 },
  concrete: { gen: concrete, size: 512, meters: 2, normal: 4 },
  wood: { gen: wood, size: 512, meters: 1, normal: 4 },
  metal: { gen: metal, size: 512, meters: 1.5, normal: 3 },
  floorConcrete: { gen: floorConcrete, size: 1024, meters: 4, normal: 3 },
  floorWood: { gen: floorWood, size: 1024, meters: 3, normal: 4 },
  floorTile: { gen: floorTile, size: 1024, meters: 2.4, normal: 4 },
  mud: { gen: mud, size: 512, meters: 6, normal: 3 },
  marbleFloor: { gen: marbleFloor, size: 1024, meters: 2.4, normal: 2 },
  marbleSlab: { gen: marbleSlab, size: 1024, meters: 1.6, normal: 1.5 },
  travertine: { gen: travertine, size: 1024, meters: 2.4, normal: 5 },
  walnut: { gen: walnut, size: 1024, meters: 1.2, normal: 3 },
  brass: { gen: brass, size: 512, meters: 1, normal: 1.5 },
  fabric: { gen: fabric, size: 512, meters: 0.5, normal: 4 },
  leather: { gen: leather, size: 512, meters: 0.5, normal: 4 },
  plaza: { gen: plaza, size: 512, meters: 2.4, normal: 3 },
};

export interface TexData {
  albedo: Uint8Array;
  normal: Uint8Array;
  orm: Uint8Array;
}

/** Albedo (sRGB), tangent-space normal and ORM (G roughness, B metalness) for set `name` at `n` x `n` pixels. */
export function generate(name: SetName, n: number): TexData {
  const spec = SPECS[name];
  const albedo = new Uint8Array(n * n * 4);
  const orm = new Uint8Array(n * n * 4);
  const height = new Float32Array(n * n);
  const px: Px = { h: 0, r: 0, g: 0, b: 0, rough: 0, metal: 0 };
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      px.metal = 0;
      spec.gen(u, v, px);
      const i = y * n + x;
      height[i] = px.h;
      albedo[i * 4] = clamp01(px.r) * 255;
      albedo[i * 4 + 1] = clamp01(px.g) * 255;
      albedo[i * 4 + 2] = clamp01(px.b) * 255;
      albedo[i * 4 + 3] = 255;
      orm[i * 4] = 255;
      orm[i * 4 + 1] = clamp01(px.rough) * 255;
      orm[i * 4 + 2] = clamp01(px.metal || 0) * 255;
      orm[i * 4 + 3] = 255;
    }
  }
  // Sobel over the wrapped height field. Strength is per metre of tile so resolution does not change the look.
  const normal = new Uint8Array(n * n * 4);
  const k = spec.normal * (n / 512);
  const hAt = (x: number, y: number) => height[wrap(y, n) * n + wrap(x, n)];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const dx = hAt(x + 1, y - 1) + 2 * hAt(x + 1, y) + hAt(x + 1, y + 1) - hAt(x - 1, y - 1) - 2 * hAt(x - 1, y) - hAt(x - 1, y + 1);
      const dy = hAt(x - 1, y + 1) + 2 * hAt(x, y + 1) + hAt(x + 1, y + 1) - hAt(x - 1, y - 1) - 2 * hAt(x, y - 1) - hAt(x + 1, y - 1);
      let nx = -dx * k * 0.125;
      let ny = -dy * k * 0.125;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * n + x) * 4;
      normal[i] = (nx * 0.5 + 0.5) * 255;
      normal[i + 1] = (ny * 0.5 + 0.5) * 255;
      normal[i + 2] = (nz * 0.5 + 0.5) * 255;
      normal[i + 3] = 255;
    }
  return { albedo, normal, orm };
}
