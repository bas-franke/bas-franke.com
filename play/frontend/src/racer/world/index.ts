// Everything that makes up the world around a race, in build order. Each module is owned separately; see types.ts.

import { buildLandmarks } from './landmarks';
import { buildSky } from './sky';
import { buildSkyCity } from './skyCity';
import { buildStands } from './stands';
import { buildTerrain } from './terrain';
import { buildTrackSurface } from './trackSurface';
import type { FrameView, WorldBuilder, WorldContext, WorldPart } from './types';
import { buildWater } from './water';

export const WORLD_BUILDERS: Record<string, WorldBuilder> = {
  sky: buildSky,
  terrain: buildTerrain,
  landmarks: buildLandmarks,
  track: buildTrackSurface,
  stands: buildStands,
  water: buildWater,
  skyCity: buildSkyCity,
};

export interface World {
  parts: WorldPart[];
  update(view: FrameView): void;
  dispose(): void;
}

/** Builds the world. `only` limits it to some modules (labs); a module that throws is skipped and logged. */
export function buildWorld(ctx: WorldContext, only?: string[]): World {
  const parts: WorldPart[] = [];
  for (const [name, build] of Object.entries(WORLD_BUILDERS)) {
    if (only && !only.includes(name)) continue;
    try {
      const part = build(ctx);
      if (part.object) ctx.scene.add(part.object);
      parts.push(part);
    } catch (err) {
      console.error(`world module "${name}" failed`, err);
    }
  }
  return {
    parts,
    update: (view) => {
      for (const p of parts) p.update?.(view);
    },
    dispose: () => {
      for (const p of parts) {
        if (p.object) ctx.scene.remove(p.object);
        p.dispose?.();
      }
    },
  };
}
