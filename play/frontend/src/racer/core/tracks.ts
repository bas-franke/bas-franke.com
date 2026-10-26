// Every course in the game: its centreline, width, jumps and the look of the world around it (Theme). All tracks are
// point-to-point desert canyon runs (start in one place, finish in another, one go) in the painted, sun-baked style
// of the concept art; themes vary the time of day, rock and sand colours and which set pieces (waterfalls, arches,
// sky city, grandstands) appear.

export interface Theme {
  /** Sky gradient, zenith to horizon, and the sun. */
  skyTop: string;
  skyHorizon: string;
  sunColor: string;
  /** Sun direction: azimuth (radians, 0 = +z, clockwise from above) and elevation (radians above the horizon). */
  sunAzimuth: number;
  sunElevation: number;
  /** Aerial perspective: colour distant things fade to, and the distance where they are half faded. */
  haze: string;
  hazeDistance: number;
  /** Cloud cover 0..1. */
  clouds: number;
  /** Rock: sunlit face, shadowed face, and the pale strata bands. */
  rockLit: string;
  rockShade: string;
  rockStrata: string;
  /** Packed dirt of the race surface and the loose sand beside it. */
  dirt: string;
  sand: string;
  /** Sparse vegetation. */
  scrub: string;
  /** Set pieces. */
  waterfalls: boolean;
  arches: boolean;
  skyCity: boolean;
  /** Racing-team banner colours used on poles and stands. */
  banners: string[];
}

export interface TrackDef {
  id: string;
  name: string;
  /** Short flavour line for menus. */
  blurb: string;
  /** Road width in metres. */
  width: number;
  /** Relative width variation 0..0.3 (wider straights / narrow sections). */
  widthVar?: number;
  /** Banking strength: bank angle = curvature * bank (radians, clamped). */
  bank?: number;
  /** Open centreline control points from the run-up to the run-off: [x, z, y]. Travel follows the order of the points. */
  points: [number, number, number?][];
  /** Positions of boost pads: fraction of the race (start line 0, finish line 1) and lateral offset as a fraction of
   * half the width (-1..1). */
  boostPads: [number, number][];
  /** Jump ramps: where the lip is, as a fraction of the race. */
  jumps: number[];
  /** How many times the base layout repeats along the course (see course()); set pieces placed per stretch of a
   * base layout's length (caves, shortcuts, gorges, vistas) come once per block. Default 1. */
  blocks?: number;
  theme: Theme;
  /** Seed for scenery placement. */
  seed: number;
}

/**
 * Open course drawn turtle-style from the origin, heading -z (seen from above with +z towards the viewer): each leg
 * is [straight metres, bend degrees (+ = left), bend radius metres], a straight followed by a bend. `hills` are
 * [course fraction, height] keys, eased in between and held flat past the first and last. Points come out every
 * ~`step` metres for the spline.
 */
function stage(legs: [number, number, number][], hills: [number, number][] = [[0, 0]], step = 20): [number, number, number][] {
  const pts: { x: number; z: number; d: number }[] = [];
  let x = 0;
  let z = 0;
  let dx = 0;
  let dz = -1;
  let d = 0;
  let next = 0;
  // March a metre at a time, turning on the bends, and keep a point every `step` metres.
  const advance = (len: number, turnRate: number) => {
    for (let k = 0; k < len; k++) {
      if (d >= next) {
        pts.push({ x, z, d });
        next += step;
      }
      if (turnRate) {
        const c = Math.cos(turnRate);
        const s = Math.sin(turnRate);
        [dx, dz] = [dx * c + dz * s, -dx * s + dz * c];
      }
      x += dx;
      z += dz;
      d += 1;
    }
  };
  for (const [straight, deg, radius] of legs) {
    advance(straight, 0);
    if (deg) advance(Math.round((Math.abs(deg) * Math.PI * radius) / 180), (Math.sign(deg) * 1) / radius);
  }
  pts.push({ x, z, d });
  const keys = [...hills].sort((p, q) => p[0] - q[0]);
  const height = (f: number) => {
    if (f <= keys[0][0]) return keys[0][1];
    for (let i = 0; i + 1 < keys.length; i++) {
      const [f0, y0] = keys[i];
      const [f1, y1] = keys[i + 1];
      if (f <= f1) return y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos(((f - f0) / Math.max(1e-6, f1 - f0)) * Math.PI));
    }
    return keys[keys.length - 1][1];
  };
  return pts.map((p) => [p.x, p.z, height(p.d / d)]);
}

