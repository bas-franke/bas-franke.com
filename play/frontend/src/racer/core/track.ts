// A race track: an open centreline spline sampled every SAMPLE_STEP metres into frames (position, tangent, right,
// up, width, curvature, bank). Physics, AI and every visual module work in track space: `s` is the distance along the
// centreline from its first point (0..length), `x` the lateral offset from it (positive = right of the direction of
// travel), and the frame at `s` turns that back into a world position. Courses are point-to-point: the grid sits on a
// run-up before the start line (startS), and a run-off after the finish line (finishS) gives pods room to stop.
// There is no road: the course is a corridor of open sand between rock walls, wide in the basins and narrow in the
// passes, and `width` is the distance between those walls. The track also owns what is in the corridor: jump ramps
// (sand ridges built into the ground's height), caves the course runs through, and the rock formations to steer round,
// which all grow out of the walls (spurs, rockfalls, and gates and barriers that leave one or two gaps).
// On top of that come the set pieces: kickers (tall ramps across part of the corridor only), shortcuts (a lane on the
// inside of a bend behind a rock ridge, raised on a ledge or sunk into a tunnel, with rocks to weave round) and slot
// walls (barriers whose gaps only a pod rolled onto its side, Q/E, fits through). Kickers and shortcut lanes change the
// ground's height across the course: `lift(s, x)` is that height above the centreline's banked surface.

import * as THREE from 'three';
import type { TrackDef } from './tracks';

export const SAMPLE_STEP = 2;
/** Road before the start line (the grid) and after the finish line (braking room), metres. */
export const RUN_UP = 140;
export const RUN_OFF = 320;
/** Jump ramp: length of the kicker up to the lip, its height, and the steep drop back down after the lip. */
export const RAMP_LEN = 30;
export const RAMP_HEIGHT = 3.2;
export const RAMP_DROP = 12;
/** Corridor width inside a cave, metres. */
export const CAVE_WIDTH = 38;
/** Kicker: run-up length to the lip, height, drop behind the lip, half width of its top and the taper at its sides. */
export const KICKER_LEN = 36;
export const KICKER_HEIGHT = 6.5;
export const KICKER_DROP = 12;
export const KICKER_HALF = 10;
export const KICKER_TAPER = 5;
/** Shortcuts: corridor width there (times def.width), lane width, and the ledge's and tunnel's profiles. */
export const SHORTCUT_WIDTH = 2.1;
export const LANE_WIDTH = 18;
export const LEDGE_RISE = 7;
export const LEDGE_UP = 45;
export const LEDGE_DROP = 8;
export const TUNNEL_DEPTH = 5;
export const TUNNEL_DROP = 14;
export const TUNNEL_UP = 50;
/** Underside of a tunnel's roof above the corridor's surface, metres. */
export const ROOF_CLEAR = 2.5;
/** Slot walls: the gap between two rocks (a flat pod needs 6.2 m, one on its side 2.4 m: at 5 m it has to be rolled
 * well over) and the corridor width. */
export const SLOT_GAP = 5;
export const SLOT_WIDTH = 1.3;
/** Depth of a slot formation along the course: from a single wall of rocks to a small rock massif. */
export const SLOT_LEN_MIN = 4;
export const SLOT_LEN_MAX = 44;

export interface Frame {
  /** Distance from the start of the centreline, metres. */
  s: number;
  pos: THREE.Vector3;
  /** Unit direction of travel. */
  tangent: THREE.Vector3;
  /** Unit vector to the right of the direction of travel, in the (banked) road plane. */
  right: THREE.Vector3;
  /** Road surface normal (banked). */
  up: THREE.Vector3;
  /** Full road width at this point, metres. */
  width: number;
  /** Signed curvature in 1/m about world up: positive = the road turns left. */
  kappa: number;
  /** Bank angle in radians, positive = the road's right edge is higher (left-hand turns bank this way). */
  bank: number;
}

/** What a rock formation looks like: a ridge of blocks out of a wall, a fallen boulder, a hoodoo pillar, a butte. */
export type ObstacleKind = 'spur' | 'boulder' | 'pillar' | 'island' | 'ridge' | 'slot';

/**
 * One collision circle of a rock formation: centre in track space, radius and height above the ground (pods in the
 * air clear it). Formations are chains of circles; `group` ties the circles of one formation together, `side` says
 * which wall it grows out of (0 = free-standing) and `t` how far along the chain from that wall it is (0..1).
 */
export interface Obstacle {
  s: number;
  x: number;
  r: number;
  h: number;
  kind: ObstacleKind;
  group: number;
  side: -1 | 0 | 1;
  t: number;
}

export interface Span {
  s0: number;
  s1: number;
}

export interface Jump {
  /** Foot of the kicker, the lip, and the bottom of the drop. */
  s0: number;
  lip: number;
  s1: number;
}

/** A tall ramp across part of the corridor: foot, lip, bottom of the drop, and the lateral centre of its top. */
export interface Kicker {
  s0: number;
  lip: number;
  s1: number;
  x: number;
}

