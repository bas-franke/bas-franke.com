// AI pilots. Every track gets a racing line once (a minimum-curvature path between the walls, found by relaxing a
// chain of points) and every pilot a speed plan along it (what its pod can hold through each bend, with braking
// zones worked backwards from the corners). A pilot follows the line with a pure-pursuit steer, rides the speed plan
// with throttle and air brakes, steers round the rocks on the road, picks up boost pads, boosts on straights, pulls out
// to pass slower pods and leans on neighbours if aggressive. Skill sets how close to the limit it drives and how clean its line is; a little rubber
// banding keeps races close without being obvious.

import { POD_HALF_WIDTH, gripRate, padPosition, turnBudget, type PodInput, type PodState } from './physics';
import type { PodStats } from './pods';
import type { Track } from './track';

export interface AiProfile {
  /** 0..1: how close to the limit it drives (corner speed, line precision). */
  skill: number;
  /** -1..1: preferred lateral bias, so bots do not all stack on one line. */
  bias: number;
  /** 0..1: how readily it boosts and squeezes past. */
  aggression: number;
}

export interface AiView {
  state: PodState;
  stats: PodStats;
  profile: AiProfile;
  /** Progress gap to the player in metres (+ = AI ahead). Drives rubber banding. */
  gapToPlayer: number;
  /** Track-space positions of other pods. */
  others: { s: number; x: number; v: number }[];
}

/** Racing line samples: every LINE_STEP metres, the lateral offset and the line's own curvature (1/m, + = left). */
const LINE_STEP = 8;
interface Line {
  x: Float32Array;
  kappa: Float32Array;
  step: number;
}
const lines = new WeakMap<Track, Line>();

export function racingLine(track: Track): Line {
  let line = lines.get(track);
  if (line) return line;
  const m = Math.round(track.length / LINE_STEP);
  const step = track.length / m;
  const px = new Float64Array(m);
  const pz = new Float64Array(m);
  const rx = new Float64Array(m);
  const rz = new Float64Array(m);
  const lim = new Float64Array(m);
  const x = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const f = track.frameAt(i * step);
    px[i] = f.pos.x;
    pz[i] = f.pos.z;
    const l = Math.hypot(f.right.x, f.right.z);
    rx[i] = f.right.x / l;
    rz[i] = f.right.z / l;
    lim[i] = f.width / 2 - POD_HALF_WIDTH - 3.2;
  }
  // The course is open: the two end points stay on the centreline, everything else relaxes.
  const c = (k: number) => Math.max(0, Math.min(m - 1, k));
  const relax = (iterations: number, bi: boolean) => {
    for (let it = 0; it < iterations; it++) {
      for (let i = 1; i < m - 1; i++) {
        const a = i - 1;
        const b = i + 1;
        const qx = (k: number) => px[k] + rx[k] * x[k];
        const qz = (k: number) => pz[k] + rz[k] * x[k];
        let tx: number;
        let tz: number;
        if (bi) {
          // Minimum curvature: each point moves to where the second difference around it is smallest.
          const a2 = c(i - 2);
          const b2 = c(i + 2);
          tx = (4 * (qx(a) + qx(b)) - (qx(a2) + qx(b2))) / 6;
          tz = (4 * (qz(a) + qz(b)) - (qz(a2) + qz(b2))) / 6;
        } else {
          tx = (qx(a) + qx(b)) / 2;
          tz = (qz(a) + qz(b)) / 2;
        }
        const d = (tx - qx(i)) * rx[i] + (tz - qz(i)) * rz[i];
        x[i] = Math.max(-lim[i], Math.min(lim[i], x[i] + d * 0.9));
      }
    }
  };
  relax(300, false);
  relax(1500, true);
  // Curvature of the line itself from the heading change between neighbouring points.
  const heading = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const b = Math.min(m - 1, i + 1);
    const a = b - 1;
    heading[i] = Math.atan2(-(px[b] + rx[b] * x[b] - px[a] - rx[a] * x[a]), -(pz[b] + rz[b] * x[b] - pz[a] - rz[a] * x[a]));
  }
  const raw = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let d = heading[i] - heading[c(i - 1)];
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    raw[i] = d / step;
  }
  const kappa = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += raw[c(i + k)];
    kappa[i] = sum / 5;
  }
  line = { x: Float32Array.from(x), kappa, step };
  lines.set(track, line);
  return line;
}

