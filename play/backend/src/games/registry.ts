// Every game the server can host. Adding a game: create games/<id>/, add it to GAMES in shared/protocol.ts and here.

import type { GameId } from '../shared/protocol.js';
import { createDustrunnersGame } from './dustrunners/server.js';
import { createGardenGame } from './garden/server.js';
import { createRocketsGame } from './rockets/server.js';
import { createRuckusGame } from './ruckus/server.js';
import type { GameFactory } from './types.js';
import { createZombiesGame } from './zombies/server.js';

export const gameFactories: Record<GameId, GameFactory> = {
  rockets: createRocketsGame,
  ruckus: createRuckusGame,
  zombies: createZombiesGame,
  garden: createGardenGame,
  dustrunners: createDustrunnersGame,
};
