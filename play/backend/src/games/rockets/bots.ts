// Rockets bots: navigate the arena on the nav graph, fight whoever they can see, dodge incoming rockets, grab health
// when low, and (on normal/hard) rocket-jump to the high ground or after a target. Rocket jumps are planned by
// simulating them with the real movement code first, so a bot only commits to a jump that lands where it wants.

import {
  clamp,
  dirToAngles,
  expandAABB,
  hdist,
  lerpAngle,
  lookDir,
  segmentAABB,
  segmentBoxes,
  type Vec3,
  v3,
  vadd,
  vdist,
  vnormalize,
  vscale,
  vsub,
  wrapAngle,
  yawForward,
  yawRight,
} from '../../shared/math.js';
import type { BotDifficulty } from '../../shared/protocol.js';
import { RK } from '../../shared/rockets/constants.js';
import type { MapData } from '../../shared/rockets/map.js';
import { chestPosition, eyePosition, playerAABB, stepBody, type Body } from '../../shared/rockets/physics.js';
import type { RocketsInput } from '../../shared/rockets/protocol.js';
import { findPath, nearestNode, type NavGraph, type NavNode } from './nav.js';

export interface BotParams {
  /** Radians of aim noise. */
  aimError: number;
  /** Max turn speed in rad/s. */
  turnRate: number;
  /** Seconds between first sight and first shot. */
  reaction: number;
  strafe: boolean;
  bhop: boolean;
  rocketJump: boolean;
  /** Probability per shot opportunity of actually firing. */
  trigger: number;
  /** Share of the target's velocity the bot leads by (1 = perfect prediction). */
  lead: number;
  /** Predicts airborne targets with gravity and the floor they will land on, instead of a straight line. */
  gravityLead: boolean;
  /** Chance of aiming at the feet of a grounded target (splash) instead of the body. */
  feet: number;
  /** Chance of noticing an incoming rocket, and seconds before reacting to it. */
  dodge: number;
  dodgeDelay: number;
  /** Health below which the bot goes looking for a pack. */
  healAt: number;
}

export const BOT_PARAMS: Record<BotDifficulty, BotParams> = {
  easy: {
    aimError: 0.15,
    turnRate: 2.6,
    reaction: 0.75,
    strafe: false,
    bhop: false,
    rocketJump: false,
    trigger: 0.45,
    lead: 0.35,
    gravityLead: false,
    feet: 0.3,
    dodge: 0.12,
    dodgeDelay: 0.4,
    healAt: 30,
  },
  normal: {
    aimError: 0.065,
    turnRate: 5,
    reaction: 0.35,
    strafe: true,
    bhop: false,
    rocketJump: true,
    trigger: 0.8,
    lead: 0.8,
    gravityLead: true,
    feet: 0.75,
    dodge: 0.5,
    dodgeDelay: 0.2,
    healAt: 45,
  },
  hard: {
    aimError: 0.025,
    turnRate: 11,
    reaction: 0.12,
    strafe: true,
    bhop: true,
    rocketJump: true,
    trigger: 1,
    lead: 1,
    gravityLead: true,
    feet: 1,
    dodge: 0.85,
    dodgeDelay: 0.07,
    healAt: 55,
  },
};

export interface BotSelf {
  id: string;
  body: Body;
  hp: number;
  dead: boolean;
  /** Sim time when the bot may fire again. */
  nextFire: number;
}

export interface BotEnemy {
  id: string;
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
}

export interface BotRocket {
  id: string;
  owner: string;
  pos: Vec3;
  vel: Vec3;
}

export interface BotView {
  now: number;
  self: BotSelf;
  enemies: BotEnemy[];
  packs: { pos: Vec3; available: boolean }[];
  /** Rockets in flight; without them bots cannot dodge. */
  rockets?: readonly BotRocket[];
  map: MapData;
  canSee(from: Vec3, to: Vec3): boolean;
}

type Mode = 'roam' | 'fight' | 'heal';

/** A planned rocket jump: jump, fire straight down `fireAt` steps later, then steer toward `dest` in the air. */
interface RocketJump {
  dest: Vec3;
  pitch: number;
  fireAt: number;
  step: number;
}

/** Highest surface at (x, z) no higher than `maxY`, or null over the void. Unlike nav's groundAt this counts tower tops. */
function floorBelow(map: MapData, x: number, z: number, maxY: number): number | null {
  let best: number | null = null;
  for (const b of map.boxes) {
    if (b.kind === 'clip') continue;
    if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z && b.max.y <= maxY && (best === null || b.max.y > best)) best = b.max.y;
  }
  return best !== null && best > map.killY ? best : null;
}

