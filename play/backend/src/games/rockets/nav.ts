// Navigation graph for Rockets bots, generated from the arena boxes: a 2 m grid of standable points on every level
// (so the floor under a bridge gets nodes too), linked where a player can walk (stairs and step-ups included) or drop,
// plus one-way links across jump pads and over gaps and ledges a plain jump clears. Pad and jump links are only kept
// when the real movement code (stepBody) lands a simulated bot on the target, so bots never trust a link they cannot
// fly. findPath runs A* on a binary heap and pulls the path straight where a player can walk the shortcut.

import { type AABB, hdist, type Vec3, v3, wrapAngle, yawForward, yawRight } from '../../shared/math.js';
import { RK } from '../../shared/rockets/constants.js';
import type { MapBox, MapData } from '../../shared/rockets/map.js';
import { type Body, playerAABB, stepBody } from '../../shared/rockets/physics.js';

export interface NavLink {
  to: number;
  cost: number;
  /** Walk onto the jump pad at the source node; the pad carries you to `to`. */
  pad?: number;
  /** Jump toward `to` once standing on the ground at least as close to `to` as `takeoff` (see shouldJump). */
  jump?: boolean;
  /** Where the run-up ends: the last flat ground before the gap or the ledge face. Only on jump links. */
  takeoff?: Vec3;
}

export interface NavNode {
  id: number;
  /** Feet position. */
  pos: Vec3;
  links: NavLink[];
  /** Count the node as reached within this horizontal distance (pad nodes: the pad fires at its rim). */
  reach?: number;
}

export interface NavGraph {
  nodes: NavNode[];
  /** Spatial buckets for nearestNode; graphs built by hand without it fall back to a linear scan. */
  index?: NodeIndex;
  /** Reused A* buffers, sized to the graph. */
  scratch?: Scratch;
  /** Box lookup for path smoothing. */
  world?: World;
}

const SPACING = 2;
const SAMPLE = 0.3;
const MAX_DROP = 11;
/** Boxes taller than this are walls, never a surface to stand on. */
const MAX_SURFACE_Y = 14;
/** Side of the square buckets boxes and nodes are sorted into. */
const CELL = 2;
/** Farthest gap a jump link may cross, and the highest ledge it may climb (a jump peaks at about 2.35 m). */
const JUMP_RANGE = 8;
const JUMP_RISE = 2.1;
/** Extra cost of a jump, and of any jump or drop over a lethal void, so bots only take them when they pay off. */
const JUMP_COST = 1.5;
const VOID_COST = 6;
/** Shortcuts are at most this long, and the strip either side of them must be walkable too. */
const SMOOTH_RANGE = 14;
const SMOOTH_SIDE = 0.3;
/** A* heuristic weight: pads fly faster than walking, so a full-distance heuristic would overestimate. */
const H_WEIGHT = 0.6;
/** Walks keep this far outside a pad's radius (the physics fires it when the feet centre is inside). */
const PAD_MARGIN = 0.8;
/** Turn rate (rad/s) of the bot the flight checks simulate; a normal bot turns 5, an easy one 2.5. */
const SIM_TURN = 4;

// ---- box lookup ------------------------------------------------------------------------------------------------

interface World {
  map: MapData;
  /** Lower corner of the bucket grid and its size in cells per side. */
  origin: number;
  n: number;
  cells: MapBox[][];
  tmp: AABB;
}

const worlds = new WeakMap<MapData, World>();

function worldFor(map: MapData): World {
  let w = worlds.get(map);
  if (w) return w;
  const origin = -map.half - 2;
  const n = Math.ceil((2 * map.half + 4) / CELL);
  const cells: MapBox[][] = Array.from({ length: n * n }, () => []);
  w = { map, origin, n, cells, tmp: playerAABB(v3()) };
  for (const b of map.boxes) {
    const x0 = cellIndex(w, b.min.x);
    const x1 = cellIndex(w, b.max.x);
    const z0 = cellIndex(w, b.min.z);
    const z1 = cellIndex(w, b.max.z);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cells[x * n + z].push(b);
  }
  worlds.set(map, w);
  return w;
}

function cellIndex(w: World, v: number): number {
  const i = Math.floor((v - w.origin) / CELL);
  return i < 0 ? 0 : i >= w.n ? w.n - 1 : i;
}

const cellAt = (w: World, x: number, z: number) => w.cells[cellIndex(w, x) * w.n + cellIndex(w, z)];

/** Does the box overlap any map box? */
function blocked(w: World, box: AABB): boolean {
  const x0 = cellIndex(w, box.min.x);
  const x1 = cellIndex(w, box.max.x);
  const z0 = cellIndex(w, box.min.z);
  const z1 = cellIndex(w, box.max.z);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      for (const b of w.cells[x * w.n + z]) {
        if (box.min.x < b.max.x && box.max.x > b.min.x && box.min.y < b.max.y && box.max.y > b.min.y && box.min.z < b.max.z && box.max.z > b.min.z) return true;
      }
    }
  }
  return false;
}

/**
 * Can a player stand with their feet at (x, y, z)? The headroom box is lifted by one step: a neighbouring stair tread
 * must not disqualify the point, exactly like the physics step-up would carry a player over it.
 */
function fits(w: World, x: number, y: number, z: number): boolean {
  return !blocked(w, playerAABB(v3(x, y + RK.stepHeight + 0.02, z), w.tmp));
}

