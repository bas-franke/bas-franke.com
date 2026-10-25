// Every gun in Last Light. Modern guns are strong and expensive; the older guns are cheaper and still useful early.
// `world` is the damage one bullet (or pellet) deals to a wall chunk; chunk health lives in world.ts.

export type WeaponId =
  | 'm1911'
  | 'glock'
  | 'thompson'
  | 'trench'
  | 'kar98k'
  | 'garand'
  | 'mp7'
  | 'm4a1'
  | 'ak12'
  | 'benelli'
  | 'm249'
  | 'barrett';

export type WeaponKind = 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'sniper' | 'lmg';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  era: 'classic' | 'modern';
  kind: WeaponKind;
  price: number;
  /** Refill of the reserve at the locker that sells it. */
  ammoPrice: number;
  damage: number;
  headMult: number;
  /** Rounds per minute. */
  rpm: number;
  auto: boolean;
  mag: number;
  reserve: number;
  /** Seconds for a full reload (tube-fed guns load one shell per `reload / mag`). */
  reload: number;
  perShell?: boolean;
  pellets: number;
  /** Cone half-angles in radians, from the hip and aimed. */
  hip: number;
  ads: number;
  /** Zombies one bullet goes through. */
  pen: number;
  /** Chunk damage per bullet. */
  world: number;
  /** Vertical kick per shot (radians) and random sideways share. */
  kick: number;
  /** Aimed field of view as a share of the normal one. */
  zoom: number;
  /** Damage falls to 50% between these distances. */
  falloff: [number, number];
}

