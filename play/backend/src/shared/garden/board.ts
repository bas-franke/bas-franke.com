// Board geometry shared by the simulation and the renderer: where a board sits in the world, cell <-> world
// conversions, and positions along a route. In co-op there is one board (index 0) at the origin; in versus every
// player has their own copy of the map, laid out in rows of three.

import { G } from './constants.js';
import type { GMapDef, GRoute } from './maps.js';

export interface BoardOrigin {
  /** World x/z of the board's centre. */
  x: number;
  z: number;
}

export function boardOrigin(def: GMapDef, b: number, boards: number): BoardOrigin {
  if (boards <= 1) return { x: 0, z: 0 };
  const w = def.grid[0].length * G.cell + G.boardGap;
  const h = def.grid.length * G.cell + G.boardGap;
  // One row up to three boards, 2 x 2 for four, rows of three for five and six.
  const perRow = boards === 4 ? 2 : 3;
  const rows = Math.ceil(boards / perRow);
  const c = b % perRow;
  const r = Math.floor(b / perRow);
  // The last row may be shorter; centre it.
  const inRow = r === rows - 1 ? boards - r * perRow : perRow;
  return { x: (c - (inRow - 1) / 2) * w, z: (r - (rows - 1) / 2) * h };
}

/** World x/z of a point in cell units on board `o`. */
export function cellToWorld(def: GMapDef, o: BoardOrigin, cx: number, cy: number): { x: number; z: number } {
  const W = def.grid[0].length;
  const H = def.grid.length;
  return { x: o.x + (cx - W / 2) * G.cell, z: o.z + (cy - H / 2) * G.cell };
}

/** Cell under a world point on board `o` (may be outside the grid). */
export function worldToCell(def: GMapDef, o: BoardOrigin, x: number, z: number): { col: number; row: number } {
  const W = def.grid[0].length;
  const H = def.grid.length;
  return { col: Math.floor((x - o.x) / G.cell + W / 2), row: Math.floor((z - o.z) / G.cell + H / 2) };
}

export const cellAt = (def: GMapDef, col: number, row: number): string | undefined => def.grid[row]?.[col];

/** A route turned into world-space segments for fast lookups. */
export interface RouteGeom {
  route: GRoute;
  /** World points. */
  xs: number[];
  zs: number[];
  /** Cumulative length at each point. */
  cum: number[];
  length: number;
  /** Half-width in metres. */
  half: number;
}

export function routeGeom(def: GMapDef, o: BoardOrigin, route: GRoute): RouteGeom {
  const xs: number[] = [];
  const zs: number[] = [];
  const cum: number[] = [];
  let len = 0;
  route.pts.forEach(([cx, cy], i) => {
    const p = cellToWorld(def, o, cx, cy);
    if (i > 0) len += Math.hypot(p.x - xs[i - 1], p.z - zs[i - 1]);
    xs.push(p.x);
    zs.push(p.z);
    cum.push(len);
  });
  return { route, xs, zs, cum, length: len, half: route.half * G.cell };
}

export interface RoutePos {
  x: number;
  z: number;
  /** Heading of travel: yaw with 0 = facing -z, positive turns left (shared/math.ts convention). */
  yaw: number;
}

/** Corners are rounded over up to this many metres either side (less on short segments). */
const CORNER = 1.5;

/** Rounding window of corner `i` (an inner point of the route). */
const cornerW = (g: RouteGeom, i: number) => Math.min(CORNER, (g.cum[i] - g.cum[i - 1]) * 0.5, (g.cum[i + 1] - g.cum[i]) * 0.5);

/**
 * Position `d` metres along the route, pushed sideways by `lateral` (-1..1 of the half-width, + = right of travel).
 * Corners are rounded with a quadratic curve, and the sideways push follows the curve's normal, so units on the edge
 * of the path neither jump nor snap direction at a bend.
 */
