import { TAU } from '../../../shared/math.js';
import type { Bar, Layout, WorldState } from '../../../shared/ruckus/world.js';
import { type Minigame, type MinigameContext, ringSpawns, survivalPlacements } from './types.js';

const RADIUS = 9;

export class Sweeper implements Minigame {
  readonly id = 'sweeper' as const;
  readonly layout: Layout = { kind: 'disc', radius: RADIUS };
  readonly world: WorldState = { bars: [{ a: 0, w: 0.9, len: RADIUS }] };
  private added = 1;

  spawns(n: number) {
    // Start everyone away from the first bar (which lies along +x).
    return ringSpawns(n, 5).map((s) => {
      const a = Math.atan2(s.z, s.x) + Math.PI / 2;
      return { x: Math.cos(a) * 5, z: Math.sin(a) * 5 };
    });
  }

  step(dt: number, ctx: MinigameContext) {
    const bars = this.world.bars!;
    const ramp = 1 + ctx.now * 0.028;
    for (const b of bars) {
      const base = Math.abs(b.w) < 0.1 ? 0.9 : Math.sign(b.w) * 0.9;
      b.w = base * ramp * (b.len < RADIUS ? 1.25 : 1);
      b.a = (b.a + b.w * dt) % TAU;
      if (b.a < 0) b.a += TAU;
    }
    if (this.added === 1 && ctx.now > 14) {
      const bar: Bar = { a: Math.PI, w: 0.9, len: RADIUS };
      bars.push(bar);
      this.added++;
    } else if (this.added === 2 && ctx.now > 32) {
      // A shorter bar spinning the other way around the middle.
      bars.push({ a: Math.PI / 2, w: -0.9, len: 5 });
      this.added++;
    }
  }

  isOver(ctx: MinigameContext) {
    return ctx.alive().length <= 1;
  }

  placements(ctx: MinigameContext) {
    return survivalPlacements(ctx);
  }
}
