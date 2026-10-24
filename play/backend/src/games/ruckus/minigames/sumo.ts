import type { Layout, WorldState } from '../../../shared/ruckus/world.js';
import { type Minigame, type MinigameContext, ringSpawns, survivalPlacements } from './types.js';

const START = 8;
const END = 2.4;
const SHRINK_SECONDS = 45;

export class Sumo implements Minigame {
  readonly id = 'sumo' as const;
  readonly layout: Layout = { kind: 'disc', radius: START };
  readonly world: WorldState = { radius: START };

  spawns(n: number) {
    return ringSpawns(n, START - 2.5);
  }

  step(_dt: number, ctx: MinigameContext) {
    const t = Math.min(1, ctx.now / SHRINK_SECONDS);
    // Ease in: slow at first so players can fight, then quick.
    const eased = t * t;
    this.world.radius = START - (START - END) * eased;
  }

  isOver(ctx: MinigameContext) {
    return ctx.alive().length <= 1;
  }

  placements(ctx: MinigameContext) {
    return survivalPlacements(ctx);
  }
}
