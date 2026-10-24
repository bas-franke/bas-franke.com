// Navigation graph for Rockets bots, generated from the arena boxes: a 2 m grid of standable points, linked where a
// player can walk (stairs and step-ups included) or drop, plus one-way links across jump pads.

import { aabbOverlap, hdist, type Vec3, v3 } from '../../shared/math.js';
import { RK } from '../../shared/rockets/constants.js';
import type { MapData } from '../../shared/rockets/map.js';
import { playerAABB } from '../../shared/rockets/physics.js';

export interface NavLink {
  to: number;
  cost: number;
  /** Walk onto the jump pad at the source node; the pad carries you to `to`. */
  pad?: number;
}

export interface NavNode {
  id: number;
  /** Feet position. */
  pos: Vec3;
  links: NavLink[];
}

export interface NavGraph {
  nodes: NavNode[];
}

const SPACING = 2;
const SAMPLE = 0.3;
const MAX_DROP = 11;
/** Boxes taller than this are walls, never a surface to stand on. */
const MAX_SURFACE_Y = 14;

/** Height of the surface a player can stand on at (x, z), or null if nothing fits there. */
export function groundAt(map: MapData, x: number, z: number): number | null {
  let best: number | null = null;
  for (const b of map.boxes) {
    if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y <= MAX_SURFACE_Y) {
      if (best === null || b.max.y > best) best = b.max.y;
    }
  }
  if (best === null) return null;
  // Headroom test with the box lifted by one step: a neighbouring stair tread must not disqualify the point,
  // exactly like the physics step-up would carry a player over it.
  const box = playerAABB(v3(x, best + RK.stepHeight + 0.02, z));
  for (const b of map.boxes) if (aabbOverlap(box, b)) return null;
  return best;
}

/**
 * Can a player walk in a straight line from a to b (climbing at most a step per sample)? Gaps only count when the
 * link drops: stepping off a ledge carries a player past the strip right next to a tall box, where no point fits.
 */
function walkable(map: MapData, a: Vec3, b: Vec3): boolean {
  const d = hdist(a, b);
  const n = Math.max(1, Math.ceil(d / SAMPLE));
  const dropping = a.y - b.y > RK.stepHeight + 1e-3;
  let prev = a.y;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const g = groundAt(map, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
    if (g === null) {
      if (dropping && i < n) continue;
      return false;
    }
    if (g - prev > RK.stepHeight + 1e-3) return false;
    if (prev - g > MAX_DROP) return false;
    prev = g;
  }
  return Math.abs(prev - b.y) < 0.05;
}

/** Where a player launched from `from` with `vel` comes down. */
function landingPoint(map: MapData, from: Vec3, vel: Vec3): Vec3 {
  const p = v3(from.x, from.y + 0.1, from.z);
  const v = v3(vel.x, vel.y, vel.z);
  const dt = 0.02;
  for (let i = 0; i < 400; i++) {
    v.y -= RK.gravity * dt;
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;
    const g = groundAt(map, p.x, p.z);
    if (v.y < 0 && g !== null && p.y <= g) return v3(p.x, g, p.z);
    if (p.y < map.killY) break;
  }
  return v3(p.x, 0, p.z);
}

export function buildNavGraph(map: MapData): NavGraph {
  const nodes: NavNode[] = [];
  const addNode = (pos: Vec3) => {
    const id = nodes.length;
    nodes.push({ id, pos, links: [] });
    return id;
  };

  const lim = map.half - 1;
  for (let x = -lim; x <= lim; x += SPACING) {
    for (let z = -lim; z <= lim; z += SPACING) {
      const g = groundAt(map, x, z);
      if (g !== null) addNode(v3(x, g, z));
    }
  }
  // Points of interest get their own nodes so paths end exactly on them.
  const extras: Vec3[] = [...map.pads.map((p) => p.pos), ...map.packs];
  for (const e of extras) {
    const g = groundAt(map, e.x, e.z);
    if (g === null) continue;
    const pos = v3(e.x, g, e.z);
    if (!nodes.some((n) => hdist(n.pos, pos) < 0.4 && Math.abs(n.pos.y - pos.y) < 0.5)) addNode(pos);
  }

  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue;
      const d = hdist(a.pos, b.pos);
      if (d > SPACING * 1.5) continue;
      if (walkable(map, a.pos, b.pos)) a.links.push({ to: b.id, cost: d + Math.max(0, b.pos.y - a.pos.y) * 2 });
    }
  }

  map.pads.forEach((pad, padIndex) => {
    const source = nodes.find((n) => hdist(n.pos, pad.pos) < 0.4 && Math.abs(n.pos.y - pad.pos.y) < 0.5);
    if (!source) return;
    const land = landingPoint(map, pad.pos, pad.vel);
    const target = nearestNode({ nodes }, land, 1.0);
    if (!target || target.id === source.id) return;
    source.links.push({ to: target.id, cost: 1, pad: padIndex });
  });

  return { nodes };
}

export function nearestNode(graph: NavGraph, pos: Vec3, maxDy = 1.2): NavNode | null {
  let best: NavNode | null = null;
  let bestD = Infinity;
  for (const n of graph.nodes) {
    const dy = Math.abs(n.pos.y - pos.y);
    if (dy > maxDy) continue;
    const d = hdist(n.pos, pos) + dy;
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** A* over the graph. Returns node ids from start (exclusive) to goal (inclusive), or null. */
export function findPath(graph: NavGraph, start: number, goal: number): number[] | null {
  if (start === goal) return [];
  const nodes = graph.nodes;
  const h = (i: number) => hdist(nodes[i].pos, nodes[goal].pos);
  const g = new Map<number, number>([[start, 0]]);
  const from = new Map<number, number>();
  const open = new Set<number>([start]);
  const f = new Map<number, number>([[start, h(start)]]);
  while (open.size) {
    let current = -1;
    let bestF = Infinity;
    for (const i of open) {
      const fi = f.get(i) ?? Infinity;
      if (fi < bestF) {
        bestF = fi;
        current = i;
      }
    }
    if (current === goal) {
      const path = [goal];
      let c = goal;
      while (from.has(c)) {
        c = from.get(c)!;
        if (c !== start) path.push(c);
      }
      return path.reverse();
    }
    open.delete(current);
    const gc = g.get(current)!;
    for (const link of nodes[current].links) {
      const tentative = gc + link.cost;
      if (tentative < (g.get(link.to) ?? Infinity)) {
        from.set(link.to, current);
        g.set(link.to, tentative);
        f.set(link.to, tentative + h(link.to));
        open.add(link.to);
      }
    }
  }
  return null;
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