/**
 * Steering used during a rocket jump, both when planning it and when flying it: face the destination and press
 * forward (air control bends the velocity toward it), or back when we would overshoot before coming down.
 */
function rocketJumpSteer(body: Body, dest: Vec3, out: { yaw: number; f: number }) {
  const dx = dest.x - body.pos.x;
  const dz = dest.z - body.pos.z;
  out.yaw = Math.atan2(-dx, -dz);
  const remaining = Math.hypot(dx, dz);
  const g = RK.gravity;
  const disc = body.vel.y * body.vel.y + 2 * g * (body.pos.y - dest.y);
  const tLand = disc > 0 ? (body.vel.y + Math.sqrt(disc)) / g : 0;
  const along = (body.vel.x * dx + body.vel.z * dz) / (remaining || 1);
  out.f = remaining < 0.6 || along * tLand > remaining + 0.6 ? -1 : 1;
}

export class RocketsBot {
  private yaw = 0;
  private pitch = 0;
  private mode: Mode = 'roam';
  private path: number[] = [];
  private goal: NavNode | null = null;
  private repathAt = 0;
  private decideAt = 0;
  private targetId: string | null = null;
  private targetSeenAt = -1;
  private lastSeenPos: Vec3 | null = null;
  private firstSightAt = 0;
  private feetThisFight = true;
  private strafeDir = 1;
  private strafeUntil = 0;
  private errYaw = 0;
  private errPitch = 0;
  private errUntil = 0;
  private jumpUntil = 0;
  private rj: RocketJump | null = null;
  private rjTryAt = 0;
  /** A rocket jump the bot would like to make; tried on the next step it stands on the ground. */
  private rjWant: { dest: Vec3; until: number } | null = null;
  private dodgeDir: Vec3 | null = null;
  private dodgeUntil = 0;
  /** Riding a jump pad: pads are aimed, so any air steering only risks missing the landing. */
  private padFlight = false;
  private wasOnGround = true;
  private lastHp = 0;
  private readonly rockets = new Map<string, { at: number; react: boolean }>();
  private seq = 0;
  /** Per-bot quirks so a room of bots does not move in lockstep. */
  private readonly style: { range: number; strafeMin: number; strafeSpan: number; hop: number; aim: number; rjChance: number };
  /** Counters for tuning scripts. */
  readonly stats = { rocketJumps: 0, rocketJumpsLanded: 0, dodges: 0 };

  constructor(
    private readonly params: BotParams,
    private readonly graph: NavGraph,
    private readonly rng: () => number,
  ) {
    this.style = {
      range: 7 + rng() * 7,
      strafeMin: 0.35 + rng() * 0.4,
      strafeSpan: 0.5 + rng() * 1.0,
      hop: 0.004 + rng() * 0.014,
      aim: 0.8 + rng() * 0.4,
      rjChance: 0.3 + rng() * 0.4,
    };
  }