/**
 * A shortcut lane on the inside of a bend, between the corridor wall on `side` and a rock ridge at |x| = xIn: from s0
 * it climbs onto a ledge (and flies off its lip at s1) or drops into a tunnel (roofed from roof0 to roof1, climbing
 * back out by s1). xOut is the corridor's half width there.
 */
export interface Shortcut {
  kind: 'ledge' | 'tunnel';
  side: -1 | 1;
  s0: number;
  s1: number;
  xIn: number;
  xOut: number;
  roof0: number;
  roof1: number;
}

/**
 * A rock formation right across the corridor with narrow slots (centres `gaps`) that only a pod on its side gets
 * through: from `s` to `s + len`, a single wall when short, a canyon through a small rock massif when long.
 */
export interface SlotWall {
  s: number;
  len: number;
  gaps: number[];
}

export class Track {
  readonly frames: Frame[] = [];
  readonly length: number;
  readonly curve: THREE.CatmullRomCurve3;
  /** Start and finish lines. */
  readonly startS: number;
  readonly finishS: number;
  readonly jumps: Jump[];
  readonly obstacles: Obstacle[];
  /** Caves the course runs through: the corridor narrows and a rock roof closes over it. */
  readonly caves: Span[];
  readonly kickers: Kicker[] = [];
  readonly shortcuts: Shortcut[];
  readonly slotWalls: SlotWall[];
  /** Boost pad centres in track space: the course's own (def.boostPads) and one in each shortcut lane. */
  readonly pads: { s: number; x: number }[];
  /** Middles of the gorge bridges (themes with waterfalls: one per block of the course), kept clear of jumps and rocks. */
  readonly gorges: number[];
  /** The first gorge bridge, or null. */
  readonly gorgeS: number | null;
  /** 2D outline for the minimap, normalised to a 0..1 square (x right, y down), one point per ~10 m. */
  readonly minimap: { points: [number, number][]; project(p: THREE.Vector3): [number, number] };
  /** Axis-aligned bounds of the centreline. */
  readonly bounds = new THREE.Box3();
  private readonly step: number;

  constructor(readonly def: TrackDef) {
    const pts = def.points.map(([x, z, y = 0]) => new THREE.Vector3(x, y, z));
    this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const approx = this.curve.getLength();
    const n = Math.max(64, Math.round(approx / SAMPLE_STEP));
    const spaced = this.curve.getSpacedPoints(n);
    this.length = approx;
    const step = (this.step = approx / n);
    this.startS = RUN_UP;
    this.finishS = approx - RUN_OFF;

    // Curvature from the change of heading in the ground plane, smoothed so banking does not wobble.
    const last = spaced.length - 1;
    const flat = spaced.map((_, i) => spaced[Math.min(last, i + 1)].clone().sub(spaced[Math.max(0, i - 1)]).setY(0).normalize());
    const raw = flat.map((a, i) => {
      if (i === last) return 0;
      const b = flat[i + 1];
      let d = Math.atan2(-b.x, -b.z) - Math.atan2(-a.x, -a.z);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return d / step;
    });
    raw[last] = raw[last - 1];
    const kappa = smooth(raw, 6);

    // Jump ramps are part of the road's height: a kicker that steepens up to the lip, then a short steep drop. Each
    // lip moves to the straightest stretch near where the track asks for it, so pods take off and land going straight.
    const bend = (lip: number) => {
      let k = 0;
      for (let d = -RAMP_LEN - 40; d <= 140; d += 4) k = Math.max(k, Math.abs(kappa[Math.max(0, Math.min(last, Math.round((lip + d) / step)))]));
      return k;
    };
    const ramps = def.jumps.map((f) => {
      let lip = this.raceS(f);
      let best = Infinity;
      // Search +-0.06 of a base layout's race, wherever the jump is on a long course.
      const win = 0.06 / this.blocks;
      for (let g = Math.max(0.05 / this.blocks, f - win); g <= Math.min(1 - 0.05 / this.blocks, f + win); g += 0.004 / this.blocks) {
        const score = bend(this.raceS(g)) + Math.abs(g - f) * this.blocks * 0.01;
        if (score < best) {
          best = score;
          lip = this.raceS(g);
        }
      }
      return { s0: lip - RAMP_LEN, lip, s1: lip + RAMP_DROP };
    });
    // Every second jump is a kicker instead: higher, and only across part of the corridor (beside it pods race on).
    this.jumps = ramps.filter((_, i) => i % 2 === 0);
    const kr = rng(def.seed * 29 + 11);
    const kickRoom = Math.max(0, def.width * 0.7 - KICKER_HALF - KICKER_TAPER - 6);
    for (const j of ramps.filter((_, i) => i % 2 === 1)) {
      const lip = j.lip + RAMP_LEN - KICKER_LEN;
      this.kickers.push({ s0: lip - KICKER_LEN, lip, s1: lip + KICKER_DROP, x: (kr() * 2 - 1) * kickRoom });
    }
    spaced.forEach((p, i) => (p.y += this.rampHeight(i * step)));
    const tangents = spaced.map((_, i) => spaced[Math.min(last, i + 1)].clone().sub(spaced[Math.max(0, i - 1)]).normalize());
    // Openness along the course: a few slow waves with seeded phases, from narrow passes to wide sandy basins.
    const wr = rng(def.seed * 5 + 1);
    const ph = [wr(), wr(), wr()].map((v) => v * Math.PI * 2);
    const amp = 0.45 + (def.widthVar ?? 0.1) * 1.5;
    const widthAt = (s: number) => {
      const o = Math.sin(s / 300 + ph[0]) * 0.5 + Math.sin(s / 640 + ph[1]) * 0.35 + Math.sin(s / 150 + ph[2]) * 0.15;
      return def.width * (1.4 + amp * o);
    };

    const worldUp = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < spaced.length; i++) {
      const tangent = tangents[i];
      const k = kappa[i];
      const bank = THREE.MathUtils.clamp(k * (def.bank ?? 60), -0.32, 0.32);
      const flatRight = tangent.clone().cross(worldUp).normalize();
      const up = new THREE.Vector3().crossVectors(flatRight, tangent).normalize();
      // Banking rotates right/up around the tangent; a left turn (k > 0) raises the right edge.
      const q = new THREE.Quaternion().setFromAxisAngle(tangent, -bank);
      const right = flatRight.clone().applyQuaternion(q);
      up.applyQuaternion(q);
      this.frames.push({ s: i * step, pos: spaced[i], tangent, right, up, width: widthAt(i * step), kappa: k, bank });
      this.bounds.expandByPoint(spaced[i]);
    }

