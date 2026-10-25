// Garden Sentinels towers: five kinds, three levels each. The server simulation reads every number from here; the
// client shows the same numbers in the build cards, the tower panel and the range circles.

export type TowerKind = 'laser' | 'shield' | 'slow' | 'missile' | 'beacon' | 'sprinkler';
export const TOWER_KINDS: TowerKind[] = ['laser', 'shield', 'slow', 'missile', 'beacon', 'sprinkler'];
export const isTowerKind = (k: unknown): k is TowerKind => typeof k === 'string' && (TOWER_KINDS as string[]).includes(k);

export type Level = 1 | 2 | 3;

/** Targeting priority of an attacking tower. */
export const TARGET_MODES = ['first', 'last', 'strong', 'close'] as const;
export type TargetMode = 0 | 1 | 2 | 3;

export interface TowerLevel {
  /** Gold to build (level 1) or to upgrade to this level. */
  cost: number;
  /** Metres from the tower centre. For shield / slow / beacon it is the radius of the field or aura. */
  range: number;
  /** Laser: damage per second. Shield, slow: damage per second to enemies inside. Missile: damage per missile. */
  dmg: number;
  /** Missile: seconds between volleys. */
  interval?: number;
  /** Missile: missiles per volley. Laser: extra targets the beam chains to. */
  count?: number;
  /** Missile: splash radius (m). */
  splash?: number;
  /** Slow: speed multiplier taken off (0.3 = 30% slower). */
  slow?: number;
  /** Beacon: damage and fire-rate bonus for towers in range. */
  buffDmg?: number;
  buffRate?: number;
  /** Beacon level 3: range bonus. */
  buffRange?: number;
  /** Shield level 3: a blocked disruption stuns the disruptor for this long (s). */
  reflect?: number;
  /** Sprinkler: enemies hit are soaked, slowed by this share for `soakTime` seconds (strongest slow applies). */
  soak?: number;
  soakTime?: number;
}

export interface TowerDef {
  kind: TowerKind;
  name: string;
  blurb: string;
  /** Hotkey on the build bar. */
  key: string;
  /** Share of an enemy's armour this tower ignores (0 = armour applies fully, 1 = ignores it). */
  pierce: number;
  /** Whether it picks targets (shows the targeting selector). */
  targets: boolean;
  /** Whether it can hit flying enemies (Glow Moths fly over the garden, not along the paths). */
  air: boolean;
  levels: [TowerLevel, TowerLevel, TowerLevel];
  /** Short per-level notes for the upgrade panel. */
  notes: [string, string, string];
}

export const TOWERS: Record<TowerKind, TowerDef> = {
  laser: {
    kind: 'laser',
    name: 'Laser Turret',
    blurb: 'Precise, continuous energy beam.',
    key: '1',
    pierce: 1,
    targets: true,
    air: true,
    levels: [
      { cost: 100, range: 7, dmg: 22 },
      { cost: 130, range: 8, dmg: 48 },
      { cost: 260, range: 9, dmg: 95, count: 2 },
    ],
    notes: ['Steady beam on one target; ignores armour.', 'Hotter beam, longer reach.', 'Beam chains to two more enemies (half damage).'],
  },
  shield: {
    kind: 'shield',
    name: 'Bubble Shield',
    blurb: 'Projects a protective shield bubble.',
    key: '2',
    pierce: 1,
    targets: false,
    air: true,
    levels: [
      { cost: 90, range: 5, dmg: 8 },
      { cost: 110, range: 6, dmg: 16 },
      { cost: 200, range: 7, dmg: 30, reflect: 1.5 },
    ],
    notes: ['Towers inside cannot be disrupted; zaps enemies inside.', 'Bigger bubble, stronger zap.', 'Blocked disruptions stun the disruptor.'],
  },
  slow: {
    kind: 'slow',
    name: 'Slow Flower',
    blurb: 'Emits a field that slows enemies.',
    key: '3',
    pierce: 1,
    targets: false,
    air: false,
    levels: [
      { cost: 80, range: 5, dmg: 2, slow: 0.3 },
      { cost: 100, range: 6, dmg: 4, slow: 0.4 },
      { cost: 180, range: 7, dmg: 8, slow: 0.5 },
    ],
    notes: ['Slows everything in its field by 30%.', '40% slow, wider field.', '50% slow and a stinging pollen.'],
  },
  missile: {
    kind: 'missile',
    name: 'Missile Pod',
    blurb: 'Launches explosive seeking missiles.',
    key: '4',
    pierce: 0,
    targets: true,
    air: true,
    levels: [
      { cost: 150, range: 9, dmg: 40, interval: 1.8, count: 1, splash: 1.6 },
      { cost: 170, range: 10, dmg: 60, interval: 1.6, count: 2, splash: 2 },
      { cost: 320, range: 12, dmg: 80, interval: 1.4, count: 3, splash: 2.6 },
    ],
    notes: ['Splash damage; weak against armour.', 'Two missiles per volley.', 'Three missiles, bigger blasts.'],
  },
  beacon: {
    kind: 'beacon',
    name: 'Energy Beacon',
    blurb: 'Provides aura buffs to nearby towers.',
    key: '5',
    pierce: 0,
    targets: false,
    air: false,
    levels: [
      { cost: 140, range: 4.5, dmg: 0, buffDmg: 0.15, buffRate: 0.1 },
      { cost: 170, range: 5.5, dmg: 0, buffDmg: 0.2, buffRate: 0.15 },
      { cost: 300, range: 6.5, dmg: 0, buffDmg: 0.3, buffRate: 0.2, buffRange: 0.1 },
    ],
    notes: ['+15% damage, +10% fire rate nearby.', '+20% damage, +15% fire rate.', '+30% damage, +20% rate, +10% range.'],
  },
  sprinkler: {
    kind: 'sprinkler',
    name: 'Sprinkler Cannon',
    blurb: 'Lobs water bombs that splash and soak.',
    key: '6',
    pierce: 0.5,
    targets: true,
    air: false,
    levels: [
      { cost: 120, range: 8, dmg: 18, interval: 1.2, count: 1, splash: 2, soak: 0.25, soakTime: 2 },
      { cost: 140, range: 9, dmg: 30, interval: 1.0, count: 1, splash: 2.4, soak: 0.3, soakTime: 2.5 },
      { cost: 240, range: 10, dmg: 50, interval: 0.8, count: 2, splash: 2.8, soak: 0.4, soakTime: 3 },
    ],
    notes: ['Splashing water bombs slow what they soak. Cannot hit flyers.', 'Bigger splash, longer soak.', 'Twin bombs, a 40% soak.'],
  },
};

/** Gold spent on a tower up to and including `lv`. */
export const spentUpTo = (k: TowerKind, lv: Level) => TOWERS[k].levels.slice(0, lv).reduce((s, l) => s + l.cost, 0);