  /** Call once per simulation step. */
  think(view: BotView): RocketsInput {
    const { self, now } = view;
    const input: RocketsInput = { seq: ++this.seq, f: 0, s: 0, jump: false, fire: false, yaw: this.yaw, pitch: this.pitch };
    if (self.dead) {
      this.path = [];
      this.goal = null;
      this.rj = null;
      this.rjWant = null;
      this.dodgeDir = null;
      this.padFlight = false;
      return input;
    }

    const body = self.body;
    // A blast knocks us off the pad's arc: then steer for safety like any other fall.
    if (body.onGround || self.hp < this.lastHp) this.padFlight = false;
    else if (this.wasOnGround && view.map.pads.some((p) => hdist(body.pos, p.pos) <= p.radius + 0.6 && Math.abs(body.pos.y - p.pos.y) < 1)) this.padFlight = true;
    this.wasOnGround = body.onGround;
    this.lastHp = self.hp;

    if (this.rjWant && now < this.rjWant.until && body.onGround && now >= self.nextFire && self.hp >= 60) {
      this.planRocketJump(view, this.rjWant.dest);
      this.rjWant = null;
    }
    if (this.rj) return this.flyRocketJump(view, input);

    if (now >= this.decideAt) {
      this.decideAt = now + 0.1;
      this.decide(view);
      if (this.rj) return this.flyRocketJump(view, input);
    }

    const target = this.targetId ? view.enemies.find((e) => e.id === this.targetId) : undefined;
    const visible = !!target && now - this.targetSeenAt < 0.15;
    const engaged = !!target && (this.mode === 'fight' || (this.mode === 'heal' && visible));

    // --- movement ------------------------------------------------------------------------------------------
    let moveDir: Vec3 | null = null;
    let faceMove = true;
    let onPath = false;

    if (this.mode === 'fight' && target) {
      faceMove = false;
      const dist = hdist(self.body.pos, target.pos);
      const toTarget = vsub(target.pos, self.body.pos);
      toTarget.y = 0;
      const away = vscale(toTarget, -1);
      // Hurt and nowhere to heal: keep the distance and make them come to us.
      const range = self.hp < this.params.healAt ? this.style.range + 5 : this.style.range;
      if (!visible && this.lastSeenPos) {
        moveDir = this.followPath(view) ?? vsub(this.lastSeenPos, self.body.pos);
        onPath = this.path.length > 0;
      } else if (dist > range + 7) {
        moveDir = this.followPath(view) ?? toTarget;
        onPath = this.path.length > 0;
      } else if (dist < 4.5) {
        moveDir = away;
      } else if (this.params.strafe) {
        if (now > this.strafeUntil) {
          this.strafeDir = this.rng() < 0.5 ? -1 : 1;
          this.strafeUntil = now + this.style.strafeMin + this.rng() * this.style.strafeSpan;
        }
        const perp = v3(-toTarget.z * this.strafeDir, 0, toTarget.x * this.strafeDir);
        // Keep some approach pressure so fights do not stall at range, and back off when they get too close.
        moveDir = vadd(perp, vscale(toTarget, dist > range ? 0.6 : dist < range - 3 ? -0.5 : 0));
      } else {
        moveDir = dist > range ? toTarget : null;
      }
    } else {
      moveDir = this.followPath(view);
      onPath = moveDir !== null;
      if (engaged) faceMove = false;
    }

    // Incoming rocket: sidestep it (overrides the plan above for a moment).
    this.watchRockets(view);
    if (this.dodgeDir && now < this.dodgeUntil) {
      moveDir = this.dodgeDir;
      onPath = false;
    }

    // Never walk off into the void or off a big drop unless the path says so.
    if (moveDir && !onPath && body.onGround && !this.safeAhead(view, moveDir)) {
      this.strafeDir *= -1;
      moveDir = vscale(moveDir, -1);
      if (!this.safeAhead(view, moveDir)) moveDir = null;
    }
    // Momentum carrying us over an edge: brake against it.
    if (!onPath && body.onGround && Math.hypot(body.vel.x, body.vel.z) > 2 && !this.safeAhead(view, body.vel, 1.4)) {
      moveDir = v3(-body.vel.x, 0, -body.vel.z);
    }

    if (this.padFlight) {
      moveDir = null;
    } else if (!body.onGround) {
      // Airborne and about to come down in the void: forget the fight and air-steer toward the nearest floor.
      // Otherwise only keep air-strafing if that does not carry us off the edge.
      const v = body.vel;
      if (!this.landsSafely(view, v.x, v.z)) {
        const rescue = this.nearestFloor(view);
        if (rescue) {
          moveDir = vsub(rescue, body.pos);
          faceMove = true;
        }
      } else if (moveDir) {
        const l = Math.hypot(moveDir.x, moveDir.z) || 1;
        if (!this.landsSafely(view, v.x + (moveDir.x / l) * 4, v.z + (moveDir.z / l) * 4)) moveDir = null;
      }
    }

    // --- aim -------------------------------------------------------------------------------------------------
    let wantYaw = this.yaw;
    let wantPitch = 0;
    if (!faceMove || !moveDir) {
      if (engaged && target && (visible || this.lastSeenPos)) {
        const aimAt = visible ? this.aimPoint(view, target) : vadd(this.lastSeenPos!, v3(0, 1, 0));
        const eye = eyePosition(self.body.pos);
        const angles = dirToAngles(vsub(aimAt, eye));
        if (now > this.errUntil) {
          this.errUntil = now + 0.4 + this.rng() * 0.4;
          const speedFactor = 1 + Math.hypot(target.vel.x, target.vel.z) / 8;
          // Aim settles the longer a bot tracks the same target.
          const settle = 1 + 0.8 * Math.max(0, 1 - (now - this.firstSightAt) / 2);
          const e = this.params.aimError * this.style.aim * speedFactor * settle;
          this.errYaw = (this.rng() * 2 - 1) * e;
          this.errPitch = (this.rng() * 2 - 1) * e * 0.6;
        }
        wantYaw = angles.yaw + this.errYaw;
        wantPitch = angles.pitch + this.errPitch;
      } else if (moveDir) {
        wantYaw = Math.atan2(-moveDir.x, -moveDir.z);
      }
    } else {
      wantYaw = Math.atan2(-moveDir.x, -moveDir.z);
    }

    const maxTurn = this.params.turnRate * RK.dt;
    this.yaw = lerpAngle(this.yaw, wantYaw, Math.min(1, maxTurn / (Math.abs(wrapAngle(wantYaw - this.yaw)) + 1e-6)));
    this.pitch += clamp(wantPitch - this.pitch, -maxTurn, maxTurn);
    this.pitch = clamp(this.pitch, -RK.maxPitch, RK.maxPitch);
    input.yaw = this.yaw;
    input.pitch = this.pitch;

    // Convert the world move direction into forward/strafe relative to where we look.
    if (moveDir) {
      const l = Math.hypot(moveDir.x, moveDir.z);
      if (l > 1e-4) {
        const nx = moveDir.x / l;
        const nz = moveDir.z / l;
        const fwd = yawForward(this.yaw);
        const right = yawRight(this.yaw);
        input.f = clamp(nx * fwd.x + nz * fwd.z, -1, 1);
        input.s = clamp(nx * right.x + nz * right.z, -1, 1);
        // Snap to full inputs: Quake movement is digital. In the air, forward alone gets air control.
        const dead = self.body.onGround ? 0.3 : 0.5;
        if (Math.abs(input.f) < dead) input.f = 0;
        else input.f = Math.sign(input.f);
        if (Math.abs(input.s) < 0.3 || (!self.body.onGround && faceMove)) input.s = 0;
        else input.s = Math.sign(input.s);
        if (input.f === 0 && input.s === 0) input.f = 1;
      }
    }

    // Jumping: bunny hop when hard, occasional dodge jumps otherwise.
    if (this.params.bhop && moveDir && this.mode !== 'heal' && !onPath) input.jump = true;
    else if (this.mode === 'fight' && visible && this.rng() < this.style.hop) this.jumpUntil = now + 0.05;
    if (now < this.jumpUntil) input.jump = true;
    // Do not hop off a ledge into nothing.
    if (input.jump && !this.safeJump(view, moveDir)) input.jump = false;

    // --- fire ------------------------------------------------------------------------------------------------
    if (engaged && target && visible && now >= self.nextFire && now - this.firstSightAt >= this.params.reaction) {
      const eye = eyePosition(self.body.pos);
      const aimAt = this.aimPoint(view, target);
      const want = dirToAngles(vsub(aimAt, eye));
      const err = Math.abs(wrapAngle(want.yaw - this.yaw)) + Math.abs(want.pitch - this.pitch);
      if (err < 0.12 && this.rng() < this.params.trigger && this.safeToFire(view, target)) input.fire = true;
    }

    return input;
  }

