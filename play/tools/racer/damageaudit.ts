// Audit of pod damage in real races: runs quick races on every track at every difficulty, logs every onParts call with
// what was going on (walls: which wall and the pod's angle to it; rocks: where the rock was relative to the pod's
// heading and what kind; pods: where the other pod was; wreck bounces: the tumble), and flags hits that do not match
// the situation:
//   away     most of the damage on the side away from what was hit (damage-weighted centre of the parts hit)
//   point    the contact point on the far half of the pod, or the push pointing towards what was hit
//   outline  the contact point well outside the pod's outline
//   void     the contact point in empty space, over half a metre from every part (between the engines, say)
//   energy   energy not finite or outside 0..2
//   rear     a nose-to-tail hit damaging the front of the pod in front (or the back of the one behind)
//   landing  damage from a landing (landings do no damage)
// Prints a table per kind and place (open course, slot walls, ledges, tunnels, kickers) and the worst examples.
//
//   tsx tools/racer/damageaudit.ts [--runs 2] [--tracks a,b] [--difficulties 0,1,2,3] [--worst 15]
// (tsx lives in play/backend/node_modules/.bin; needs Node 22+.)

import { newCareer, playerRacer, quickRaceRacers } from '../../frontend/src/racer/core/career';
import { PARTS, PART_IDS, toPodSpace, type Hit, type PartAnchor, type PartHit, type PartId } from '../../frontend/src/racer/core/damage';
import { podHalfWidth } from '../../frontend/src/racer/core/physics';
import { Race, WRECK_TIME, type Racer } from '../../frontend/src/racer/core/race';
import { KICKER_HALF, KICKER_TAPER, type Obstacle, type Track } from '../../frontend/src/racer/core/track';
import { TRACKS, trackById } from '../../frontend/src/racer/core/tracks';
import { DIFFICULTIES } from '../../frontend/src/racer/ui/menuStore';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const runs = Number(opt('runs', '2'));
const trackIds = opt('tracks', TRACKS.map((t) => t.id).join(',')).split(',');
const diffs = opt('difficulties', '0,1,2,3').split(',').map(Number);
const showWorst = Number(opt('worst', '4'));
const STEP = 1 / 120;

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const f1 = (v: number) => v.toFixed(1);
const fv = (v: V3) => `(${v.map(f1).join(',')})`;

interface Snap {
  s: number;
  x: number;
  psi: number;
  phi: number;
  v: number;
  roll: number;
  /** Parts already broken before this step (one crash can land several hits, and break parts between them). */
  broken: Set<PartId>;
}

interface Row {
  key: string;
  n: number;
  flags: Record<string, number>;
}
interface Example {
  key: string;
  score: number;
  text: string;
}

const FLAGS = ['away', 'point', 'outline', 'void', 'energy', 'rear', 'landing'];
const rows = new Map<string, Row>();
const examples: Example[] = [];
let total = 0;
let flagged = 0;

/** Where on the course a contact happened. */
function place(t: Track, s: number, x: number, rock?: Obstacle): string {
  if (rock?.kind === 'slot') return 'slot';
  const c = t.shortcutAt(s, x);
  if (c) return c.kind;
  if (rock?.kind === 'ridge') return 'ridge';
  if (t.kickers.some((k) => s > k.s0 - 5 && s < k.s1 + 5 && Math.abs(x - k.x) < KICKER_HALF + KICKER_TAPER + 4)) return 'kicker';
  return 'open';
}

/** The pod's outline from its anchors (pod space box), for the outline check. */
function outline(anchors: Record<PartId, PartAnchor>): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const id of PART_IDS) {
    const a = anchors[id];
    if (!a) continue;
    const ext = [a.r, a.r, a.r + (a.len ?? 0)];
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a.pos[k] - ext[k]);
      hi[k] = Math.max(hi[k], a.pos[k] + ext[k]);
    }
  }
  return [lo, hi];
}