/** How a block of a long course re-uses the base legs: in order or back to front, bends as drawn or mirrored, and a
 * scale for its straights and bend radii. */
interface Variant {
  reverse: boolean;
  mirror: boolean;
  straight: number;
  radius: number;
}

const v = (reverse: boolean, mirror: boolean, straight: number, radius: number): Variant => ({ reverse, mirror, straight, radius });
/** Default four-block plan: as drawn, back to front and mirrored, mirrored, back to front. The mirrored blocks turn
 * the other way, so the course's overall heading stays near where it started and it never curls back on itself. */
const BLOCKS: Variant[] = [v(false, false, 1, 1), v(true, true, 1.06, 1.04), v(false, true, 0.92, 1.08), v(true, false, 1.02, 0.96)];

/**
 * A long course from a short base layout: the base legs (all but the last, the run-off straight, which comes once at
 * the end) repeated in blocks with variations (see Variant). Hills, jumps and boost pads repeat with them, so they are
 * as dense on the long course as on the base one. Returns the TrackDef fields it fills in.
 */
function course(
  legs: [number, number, number][],
  hills: [number, number][],
  jumps: number[],
  boostPads: [number, number][],
  blocks: Variant[] = BLOCKS,
): Pick<TrackDef, 'points' | 'jumps' | 'boostPads' | 'blocks'> {
  const body = legs.slice(0, -1);
  const out: [number, number, number][] = [];
  const keys: [number, number][] = [];
  const js: number[] = [];
  const pads: [number, number][] = [];
  const B = blocks.length;
  blocks.forEach((b, k) => {
    const seq = b.reverse ? [...body].reverse() : body;
    for (const [len, deg, rad] of seq) out.push([Math.round(len * b.straight), b.mirror ? -deg : deg, Math.round(rad * b.radius)]);
    // A block run back to front runs its hills, jumps and pads back to front too; keys keep 2% off the block's ends
    // so neighbouring blocks blend.
    const at = (f: number) => (k + (b.reverse ? 1 - f : f)) / B;
    for (const [f, y] of hills) keys.push([(k + 0.02 + 0.96 * (b.reverse ? 1 - f : f)) / B, y]);
    for (const f of jumps) js.push(at(f));
    for (const [f, x] of boostPads) pads.push([at(f), b.mirror ? -x : x]);
  });
  out.push(legs[legs.length - 1]);
  return { points: stage(out, keys), jumps: js.sort((a, b) => a - b), boostPads: pads.sort((a, b) => a[0] - b[0]), blocks: B };
}

const noon: Theme = {
  skyTop: '#3d7fd6',
  skyHorizon: '#bfe0f2',
  sunColor: '#fff1d6',
  sunAzimuth: 2.4,
  sunElevation: 0.55,
  haze: '#e9c7a6',
  hazeDistance: 900,
  clouds: 0.55,
  rockLit: '#d9733e',
  rockShade: '#8a3d2b',
  rockStrata: '#efb07a',
  dirt: '#d39a62',
  sand: '#e2b07a',
  scrub: '#7c6a2e',
  waterfalls: true,
  arches: true,
  skyCity: true,
  banners: ['#2c63c7', '#d2342c', '#f2f2f2'],
};