function sample(arr: Float32Array, step: number, s: number): number {
  const n = arr.length;
  const f = Math.max(0, Math.min(n - 1, s / step));
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  const a = arr[i];
  const b = arr[i + 1];
  return a + (b - a) * t;
}

/** Per-pilot memory: its speed plan on the current track, and a couple of slow random signals. */
interface Pilot {
  track: Track;
  plan: Float32Array;
  seed: number;
  stuck: number;
}
const pilots = new WeakMap<PodState, Pilot>();

function speedPlan(track: Track, line: Line, stats: PodStats, skill: number): Float32Array {
  const m = line.kappa.length;
  const plan = new Float32Array(m);
  // How much of the pod's lateral budget the pilot dares to use, and how hard it brakes.
  const margin = 0.74 + 0.18 * skill;
  for (let i = 0; i < m; i++) {
    // The sharpest point nearby, a little exaggerated: quick changes of direction need more than steady bends.
    let k = 0;
    for (let j = -2; j <= 2; j++) k = Math.max(k, Math.abs(line.kappa[Math.max(0, Math.min(m - 1, i + j))]));
    k *= 1.1;
    let v = stats.topSpeed * 1.35;
    // Largest v with v * k <= budget(v): bisection (the budget falls with speed).
    if (k > 1e-5) {
      let lo = 5;
      let hi = v;
      for (let it = 0; it < 20; it++) {
        const mid = (lo + hi) / 2;
        if (mid * k <= turnBudget(stats, mid) * margin) lo = mid;
        else hi = mid;
      }
      v = lo;
    }
    plan[i] = v;
  }
  // Braking zones: going backwards, a point can only be as fast as the next allows after braking over one step.
  const decel = 30 + 10 * skill;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = m - 2; i >= 0; i--) {
      const next = plan[i + 1];
      plan[i] = Math.min(plan[i], Math.sqrt(next * next + 2 * decel * line.step));
    }
  }
  return plan;
}

