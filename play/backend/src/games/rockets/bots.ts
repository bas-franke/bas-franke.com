// Rockets bots: navigate the arena on the nav graph, fight whoever they can see, dodge incoming rockets, grab health
// when low, and (on normal/hard) rocket-jump to the high ground or after a target. Rocket jumps are planned by
// simulating them with the real movement code first, so a bot only commits to a jump that lands where it wants.
// In team modes bots never shoot through teammates and stay near them; in CTF they split into attackers and
// defenders per team, and in elimination they move as a group, use cover and back off when hurt.

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
import type { BotDifficulty, RocketsMode as GameMode, Team } from '../../shared/protocol.js';
import { RK } from '../../shared/rockets/constants.js';
import type { MapData } from '../../shared/rockets/map.js';
import { chestPosition, eyePosition, playerAABB, stepBody, type Body } from '../../shared/rockets/physics.js';
import type { RocketsInput } from '../../shared/rockets/protocol.js';
import { airSteer, findPath, linkBetween, nearestNode, shouldJump, StuckWatch, type NavGraph, type NavNode } from './nav.js';

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
  /** Aims splash on the inside of targets standing near a void, so the blast knocks them off (the faller counts as a frag). */
  edgeKnock: boolean;
}

export const BOT_PARAMS: Record<BotDifficulty, BotParams> = {
  // Tuned down on 2026-10-25: bots landed almost every rocket. Splash makes any near miss hurt, so the real levers
  // are aim noise, how well they lead, and how often they aim at the feet.
  easy: {
    aimError: 0.28,
    turnRate: 2.2,
    reaction: 1.0,
    strafe: false,
    bhop: false,
    rocketJump: false,
    trigger: 0.35,
    lead: 0.15,
    gravityLead: false,
    feet: 0.1,
    dodge: 0.08,
    dodgeDelay: 0.5,
    healAt: 30,
    edgeKnock: false,
  },
  normal: {
    aimError: 0.14,
    turnRate: 3.8,
    reaction: 0.6,
    strafe: true,
    bhop: false,
    rocketJump: true,
    trigger: 0.6,
    lead: 0.45,
    gravityLead: false,
    feet: 0.35,
    dodge: 0.35,
    dodgeDelay: 0.3,
    healAt: 45,
    edgeKnock: false,
  },
  hard: {
    aimError: 0.075,
    turnRate: 7,
    reaction: 0.3,
    strafe: true,
    bhop: true,
    rocketJump: true,
    trigger: 0.85,
    lead: 0.7,
    gravityLead: true,
    feet: 0.65,
    dodge: 0.6,
    dodgeDelay: 0.15,
    healAt: 55,
    edgeKnock: true,
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
  /** Health packs and items (armor, mega...); `item` marks the ones worth taking at full health. */
  packs: { pos: Vec3; available: boolean; item?: boolean }[];
  /** Rockets in flight; without them bots cannot dodge. */
  rockets?: readonly BotRocket[];
  map: MapData;
  canSee(from: Vec3, to: Vec3): boolean;
  /** The match countdown: nobody can move or fire yet. */
  frozen?: boolean;
  mode?: GameMode;
  team?: Team;
  /** Living teammates (never targets). The server already leaves teammates out of `enemies`. */
  allies?: { id: string; pos: Vec3 }[];
  /** CTF: index = team. state 0 base, 1 carried, 2 dropped. carrier = player id. */
  flags?: { state: 0 | 1 | 2; pos: Vec3; carrier?: string }[];
  /** Team modes: [red base, blue base]. */
  bases?: [Vec3, Vec3];
  /** Elim: true during the intermission (bots idle). */
  roundOver?: boolean;
}

/** `obj`: heading for what the team mode asks of us (a flag, home, the enemy carrier, the group). */
type Mode = 'roam' | 'fight' | 'heal' | 'obj';

/**
 * Team-mode objectives. CTF: carry the flag home, return our dropped flag, chase the enemy carrier, attack their flag,
 * escort our carrier, or (defenders) get back to the base. Elimination: regroup with the team (and advance together), retreat when hurt.
 */
type ObjKind = 'carry' | 'return' | 'chase' | 'attack' | 'escort' | 'guard' | 'regroup' | 'retreat';
interface Objective {
  kind: ObjKind;
  pos: Vec3;
  /** chase: the carrier's id. */
  id?: string;
}

/** Stable per-id hash (FNV-1a) for the CTF role split. */
function idHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Which team's half a point is on, from the two bases (same rule as `sideOf` in modes.ts). */
function sideFrom(bases: [Vec3, Vec3], p: Vec3): Team {
  return p.x * bases[0].x + p.z * bases[0].z >= 0 ? 0 : 1;
}

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
 * Per-tick work budget shared by all bots in the process: path searches and rocket-jump simulations are the expensive
 * calls, and a room full of bots deciding in the same tick must not stall the loop. Over budget, a bot waits a tick.
 */
const budget = { at: -1, paths: 0, rj: 0 };
const PATHS_PER_TICK = 4;
const RJ_PLANS_PER_TICK = 1;
function spend(now: number, kind: 'paths' | 'rj', max: number): boolean {
  if (budget.at !== now) {
    budget.at = now;
    budget.paths = 0;
    budget.rj = 0;
  }
  if (budget[kind] >= max) return false;
  budget[kind]++;
  return true;
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
  private roamRetryAt = 0;
  /** The path node we last passed, so the link to the next one (jump, pad) is known. */
  private prev = -1;
  /** What the current nav link wants from the jump key: true/false on a jump link, null otherwise. */
  private navJump: boolean | null = null;
  private readonly stuck = new StuckWatch();
  /** Waypoints we got stuck on recently; paths route around them for a while. */
  private readonly avoid = new Set<number>();
  private avoidUntil = 0;
  /** Goals that trapped us (stuck watchdog), skipped until the time stored. */
  private readonly banned = new Map<number, number>();
  /** The pack or item we are heading for, its nav node, and when to reconsider. */
  private pickup: Vec3 | null = null;
  private pickupNode: NavNode | null = null;
  private pickupAt = 0;
  private calmAt = 0;
  /** Spawn time and place: no shooting (it ends spawn protection) until we moved off the spawn or it ran out. */
  private spawnAt = -1;
  private spawnPos: Vec3 = v3();
  private wasDead = true;
  private progressPos: Vec3 = v3();
  private progressAt = 0;
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
  /** Team modes: teammates seen lately (id, last seen), for the CTF role split and to ignore their rockets. */
  private readonly mates = new Map<string, number>();
  /** What the team mode wants from us right now (null: fight and roam as usual). */
  private obj: Objective | null = null;
  /** CTF role, split per team by id hash. */
  role: 'attack' | 'defend' | null = null;
  /** Elimination: a nearby spot out of the target's sight to duck into while reloading. */
  private cover: Vec3 | null = null;
  private coverAt = 0;
  /** Per-bot quirks so a room of bots does not move in lockstep. */
  private readonly style: { range: number; strafeMin: number; strafeSpan: number; hop: number; aim: number; rjChance: number };
  /** Counters for tuning scripts. */
  readonly stats = { rocketJumps: 0, rocketJumpsLanded: 0, dodges: 0, unstuck: 0 };

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
      this.pickup = null;
      this.wasDead = true;
      return input;
    }
    if (this.wasDead) {
      this.wasDead = false;
      this.spawnAt = now;
      this.spawnPos = { ...self.body.pos };
    }

    const body = self.body;
    if (view.frozen || view.roundOver) {
      // Countdown or the pause between rounds: nothing to plan yet (a rocket jump or a stuck check now would only misfire).
      this.rj = null;
      this.rjWant = null;
      this.stuck.reset();
      this.progressAt = now;
      return input;
    }
    // A blast knocks us off the pad's arc: then steer for safety like any other fall.
    if (body.onGround || self.hp < this.lastHp) this.padFlight = false;
    else if (this.wasOnGround && view.map.pads.some((p) => hdist(body.pos, p.pos) <= p.radius + 0.6 && Math.abs(body.pos.y - p.pos.y) < 1)) this.padFlight = true;
    this.wasOnGround = body.onGround;
    this.lastHp = self.hp;

    if (this.rjWant && now < this.rjWant.until && body.onGround && now >= self.nextFire && self.hp >= 60) {
      if (this.planRocketJump(view, this.rjWant.dest)) this.rjWant = null;
    }
    if (this.rj) return this.flyRocketJump(view, input);

    if (now >= this.decideAt) {
      this.decideAt = now + 0.1;
      this.decide(view);
      if (this.rj) return this.flyRocketJump(view, input);
    }

    const target = this.targetId ? view.enemies.find((e) => e.id === this.targetId) : undefined;
    const visible = !!target && now - this.targetSeenAt < 0.15;
    const engaged = !!target && (this.mode === 'fight' || ((this.mode === 'heal' || this.mode === 'obj') && visible));

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
      // Hurt and nowhere to heal: keep the distance and make them come to us. Elimination has no second life: stand off.
      const range = (self.hp < this.params.healAt ? this.style.range + 5 : this.style.range) + (view.mode === 'elim' ? 3 : 0);
      const cover = this.cover;
      if (cover && visible && view.mode === 'elim' && now < self.nextFire - 0.15 && hdist(cover, body.pos) > 0.4) {
        // Reloading: duck behind cover; once out of sight the chase below brings us back round the corner to peek.
        moveDir = v3(cover.x - body.pos.x, 0, cover.z - body.pos.z);
      } else if (!visible && this.lastSeenPos) {
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
        // No real strafing, but do not stand like a statue either: drift sideways now and then.
        if (now > this.strafeUntil) {
          this.strafeDir = this.rng() < 0.4 ? 0 : this.rng() < 0.5 ? -1 : 1;
          this.strafeUntil = now + 1 + this.rng() * 1.5;
        }
        moveDir = dist > range ? toTarget : this.strafeDir ? v3(-toTarget.z * this.strafeDir, 0, toTarget.x * this.strafeDir) : null;
      }
    } else {
      moveDir = this.followPath(view);
      onPath = moveDir !== null;
      if (engaged) faceMove = false;
      // The nav node next to a pack (or a flag, or the base) can be further away than the touch radius: walk the last
      // metres straight.
      const pk = this.mode === 'heal' ? this.pickup : this.mode === 'obj' ? (this.obj?.pos ?? null) : null;
      if (!moveDir && pk && hdist(pk, body.pos) < 3.5 && Math.abs(pk.y - body.pos.y) < 1.5) {
        moveDir = v3(pk.x - body.pos.x, 0, pk.z - body.pos.z);
        if (Math.hypot(moveDir.x, moveDir.z) < 0.3) moveDir = null;
      }
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
      const original = moveDir;
      moveDir = vscale(original, -1);
      // On a bridge neither side works: run along it instead, or stand still.
      if (!this.safeAhead(view, moveDir)) moveDir = v3(-original.z, 0, original.x);
      if (!this.safeAhead(view, moveDir)) moveDir = v3(original.z, 0, -original.x);
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
      const steerLen = moveDir ? Math.hypot(moveDir.x, moveDir.z) : 0;
      const steered = onPath && steerLen > 1e-4 ? this.landsSafely(view, v.x + (moveDir!.x / steerLen) * 4, v.z + (moveDir!.z / steerLen) * 4) : false;
      if (onPath && (steered || (steerLen <= 1e-4 && this.landsSafely(view, v.x, v.z)))) {
        // Nav air steering (or coasting) brings us down on the next waypoint: leave it be.
      } else if (!this.landsSafely(view, v.x, v.z)) {
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
      } else if (moveDir && (moveDir.x || moveDir.z)) {
        wantYaw = Math.atan2(-moveDir.x, -moveDir.z);
      }
    } else if (moveDir.x || moveDir.z) {
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
    // Jump links of the nav graph decide the jump key themselves, as long as there is floor where the jump comes down.
    if (onPath && this.navJump !== null) input.jump = this.navJump && this.navJumpLands(view);

    // --- fire ------------------------------------------------------------------------------------------------
    const spawnSafe = now - this.spawnAt < RK.spawnProtection && hdist(self.body.pos, this.spawnPos) < 3;
    if (engaged && target && visible && !spawnSafe && now >= self.nextFire && now - this.firstSightAt >= this.params.reaction) {
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
    if (budget.at === now && budget.paths >= PATHS_PER_TICK) {
      this.decideAt = now + RK.dt;
      return;
    }
    const eye = eyePosition(self.body.pos);

    // Team modes: remember who is on our side, and work out what the mode wants from us.
    if (view.allies) for (const a of view.allies) this.mates.set(a.id, now);
    for (const [id, at] of this.mates) if (now - at > 20) this.mates.delete(id);
    const team = view.team;
    const ctf = view.mode === 'ctf' && team !== undefined && !!view.flags && !!view.bases;
    this.obj = ctf ? this.ctfObjective(view) : null;
    if (!ctf) this.role = null;
    const ownFlag = ctf ? view.flags![team!] : undefined;
    const carrierId = ownFlag?.state === 1 ? ownFlag.carrier : undefined;
    const carrying = this.obj?.kind === 'carry';
    // A CTF defender with nothing urgent guards the base: only enemies near it are worth a fight.
    const guardAt = ctf && this.role === 'defend' && !this.obj ? view.bases![team!] : null;

    let best: BotEnemy | null = null;
    let bestD = Infinity;
    for (const e of view.enemies) {
      const d = hdist(self.body.pos, e.pos);
      // The carrier runs: it only shoots back at whoever gets close.
      if (carrying && d > 14) continue;
      if (guardAt && e.id !== carrierId && hdist(e.pos, guardAt) > 26) continue;
      // Stick with the current target a little: switching every time someone is a metre closer looks twitchy.
      // Our flag's carrier comes first.
      const score = (e.id === this.targetId ? d - 4 : d) - (e.id === carrierId ? 12 : 0);
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
    } else if (now - this.targetSeenAt > 3 || (guardAt && this.lastSeenPos && this.targetId !== carrierId && hdist(this.lastSeenPos, guardAt) > 26)) {
      // Lost them (a defender also lets them go once they are far from the base).
      this.targetId = null;
      this.lastSeenPos = null;
    }
    if (view.mode === 'elim') this.obj = this.elimObjective(view);
    // A defender drawn away from the base walks back, shooting on the way, instead of chasing further.
    else if (guardAt && hdist(self.body.pos, guardAt) > 12) this.obj = { kind: 'guard', pos: guardAt };

    // Forget rockets that are long gone.
    for (const [id, r] of this.rockets) if (now - r.at > RK.rocketLife + 1) this.rockets.delete(id);

    let mode: Mode = this.targetId ? 'fight' : 'roam';
    const obj = this.obj;
    if (obj) {
      switch (obj.kind) {
        case 'carry':
        case 'return':
        case 'retreat':
        case 'guard':
          mode = 'obj';
          break;
        case 'chase':
          mode = best && best.id === obj.id ? 'fight' : 'obj';
          break;
        case 'attack':
          // Fight whoever is in the way when it is close and we are healthy; otherwise keep going and shoot on the run.
          mode = best && hdist(self.body.pos, best.pos) < this.style.range && self.hp >= this.params.healAt ? 'fight' : 'obj';
          break;
        case 'escort':
        case 'regroup':
          if (!this.targetId) mode = 'obj';
          break;
      }
    }
    const here = nearestNode(this.graph, self.body.pos, 2.5);
    if (!here) {
      this.mode = mode;
      return;
    }
    const objGoal = mode === 'obj' ? nearestNode(this.graph, obj!.pos, obj!.kind === 'regroup' || obj!.kind === 'retreat' ? 8 : 3) : null;
    if (mode === 'obj' && !objGoal) mode = this.targetId ? 'fight' : 'roam';

    // Health and items: badly hurt, any pack a walk away; a bit hurt, a nearby one; calm, now and then an item.
    // Not while carrying, returning or chasing a flag, and elimination has no pickups at all.
    const busy = !!obj && (obj.kind === 'carry' || obj.kind === 'return' || obj.kind === 'chase');
    if (busy || view.mode === 'elim') this.pickup = null;
    else {
      if (this.pickup && !view.packs.some((p) => p.available && p.pos === this.pickup)) this.pickup = null;
      if (now >= this.pickupAt || (!this.pickup && self.hp < this.params.healAt)) {
        this.pickupAt = now + 1;
        this.choosePickup(view, here, mode === 'roam', guardAt);
      }
      if (this.pickup && this.pickupNode) {
        const goal = this.pickupNode;
        if (goal !== this.goal || (now > this.repathAt && this.path.length === 0 && hdist(self.body.pos, goal.pos) > 1)) this.setGoal(here, goal, now);
        mode = 'heal';
      }
    }

    // Stuck watchdog: no real progress for 3 s while not busy shooting at someone (a dead-end alley, a lip the
    // nav graph thinks is walkable): drop the plan, maybe rocket-jump out, and pick somewhere else to go.
    const shooting = !!best && mode !== 'roam';
    if (shooting || hdist(self.body.pos, this.progressPos) > 2 || Math.abs(self.body.pos.y - this.progressPos.y) > 1) {
      this.progressPos = { ...self.body.pos };
      this.progressAt = now;
    } else if (now - this.progressAt > 3) {
      this.progressPos = { ...self.body.pos };
      this.progressAt = now;
      this.stats.unstuck++;
      // Whatever we were heading for trapped us: leave it alone for a while.
      if (this.goal) this.banned.set(this.goal.id, now + 10);
      if (this.pickupNode) this.banned.set(this.pickupNode.id, now + 10);
      this.pickup = null;
      this.pickupNode = null;
      this.path = [];
      this.goal = null;
      if (!best) {
        this.targetId = null;
        this.lastSeenPos = null;
        // An objective stays an objective: try again next decision (by rocket jump if the walk keeps failing).
        if (mode !== 'obj') mode = 'roam';
      }
      const up = this.nearbyHighNode(self.body.pos);
      if (up) {
        this.rjTryAt = 0;
        this.tryRocketJump(view, up.pos, 1);
      }
    }

    const wasMode = this.mode;
    this.mode = mode;
    // Elimination: keep a spot in mind to duck behind while reloading.
    if (mode === 'fight' && view.mode === 'elim' && best) {
      if (now >= this.coverAt) {
        this.coverAt = now + 0.6;
        this.cover = this.findCover(view, best);
      }
    } else this.cover = null;

    if (mode === 'heal') {
      // Goal and path were set above.
    } else if (mode === 'obj') {
      const goal = objGoal!;
      // A moving objective (a carrier, the group) changes node often: repath at most twice a second for it.
      if ((goal !== this.goal && (now > this.repathAt - 1 || !this.path.length)) || now > this.repathAt) {
        const reachable = this.setGoal(here, goal, now);
        // The flag (or home) is up a tower or across a gap and the walk is long: rocket-jump there.
        const d = hdist(goal.pos, self.body.pos);
        const jumpy = obj!.kind === 'attack' || obj!.kind === 'carry' || obj!.kind === 'return';
        if (jumpy && d > 5 && d < 24 && (!reachable || this.pathLonger(self.body.pos, goal, 1.8))) {
          this.tryRocketJump(view, goal.pos, obj!.kind === 'carry' ? 0.5 : this.style.rjChance);
        }
      }
    } else if (mode === 'fight') {
      if (!best && this.lastSeenPos) {
        const goal = nearestNode(this.graph, this.lastSeenPos, 3);
        if (goal && (goal !== this.goal || now > this.repathAt)) this.setGoal(here, goal, now);
        // Chase: they went somewhere the walk is long; rocket-jump after them.
        if (goal && goal.pos.y > self.body.pos.y + 1.5 && this.pathLonger(self.body.pos, goal, 1.8)) this.tryRocketJump(view, goal.pos, this.style.rjChance * 0.5);
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
      if ((wasMode !== 'roam' || reached || !this.goal || now > this.repathAt + 4) && now >= this.roamRetryAt) {
        // A few tries per decision; when nothing is reachable from here, back off instead of searching every step.
        for (let attempt = 0; attempt < 3; attempt++) {
          const goal = this.roamGoal(view);
          if ((this.banned.get(goal.id) ?? 0) > now) continue;
          const reachable = this.setGoal(here, goal, now);
          // Unreachable on foot or a long way round: try to rocket-jump up there instead.
          if ((!reachable || this.pathLonger(self.body.pos, goal, 2.5)) && goal.pos.y > self.body.pos.y + 1.5 && hdist(goal.pos, self.body.pos) < 24) {
            this.tryRocketJump(view, goal.pos, this.style.rjChance);
          }
          if (reachable || this.rjWant) break;
          if (attempt === 2) this.roamRetryAt = now + 1;
        }
      }
    }
  }

  /** A random node to roam to, preferring the high ground. */
  private highNode(pos: Vec3): NavNode {
    const nodes = this.graph.nodes;
    let goal: NavNode = nodes[Math.floor(this.rng() * nodes.length)];
    for (let i = 0; i < 4; i++) {
      const candidate = nodes[Math.floor(this.rng() * nodes.length)];
      if (candidate.pos.y > goal.pos.y && hdist(candidate.pos, pos) > 6) goal = candidate;
    }
    return goal;
  }

  /** A random node within `r` metres (horizontally) of `centre` and a few metres of its height, or null. */
  private nodeNear(centre: Vec3, r: number, maxDy: number): NavNode | null {
    const near: NavNode[] = [];
    for (const n of this.graph.nodes) if (hdist(n.pos, centre) < r && Math.abs(n.pos.y - centre.y) < maxDy) near.push(n);
    return near.length ? near[Math.floor(this.rng() * near.length)] : null;
  }

  /**
   * Where to roam. FFA: anywhere, preferring the high ground. Team modes: often near a teammate, otherwise mostly on
   * our own half. A CTF defender stays around its base.
   */
  private roamGoal(view: BotView): NavNode {
    const pos = view.self.body.pos;
    const { team, bases } = view;
    if (team === undefined || !bases) return this.highNode(pos);
    if (view.mode === 'ctf' && this.role === 'defend') {
      const n = this.nodeNear(bases[team], 13, 5);
      if (n) return n;
    }
    if (view.allies?.length && this.rng() < 0.55) {
      const a = view.allies[Math.floor(this.rng() * view.allies.length)];
      const n = hdist(a.pos, pos) > 5 ? this.nodeNear(a.pos, 6, 2) : null;
      if (n) return n;
    }
    let goal = this.highNode(pos);
    for (let i = 0; i < 3 && sideFrom(bases, goal.pos) !== team && this.rng() < 0.6; i++) goal = this.highNode(pos);
    return goal;
  }

  /** CTF: what this bot should do about the flags right now; null means guard (defenders) or fight as usual. */
  private ctfObjective(view: BotView): Objective | null {
    const team = view.team!;
    const flags = view.flags!;
    const bases = view.bases!;
    const self = view.self;
    const mine = flags[team];
    const theirs = flags[1 - team];
    if (!mine || !theirs) return null;
    // Roles by id hash over the team (teammates seen lately): about 40% defend, at least one once there are two.
    const ids = [self.id, ...this.mates.keys()].sort((a, b) => idHash(a) - idHash(b) || (a < b ? -1 : 1));
    const defenders = ids.length < 2 ? 0 : Math.max(1, Math.floor(ids.length * 0.4));
    this.role = ids.indexOf(self.id) < defenders ? 'defend' : 'attack';

    if (theirs.state === 1 && theirs.carrier === self.id) return { kind: 'carry', pos: bases[team] };
    if (mine.state === 2 && (this.role === 'defend' || hdist(mine.pos, self.body.pos) < 22)) return { kind: 'return', pos: mine.pos };
    // Our flag is on the run: defenders hunt the carrier, and so does everyone once both flags are out.
    if (mine.state === 1 && (this.role === 'defend' || theirs.state === 1)) return { kind: 'chase', pos: mine.pos, id: mine.carrier };
    if (this.role === 'defend') return null;
    if (theirs.state === 1) return { kind: 'escort', pos: theirs.pos };
    return { kind: 'attack', pos: theirs.pos };
  }

  /** Elimination: back off when hurt, and with nobody in sight move as a group toward the nearest enemy. */
  private elimObjective(view: BotView): Objective | null {
    const pos = view.self.body.pos;
    const allies = view.allies ?? [];
    if (view.self.hp < 70 && this.targetId && this.lastSeenPos) {
      // Hurt: fall back on the nearest teammate, or just away from the shooter, shooting on the way.
      let ally: Vec3 | null = null;
      let allyD = 30;
      for (const a of allies) {
        const d = hdist(a.pos, pos);
        if (d > 4 && d < allyD) {
          allyD = d;
          ally = a.pos;
        }
      }
      if (ally) return { kind: 'retreat', pos: ally };
      const ax = pos.x - this.lastSeenPos.x;
      const az = pos.z - this.lastSeenPos.z;
      const l = Math.hypot(ax, az) || 1;
      return { kind: 'retreat', pos: v3(pos.x + (ax / l) * 10, pos.y, pos.z + (az / l) * 10) };
    }
    if (this.targetId) return null;
    let cx = pos.x;
    let cy = pos.y;
    let cz = pos.z;
    for (const a of allies) {
      cx += a.pos.x;
      cy += a.pos.y;
      cz += a.pos.z;
    }
    const n = allies.length + 1;
    cx /= n;
    cy /= n;
    cz /= n;
    let enemy: Vec3 | null = null;
    let enemyD = Infinity;
    for (const e of view.enemies) {
      const d = Math.hypot(e.pos.x - cx, e.pos.z - cz);
      if (d < enemyD) {
        enemyD = d;
        enemy = e.pos;
      }
    }
    if (!enemy) return null;
    // The group's centre, a few metres toward the enemy: everyone closes up, and the group creeps forward.
    const step = Math.min(6, enemyD);
    return { kind: 'regroup', pos: v3(cx + ((enemy.x - cx) / (enemyD || 1)) * step, cy, cz + ((enemy.z - cz) / (enemyD || 1)) * step) };
  }

  /** The closest nav node a few metres away from which `target` cannot see us. */
  private findCover(view: BotView, target: BotEnemy): Vec3 | null {
    const pos = view.self.body.pos;
    const chest = chestPosition(target.pos);
    let best: Vec3 | null = null;
    let bestD = Infinity;
    let tries = 0;
    for (const n of this.graph.nodes) {
      const d = hdist(n.pos, pos);
      if (d < 1.5 || d > 4.5 || d >= bestD || Math.abs(n.pos.y - pos.y) > 1) continue;
      if (!view.canSee(eyePosition(n.pos), chest)) {
        best = n.pos;
        bestD = d;
      }
      if (++tries >= 10) break;
    }
    return best;
  }

  /** Plans a path to the goal; false when the graph has no route there (the caller picks something else). */
  private setGoal(here: NavNode, goal: NavNode, now: number): boolean {
    this.goal = goal;
    this.repathAt = now + 1.5;
    this.prev = here.id;
    if (now > this.avoidUntil) this.avoid.clear();
    spend(now, 'paths', Infinity);
    const path = findPath(this.graph, here.id, goal.id, { avoid: this.avoid });
    this.path = path ?? [];
    return path !== null;
  }

  /** A node a few metres up within rocket-jump range, to escape a pit. */
  private nearbyHighNode(pos: Vec3): NavNode | null {
    let best: NavNode | null = null;
    let bestD = Infinity;
    for (const n of this.graph.nodes) {
      const dy = n.pos.y - pos.y;
      const d = hdist(n.pos, pos);
      if (dy < 1.5 || dy > 10 || d > 16 || d < 2) continue;
      const score = d + this.rng() * 4;
      if (score < bestD) {
        bestD = score;
        best = n;
      }
    }
    return best;
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

  /**
   * Picks the pack or item to head for (or none), by walking distance: up to 40 m when badly hurt, 16 m when a bit
   * hurt, and when calm, sometimes an item within 25 m. Ones out of reach on foot but above us get a rocket jump.
   */
  private choosePickup(view: BotView, here: NavNode, calm: boolean, guardAt: Vec3 | null) {
    const { self, now } = view;
    const hp = self.hp;
    let maxWalk = hp < this.params.healAt ? 40 : hp <= 70 ? 16 : 0;
    let itemsOnly = false;
    if (maxWalk === 0) {
      // Keep a calm-time item target until it is taken; roll for a new one every few seconds.
      if (this.pickup && calm) return;
      if (!calm || now < this.calmAt || guardAt) {
        this.pickup = null;
        return;
      }
      this.calmAt = now + 3 + this.rng() * 3;
      if (this.rng() > 0.5) return;
      maxWalk = 25;
      itemsOnly = true;
    }
    const pos = self.body.pos;
    const candidates = view.packs
      // A CTF defender only takes what lies near its base.
      .filter((p) => p.available && (!itemsOnly || p.item !== false) && hdist(p.pos, pos) < maxWalk && (!guardAt || hdist(p.pos, guardAt) < 20))
      .map((p) => ({ p, d: hdist(p.pos, pos) + Math.abs(p.pos.y - pos.y) * 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    let best: { pos: Vec3; node: NavNode } | null = null;
    let bestLen = maxWalk;
    let jumpTo: Vec3 | null = null;
    for (const { p } of candidates) {
      // Only pickups standing on a floor can be collected (the pickup needs feet within a metre of it).
      const floor = floorBelow(view.map, p.pos.x, p.pos.z, p.pos.y + 1.05);
      if (floor === null || Math.abs(floor - p.pos.y) >= 0.95) continue;
      const node = nearestNode(this.graph, p.pos, 2.5);
      if (!node || hdist(node.pos, p.pos) > 3 || (this.banned.get(node.id) ?? 0) > now) {
        if (!jumpTo && p.pos.y > pos.y + 1.5) jumpTo = p.pos;
        continue;
      }
      if (!spend(now, 'paths', PATHS_PER_TICK)) break;
      const path = node === here ? [] : findPath(this.graph, here.id, node.id, { avoid: this.avoid });
      if (!path) {
        // A failed search walks the whole graph: do not repeat it every second.
        this.banned.set(node.id, now + 8);
        if (!jumpTo && p.pos.y > pos.y + 1.5) jumpTo = p.pos;
        continue;
      }
      let len = hdist(p.pos, node.pos);
      let prev = pos;
      for (const id of path) {
        const q = this.graph.nodes[id].pos;
        len += hdist(prev, q);
        prev = q;
      }
      if (len < bestLen) {
        bestLen = len;
        best = { pos: p.pos, node };
      }
    }
    this.pickup = best?.pos ?? null;
    this.pickupNode = best?.node ?? null;
    // A mega on a pillar top, say: rocket-jump for it.
    if (!best && jumpTo) this.tryRocketJump(view, jumpTo, Math.max(this.style.rjChance, 0.6));
  }

  /**
   * World-space direction toward the next node, dropping nodes as we reach them. In the air it steers for the landing
   * on that node (a zero vector means: coast, the arc already lands there). Also sets navJump for jump links.
   */
  private followPath(view: BotView): Vec3 | null {
    const { now } = view;
    const body = view.self.body;
    const pos = body.pos;
    this.navJump = null;
    while (this.path.length) {
      const node = this.graph.nodes[this.path[0]];
      if (hdist(pos, node.pos) < (node.reach ?? 0.7) && Math.abs(pos.y - node.pos.y) < 1.2) {
        this.prev = this.path.shift()!;
        continue;
      }
      if (this.stuck.update(now, pos, node, body.onGround)) {
        // No closer to this waypoint for a while: route around it, hop in case it is a lip, and plan again.
        this.avoid.add(node.id);
        this.avoidUntil = now + 5;
        this.path = [];
        this.repathAt = 0;
        this.decideAt = 0;
        this.jumpUntil = now + 0.05;
        return null;
      }
      const link = this.prev >= 0 ? linkBetween(this.graph, this.prev, node.id) : undefined;
      if (link?.jump) this.navJump = shouldJump(link, node.pos, pos, body.onGround);
      if (!body.onGround) return airSteer(pos, body.vel, node.pos) ?? v3();
      const d = vsub(node.pos, pos);
      d.y = 0;
      return d;
    }
    return null;
  }

  /**
   * Is there floor `ahead` metres along `dir`, at most a few metres below us, and all the way along where our current
   * speed plus pressing toward `dir` carries us in the next 0.8 s? Momentum is what throws bots off narrow bridges.
   */
  private safeAhead(view: BotView, dir: Vec3, ahead = 1.6): boolean {
    const l = Math.hypot(dir.x, dir.z) || 1;
    const nx = dir.x / l;
    const nz = dir.z / l;
    const b = view.self.body;
    const p = b.pos;
    const ok = (x: number, z: number) => {
      const g = floorBelow(view.map, x, z, p.y + RK.stepHeight + 0.05);
      return g !== null && p.y - g <= 4;
    };
    for (const d of [ahead * 0.6, ahead]) if (!ok(p.x + nx * d, p.z + nz * d)) return false;
    // Keep a margin from the edge: a splash knockback on top of the strafe must not be enough to tip us over.
    const margin = 0.8;
    const vx = b.vel.x * 0.5 + nx * RK.groundSpeed * 0.5;
    const vz = b.vel.z * 0.5 + nz * RK.groundSpeed * 0.5;
    for (const t of [0.25, 0.5, 0.8]) if (!ok(p.x + vx * t + nx * margin, p.z + vz * t + nz * margin)) return false;
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

  /** Is there floor (not void) where a nav jump toward the next waypoint comes down? */
  private navJumpLands(view: BotView): boolean {
    const b = view.self.body;
    const node = this.path.length ? this.graph.nodes[this.path[0]] : null;
    if (!node) return false;
    if (floorBelow(view.map, node.pos.x, node.pos.z, node.pos.y + 0.05) === null) return false;
    const air = (2 * RK.jumpSpeed) / RK.gravity;
    const d = hdist(b.pos, node.pos) || 1;
    const speed = Math.max(Math.hypot(b.vel.x, b.vel.z), RK.groundSpeed * 0.6);
    const reachX = b.pos.x + ((node.pos.x - b.pos.x) / d) * Math.min(d, speed * air);
    const reachZ = b.pos.z + ((node.pos.z - b.pos.z) / d) * Math.min(d, speed * air);
    return floorBelow(view.map, reachX, reachZ, Math.max(b.pos.y, node.pos.y) + 1) !== null;
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
      if (this.params.edgeKnock) {
        // Void next to them: put the blast on the inside so the knockback pushes them over the edge.
        let ox = 0;
        let oz = 0;
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          const dx = Math.cos(a);
          const dz = Math.sin(a);
          if (floorBelow(view.map, p.x + dx * 2.2, p.z + dz * 2.2, p.y + 0.05) === null) {
            ox -= dx;
            oz -= dz;
          }
        }
        const ol = Math.hypot(ox, oz);
        if (ol > 0.5) {
          const fx = p.x + (ox / ol) * 0.8;
          const fz = p.z + (oz / ol) * 0.8;
          const g = floorBelow(view.map, fx, fz, p.y + 0.05);
          if (g !== null && Math.abs(g - p.y) < 0.1) {
            feet.x = fx;
            feet.z = fz;
          }
        }
      }
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
    if (view.allies?.length) {
      // No friendly fire, but no wasted rockets either: a teammate in the line of fire would eat it, and a blast
      // that only reaches a teammate does nothing.
      const reachesTarget = direct || vdist(at, chestPosition(target.pos)) < RK.splashRadius;
      for (const a of view.allies) {
        const hit = segmentAABB(eye, end, expandAABB(playerAABB(a.pos), RK.rocketRadius));
        if (hit && hit.t < t) return false;
        if (!reachesTarget && vdist(at, chestPosition(a.pos)) < RK.splashRadius) return false;
      }
    }
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
      // Our own rockets are not aimed at us, and a teammate's cannot hurt us.
      if (r.owner === self.id || this.mates.has(r.owner)) continue;
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
    // Elimination has no health to win back: only jump to get unstuck.
    if (view.mode === 'elim' && chance < 1) return;
    this.rjTryAt = now + 1.2;
    if (this.rng() < chance) this.rjWant = { dest, until: now + 0.6 };
  }

  /** Commits to a rocket jump to `dest` if a simulated attempt lands there. */
  private planRocketJump(view: BotView, dest: Vec3): boolean {
    if (hdist(view.self.body.pos, dest) < 3) return true;
    if (!spend(view.now, 'rj', RJ_PLANS_PER_TICK)) return false;
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
    return true;
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
    // Not standing at the start, or the jump did not happen (the server held us still): give up quietly.
    if ((i === 0 && !body.onGround) || (i === 1 && body.onGround)) {
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
