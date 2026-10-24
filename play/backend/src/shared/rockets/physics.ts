// Quake-style player movement and rocket sweeps for Rockets. Runs identically on the server (authoritative) and
// in the client (prediction), so it must be deterministic and must not touch anything outside its arguments.

import { aabbOverlap, clamp, hdist, segmentBoxes, type AABB, type Vec3, vnormalize, vsub, yawForward, yawRight } from '../math.js';
import { RK } from './constants.js';
import type { MapData } from './map.js';

export interface MoveInput {
  /** -1..1 forward/back. */
  f: number;
  /** -1..1 right/left. */
  s: number;
  jump: boolean;
  yaw: number;
}

export interface Body {
  /** Feet position (bottom centre of the box). */
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
}

export interface StepResult {
  landed: boolean;
  /** Index of the jump pad that fired this step, or -1. */
  pad: number;
}

export function playerAABB(pos: Vec3, out?: AABB): AABB {
  const hw = RK.halfWidth;
  if (out) {
    out.min.x = pos.x - hw;
    out.min.y = pos.y;
    out.min.z = pos.z - hw;
    out.max.x = pos.x + hw;
    out.max.y = pos.y + RK.height;
    out.max.z = pos.z + hw;
    return out;
  }
  return { min: { x: pos.x - hw, y: pos.y, z: pos.z - hw }, max: { x: pos.x + hw, y: pos.y + RK.height, z: pos.z + hw } };
}

function firstOverlap(box: AABB, map: MapData): AABB | null {
  for (const b of map.boxes) if (aabbOverlap(box, b)) return b;
  return null;
}

function accelerate(b: Body, wishX: number, wishZ: number, wishSpeed: number, accel: number, dt: number) {
  const current = b.vel.x * wishX + b.vel.z * wishZ;
  const add = wishSpeed - current;
  if (add <= 0) return;
  const a = Math.min(accel * dt * wishSpeed, add);
  b.vel.x += wishX * a;
  b.vel.z += wishZ * a;
}

function friction(b: Body, dt: number) {
  const speed = Math.hypot(b.vel.x, b.vel.z);
  if (speed < 1e-4) {
    b.vel.x = 0;
    b.vel.z = 0;
    return;
  }
  const control = Math.max(speed, RK.stopSpeed);
  const drop = control * RK.friction * dt;
  const scale = Math.max(speed - drop, 0) / speed;
  b.vel.x *= scale;
  b.vel.z *= scale;
}

/** CPM air control: steer the horizontal velocity toward the wish direction without adding speed. */
function airControl(b: Body, wishX: number, wishZ: number, strength: number, dt: number) {
  const speed = Math.hypot(b.vel.x, b.vel.z);
  if (speed < 1e-4) return;
  let dx = b.vel.x / speed;
  let dz = b.vel.z / speed;
  const dot = dx * wishX + dz * wishZ;
  if (dot <= 0) return;
  const k = 32 * strength * dot * dot * dt;
  dx = dx * speed + wishX * k;
  dz = dz * speed + wishZ * k;
  const l = Math.hypot(dx, dz) || 1;
  b.vel.x = (dx / l) * speed;
  b.vel.z = (dz / l) * speed;
}

const tmpBox: AABB = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };

/** Moves the body by vel * dt, sliding along boxes and stepping up low obstacles. */
function moveAndSlide(b: Body, map: MapData, dt: number): boolean {
  let landed = false;
  const wasOnGround = b.onGround;
  const dx = b.vel.x * dt;
  const dy = b.vel.y * dt;
  const dz = b.vel.z * dt;

  // Vertical.
  b.pos.y += dy;
  b.onGround = false;
  {
    const hit = firstOverlap(playerAABB(b.pos, tmpBox), map);
    if (hit) {
      if (dy <= 0) {
        b.pos.y = hit.max.y;
        if (b.vel.y < -1) landed = true;
        b.vel.y = 0;
        b.onGround = true;
      } else {
        b.pos.y = hit.min.y - RK.height - 1e-4;
        b.vel.y = 0;
      }
    }
  }

  // Horizontal, one axis at a time, with a step-up attempt when blocked.
  const horizontal = (axis: 'x' | 'z', d: number) => {
    if (d === 0) return;
    const before = b.pos[axis];
    b.pos[axis] += d;
    const hit = firstOverlap(playerAABB(b.pos, tmpBox), map);
    if (!hit) return;
    const rise = hit.max.y - b.pos.y;
    if ((wasOnGround || b.onGround) && rise > 0 && rise <= RK.stepHeight + 1e-4) {
      const savedY = b.pos.y;
      b.pos.y = hit.max.y + 1e-4;
      if (!firstOverlap(playerAABB(b.pos, tmpBox), map)) {
        b.onGround = true;
        return;
      }
      b.pos.y = savedY;
    }
    // Slide: back off to the face we hit.
    if (d > 0) b.pos[axis] = hit.min[axis] - RK.halfWidth - 1e-4;
    else b.pos[axis] = hit.max[axis] + RK.halfWidth + 1e-4;
    // A second box may still overlap after clamping (corners); then just undo the move.
    if (firstOverlap(playerAABB(b.pos, tmpBox), map)) b.pos[axis] = before;
    b.vel[axis] = 0;
  };
  horizontal('x', dx);
  horizontal('z', dz);
  return landed;
}

