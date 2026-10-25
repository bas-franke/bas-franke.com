// Every game the frontend can render. Mirrors backend/src/games/registry.ts.

import type { ComponentType } from 'react';
import type { GameId } from '@shared/protocol';
import { GardenClient } from './garden/client';
import { GardenHud } from './garden/Hud';
import { RocketsClient } from './rockets/client';
import { RocketsHud } from './rockets/Hud';
import { RuckusClient } from './ruckus/client';
import { RuckusHud } from './ruckus/Hud';
import type { ClientContext, GameClient } from './types';
import { ZombiesClient } from './zombies/client';
import { ZombiesHud } from './zombies/Hud';

export interface GameModule<C extends GameClient = GameClient> {
  create(ctx: ClientContext): C;
  Hud: ComponentType<{ client: C; ctx: ClientContext }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const gameModules: Record<GameId, GameModule<any>> = {
  rockets: { create: (ctx) => new RocketsClient(ctx), Hud: RocketsHud },
  ruckus: { create: (ctx) => new RuckusClient(ctx), Hud: RuckusHud },
  zombies: { create: (ctx) => new ZombiesClient(ctx), Hud: ZombiesHud },
  garden: { create: (ctx) => new GardenClient(ctx), Hud: GardenHud },
};
