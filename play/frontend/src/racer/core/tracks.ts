// Every circuit in the game: its centreline, width, laps and the look of the world around it (Theme). All tracks are
// desert canyon circuits in the painted, sun-baked style of the concept art; themes vary the time of day, rock and
// sand colours and which set pieces (waterfalls, arches, sky city, grandstands) appear.

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
  laps: number;
  /** Road width in metres. */
  width: number;
  /** Relative width variation 0..0.3 (wider straights / narrow sections). */
  widthVar?: number;
  /** Banking strength: bank angle = curvature * bank (radians, clamped). */
  bank?: number;
  /** Closed centreline control points: [x, z, y]. Direction of travel is the order of the points. */
  points: [number, number, number?][];
  /** Positions of boost pads: fraction of the lap and lateral offset as a fraction of half the width (-1..1). */
  boostPads: [number, number][];
  theme: Theme;
  /** Seed for scenery placement. */
  seed: number;
}

/**
 * Closed centreline drawn like a circuit plan: corner vertices [x, z, radius] (metres, seen from above with +z towards
 * the viewer) joined by straights, each corner rounded with a bend of that radius. The start line sits on the straight
 * from the last vertex into the first, `start` of the way along it. `hills` are [lap fraction, height] keys, eased in
 * between. Points come out every ~`step` metres for the spline.
 */