const golden: Theme = {
  ...noon,
  skyTop: '#4a74c9',
  skyHorizon: '#f6d3a1',
  sunColor: '#ffd9a0',
  sunAzimuth: 1.2,
  sunElevation: 0.28,
  haze: '#f0b98a',
  hazeDistance: 750,
  clouds: 0.4,
  rockLit: '#e2693a',
  rockShade: '#7a3326',
  rockStrata: '#f5b27c',
  dirt: '#cf8f58',
  sand: '#e8ad74',
};

const sunset: Theme = {
  ...noon,
  skyTop: '#5a4fa8',
  skyHorizon: '#ff9a5c',
  sunColor: '#ffb070',
  sunAzimuth: 0.4,
  sunElevation: 0.1,
  haze: '#e98a63',
  hazeDistance: 650,
  clouds: 0.65,
  rockLit: '#e05a35',
  rockShade: '#5e2a35',
  rockStrata: '#f39a6a',
  dirt: '#bf7a4f',
  sand: '#d99566',
  banners: ['#7b3fc2', '#f2b632', '#f2f2f2'],
};

const morning: Theme = {
  ...noon,
  skyTop: '#3f8ae0',
  skyHorizon: '#d9eef5',
  sunColor: '#fff6e8',
  sunAzimuth: 4.1,
  sunElevation: 0.38,
  haze: '#e3d0bb',
  hazeDistance: 1000,
  clouds: 0.3,
  rockLit: '#c9693f',
  rockShade: '#7d3f31',
  rockStrata: '#e6b98c',
  dirt: '#d6a571',
  sand: '#e5bf8d',
  scrub: '#6f7a33',
  banners: ['#1f9e8f', '#e36b2c', '#f2f2f2'],
};