  // ---- decisions ----------------------------------------------------------------------------------------------

  private decide(view: BotView) {
    const { self, now } = view;
    const eye = eyePosition(self.body.pos);

    let best: BotEnemy | null = null;
    let bestD = Infinity;
    for (const e of view.enemies) {
      const d = hdist(self.body.pos, e.pos);
      // Stick with the current target a little: switching every time someone is a metre closer looks twitchy.
      const score = e.id === this.targetId ? d - 4 : d;
      if (score < bestD && d < 45 && view.canSee(eye, chestPosition(e.pos))) {
        best = e;
        bestD = score;
      }
    }
    if (best) {
      if (best.id !== this.targetId) {
        this.firstSightAt = now;
        this.feetThisFight = this.rng() < this.params.feet;
      }
      this.targetId = best.id;
      this.targetSeenAt = now;
      this.lastSeenPos = { ...best.pos };
    } else if (now - this.targetSeenAt > 3) {
      this.targetId = null;
      this.lastSeenPos = null;
    }

    // Forget rockets that are long gone.
    for (const [id, r] of this.rockets) if (now - r.at > RK.rocketLife + 1) this.rockets.delete(id);

    let mode: Mode = this.targetId ? 'fight' : 'roam';
    const here = nearestNode(this.graph, self.body.pos, 2.5);
    if (!here) {
      this.mode = mode;
      return;
    }

    if (self.hp < this.params.healAt) {
      const pack = this.nearestPack(view);
      const goal = pack ? nearestNode(this.graph, pack) : null;
      if (goal) {
        const reachable = goal !== this.goal || now > this.repathAt ? this.setGoal(here, goal, now) : this.path.length > 0 || hdist(self.body.pos, goal.pos) < 1.5;
        if (reachable) mode = 'heal';
      }
    }

    const wasMode = this.mode;
    this.mode = mode;

    if (mode === 'heal') {
      // Goal and path were set above.
    } else if (mode === 'fight') {
      if (!best && this.lastSeenPos) {
        const goal = nearestNode(this.graph, this.lastSeenPos, 3);
        if (goal && (goal !== this.goal || now > this.repathAt)) this.setGoal(here, goal, now);
        // Chase: they went somewhere the walk is long; rocket-jump after them.
        if (goal && this.pathLonger(self.body.pos, goal, 1.8)) this.tryRocketJump(view, goal.pos, this.style.rjChance * 0.5);
      } else if (best && hdist(self.body.pos, best.pos) > this.style.range + 7) {
        const goal = nearestNode(this.graph, best.pos, 3);
        if (goal && (goal !== this.goal || now > this.repathAt)) this.setGoal(here, goal, now);
      }
      // Enemy well above us: take the high ground with a rocket jump.
      if (best && best.pos.y - self.body.pos.y > 2.2 && hdist(self.body.pos, best.pos) < 22) {
        const landing = nearestNode(this.graph, best.pos, 1.5);
        if (landing) this.tryRocketJump(view, landing.pos, this.style.rjChance);
      }
    } else {
      const reached = this.path.length === 0;
      if (wasMode !== 'roam' || reached || !this.goal || now > this.repathAt + 4) {
        const nodes = this.graph.nodes;
        let goal: NavNode = nodes[Math.floor(this.rng() * nodes.length)];
        // Prefer the high ground.
        for (let i = 0; i < 4; i++) {
          const candidate = nodes[Math.floor(this.rng() * nodes.length)];
          if (candidate.pos.y > goal.pos.y && hdist(candidate.pos, self.body.pos) > 6) goal = candidate;
        }
        const reachable = this.setGoal(here, goal, now);
        // Unreachable on foot or a long way round: try to rocket-jump up there instead.
        if ((!reachable || this.pathLonger(self.body.pos, goal, 2.5)) && goal.pos.y > self.body.pos.y + 1.5 && hdist(goal.pos, self.body.pos) < 24) {
          this.tryRocketJump(view, goal.pos, this.style.rjChance);
        }
      }
    }
  }

