// Pod flight model, in track space. A pod has a heading (psi) and a velocity direction (phi), both measured relative
// to the track tangent (positive = to the left). Steering sets a target turn rate (limited by a lateral-g budget, so
// fast bends need a wide line or less speed); the actual turn rate eases towards it, which gives the pod weight. The
// velocity follows the heading at the pod's grip rate, so at speed the pod slides towards the outside, and sliding
// scrubs speed. Air brakes (brake + steer) carve: more grip and a bigger turn budget while slowing. When the track
// curves under a pod its relative angles change by -kappa * ds, which is what makes the player steer through
// corners. The road edges are walls: a hit costs speed by how square it was, and bounces the pod back off.

import type { Track } from './track';
import type { PodStats } from './pods';

export interface PodInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 air brakes */
  brake: number;
  /** -1 (left) .. 1 (right) */
  steer: number;
  boost: boolean;
}

export const NO_INPUT: PodInput = { throttle: 0, brake: 0, steer: 0, boost: false };

export interface PodState {
  /** Distance along the track (wrapped 0..length) and lateral offset (m, + right). */
  s: number;
  x: number;
  /** Speed along the velocity direction, m/s. */
  v: number;
  /** Heading and velocity direction relative to the track tangent, radians, + left. */
  psi: number;
  phi: number;
  /** Rate the heading is turning (rad/s, + left), for banking the model. */
  yawRate: number;
  /** Boost meter 0..1 and whether the pod is boosting right now. */
  boost: number;
  boosting: boolean;
  /** Seconds left on a boost pad surge. */
  surge: number;
  /** Seconds left of a slipstream bonus. */
  draft: number;
  /** Impact strength of a wall or pod hit this step (0 = none), side -1 left / 1 right. Visual/audio cue. */
  impact: number;
  impactSide: number;
  /** Set this step when a boost pad was hit (cue). */
  padHit: boolean;
  /** Distance travelled this step along the track (can be negative). */
  ds: number;
  /** Seconds since the boost was last lit (the kick is only full after a pause, so tapping it gains nothing). */
  sinceBoost: number;
  /** Seconds the pod has been touching a wall without a break (scraping), 0 when clear. */
  scrape: number;
}

export function newPodState(s: number, x: number): PodState {
  return { s, x, v: 0, psi: 0, phi: 0, yawRate: 0, boost: 0.5, boosting: false, surge: 0, draft: 0, impact: 0, impactSide: 0, padHit: false, ds: 0, sinceBoost: 9, scrape: 0 };
}

/** Half the pod's width, for wall and pod contacts. */
export const POD_HALF_WIDTH = 3.4;
/** Deceleration at full air brake, m/s². */
const BRAKE = 46;
/** Drag with the throttle off. */
const COAST = 7;
/** How hard the pod is pulled back down to its top speed after a boost or surge. */
const DRAG_OVER = 14;
/** Boost: top speed and thrust multipliers, and the instant kick when it lights. */
const BOOST_TOP = 1.28;
const BOOST_THRUST = 2.2;
const BOOST_KICK = 5;
/** Boost pad: top speed multiplier, duration and kick. */
const SURGE_TOP = 1.2;
const SURGE_TIME = 1.5;
const PAD_KICK = 12;
const DRAFT_TOP = 1.05;
/** Lateral acceleration budget per unit of the pod's turn stat (m/s² per rad/s). */
const LAT_PER_TURN = 47;
/** How fast the turn rate follows the stick (1/s): lower = heavier. */
const YAW_RESPONSE = 7;
/** Speed lost per second to sliding: v * slip² * SLIP_DRAG. */
const SLIP_DRAG = 1.1;
/** Scraping along a wall, m/s². */
const SCRAPE = 26;
const GRAVITY = 9.8;

/** Turn rate the pod can hold at speed v (rad/s), with the air brakes at `brake`. Also used by the AI. */
export function turnBudget(stats: PodStats, v: number, brake = 0): number {
  const low = stats.turn * Math.min(1, 0.35 + v / 18) * (1 + 0.3 * brake);
  const lat = (stats.turn * LAT_PER_TURN * (1 + 0.38 * brake)) / Math.max(1, v);
  return Math.min(low, lat);
}

/** How fast the velocity direction follows the heading (1/s): loose at speed, tight on the air brakes. */
export function gripRate(stats: PodStats, v: number, brake = 0): number {
  return stats.grip * (1.2 - 0.45 * Math.min(1.2, v / stats.topSpeed)) * (1 + 0.9 * brake);
}