export const TRACKS: TrackDef[] = [
  {
    id: 'redrock',
    name: 'Redrock Run',
    blurb: 'Wide sweepers under the stands. A gentle start.',
    width: 48,
    widthVar: 0.12,
    ...course(
      [[300, 35, 420], [260, -55, 380], [320, 70, 340], [200, -30, 500], [340, -60, 300], [260, 75, 320], [300, -40, 400], [280, -50, 380], [320, 65, 340], [260, -35, 450], [300, 45, 400], [260, -60, 360], [380, 0, 0]],
      [[0, 0], [0.25, 12], [0.5, -6], [0.75, 8], [1, 0]],
      [0.18, 0.4, 0.62, 0.84],
      [[0.08, 0], [0.3, 0.4], [0.52, -0.3], [0.73, 0], [0.93, 0.3]],
    ),
    theme: noon,
    seed: 11,
  },
  {
    id: 'falls',
    name: 'Thunder Falls',
    blurb: 'Bridges over the gorge and a long run past the waterfalls.',
    width: 44,
    widthVar: 0.15,
    ...course(
      [[260, -45, 300], [300, 60, 280], [220, 50, 360], [360, -80, 260], [280, -30, 420], [340, 65, 300], [250, -50, 340], [300, -40, 320], [260, 55, 300], [300, -45, 360], [260, 60, 320], [400, 0, 0]],
      [[0, 0], [0.2, 16], [0.45, 4], [0.62, -8], [0.85, 10], [1, 4]],
      [0.2, 0.42, 0.7, 0.88],
      [[0.1, 0.3], [0.33, -0.3], [0.56, 0], [0.78, 0.4]],
    ),
    theme: noon,
    seed: 23,
  },
  {
    id: 'mesa',
    name: 'Mesa Run',
    blurb: 'Golden hour on the mesa tops. Long straights, tight hairpins.',
    width: 44,
    widthVar: 0.2,
    ...course(
      [[500, 95, 140], [380, -100, 150], [450, 40, 400], [300, -95, 160], [520, 70, 220], [400, -85, 160], [420, 90, 150], [350, -40, 300], [350, 0, 0]],
      [[0, 0], [0.15, 24], [0.4, 6], [0.6, -10], [0.85, 14], [1, 10]],
      [0.18, 0.4, 0.62, 0.82],
      [[0.08, 0.4], [0.36, 0], [0.62, -0.4], [0.9, 0]],
    ),
    theme: golden,
    seed: 37,
  },
  {
    id: 'spires',
    name: 'Needle Spires',
    blurb: 'Rock walls close across the canyon. Find the gap and thread it.',
    width: 42,
    widthVar: 0.1,
    ...course(
      [[240, 40, 200], [140, -70, 180], [140, 75, 180], [140, -70, 180], [200, 45, 260], [260, -60, 220], [160, 70, 200], [160, -65, 200], [180, 60, 200], [160, -70, 190], [200, 55, 220], [160, -60, 200], [220, 50, 240], [380, 0, 0]],
      [[0, 0], [0.2, 10], [0.35, -6], [0.55, 12], [0.8, -4], [1, 0]],
      [0.28, 0.56, 0.8],
      [[0.12, -0.4], [0.42, 0.4], [0.68, 0], [0.9, 0]],
    ),
    theme: morning,
    seed: 41,
  },
  {
    id: 'archway',
    name: 'Archway Gorge',
    blurb: 'Through the great arch and down into the gorge.',
    width: 42,
    widthVar: 0.18,
    ...course(
      [[320, -50, 260], [260, 85, 220], [300, -40, 380], [220, -70, 200], [340, 90, 240], [280, -35, 400], [300, 60, 260], [240, -80, 220], [280, 45, 320], [260, -50, 300], [400, 0, 0]],
      [[0, 0], [0.2, 30], [0.38, 26], [0.6, -20], [0.8, -6], [1, -10]],
      [0.2, 0.42, 0.66, 0.86],
      [[0.12, 0], [0.38, -0.4], [0.63, 0.4], [0.9, 0]],
    ),
    theme: golden,
    seed: 53,
  },
  {
    id: 'dustbowl',
    name: 'Dust Bowl Dash',
    blurb: 'Short, fast and crowded. Elbows out.',
    width: 46,
    widthVar: 0.08,
    ...course(
      [[420, 60, 260], [300, -90, 220], [380, 70, 260], [350, -60, 280], [300, 40, 300], [450, 0, 0]],
      [[0, 0], [0.3, 8], [0.55, -4], [0.8, 6], [1, 0]],
      [0.3, 0.55, 0.8],
      [[0.15, 0], [0.55, 0.4], [0.88, 0]],
    ),
    theme: morning,
    seed: 67,
  },
  {
    id: 'sunspire',
    name: 'Sunspire Stage',
    blurb: 'Racing into the setting sun. Watch the glare.',
    width: 42,
    widthVar: 0.16,
    ...course(
      [[280, 50, 220], [200, -75, 200], [260, 40, 320], [220, -60, 240], [300, 80, 200], [240, -45, 300], [200, 55, 260], [220, -60, 240], [260, 70, 220], [200, -50, 280], [240, 45, 260], [380, 0, 0]],
      [[0, 0], [0.2, 18], [0.4, 4], [0.6, 22], [0.8, -6], [1, 0]],
      [0.2, 0.46, 0.7, 0.9],
      [[0.1, 0.4], [0.33, -0.4], [0.58, 0], [0.8, 0.4]],
    ),
    theme: sunset,
    seed: 79,
  },
  {
    id: 'crown',
    name: 'The Crown',
    blurb: 'The championship course. Every corner bites.',
    width: 40,
    widthVar: 0.2,
    ...course(
      [[240, -60, 160], [180, 90, 150], [200, -45, 240], [160, -80, 160], [260, 100, 150], [180, -55, 200], [220, 60, 180], [160, -70, 170], [200, 75, 160], [180, -60, 170], [220, 80, 150], [160, -55, 180], [380, 0, 0]],
      [[0, 0], [0.12, 20], [0.3, 30], [0.42, 6], [0.6, -16], [0.8, 10], [1, 4]],
      [0.16, 0.38, 0.62, 0.84],
      [[0.08, 0], [0.28, 0.5], [0.52, -0.4], [0.73, 0.4], [0.93, -0.3]],
    ),
    theme: sunset,
    seed: 97,
  },
];

export function trackById(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