function audit(race: Race, snaps: Map<Racer, Snap>, r: Racer, hits: PartHit[], hit: Hit, label: string) {
  const t = race.track;
  const st = r.state;
  const snap = snaps.get(r) ?? { s: st.s, x: st.x, psi: st.psi, phi: st.phi, v: st.v, roll: st.roll, broken: new Set<PartId>() };
  const knife = (-snap.roll * Math.PI) / 2;
  const wrecked = r.wrecked > 0;
  const w = r.wreck;
  // `toward`: the unit direction (pod space) from the pod to what it hit, worked out from the situation itself.
  let toward: V3 | null = null;
  let what = '';
  let where = 'open';
  let rearFront: boolean | null = null;
  // The rule for a nose square into a rock at speed (physics headOn): the pod is shattered outright (shatter breaks the
  // hull and the engine on the side hit, everything they carry going with them), checked on its own below.
  const headOn = st.headOn && hits.some((h) => h.part === 'hull' && h.broke);
  // A hit that wrecks the pod can be followed by the rest of the same contact (contactHits): those still count as
  // what they were, only the wreck's own bounces and wall slides are its tumble.
  const kind = headOn ? 'head-on' : hit.kind === 'ground' ? 'bounce' : wrecked && hit.kind === 'wall' ? 'wreck-wall' : hit.kind;
  if (kind === 'wall') {
    const side = Math.sign(snap.x) || 1;
    toward = toPodSpace(side, 0, 0, snap.psi, 0, knife);
    const nose = (-snap.psi * side * 180) / Math.PI;
    const vel = (-snap.phi * side * 180) / Math.PI;
    what = `${side < 0 ? 'left' : 'right'} wall, nose ${f1(nose)}deg / path ${f1(vel)}deg into it, ${f1(snap.v)} m/s, roll ${f1(snap.roll)}`;
    where = place(t, st.s, st.x);
  } else if (kind === 'rock' || kind === 'head-on') {
    // The rock touching the pod. In a formation (a slot canyon is rows of rocks down both sides) several touch at
    // once: of those in reach, the one the hit faces best is the one it came from; failing any, the nearest.
    let best: Obstacle | undefined;
    let fit = -Infinity;
    let gap = Infinity;
    const reach = podHalfWidth(st) + 1.5;
    for (const o of t.obstacles) {
      const d = Math.hypot(o.s - st.s, o.x - st.x) - o.r;
      const dir = norm(toPodSpace(o.x - st.x, 0, st.s - o.s, snap.psi, 0, knife));
      const f = dot(dir, norm(hit.point));
      if (d < reach && Math.abs(o.s - st.s) < o.r + 4 ? f > fit : fit === -Infinity && d < gap) {
        if (d < reach) fit = f;
        gap = Math.min(gap, d);
        best = o;
      }
    }
    if (best) {
      // Height of the rock's side facing the pod, relative to the pod: its base to its top, the pod's centre if between.
      const base = t.lift(best.s, best.x) - st.h;
      const ry = Math.max(base, Math.min(base + best.h, 0));
      toward = norm(toPodSpace(best.x - st.x, ry, st.s - best.s, snap.psi, 0, knife));
      const bearing = (Math.atan2(toward[0], -toward[2]) * 180) / Math.PI;
      what = `${best.kind} r ${f1(best.r)} at ${f1(bearing)}deg off the nose (pod space ${fv(toward)}), ${f1(snap.v)} m/s, roll ${f1(snap.roll)}`;
      where = place(t, st.s, st.x, best);
    }
  } else if (kind === 'pod') {
    // In a pack several pods can be in reach: the one the hit faces best is the one it came from (if none in reach
    // faces it, the hit is wrong whichever it was).
    let other: Racer | undefined;
    let d = -Infinity;
    for (const o of race.racers) {
      // A pod wrecked by this same contact (the other half of it went first) still counts.
      if (o === r || o.wrecked < WRECK_TIME - 1e-6 && o.wrecked > 0 || o.ghost > 0) continue;
      const lat = o.state.x - st.x;
      const along = o.state.s - st.s;
      if (Math.abs(along) > 8.5 || Math.abs(lat) > 8 || Math.abs(o.state.h - st.h) > 2.5) continue;
      const dd = dot(norm(toPodSpace(lat, 0, -along, snap.psi, 0, knife)), norm(hit.point));
      if (dd > d) {
        d = dd;
        other = o;
      }
    }
    if (other) {
      const lat = other.state.x - st.x;
      const along = other.state.s - st.s;
      toward = norm(toPodSpace(lat, 0, -along, snap.psi, 0, knife));
      what = `other pod ${f1(along)} m ahead, ${f1(lat)} m right, closing ${f1(snap.v - other.state.v)} m/s, roll ${f1(snap.roll)}`;
      // Nose to tail (lined up, one behind the other): who is in front.
      if (Math.abs(along) > 3 && Math.abs(lat) < 4.5) rearFront = along < 0;
      where = place(t, st.s, st.x);
    }
  } else if (kind === 'bounce') {
    toward = toPodSpace(0, -1, 0, w.yaw, w.pitch, w.roll);
    what = `wreck bounce, roll ${f1((w.roll * 180) / Math.PI)} pitch ${f1((w.pitch * 180) / Math.PI)} yaw ${f1((w.yaw * 180) / Math.PI)}deg`;
    where = place(t, st.s, st.x);
  } else if (kind === 'wreck-wall') {
    toward = toPodSpace(Math.sign(st.x), 0, 0, w.yaw, w.pitch, w.roll);
    what = `wreck into the ${st.x < 0 ? 'left' : 'right'} wall, roll ${f1((w.roll * 180) / Math.PI)} pitch ${f1((w.pitch * 180) / Math.PI)}deg`;
    where = place(t, st.s, st.x);
  } else what = `${hit.kind}`;

  const flags: string[] = [];
  let score = 0;
  // Damage-weighted centre of the parts the hit itself damaged (not the parts a broken one took with it: they come off
  // wherever they are).
  const carried = new Set<PartId>();
  for (const h of hits) if (h.broke) for (const id of PARTS[h.part]?.carries ?? []) carried.add(id);
  let sum = 0;
  const c: V3 = [0, 0, 0];
  let away = 0;
  for (const h of hits) {
    const a = r.anchors[h.part];
    if (!a || carried.has(h.part) || kind === 'head-on') continue;
    sum += h.amount;
    for (let k = 0; k < 3; k++) c[k] += a.pos[k] * h.amount;
    if (toward && dot(a.pos as V3, toward) < -0.8) away += h.amount;
  }
  if (sum > 0) for (let k = 0; k < 3; k++) c[k] /= sum;
  if (toward && sum > 0) {
    const cd = dot(c, toward);
    if (cd < -0.2 || away / sum > 0.35) {
      flags.push('away');
      score += Math.max(0, -cd) + away / sum;
    }
    if (dot(hit.point, toward) < -0.3 || dot(hit.dir, toward) > 0.3) {
      flags.push('point');
      score += 0.5;
    }
  }
  const [lo, hi] = outline(r.anchors);
  const out = Math.max(...[0, 1, 2].map((k) => Math.max(lo[k] - 0.6 - hit.point[k], hit.point[k] - hi[k] - 0.6)));
  if (out > 0) {
    flags.push('outline');
    score += out;
  }
  let near = Infinity;
  for (const id of PART_IDS) {
    const a = r.anchors[id];
    if (!a || snap.broken.has(id)) continue;
    const z = Math.max(a.pos[2] - (a.len ?? 0), Math.min(a.pos[2] + (a.len ?? 0), hit.point[2]));
    near = Math.min(near, Math.hypot(hit.point[0] - a.pos[0], hit.point[1] - a.pos[1], hit.point[2] - z) - a.r);
  }
  // Broken parts are gone, so a pod falling apart has more empty space: only judge what is still there.
  if (near > 0.5 && kind !== 'head-on') {
    flags.push('void');
    score += near;
  }
  if (!Number.isFinite(hit.energy) || hit.energy < 0 || hit.energy > 2.0001) {
    flags.push('energy');
    score += 1;
  }
  if (rearFront !== null && sum > 0) {
    // In front: the damage belongs on its back half (+z); behind: on its front half.
    if (rearFront ? c[2] < -0.5 : c[2] > 0.5) {
      flags.push('rear');
      score += Math.abs(c[2]);
    }
  }
  if (kind === 'head-on') {
    // The engine on the side the rock is on must be the one that goes (the rock's side in pod space, as the hit has it).
    const want = hit.point[0] < 0 ? 'nacelleL' : 'nacelleR';
    if (!hits.some((h) => h.part === want && h.broke) || (toward && dot(hit.point, toward) < -0.3)) {
      flags.push('away');
      score += 1;
    }
  }
  if (hit.kind === 'landing') {
    flags.push('landing');
    score += 1;
  }

  const key = `${kind.padEnd(10)} ${where}`;
  const row = rows.get(key) ?? { key, n: 0, flags: Object.fromEntries(FLAGS.map((f) => [f, 0])) };
  row.n++;
  for (const f of flags) row.flags[f]++;
  rows.set(key, row);
  total++;
  if (flags.length) {
    flagged++;
    const parts = hits.slice(0, 5).map((h) => `${h.part} ${h.amount.toFixed(2)}${h.broke ? '!' : ''}`).join(', ');
    examples.push({
      key: key.replace(/ +/, ' '),
      score,
      text:
        `[${flags.join(',')}] ${label} ${r.name} ${kind} @${where}: ${what}\n` +
        `      hit e ${hit.energy.toFixed(2)} point ${fv(hit.point)} dir ${fv(hit.dir)} | damage centre ${fv(c)} | ${parts}`,
    });
  }
}

