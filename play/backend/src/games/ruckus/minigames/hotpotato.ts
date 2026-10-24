import { toTuple } from '../../../shared/math.js';
import type { Layout, WorldState } from '../../../shared/ruckus/world.js';
import { type Minigame, type MinigameContext, type MPawn, ringSpawns, survivalPlacements } from './types.js';

const RADIUS = 9;
const PASS_COOLDOWN = 0.6;

export class HotPotato implements Minigame {
  readonly id = 'hotpotato' as const;
  readonly layout: Layout = { kind: 'disc', radius: RADIUS };
  readonly world: WorldState = { bomb: { holder: null, fuse: 0 } };
  private lastPass = -10;

  spawns(n: number) {
    return ringSpawns(n, RADIUS - 2.5);
  }

  begin(ctx: MinigameContext) {
    this.arm(ctx, null);
  }

  private arm(ctx: MinigameContext, exclude: MPawn | null) {
    const candidates = ctx.alive().filter((p) => p !== exclude);
    if (!candidates.length) return;
    const holder = candidates[Math.floor(ctx.rng() * candidates.length)];
    this.world.bomb = { holder: holder.id, fuse: 9 + ctx.rng() * 7 };
    this.lastPass = ctx.now;
  }

  step(dt: number, ctx: MinigameContext) {
    const bomb = this.world.bomb!;
    if (!bomb.holder) return;
    const holder = ctx.pawns.find((p) => p.id === bomb.holder);
    if (!holder || holder.out) {
      this.arm(ctx, null);
      return;
    }
    bomb.fuse -= dt;
    if (bomb.fuse <= 0) {
      ctx.emit({ k: 'boom', at: toTuple(holder.body.pos), id: holder.id });
      ctx.eliminate(holder);
      bomb.holder = null;
      if (ctx.alive().length >= 2) this.arm(ctx, holder);
    }
  }

  onContact(a: MPawn, b: MPawn, _dasher: MPawn | null, ctx: MinigameContext) {
    const bomb = this.world.bomb!;
    if (!bomb.holder || ctx.now - this.lastPass < PASS_COOLDOWN) return;
    const from = bomb.holder === a.id ? a : bomb.holder === b.id ? b : null;
    if (!from) return;
    const to = from === a ? b : a;
    bomb.holder = to.id;
    this.lastPass = ctx.now;
    ctx.emit({ k: 'pass', from: from.id, to: to.id });
  }

  afterPawnStep(p: MPawn) {
    // The holder recovers the dash faster so they can actually catch someone.
    if (this.world.bomb?.holder === p.id && p.body.dashCd > 0) p.body.dashCd = Math.max(0, p.body.dashCd - 1 / 60);
  }

  isOver(ctx: MinigameContext) {
    return ctx.alive().length <= 1;
  }

  placements(ctx: MinigameContext) {
    const holder = this.world.bomb?.holder;
    // Whoever is holding the bomb when time runs out ranks below the other survivors.
    const tiers = survivalPlacements(ctx);
    if (holder && tiers[0]?.includes(holder) && tiers[0].length > 1) {
      tiers[0] = tiers[0].filter((id) => id !== holder);
      tiers.splice(1, 0, [holder]);
    }
    return tiers;
  }
}
