// Rockets item control, Quake style: armor shards in trails along the routes, a yellow armor or two at spots that
// take commitment to reach, and one mega health on a long timer somewhere exposed. Health packs stay in maps.ts;
// everything else lives here, keyed by map id, so map layout and item layout can be tuned separately. Every
// position sits on walkable ground (groundAt in nav.ts), clear of pads, spawns and packs.

import { type Vec3, v3 } from '../math.js';

export type ItemKind = 'shard' | 'armor' | 'mega';

export interface ItemSpawn {
  k: ItemKind;
  /** On the surface the item rests on. */
  p: Vec3;
}

export const ITEM = {
  /** Armor soaks this share of incoming damage while it lasts (Quake 3 uses two thirds). */
  armorProtection: 0.66,
  /** Armor and health above this tick back down by one point per second. */
  overhealFloor: 100,
  /** Hard caps: shards and armor stack up to maxArmor, mega health up to maxOverheal. */
  maxArmor: 200,
  maxOverheal: 200,
  shard: { armor: 5, respawn: 20 },
  armor: { armor: 50, respawn: 25 },
  mega: { health: 100, respawn: 40 },
} as const;

/** Respawn time of each kind, in seconds. */
export const itemRespawn = (k: ItemKind) => ITEM[k].respawn;

// Same quarter-turn rotation as MapBuilder's quad and pair, so items follow each map's symmetry.
const rot = (x: number, y: number, z: number, t: number): Vec3 =>
  t === 1 ? v3(-z, y, x) : t === 2 ? v3(-x, y, -z) : t === 3 ? v3(z, y, -x) : v3(x, y, z);
const one = (k: ItemKind, x: number, y: number, z: number): ItemSpawn[] => [{ k, p: v3(x, y, z) }];
const pair = (k: ItemKind, x: number, y: number, z: number): ItemSpawn[] => [0, 2].map((t) => ({ k, p: rot(x, y, z, t) }));
const quad = (k: ItemKind, x: number, y: number, z: number): ItemSpawn[] => [0, 1, 2, 3].map((t) => ({ k, p: rot(x, y, z, t) }));

const ITEMS: Record<string, ItemSpawn[]> = {
  // Mega on top of a pillar: rocket-jump for it. Armor on the central platform, shards on the floor and the ledges.
  foundry: [...one('mega', 11.5, 7, 11.5), ...pair('armor', -5, 3, 5), ...quad('shard', 0, 0, 20), ...pair('shard', 30.25, 4, 6), ...pair('shard', 30.25, 4, -6)],
  // Mega on the hub next to the health; armor out on the high bridges; shards on the outer islands.
  skyway: [...one('mega', 2.4, 2, -2.4), ...pair('armor', 16, 5, 25), ...quad('shard', 26, 0, 4.5), ...quad('shard', 26, 0, -4.5)],
  // Mega down on the canyon floor between both plateaus; armor up top; shards across the bridges.
  canyon: [...one('mega', 0, 0, 5), ...pair('armor', 24, 6, -12), ...pair('shard', 8, 6, 20), ...pair('shard', -8, 6, 20)],
  // Mega on the second tier of the pyramid; armor on the open floor; shards round the first tier.
  ziggurat: [...one('mega', 6, 4, 6), ...pair('armor', 20, 0, 0), ...quad('shard', 10, 2, -5)],
  // Mega on the central spire next to its launch pad; armor on two pad-only spires; shards on the low towers.
  spires: [...one('mega', 2.5, 5, 2.5), ...pair('armor', 8, 5, 28), ...quad('shard', 10, 3, 10), ...quad('shard', 24, 7, 6.5)],
  // Mega up on the battlements; armor on two corner bunkers; shards outside each doorway.
  fortress: [...one('mega', 6, 5, 11.25), ...pair('armor', 31, 3, 25), ...quad('shard', 0, 0, 16)],
  // Mega on the raised walkway; armor on the far ring; shards round the ring near the edge of the pit.
  pit: [...one('mega', 12, 5, 29.5), ...pair('armor', 16, 0, -19), ...quad('shard', 12, 0, -14)],
  // Mega in the middle of the long bridge, in view of both bases; armor on the base towers; shards under the bridge.
  twin: [...one('mega', 0, 4, 0), ...pair('armor', 0, 8, 30), ...pair('shard', 5, 0, 14), ...pair('shard', -5, 0, 14)],
  // Mega on a rooftop; armor on two low roofs; shards on the streets.
  downtown: [...one('mega', 25, 7, 7), ...pair('armor', 9, 2.5, 25), ...quad('shard', 0, 0, 17)],
  // Mega on top of the central pillar: rocket-jump for it. Armor on two inner platforms; shards on the outer ring.
  orbit: [...one('mega', 0, 5, 0), ...pair('armor', 10.3, 3, 10.3), ...quad('shard', 26, 6, -2)],
};

/** Item layout for a map (empty for a map without one). */
export function itemsFor(mapId: string): ItemSpawn[] {
  return ITEMS[mapId] ?? [];
}