/** Advances one body by one fixed step with the given input. */
export function stepBody(b: Body, input: MoveInput, map: MapData, dt = RK.dt): StepResult {
  const fwd = yawForward(input.yaw);
  const right = yawRight(input.yaw);
  let wishX = fwd.x * input.f + right.x * input.s;
  let wishZ = fwd.z * input.f + right.z * input.s;
  let wishLen = Math.hypot(wishX, wishZ);
  if (wishLen > 1e-6) {
    wishX /= wishLen;
    wishZ /= wishLen;
    wishLen = Math.min(wishLen, 1);
  } else {
    wishX = wishZ = 0;
  }

  if (b.onGround) {
    friction(b, dt);
    accelerate(b, wishX, wishZ, wishLen * RK.groundSpeed, RK.groundAccel, dt);
    if (input.jump) {
      b.vel.y = RK.jumpSpeed;
      b.onGround = false;
    }
  } else if (wishLen > 0) {
    // CPM/Warsow-style air movement. Every key combination does something useful:
    // - pushing against the current motion is a gentle air brake (never a hard stop, so knockback keeps its punch);
    // - forward + strafe is plain Quake air acceleration, so strafe jumping still builds speed;
    // - strafe alone adds a sharp, capped sideways push on top: turn the mouse with it to carve tight air turns;
    // - every key also bends the velocity toward the wish direction without changing its speed: fully with W or S
    //   alone, partly once a strafe key is held (so a key alone cannot swing a rocket jump or knockback around).
    const along = b.vel.x * wishX + b.vel.z * wishZ;
    if (along < 0) {
      accelerate(b, wishX, wishZ, wishLen * RK.airSpeed, RK.airStopAccel, dt);
    } else {
      accelerate(b, wishX, wishZ, wishLen * RK.airSpeed, RK.airAccel, dt);
      if (input.f === 0) accelerate(b, wishX, wishZ, wishLen * RK.airStrafeSpeed, RK.airStrafeAccel, dt);
    }
    airControl(b, wishX, wishZ, input.s === 0 ? RK.airControl : RK.airControl * RK.airControlStrafeScale, dt);
  }
  b.vel.y -= RK.gravity * dt;

  const landed = moveAndSlide(b, map, dt);

  let pad = -1;
  if (b.onGround) {
    for (let i = 0; i < map.pads.length; i++) {
      const p = map.pads[i];
      if (Math.abs(b.pos.y - p.pos.y) < 0.35 && hdist(b.pos, p.pos) <= p.radius) {
        b.vel.x = p.vel.x;
        b.vel.y = p.vel.y;
        b.vel.z = p.vel.z;
        b.onGround = false;
        pad = i;
        break;
      }
    }
  }
  return { landed, pad };
}

export const eyePosition = (pos: Vec3): Vec3 => ({ x: pos.x, y: pos.y + RK.eyeHeight, z: pos.z });
export const chestPosition = (pos: Vec3): Vec3 => ({ x: pos.x, y: pos.y + RK.height * 0.55, z: pos.z });

/**
 * Splash knockback on a body with feet at `pos` from an explosion at `at`: the velocity change (before the self
 * scale) and the damage falloff, or null when out of reach or behind cover. Shared so the client can predict its own
 * rocket jumps with exactly the server's numbers.
 */
export function splashKnock(at: Vec3, pos: Vec3, boxes: readonly AABB[], direct: boolean): { x: number; y: number; z: number; falloff: number } | null {
  const box = playerAABB(pos);
  const nx = clamp(at.x, box.min.x, box.max.x) - at.x;
  const ny = clamp(at.y, box.min.y, box.max.y) - at.y;
  const nz = clamp(at.z, box.min.z, box.max.z) - at.z;
  const d = Math.hypot(nx, ny, nz);
  if (d > RK.splashRadius) return null;
  const centre = { x: pos.x, y: pos.y + RK.height * 0.5, z: pos.z };
  if (!direct && segmentBoxes(at, centre, boxes)) return null; // behind cover
  const falloff = 1 - d / RK.splashRadius;
  // Away from the blast, with a guaranteed bit of lift so floor hits launch players.
  const dir = vnormalize(vsub(centre, at));
  if (dir.y < RK.knockbackLift) dir.y = RK.knockbackLift;
  const n = vnormalize(dir);
  const kick = RK.knockback * (direct ? 1 : falloff);
  return { x: n.x * kick, y: n.y * kick, z: n.z * kick, falloff };
}