const started = Date.now();
for (const id of trackIds) {
  const def = trackById(id);
  for (const di of diffs) {
    const d = DIFFICULTIES[di];
    for (let run = 0; run < runs; run++) {
      const setups = quickRaceRacers(playerRacer(newCareer('Player')), 8, d.skill, d.upgrades);
      const snaps = new Map<Racer, Snap>();
      const label = `${id}/${d.name}#${run + 1}`;
      let race!: Race;
      race = new Race(def, setups, { onParts: (r, hits, hit) => audit(race, snaps, r, hits, hit, label) });
      race.autopilot = true;
      (race as unknown as { playerAi: object }).playerAi = { skill: d.skill, bias: 0, aggression: 0.6 };
      while (race.time < 400 && !race.racers.every((r) => r.finish !== null)) {
        for (const r of race.racers) {
          const st = r.state;
          const sn = snaps.get(r);
          const pose = { s: st.s, x: st.x, psi: st.psi, phi: st.phi, v: st.v, roll: st.roll };
          if (sn) {
            Object.assign(sn, pose);
            if (sn.broken.size !== r.parts.broken.size) sn.broken = new Set(r.parts.broken);
          } else snaps.set(r, { ...pose, broken: new Set(r.parts.broken) });
        }
        race.update(STEP + 1e-9);
      }
    }
  }
}

console.log(`\n${total} damaging hits in ${trackIds.length * diffs.length * runs} races, ${flagged} flagged (${((flagged / Math.max(1, total)) * 100).toFixed(1)}%), ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
console.log(`${'kind       place'.padEnd(24)} ${'hits'.padStart(6)} ${FLAGS.map((f) => f.padStart(8)).join('')}`);
for (const row of [...rows.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  console.log(`${row.key.padEnd(24)} ${String(row.n).padStart(6)} ${FLAGS.map((f) => String(row.flags[f] || '.').padStart(8)).join('')}`);
}
// The worst few of each kind and place, so one noisy kind does not hide the others.
const groups = new Map<string, Example[]>();
for (const e of examples) groups.set(e.key, [...(groups.get(e.key) ?? []), e]);
for (const [key, list] of [...groups].sort()) {
  console.log(`\nworst ${key} (${list.length} flagged):`);
  for (const e of list.sort((a, b) => b.score - a.score).slice(0, showWorst)) console.log(`  ${e.text}`);
}
