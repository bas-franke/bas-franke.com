// Pod flight model, in track space. A pod has a heading (psi) and a velocity direction (phi), both measured relative
// to the track tangent (positive = to the left). Steering sets a target turn rate (limited by a lateral-g budget, so
// fast bends need a wide line or less speed); the actual turn rate eases towards it, which gives the pod weight. The
// velocity follows the heading at the pod's grip rate, so at speed the pod slides towards the outside, and sliding
// scrubs speed. Air brakes (brake + steer) carve: more grip and a bigger turn budget while slowing. When the track
// curves under a pod its relative angles change by -kappa * ds, which is what makes the player steer through
// corners. The road edges are walls: a hit costs speed by how square it was, and bounces the pod back off. Rocks on
// the road are the same, only worse head-on. Turning costs a little top speed, and rolling the pod onto its side
// (knife-edge, to slip through a gap the pod would not fit through flat) a little more. Over a crest or a jump's lip
// the pod leaves the road and flies until gravity brings it back down.

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
  /** -1 (onto the left side) .. 1 (onto the right side), 0 = flat. */
  roll: number;
}

export const NO_INPUT: PodInput = { throttle: 0, brake: 0, steer: 0, boost: false, roll: 0 };

export interface PodState {
  /** Distance along the track (0..length) and lateral offset (m, + right). */
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
  /** Knife-edge roll, -1 (left side down) .. 1 (right side down), eased towards the input. */
  roll: number;
  /** Height above the road (0 on the road), vertical speed (m/s, world up) and whether airborne. */
  h: number;
  vy: number;
  air: boolean;
  /** Nose against a rock last step (so the hit is only counted once). */
  onRock: boolean;
}

export function newPodState(s: number, x: number): PodState {
  return { s, x, v: 0, psi: 0, phi: 0, yawRate: 0, boost: 0.5, boosting: false, surge: 0, draft: 0, impact: 0, impactSide: 0, padHit: false, ds: 0, sinceBoost: 9, scrape: 0, roll: 0, h: 0, vy: 0, air: false, onRock: false };
}

/** Half the pod's width, for wall and pod contacts. */
export const POD_HALF_WIDTH = 3.4;
/** Half width fully on its side. */
const KNIFE_HALF_WIDTH = 1.5;