export function aiInput(track: Track, view: AiView, time: number): PodInput {
  const { state: st, stats, profile } = view;
  const line = racingLine(track);
  let p = pilots.get(st);
  if (!p || p.track !== track) {
    p = { track, plan: speedPlan(track, line, stats, profile.skill), seed: Math.random() * 100, stuck: 0 };
    pilots.set(st, p);
  }
  const skill = profile.skill;
  const f = track.frameAt(st.s);
  const half = f.width / 2 - POD_HALF_WIDTH - 0.8;
  const look = 14 + st.v * 0.38;
  const sAhead = st.s + look;

  // Where to be: the racing line (weaker pilots cut it less), the pilot's own bias, a little wander.
  const lineUse = 0.55 + 0.45 * skill;
  const wander = (1 - skill) * (Math.sin(time * 0.37 + p.seed) * 3 + Math.sin(time * 0.91 + p.seed * 2) * 1.5);
  let target = sample(line.x, line.step, sAhead) * lineUse + profile.bias * 3 + wander;

  // Boost pads close ahead and not far off the line: go and get them (the better pilots more reliably).
  if (skill > 0.3) {
    for (const pad of track.def.boostPads) {
      const pp = padPosition(track, pad);
      const d = pp.s - st.s;
      if (d > 0 && d < 60 + st.v * 1.4 && Math.abs(pp.x - target) < 6 + 8 * skill) target = pp.x;
    }
  }

  // Rocks: the nearest group ahead that is in the way (rocks side by side count as one blocked span) is passed on the
  // side nearer where the pod is heading, aiming so the path, not just the far target point, clears it. Weaker pilots see
  // the rocks later and keep less room.
  const seeRocks = 40 + st.v * (0.9 + 0.9 * skill);
  const clearance = POD_HALF_WIDTH + 2 + 1.5 * skill;
  const groups: { d: number; ids: number[]; spans: [number, number][] }[] = [];
  for (const o of track.obstacles) {
    const d = o.s - st.s;
    if (d < -o.r - 3 || d > seeRocks || st.h > o.h + 1) continue;
    // One formation is one group even when it leans along the course.
    const g = groups.find((gg) => gg.ids.includes(o.group) || Math.abs(gg.d - d) < 15);
    const span: [number, number] = [o.x - o.r - clearance, o.x + o.r + clearance];
    if (g) {
      g.spans.push(span);
      g.d = Math.min(g.d, d);
      if (!g.ids.includes(o.group)) g.ids.push(o.group);
    } else groups.push({ d, ids: [o.group], spans: [span] });
  }
  groups.sort((p, q) => p.d - q.d);
  let rockSlow = false;
  let dodging = false;
  for (const { d, spans } of groups) {
    spans.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const sp of spans) {
      const lastSpan = merged[merged.length - 1];
      if (lastSpan && sp[0] <= lastSpan[1]) lastSpan[1] = Math.max(lastSpan[1], sp[1]);
      else merged.push([...sp]);
    }
    const k = Math.max(0.3, Math.min(1, Math.max(0, d) / look));
    const xAt = st.x + (target - st.x) * k;
    const block = merged.find(([l, r]) => xAt > l && xAt < r);
    if (!block) continue;
    const [l, r] = block;
    const leftOk = l > -half;
    const rightOk = r < half;
    const want = leftOk && (!rightOk || xAt - l < r - xAt) ? l : rightOk ? r : xAt;
    target = st.x + (want - st.x) / k;
    dodging = true;
    if (d > 0 && d < st.v * 0.7 && st.x > l + 1 && st.x < r - 1) rockSlow = true;
    break;
  }

  // Traffic: pull out to pass a slower pod ahead, give (or deny) room to pods alongside, and do not ram the pod in
  // front when there is no way round (the aggressive leave it later).
  let follow = Infinity;
  for (const o of view.others) {
    const d = o.s - st.s;
    const dx = o.x - st.x;
    if (d > 2 && d < 30 + st.v * 0.45 && Math.abs(o.x - target) < 8 && o.v < st.v + 3) {
      // Pass on the side with more room, staying inside the walls.
      const left = o.x - 8.5;
      const right = o.x + 8.5;
      const leftOk = left > -half;
      const rightOk = right < half;
      if (leftOk && (!rightOk || Math.abs(left - target) < Math.abs(right - target))) target = left;
      else if (rightOk) target = right;
    } else if (Math.abs(d) < 10 && Math.abs(dx) < 10) {
      // Alongside: the timid make room, the aggressive lean in.
      const lean = profile.aggression > 0.8 ? 1 : -3.5;
      target += Math.sign(dx || 1) * lean;
    }
    // Closing fast on a pod still in the way: match its speed until there is room.
    const closing = st.v - o.v;
    if (d > 0 && Math.abs(dx) < 7 && closing > 0 && d < 9 + closing * (1.1 - 0.5 * profile.aggression)) follow = Math.min(follow, o.v - 1);
  }
  target = Math.max(-half, Math.min(half, target));

  // Steering, in three stages: the velocity direction that reaches the target point (pure pursuit), the heading that
  // turns the velocity that way at the pod's grip rate, and the turn rate that gets the heading there; plus the turn
  // rate the line itself needs. Each stage anticipates the lag of the next, so the pod settles instead of weaving.
  // Aim from where the pod will be in a moment, not where it is: damps the weave out of the pursuit.
  const xSoon = st.x - st.v * Math.sin(st.phi) * 0.4;
  const phiWant = -Math.atan2(target - xSoon, look);
  const kLine = sample(line.kappa, line.step, st.s + st.v * 0.06);
  const g = gripRate(stats, st.v, 0);
  // Dodging a rock: snappier, at the cost of a little weave.
  const phiRate = (phiWant - st.phi) * (1.2 + 0.6 * skill) * (dodging ? 1.8 : 1);
  const psiWant = st.phi + phiRate / g + (kLine * st.v) / g;
  let yawWant = kLine * st.v + (psiWant - st.psi) * 5;
  // Wall sense: if the pod will be at a wall in half a second, turn away from it now.
  const edge = f.width / 2 - POD_HALF_WIDTH - 0.8;
  const xWall = st.x - st.v * Math.sin(st.phi) * 0.5;
  if (Math.abs(xWall) > edge) yawWant += Math.sign(xWall) * Math.min(0.6, (Math.abs(xWall) - edge) * 0.12);
  const budget = Math.max(0.15, turnBudget(stats, st.v));
  const sloppy = (1 - skill) * 0.12 * Math.sin(time * 2.3 + p.seed * 3);
  let steer = Math.max(-1, Math.min(1, -yawWant / budget + sloppy));

  // Speed: the plan a little way ahead, nudged by rubber banding (behind the player -> braver, far ahead -> calmer).
  const gap = view.gapToPlayer;
  // Weak pilots get less of a push from behind, so an easy field stays easy.
  const band = gap > 120 ? -Math.min(0.04, (gap - 120) / 6000) : gap < -200 ? Math.min(0.03, (-gap - 200) / 8000) * (0.3 + 0.7 * skill) : 0;
  let wantV = Infinity;
  for (let d = 0; d <= 24; d += 8) wantV = Math.min(wantV, sample(p.plan, line.step, st.s + d));
  wantV *= 1 + band;
  // Weaker pilots also hold back a little on the straights.
  const cruise = stats.topSpeed * (0.78 + 0.22 * skill) * (st.boosting ? 1.3 : 1) * (st.surge > 0 ? 1.2 : 1) * (1 + band);
  wantV = Math.min(wantV, Math.max(cruise, st.draft > 0 ? stats.topSpeed * 1.05 : 0));
  wantV = Math.min(wantV, follow);
  // A rock coming up with no room yet to get round it: ease off.
  if (rockSlow) wantV = Math.min(wantV, Math.max(45, st.v - 4));
  // Off the line with the stick already at full lock: scrub speed so the turn tightens.
  if (Math.abs(yawWant) > budget * 1.05 && Math.abs(target - st.x) > 3) wantV = Math.min(wantV, st.v - 3);
  let throttle = st.v < wantV - 0.5 ? 1 : st.v < wantV + 1.5 ? 0.5 : 0;
  let brake = st.v > wantV + 2.5 ? Math.min(1, (st.v - wantV) / 12) : 0;
  // Never stall: a pod crawling (knocked about, pinned on a wall) floors it and straightens out.
  if (st.v < 20) {
    p.stuck += 1 / 120;
    throttle = 1;
    brake = 0;
    if (p.stuck > 1 && !st.onRock) steer = Math.max(-1, Math.min(1, st.psi * 2));
  } else p.stuck = 0;

  // Boost when the plan says the road stays fast for a while and the meter is full enough for this pilot.
  let clear = true;
  const reach = st.v * (st.boosting ? 1.2 : 2.2);
  for (let d = 0; d <= reach; d += 24) {
    if (sample(p.plan, line.step, st.s + d) < stats.topSpeed * (st.boosting ? 1 : 1.05)) {
      clear = false;
      break;
    }
  }
  // Weak pilots hoard boost (they use it less, and later).
  const threshold = 0.25 + 0.5 * (1 - profile.aggression) + 0.3 * (1 - skill) - (band > 0 ? 0.15 : 0);
  const boost = st.boosting ? clear && brake === 0 : st.boost > threshold && clear && throttle === 1 && Math.abs(steer) < 0.5 && st.v > stats.topSpeed * 0.75;
  return { throttle, brake, steer, boost, roll: 0 };
}
