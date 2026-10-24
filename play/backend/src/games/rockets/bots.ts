// Rockets bots: navigate the arena on the nav graph, fight whoever they can see, grab health when low,
// and (on normal/hard) rocket-jump after players on the high ground.

import { clamp, dirToAngles, hdist, lerpAngle, lookDir, type Vec3, v3, vadd, vscale, vsub, wrapAngle, yawForward, yawRight } from '../../shared/math.js';
import type { BotDifficulty } from '../../shared/protocol.js';
import { RK } from '../../shared/rockets/constants.js';
import type { MapData } from '../../shared/rockets/map.js';
import { chestPosition, eyePosition, type Body } from '../../shared/rockets/physics.js';
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
}

export const BOT_PARAMS: Record<BotDifficulty, BotParams> = {
  easy: { aimError: 0.16, turnRate: 2.5, reaction: 0.7, strafe: false, bhop: false, rocketJump: false, trigger: 0.5 },
  normal: { aimError: 0.07, turnRate: 5, reaction: 0.35, strafe: true, bhop: false, rocketJump: true, trigger: 0.8 },
  hard: { aimError: 0.025, turnRate: 11, reaction: 0.12, strafe: true, bhop: true, rocketJump: true, trigger: 1 },
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

export interface BotView {
  now: number;
  self: BotSelf;
  enemies: BotEnemy[];
  packs: { pos: Vec3; available: boolean }[];
  map: MapData;
  canSee(from: Vec3, to: Vec3): boolean;
}

type Mode = 'roam' | 'fight' | 'heal';

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
  private strafeDir = 1;
  private strafeUntil = 0;
  private errYaw = 0;
  private errPitch = 0;
  private errUntil = 0;
  private jumpUntil = 0;
  private rj: { phase: number; travelYaw: number; until: number } | null = null;
  private seq = 0;

  constructor(
    private readonly params: BotParams,
    private readonly graph: NavGraph,
    private readonly rng: () => number,
  ) {}

  /** Call once per simulation step. */
  think(view: BotView): RocketsInput {
    const { self, now } = view;
    const input: RocketsInput = { seq: ++this.seq, f: 0, s: 0, jump: false, fire: false, yaw: this.yaw, pitch: this.pitch };
    if (self.dead) {
      this.path = [];
      this.goal = null;
      this.rj = null;
      return input;
    }

    if (now >= this.decideAt) {
      this.decideAt = now + 0.1;
      this.decide(view);
    }

    const target = this.targetId ? view.enemies.find((e) => e.id === this.targetId) : undefined;
    const visible = !!target && now - this.targetSeenAt < 0.15;

    // --- movement ------------------------------------------------------------------------------------------
    let moveDir: Vec3 | null = null;
    let faceMove = true;

    if (this.mode === 'fight' && target) {
      faceMove = false;
      const dist = hdist(self.body.pos, target.pos);
      const toTarget = vsub(target.pos, self.body.pos);
      toTarget.y = 0;
      const away = vscale(toTarget, -1);
      if (!visible && this.lastSeenPos) {
        moveDir = this.followPath(view) ?? vsub(this.lastSeenPos, self.body.pos);
      } else if (dist > 15) {
        moveDir = this.followPath(view) ?? toTarget;
      } else if (dist < 4.5) {
        moveDir = away;
      } else if (this.params.strafe) {
        if (now > this.strafeUntil) {
          this.strafeDir = this.rng() < 0.5 ? -1 : 1;
          this.strafeUntil = now + 0.6 + this.rng() * 1.1;
        }
        const perp = v3(-toTarget.z * this.strafeDir, 0, toTarget.x * this.strafeDir);
        // Keep some approach pressure so fights do not stall at range.
        moveDir = vadd(perp, vscale(toTarget, dist > 10 ? 0.6 : 0));
      } else {
        moveDir = dist > 9 ? toTarget : null;
      }
      // Avoid walking off into nothing: if the strafe direction has no ground close by, flip it.
      if (moveDir && !this.groundAhead(view, moveDir)) {
        this.strafeDir *= -1;
        moveDir = vscale(moveDir, -1);
        if (!this.groundAhead(view, moveDir)) moveDir = null;
      }
    } else {
      moveDir = this.followPath(view);
    }

    // --- aim -------------------------------------------------------------------------------------------------
    let wantYaw = this.yaw;
    let wantPitch = 0;
    if (this.mode === 'fight' && target && (visible || this.lastSeenPos)) {
      const aimAt = visible ? this.aimPoint(view, target) : vadd(this.lastSeenPos!, v3(0, 1, 0));
      const eye = eyePosition(self.body.pos);
      const angles = dirToAngles(vsub(aimAt, eye));
      if (now > this.errUntil) {
        this.errUntil = now + 0.4 + this.rng() * 0.4;
        const speedFactor = 1 + Math.hypot(target.vel.x, target.vel.z) / 8;
        this.errYaw = (this.rng() * 2 - 1) * this.params.aimError * speedFactor;
        this.errPitch = (this.rng() * 2 - 1) * this.params.aimError * 0.6 * speedFactor;
      }
      wantYaw = angles.yaw + this.errYaw;
      wantPitch = angles.pitch + this.errPitch;
    } else if (moveDir && faceMove) {
      wantYaw = Math.atan2(-moveDir.x, -moveDir.z);
    }

    // Rocket jump overrides the look direction for a couple of steps.
    if (this.rj) {
      const r = this.rj;
      if (r.phase === 0) {
        input.jump = true;
        r.phase = 1;
      } else if (r.phase === 1) {
        this.yaw = r.travelYaw + Math.PI;
        this.pitch = -1.15;
        input.yaw = this.yaw;
        input.pitch = this.pitch;
        input.fire = true;
        r.phase = 2;
        r.until = now + 0.9;
        input.f = 0;
        return input;
      } else {
        wantYaw = r.travelYaw;
        wantPitch = 0;
        moveDir = yawForward(r.travelYaw);
        if (now > r.until || self.body.onGround) this.rj = null;
      }
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
        // Snap to full inputs: Quake movement is digital.
        if (Math.abs(input.f) < 0.3) input.f = 0;
        else input.f = Math.sign(input.f);
        if (Math.abs(input.s) < 0.3) input.s = 0;
        else input.s = Math.sign(input.s);
        if (input.f === 0 && input.s === 0) input.f = 1;
      }
    }

    // Jumping: bunny hop when hard, occasional dodge jumps otherwise.
    if (this.params.bhop && moveDir && this.mode !== 'heal') input.jump = true;
    else if (this.mode === 'fight' && visible && this.rng() < 0.012) this.jumpUntil = now + 0.05;
    if (now < this.jumpUntil) input.jump = true;

    // --- fire ------------------------------------------------------------------------------------------------
    if (this.mode === 'fight' && target && visible && now >= self.nextFire && now - this.firstSightAt >= this.params.reaction) {
      const eye = eyePosition(self.body.pos);
      const aimAt = this.aimPoint(view, target);
      const want = dirToAngles(vsub(aimAt, eye));
      const err = Math.abs(wrapAngle(want.yaw - this.yaw)) + Math.abs(want.pitch - this.pitch);
      const dist = hdist(self.body.pos, target.pos);
      const safe = dist > 3 || self.hp > 70;
      if (err < 0.12 && safe && !this.wallInFace(view) && this.rng() < this.params.trigger) input.fire = true;
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
      if (d < bestD && d < 45 && view.canSee(eye, chestPosition(e.pos))) {
        best = e;
        bestD = d;
      }
    }
    if (best) {
      if (best.id !== this.targetId) this.firstSightAt = now;
      this.targetId = best.id;
      this.targetSeenAt = now;
      this.lastSeenPos = { ...best.pos };
    } else if (now - this.targetSeenAt > 3) {
      this.targetId = null;
      this.lastSeenPos = null;
    }

    let mode: Mode = this.targetId ? 'fight' : 'roam';
    const here = nearestNode(this.graph, self.body.pos, 2.5);
    if (!here) {
      this.mode = mode;
      return;
    }

    if (self.hp < 45) {
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
      } else if (best && hdist(self.body.pos, best.pos) > 15) {
        const goal = nearestNode(this.graph, best.pos, 3);
        if (goal && (goal !== this.goal || now > this.repathAt)) this.setGoal(here, goal, now);
      }
      // Enemy well above us and we are healthy: rocket jump toward them.
      if (best && this.params.rocketJump && !this.rj && self.body.onGround && self.hp > 60 && now >= self.nextFire) {
        const dy = best.pos.y - self.body.pos.y;
        const dist = hdist(self.body.pos, best.pos);
        if (dy > 2.2 && dist < 14 && this.rng() < 0.35) {
          this.rj = { phase: 0, travelYaw: Math.atan2(-(best.pos.x - self.body.pos.x), -(best.pos.z - self.body.pos.z)), until: now + 1 };
        }
      }
    } else {
      const reached = this.path.length === 0;
      if (wasMode !== 'roam' || reached || !this.goal || now > this.repathAt + 4) {
        const nodes = this.graph.nodes;
        let goal: NavNode = nodes[Math.floor(this.rng() * nodes.length)];
        // Prefer the high ground and places where we last saw someone.
        for (let i = 0; i < 4; i++) {
          const candidate = nodes[Math.floor(this.rng() * nodes.length)];
          if (candidate.pos.y > goal.pos.y && hdist(candidate.pos, self.body.pos) > 6) goal = candidate;
        }
        this.setGoal(here, goal, now);
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

  private groundAhead(view: BotView, dir: Vec3): boolean {
    const l = Math.hypot(dir.x, dir.z) || 1;
    const p = view.self.body.pos;
    const x = p.x + (dir.x / l) * 1.6;
    const z = p.z + (dir.z / l) * 1.6;
    const node = nearestNode(this.graph, v3(x, p.y, z), 1.5);
    return !!node && hdist(node.pos, v3(x, 0, z)) < 1.6;
  }

  private aimPoint(view: BotView, target: BotEnemy): Vec3 {
    const eye = eyePosition(view.self.body.pos);
    const dist = hdist(view.self.body.pos, target.pos);
    const lead = dist / RK.rocketSpeed;
    const predicted = vadd(target.pos, vscale(target.vel, lead * 0.9));
    // Aim at the feet of grounded targets for guaranteed splash, at the chest otherwise.
    predicted.y += target.onGround && dist > 5 ? 0.15 : 1.0;
    if (predicted.y < eye.y - 20) predicted.y = eye.y - 20;
    return predicted;
  }

  private wallInFace(view: BotView): boolean {
    const eye = eyePosition(view.self.body.pos);
    const dir = lookDir(this.yaw, this.pitch);
    const end = vadd(eye, vscale(dir, 2.2));
    return !view.canSee(eye, end);
  }
}
