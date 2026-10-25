// Player movement and grenade flight for Last Light. Runs identically on the server (authoritative) and in the client
// (prediction), so it only reads its arguments and the world.

import type { AABB, Vec3 } from '../math.js';
import { yawForward, yawRight } from '../math.js';
import { ZB } from './constants.js';
import { firstBlock, type World } from './world.js';

export interface ZInput {
  /** Monotonic per client; the server echoes the last one it applied so the client can reconcile. */
  seq: number;
  f: number;
  s: number;
  jump: boolean;
  sprint: boolean;
  ads: boolean;
  /** Use key held: repair, buy, revive. */
  use: boolean;
  yaw: number;
  pitch: number;
}

export interface Body {
  /** Feet position. */
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
}

const box: AABB = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };

function bodyBox(p: Vec3, hw = ZB.halfWidth, h = ZB.height): AABB {
  box.min.x = p.x - hw;
  box.min.y = p.y;
  box.min.z = p.z - hw;
  box.max.x = p.x + hw;
  box.max.y = p.y + h;
  box.max.z = p.z + hw;
  return box;
}

/** Top speed for this input. */
export function moveSpeed(inp: ZInput, downed: boolean) {
  if (downed) return ZB.crawlSpeed;
  if (inp.ads) return ZB.adsSpeed;
  return inp.sprint && inp.f > 0 ? ZB.sprintSpeed : ZB.walkSpeed;
}

/** Advances a player by one fixed step. */
export function stepPlayer(b: Body, inp: ZInput, w: World, downed = false, dt: number = ZB.dt) {
  const fwd = yawForward(inp.yaw);
  const right = yawRight(inp.yaw);
  let wx = fwd.x * inp.f + right.x * inp.s;
  let wz = fwd.z * inp.f + right.z * inp.s;
  const len = Math.hypot(wx, wz);
  if (len > 1) {
    wx /= len;
    wz /= len;
  }
  const speed = moveSpeed(inp, downed);
  const accel = (b.onGround ? ZB.groundAccel : ZB.airAccel) * dt;
  const tx = wx * speed;
  const tz = wz * speed;
  const dx = tx - b.vel.x;
  const dz = tz - b.vel.z;
  const dl = Math.hypot(dx, dz);
  if (dl > 0) {
    const k = Math.min(1, (accel * Math.max(speed, 3)) / dl);
    b.vel.x += dx * k;
    b.vel.z += dz * k;
  }
  if (b.onGround && inp.jump && !downed) {
    b.vel.y = ZB.jumpSpeed;
    b.onGround = false;
  }
  b.vel.y -= ZB.gravity * dt;
  moveAndSlide(b, w, dt);
  if (b.pos.y < ZB.killY) {
    b.pos.y = 0.1;
    b.vel.y = 0;
  }
}

function moveAndSlide(b: Body, w: World, dt: number) {
  const wasOnGround = b.onGround;
  b.pos.y += b.vel.y * dt;
  b.onGround = false;
  const hitY = firstBlock(w, bodyBox(b.pos), 'player');
  if (hitY) {
    if (b.vel.y <= 0) {
      b.pos.y = hitY.max.y;
      b.onGround = true;
    } else b.pos.y = hitY.min.y - ZB.height - 1e-4;
    b.vel.y = 0;
  }
  const horizontal = (axis: 'x' | 'z', d: number) => {
    if (d === 0) return;
    const before = b.pos[axis];
    b.pos[axis] += d;
    const hit = firstBlock(w, bodyBox(b.pos), 'player');
    if (!hit) return;
    const rise = hit.max.y - b.pos.y;
    if ((wasOnGround || b.onGround) && rise > 0 && rise <= ZB.stepHeight + 1e-4) {
      const y = b.pos.y;
      b.pos.y = hit.max.y + 1e-4;
      if (!firstBlock(w, bodyBox(b.pos), 'player')) {
        b.onGround = true;
        return;
      }
      b.pos.y = y;
    }
    if (d > 0) b.pos[axis] = hit.min[axis] - ZB.halfWidth - 1e-4;
    else b.pos[axis] = hit.max[axis] + ZB.halfWidth + 1e-4;
    if (firstBlock(w, bodyBox(b.pos), 'player')) b.pos[axis] = before;
    b.vel[axis] = 0;
  };
  horizontal('x', b.vel.x * dt);
  horizontal('z', b.vel.z * dt);
  // Standing on air after the floor under us was shot away: start falling next step.
  if (b.onGround) return;
  if (b.vel.y === 0 && firstBlock(w, { min: { x: b.pos.x - ZB.halfWidth, y: b.pos.y - 0.03, z: b.pos.z - ZB.halfWidth }, max: { x: b.pos.x + ZB.halfWidth, y: b.pos.y, z: b.pos.z + ZB.halfWidth } }, 'player'))
    b.onGround = true;
}

export const eyeHeight = (downed: boolean) => (downed ? ZB.downedEye : ZB.eyeHeight);

// ---- grenades -----------------------------------------------------------------------------------------------------

export interface NadeBody {
  pos: Vec3;
  vel: Vec3;
}

const NADE_R = 0.07;

/** One step of a bouncing grenade; returns the impact speed when it bounced this step (for the clink), else 0. */
export function stepNade(n: NadeBody, w: World, dt: number = ZB.dt): number {
  n.vel.y -= ZB.gravity * dt;
  let impact = 0;
  for (const a of ['x', 'y', 'z'] as const) {
    const d = n.vel[a] * dt;
    if (d === 0) continue;
    n.pos[a] += d;
    const b: AABB = { min: { x: n.pos.x - NADE_R, y: n.pos.y - NADE_R, z: n.pos.z - NADE_R }, max: { x: n.pos.x + NADE_R, y: n.pos.y + NADE_R, z: n.pos.z + NADE_R } };
    if (firstBlock(w, b, 'nade')) {
      n.pos[a] -= d;
      impact = Math.max(impact, Math.abs(n.vel[a]));
      n.vel[a] *= -0.32;
      for (const o of ['x', 'y', 'z'] as const) if (o !== a) n.vel[o] *= 0.72;
    }
  }
  return impact > 1.2 ? impact : 0;
}