  /** Plans a path to the goal; false when the graph has no route there (the caller picks something else). */
  private setGoal(here: NavNode, goal: NavNode, now: number): boolean {
    this.goal = goal;
    this.repathAt = now + 1.5;
    const path = findPath(this.graph, here.id, goal.id);
    this.path = path ?? [];
    return path !== null;
  }

  /** Is the current path (if it leads to `goal`) much longer than the straight line? No path counts as longer. */
  private pathLonger(from: Vec3, goal: NavNode, factor: number): boolean {
    if (this.goal !== goal || !this.path.length) return true;
    let len = 0;
    let prev = from;
    for (const id of this.path) {
      const p = this.graph.nodes[id].pos;
      len += hdist(prev, p);
      prev = p;
    }
    return len > hdist(from, goal.pos) * factor + 4;
  }

  private nearestPack(view: BotView): Vec3 | null {
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (const p of view.packs) {
      if (!p.available) continue;
      const d = hdist(view.self.body.pos, p.pos) + Math.abs(p.pos.y - view.self.body.pos.y) * 3;
      if (d < bestD && d < 30) {
        bestD = d;
        best = p.pos;
      }
    }
    return best;
  }

  /** World-space direction toward the next node, dropping nodes as we reach them. */
  private followPath(view: BotView): Vec3 | null {
    const pos = view.self.body.pos;
    while (this.path.length) {
      const node = this.graph.nodes[this.path[0]];
      const reach = node.links.some((l) => l.pad !== undefined) ? 0.35 : 0.7;
      if (hdist(pos, node.pos) < reach && Math.abs(pos.y - node.pos.y) < 1.2) {
        this.path.shift();
        continue;
      }
      const d = vsub(node.pos, pos);
      d.y = 0;
      return d;
    }
    return null;
  }

  /** Is there floor `ahead` metres along `dir`, at most a few metres below us? */
  private safeAhead(view: BotView, dir: Vec3, ahead = 1.6): boolean {
    const l = Math.hypot(dir.x, dir.z) || 1;
    const p = view.self.body.pos;
    for (const d of [ahead * 0.6, ahead]) {
      const g = floorBelow(view.map, p.x + (dir.x / l) * d, p.z + (dir.z / l) * d, p.y + RK.stepHeight + 0.05);
      if (g === null || p.y - g > 4) return false;
    }
    return true;
  }

