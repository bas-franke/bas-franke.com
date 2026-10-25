// Survivor bots for Last Light. Each bot holds its own spot in the room, picked for sight lines to the windows and
// spread away from the other bots; shoots the nearest zombie it can actually see (inside, or at a window); rebuilds
// barricades between fights, revives downed teammates, buys a better gun when it can afford one and buys ammo for
// it at its locker. Only the pistols have unlimited reserve, so bots run dry like players do.

import { clamp, hdist, type Vec3 } from '../../shared/math.js';
import type { BotDifficulty } from '../../shared/protocol.js';
import { ZB } from '../../shared/zombies/constants.js';
import type { ZInput } from '../../shared/zombies/physics.js';
import { LOCKER_ORDER, WEAPONS } from '../../shared/zombies/weapons.js';
import { firstBlock, inside, raycast, type World } from '../../shared/zombies/world.js';
import type { Survivor } from './server.js';

interface BotZombie {
  pos: Vec3;
  hp: number;
  state: number;
}

export interface BotView {
  now: number;
  wave: number;
  world: World;
  zombies: readonly BotZombie[];
  players: ReadonlyMap<string, Survivor>;
  boards: readonly number[];
  fire(dirs: Vec3[]): void;
  reload(): void;
  switchSlot(s: 0 | 1): void;
  knife(d: Vec3): void;
  repairable(pos: Vec3): number;
}

const PARAMS: Record<BotDifficulty, { aimError: number; turn: number; reaction: number; range: number; headAim: number }> = {
  easy: { aimError: 0.1, turn: 2.5, reaction: 0.8, range: 13, headAim: 0 },
  normal: { aimError: 0.055, turn: 4.5, reaction: 0.45, range: 18, headAim: 0.08 },
  hard: { aimError: 0.018, turn: 8, reaction: 0.18, range: 28, headAim: 0.32 },
};

/** Zombies outside the room are only worth a shot this close, or while they are at a window. */
const OUTSIDE_RANGE = 7;

/** Home spots taken by bots, per world, so each bot picks a spot away from the others. */
const homes = new WeakMap<World, Map<SurvivorBot, Vec3>>();

export class SurvivorBot {
  private seq = 0;
  private yaw = 0;
  private pitch = 0;
  private seenAt = -1;
  private targetRef: BotZombie | null = null;
  private home: Vec3 | null = null;
  private homeWave = -1;
  private strafe = 1;
  private strafeT = 0;
  private thinkT = 0;
  private blockedT = 0;
  private dodgeT = 0;
  private dodge = 1;
  private goal: { pos: Vec3; use: boolean; why: string } | null = null;
  private readonly p: (typeof PARAMS)['normal'];

  constructor(
    difficulty: BotDifficulty,
    private readonly rng: () => number,
  ) {
    this.p = PARAMS[difficulty] ?? PARAMS.normal;
  }

  think(view: BotView, me: Survivor): ZInput {
    const dt = ZB.dt;
    const pos = me.body.pos;
    // Unlimited reserve for pistols only; an empty bought gun means switching to the other one.
    let cur = me.slots[me.cur] ?? 'm1911';
    if (WEAPONS[cur].kind === 'pistol') me.res[me.cur] = Math.max(me.res[me.cur], WEAPONS[cur].mag);
    else if (me.mag[me.cur] <= 0 && me.res[me.cur] <= 0 && me.reloadLeft <= 0) {
      const other: 0 | 1 = me.cur === 0 ? 1 : 0;
      if (me.slots[other]) {
        view.switchSlot(other);
        cur = me.slots[me.cur] ?? cur;
      }
    }
    const inp: ZInput = { seq: ++this.seq, f: 0, s: 0, jump: false, sprint: false, ads: false, use: false, yaw: this.yaw, pitch: this.pitch };
    if (me.life === 2) {
      this.release(view.world);
      return inp;
    }
    // A fresh spot every wave (the room changes as walls come down).
    if (!this.home || this.homeWave !== view.wave) {
      this.home = this.pickHome(view, pos);
      this.homeWave = view.wave;
    }

    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.15;
      const best = this.pickTarget(view, pos);
      if (best !== this.targetRef) this.seenAt = view.now;
      this.targetRef = best;
      this.goal = this.pickGoal(view, me, !!best && hdist(best.pos, pos) < 3);
    }

