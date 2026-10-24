import { toTuple } from '../../../shared/math.js';
import type { Coin, Layout, WorldState } from '../../../shared/ruckus/world.js';
import { type Minigame, type MinigameContext, type MPawn, ringSpawns } from './types.js';

const HALF = 10;
const MAX_COINS = 18;
const PICKUP = 0.95;

export class CoinRush implements Minigame {
  readonly id = 'coins' as const;
  readonly layout: Layout = { kind: 'square', half: HALF };
  readonly world: WorldState = { coins: [] };
  private nextId = 1;
  private spawnAt = 0;

  spawns(n: number) {
    return ringSpawns(n, HALF - 2.5);
  }

  begin(ctx: MinigameContext) {
    for (let i = 0; i < 10; i++) this.drop(ctx, (ctx.rng() * 2 - 1) * (HALF - 1.5), (ctx.rng() * 2 - 1) * (HALF - 1.5));
  }

  private drop(ctx: MinigameContext, x: number, z: number) {
    const lim = HALF - 0.8;
    const coin: Coin = { id: this.nextId++, x: Math.max(-lim, Math.min(lim, x)), z: Math.max(-lim, Math.min(lim, z)) };
    this.world.coins!.push(coin);
    return coin;
  }

  step(dt: number, ctx: MinigameContext) {
    const coins = this.world.coins!;
    this.spawnAt -= dt;
    if (this.spawnAt <= 0 && coins.length < MAX_COINS) {
      this.drop(ctx, (ctx.rng() * 2 - 1) * (HALF - 1.5), (ctx.rng() * 2 - 1) * (HALF - 1.5));
      this.spawnAt = 0.8;
    }
    for (const p of ctx.alive()) {
      if (p.body.pos.y > 0.6) continue;
      for (let i = coins.length - 1; i >= 0; i--) {
        const c = coins[i];
        const dx = c.x - p.body.pos.x;
        const dz = c.z - p.body.pos.z;
        if (dx * dx + dz * dz <= PICKUP * PICKUP) {
          coins.splice(i, 1);
          p.score++;
          ctx.emit({ k: 'coin', id: p.id, at: [c.x, 0, c.z] });
        }
      }
    }
  }

  onContact(a: MPawn, b: MPawn, dasher: MPawn | null, ctx: MinigameContext) {
    if (!dasher) return;
    const victim = dasher === a ? b : a;
    const n = Math.min(3, victim.score);
    if (n <= 0) return;
    victim.score -= n;
    for (let i = 0; i < n; i++) {
      const ang = ctx.rng() * Math.PI * 2;
      const r = 1.6 + ctx.rng() * 1.2;
      this.drop(ctx, victim.body.pos.x + Math.cos(ang) * r, victim.body.pos.z + Math.sin(ang) * r);
    }
    ctx.emit({ k: 'shove', id: victim.id, by: dasher.id });
    void toTuple;
  }

  isOver() {
    return false;
  }

  placements(ctx: MinigameContext) {
    const sorted = [...ctx.pawns].sort((a, b) => b.score - a.score);
    const tiers: string[][] = [];
    let last = NaN;
    for (const p of sorted) {
      if (p.score === last) tiers[tiers.length - 1].push(p.id);
      else {
        tiers.push([p.id]);
        last = p.score;
      }
    }
    return tiers;
  }
}