  /** Would a jump now (carrying our speed, plus the way we want to go) come down on a floor? */
  private safeJump(view: BotView, moveDir: Vec3 | null): boolean {
    const b = view.self.body;
    if (!b.onGround) return true;
    const air = (2 * RK.jumpSpeed) / RK.gravity;
    // Check both the speed we have and where the keys would push us; either must come down on a floor.
    for (let pass = 0; pass < 2; pass++) {
      let vx = b.vel.x;
      let vz = b.vel.z;
      if (pass === 1) {
        if (!moveDir) break;
        const l = Math.hypot(moveDir.x, moveDir.z) || 1;
        vx = vx * 0.5 + (moveDir.x / l) * RK.groundSpeed * 0.5;
        vz = vz * 0.5 + (moveDir.z / l) * RK.groundSpeed * 0.5;
      }
      for (const k of [0.35, 0.7, 1, 1.15]) {
        const g = floorBelow(view.map, b.pos.x + vx * air * k, b.pos.z + vz * air * k, b.pos.y + 1);
        if (g === null || b.pos.y - g > 4) return false;
      }
    }
    return true;
  }

  /** Coasting with this horizontal velocity from where we are, do we come down on a floor? */
  private landsSafely(view: BotView, vx: number, vz: number): boolean {
    const b = view.self.body;
    let x = b.pos.x;
    let y = b.pos.y;
    let z = b.pos.z;
    let vy = b.vel.y;
    const dt = 0.06;
    for (let i = 0; i < 60; i++) {
      vy -= RK.gravity * dt;
      x += vx * dt;
      z += vz * dt;
      const ny = y + vy * dt;
      if (vy < 0) {
        const g = floorBelow(view.map, x, z, y + 0.05);
        if (g !== null && ny <= g) return true;
      }
      y = ny;
      if (y < view.map.killY) return false;
    }
    return true;
  }

  /** The closest standable spot below us, for steering back to safety when airborne over the void. */
  private nearestFloor(view: BotView): Vec3 | null {
    const p = view.self.body.pos;
    let best: Vec3 | null = null;
    let bestD = Infinity;
    for (const n of this.graph.nodes) {
      if (n.pos.y > p.y + 0.3) continue;
      const d = hdist(n.pos, p) + (p.y - n.pos.y) * 0.3;
      if (d < bestD) {
        bestD = d;
        best = n.pos;
      }
    }
    return best;
  }

  // ---- aiming and firing --------------------------------------------------------------------------------------

  /** Where the target will be when a rocket fired now gets there, at its feet when it is (or will be) on the floor. */
  private aimPoint(view: BotView, target: BotEnemy): Vec3 {
    const eye = eyePosition(view.self.body.pos);
    const lead = this.params.lead;
    let t = vdist(eye, target.pos) / RK.rocketSpeed;
    let p = target.pos;
    let grounded = target.onGround;
    for (let i = 0; i < 3; i++) {
      const lt = t * lead;
      const x = target.pos.x + target.vel.x * lt;
      const z = target.pos.z + target.vel.z * lt;
      let y: number;
      grounded = target.onGround;
      if (target.onGround) {
        // Follow stairs and ramps; if they run off a ledge just keep their height.
        const g = floorBelow(view.map, x, z, target.pos.y + RK.stepHeight + 0.05);
        y = g !== null && target.pos.y - g < 1.5 ? g : target.pos.y;
      } else if (this.params.gravityLead) {
        y = target.pos.y + target.vel.y * lt - 0.5 * RK.gravity * lt * lt;
        const g = floorBelow(view.map, x, z, Math.max(target.pos.y, y) + 0.05);
        if (g !== null && y <= g) {
          y = g;
          grounded = true;
        }
      } else {
        y = target.pos.y + target.vel.y * lt;
      }
      p = v3(x, y, z);
      t = vdist(eye, p) / RK.rocketSpeed;
    }
    const dist = hdist(view.self.body.pos, p);
    if (grounded && this.feetThisFight && dist > 4.5) {
      const feet = v3(p.x, p.y + 0.12, p.z);
      // A ledge edge between us and their feet would eat the rocket: then go for the body.
      if (view.canSee(eye, feet)) return feet;
    }
    return v3(p.x, p.y + 0.95, p.z);
  }

  /** Would the rocket we fire now hurt us more than it is worth? Traces the shot to where it would explode. */
  private safeToFire(view: BotView, target: BotEnemy): boolean {
    const self = view.self;
    const eye = eyePosition(self.body.pos);
    const end = vadd(eye, vscale(lookDir(this.yaw, this.pitch), 60));
    const wall = segmentBoxes(eye, end, view.map.boxes);
    let t = wall ? wall.t : 1;
    const body = segmentAABB(eye, end, expandAABB(playerAABB(target.pos), RK.rocketRadius));
    const direct = !!body && body.t < t;
    if (direct) t = body!.t;
    const at = vadd(eye, vscale(vsub(end, eye), t));
    const box = playerAABB(self.body.pos);
    const nearest = v3(clamp(at.x, box.min.x, box.max.x), clamp(at.y, box.min.y, box.max.y), clamp(at.z, box.min.z, box.max.z));
    const d = vdist(at, nearest);
    if (d >= RK.splashRadius) return true;
    const selfDmg = RK.splashDamage * (1 - d / RK.splashRadius) * RK.selfDamageScale;
    // A point-blank direct hit is a fair trade while healthy; blowing up a wall in our face never is.
    return direct ? self.hp - selfDmg > 20 : selfDmg < 8 && self.hp > 40;
  }