/** Top of the highest box under (x, z) that is no higher than maxY, or null. */
function topBelow(w: World, x: number, z: number, maxY: number): number | null {
  let best: number | null = null;
  const lim = Math.min(maxY, MAX_SURFACE_Y);
  for (const b of cellAt(w, x, z)) {
    if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y <= lim && (best === null || b.max.y > best)) best = b.max.y;
  }
  return best;
}

/**
 * Height of the surface a player can stand on at (x, z), or null if nothing fits there. With `maxY` it is the
 * surface a player at that height would be standing on (the floor under a bridge for someone under the bridge);
 * without it the highest one.
 */
export function groundAt(map: MapData, x: number, z: number, maxY = Infinity): number | null {
  const w = worldFor(map);
  const g = topBelow(w, x, z, maxY);
  return g !== null && fits(w, x, g, z) ? g : null;
}

/** Every standable surface height at (x, z), highest first. */
function surfacesAt(w: World, x: number, z: number): number[] {
  const tops: number[] = [];
  for (const b of cellAt(w, x, z)) {
    if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y <= MAX_SURFACE_Y && !tops.includes(b.max.y)) tops.push(b.max.y);
  }
  tops.sort((a, b) => b - a);
  // A top inside another box (the floor under a stair tread) is no surface: anyone there stands on the box.
  const cell = cellAt(w, x, z);
  const buried = (y: number) => cell.some((b) => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.min.y <= y + 1e-3 && b.max.y > y + 1e-3);
  return tops.filter((y) => !buried(y) && fits(w, x, y, z));
}

/** Index of the pad a player standing at (x, y, z) could fire, or -1: within its radius plus a margin for drift. */
function padAt(map: MapData, x: number, y: number, z: number): number {
  for (let i = 0; i < map.pads.length; i++) {
    const p = map.pads[i];
    if (Math.abs(y - p.pos.y) < 0.35 && Math.hypot(x - p.pos.x, z - p.pos.z) <= p.radius + PAD_MARGIN) return i;
  }
  return -1;
}

/**
 * Grid points that sit right at a drop-off (the 2.4 m bridges put the grid 0.2 m from their edges) move half a metre
 * inward when the other side has ground, so a bot that drifts a little does not walk off.
 */
function awayFromEdge(w: World, x: number, y: number, z: number): Vec3 {
  const solid = (px: number, pz: number) => {
    const g = topBelow(w, px, pz, y + RK.stepHeight);
    return g !== null && y - g <= RK.stepHeight;
  };
  let dx = 0;
  let dz = 0;
  const r = 0.8;
  if (!solid(x + r, z) && solid(x - r, z)) dx = -0.5;
  else if (!solid(x - r, z) && solid(x + r, z)) dx = 0.5;
  if (!solid(x, z + r) && solid(x, z - r)) dz = -0.5;
  else if (!solid(x, z - r) && solid(x, z + r)) dz = 0.5;
  if ((dx || dz) && topBelow(w, x + dx, z + dz, y + 1e-3) === y && fits(w, x + dx, y, z + dz)) return v3(x + dx, y, z + dz);
  return v3(x, y, z);
}

/** Can a running jump cover d metres while climbing `rise` (negative: dropping) at all? A cheap pre-check. */
function jumpReaches(rise: number, d: number): boolean {
  const disc = RK.jumpSpeed * RK.jumpSpeed - 2 * RK.gravity * rise;
  if (disc < 0) return false;
  const t = (RK.jumpSpeed + Math.sqrt(disc)) / RK.gravity;
  return t * RK.groundSpeed >= d - 0.8;
}

/** Is there flat ground half a metre around pos on all four sides? Jumps only aim at landings that forgive a miss. */
function roomy(w: World, pos: Vec3): boolean {
  for (const [ox, oz] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) {
    if (groundAt(w.map, pos.x + ox, pos.z + oz, pos.y + RK.stepHeight) !== pos.y) return false;
  }
  return true;
}

/** Is pos within `margin` of the rim of a pad at its height? Jumps keep clear: a landing that drifts would fire it. */
function nearPad(map: MapData, pos: Vec3, margin: number): boolean {
  return map.pads.some((p) => Math.abs(pos.y - p.pos.y) < 0.35 && hdist(pos, p.pos) <= p.radius + RK.halfWidth + margin);
}

// ---- walking ---------------------------------------------------------------------------------------------------

interface WalkRules {
  /** Allow falling down more than a step on the way. */
  drop: boolean;
  /** How close the walk must end to b.y. */
  endTol: number;
  /** The one pad the walk may step on (the one at its end), or -1. */
  pad: number;
}

const LINK: WalkRules = { drop: true, endTol: 0.05, pad: -1 };
const SHORTCUT: WalkRules = { drop: false, endTol: 0.05, pad: -1 };
const SHORTCUT_SIDE: WalkRules = { drop: false, endTol: RK.stepHeight + 0.05, pad: -1 };

/**
 * Can a player walk in a straight line from a to b, following the level they start on (climbing at most a step per
 * sample, falling down any drop if allowed)? Stepping off a ledge carries a player past the strip right next to a
 * tall box, where no point fits; that only counts as long as the body still fits at the height it falls from.
 * Walks that cross a jump pad fail, since the pad would throw the player somewhere else.
 */