export function stepPod(st: PodState, input: PodInput, track: Track, stats: PodStats, dt: number) {
  st.impact = 0;
  st.padHit = false;

  // Boost: drains the meter while held, refills slowly the rest of the time (faster in a slipstream).
  const wasBoosting = st.boosting;
  st.boosting = input.boost && input.throttle > 0 && st.boost > (wasBoosting ? 0 : 0.08);
  if (st.boosting) {
    st.boost = Math.max(0, st.boost - dt / stats.boostTime);
    if (!wasBoosting) st.v += BOOST_KICK * Math.min(1, st.sinceBoost / 2);
    st.sinceBoost = 0;
  } else st.boost = Math.min(1, st.boost + stats.boostRefill * dt * (st.draft > 0 ? 2.5 : 1));
  if (!st.boosting) st.sinceBoost += dt;
  st.surge = Math.max(0, st.surge - dt);
  st.draft = Math.max(0, st.draft - dt);

  let top = stats.topSpeed;
  if (st.boosting) top *= BOOST_TOP;
  if (st.surge > 0) top *= SURGE_TOP;
  if (st.draft > 0) top *= DRAFT_TOP;

  const f = track.frameAt(st.s);

  // Thrust falls off towards the top speed; above it (after a boost) drag pulls the pod back down.
  const thrust = stats.thrust * (st.boosting ? BOOST_THRUST : st.surge > 0 ? 1.5 : 1);
  if (st.v < top) st.v = Math.min(top, st.v + input.throttle * thrust * (1 - (st.v / top) ** 2 * 0.85) * dt);
  else st.v = Math.max(top, st.v - DRAG_OVER * dt);
  st.v -= (input.brake * BRAKE * Math.min(1, st.v / 30 + 0.2) + (1 - input.throttle) * COAST) * dt;
  // Downhill is a little faster, uphill a little slower.
  st.v -= f.tangent.y * GRAVITY * 1.5 * dt;

  // Steering: a turn-rate target within the lateral-g budget; the actual rate eases towards it.
  const budget = turnBudget(stats, st.v, input.brake);
  const want = -input.steer * budget;
  st.yawRate += (want - st.yawRate) * (1 - Math.exp(-YAW_RESPONSE * (1 + input.brake * 0.6) * dt));
  st.psi += st.yawRate * dt;

  // The velocity follows the heading: loosely at speed (slide), tightly on the air brakes (carve).
  const grip = gripRate(stats, st.v, input.brake);
  st.phi += (st.psi - st.phi) * (1 - Math.exp(-grip * dt));
  const slip = st.psi - st.phi;
  st.v -= st.v * slip * slip * SLIP_DRAG * dt;
  st.v = Math.max(0, st.v);

  const sdot = (st.v * Math.cos(st.phi)) / Math.max(0.3, 1 + f.kappa * st.x);
  const xdot = -st.v * Math.sin(st.phi);
  st.ds = sdot * dt;
  st.s = track.wrap(st.s + st.ds);
  st.x += xdot * dt;
  st.psi -= f.kappa * st.ds;
  st.phi -= f.kappa * st.ds;
  // Pods never turn round: a pod can be knocked sideways but always flies forwards.
  st.psi = Math.max(-1.3, Math.min(1.3, st.psi));
  st.phi = Math.max(-1.2, Math.min(1.2, st.phi));

  // Walls.
  const limit = f.width / 2 - POD_HALF_WIDTH;
  if (Math.abs(st.x) > limit) {
    const side = Math.sign(st.x);
    st.x = side * limit;
    // Fraction of the velocity going into the wall: how square the hit was.
    const into = Math.max(0, -Math.sin(st.phi) * side);
    if (into > 0.05) {
      // A real hit: lose speed by how square it was (a glancing touch costs a few percent, head-on about half),
      // bounce off, and the nose is knocked back towards the wall's direction.
      st.v *= 1 - Math.min(0.5, 0.02 + into * 0.95);
      st.phi = Math.max(-0.12, Math.min(0.12, side * into * 0.35));
      st.psi = st.psi * 0.35 + st.phi * 0.65;
      st.yawRate *= 0.3;
      st.impact = Math.min(1, into * 3 + 0.1);
      st.impactSide = side;
    } else {
      st.v = Math.max(0, st.v - SCRAPE * dt);
      if (st.phi * side < 0) st.phi = 0;
      // A faint impact while scraping, so the scrape sound and sparks keep going.
      st.impact = 0.05;
      st.impactSide = side;
    }
    st.scrape += dt;
  } else st.scrape = 0;

  // Boost pads.
  const pads = track.def.boostPads;
  for (const [frac, lat] of pads) {
    const ps = frac * track.length;
    let d = st.s - ps;
    if (d > track.length / 2) d -= track.length;
    if (d < -track.length / 2) d += track.length;
    if (d >= 0 && d < st.ds + 0.01 && Math.abs(st.x - lat * (f.width / 2 - 6)) < 5.5) {
      st.surge = SURGE_TIME;
      st.v = Math.min(st.v + PAD_KICK, stats.topSpeed * SURGE_TOP * 1.08);
      st.boost = Math.min(1, st.boost + 0.15);
      st.padHit = true;
    }
  }
}

/** Boost pad centre in track space (s, x). */
export function padPosition(track: Track, pad: [number, number]): { s: number; x: number } {
  const s = pad[0] * track.length;
  return { s, x: pad[1] * (track.frameAt(s).width / 2 - 6) };
}