    this.gorges = def.theme.waterfalls ? this.pickGorges() : [];
    this.gorgeS = this.gorges[0] ?? null;
    this.caves = this.pickCaves();
    // The grid and the finish under the stands, the gorge bridge and the caves get fixed widths; elsewhere the corridor
    // breathes. Each blends over ~80 m.
    const fixed: [number, number, number][] = [
      [0, this.startS + 60, def.width * 1.1],
      [this.finishS - 120, approx, def.width * 1.1],
    ];
    for (const g of this.gorges) fixed.push([g - 130, g + 130, def.width]);
    for (const c of this.caves) fixed.push([c.s0 - 10, c.s1 + 10, CAVE_WIDTH]);
    this.shortcuts = this.pickShortcuts();
    for (const c of this.shortcuts) fixed.push([c.s0 - 30, c.s1 + 30, def.width * SHORTCUT_WIDTH]);
    this.slotWalls = this.pickSlotWalls();
    for (const w of this.slotWalls) fixed.push([w.s - 30, w.s + w.len + 30, def.width * SLOT_WIDTH]);
    for (const f of this.frames) {
      let w = f.width;
      for (const [a, b, fw] of fixed) {
        const d = f.s < a ? a - f.s : f.s > b ? f.s - b : 0;
        w += (fw - w) * (1 - smoothstep01(d / 80));
      }
      f.width = w;
    }
    this.pads = def.boostPads.map(([frac, lat]) => {
      const s = this.raceS(frac);
      return { s, x: lat * (this.frameAt(s).width / 2 - 6) };
    });
    // The lane's pad is the shortcut's reward: on the ledge's top, or where pods land in the tunnel.
    for (const c of this.shortcuts) this.pads.push({ s: c.kind === 'ledge' ? c.s0 + LEDGE_UP + 6 : c.roof0 + 4, x: c.side * (c.xIn + LANE_WIDTH / 2 + 1.5) });
    this.kickers.push(...this.pickKickers());
    this.kickers.sort((a, b) => a.lip - b.lip);
    this.obstacles = this.placeObstacles();