function walkable(w: World, ax: number, ay: number, az: number, bx: number, by: number, bz: number, rules: WalkRules): boolean {
  const d = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(d / SAMPLE));
  const pads = w.map.pads.length > 0;
  let prev = ay;
  let falling = false;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const top = topBelow(w, x, z, prev + RK.stepHeight + 1e-3);
    if (top === null || !fits(w, x, top, z)) {
      // In the air: fine while dropping, if the body fits where it is.
      if (rules.drop && i < n && fits(w, x, prev, z)) {
        falling = true;
        continue;
      }
      return false;
    }
    if (prev - top > RK.stepHeight + 1e-3) {
      if (!rules.drop || prev - top > MAX_DROP) return false;
      falling = true;
    } else if (falling && !rules.drop) return false;
    prev = top;
    if (pads) {
      const p = padAt(w.map, x, prev, z);
      if (p >= 0 && p !== rules.pad) return false;
    }
  }
  return Math.abs(prev - by) <= rules.endTol;
}

/** Is there no ground at all (only the void) somewhere on the straight line from a to b? */
function overVoid(w: World, a: Vec3, b: Vec3): boolean {
  const n = Math.max(1, Math.ceil(hdist(a, b) / 0.5));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (topBelow(w, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, Math.max(a.y, b.y)) === null) return true;
  }
  return false;
}

/** Does the ground continue at the target's level as far as a full-speed drop could carry a player past it? */
function overshootRisk(w: World, a: Vec3, b: Vec3): boolean {
  const d = hdist(a, b) || 1;
  const dx = (b.x - a.x) / d;
  const dz = (b.z - a.z) / d;
  const carry = RK.groundSpeed * Math.sqrt((2 * (a.y - b.y)) / RK.gravity) + 1;
  // Along the line and a little to either side of it: a drain right beside the line counts too.
  for (const side of [0, -0.7, 0.7]) {
    for (let t = 0.5; t <= carry; t += 0.5) {
      const g = topBelow(w, b.x + dx * t - dz * side, b.z + dz * t + dx * side, b.y + RK.stepHeight + 1e-3);
      if (g === null || b.y - g > RK.stepHeight + 1e-3) return true;
    }
  }
  return false;
}

/** The last point on the flat run from a toward b before the ground ends, drops or rises past a step. */
function takeoffPoint(w: World, a: Vec3, b: Vec3): Vec3 {
  const d = hdist(a, b);
  const n = Math.max(1, Math.ceil(d / 0.15));
  let prev = a.y;
  let last = v3(a.x, a.y, a.z);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const top = topBelow(w, x, z, prev + RK.stepHeight + 1e-3);
    if (top === null || prev - top > RK.stepHeight + 1e-3 || !fits(w, x, top, z) || padAt(w.map, x, top, z) >= 0) break;
    prev = top;
    last = v3(x, top, z);
  }
  return last;
}

// ---- flight simulation -----------------------------------------------------------------------------------------

/** A copy of the map holding only the boxes near a flight, so a few hundred simulated steps stay cheap. */
function localMap(w: World, cx: number, cz: number, r: number): MapData {
  const set = new Set<MapBox>();
  const x0 = cellIndex(w, cx - r);
  const x1 = cellIndex(w, cx + r);
  const z0 = cellIndex(w, cz - r);
  const z1 = cellIndex(w, cz + r);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (const b of w.cells[x * w.n + z]) set.add(b);
  return { ...w.map, boxes: [...set] };
}

const yawTo = (from: Vec3, to: Vec3) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

interface Flight {
  /** Feet position on landing. */
  pos: Vec3;
  /** Seconds from the start to the landing. */
  time: number;
  /** A pad the landing fired (pads that throw you onto the next pad), or -1. */
  pad: number;
}

/**
 * Plays a bot heading for `target` exactly like a bot would (forward held, facing the target) with the real movement
 * code: it runs, jumps by the shouldJump rule when `takeoff` is given (else it starts on the pad `pad`, or with `drop`
 * it just walks off a ledge), steers in
 * the air and stops at the first landing. Null when it never takes off, fires another pad or falls out of the map.
 */
function fly(sub: MapData, start: Vec3, vel: Vec3, target: Vec3 | null, takeoff: Vec3 | null, pad: number, drop = false): Flight | null {
  const body: Body = { pos: v3(start.x, start.y, start.z), vel: v3(vel.x, vel.y, vel.z), onGround: true };
  if (!target) return coast(sub, body, pad);
  // Facing the way it already moves (or the target, from a standstill).
  const input = { f: 1, s: 0, jump: false, yaw: Math.hypot(vel.x, vel.z) > 0.5 ? Math.atan2(-vel.x, -vel.z) : yawTo(start, target) };
  const reach = takeoff ? hdist(takeoff, target) + 0.1 : 0;
  let launched = takeoff === null;
  let airborne = false;
  let landed: Flight | null = null;
  let settleUntil = 0;
  for (let k = 0; k < 60 * 5; k++) {
    // On the ground run at the target; in the air steer out the error of the predicted landing, like airSteer says.
    // Bots turn at a limited rate and press digital keys relative to where they look, so the flight does too.
    const dir = body.onGround ? v3(target.x - body.pos.x, 0, target.z - body.pos.z) : airSteer(body.pos, body.vel, target);
    input.f = 0;
    input.s = 0;
    const l = dir ? Math.hypot(dir.x, dir.z) : 0;
    if (l > 0.05) {
      const want = Math.atan2(-dir!.x, -dir!.z);
      const turn = wrapAngle(want - input.yaw);
      input.yaw += Math.abs(turn) <= SIM_TURN * RK.dt ? turn : Math.sign(turn) * SIM_TURN * RK.dt;
      const fwd = yawForward(input.yaw);
      const right = yawRight(input.yaw);
      const f = (dir!.x * fwd.x + dir!.z * fwd.z) / l;
      const sd = (dir!.x * right.x + dir!.z * right.z) / l;
      input.f = Math.abs(f) < 0.3 ? 0 : Math.sign(f);
      input.s = Math.abs(sd) < 0.3 ? 0 : Math.sign(sd);
    }
    input.jump = !launched && body.onGround && hdist(body.pos, target) <= reach;
    const r = stepBody(body, input, sub);
    if (input.jump) launched = true;
    if (r.pad >= 0 && r.pad !== pad) return null;
    if (landed) {
      // After touching down the bot still slides on its flight speed: it must come to rest on that level.
      if (k >= settleUntil) return body.pos.y > landed.pos.y - 0.3 ? landed : null;
      continue;
    }
    // A walk off a ledge only counts as in the air once it has fallen (the physics flickers at an edge).
    if (!body.onGround && (!drop || body.pos.y < start.y - RK.stepHeight)) airborne = true;
    else if (
      (launched && airborne && body.onGround) ||
      // Walking off a ledge: the drop may also be a staircase down, which ends on the target without any flight.
      (drop && body.onGround && hdist(body.pos, target) < 0.5 && Math.abs(body.pos.y - target.y) < 0.3)
    ) {
      landed = { pos: v3(body.pos.x, body.pos.y, body.pos.z), time: (k + 1) * RK.dt, pad: -1 };
      settleUntil = k + 30;
      continue;
    }
    if ((!launched || drop) && !airborne && k > 90) return null;
    // Falling past the target's level: it can only come down somewhere lower.
    if (airborne && body.vel.y < 0 && body.pos.y < target.y - 0.5) return null;
    if (body.pos.y < sub.killY) return null;
  }
  return null;
}