  // ---- dodging --------------------------------------------------------------------------------------------------

  /** Looks for enemy rockets that will blow up near us soon and picks a sidestep direction. */
  private watchRockets(view: BotView) {
    const { now, self } = view;
    if (!view.rockets?.length || now < this.dodgeUntil) return;
    const chest = chestPosition(self.body.pos);
    let urgent = Infinity;
    let threat: { danger: Vec3; vel: Vec3 } | null = null;
    for (const r of view.rockets) {
      if (r.owner === self.id) continue;
      let seen = this.rockets.get(r.id);
      if (!seen) {
        seen = { at: now, react: this.rng() < this.params.dodge };
        this.rockets.set(r.id, seen);
      }
      if (!seen.react || now - seen.at < this.params.dodgeDelay) continue;
      const v = r.vel;
      const speed2 = v.x * v.x + v.y * v.y + v.z * v.z;
      const rel = vsub(chest, r.pos);
      const t = (rel.x * v.x + rel.y * v.y + rel.z * v.z) / speed2;
      if (t < 0 || t > 0.9 || t > urgent) continue;
      let danger = vadd(r.pos, vscale(v, t));
      // Where does it really go off? A wall in between may stop it far away from us, or right at our feet.
      const hit = segmentBoxes(r.pos, vadd(danger, vscale(v, 0.08)), view.map.boxes);
      if (hit) danger = vadd(r.pos, vscale(vsub(vadd(danger, vscale(v, 0.08)), r.pos), hit.t));
      if (vdist(danger, chest) > RK.splashRadius + 0.6) continue;
      urgent = t;
      threat = { danger, vel: v };
    }
    if (!threat) return;
    // Sidestep perpendicular to the rocket, away from where it passes.
    let perp = vnormalize(v3(-threat.vel.z, 0, threat.vel.x));
    const off = (chest.x - threat.danger.x) * perp.x + (chest.z - threat.danger.z) * perp.z;
    if (Math.abs(off) > 0.3 ? off < 0 : this.rng() < 0.5) perp = vscale(perp, -1);
    if (!this.safeAhead(view, perp)) perp = vscale(perp, -1);
    if (!this.safeAhead(view, perp)) {
      // No room to the sides: back away from the blast instead.
      perp = vnormalize(v3(chest.x - threat.danger.x, 0, chest.z - threat.danger.z));
      if (!this.safeAhead(view, perp)) return;
    }
    this.dodgeDir = perp;
    this.dodgeUntil = now + 0.25 + this.rng() * 0.2;
    this.stats.dodges++;
    // A rocket at our feet: jump out of the worst of the splash too.
    if (threat.danger.y < self.body.pos.y + 0.8 && this.rng() < 0.6 && this.safeAhead(view, perp, 3)) this.jumpUntil = now + 0.05;
  }

  // ---- rocket jumps -----------------------------------------------------------------------------------------

  /** Maybe wants a rocket jump to `dest`; it is planned the next time the bot stands on the ground with a rocket ready. */
  private tryRocketJump(view: BotView, dest: Vec3, chance: number) {
    const { self, now } = view;
    if (!this.params.rocketJump || this.rj || now < this.rjTryAt || self.hp < 60) return;
    this.rjTryAt = now + 1.2;
    if (this.rng() < chance) this.rjWant = { dest, until: now + 0.6 };
  }

  /** Commits to a rocket jump to `dest` if a simulated attempt lands there. */
  private planRocketJump(view: BotView, dest: Vec3) {
    let bestPlan: RocketJump | null = null;
    let bestCost = Infinity;
    for (const fireAt of [1, 4, 8, 12]) {
      for (const pitch of [-1.5, -1.3]) {
        const plan: RocketJump = { dest, pitch, fireAt, step: 0 };
        const cost = this.simulateRocketJump(view, plan);
        if (cost < bestCost) {
          bestCost = cost;
          bestPlan = plan;
        }
      }
    }
    if (bestPlan) {
      this.rj = bestPlan;
      this.stats.rocketJumps++;
    }
  }