/** Half width of a pod right now (narrower as it rolls onto its side). */
export function podHalfWidth(st: PodState) {
  return POD_HALF_WIDTH + (KNIFE_HALF_WIDTH - POD_HALF_WIDTH) * Math.abs(st.roll);
}
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
/** Gravity in the air: stronger than real so jumps are punchy and short. */
const AIR_GRAVITY = 26;
/** Top speed lost at full steering lock, and fully on the side. */
const TURN_SLOW = 0.035;
const ROLL_SLOW = 0.07;
/** How fast the pod rolls onto its side (full roll per second). */
const ROLL_RATE = 5;

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
  st.roll += Math.max(-ROLL_RATE * dt, Math.min(ROLL_RATE * dt, input.roll - st.roll));
  top *= (1 - TURN_SLOW * Math.abs(input.steer)) * (1 - ROLL_SLOW * Math.abs(st.roll));

  const f = track.frameAt(st.s);

  // Thrust falls off towards the top speed; above it (after a boost) drag pulls the pod back down.
  const thrust = stats.thrust * (st.boosting ? BOOST_THRUST : st.surge > 0 ? 1.5 : 1);
  if (st.v < top) st.v = Math.min(top, st.v + input.throttle * thrust * (1 - (st.v / top) ** 2 * 0.85) * dt);
  else st.v = Math.max(top, st.v - DRAG_OVER * dt);
  st.v -= (input.brake * BRAKE * Math.min(1, st.v / 30 + 0.2) + (1 - input.throttle) * COAST) * dt;
  // Downhill is a little faster, uphill a little slower.
  if (!st.air) st.v -= f.tangent.y * GRAVITY * 1.5 * dt;

  // Steering: a turn-rate target within the lateral-g budget; the actual rate eases towards it.
  // In the air the pod only half answers the stick.
  const budget = turnBudget(stats, st.v, input.brake) * (st.air ? 0.5 : 1);
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
  st.s = track.clamp(st.s + st.ds);
  // The end of the run-off: the pod parks.
  if (st.s > track.length - 3) {
    st.s = track.length - 3;
    st.v = 0;
  }
  st.x += xdot * dt;
  st.psi -= f.kappa * st.ds;
  st.phi -= f.kappa * st.ds;
  // Pods never turn round: a pod can be knocked sideways but always flies forwards.
  st.psi = Math.max(-1.3, Math.min(1.3, st.psi));
  st.phi = Math.max(-1.2, Math.min(1.2, st.phi));

  // Height: on the road the pod follows it; if the road falls away faster than gravity could pull it down (a crest,
  // a jump's lip) it flies, and lands when it meets the road again. Heights are the centreline's, so sideways moves
  // over the banking (or being shoved by a wall, a rock or a pod) never launch anyone.
  const y0 = f.pos.y;
  const y1 = track.frameAt(st.s).pos.y;
  const roadVy = (y1 - y0) / dt;
  if (!st.air) {
    const ballistic = y0 + st.vy * dt - 0.5 * AIR_GRAVITY * dt * dt;
    if (ballistic > y1 + 0.004 && st.v > 15) {
      st.air = true;
      st.h = ballistic - y1;
      st.vy -= AIR_GRAVITY * dt;
    } else {
      st.h = 0;
      st.vy = roadVy;
    }
  } else {
    st.vy -= AIR_GRAVITY * dt;
    st.h = y0 + st.h + st.vy * dt - y1;
    if (st.h <= 0) {
      // Touchdown: a hard landing costs a little speed.
      const hard = Math.max(0, roadVy - st.vy - 8);
      if (hard > 0) {
        st.v *= 1 - Math.min(0.15, hard * 0.012);
        st.impact = Math.min(1, hard * 0.06);
        st.impactSide = 0;
      }
      st.air = false;
      st.h = 0;
      st.vy = roadVy;
    }
  }

  // Walls.
  const hw = podHalfWidth(st);
  const limit = f.width / 2 - hw;
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

  // Rocks: flying into one nose-first costs a lot of speed and leaves the pod against it, sliding off towards the
  // nearer side; brushing past one is a scrape. Each contact is pushed out along the shallower overlap, so a pod
  // too wide for a gap is held back instead of wedged between the two rocks.
  const wasOnRock = st.onRock;
  st.onRock = false;
  for (const o of track.obstacles) {
    const reachS = o.r + 3;
    const ds = st.s - o.s;
    if (Math.abs(ds) >= reachS || st.h > o.h) continue;
    const dx = st.x - o.x;
    const reachX = o.r + hw - 0.3;
    if (Math.abs(dx) >= reachX) continue;
    const side = dx >= 0 ? 1 : -1;
    if (ds < 0 && reachS + ds < reachX - Math.abs(dx)) {
      const fresh = !wasOnRock;
      st.onRock = true;
      st.s = o.s - reachS;
      if (fresh) {
        const square = 1 - Math.abs(dx) / reachX;
        st.v *= 1 - Math.min(0.6, 0.15 + square * 0.5);
        st.impact = Math.min(1, 0.35 + square);
      } else {
        st.v = Math.min(st.v, 14);
        st.impact = Math.max(st.impact, 0.05);
      }
      // Slide off round the end of this rock's formation (plus rocks beside it with no gap a pod fits through) that
      // has room to pass the wall, the nearer end if both do.
      let lo = o.x - o.r;
      let hi = o.x + o.r;
      for (let pass = 0; pass < 2; pass++) {
        for (const o2 of track.obstacles) {
          if (o2.group !== o.group && (Math.abs(o2.s - o.s) > 10 || o2.x - o2.r > hi + 2 * hw || o2.x + o2.r < lo - 2 * hw)) continue;
          lo = Math.min(lo, o2.x - o2.r);
          hi = Math.max(hi, o2.x + o2.r);
        }
      }
      const leftOpen = lo - 2 * hw > -f.width / 2;
      const rightOpen = hi + 2 * hw < f.width / 2;
      const dir = leftOpen && (!rightOpen || st.x - lo < hi - st.x) ? -1 : rightOpen ? 1 : side;
      st.x += dir * 7 * dt;
      st.phi = -dir * 0.2;
      st.psi = st.psi * 0.5 + st.phi * 0.5;
      st.yawRate *= 0.3;
    } else {
      st.x = o.x + side * reachX;
      st.v = Math.max(0, st.v - SCRAPE * dt);
      if (st.phi * side > 0) st.phi = 0;
      st.impact = Math.max(st.impact, 0.05);
    }
    st.impactSide = -side;
  }

  // Boost pads.
  const pads = track.def.boostPads;
  for (const [frac, lat] of pads) {
    const ps = track.raceS(frac);
    const d = st.s - ps;
    if (st.h < 1 && d >= 0 && d < st.ds + 0.01 && Math.abs(st.x - lat * (f.width / 2 - 6)) < 5.5) {
      st.surge = SURGE_TIME;
      st.v = Math.min(st.v + PAD_KICK, stats.topSpeed * SURGE_TOP * 1.08);
      st.boost = Math.min(1, st.boost + 0.15);
      st.padHit = true;
    }
  }
}

/** Boost pad centre in track space (s, x). */
export function padPosition(track: Track, pad: [number, number]): { s: number; x: number } {
  const s = track.raceS(pad[0]);
  return { s, x: pad[1] * (track.frameAt(s).width / 2 - 6) };
}
