// Every course in the game: its centreline, width, jumps and the look of the world around it (Theme). For now there is
// one, Redrock Run, so its look can be polished against the concept art before more courses come back. All tracks are
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

/** Dusk in the red canyon, after the concept art: a magenta-violet sky over a hot orange horizon, the sun low behind
 * the spires, deep red rock with violet shade, rusty sand and thick orange dust. */
const dusk: Theme = {
  skyTop: '#6a3a9c',
  skyHorizon: '#ff9a56',
  sunColor: '#ffc27a',
  sunAzimuth: 0.35,
  sunElevation: 0.16,
  haze: '#e8764a',
  hazeDistance: 620,
  clouds: 0.6,
  rockLit: '#d9481f',
  rockShade: '#5a1f3a',
  rockStrata: '#f07a2a',
  dirt: '#a5502c',
  sand: '#b85a30',
  scrub: '#6b4a2a',
  waterfalls: false,
  arches: true,
  skyCity: false,
  banners: ['#5b2a8c', '#4a2373', '#f4d9ff'],
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
    theme: dusk,
    seed: 11,
  },
];

export function trackById(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