    const size = this.bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z) * 1.08;
    const cx = (this.bounds.min.x + this.bounds.max.x) / 2;
    const cz = (this.bounds.min.z + this.bounds.max.z) / 2;
    const project = (p: THREE.Vector3): [number, number] => [0.5 + (p.x - cx) / span, 0.5 + (p.z - cz) / span];
    const points: [number, number][] = [];
    for (let i = 0; i < this.frames.length; i += 5) points.push(project(this.frames[i].pos));
    points.push(project(this.frames[last].pos));
    this.minimap = { points, project };
  }

  /** Length of the race, start line to finish line. */
  get raceLength() {
    return this.finishS - this.startS;
  }

  /** Track distance of a fraction of the race (0 = start line, 1 = finish line). */
  raceS(frac: number) {
    return this.startS + frac * (this.finishS - this.startS);
  }

  /** How many times the base layout repeats along the course (TrackDef.blocks). */
  get blocks() {
    return Math.max(1, Math.round(this.def.blocks ?? 1));
  }

  /** Race fraction of fraction f (0..1) of block k. */
  private blockF(k: number, f: number) {
    return (k + f) / this.blocks;
  }

  /** Windows [a, b] given as fractions of a base layout's race, repeated in every block, as fractions of the race. */
  private perBlock(windows: number[][]): [number, number][] {
    const out: [number, number][] = [];
    for (let k = 0; k < this.blocks; k++) for (const [a, b] of windows) out.push([this.blockF(k, a), this.blockF(k, b)]);
    return out;
  }

  /** Race length of one block: what the counts of set pieces are based on. */
  get blockLength() {
    return this.raceLength / this.blocks;
  }

  clamp(s: number) {
    return Math.max(0, Math.min(this.length, s));
  }

  /** Extra road height from the jump ramps at s. */
  rampHeight(s: number) {
    for (const j of this.jumps) {
      if (s > j.s0 && s <= j.lip) return RAMP_HEIGHT * ((s - j.s0) / RAMP_LEN) ** 1.6;
      if (s > j.lip && s < j.s1) return RAMP_HEIGHT * (1 - (s - j.lip) / RAMP_DROP) ** 2;
    }
    return 0;
  }

  /**
   * Height of the ground above the centreline's banked surface at (s, x): kickers and shortcut lanes (a ledge is
   * higher, a tunnel lower), 0 everywhere else. Physics, the terrain and everything placed on the ground use it.
   */
  lift(s: number, x: number): number {
    let y = 0;
    for (const k of this.kickers) {
      if (s <= k.s0 || s >= k.s1) continue;
      const a = s <= k.lip ? ((s - k.s0) / (k.lip - k.s0)) ** 1.6 : (1 - (s - k.lip) / (k.s1 - k.lip)) ** 2;
      y += KICKER_HEIGHT * a * (1 - smoothstep01((Math.abs(x - k.x) - KICKER_HALF) / KICKER_TAPER));
    }
    for (const c of this.shortcuts) {
      const ledge = c.kind === 'ledge';
      if (s <= c.s0 || s >= c.s1 + (ledge ? LEDGE_DROP : 0)) continue;
      const u = x * c.side;
      // Under the ridge it blends to the field; beyond the corridor wall it fades into the sand.
      const across = smoothstep01((u - c.xIn + 2) / 3) * (1 - smoothstep01((u - c.xOut - 2) / 10));
      if (across <= 0) continue;
      y += this.laneProfile(c, s) * across;
    }
    return y;
  }

  /** A shortcut lane's height along it: up onto the ledge and off its lip, or down into the tunnel and back up. */
  laneProfile(c: Shortcut, s: number): number {
    if (c.kind === 'ledge') {
      if (s < c.s0 + LEDGE_UP) return LEDGE_RISE * smoothstep01((s - c.s0) / LEDGE_UP);
      if (s <= c.s1) return LEDGE_RISE;
      return LEDGE_RISE * Math.max(0, 1 - (s - c.s1) / LEDGE_DROP) ** 2;
    }
    if (s < c.s0 + TUNNEL_DROP) return -TUNNEL_DEPTH * (1 - (1 - Math.max(0, s - c.s0) / TUNNEL_DROP) ** 2);
    if (s > c.s1 - TUNNEL_UP) return -TUNNEL_DEPTH * (1 - smoothstep01((s - c.s1 + TUNNEL_UP) / TUNNEL_UP));
    return -TUNNEL_DEPTH;
  }

  /** The lowest the ground goes at s (a tunnel floor), for what has to stay under it. */
  lowest(s: number): number {
    let y = 0;
    for (const c of this.shortcuts) if (c.kind === 'tunnel' && s > c.s0 && s < c.s1) y = Math.min(y, this.laneProfile(c, s));
    return y;
  }

  /** The shortcut whose lane (s, x) is in, if any. */
  shortcutAt(s: number, x: number): Shortcut | undefined {
    return this.shortcuts.find((c) => s > c.s0 && s < c.s1 && x * c.side > c.xIn);
  }

  /** Interpolated frame at distance s (clamped to the track). Reuses `out` if given. */
  frameAt(s: number, out?: Frame): Frame {
    const n = this.frames.length;
    const f = this.clamp(s) / this.step;
    const i = Math.min(n - 2, Math.floor(f));
    const t = f - i;
    const a = this.frames[i];
    const b = this.frames[i + 1];
    const o = out ?? { s: 0, pos: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), width: 0, kappa: 0, bank: 0 };
    o.s = this.clamp(s);
    o.pos.lerpVectors(a.pos, b.pos, t);
    o.tangent.lerpVectors(a.tangent, b.tangent, t).normalize();
    o.right.lerpVectors(a.right, b.right, t).normalize();
    o.up.lerpVectors(a.up, b.up, t).normalize();
    o.width = a.width + (b.width - a.width) * t;
    o.kappa = a.kappa + (b.kappa - a.kappa) * t;
    o.bank = a.bank + (b.bank - a.bank) * t;
    return o;
  }

  /** World position of track-space (s, x) at height h above the road surface. */
  toWorld(s: number, x: number, h = 0, out = new THREE.Vector3()): THREE.Vector3 {
    const f = this.frameAt(s, scratch);
    return out.copy(f.pos).addScaledVector(f.right, x).addScaledVector(f.up, h).setY(out.y + this.lift(s, x));
  }

  /** Nearest track-space coordinates of a world point, searching around `hint` (an s) if given. */
  toTrack(p: THREE.Vector3, hint?: number): { s: number; x: number; h: number } {
    const n = this.frames.length;
    let best = 0;
    let bestD = Infinity;
    const from = hint === undefined ? 0 : Math.max(0, Math.round(this.clamp(hint) / this.step) - 40);
    const to = hint === undefined ? n : Math.min(n, from + 80);
    for (let i = from; i < to; i++) {
      const d = this.frames[i].pos.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const f = this.frames[best];
    const rel = p.clone().sub(f.pos);
    const along = rel.dot(f.tangent);
    return { s: this.clamp(f.s + along), x: rel.dot(f.right), h: rel.dot(f.up) };
  }

  /** Max |kappa| over [s, s + ahead]. */
  maxCurvature(s: number, ahead: number): number {
    let m = 0;
    for (let d = 0; d <= ahead; d += SAMPLE_STEP * 2) m = Math.max(m, Math.abs(this.frameAt(s + d, scratch).kappa));
    return m;
  }

  /** A bridge in the second half of each block, on the straightest stretch at least 250 m from any jump. */
  private pickGorges(): number[] {
    return this.perBlock([[0.5, 0.76]]).map(([a, b]) => {
      let best = this.raceS((a + b) / 2);
      let bestK = Infinity;
      for (let f = a; f <= b; f += 0.01 / this.blocks) {
        const s = this.raceS(f);
        if (this.jumps.some((j) => Math.abs(j.lip - s) < 250)) continue;
        const k = this.maxCurvature(s - 120, 240);
        if (k < bestK) {
          bestK = k;
          best = s;
        }
      }
      return best;
    });
  }

  /** Caves on gentle stretches clear of jumps, the gorges and the start and finish: one per block, or two on long
   * base layouts. */
  private pickCaves(): Span[] {
    const r = rng(this.def.seed * 11 + 5);
    const out: Span[] = [];
    const windows = this.perBlock(this.blockLength > 5200 ? [[0.26, 0.44], [0.62, 0.8]] : [[0.4, 0.62]]);
    for (const [a, b] of windows) {
      const len = 170 + r() * 90;
      let best: number | null = null;
      let bestK = Infinity;
      for (let f = a; f <= b; f += 0.01 / this.blocks) {
        const mid = this.raceS(f);
        if (this.jumps.some((j) => j.lip > mid - len / 2 - 160 && j.s0 < mid + len / 2 + 140)) continue;
        if (this.gorges.some((g) => Math.abs(g - mid) < len / 2 + 330)) continue;
        const k = this.maxCurvature(mid - len / 2 - 40, len + 80);
        if (k < bestK) {
          bestK = k;
          best = mid;
        }
      }
      if (best !== null) out.push({ s0: best - len / 2, s1: best + len / 2 });
    }
    return out;
  }

  /** Mean curvature over [s0, s1] (signed, + = turning left). */
  private meanCurvature(s0: number, s1: number) {
    let k = 0;
    let n = 0;
    for (let s = s0; s <= s1; s += SAMPLE_STEP * 2, n++) k += this.frameAt(s, scratch).kappa;
    return n ? k / n : 0;
  }

  /** True if [a, b] comes within `margin` of a jump, the gorge, a cave or a boost pad. */
  private busy(a: number, b: number, margin: number) {
    const near = (s0: number, s1: number, m = margin) => s1 > a - m && s0 < b + m;
    return (
      this.jumps.some((j) => near(j.s0, j.s1 + 140)) ||
      this.kickers.some((k) => near(k.s0, k.s1 + 220)) ||
      this.gorges.some((g) => near(g - 170, g + 170)) ||
      this.caves.some((c) => near(c.s0, c.s1)) ||
      this.def.boostPads.some(([f]) => near(this.raceS(f) - 20, this.raceS(f) + 20, 30))
    );
  }

  /**
   * Shortcut lanes on the insides of the most sustained bends: two per block, three on long base layouts, ledges and
   * tunnels in turn.
   * The lane hugs the inside, so it is shorter than the racing line round the outside of the field.
   */
  private pickShortcuts(): Shortcut[] {
    const r = rng(this.def.seed * 17 + 3);
    const count = this.blockLength > 4500 ? 3 : 2;
    const picked: { s0: number; s1: number; k: number }[] = [];
    for (const [a, b] of this.perBlock([[0, 1]])) {
      const cands: typeof picked = [];
      for (let f = Math.max(a, 0.1 / this.blocks); f <= Math.min(b, 1 - 0.1 / this.blocks); f += 0.005 / this.blocks) {
        const len = 250;
        const mid = this.raceS(f);
        const s0 = mid - len / 2;
        const s1 = mid + len / 2;
        if (s0 < this.startS + 260 || s1 > this.finishS - 300 || this.busy(s0, s1 + 120, 30)) continue;
        cands.push({ s0, s1, k: this.meanCurvature(s0, s1) });
      }
      cands.sort((p, q) => Math.abs(q.k) - Math.abs(p.k));
      let n = 0;
      for (const c of cands) {
        if (n >= count) break;
        if (picked.some((p) => c.s1 + 250 > p.s0 && c.s0 - 250 < p.s1)) continue;
        picked.push(c);
        n++;
      }
    }
    picked.sort((a, b) => a.s0 - b.s0);
    const hw = (this.def.width * SHORTCUT_WIDTH) / 2;
    const first = r() < 0.5 ? 0 : 1;
    return picked.map((c, i): Shortcut => {
      const kind = (i + first) % 2 === 0 ? 'ledge' : 'tunnel';
      // The tunnel is a little longer: pods fly the first stretch after dropping in, so the roof starts later.
      const s1 = kind === 'tunnel' ? c.s1 + 30 : c.s1;
      return {
        kind,
        side: c.k > 0 ? -1 : 1,
        s0: c.s0,
        s1,
        xIn: hw - LANE_WIDTH,
        xOut: hw,
        roof0: c.s0 + 62,
        roof1: s1 - TUNNEL_UP + 6,
      };
    });
  }

  /**
   * Slot formations on straight stretches, one at a time (never one straight behind another): two per block, three
   * on long base layouts. Each is a different depth, from a single wall to a massif with a canyon through it, and has two slots.
   */
  private pickSlotWalls(): SlotWall[] {
    const r = rng(this.def.seed * 23 + 9);
    const runs = this.blockLength > 5200 ? 3 : 2;
    const out: SlotWall[] = [];
    const taken: [number, number][] = this.shortcuts.map((c) => [c.s0 - 150, c.s1 + 250]);
    const windows = this.perBlock(runs === 3 ? [[0.2, 0.4], [0.45, 0.65], [0.7, 0.88]] : [[0.25, 0.48], [0.58, 0.85]]);
    // Depths for this course's formations, shuffled so a course gets a mix: a wall, a short block, a long massif.
    const depths = [SLOT_LEN_MIN + r() * 4, 14 + r() * 10, 30 + r() * (SLOT_LEN_MAX - 30)].sort(() => r() - 0.5);
    windows.forEach(([a, b], i) => {
      const len = depths[i % depths.length];
      let best: number | null = null;
      let bestK = Infinity;
      for (let f = a; f <= b; f += 0.005 / this.blocks) {
        const s0 = this.raceS(f);
        const s1 = s0 + len;
        if (this.busy(s0, s1, 70) || taken.some(([t0, t1]) => s1 + 60 > t0 && s0 - 60 < t1)) continue;
        const k = this.maxCurvature(s0 - 80, len + 120);
        if (k < bestK) {
          bestK = k;
          best = s0;
        }
      }
      if (best === null) return;
      taken.push([best - 100, best + len + 100]);
      // Two slots, well apart.
      const hw = (this.def.width * SLOT_WIDTH) / 2;
      const g1 = -hw + 8 + r() * (hw - 12);
      const g2 = Math.min(hw - 8, g1 + 16 + r() * (hw - 12));
      out.push({ s: best, len, gaps: [g1, g2] });
    });
    return out.sort((a, b) => a.s - b.s);
  }

  /** Extra kickers on straight stretches clear of everything else (one per block, two on long base layouts), off to
   * one side or the middle. */
  private pickKickers(): Kicker[] {
    const r = rng(this.def.seed * 31 + 5);
    const count = this.blockLength > 5200 ? 2 : 1;
    const out: Kicker[] = [];
    const taken: [number, number][] = [
      ...this.shortcuts.map((c): [number, number] => [c.s0 - 150, c.s1 + 250]),
      ...this.slotWalls.map((w): [number, number] => [w.s - 150, w.s + w.len + 150]),
    ];
    for (const [a, b] of this.perBlock([[0, 1]])) {
      const cands: { lip: number; k: number }[] = [];
      for (let f = Math.max(a, 0.1 / this.blocks); f <= Math.min(b, 1 - 0.1 / this.blocks); f += 0.005 / this.blocks) {
        const lip = this.raceS(f);
        const s0 = lip - KICKER_LEN;
        if (s0 < this.startS + 250 || lip + 300 > this.finishS || this.busy(s0, lip + 220, 30)) continue;
        if (taken.some(([t0, t1]) => lip + 240 > t0 && s0 - 40 < t1)) continue;
        cands.push({ lip, k: this.maxCurvature(s0 - 60, KICKER_LEN + 340) });
      }
      cands.sort((p, q) => p.k - q.k);
      let n = 0;
      for (const c of cands) {
        if (n >= count) break;
        if ([...out, ...this.kickers].some((k) => Math.abs(k.lip - c.lip) < 500)) continue;
        const hw = this.frameAt(c.lip).width / 2;
        const room = Math.max(0, hw - KICKER_HALF - KICKER_TAPER - 9);
        out.push({ s0: c.lip - KICKER_LEN, lip: c.lip, s1: c.lip + KICKER_DROP, x: (r() * 2 - 1) * room });
        n++;
      }
    }
    return out.sort((a, b) => a.lip - b.lip);
  }

  /** True inside a cave, or within `margin` metres of one. */
  inCave(s: number, margin = 0) {
    return this.caves.some((c) => s > c.s0 - margin && s < c.s1 + margin);
  }

  /**
   * Rock formations every couple of hundred metres, all grown out of the corridor walls: a spur (a ridge of blocks
   * reaching a third to half way across), a gate (spurs from both walls with one gap between), a rockfall (boulders
   * tumbled out from one wall) and, in wider stretches, a barrier right across the course with two gaps. Nothing stands
   * loose in the open. Never near the start, the finish, a jump's kicker and landing, a boost pad, the gorge bridge or
   * inside a cave.
   */
  private placeObstacles(): Obstacle[] {
    const r = rng(this.def.seed * 31 + 7);
    const out: Obstacle[] = [];
    const pads = this.def.boostPads.map(([f]) => this.raceS(f));
    const blocked = (s: number) =>
      this.jumps.some((j) => s > j.s0 - 60 && s < j.s1 + 110) ||
      this.kickers.some((k) => s > k.s0 - 60 && s < k.lip + 280) ||
      this.shortcuts.some((c) => s > c.s0 - 90 && s < c.s1 + (c.kind === 'ledge' ? 200 : 60)) ||
      this.slotWalls.some((w) => s > w.s - 90 && s < w.s + w.len + 90) ||
      pads.some((p) => Math.abs(p - s) < 45) ||
      this.gorges.some((g) => Math.abs(g - s) < 170) ||
      this.inCave(s, 70);
    let group = 0;
    const rock = (s: number, x: number, rad: number, h: number, kind: ObstacleKind, side: -1 | 0 | 1, t: number) =>
      out.push({ s, x, r: rad, h, kind, group, side, t });
    /** A ridge out of the wall on `side`, reaching `reach` metres into the corridor and leaning a little along it. */
    const spur = (s: number, side: -1 | 1, reach: number) => {
      const hw = this.frameAt(s).width / 2;
      const lean = (r() - 0.3) * 0.5;
      const top = 11 + r() * 9;
      // Circle centres step in from the wall until the next one would poke out past `reach`.
      let d = 0;
      for (let k = 0; k < 12; k++) {
        const t = Math.min(1, d / reach);
        const rad = Math.min(5.2 - 1.8 * t + r() * 0.8, reach * 0.6);
        if (k > 0 && d + rad > reach) break;
        rock(s + d * lean, side * (hw + 1 - d), rad, top * (1 - 0.45 * t), 'spur', side, t);
        d += rad * 1.2;
      }
      group++;
    };
    /** The middle of a barrier: a ridge of blocks across the course from x0 to x1, tallest in its middle. */
    const middle = (s: number, x0: number, x1: number, lean: number) => {
      const top = 12 + r() * 8;
      const n = Math.max(2, Math.round((x1 - x0) / 5));
      const rad = Math.min(5.5, ((x1 - x0) / n) * 0.75);
      for (let k = 0; k < n; k++) {
        const x = x0 + rad + ((x1 - x0 - 2 * rad) * k) / (n - 1);
        const t = Math.abs((k / (n - 1)) * 2 - 1);
        rock(s + x * lean + (r() - 0.5) * 2, x, rad, top * (1 - 0.3 * t), 'spur', 0, t);
      }
      group++;
    };
    // Shortcuts: the ridge between the lane and the field, and rocks to weave round in the lane (boulders on a ledge,
    // pillars holding up a tunnel's roof).
    for (const c of this.shortcuts) {
      const ledge = c.kind === 'ledge';
      const a = c.s0 + (ledge ? 14 : 10);
      const b = ledge ? c.s1 : c.s1 - 8;
      for (let ss = a; ss <= b; ss += 4.5) rock(ss, c.side * (c.xIn - 0.5), 3.4, 12, 'ridge', 0, (ss - a) / (b - a));
      group++;
      const lane = (u: number) => c.side * (c.xIn + u);
      const from = ledge ? c.s0 + LEDGE_UP + 20 : c.roof0 + 14;
      const to = ledge ? c.s1 - 30 : c.roof1 - 14;
      const n = Math.max(2, Math.floor((to - from) / 30));
      for (let k = 0; k <= n; k++) {
        const ss = from + ((to - from) * k) / n + (r() - 0.5) * 6;
        const u = k % 2 ? 13.5 : 5.5;
        if (ledge) rock(ss, lane(u), 2.4 + r() * 0.4, 3.4, 'boulder', 0, 0);
        else rock(ss, lane(u), 2.2, TUNNEL_DEPTH + ROOF_CLEAR + 0.5, 'pillar', 0, 0);
        group++;
      }
    }
    // Slot formations: rocks edge to edge across the corridor except for the slots, each SLOT_GAP wide, in rows every
    // few metres for the formation's depth. Rocks rise towards the middle of each block and of the formation's depth,
    // so a deep one reads as a small rock massif with canyons through it. Each block between two slots is its own
    // formation, so a pod pinned against it slides off towards the nearer slot.
    for (const w of this.slotWalls) {
      const rows = Math.max(1, Math.round(w.len / 4) + 1);
      const blocks: number[] = [];
      for (let row = 0; row < rows; row++) {
        const ss = rows === 1 ? w.s : w.s + (w.len * row) / (rows - 1);
        const along = rows === 1 ? 1 : Math.sin((Math.PI * row) / (rows - 1));
        const hw = this.frameAt(ss).width / 2;
        const edges = [-hw - 2, ...[...w.gaps].sort((p, q) => p - q).flatMap((g) => [g - SLOT_GAP / 2, g + SLOT_GAP / 2]), hw + 2];
        for (let k = 0; k < edges.length; k += 2) {
          const a = edges[k];
          const b = edges[k + 1];
          const rad = Math.max(1.4, Math.min(4.2, (b - a) / 2));
          const n = Math.max(1, Math.round((b - a - 2 * rad) / 6) + 1);
          blocks[k / 2] ??= group++;
          for (let j = 0; j < n; j++) {
            const x = n === 1 ? (a + b) / 2 : a + rad + ((b - a - 2 * rad) * j) / (n - 1);
            const mid = n === 1 ? 1 : Math.sin((Math.PI * (j + 0.5)) / n);
            const h = 10 + (4 + Math.min(18, w.len * 0.45)) * along * mid + r() * 3;
            out.push({ s: ss, x, r: rad, h, kind: 'slot', group: blocks[k / 2], side: 0, t: 0 });
          }
        }
      }
    }
    let s = this.startS + 320;
    while (s < this.finishS - 220) {
      if (blocked(s) || blocked(s + 120)) {
        s += 30;
        continue;
      }
      const w = this.frameAt(s).width;
      const hw = w / 2;
      const side: -1 | 1 = r() < 0.5 ? -1 : 1;
      const kind = r();
      if (w > 76 && kind < 0.3) {
        // Barrier with two gaps: spurs from both walls and a block of wall across the middle, so the corridor is shut
        // off except for two passes of 16-20 m. The middle takes 40-55% of the closed width, so it reads as a wall
        // across the course, not a lone rock.
        const gap = 16 + r() * 4;
        const closed = w - 2 * gap;
        const mid = closed * (0.4 + r() * 0.15);
        const rest = closed - mid;
        const a = rest * (0.3 + r() * 0.4);
        const lean = (r() - 0.5) * 0.15;
        spur(s, -1, a);
        spur(s + (r() - 0.5) * 6, 1, Math.max(4, rest - a));
        middle(s, -hw + a + gap, -hw + a + gap + mid, lean);
      } else if (kind < 0.48) {
        spur(s, side, w * (0.35 + r() * 0.17));
      } else if (kind < 0.8) {
        // Gate: spurs from both walls with one gap of 18-26 m, sometimes in the middle, sometimes hard by one wall.
        const gap = 18 + r() * 8;
        const c = (r() * 2 - 1) * Math.max(0, hw - gap / 2 - 5) * (r() < 0.4 ? 1 : 0.35);
        spur(s, -1, Math.max(4, hw + c - gap / 2));
        spur(s + (r() - 0.5) * 8, 1, Math.max(4, hw - c - gap / 2));
      } else {
        // Rockfall: a heap of boulders tumbled out of one wall, smaller towards its toe.
        const n = 4 + Math.floor(r() * 3);
        const reach = w * (0.25 + r() * 0.12);
        for (let k = 0; k < n; k++) {
          const t = k / (n - 1);
          const rad = 3.6 - 1.3 * t + r() * 0.5;
          rock(s + t * 14 + (r() - 0.5) * 6, side * (hw + 1 - rad - t * reach), rad, rad * 1.4, 'boulder', side, t);
        }
        group++;
      }
      s += 180 + r() * 150;
    }
    return out;
  }
}

function smoothstep01(t: number) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

const scratch: Frame = { s: 0, pos: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), width: 0, kappa: 0, bank: 0 };

function smooth(v: number[], radius: number): number[] {
  const n = v.length;
  return v.map((_, i) => {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += v[Math.max(0, Math.min(n - 1, i + k))];
    return sum / (radius * 2 + 1);
  });
}

/** Deterministic PRNG for scenery placement: the same track always looks the same. */
export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
