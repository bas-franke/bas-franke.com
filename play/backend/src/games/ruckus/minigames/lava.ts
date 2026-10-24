import { type Layout, type WorldState, tileCenter, tileIndex } from '../../../shared/ruckus/world.js';
import { type Minigame, type MinigameContext, ringSpawns, survivalPlacements } from './types.js';

const COLS = 11;
const ROWS = 11;
const SIZE = 2;
/** A tile starts cracking once someone has stood on it for this long; running across is safe, stopping is not. */
const DWELL_SECONDS = 0.45;
/** Dwell drains this many times faster than it builds while nobody is on the tile. */
const DWELL_DECAY = 2;
const CRACK_SECONDS = 1.3;
/** After this long, random tiles start cracking on their own, faster and faster. */
const RANDOM_AFTER = 12;

export class FloorIsLava implements Minigame {
  readonly id = 'lava' as const;
  readonly layout = { kind: 'tiles', cols: COLS, rows: ROWS, size: SIZE } as const satisfies Layout;
  readonly world: WorldState = { tiles: new Array(COLS * ROWS).fill(0) };
  private readonly dwell = new Float32Array(COLS * ROWS);
  private readonly timers = new Map<number, number>();
  private nextRandom = RANDOM_AFTER;

  spawns(n: number) {
    // Snap spawns to tile centres so everyone starts on a clean tile.
    return ringSpawns(n, 7).map((s) => {
      const i = tileIndex(this.layout, s.x, s.z);
      return i >= 0 ? tileCenter(this.layout, i) : s;
    });
  }

  private crack(i: number, ctx: MinigameContext) {
    const tiles = this.world.tiles!;
    if (tiles[i] !== 0) return;
    tiles[i] = 1;
    this.timers.set(i, CRACK_SECONDS);
    ctx.emit({ k: 'tile', i, state: 1 });
  }

  step(dt: number, ctx: MinigameContext) {
    const tiles = this.world.tiles!;
    const occupied = new Set<number>();
    for (const p of ctx.alive()) {
      if (!p.body.onGround) continue;
      const i = tileIndex(this.layout, p.body.pos.x, p.body.pos.z);
      if (i < 0) continue;
      occupied.add(i);
      if (tiles[i] !== 0) continue;
      this.dwell[i] += dt;
      if (this.dwell[i] >= DWELL_SECONDS) this.crack(i, ctx);
    }
    for (let i = 0; i < this.dwell.length; i++) {
      if (this.dwell[i] > 0 && !occupied.has(i)) this.dwell[i] = Math.max(0, this.dwell[i] - dt * DWELL_DECAY);
    }
    for (const [i, t] of this.timers) {
      const left = t - dt;
      if (left <= 0) {
        this.timers.delete(i);
        tiles[i] = 2;
        ctx.emit({ k: 'tile', i, state: 2 });
      } else this.timers.set(i, left);
    }
    if (ctx.now >= this.nextRandom) {
      const solid: number[] = [];
      tiles.forEach((s, i) => s === 0 && solid.push(i));
      if (solid.length) this.crack(solid[Math.floor(ctx.rng() * solid.length)], ctx);
      const interval = Math.max(0.15, 0.7 - (ctx.now - RANDOM_AFTER) * 0.014);
      this.nextRandom = ctx.now + interval;
    }
  }

  isOver(ctx: MinigameContext) {
    return ctx.alive().length <= 1;
  }

  placements(ctx: MinigameContext) {
    return survivalPlacements(ctx);
  }
}