/**
 * Air steering toward a landing spot: the horizontal direction to push (world space) so a body flying with `vel`
 * comes down on `target`, or null when its predicted landing is already close enough (push nothing, or it overshoots).
 * Aims straight at the target while the body cannot get that high any more.
 */
export function airSteer(pos: Vec3, vel: Vec3, target: Vec3): Vec3 | null {
  const disc = vel.y * vel.y + 2 * RK.gravity * (pos.y - target.y);
  if (disc < 0) return v3(target.x - pos.x, 0, target.z - pos.z);
  const t = (vel.y + Math.sqrt(disc)) / RK.gravity;
  const ex = target.x - (pos.x + vel.x * t);
  const ez = target.z - (pos.z + vel.z * t);
  return ex * ex + ez * ez < 0.16 ? null : v3(ex, 0, ez);
}

/** A passenger that touches nothing: where a pad drops someone who does not steer. */
function coast(sub: MapData, body: Body, pad: number): Flight | null {
  const input = { f: 0, s: 0, jump: false, yaw: 0 };
  let airborne = false;
  for (let k = 0; k < 60 * 6; k++) {
    const r = stepBody(body, input, sub);
    if (r.pad >= 0 && r.pad !== pad) return airborne ? { pos: v3(body.pos.x, body.pos.y, body.pos.z), time: (k + 1) * RK.dt, pad: r.pad } : null;
    if (!body.onGround) airborne = true;
    else if (airborne) return { pos: v3(body.pos.x, body.pos.y, body.pos.z), time: (k + 1) * RK.dt, pad: -1 };
    if (body.pos.y < sub.killY) return null;
  }
  return null;
}

const landedOn = (f: Flight | null, target: Vec3, tol: number) => !!f && Math.abs(f.pos.y - target.y) < 0.3 && hdist(f.pos, target) <= tol;

// ---- graph -----------------------------------------------------------------------------------------------------

interface NodeIndex {
  origin: number;
  n: number;
  cells: number[][];
}

function buildIndex(nodes: NavNode[], half: number): NodeIndex {
  const origin = -half - 2;
  const n = Math.ceil((2 * half + 4) / CELL);
  const cells: number[][] = Array.from({ length: n * n }, () => []);
  const clampCell = (v: number) => Math.min(n - 1, Math.max(0, Math.floor((v - origin) / CELL)));
  for (const node of nodes) cells[clampCell(node.pos.x) * n + clampCell(node.pos.z)].push(node.id);
  return { origin, n, cells };
}

/** Calls fn for every node id whose bucket lies within r of (x, z). */
function forNear(index: NodeIndex, x: number, z: number, r: number, fn: (id: number) => void) {
  const c = (v: number) => Math.min(index.n - 1, Math.max(0, Math.floor((v - index.origin) / CELL)));
  const x1 = c(x + r);
  const z1 = c(z + r);
  for (let i = c(x - r); i <= x1; i++) for (let k = c(z - r); k <= z1; k++) for (const id of index.cells[i * index.n + k]) fn(id);
}

interface Scratch {
  g: Float64Array;
  stamp: Uint32Array;
  closed: Uint32Array;
  parent: Int32Array;
  via: (NavLink | null)[];
  heapF: Float64Array;
  heapN: Int32Array;
  run: number;
}

function scratchFor(graph: NavGraph): Scratch {
  const n = graph.nodes.length;
  if (graph.scratch && graph.scratch.g.length === n) return graph.scratch;
  let links = 1;
  for (const node of graph.nodes) links += node.links.length;
  graph.scratch = {
    g: new Float64Array(n),
    stamp: new Uint32Array(n),
    closed: new Uint32Array(n),
    parent: new Int32Array(n),
    via: new Array<NavLink | null>(n).fill(null),
    heapF: new Float64Array(links + 1),
    heapN: new Int32Array(links + 1),
    run: 0,
  };
  return graph.scratch;
}