  /**
   * Runs the rocket jump through the real movement code, including the server's knockback rule. Returns the self
   * damage taken if it lands within reach of `dest`, or Infinity if it falls short, overshoots or hits the void.
   */
  private simulateRocketJump(view: BotView, plan: RocketJump): number {
    const map = view.map;
    const body: Body = { pos: { ...view.self.body.pos }, vel: { ...view.self.body.vel }, onGround: view.self.body.onGround };
    const steer = { yaw: 0, f: 1 };
    const input = { f: 1, s: 0, jump: false, yaw: 0 };
    let rocket: { pos: Vec3; vel: Vec3 } | null = null;
    let exploded = false;
    let selfDmg = 0;
    for (let i = 0; i < 300; i++) {
      rocketJumpSteer(body, plan.dest, steer);
      input.yaw = steer.yaw;
      input.f = i <= plan.fireAt ? 1 : steer.f;
      input.jump = i === 0;
      stepBody(body, input, map);
      if (body.pos.y < map.killY) return Infinity;
      if (i === plan.fireAt) {
        const dir = lookDir(steer.yaw, plan.pitch);
        const eye = eyePosition(body.pos);
        let origin = vadd(eye, vscale(dir, RK.muzzleOffset));
        if (segmentBoxes(eye, origin, map.boxes)) origin = vadd(eye, vscale(dir, 0.05));
        rocket = { pos: origin, vel: vscale(dir, RK.rocketSpeed) };
      }
      if (rocket) {
        const to = vadd(rocket.pos, vscale(rocket.vel, RK.dt));
        const hit = segmentBoxes(rocket.pos, to, map.boxes);
        if (hit) {
          const at = vadd(vadd(rocket.pos, vscale(vsub(to, rocket.pos), hit.t)), vscale(hit.normal, 0.05));
          const box = playerAABB(body.pos);
          const nearest = v3(clamp(at.x, box.min.x, box.max.x), clamp(at.y, box.min.y, box.max.y), clamp(at.z, box.min.z, box.max.z));
          const d = vdist(at, nearest);
          if (d > RK.splashRadius) return Infinity;
          const falloff = 1 - d / RK.splashRadius;
          const centre = v3(body.pos.x, body.pos.y + RK.height * 0.5, body.pos.z);
          const dir = vnormalize(vsub(centre, at));
          if (dir.y < RK.knockbackLift) dir.y = RK.knockbackLift;
          const n = vnormalize(dir);
          const kick = RK.knockback * falloff * RK.selfKnockbackScale;
          body.vel.x += n.x * kick;
          body.vel.y += n.y * kick;
          body.vel.z += n.z * kick;
          if (n.y > 0) body.onGround = false;
          selfDmg = RK.splashDamage * falloff * RK.selfDamageScale;
          rocket = null;
          exploded = true;
        } else {
          rocket.pos = to;
          if (i > plan.fireAt + 30) return Infinity;
        }
      }
      if (exploded && body.onGround) {
        const miss = hdist(body.pos, plan.dest);
        if (miss > 2.5 || body.pos.y < plan.dest.y - 0.6) return Infinity;
        if (view.self.hp - selfDmg < 20) return Infinity;
        return selfDmg + miss * 4;
      }
    }
    return Infinity;
  }

  /** Executes the planned rocket jump step by step, steering exactly like the simulation did. */
  private flyRocketJump(view: BotView, input: RocketsInput): RocketsInput {
    const plan = this.rj!;
    const body = view.self.body;
    const steer = { yaw: 0, f: 1 };
    rocketJumpSteer(body, plan.dest, steer);
    const i = plan.step++;
    input.yaw = this.yaw = steer.yaw;
    input.f = i <= plan.fireAt ? 1 : steer.f;
    input.jump = i === 0;
    if (i === 0 && !body.onGround) {
      this.rj = null;
      return input;
    }
    if (i === plan.fireAt) {
      this.pitch = plan.pitch;
      input.fire = true;
    } else {
      // Look down for the shot, then back up toward the horizon on the way.
      const wantPitch = i < plan.fireAt ? plan.pitch : 0;
      this.pitch += clamp(wantPitch - this.pitch, -0.25, 0.25);
    }
    input.pitch = this.pitch;
    if ((i > plan.fireAt + 2 && body.onGround) || i > 300) {
      if (body.onGround && hdist(body.pos, plan.dest) < 3 && body.pos.y > plan.dest.y - 0.6) this.stats.rocketJumpsLanded++;
      this.rj = null;
      this.path = [];
      this.decideAt = 0;
    }
    return input;
  }
}
