// Small vector / box / random helpers shared by server simulation and client prediction.
// Keep this file free of Node and DOM APIs: it is compiled into the backend and bundled into the frontend.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Compact wire form of a vector. */
export type Vec3Tuple = [number, number, number];

export const TAU = Math.PI * 2;

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vclone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const vcopy = (out: Vec3, a: Vec3): Vec3 => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
};
export const vset = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};
export const vadd = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vscale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
/** out = a + b * s */
export const vaddScaled = (out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 => {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
};
export const vdot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vlen2 = (a: Vec3) => a.x * a.x + a.y * a.y + a.z * a.z;
export const vlen = (a: Vec3) => Math.sqrt(vlen2(a));
export const vdist2 = (a: Vec3, b: Vec3) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
export const vdist = (a: Vec3, b: Vec3) => Math.sqrt(vdist2(a, b));
/** Horizontal (xz) distance. */
export const hdist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
export const vnormalize = (a: Vec3): Vec3 => {
  const l = vlen(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
};
export const vlerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
export const toTuple = (a: Vec3): Vec3Tuple => [round3(a.x), round3(a.y), round3(a.z)];
export const fromTuple = (t: Vec3Tuple): Vec3 => ({ x: t[0], y: t[1], z: t[2] });

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Wraps an angle to [-PI, PI]. */
export const wrapAngle = (a: number) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
export const lerpAngle = (a: number, b: number, t: number) => a + wrapAngle(b - a) * t;

/** Yaw convention used everywhere: yaw 0 looks down -Z (three.js default), positive yaw turns left. */
export const yawForward = (yaw: number): Vec3 => ({ x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) });
export const yawRight = (yaw: number): Vec3 => ({ x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) });
/** Unit vector for a yaw/pitch pair (pitch positive = looking up). */
export const lookDir = (yaw: number, pitch: number): Vec3 => {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
};
/** Inverse of lookDir. */
export const dirToAngles = (d: Vec3): { yaw: number; pitch: number } => ({
  yaw: Math.atan2(-d.x, -d.z),
  pitch: Math.asin(clamp(d.y / (vlen(d) || 1), -1, 1)),
});

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export const aabb = (minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): AABB => ({
  min: { x: minX, y: minY, z: minZ },
  max: { x: maxX, y: maxY, z: maxZ },
});
export const aabbFromCenter = (c: Vec3, size: Vec3): AABB => ({
  min: { x: c.x - size.x / 2, y: c.y - size.y / 2, z: c.z - size.z / 2 },
  max: { x: c.x + size.x / 2, y: c.y + size.y / 2, z: c.z + size.z / 2 },
});
export const aabbCenter = (b: AABB): Vec3 => ({
  x: (b.min.x + b.max.x) / 2,
  y: (b.min.y + b.max.y) / 2,
  z: (b.min.z + b.max.z) / 2,
});
export const aabbSize = (b: AABB): Vec3 => ({ x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z });
export const aabbOverlap = (a: AABB, b: AABB) =>
  a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y && a.min.z < b.max.z && a.max.z > b.min.z;
export const pointInAABB = (p: Vec3, b: AABB) =>
  p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
export const expandAABB = (b: AABB, r: number): AABB => ({
  min: { x: b.min.x - r, y: b.min.y - r, z: b.min.z - r },
  max: { x: b.max.x + r, y: b.max.y + r, z: b.max.z + r },
});

export interface RayHit {
  t: number;
  normal: Vec3;
}

/**
 * Slab test of the ray origin + dir * t against a box. Returns the entry distance t in [0, maxT] and the face
 * normal, or null. dir need not be normalized (t is then in multiples of dir). A ray starting inside returns t = 0.
 */
export function rayAABB(origin: Vec3, dir: Vec3, box: AABB, maxT = Infinity): RayHit | null {
  let tmin = 0;
  let tmax = maxT;
  let normal: Vec3 = { x: 0, y: 0, z: 0 };
  const axes: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];
  for (const ax of axes) {
    const o = origin[ax];
    const d = dir[ax];
    const lo = box.min[ax];
    const hi = box.max[ax];
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (lo - o) * inv;
    let t2 = (hi - o) * inv;
    let n = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      n = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      normal = { x: 0, y: 0, z: 0 };
      normal[ax] = n;
    }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return { t: tmin, normal };
}

/** Segment a→b against a box; t is in [0, 1]. */
export const segmentAABB = (a: Vec3, b: Vec3, box: AABB) => rayAABB(a, vsub(b, a), box, 1);

/** Earliest hit of a segment against many boxes. */
export function segmentBoxes(a: Vec3, b: Vec3, boxes: readonly AABB[]): (RayHit & { index: number }) | null {
  let best: (RayHit & { index: number }) | null = null;
  const dir = vsub(b, a);
  for (let i = 0; i < boxes.length; i++) {
    const hit = rayAABB(a, dir, boxes[i], best ? best.t : 1);
    if (hit && (!best || hit.t < best.t)) best = { ...hit, index: i };
  }
  return best;
}

/** Deterministic PRNG (mulberry32); the same seed gives the same sequence on server and client. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const randomInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
export const pick = <T>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)];
export function shuffle<T>(r: () => number, arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