/** Min-heap on (f, node) in the scratch arrays. Stale entries are skipped by the caller. */
function heapPush(s: Scratch, size: number, f: number, node: number): number {
  let i = size;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (s.heapF[p] <= f) break;
    s.heapF[i] = s.heapF[p];
    s.heapN[i] = s.heapN[p];
    i = p;
  }
  s.heapF[i] = f;
  s.heapN[i] = node;
  return size + 1;
}

function heapPop(s: Scratch, size: number): number {
  const last = size - 1;
  const f = s.heapF[last];
  const node = s.heapN[last];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= last) break;
    if (c + 1 < last && s.heapF[c + 1] < s.heapF[c]) c++;
    if (s.heapF[c] >= f) break;
    s.heapF[i] = s.heapF[c];
    s.heapN[i] = s.heapN[c];
    i = c;
  }
  s.heapF[i] = f;
  s.heapN[i] = node;
  return last;
}

/**
 * Dijkstra (h = null) or A* (h = goal) from start. Fills scratch g/parent/via for every settled node; returns true
 * when the goal was settled. Costs above `limit` are not explored.
 */
function search(graph: NavGraph, start: number, goal: number, limit: number, avoid?: ReadonlySet<number>): boolean {
  const s = scratchFor(graph);
  const nodes = graph.nodes;
  const run = ++s.run;
  const gp = goal >= 0 ? nodes[goal].pos : null;
  s.g[start] = 0;
  s.stamp[start] = run;
  s.parent[start] = -1;
  s.via[start] = null;
  let size = heapPush(s, 0, gp ? hdist(nodes[start].pos, gp) * H_WEIGHT : 0, start);
  while (size > 0) {
    const current = s.heapN[0];
    size = heapPop(s, size);
    if (s.closed[current] === run) continue;
    s.closed[current] = run;
    if (current === goal) return true;
    const gc = s.g[current];
    for (const link of nodes[current].links) {
      const to = link.to;
      if (s.closed[to] === run || (avoid && to !== goal && avoid.has(to))) continue;
      const tentative = gc + link.cost;
      if (tentative > limit) continue;
      if (s.stamp[to] !== run || tentative < s.g[to]) {
        s.stamp[to] = run;
        s.g[to] = tentative;
        s.parent[to] = current;
        s.via[to] = link;
        size = heapPush(s, size, tentative + (gp ? hdist(nodes[to].pos, gp) * H_WEIGHT : 0), to);
      }
    }
  }
  return false;
}

