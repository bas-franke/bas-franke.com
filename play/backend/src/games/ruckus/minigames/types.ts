// Contract between the Ruckus round runner and a minigame.

import type { RuckusEvent } from '../../../shared/ruckus/protocol.js';
import type { Layout, MinigameId, Pawn, WorldState } from '../../../shared/ruckus/world.js';

export interface MPawn {
  id: string;
  name: string;
  bot: boolean;
  body: Pawn;
  out: boolean;
  /** Sim time of elimination; -1 while in. */
  outAt: number;
  /** Round-specific score where the minigame keeps one (coins). */
  score: number;
}

export interface MinigameContext {
  /** Seconds since play began. */
  now: number;
  /** Everyone taking part this round, in and out. */
  pawns: MPawn[];
  alive(): MPawn[];
  eliminate(p: MPawn): void;
  emit(e: RuckusEvent): void;
  rng: () => number;
}

export interface Minigame {
  readonly id: MinigameId;
  readonly layout: Layout;
  readonly world: WorldState;
  spawns(n: number): { x: number; z: number }[];
  begin?(ctx: MinigameContext): void;
  step(dt: number, ctx: MinigameContext): void;
  /** Two live pawns touched this step. `dasher` is whichever of them was mid-dash, if any. */
  onContact?(a: MPawn, b: MPawn, dasher: MPawn | null, ctx: MinigameContext): void;
  /** Extra per-pawn rule applied after the pawn moved (e.g. the bomb holder dashes more often). */
  afterPawnStep?(p: MPawn, ctx: MinigameContext): void;
  isOver(ctx: MinigameContext): boolean;
  /** Ranking tiers, best first. Pawns in one tier share the placement. */
  placements(ctx: MinigameContext): string[][];
}

/** Evenly spaced spawn ring. */
export function ringSpawns(n: number, radius: number): { x: number; z: number }[] {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: Math.cos(a) * radius, z: Math.sin(a) * radius });
  }
  return out;
}

/** Survivors tie for first; the eliminated rank by how long they lasted. */
export function survivalPlacements(ctx: MinigameContext, aliveSort?: (a: MPawn, b: MPawn) => number): string[][] {
  const alive = ctx.alive();
  if (aliveSort) alive.sort(aliveSort);
  const tiers: string[][] = [];
  if (alive.length) {
    if (aliveSort) for (const p of alive) tiers.push([p.id]);
    else tiers.push(alive.map((p) => p.id));
  }
  const out = ctx.pawns.filter((p) => p.out).sort((a, b) => b.outAt - a.outAt);
  let current: string[] = [];
  let currentAt = NaN;
  for (const p of out) {
    if (Math.abs(p.outAt - currentAt) < 1e-3) current.push(p.id);
    else {
      if (current.length) tiers.push(current);
      current = [p.id];
      currentAt = p.outAt;
    }
  }
  if (current.length) tiers.push(current);
  return tiers;
}
