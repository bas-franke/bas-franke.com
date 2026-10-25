// Headless check that pod damage lands where the crash happened: builds small situations straight on the race
// simulation (a pod flown into the left wall at a few angles, into a rock off-centre, rear-ended, side-swiped, landing
// hard flat and knife-edge, a wreck bouncing on its back and on its side, and a crash budget: how many hits of each
// kind a pod survives) and checks which parts took the most. Prints each case; exits non-zero if one fails.
//
//   tsx tools/racer/damagecheck.ts [-v]
// (tsx lives in play/backend/node_modules/.bin; needs Node 22+.)

import { newCareer, playerRacer } from '../../frontend/src/racer/core/career';
import { PART_IDS, isWrecked, newPodDamage, type PartId } from '../../frontend/src/racer/core/damage';
import { newPodState, podHalfWidth, type PodState } from '../../frontend/src/racer/core/physics';
import { Race, handlingOf, type Racer } from '../../frontend/src/racer/core/race';
import type { Obstacle } from '../../frontend/src/racer/core/track';
import { TRACKS } from '../../frontend/src/racer/core/tracks';

const verbose = process.argv.includes('-v');
const STEP = 1 / 120;

// Private bits of the race the scenarios drive directly.
interface RaceInternals {
  step(dt: number): void;
  contacts(): void;
  stepWreck(r: Racer, dt: number): void;
}
const internals = (race: Race) => race as unknown as RaceInternals;

function newRace(pods = 1) {
  const me = playerRacer(newCareer('Check'));
  const setups = Array.from({ length: pods }, (_, i) => ({ ...me, id: `p${i}` }));
  const race = new Race(TRACKS[0], setups);
  race.phase = 'racing';
  race.time = 1;
  race.playerInput = { throttle: 1, brake: 0, steer: 0, boost: false, roll: 0 };
  // No rocks unless a case puts one down.
  (race.track.obstacles as Obstacle[]).length = 0;
  return race;
}

/** A straight, flat stretch away from jumps, the start and the finish. */
function straightS(race: Race): number {
  const t = race.track;
  for (let s = t.startS + 300; s < t.finishS - 300; s += 10) {
    let ok = !t.jumps.some((j) => s > j.s0 - 150 && s < j.s1 + 150);
    for (let d = -40; ok && d <= 80; d += 5) {
      const f = t.frameAt(s + d);
      if (Math.abs(f.kappa) > 0.0015 || Math.abs(f.tangent.y) > 0.03) ok = false;
    }
    if (ok) return s;
  }
  throw new Error('no straight found');
}

function place(r: Racer, patch: Partial<PodState>) {
  Object.assign(r.state, newPodState(r.state.s, 0), patch);
  r.hurtCool = 0;
  r.lastHit = null;
}

function fresh(r: Racer) {
  r.parts = newPodDamage();
  r.handling = handlingOf(r.stats, r.parts);
  r.wrecked = 0;
  r.ghost = 0;
}

/** Damage taken per part since the pod was fresh, most first. */
function taken(r: Racer): [PartId, number][] {
  return PART_IDS.map((id) => [id, 1 - r.parts.health[id]] as [PartId, number])
    .filter(([, d]) => d > 0.001)
    .sort((a, b) => b[1] - a[1]);
}