function circuit(vertices: [number, number, number][], hills: [number, number][] = [[0, 0]], start = 0.5, step = 20): [number, number, number][] {
  const n = vertices.length;
  type P = { x: number; z: number };
  const corners = vertices.map(([x, z, r], i) => {
    const [ax, az] = vertices[(i - 1 + n) % n];
    const [bx, bz] = vertices[(i + 1) % n];
    const l1 = Math.hypot(x - ax, z - az);
    const l2 = Math.hypot(bx - x, bz - z);
    const d1 = { x: (x - ax) / l1, z: (z - az) / l1 };
    const d2 = { x: (bx - x) / l2, z: (bz - z) / l2 };
    const turn = Math.atan2(d1.x * d2.z - d1.z * d2.x, d1.x * d2.x + d1.z * d2.z);
    // Tangent length, limited so neighbouring bends never overlap on a short straight.
    const t = Math.min(r * Math.tan(Math.abs(turn) / 2), 0.49 * Math.min(l1, l2));
    const radius = t / Math.tan(Math.max(1e-4, Math.abs(turn) / 2));
    const t1 = { x: x - d1.x * t, z: z - d1.z * t };
    const t2 = { x: x + d2.x * t, z: z + d2.z * t };
    // Centre: from t1, perpendicular to d1 towards the inside of the bend.
    const s = Math.sign(turn) || 1;
    const c = { x: t1.x - d1.z * radius * s, z: t1.z + d1.x * radius * s };
    return { t1, t2, c, turn, radius };
  });

  const pts: P[] = [];
  const line = (a: P, b: P) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const k = Math.max(1, Math.round(len / step));
    for (let i = 1; i <= k; i++) pts.push({ x: a.x + ((b.x - a.x) * i) / k, z: a.z + ((b.z - a.z) * i) / k });
  };
  const t2Last = corners[n - 1].t2;
  const t1First = corners[0].t1;
  const s0 = { x: t2Last.x + (t1First.x - t2Last.x) * start, z: t2Last.z + (t1First.z - t2Last.z) * start };
  pts.push(s0);
  let cur: P = s0;
  for (const c of corners) {
    line(cur, c.t1);
    const k = Math.max(2, Math.round((Math.abs(c.turn) * c.radius) / step));
    const vx = c.t1.x - c.c.x;
    const vz = c.t1.z - c.c.z;
    for (let i = 1; i <= k; i++) {
      const a = (c.turn * i) / k;
      pts.push({ x: c.c.x + vx * Math.cos(a) - vz * Math.sin(a), z: c.c.z + vx * Math.sin(a) + vz * Math.cos(a) });
    }
    cur = c.t2;
  }
  line(cur, s0);
  pts.pop(); // back at the start

  const dist = [0];
  for (let i = 1; i < pts.length; i++) dist.push(dist[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const total = dist[dist.length - 1] + Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z);
  const keys = [...hills].sort((p, q) => p[0] - q[0]);
  const height = (f: number) => {
    for (let i = 0; i < keys.length; i++) {
      const [f0, y0] = keys[i];
      const [f1, y1] = i + 1 < keys.length ? keys[i + 1] : [keys[0][0] + 1, keys[0][1]];
      const ff = f < keys[0][0] ? f + 1 : f;
      if (ff >= f0 && ff <= f1) return y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos(((ff - f0) / Math.max(1e-6, f1 - f0)) * Math.PI));
    }
    return keys[0][1];
  };
  return pts.map((p, i) => [p.x, p.z, height(dist[i] / total)]);
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
    laps: 3,
    width: 34,
    widthVar: 0.12,
    points: circuit([[0, -600, 260], [-540, -780, 350], [-1140, -420, 220], [-900, 60, 400], [-1080, 420, 200], [-360, 540, 300], [60, 300, 260]], [[0, 0], [0.25, 12], [0.5, -6], [0.75, 8]]),
    boostPads: [[0.155, 0], [0.29, 0.4], [0.655, -0.3]],
    theme: noon,
    seed: 11,
  },
  {
    id: 'falls',
    name: 'Thunder Falls',
    blurb: 'Bridges over the gorge and a long run past the waterfalls.',
    laps: 3,
    width: 30,
    widthVar: 0.15,
    points: circuit([[0, -500, 220], [-560, -780, 300], [-1230, -560, 180], [-1290, 0, 160], [-780, -110, 200], [-560, 390, 160], [110, 390, 220]], [[0, 0], [0.2, 16], [0.45, 4], [0.62, -8], [0.85, 10]]),
    boostPads: [[0.125, 0.3], [0.275, -0.3], [0.665, 0], [0.78, 0.4]],
    theme: noon,
    seed: 23,
  },
  {
    id: 'mesa',
    name: 'Mesa Loop',
    blurb: 'Golden hour on the mesa tops. Long straights, tight hairpins.',
    laps: 3,
    width: 30,
    widthVar: 0.2,
    points: circuit([[0, -1000, 65], [-230, -1000, 65], [-380, -250, 300], [-700, 150, 180], [-600, 500, 90], [-150, 550, 200], [150, 250, 70], [350, 350, 70]], [[0, 0], [0.15, 24], [0.4, 6], [0.6, -10], [0.85, 14]]),
    boostPads: [[0.235, 0.4], [0.415, 0], [0.62, -0.4], [0.87, 0]],
    theme: golden,
    seed: 37,
  },
  {
    id: 'spires',
    name: 'Needle Spires',
    blurb: 'A slalom through the rock needles. Hold the inside.',
    laps: 3,
    width: 28,
    widthVar: 0.1,
    points: circuit([[0, -500, 200], [400, -650, 150], [650, -450, 130], [850, -550, 130], [1050, -350, 130], [1150, -500, 120], [1300, -150, 140], [1000, 300, 75], [600, 150, 160], [300, 400, 150], [-50, 300, 180]], [[0, 0], [0.2, 10], [0.35, -6], [0.55, 12], [0.8, -4]]),
    boostPads: [[0.13, -0.4], [0.52, 0.4], [0.65, 0]],
    theme: morning,
    seed: 41,
  },
  {
    id: 'archway',
    name: 'Archway Gorge',
    blurb: 'Through the great arch and down into the gorge.',
    laps: 3,
    width: 28,
    widthVar: 0.18,
    points: circuit([[0, -600, 180], [-500, -750, 250], [-900, -500, 90], [-750, -150, 200], [-1050, 250, 70], [-850, 450, 70], [-200, 300, 160], [100, 500, 140]], [[0, 0], [0.2, 30], [0.38, 26], [0.6, -20], [0.8, -6]]),
    boostPads: [[0.165, 0], [0.49, -0.4], [0.665, 0.4], [0.91, 0]],
    theme: golden,
    seed: 53,
  },
  {
    id: 'dustbowl',
    name: 'Dust Bowl',
    blurb: 'Short, fast and crowded. Elbows out.',
    laps: 4,
    width: 32,
    widthVar: 0.08,
    points: circuit([[760, -300, 190], [760, 300, 190], [220, 320, 110], [120, 270, 110], [0, 270, 110], [-100, 320, 110], [-640, 320, 170], [-640, -300, 170]], [[0, 0], [0.3, 8], [0.55, -4], [0.8, 6]]),
    boostPads: [[0.225, 0], [0.56, 0.4], [0.725, 0]],
    theme: morning,
    seed: 67,
  },
  {
    id: 'sunspire',
    name: 'Sunspire Circuit',
    blurb: 'Racing into the setting sun. Watch the glare.',
    laps: 3,
    width: 28,
    widthVar: 0.16,
    points: circuit([[0, -630, 150], [-360, -760, 100], [-630, -580, 160], [-900, -720, 120], [-1350, -630, 70], [-1300, -400, 70], [-900, -320, 200], [-630, -90, 140], [-360, 40, 140], [-400, 320, 90], [-40, 400, 160], [90, 140, 200]], [[0, 0], [0.2, 18], [0.4, 4], [0.6, 22], [0.8, -6]]),
    boostPads: [[0.118, 0.4], [0.335, -0.4], [0.49, 0], [0.585, 0.4], [0.93, -0.4]],
    theme: sunset,
    seed: 79,
  },
  {
    id: 'crown',
    name: 'The Crown',
    blurb: 'The championship course. Every corner bites.',
    laps: 3,
    width: 26,
    widthVar: 0.2,
    points: circuit([[0, -570, 90], [290, -620, 140], [450, -410, 110], [570, -490, 80], [900, -530, 60], [940, -290, 60], [570, -160, 160], [740, 160, 120], [980, 290, 70], [820, 570, 70], [330, 410, 180], [80, 570, 120], [-120, 330, 140]], [[0, 0], [0.12, 20], [0.3, 30], [0.42, 6], [0.6, -16], [0.8, 10]]),
    boostPads: [[0.265, 0], [0.395, 0.5], [0.61, -0.4], [0.675, 0.4], [0.92, -0.3]],
    theme: sunset,
    seed: 97,
  },
];

export function trackById(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}
