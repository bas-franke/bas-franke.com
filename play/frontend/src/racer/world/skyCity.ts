// The sky city set piece and the airships: the mesa-top settlement where the zones put one (themes with skyCity), and
// the airships drifting over the circuit with it. Themes without the city (the dusk canyon of the concept art) have
// neither: no airship in any reference frame, and their pale hulls fought the red-violet palette. See cityBuild.ts
// and airships.ts.

import * as THREE from 'three';
import { buildAirships } from './airships';
import { buildCity } from './cityBuild';
import type { WorldBuilder, WorldPart } from './types';
import { zonesFor } from './zones';

export const buildSkyCity: WorldBuilder = (ctx) => {
  const city = zonesFor(ctx.track).city;
  const group = new THREE.Group();
  group.name = 'skyCityModule';
  const parts: WorldPart[] = [];
  if (city) parts.push(buildCity(ctx, city));
  if (ctx.theme.skyCity) parts.push(buildAirships(ctx, city));
  for (const p of parts) if (p.object) group.add(p.object);
  return {
    object: group,
    update: (view) => {
      for (const p of parts) p.update?.(view);
    },
    dispose: () => {
      for (const p of parts) p.dispose?.();
    },
  };
};
