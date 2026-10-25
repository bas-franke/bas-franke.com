// Dustrunners snapshots, without three.js (runs under Node in the headless net test): a racer's state to the wire
// (PodSnap, rounded), a per-pod buffer of received snapshots sampled a little in the past (interpolated between the two
// around the render time, extrapolated briefly when the next one is late), and writing a sample back into a remote
// racer. Discrete things (flags, broken parts, the wreck) come from the newer snapshot once its time has passed.

import type { PodSnap } from '@shared/dustrunners/protocol';
import type { Race, Racer } from '../core/race';

/** Flag bits of PodSnap.f. */
export const F_BOOST = 1;
export const F_AIR = 2;
export const F_WRECK = 4;
export const F_GHOST = 8;

/**
 * How far in the past remote pods are drawn (ms; snapshots carry their capture time, so this covers the one-way trip
 * plus the send and relay intervals of 50 ms each), and the longest they are extrapolated past their last snapshot.
 */
export const INTERP_DELAY = 150;
export const MAX_EXTRAPOLATE = 250;
/** A remote pod that has received no new snapshot for this long (ms) is treated as a ghost: not solid. */
export const STALE_MS = 500;

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A racer's state on the wire. */
export function encodePod(r: Racer): PodSnap {
  const st = r.state;
  const snap: PodSnap = {
    id: r.id,
    s: r2(st.s),
    x: r2(st.x),
    v: r2(st.v),
    psi: r3(st.psi),
    phi: r3(st.phi),
    yr: r3(st.yawRate),
    h: r2(st.h),
    vy: r2(st.vy),
    roll: r3(st.roll),
    f: (st.boosting ? F_BOOST : 0) | (st.air ? F_AIR : 0) | (r.wrecked > 0 ? F_WRECK : 0) | (r.ghost > 0 ? F_GHOST : 0),
    in: [r2(r.input.throttle), r2(r.input.steer), r2(r.input.brake)],
    dmg: [r2(r.damage[0]), r2(r.damage[1]), r2(r.damage[2])],
    broken: [...r.parts.broken],
  };
  if (r.wrecked > 0) snap.wr = [r3(r.wreck.roll), r3(r.wreck.pitch), r3(r.wreck.yaw), r2(r.wreck.h)];
  return snap;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** Angles that may wrap (the wreck's tumble is unbounded, so plain lerp; these are headings within ±π). */
const lerpAngle = (a: number, b: number, k: number) => {
  let d = b - a;
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * k;
};

/** Received snapshots of one pod, by server time (ms), oldest first. */
export class SnapBuffer {
  private readonly items: { t: number; p: PodSnap }[] = [];

  /**
   * Adds a snapshot captured at server time `t` (the pod's `at`). Returns false when it is not news: the same capture
   * time again (relayed while its owner sent nothing new) or older than the newest one.
   */
  push(t: number, p: PodSnap): boolean {
    const it = this.items;
    if (it.length && t <= it[it.length - 1].t) return false;
    it.push({ t, p });
    if (it.length > 32) it.splice(0, it.length - 32);
    return true;
  }

  get latest(): { t: number; p: PodSnap } | null {
    return this.items[this.items.length - 1] ?? null;
  }

  get size() {
    return this.items.length;
  }

  /**
   * The pod at server time `t`: between the two snapshots around it, or the newest moved on along its heading for up
   * to MAX_EXTRAPOLATE ms. Across a wreck or a respawn (the wreck flag changes) it does not blend: the pod jumps.
   */
  sample(t: number): PodSnap | null {
    const it = this.items;
    if (!it.length) return null;
    // Drop what is too old to be needed (keep one before t).
    while (it.length > 2 && it[1].t <= t) it.shift();
    const a = it[0];
    if (t <= a.t) return a.p;
    const b = it[1];
    if (!b) return extrapolate(a.p, Math.min(t - a.t, MAX_EXTRAPOLATE) / 1000);
    if (t >= b.t) return b.p;
    if ((a.p.f & F_WRECK) !== (b.p.f & F_WRECK)) return a.p;
    const k = (t - a.t) / (b.t - a.t);
    const pa = a.p;
    const pb = b.p;
    const out: PodSnap = {
      ...pa,
      s: lerp(pa.s, pb.s, k),
      x: lerp(pa.x, pb.x, k),
      v: lerp(pa.v, pb.v, k),
      psi: lerpAngle(pa.psi, pb.psi, k),
      phi: lerpAngle(pa.phi, pb.phi, k),
      yr: lerp(pa.yr, pb.yr, k),
      h: lerp(pa.h, pb.h, k),
      vy: lerp(pa.vy, pb.vy, k),
      roll: lerp(pa.roll, pb.roll, k),
      in: [lerp(pa.in[0], pb.in[0], k), lerp(pa.in[1], pb.in[1], k), lerp(pa.in[2], pb.in[2], k)],
    };
    if (pa.wr && pb.wr) out.wr = [lerp(pa.wr[0], pb.wr[0], k), lerp(pa.wr[1], pb.wr[1], k), lerp(pa.wr[2], pb.wr[2], k), lerp(pa.wr[3], pb.wr[3], k)];
    return out;
  }
}

/** A snapshot moved on by `dt` seconds along its velocity (track space: x + right, phi + left). */
export function extrapolate(p: PodSnap, dt: number): PodSnap {
  if (dt <= 0 || p.f & F_WRECK) return p;
  return { ...p, s: p.s + p.v * Math.cos(p.phi) * dt, x: p.x - p.v * Math.sin(p.phi) * dt, h: Math.max(0, p.h + (p.f & F_AIR ? p.vy * dt : 0)) };
}

/**
 * Writes a sample into a remote racer: its flight state (into the same PodState object, which the AI keys its pilot
 * on), input and damage for the animation, then the flags and broken parts through the race (wreck, respawn and
 * breakage events for the view).
 */
export function applyPod(race: Race, r: Racer, p: PodSnap) {
  const st = r.state;
  st.s = race.track.clamp(p.s);
  st.x = p.x;
  st.v = p.v;
  st.psi = p.psi;
  st.phi = p.phi;
  st.yawRate = p.yr;
  st.h = p.h;
  st.vy = p.vy;
  st.roll = p.roll;
  st.boosting = (p.f & F_BOOST) !== 0;
  st.air = (p.f & F_AIR) !== 0;
  r.input = { throttle: p.in[0], steer: p.in[1], brake: p.in[2], boost: st.boosting, roll: 0 };
  r.damage = [p.dmg[0], p.dmg[1], p.dmg[2]];
  race.remoteParts(r, p.broken);
  race.remoteFlags(r, (p.f & F_WRECK) !== 0, (p.f & F_GHOST) !== 0);
  if (p.wr) {
    r.wreck.roll = p.wr[0];
    r.wreck.pitch = p.wr[1];
    r.wreck.yaw = p.wr[2];
    r.wreck.h = p.wr[3];
    st.h = p.wr[3];
  }
}
