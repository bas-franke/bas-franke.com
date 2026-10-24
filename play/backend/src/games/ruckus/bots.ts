// Ruckus bots: one small heuristic per minigame. They re-decide a few times a second and hold the input in between,
// with difficulty controlling reaction time, aim jitter and how cleverly they use the dash.

import { TAU, wrapAngle } from '../../shared/math.js';
import type { BotDifficulty } from '../../shared/protocol.js';
import { RU } from '../../shared/ruckus/constants.js';
import { type Layout, type MinigameId, type RuckusInput, type WorldState, tileCenter, tileIndex } from '../../shared/ruckus/world.js';
import type { MPawn } from './minigames/types.js';

export interface BotParams {
  /** Seconds between decisions. */
  reaction: number;
  /** Random steering noise (radians). */
  jitter: number;
  /** Probability of using the dash when it would be smart. */
  dashSkill: number;
  /** Looks ahead / dodges. */
  clever: boolean;
}

export const BOT_PARAMS: Record<BotDifficulty, BotParams> = {
  easy: { reaction: 0.35, jitter: 0.5, dashSkill: 0.3, clever: false },
  normal: { reaction: 0.18, jitter: 0.25, dashSkill: 0.7, clever: true },
  hard: { reaction: 0.08, jitter: 0.08, dashSkill: 0.95, clever: true },
};

export interface BotView {
  now: number;
  self: MPawn;
  others: MPawn[];
  layout: Layout;
  world: WorldState;
  mg: MinigameId;
}

export class RuckusBot {
  private seq = 0;
  private decideAt = 0;
  private held: RuckusInput = { seq: 0, mx: 0, mz: 0, dash: false };
  private wander = 0;

  constructor(
    private readonly params: BotParams,
    private readonly rng: () => number,
  ) {}

  think(view: BotView): RuckusInput {
    if (view.now >= this.decideAt) {
      this.decideAt = view.now + this.params.reaction * (0.7 + this.rng() * 0.6);
      this.held = this.decide(view);
    }
    const dash = this.held.dash;
    this.held.dash = false; // a dash is a single press
    // The edge guard runs every step, not just at decision time: a held direction must never carry a bot off.
    let { mx, mz } = this.held;
    if (view.layout.kind === 'disc') {
      const k = this.keepOnDisc(view, mx, mz);
      const l = Math.hypot(k.dx, k.dz);
      if (l > 1) {
        mx = k.dx / l;
        mz = k.dz / l;
      } else {
        mx = k.dx;
        mz = k.dz;
      }
    }
    return { mx, mz, dash, seq: ++this.seq };
  }

  private decide(view: BotView): RuckusInput {
    switch (view.mg) {
      case 'hotpotato':
        return this.hotPotato(view);
      case 'lava':
        return this.lava(view);
      case 'coins':
        return this.coins(view);
      case 'sweeper':
        return this.sweeper(view);
      case 'sumo':
        return this.sumo(view);
    }
  }