export function buildNavGraph(map: MapData): NavGraph {
  const w = worldFor(map);
  const nodes: NavNode[] = [];
  const addNode = (pos: Vec3) => {
    const id = nodes.length;
    nodes.push({ id, pos, links: [] });
    return id;
  };
  /** Ids of the node at each pad's centre, by pad index. */
  const padNode: number[] = [];
  const findNode = (pos: Vec3) => nodes.find((n) => hdist(n.pos, pos) < 0.4 && Math.abs(n.pos.y - pos.y) < 0.5);

  // One node per standable surface on the grid; none on a pad's rim, where a passing bot would be launched.
  const lim = map.half - 1;
  for (let x = -lim; x <= lim; x += SPACING) {
    for (let z = -lim; z <= lim; z += SPACING) {
      for (const y of surfacesAt(w, x, z)) {
        const pos = awayFromEdge(w, x, y, z);
        if (padAt(map, pos.x, pos.y, pos.z) < 0) addNode(pos);
      }
    }
  }

  // Points of interest get their own nodes so paths end exactly on them. Pads get the node at their centre.
  map.pads.forEach((pad, i) => {
    const y = groundAt(map, pad.pos.x, pad.pos.z, pad.pos.y + 0.1);
    if (y === null) return;
    const id = addNode(v3(pad.pos.x, y, pad.pos.z));
    nodes[id].reach = pad.radius;
    padNode[i] = id;
  });
  const extras: Vec3[] = [...map.packs, ...map.spawns.map((s) => s.pos)];
  // Where each pad drops a passenger that does not steer: a node there makes sure the landing is on the graph.
  const padLandings = map.pads.map((pad, i) => {
    if (padNode[i] === undefined) return null;
    const sub = localMap(w, pad.pos.x, pad.pos.z, Math.hypot(pad.vel.x, pad.vel.z) * 2.5 + 4);
    const f = fly(sub, nodes[padNode[i]].pos, v3(), null, null, i);
    if (f && f.pad < 0 && hdist(f.pos, pad.pos) > pad.radius + 1) extras.push(f.pos);
    return f;
  });
  for (const e of extras) {
    const y = groundAt(map, e.x, e.z, e.y + 0.1);
    if (y === null || Math.abs(y - e.y) > 0.6) continue;
    const pos = v3(e.x, y, e.z);
    if (padAt(map, pos.x, pos.y, pos.z) < 0 && !findNode(pos)) addNode(pos);
  }

  const index = buildIndex(nodes, map.half);
  const graph: NavGraph = { nodes, index, world: w };

  // Walking and dropping.
  const padOf = new Map<number, number>();
  padNode.forEach((id, i) => padOf.set(id, i));
  const padReach = Math.max(0, ...map.pads.map((p) => p.radius + PAD_MARGIN));
  const landings: [NavNode, Flight][] = [];
  for (const a of nodes) {
    if (padOf.has(a.id)) continue; // standing there fires the pad
    let near: MapData | null = null;
    // Pad nodes sit in a hole in the grid (no nodes on the rim), so links into them reach further.
    forNear(index, a.pos.x, a.pos.z, SPACING * 1.5 + padReach, (id) => {
      const b = nodes[id];
      if (a === b) return;
      const d = hdist(a.pos, b.pos);
      const pad = padOf.get(id);
      if (d > SPACING * 1.5 + (pad === undefined ? 0 : map.pads[pad].radius + PAD_MARGIN) || b.pos.y - a.pos.y > SPACING * 1.5) return;
      const rules = pad === undefined ? LINK : { ...LINK, pad };
      if (!walkable(w, a.pos.x, a.pos.y, a.pos.z, b.pos.x, b.pos.y, b.pos.z, rules)) return;
      const drops = a.pos.y - b.pos.y > RK.stepHeight + 1e-3;
      // Walking off at full speed carries a player well past the foot of the ledge: fly it to be sure it lands.
      // Only drops with something worse than the target's level just past it need that.
      if (drops && overshootRisk(w, a.pos, b.pos)) {
        near ??= localMap(w, a.pos.x, a.pos.z, SPACING * 1.5 + RK.groundSpeed * Math.sqrt((2 * MAX_DROP) / RK.gravity) + 1);
        // Bots arrive at full speed, often still moving along the previous link: try straight on and 45 degrees off.
        const heading = Math.atan2(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
        let first: Flight | null = null;
        let ok = true;
        for (const off of [0, -Math.PI / 4, Math.PI / 4]) {
          const run = v3(Math.sin(heading + off) * RK.groundSpeed, 0, Math.cos(heading + off) * RK.groundSpeed);
          const f = fly(near, a.pos, run, b.pos, null, pad ?? -1, true);
          if (off === 0) first = f;
          if (!f || Math.abs(f.pos.y - b.pos.y) > 0.3 || (hdist(f.pos, b.pos) > 1.2 && !walkable(w, f.pos.x, f.pos.y, f.pos.z, b.pos.x, b.pos.y, b.pos.z, SHORTCUT))) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          // Lands somewhere else but safely: remember where, the link may still go there (see below).
          if (first) landings.push([a, first]);
          return;
        }
      }
      const fall = drops && overVoid(w, a.pos, b.pos);
      a.links.push({ to: b.id, cost: d + Math.max(0, b.pos.y - a.pos.y) * 2 + (fall ? VOID_COST : 0) });
    });
  }

  // Drops that came down somewhere other than their target link to where they really land, unless the node
  // already has a way down there.
  for (const [a, f] of landings) {
    const n = nearestNode(graph, f.pos, 0.3);
    if (!n || n === a || hdist(n.pos, f.pos) > 1.2 || a.links.some((l) => l.to === n.id) || padOf.has(n.id)) continue;
    a.links.push({ to: n.id, cost: hdist(a.pos, n.pos) + (overVoid(w, a.pos, n.pos) ? VOID_COST : 0) });
  }

  // Pads: try the natural landing and, for pads that throw straight up, any higher ground a steering bot reaches.
  map.pads.forEach((pad, i) => {
    const source = padNode[i];
    if (source === undefined) return;
    const from = nodes[source].pos;
    const natural = padLandings[i];
    // Thrown straight onto the next pad: that pad's node is the target, and its own link carries on.
    if (natural && natural.pad >= 0 && padNode[natural.pad] !== undefined) {
      nodes[source].links.push({ to: padNode[natural.pad], cost: 1 + natural.time * RK.groundSpeed * 0.8, pad: i });
    }
    const up = pad.vel.x === 0 && pad.vel.z === 0;
    const around = natural ? natural.pos : from;
    const sub = localMap(w, around.x, around.z, Math.hypot(pad.vel.x, pad.vel.z) * 2.5 + 14);
    const chosen: NavNode[] = [];
    const tryTargets = (pick: (n: NavNode) => boolean, r: number, max: number) => {
      const candidates: NavNode[] = [];
      forNear(index, around.x, around.z, r, (id) => {
        if (id !== source && !padOf.has(id) && pick(nodes[id])) candidates.push(nodes[id]);
      });
      candidates.sort((p, q) => hdist(p.pos, around) - hdist(q.pos, around));
      let tried = 0;
      for (const c of candidates) {
        if (chosen.length >= max || tried >= 48) break;
        if (chosen.some((o) => hdist(o.pos, c.pos) < 4 && Math.abs(o.pos.y - c.pos.y) < 0.6)) continue;
        tried++;
        // Bots fire the pad anywhere on its rim, so the flight must work from the centre and from all four sides.
        const rim = pad.radius * 0.9;
        const starts = [from, v3(from.x + rim, from.y, from.z), v3(from.x - rim, from.y, from.z), v3(from.x, from.y, from.z + rim), v3(from.x, from.y, from.z - rim)];
        let time = 0;
        let ok = true;
        for (const st of starts) {
          const f = fly(sub, st, v3(), c.pos, null, i);
          if (!landedOn(f, c.pos, 1.6)) {
            ok = false;
            break;
          }
          time = Math.max(time, f!.time);
        }
        if (!ok) continue;
        chosen.push(c);
        nodes[source].links.push({ to: c.id, cost: 1 + time * RK.groundSpeed * 0.8, pad: i });
      }
    };
    if (!up) tryTargets((n) => hdist(n.pos, around) <= 3 && Math.abs(n.pos.y - around.y) < 0.6, 3, 1);
    else {
      tryTargets((n) => n.pos.y > pad.pos.y + 0.6, 10, 4);
      // Nothing higher in reach: at least steer off the pad, or a bot that walks on keeps bouncing forever.
      if (!chosen.length) tryTargets((n) => Math.abs(n.pos.y - pad.pos.y) < 0.3 && hdist(n.pos, from) > pad.radius + 0.8, 5, 1);
    }
  });

  addJumpLinks(graph, w);
  return graph;
}

/**
 * Jump links from nodes at an edge (a missing neighbour) to nodes a plain jump reaches that are far away or
 * unreachable on foot. Each is flown twice with the real movement code, from a slow and a full-speed run-up.
 */
function addJumpLinks(graph: NavGraph, w: World) {
  const { nodes, index } = graph;
  const s = scratchFor(graph);
  // Where a jump may come down: off pads and with room around it. Worked out once per node.
  const landable = nodes.map((b) => b.reach === undefined && !nearPad(w.map, b.pos, 1.2) && roomy(w, b.pos));
  for (const a of nodes) {
    if (a.reach !== undefined || a.links.length >= 8 || nearPad(w.map, a.pos, 0.8)) continue;
    let candidates: NavNode[] = [];
    forNear(index!, a.pos.x, a.pos.z, JUMP_RANGE, (id) => {
      const b = nodes[id];
      const d = hdist(a.pos, b.pos);
      const rise = b.pos.y - a.pos.y;
      if (b !== a && landable[id] && d >= 1 && d <= JUMP_RANGE && rise <= JUMP_RISE && -rise <= MAX_DROP) candidates.push(b);
    });
    if (!candidates.length) continue;
    // Walking costs from a, so jumps that only save a couple of steps are skipped.
    let far = 0;
    for (const b of candidates) far = Math.max(far, hdist(a.pos, b.pos));
    search(graph, a.id, -1, far * 2 + 4);
    const run = s.run;
    candidates = candidates.filter((b) => !(s.closed[b.id] === run && s.g[b.id] <= hdist(a.pos, b.pos) * 2 + 4));
    if (!candidates.length) continue;
    // A neighbour already jumping across to the same spot makes another jump redundant.
    const covered = (b: NavNode) =>
      a.links.some((l) => !l.jump && nodes[l.to].links.some((j) => j.jump && hdist(nodes[j.to].pos, b.pos) < 2.2 && Math.abs(nodes[j.to].pos.y - b.pos.y) < 0.6));
    candidates = candidates.filter((b) => !covered(b) && jumpReaches(b.pos.y - a.pos.y, hdist(a.pos, b.pos)));
    if (!candidates.length) continue;
    candidates.sort((p, q) => hdist(a.pos, p.pos) - hdist(a.pos, q.pos));
    const sub = localMap(w, a.pos.x, a.pos.z, JUMP_RANGE + 3);
    const chosen: NavNode[] = [];
    let tried = 0;
    for (const b of candidates) {
      if (chosen.length >= 3 || tried >= 10) break;
      if (chosen.some((o) => hdist(o.pos, b.pos) < 2.5 && Math.abs(o.pos.y - b.pos.y) < 0.6)) continue;
      tried++;
      const takeoff = takeoffPoint(w, a.pos, b.pos);
      const d = hdist(a.pos, b.pos);
      const dx = (b.pos.x - a.pos.x) / d;
      const dz = (b.pos.z - a.pos.z) / d;
      const slow = fly(sub, a.pos, v3(dx * RK.groundSpeed * 0.35, 0, dz * RK.groundSpeed * 0.35), b.pos, takeoff, -1);
      if (!landedOn(slow, b.pos, 1.2)) continue;
      const fast = fly(sub, a.pos, v3(dx * RK.groundSpeed, 0, dz * RK.groundSpeed), b.pos, takeoff, -1);
      if (!landedOn(fast, b.pos, 1.2)) continue;
      // Bots reach the node from the side as often as not: half a metre off the line, running in at 35 degrees.
      let sideways = true;
      for (const side of [-1, 1]) {
        const sx = a.pos.x - dz * 0.5 * side;
        const sz = a.pos.z + dx * 0.5 * side;
        if (groundAt(w.map, sx, sz, a.pos.y + 0.1) !== a.pos.y) continue;
        const c = Math.cos(0.6);
        const sn = Math.sin(0.6) * side;
        const run = v3((dx * c - dz * sn) * RK.groundSpeed, 0, (dz * c + dx * sn) * RK.groundSpeed);
        if (!landedOn(fly(sub, v3(sx, a.pos.y, sz), run, b.pos, takeoff, -1), b.pos, 1.2)) sideways = false;
      }
      if (!sideways) continue;
      chosen.push(b);
      const risky = overVoid(w, a.pos, b.pos);
      a.links.push({ to: b.id, cost: d + Math.max(0, b.pos.y - a.pos.y) * 2 + JUMP_COST + (risky ? VOID_COST : 0), jump: true, takeoff });
    }
  }
}

// ---- queries ---------------------------------------------------------------------------------------------------

/**
 * Closest node to pos within maxDy vertically. Nodes above pos count extra, so a bot in mid-jump under a bridge
 * still finds the floor it will land on rather than the bridge.
 */
export function nearestNode(graph: NavGraph, pos: Vec3, maxDy = 1.2): NavNode | null {
  let best: NavNode | null = null;
  let bestD = Infinity;
  const consider = (n: NavNode) => {
    const dy = n.pos.y - pos.y;
    if (Math.abs(dy) > maxDy) return;
    const d = hdist(n.pos, pos) + (dy > 0.3 ? dy * 3 : Math.abs(dy));
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  };
  const index = graph.index;
  if (!index) {
    for (const n of graph.nodes) consider(n);
    return best;
  }
  // Rings of buckets outward until the next ring cannot hold anything closer.
  const cx = Math.floor((pos.x - index.origin) / CELL);
  const cz = Math.floor((pos.z - index.origin) / CELL);
  for (let r = 0; r <= index.n; r++) {
    for (let i = cx - r; i <= cx + r; i++) {
      if (i < 0 || i >= index.n) continue;
      const edge = i === cx - r || i === cx + r;
      for (let k = cz - r; k <= cz + r; k += edge ? 1 : 2 * r) {
        if (k >= 0 && k < index.n) for (const id of index.cells[i * index.n + k]) consider(graph.nodes[id]);
        if (r === 0) break;
      }
    }
    if (bestD <= r * CELL) break;
  }
  return best;
}

/** The link from node `from` to node `to`, if there is a direct one (shortcut segments of a smoothed path have none). */
export function linkBetween(graph: NavGraph, from: number, to: number): NavLink | undefined {
  return graph.nodes[from]?.links.find((l) => l.to === to);
}

/**
 * On a jump link: jump now? True once a bot standing on the takeoff level is at least as close to the target as the
 * takeoff point (never again after it landed on another level).
 */
export function shouldJump(link: NavLink, target: Vec3, pos: Vec3, onGround: boolean): boolean {
  const t = link.takeoff;
  return !!link.jump && !!t && onGround && Math.abs(pos.y - t.y) < 0.6 && hdist(pos, target) <= hdist(t, target) + 0.1;
}

export interface PathOptions {
  /** Pull the path straight where a player can walk the shortcut (default true). */
  smooth?: boolean;
  /** Nodes to route around, e.g. a waypoint a bot got stuck on. */
  avoid?: ReadonlySet<number>;
}

/**
 * A* over the graph. Returns node ids from start (exclusive) to goal (inclusive), or null. Smoothed paths skip the
 * nodes in between where walking straight works; pad and jump links always keep both ends, so linkBetween on two
 * consecutive ids tells a bot when to jump or that a pad is next.
 */
export function findPath(graph: NavGraph, start: number, goal: number, opts: PathOptions = {}): number[] | null {
  if (start === goal) return [];
  if (!search(graph, start, goal, Infinity, opts.avoid)) return null;
  const s = graph.scratch!;
  const full = [goal];
  for (let c = goal; s.parent[c] >= 0; c = s.parent[c]) full.push(s.parent[c]);
  full.reverse();
  if (opts.smooth === false || !graph.world) return full.slice(1);
  const via = full.map((id) => s.via[id]);
  return smoothPath(graph, full, via);
}

/** String pulling: from each kept node, skip ahead to the farthest node a straight walk reaches. */
function smoothPath(graph: NavGraph, full: number[], via: (NavLink | null)[]): number[] {
  const w = graph.world!;
  const nodes = graph.nodes;
  const plain = (k: number) => !via[k]!.pad && !via[k]!.jump;
  const out: number[] = [];
  let i = 0;
  while (i < full.length - 1) {
    let j = i + 1;
    // Right after a pad, jump or drop the bot still carries its flight speed: let it settle on the next node first.
    const landing = i > 0 && (!plain(i) || nodes[full[i - 1]].pos.y - nodes[full[i]].pos.y > RK.stepHeight + 1e-3);
    if (plain(j) && !landing) {
      const a = nodes[full[i]].pos;
      while (j + 1 < full.length && plain(j + 1) && hdist(a, nodes[full[j + 1]].pos) <= SMOOTH_RANGE && straight(w, a, nodes[full[j + 1]].pos)) j++;
    }
    out.push(full[j]);
    i = j;
  }
  return out;
}

/** A shortcut must be walkable without drops along its centre line and along both sides of it. */
function straight(w: World, a: Vec3, b: Vec3): boolean {
  if (!walkable(w, a.x, a.y, a.z, b.x, b.y, b.z, SHORTCUT)) return false;
  const d = hdist(a, b) || 1;
  const ox = (-(b.z - a.z) / d) * SMOOTH_SIDE;
  const oz = ((b.x - a.x) / d) * SMOOTH_SIDE;
  return walkable(w, a.x + ox, a.y, a.z + oz, b.x + ox, b.y, b.z + oz, SHORTCUT_SIDE) && walkable(w, a.x - ox, a.y, a.z - oz, b.x - ox, b.y, b.z - oz, SHORTCUT_SIDE);
}

/**
 * Stuck detection for path following. Feed it every step with the waypoint being walked to; it reports true (once
 * per stall) when the bot got no closer to that waypoint for `after` seconds. The usual reaction: avoid that
 * waypoint for a while, jump, and plan again.
 */
export class StuckWatch {
  private node = -1;
  private best = Infinity;
  private since = 0;

  constructor(private readonly after = 1.2) {}

  /** Pass onGround: time in the air (a long drop, a pad flight) never counts as stuck. */
  update(now: number, pos: Vec3, node: NavNode, onGround = true): boolean {
    const d = hdist(pos, node.pos) + Math.abs(pos.y - node.pos.y) * 0.5;
    if (node.id !== this.node || d < this.best - 0.4 || !onGround) {
      this.node = node.id;
      this.best = d;
      this.since = now;
      return false;
    }
    if (now - this.since < this.after) return false;
    this.best = d;
    this.since = now;
    return true;
  }

  reset() {
    this.node = -1;
  }
}

const cache = new WeakMap<MapData, NavGraph>();
export function navGraphFor(map: MapData): NavGraph {
  let graph = cache.get(map);
  if (!graph) {
    graph = buildNavGraph(map);
    cache.set(map, graph);
  }
  return graph;
}