const W = (d: WeaponDef) => d;

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  m1911: W({ id: 'm1911', name: 'M1911', era: 'classic', kind: 'pistol', price: 0, ammoPrice: 120, damage: 48, headMult: 3, rpm: 420, auto: false, mag: 8, reserve: 64, reload: 1.6, pellets: 1, hip: 0.028, ads: 0.006, pen: 1, world: 9, kick: 0.035, zoom: 0.82, falloff: [12, 30] }),
  glock: W({ id: 'glock', name: 'Glock 17', era: 'modern', kind: 'pistol', price: 500, ammoPrice: 250, damage: 42, headMult: 3, rpm: 640, auto: false, mag: 17, reserve: 136, reload: 1.4, pellets: 1, hip: 0.024, ads: 0.005, pen: 1, world: 9, kick: 0.026, zoom: 0.82, falloff: [12, 30] }),
  thompson: W({ id: 'thompson', name: 'Thompson M1A1', era: 'classic', kind: 'smg', price: 1200, ammoPrice: 600, damage: 52, headMult: 2.5, rpm: 700, auto: true, mag: 30, reserve: 210, reload: 2.4, pellets: 1, hip: 0.04, ads: 0.012, pen: 1, world: 10, kick: 0.022, zoom: 0.8, falloff: [10, 26] }),
  trench: W({ id: 'trench', name: 'Model 1897 Trench', era: 'classic', kind: 'shotgun', price: 1000, ammoPrice: 500, damage: 40, headMult: 1.6, rpm: 75, auto: false, mag: 6, reserve: 48, reload: 3.6, perShell: true, pellets: 9, hip: 0.085, ads: 0.065, pen: 1, world: 12, kick: 0.11, zoom: 0.86, falloff: [5, 14] }),
  kar98k: W({ id: 'kar98k', name: 'Kar98k', era: 'classic', kind: 'sniper', price: 900, ammoPrice: 450, damage: 260, headMult: 3, rpm: 52, auto: false, mag: 5, reserve: 50, reload: 2.8, pellets: 1, hip: 0.05, ads: 0.0015, pen: 4, world: 40, kick: 0.09, zoom: 0.45, falloff: [60, 120] }),
  garand: W({ id: 'garand', name: 'M1 Garand', era: 'classic', kind: 'rifle', price: 1300, ammoPrice: 650, damage: 120, headMult: 2.5, rpm: 320, auto: false, mag: 8, reserve: 96, reload: 2.2, pellets: 1, hip: 0.035, ads: 0.003, pen: 2, world: 22, kick: 0.05, zoom: 0.7, falloff: [40, 90] }),
  mp7: W({ id: 'mp7', name: 'MP5SD', era: 'modern', kind: 'smg', price: 1800, ammoPrice: 900, damage: 58, headMult: 2.5, rpm: 950, auto: true, mag: 40, reserve: 280, reload: 2.0, pellets: 1, hip: 0.034, ads: 0.009, pen: 1, world: 10, kick: 0.016, zoom: 0.8, falloff: [12, 30] }),
  m4a1: W({ id: 'm4a1', name: 'M4A1', era: 'modern', kind: 'rifle', price: 2400, ammoPrice: 1200, damage: 92, headMult: 2.5, rpm: 800, auto: true, mag: 30, reserve: 270, reload: 2.1, pellets: 1, hip: 0.032, ads: 0.004, pen: 2, world: 18, kick: 0.019, zoom: 0.68, falloff: [30, 70] }),
  ak12: W({ id: 'ak12', name: 'AK-12', era: 'modern', kind: 'rifle', price: 2600, ammoPrice: 1300, damage: 105, headMult: 2.5, rpm: 700, auto: true, mag: 30, reserve: 240, reload: 2.3, pellets: 1, hip: 0.036, ads: 0.005, pen: 2, world: 22, kick: 0.026, zoom: 0.68, falloff: [30, 70] }),
  benelli: W({ id: 'benelli', name: 'Benelli M4', era: 'modern', kind: 'shotgun', price: 2200, ammoPrice: 1100, damage: 62, headMult: 1.6, rpm: 300, auto: false, mag: 7, reserve: 63, reload: 3.4, perShell: true, pellets: 9, hip: 0.075, ads: 0.055, pen: 1, world: 14, kick: 0.09, zoom: 0.84, falloff: [6, 16] }),
  m249: W({ id: 'm249', name: 'M249 SAW', era: 'modern', kind: 'lmg', price: 4000, ammoPrice: 2000, damage: 110, headMult: 2, rpm: 780, auto: true, mag: 100, reserve: 400, reload: 4.6, pellets: 1, hip: 0.05, ads: 0.012, pen: 3, world: 26, kick: 0.017, zoom: 0.72, falloff: [30, 70] }),
  barrett: W({ id: 'barrett', name: 'Barrett M82', era: 'modern', kind: 'sniper', price: 5000, ammoPrice: 2500, damage: 1400, headMult: 3, rpm: 110, auto: false, mag: 10, reserve: 40, reload: 3.4, pellets: 1, hip: 0.06, ads: 0.001, pen: 8, world: 220, kick: 0.16, zoom: 0.32, falloff: [80, 160] }),
};

export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];
export const START_WEAPON: WeaponId = 'm1911';

/** Lockers in every map, in the order they are placed around the walls (cheap first, near the spawn). */
export const LOCKER_ORDER: WeaponId[] = ['glock', 'kar98k', 'trench', 'thompson', 'garand', 'mp7', 'benelli', 'm4a1', 'ak12', 'm249', 'barrett'];

export const NADE_PRICE = 400;
export const ARMOR_PRICE = 2000;
/** Ammo locker refills every gun you hold at this share of their own ammo prices. */
export const AMMO_CACHE_SHARE = 1.25;

export const fireInterval = (w: WeaponDef) => 60 / w.rpm;

/** Damage multiplier at distance `d`. */
export function falloffAt(w: WeaponDef, d: number) {
  const [a, b] = w.falloff;
  if (d <= a) return 1;
  if (d >= b) return 0.5;
  return 1 - 0.5 * ((d - a) / (b - a));
}

export const isWeaponId = (v: unknown): v is WeaponId => typeof v === 'string' && v in WEAPONS;