  private move(dx: number, dz: number, dash = false): RuckusInput {
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) return { seq: 0, mx: 0, mz: 0, dash };
    const ang = Math.atan2(dz, dx) + (this.rng() * 2 - 1) * this.params.jitter;
    return { seq: 0, mx: Math.cos(ang), mz: Math.sin(ang), dash };
  }

  /**
   * Keeps a desired direction from running off a disc: near the edge the outward component is removed and
   * replaced by a pull toward the centre, so fleeing and chasing bots circle instead of falling.
   */
  private keepOnDisc(view: BotView, dx: number, dz: number, margin = 3.5) {
    if (view.layout.kind !== 'disc') return { dx, dz };
    const radius = view.world.radius ?? view.layout.radius;
    const p = view.self.body.pos;
    const r = Math.hypot(p.x, p.z);
    if (r < 0.01) return { dx, dz };
    const l = Math.hypot(dx, dz);
    if (l > 1e-6) {
      dx /= l;
      dz /= l;
    }
    const ux = p.x / r;
    const uz = p.z / r;
    const edge = radius - r;
    const full = Math.min(1.5, margin * 0.45);
    const outward = dx * ux + dz * uz;
    if (edge < margin && outward > 0) {
      const allowed = Math.max(0, edge - full) / (margin - full);
      dx -= ux * outward * (1 - allowed);
      dz -= uz * outward * (1 - allowed);
    }
    if (edge < 2.2) {
      dx -= ux * (2.2 - edge) * 1.5;
      dz -= uz * (2.2 - edge) * 1.5;
    }
    return { dx, dz };
  }

  /** Would a dash in this direction (about 3.5 m) stay on the disc? */
  private dashSafe(view: BotView, dx: number, dz: number) {
    if (view.layout.kind !== 'disc') return true;
    const radius = view.world.radius ?? view.layout.radius;
    const l = Math.hypot(dx, dz) || 1;
    const p = view.self.body.pos;
    return Math.hypot(p.x + (dx / l) * 3.5, p.z + (dz / l) * 3.5) < radius - 0.4;
  }

  private nearest(view: BotView, filter?: (p: MPawn) => boolean): { p: MPawn; d: number } | null {
    let best: MPawn | null = null;
    let bestD = Infinity;
    for (const o of view.others) {
      if (filter && !filter(o)) continue;
      const d = Math.hypot(o.body.pos.x - view.self.body.pos.x, o.body.pos.z - view.self.body.pos.z);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best ? { p: best, d: bestD } : null;
  }

  // ---- minigames ----------------------------------------------------------------------------------------------

  private hotPotato(view: BotView): RuckusInput {
    const me = view.self.body;
    const holderId = view.world.bomb?.holder;
    if (holderId === view.self.id) {
      const target = this.nearest(view);
      if (!target) return this.move(0, 0);
      const t = target.p.body;
      const lead = Math.min(0.5, target.d / 10);
      const dx = t.pos.x + t.vel.x * lead - me.pos.x;
      const dz = t.pos.z + t.vel.z * lead - me.pos.z;
      const dash = target.d < 3.4 && me.dashCd === 0 && this.dashSafe(view, dx, dz) && this.rng() < this.params.dashSkill;
      const k = this.keepOnDisc(view, dx, dz);
      return this.move(k.dx, k.dz, dash);
    }
    const holder = view.others.find((o) => o.id === holderId);
    if (!holder) return this.wanderDisc(view);
    const dx = me.pos.x - holder.body.pos.x;
    const dz = me.pos.z - holder.body.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 7) return this.wanderDisc(view);
    // Run away, but circle rather than straight into the edge.
    const k = this.keepOnDisc(view, dx, dz);
    const dash = d < 2.6 && me.dashCd === 0 && this.dashSafe(view, k.dx, k.dz) && this.rng() < this.params.dashSkill;
    return this.move(k.dx, k.dz, dash);
  }

  private wanderDisc(view: BotView): RuckusInput {
    if (this.rng() < 0.3) this.wander = this.rng() * TAU;
    const k = this.keepOnDisc(view, Math.cos(this.wander), Math.sin(this.wander));
    return this.move(k.dx, k.dz);
  }

  private lava(view: BotView): RuckusInput {
    if (view.layout.kind !== 'tiles') return this.move(0, 0);
    const layout = view.layout;
    const tiles = view.world.tiles ?? [];
    const me = view.self.body.pos;
    const here = tileIndex(layout, me.x, me.z);
    let best: { x: number; z: number; score: number } | null = null;
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] !== 0 || i === here) continue;
      const c = tileCenter(layout, i);
      const d = Math.hypot(c.x - me.x, c.z - me.z);
      if (d > layout.size * 2.2) continue;
      let neighbours = 0;
      const cx = i % layout.cols;
      const cz = Math.floor(i / layout.cols);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const nx = cx + ox;
          const nz = cz + oz;
          if (nx < 0 || nz < 0 || nx >= layout.cols || nz >= layout.rows) continue;
          if (tiles[nz * layout.cols + nx] === 0) neighbours++;
        }
      }
      let crowd = 0;
      for (const o of view.others) crowd += Math.hypot(o.body.pos.x - c.x, o.body.pos.z - c.z) < 1.5 ? 1 : 0;
      const score = neighbours * (this.params.clever ? 1 : 0.3) - d * 0.8 - crowd * 1.5 + this.rng() * 1.5;
      if (!best || score > best.score) best = { x: c.x, z: c.z, score };
    }
    if (!best) return this.move(0, 0);
    return this.move(best.x - me.x, best.z - me.z);
  }

  private coins(view: BotView): RuckusInput {
    const me = view.self;
    const coins = view.world.coins ?? [];
    let target: { x: number; z: number } | null = null;
    let bestScore = -Infinity;
    for (const c of coins) {
      const d = Math.hypot(c.x - me.body.pos.x, c.z - me.body.pos.z);
      let rivals = 0;
      for (const o of view.others) if (Math.hypot(c.x - o.body.pos.x, c.z - o.body.pos.z) < d) rivals++;
      const score = -d - rivals * (this.params.clever ? 3 : 0) + this.rng();
      if (score > bestScore) {
        bestScore = score;
        target = c;
      }
    }
    const rich = this.nearest(view, (o) => o.score >= 3 && o.score >= me.score);
    if (rich && rich.d < 2.2 && me.body.dashCd === 0 && this.params.clever && this.rng() < this.params.dashSkill) {
      return this.move(rich.p.body.pos.x - me.body.pos.x, rich.p.body.pos.z - me.body.pos.z, true);
    }
    if (!target) return this.move(0, 0);
    const dx = target.x - me.body.pos.x;
    const dz = target.z - me.body.pos.z;
    const dash = Math.hypot(dx, dz) > 7 && me.body.dashCd === 0 && this.rng() < this.params.dashSkill * 0.5;
    return this.move(dx, dz, dash);
  }

  private sweeper(view: BotView): RuckusInput {
    const me = view.self.body;
    const bars = view.world.bars ?? [];
    const r = Math.hypot(me.pos.x, me.pos.z);
    const ang = Math.atan2(me.pos.z, me.pos.x);
    // Danger: the bar that will reach our angle soonest, in its own direction of travel.
    let soonest: { bar: (typeof bars)[number]; gap: number } | null = null;
    for (const b of bars) {
      if (r > b.len + 0.5) continue;
      let gap = wrapAngle(ang - b.a) * Math.sign(b.w);
      if (gap < 0) gap += TAU;
      if (!soonest || gap / Math.abs(b.w) < soonest.gap / Math.abs(soonest.bar.w)) soonest = { bar: b, gap };
    }
    const targetR = this.params.clever ? 2.6 : 4;
    const radial = (targetR - r) * 0.8;
    const rx = r > 0.01 ? me.pos.x / r : 1;
    const rz = r > 0.01 ? me.pos.z / r : 0;
    if (!soonest) return this.move(rx * radial, rz * radial);
    const dir = Math.sign(soonest.bar.w);
    // Tangent in the bar's direction of travel.
    const tx = -Math.sin(ang) * dir;
    const tz = Math.cos(ang) * dir;
    const timeToHit = soonest.gap / Math.abs(soonest.bar.w);
    const run = timeToHit < 1.4 ? 1 : 0.4;
    const k = this.keepOnDisc(view, tx * run + rx * radial, tz * run + rz * radial, 2);
    const dash = timeToHit < 0.45 && me.dashCd === 0 && this.dashSafe(view, k.dx, k.dz) && this.rng() < this.params.dashSkill;
    return this.move(k.dx, k.dz, dash);
  }

  private sumo(view: BotView): RuckusInput {
    const me = view.self.body;
    const radius = view.world.radius ?? 8;
    const r = Math.hypot(me.pos.x, me.pos.z);
    if (r > radius - 1.3) return this.move(-me.pos.x, -me.pos.z, me.dashCd === 0 && r > radius - 0.6 && radius > 3);
    // Someone dashing straight at us: sidestep.
    if (this.params.clever) {
      for (const o of view.others) {
        if (o.body.dashT <= 0) continue;
        const dx = me.pos.x - o.body.pos.x;
        const dz = me.pos.z - o.body.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 3.5 && (dx * o.body.vel.x + dz * o.body.vel.z) / (d * RU.dashSpeed) > 0.8) {
          return this.move(-dz, dx, me.dashCd === 0 && this.rng() < this.params.dashSkill);
        }
      }
    }
    // Prefer enemies closer to the edge than we are.
    let best: { p: MPawn; score: number } | null = null;
    for (const o of view.others) {
      const d = Math.hypot(o.body.pos.x - me.pos.x, o.body.pos.z - me.pos.z);
      const er = Math.hypot(o.body.pos.x, o.body.pos.z);
      const score = -d + (this.params.clever ? er * 0.8 : 0);
      if (!best || score > best.score) best = { p: o, score };
    }
    if (!best) return this.move(0, 0);
    const t = best.p.body;
    const dx = t.pos.x - me.pos.x;
    const dz = t.pos.z - me.pos.z;
    const d = Math.hypot(dx, dz);
    // Dash when the shove would send them outward and we would not fly off ourselves. Once the disc is tiny
    // nothing is safe any more, so gamble on a dash that points at the far side.
    const outward = (dx * t.pos.x + dz * t.pos.z) / ((d || 1) * (Math.hypot(t.pos.x, t.pos.z) || 1));
    const safe = this.dashSafe(view, dx, dz) || (radius < 3.5 && outward > 0.5 && this.rng() < 0.5);
    const dash = d < 2.6 && me.dashCd === 0 && (outward > 0.2 || !this.params.clever) && safe && this.rng() < this.params.dashSkill;
    const k = this.keepOnDisc(view, dx, dz, 2);
    return this.move(k.dx, k.dz, dash);
  }
}