    let target = this.targetRef && view.zombies.includes(this.targetRef as never) ? this.targetRef : null;
    // A downed teammate comes first unless something is right on us.
    if (target && this.goal?.why === 'revive' && hdist(target.pos, pos) > 3) target = null;
    if (target) {
      const ex = target.pos.x - pos.x;
      const ez = target.pos.z - pos.z;
      const d = Math.hypot(ex, ez);
      // Better bots go for the head now and then.
      const aimY = this.rng() < this.p.headAim ? 1.55 : 1.15;
      const ey = target.pos.y + aimY - (pos.y + ZB.eyeHeight);
      const wantYaw = Math.atan2(-ex, -ez);
      const wantPitch = Math.atan2(ey, d);
      this.yaw += clamp(wrap(wantYaw - this.yaw), -this.p.turn * dt, this.p.turn * dt);
      this.pitch += clamp(wantPitch - this.pitch, -this.p.turn * dt, this.p.turn * dt);
      const err = Math.abs(wrap(wantYaw - this.yaw)) + Math.abs(wantPitch - this.pitch);
      if (d < 1.4 && me.life === 0) view.knife({ x: -Math.sin(this.yaw), y: 0, z: -Math.cos(this.yaw) });
      else if (err < 0.08 && view.now - this.seenAt > this.p.reaction && me.reloadLeft <= 0) {
        if (me.mag[me.cur] <= 0) view.reload();
        else {
          const w = WEAPONS[cur];
          const dirs: Vec3[] = [];
          for (let i = 0; i < w.pellets; i++) {
            const spread = w.pellets > 1 ? w.hip : this.p.aimError;
            const yaw = this.yaw + (this.rng() - 0.5) * 2 * spread;
            const pitch = this.pitch + (this.rng() - 0.5) * 2 * spread;
            dirs.push({ x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) });
          }
          view.fire(dirs);
        }
      }
      // Back off from anything close, drift a little otherwise, and stay near home.
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = 0.8 + this.rng() * 1.2;
        this.strafe = this.rng() < 0.5 ? -1 : 1;
      }
      inp.f = d < 3.5 ? -1 : 0;
      inp.s = this.strafe * 0.4;
      if (this.home && hdist(this.home, pos) > 3 && d > 3.5) {
        // Too far from the spot: step back towards it while shooting.
        const hx = this.home.x - pos.x;
        const hz = this.home.z - pos.z;
        const fx = -Math.sin(this.yaw);
        const fz = -Math.cos(this.yaw);
        const rx = Math.cos(this.yaw);
        const rz = -Math.sin(this.yaw);
        const l = Math.hypot(hx, hz);
        inp.f = clamp((hx * fx + hz * fz) / l, -1, 1);
        inp.s = clamp((hx * rx + hz * rz) / l, -1, 1);
      }
    } else {
      if (me.mag[me.cur] < WEAPONS[cur].mag * 0.5) view.reload();
      this.pitch *= 0.95;
      if (this.goal) {
        const gx = this.goal.pos.x - pos.x;
        const gz = this.goal.pos.z - pos.z;
        const d = Math.hypot(gx, gz);
        const wantYaw = Math.atan2(-gx, -gz);
        this.yaw += clamp(wrap(wantYaw - this.yaw), -this.p.turn * dt, this.p.turn * dt);
        if (d > (this.goal.use ? 0.9 : 0.6)) {
          inp.f = Math.abs(wrap(wantYaw - this.yaw)) < 0.8 ? 1 : 0.2;
          inp.sprint = d > 6;
        } else if (this.goal.why === 'upgrade' && me.slots[1] && me.cur !== 1) {
          // A new gun replaces the one in hand: hold the second slot first so the pistol (unlimited ammo) stays.
          view.switchSlot(1);
        } else inp.use = this.goal.use && (this.seq % 20 !== 0 || (this.goal.why !== 'buy' && this.goal.why !== 'upgrade'));
      } else {
        // Idle: face the nearest window.
        const w = nearestWindow(view.world, pos);
        if (w) this.yaw += clamp(wrap(Math.atan2(-(w.x - pos.x), -(w.z - pos.z)) - this.yaw), -2 * dt, 2 * dt);
      }
    }
    // Walking into something (a crate, a pillar, a teammate): sidestep for a moment, or hop debris.
    const moving = Math.abs(inp.f) > 0.5;
    const speed = Math.hypot(me.body.vel.x, me.body.vel.z);
    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      inp.s = this.dodge;
      inp.f = Math.max(inp.f, 0.3);
    } else if (moving && speed < 0.5) {
      this.blockedT += dt;
      if (this.blockedT > 0.4) {
        this.blockedT = 0;
        this.dodgeT = 0.5;
        this.dodge = this.rng() < 0.5 ? -1 : 1;
        inp.jump = this.rng() < 0.3;
      }
    } else this.blockedT = 0;
    inp.yaw = this.yaw;
    inp.pitch = this.pitch;
    return inp;
  }

  /** The nearest zombie we can see: inside the room, at a window, or close outside. Never through walls. */
  private pickTarget(view: BotView, pos: Vec3): BotZombie | null {
    const eye = { x: pos.x, y: pos.y + ZB.eyeHeight, z: pos.z };
    let best: BotZombie | null = null;
    let bestD = this.p.range;
    for (const z of view.zombies) {
      if (z.state === 0) continue;
      const d = hdist(z.pos, pos);
      if (d >= bestD) continue;
      if (!inside(view.world, z.pos.x, z.pos.z) && d > OUTSIDE_RANGE && !view.world.windows.some((w) => hdist(w.outside, z.pos) < 1.3)) continue;
      const c = { x: z.pos.x, y: z.pos.y + 1.2, z: z.pos.z };
      const dx = c.x - eye.x;
      const dy = c.y - eye.y;
      const dz = c.z - eye.z;
      const len = Math.hypot(dx, dy, dz);
      if (raycast(view.world, eye, { x: dx / len, y: dy / len, z: dz / len }, len - 0.3)) continue;
      best = z;
      bestD = d;
    }
    return best;
  }

  /** A free spot inside with the most windows in sight, a few metres off them, away from the other bots. */
  private pickHome(view: BotView, from: Vec3): Vec3 {
    const w = view.world;
    let taken = homes.get(w);
    if (!taken) homes.set(w, (taken = new Map()));
    taken.delete(this);
    const others = [...taken.values()];
    const m = 2.5;
    let best = { ...from };
    let bestScore = -Infinity;
    for (let x = w.interior.minX + m; x <= w.interior.maxX - m; x += 1.5)
      for (let z = w.interior.minZ + m; z <= w.interior.maxZ - m; z += 1.5) {
        const box = { min: { x: x - 0.45, y: 0.05, z: z - 0.45 }, max: { x: x + 0.45, y: 1.8, z: z + 0.45 } };
        if (firstBlock(w, box, 'player')) continue;
        if (w.stations.some((s) => hdist(s.pos, { x, y: 0, z }) < 2)) continue;
        const eye = { x, y: 1.6, z };
        let seen = 0;
        let nearest = Infinity;
        for (const win of w.windows) {
          const t = { x: win.inside.x, y: 1.6, z: win.inside.z };
          const dx = t.x - x;
          const dz = t.z - z;
          const len = Math.hypot(dx, dz);
          nearest = Math.min(nearest, len);
          if (len > 16) continue;
          if (!raycast(w, eye, { x: dx / len, y: 0, z: dz / len }, len - 0.5)) seen++;
        }
        const spread = others.length ? Math.min(...others.map((o) => hdist(o, eye))) : 6;
        const score = seen * 2 - Math.max(0, 3.5 - nearest) * 3 + Math.min(spread, 6) * 1.2 - hdist(eye, from) * 0.05 + this.rng() * 0.5;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y: 0, z };
        }
      }
    taken.set(this, best);
    return best;
  }

  private release(w: World) {
    homes.get(w)?.delete(this);
    this.home = null;
  }

  private pickGoal(view: BotView, me: Survivor, fighting: boolean): { pos: Vec3; use: boolean; why: string } | null {
    const pos = me.body.pos;
    for (const o of view.players.values())
      if (o !== me && o.life === 1 && hdist(o.body.pos, pos) < 18) return { pos: o.body.pos, use: true, why: 'revive' };
    if (fighting) return null;
    // A better gun when the points allow it (keeping a cushion).
    const have = me.slots.map((s) => (s ? LOCKER_ORDER.indexOf(s) : -1));
    for (let i = LOCKER_ORDER.length - 1; i >= 0; i--) {
      const id = LOCKER_ORDER[i];
      if (i <= Math.max(...have)) break;
      if (me.points >= WEAPONS[id].price * 1.15) {
        const st = view.world.stations.find((s) => s.item === id);
        if (st) return { pos: st.pos, use: true, why: 'upgrade' };
      }
    }
    // Ammo for a bought gun running low.
    for (let s = 0; s < 2; s++) {
      const id = me.slots[s];
      if (!id || WEAPONS[id].kind === 'pistol') continue;
      if (me.res[s] < WEAPONS[id].reserve * 0.25 && me.points >= WEAPONS[id].ammoPrice) {
        const st = view.world.stations.find((x) => x.item === id);
        if (st) return { pos: st.pos, use: true, why: 'buy' };
      }
    }
    // Rebuild the closest window missing boards, unless a teammate is already at it.
    let best = -1;
    let bestD = 14;
    for (const w of view.world.windows) {
      if (view.boards[w.i] >= ZB.boardsPerWindow) continue;
      const d = hdist(w.inside, pos);
      const busy = [...view.players.values()].some((o) => o !== me && o.life === 0 && hdist(o.body.pos, w.inside) < 1.2);
      if (d < bestD && !busy) {
        bestD = d;
        best = w.i;
      }
    }
    if (best >= 0) return { pos: view.world.windows[best].inside, use: true, why: 'repair' };
    if (me.slots[1] && me.cur !== 1 && LOCKER_ORDER.indexOf(me.slots[1]) > LOCKER_ORDER.indexOf(me.slots[0])) view.switchSlot(1);
    if (this.home && hdist(this.home, pos) > 0.7) return { pos: this.home, use: false, why: 'home' };
    return null;
  }
}

function nearestWindow(w: World, p: Vec3): Vec3 | null {
  let best: Vec3 | null = null;
  let bestD = Infinity;
  for (const win of w.windows) {
    const d = hdist(win.inside, p);
    if (d < bestD) {
      bestD = d;
      best = win.inside;
    }
  }
  return best;
}

const wrap = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