let failures = 0;
function expect(name: string, r: Racer, opts: { top: PartId[]; topN?: number; not?: PartId[]; wrecked?: boolean }) {
  const t = taken(r);
  const n = opts.topN ?? 3;
  const top = t.slice(0, n).map(([id]) => id);
  const problems: string[] = [];
  if (!t.length) problems.push('no damage');
  for (const id of top) if (!opts.top.includes(id)) problems.push(`${id} in the top ${n}`);
  const worstNot = Math.max(0, ...t.filter(([id]) => opts.not?.includes(id)).map(([, d]) => d));
  // Parts that should be spared may take a little spill, never more than a fifth of the worst.
  if (t.length && worstNot > t[0][1] * 0.2) problems.push(`spared parts took ${worstNot.toFixed(2)}`);
  if (opts.wrecked !== undefined && isWrecked(r.parts) !== opts.wrecked) problems.push(opts.wrecked ? 'not wrecked' : 'wrecked');
  const ok = problems.length === 0;
  if (!ok) failures++;
  const list = t.slice(0, verbose ? 10 : 5).map(([id, d]) => `${id} ${d.toFixed(2)}`).join(', ');
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} ${list}${isWrecked(r.parts) ? '  [wrecked]' : ''}${ok ? '' : `  <- ${problems.join('; ')}`}`);
}

const LEFT: PartId[] = ['intakeL', 'clawsL', 'nacelleL', 'finL', 'flapL', 'nozzleL', 'binderL', 'cableL', 'stabL'];
const RIGHT: PartId[] = ['intakeR', 'clawsR', 'nacelleR', 'finR', 'flapR', 'nozzleR', 'binderR', 'cableR', 'stabR'];
const deg = (d: number) => (d * Math.PI) / 180;

/** Flies the pod into the left wall at `angle` degrees and `v` m/s until it touches. */
function wallHit(race: Race, r: Racer, angle: number, v: number, s: number) {
  const f = race.track.frameAt(s);
  place(r, { s, x: -(f.width / 2 - podHalfWidth(r.state)) + 0.3, v, psi: deg(angle), phi: deg(angle) });
  for (let k = 0; k < 30 && r.state.scrape === 0; k++) internals(race).step(STEP);
}

/** Flies the pod nose-first into a rock `offset` metres to its left (negative) or right of its centre. */
function rockHit(race: Race, r: Racer, offset: number, v: number, s: number) {
  const obstacles = race.track.obstacles as Obstacle[];
  obstacles.length = 0;
  obstacles.push({ s: s + 12, x: offset, r: 2.5, h: 20, kind: 'boulder', group: 1, side: 0, t: 0 });
  place(r, { s, x: 0, v });
  for (let k = 0; k < 60 && !r.state.onRock && r.state.impact < 0.04; k++) internals(race).step(STEP);
  obstacles.length = 0;
}

const race = newRace();
const r = race.player;
const s0 = straightS(race);

// Walls: a glancing scrape lands on the flank (flap, fin, nacelle), a square hit on the front corner; never the right.
for (const [angle, v] of [[4, 90], [20, 90], [60, 70]]) {
  fresh(r);
  wallHit(race, r, angle, v, s0);
  // Grind along for a second on the shallow one: a scrape keeps chipping the same flank.
  if (angle < 10) for (let k = 0; k < 120; k++) internals(race).step(STEP);
  const front: PartId[] = ['intakeL', 'clawsL', 'nacelleL', 'flapL', 'finL'];
  const flank: PartId[] = ['flapL', 'nacelleL', 'finL', 'nozzleL', 'intakeL', 'binderL'];
  expect(`left wall ${angle}deg at ${v} m/s`, r, { top: angle < 10 ? flank : front, not: RIGHT });
}

// Rocks nose-first, a little left and right of centre: that side's intake and claws.
fresh(r);
rockHit(race, r, -1.5, 95, s0);
expect('rock nose-first, offset left', r, { top: ['clawsL', 'intakeL', 'nacelleL'], not: RIGHT });
fresh(r);
// Off-centre enough not to count as head-on (a square rock hit over 25 m/s wrecks the pod outright, see physics.ts).
rockHit(race, r, 3.2, 40, s0);
expect('rock glancing the right engine, 40', r, { top: ['clawsR', 'intakeR', 'nacelleR'], not: LEFT, wrecked: false });
fresh(r);
rockHit(race, r, -5.6, 90, s0);
expect('rock brushing the left flank', r, { top: ['flapL', 'nacelleL', 'clawsL', 'intakeL', 'finL'], not: RIGHT });

// Hard landings do no damage (a design choice: jumps are for flying, only crashes hurt), flat or knife-edge.
for (const [name, roll] of [['hard landing flat', 0], ['hard landing knife-edge left', -1]] as const) {
  fresh(r);
  place(r, { s: s0, x: 0, v: 80, air: true, h: 0.05, vy: -30, roll });
  race.playerInput = { ...race.playerInput, roll };
  internals(race).step(STEP);
  race.playerInput = { ...race.playerInput, roll: 0 };
  const t = taken(r);
  if (t.length) failures++;
  console.log(`${t.length ? 'FAIL' : 'ok  '} ${name.padEnd(34)} ${t.length ? `took ${t[0][0]} ${t[0][1].toFixed(2)}  <- landings should not hurt` : 'no damage'}`);
}

// Wrecks bouncing: on its back the fins and the canopy, on its left side the left flap and fin.
for (const [name, roll, top, not] of [
  ['wreck lands on its back', Math.PI, ['finL', 'finR', 'canopy', 'cableL', 'cableR'], ['clawsL', 'clawsR', 'flapL', 'flapR', 'binderMid']],
  ['wreck lands on its left side', Math.PI / 2, ['flapL', 'nacelleL', 'finL', 'intakeL', 'nozzleL', 'clawsL'], RIGHT],
] as [string, number, PartId[], PartId[]][]) {
  fresh(r);
  place(r, { s: s0, x: 0, v: 40 });
  r.wrecked = 3;
  r.wreck = { h: 0.02, vy: -12, vx: 0, roll, pitch: 0, yaw: 0, wr: 0, wp: 0, wy: 0, rest: false };
  internals(race).stepWreck(r, STEP);
  expect(name, r, { top, not });
  r.wrecked = 0;
}

// Pod to pod: rear-ended at 20 m/s closing, and a side swipe.
{
  const two = newRace(2);
  const [a, b] = two.racers;
  const s = straightS(two);
  place(a, { s, x: 0, v: 90 });
  place(b, { s: s + 6.6, x: 0, v: 70 });
  internals(two).contacts();
  expect('rear-ender: the one behind', a, { top: ['clawsL', 'clawsR', 'intakeL', 'intakeR', 'binderMid'], not: ['tail', 'canopy', 'stabL', 'stabR'] });
  expect('rear-ender: the one in front', b, { top: ['tail', 'stabL', 'stabR', 'nozzleL', 'nozzleR', 'hull'], not: ['clawsL', 'clawsR', 'intakeL', 'intakeR'] });
  fresh(a);
  fresh(b);
  place(a, { s, x: 0, v: 90, phi: deg(-6), psi: deg(-6) });
  place(b, { s: s + 1, x: podHalfWidth(a.state) * 2 - 0.6, v: 90 });
  internals(two).contacts();
  expect('side swipe: the one swiping (right)', a, { top: RIGHT, not: LEFT });
  expect('side swipe: the one swiped (left)', b, { top: LEFT, not: RIGHT });
}

// The crash budget: scrapes and a couple of solid hits are survivable, a full-speed nose-first rock or 3-4 hard wall hits
// are not.
function budget(name: string, hits: number, hit: () => void, wrecked: boolean) {
  fresh(r);
  let n = 0;
  for (; n < hits && !isWrecked(r.parts); n++) {
    hit();
    r.hurtCool = 0;
  }
  const ok = isWrecked(r.parts) === wrecked;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} ${isWrecked(r.parts) ? `wrecked after ${n}` : `survived ${n}`}`);
  r.wrecked = 0;
}
budget('8 wall scrapes (4deg, 90)', 8, () => wallHit(race, r, 4, 90, s0), false);
budget('2 solid wall hits (20deg, 90)', 2, () => wallHit(race, r, 20, 90, s0), false);
budget('4 hard wall hits (30deg, 95)', 4, () => wallHit(race, r, 30, 95, s0), true);
budget('1 full-speed nose-first rock', 1, () => rockHit(race, r, -1, 100, s0), true);
budget('2 glancing rocks at 40', 2, () => rockHit(race, r, 3.2, 40, s0), false);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
