// A race track: a closed centreline spline sampled every SAMPLE_STEP metres into frames (position, tangent, right,
// up, width, curvature, bank). Physics, AI and every visual module work in track space: `s` is the distance along the
// centreline from the start line (0..length), `x` the lateral offset from it (positive = right of the direction of
// travel), and the frame at `s` turns that back into a world position.

import * as THREE from 'three';
import type { TrackDef } from './tracks';

export const SAMPLE_STEP = 2;

export interface Frame {
  /** Distance from the start line, metres. */
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

export class Track {
  readonly frames: Frame[] = [];
  readonly length: number;
  readonly curve: THREE.CatmullRomCurve3;
  /** 2D outline for the minimap, normalised to a 0..1 square (x right, y down), one point per ~10 m. */
  readonly minimap: { points: [number, number][]; project(p: THREE.Vector3): [number, number] };
  /** Axis-aligned bounds of the centreline. */
  readonly bounds = new THREE.Box3();

  constructor(readonly def: TrackDef) {
    const pts = def.points.map(([x, z, y = 0]) => new THREE.Vector3(x, y, z));
    this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    const approx = this.curve.getLength();
    const n = Math.max(64, Math.round(approx / SAMPLE_STEP));
    const spaced = this.curve.getSpacedPoints(n);
    spaced.pop(); // closed: the last point repeats the first
    this.length = approx;
    const step = approx / spaced.length;

    // Tangents, then curvature from the change of heading in the ground plane, smoothed so banking does not wobble.
    const tangents = spaced.map((p, i) => spaced[(i + 1) % spaced.length].clone().sub(spaced[(i - 1 + spaced.length) % spaced.length]).normalize());
    const raw = tangents.map((t, i) => {
      const a = t;
      const b = tangents[(i + 1) % tangents.length];
      const ha = Math.atan2(-a.x, -a.z);
      const hb = Math.atan2(-b.x, -b.z);
      let d = hb - ha;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return d / step;
    });
    const kappa = smooth(raw, 6);
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

    const size = this.bounds.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z) * 1.08;
    const cx = (this.bounds.min.x + this.bounds.max.x) / 2;
    const cz = (this.bounds.min.z + this.bounds.max.z) / 2;
    const project = (p: THREE.Vector3): [number, number] => [0.5 + (p.x - cx) / span, 0.5 + (p.z - cz) / span];
    const points: [number, number][] = [];
    for (let i = 0; i < this.frames.length; i += 5) points.push(project(this.frames[i].pos));
    this.minimap = { points, project };
  }

  wrap(s: number) {
    return ((s % this.length) + this.length) % this.length;
  }

  /** Interpolated frame at distance s (wrapped). Reuses `out` if given. */
  frameAt(s: number, out?: Frame): Frame {
    const n = this.frames.length;
    const f = (this.wrap(s) / this.length) * n;
    const i = Math.floor(f) % n;
    const t = f - Math.floor(f);
    const a = this.frames[i];
    const b = this.frames[(i + 1) % n];
    const o = out ?? { s: 0, pos: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), width: 0, kappa: 0, bank: 0 };
    o.s = this.wrap(s);
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
    const from = hint === undefined ? 0 : Math.round((this.wrap(hint) / this.length) * n) - 40;
    const count = hint === undefined ? n : 80;
    for (let k = 0; k < count; k++) {
      const i = (((from + k) % n) + n) % n;
      const d = this.frames[i].pos.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const f = this.frames[best];
    const rel = p.clone().sub(f.pos);
    const along = rel.dot(f.tangent);
    return { s: this.wrap(f.s + along), x: rel.dot(f.right), h: rel.dot(f.up) };
  }

  /** Max |kappa| over [s, s + ahead]. */
  maxCurvature(s: number, ahead: number): number {
    let m = 0;
    for (let d = 0; d <= ahead; d += SAMPLE_STEP * 2) m = Math.max(m, Math.abs(this.frameAt(s + d, scratch).kappa));
    return m;
  }
}

const scratch: Frame = { s: 0, pos: new THREE.Vector3(), tangent: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), width: 0, kappa: 0, bank: 0 };

function smooth(v: number[], radius: number): number[] {
  const n = v.length;
  return v.map((_, i) => {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += v[(i + k + n) % n];
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
