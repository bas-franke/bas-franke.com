// A race track: an open centreline spline sampled every SAMPLE_STEP metres into frames (position, tangent, right,
// up, width, curvature, bank). Physics, AI and every visual module work in track space: `s` is the distance along the
// centreline from its first point (0..length), `x` the lateral offset from it (positive = right of the direction of
// travel), and the frame at `s` turns that back into a world position. Courses are point-to-point: the grid sits on a
// run-up before the start line (startS), and a run-off after the finish line (finishS) gives pods room to stop.
// The track also owns what is on the road: jump ramps (built into the road's height) and rock obstacles.

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

/** A rock on the road: centre in track space, radius and height above the road (pods in the air clear it). */
export interface Obstacle {
  s: number;
  x: number;
  r: number;
  h: number;
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
    const widthAt = (s: number) => {
      const w = def.width;
      if (!def.widthVar) return w;
      return w * (1 + def.widthVar * Math.sin((s / approx) * Math.PI * 2 * 3 + 1.3));
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

  /**
   * Rocks on the road every few hundred metres, in one of three patterns: a lone boulder, a "needle" (two rocks with
   * a gap only a pod on its side fits through, and room to go round either side), or a slalom of three. Never near
   * the start, the finish, a jump's kicker and landing, a boost pad or the gorge bridge.
   */
  private placeObstacles(): Obstacle[] {
    const r = rng(this.def.seed * 31 + 7);
    const out: Obstacle[] = [];
    const pads = this.def.boostPads.map(([f]) => this.raceS(f));
    const blocked = (s: number) =>
      this.jumps.some((j) => s > j.s0 - 50 && s < j.s1 + 110) ||
      pads.some((p) => Math.abs(p - s) < 40) ||
      (this.gorgeS !== null && Math.abs(this.gorgeS - s) < 150);
    let s = this.startS + 300;
    while (s < this.finishS - 200) {
      if (blocked(s) || blocked(s + 150)) {
        s += 30;
        continue;
      }
      const hw = this.frameAt(s).width / 2;
      const kind = r();
      const rock = (ss: number, x: number, rad: number) => out.push({ s: ss, x, r: rad, h: rad * (1.6 + r() * 1.2) });
      if (kind < 0.3) {
        rock(s, (r() * 2 - 1) * 0.55 * hw, 3.2 + r() * 1.6);
      } else if (kind < 0.65) {
        // Needle: rock edges 4.6 m apart, a pod is 6.8 m wide flat and about 3 m on its side.
        const rad = 3 + r() * 0.6;
        const xc = (r() * 2 - 1) * 0.25 * hw;
        rock(s, xc - 2.3 - rad, rad);
        rock(s, xc + 2.3 + rad, rad);
      } else {
        const side = r() < 0.5 ? -1 : 1;
        for (let k = 0; k < 3; k++) rock(s + k * 75, side * (k % 2 ? -1 : 1) * (0.25 + r() * 0.2) * hw, 2.6 + r() * 1.2);
      }
      s += 170 + r() * 150;
    }
    return out;
  }
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
