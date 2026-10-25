// A race track: an open centreline spline sampled every SAMPLE_STEP metres into frames (position, tangent, right,
// up, width, curvature, bank). Physics, AI and every visual module work in track space: `s` is the distance along the
// centreline from its first point (0..length), `x` the lateral offset from it (positive = right of the direction of
// travel), and the frame at `s` turns that back into a world position. Courses are point-to-point: the grid sits on a
// run-up before the start line (startS), and a run-off after the finish line (finishS) gives pods room to stop.
// There is no road: the course is a corridor of open sand between rock walls, wide in the basins and narrow in the
// passes, and `width` is the distance between those walls. The track also owns what is in the corridor: jump ramps
// (sand ridges built into the ground's height), caves the course runs through, and the rock formations to steer round,
// which grow out of the walls (spurs, gates, rockfalls) or stand in the open (buttes, hoodoos).

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
export type ObstacleKind = 'spur' | 'boulder' | 'pillar' | 'island';

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
  /** Middle of the gorge bridge (themes with waterfalls), or null. Kept clear of jumps and rocks. */
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
    this.jumps = def.jumps.map((f) => {
      let lip = this.raceS(f);
      let best = Infinity;
      for (let g = Math.max(0.05, f - 0.06); g <= Math.min(0.95, f + 0.06); g += 0.004) {
        const score = bend(this.raceS(g)) + Math.abs(g - f) * 0.01;
        if (score < best) {
          best = score;
          lip = this.raceS(g);
        }
      }
      return { s0: lip - RAMP_LEN, lip, s1: lip + RAMP_DROP };
    });
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

    this.gorgeS = def.theme.waterfalls ? this.pickGorge() : null;
    this.caves = this.pickCaves();
    // The grid and the finish under the stands, the gorge bridge and the caves get fixed widths; elsewhere the corridor
    // breathes. Each blends over ~80 m.
    const fixed: [number, number, number][] = [
      [0, this.startS + 60, def.width * 1.1],
      [this.finishS - 120, approx, def.width * 1.1],
    ];
    if (this.gorgeS !== null) fixed.push([this.gorgeS - 130, this.gorgeS + 130, def.width]);
    for (const c of this.caves) fixed.push([c.s0 - 10, c.s1 + 10, CAVE_WIDTH]);
    for (const f of this.frames) {
      let w = f.width;
      for (const [a, b, fw] of fixed) {
        const d = f.s < a ? a - f.s : f.s > b ? f.s - b : 0;
        w += (fw - w) * (1 - smoothstep01(d / 80));
      }
      f.width = w;
    }
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
    return out.copy(f.pos).addScaledVector(f.right, x).addScaledVector(f.up, h);
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

  /** Bridge in the second half of the race, on the straightest stretch at least 250 m from any jump. */
  private pickGorge(): number {
    let best = this.raceS(0.62);
    let bestK = Infinity;
    for (let f = 0.5; f <= 0.76; f += 0.01) {
      const s = this.raceS(f);
      if (this.jumps.some((j) => Math.abs(j.lip - s) < 250)) continue;
      const k = this.maxCurvature(s - 120, 240);
      if (k < bestK) {
        bestK = k;
        best = s;
      }
    }
    return best;
  }

  /** Caves on gentle stretches clear of jumps, the gorge and the start and finish: one, or two on long courses. */
  private pickCaves(): Span[] {
    const r = rng(this.def.seed * 11 + 5);
    const out: Span[] = [];
    const windows = this.raceLength > 5200 ? [[0.26, 0.44], [0.62, 0.8]] : [[0.4, 0.62]];
    for (const [a, b] of windows) {
      const len = 170 + r() * 90;
      let best: number | null = null;
      let bestK = Infinity;
      for (let f = a; f <= b; f += 0.01) {
        const mid = this.raceS(f);
        if (this.jumps.some((j) => j.lip > mid - len / 2 - 160 && j.s0 < mid + len / 2 + 140)) continue;
        if (this.gorgeS !== null && Math.abs(this.gorgeS - mid) < len / 2 + 330) continue;
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

  /** True inside a cave, or within `margin` metres of one. */
  inCave(s: number, margin = 0) {
    return this.caves.some((c) => s > c.s0 - margin && s < c.s1 + margin);
  }

  /**
   * Rock formations every couple of hundred metres. Most grow out of the corridor walls: a spur (a ridge of blocks
   * reaching a third to half way across), a gate (spurs from both walls with a gap between), a rockfall (boulders
   * tumbled out from one wall). In wider stretches a butte stands in the middle with room round either side, and
   * hoodoo pillars stand alone or in a pair with a gap only a pod on its side fits through. Never near the start, the
   * finish, a jump's kicker and landing, a boost pad, the gorge bridge or inside a cave.
   */
  private placeObstacles(): Obstacle[] {
    const r = rng(this.def.seed * 31 + 7);
    const out: Obstacle[] = [];
    const pads = this.def.boostPads.map(([f]) => this.raceS(f));
    const blocked = (s: number) =>
      this.jumps.some((j) => s > j.s0 - 60 && s < j.s1 + 110) ||
      pads.some((p) => Math.abs(p - s) < 45) ||
      (this.gorgeS !== null && Math.abs(this.gorgeS - s) < 170) ||
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
      if (w > 62 && kind < 0.22) {
        // Butte in the middle: a few big blocks along the course, a lane of at least 15 m either side.
        const x = (r() * 2 - 1) * Math.max(0, hw - 28) * 0.4;
        const big = Math.min(6.5, (hw - 18 - Math.abs(x)) / 1.6);
        for (let k = 0; k < 4; k++) rock(s + k * big * 1.3, x + (r() - 0.5) * 2, big * (1 - k * 0.15), (18 + r() * 12) * (1 - k * 0.12), 'island', 0, k / 3);
        group++;
      } else if (kind < 0.45) {
        spur(s, side, w * (0.35 + r() * 0.17));
      } else if (kind < 0.62) {
        // Gate: spurs from both walls, a gap of 18-26 m somewhere across the middle.
        const gap = 18 + r() * 8;
        const c = (r() * 2 - 1) * hw * 0.3;
        spur(s, -1, Math.max(4, hw + c - gap / 2));
        spur(s + (r() - 0.5) * 8, 1, Math.max(4, hw - c - gap / 2));
      } else if (kind < 0.8) {
        // Rockfall: a heap of boulders tumbled out of one wall, smaller towards its toe.
        const n = 4 + Math.floor(r() * 3);
        const reach = w * (0.25 + r() * 0.12);
        for (let k = 0; k < n; k++) {
          const t = k / (n - 1);
          const rad = 3.6 - 1.3 * t + r() * 0.5;
          rock(s + t * 14 + (r() - 0.5) * 6, side * (hw + 1 - rad - t * reach), rad, rad * 1.4, 'boulder', side, t);
        }
        group++;
      } else if (kind < 0.92 || w < 50) {
        // A lone hoodoo.
        const rad = 2.6 + r() * 0.8;
        rock(s, (r() * 2 - 1) * 0.5 * hw, rad, 12 + r() * 6, 'pillar', 0, 0);
        group++;
      } else {
        // Needle: two hoodoos, edges 4.6 m apart; a pod is 6.8 m wide flat and about 3 m on its side.
        const rad = 3 + r() * 0.6;
        const xc = (r() * 2 - 1) * 0.25 * hw;
        for (const sd of [-1, 1]) {
          rock(s, xc + sd * (2.3 + rad), rad, 13 + r() * 5, 'pillar', 0, 0);
          group++;
        }
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