export function routePos(g: RouteGeom, d: number, lateral = 0, out: RoutePos = { x: 0, z: 0, yaw: 0 }): RoutePos {
  const n = g.cum.length;
  if (n < 2) {
    out.x = g.xs[0] ?? 0;
    out.z = g.zs[0] ?? 0;
    out.yaw = 0;
    return out;
  }
  const dd = Math.max(0, Math.min(g.length, d));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (g.cum[mid] <= dd) lo = mid;
    else hi = mid;
  }
  let px: number;
  let pz: number;
  let tx: number;
  let tz: number;
  const toEnd = g.cum[lo + 1] - dd;
  const fromStart = dd - g.cum[lo];
  const wEnd = lo + 1 < n - 1 ? cornerW(g, lo + 1) : 0;
  const wStart = lo > 0 ? cornerW(g, lo) : 0;
  let c = -1;
  let t = 0;
  if (wEnd > 0 && toEnd < wEnd) {
    c = lo + 1;
    t = (wEnd - toEnd) / (2 * wEnd);
  } else if (wStart > 0 && fromStart < wStart) {
    c = lo;
    t = 0.5 + fromStart / (2 * wStart);
  }
  if (c >= 0) {
    // Quadratic Bezier from w before the corner to w after it, with the corner as control point.
    const w = cornerW(g, c);
    const cx = g.xs[c];
    const cz = g.zs[c];
    const l0 = g.cum[c] - g.cum[c - 1];
    const l1 = g.cum[c + 1] - g.cum[c];
    const ax = cx + ((g.xs[c - 1] - cx) * w) / l0;
    const az = cz + ((g.zs[c - 1] - cz) * w) / l0;
    const bx = cx + ((g.xs[c + 1] - cx) * w) / l1;
    const bz = cz + ((g.zs[c + 1] - cz) * w) / l1;
    const u = 1 - t;
    px = u * u * ax + 2 * u * t * cx + t * t * bx;
    pz = u * u * az + 2 * u * t * cz + t * t * bz;
    tx = 2 * u * (cx - ax) + 2 * t * (bx - cx);
    tz = 2 * u * (cz - az) + 2 * t * (bz - cz);
  } else {
    const l = g.cum[lo + 1] - g.cum[lo] || 1;
    tx = (g.xs[lo + 1] - g.xs[lo]) / l;
    tz = (g.zs[lo + 1] - g.zs[lo]) / l;
    px = g.xs[lo] + tx * fromStart;
    pz = g.zs[lo] + tz * fromStart;
  }
  const tl = Math.hypot(tx, tz) || 1;
  const fx = tx / tl;
  const fz = tz / tl;
  // Right of travel with y up: forward x up = (-fz, fx).
  const off = lateral * g.half * 0.8;
  out.x = px - fz * off;
  out.z = pz + fx * off;
  out.yaw = Math.atan2(-fx, -fz);
  return out;
}

/**
 * Flying enemies (Glow Moths) do not follow the paths: each ground route r has an air route that flies straight from
 * the route's portal mouth to its greenhouse door. Route indices on the wire: 0..routes-1 are the ground routes,
 * routes..2*routes-1 the air routes (air route of ground route r = routes + r).
 */
export function airRoute(route: GRoute): GRoute {
  return { entry: route.entry, pts: [route.pts[0], route.pts[route.pts.length - 1]], half: 0.6 };
}

/** Every route of a map in wire order: the ground routes, then their air routes. */
export const allRoutes = (def: GMapDef): GRoute[] => [...def.routes, ...def.routes.map(airRoute)];

/** Whether wire route index `r` is an air route on this map. */
export const isAirRoute = (def: GMapDef, r: number) => r >= def.routes.length;

/** Buildable mask for a map: true where a tower may stand (before towers are placed). */
export function buildableMask(def: GMapDef): boolean[][] {
  return def.grid.map((row) => [...row].map((c) => c === '.'));
}
