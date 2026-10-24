// Pod designs (what a racer flies and looks like) and their performance. A pod is two big turbine engines out front,
// tethered by glowing energy binders to a small cockpit behind them, like in the concept art. Designs differ in shape
// parameters and paint; stats differ in thrust, top speed, handling and boost.

export interface PodLivery {
  /** Main hull paint, secondary stripes/panels, small accent details, engine glow and exhaust colour. */
  primary: string;
  secondary: string;
  accent: string;
  glow: string;
}

export interface PodShape {
  /** Engine length and radius (metres). */
  engineLength: number;
  engineRadius: number;
  /** Distance between the two engine centres. */
  engineSpread: number;
  /** Cockpit length and how far behind the engines it trails. */
  cockpitLength: number;
  cockpitTrail: number;
  /** 0 = round intakes, 1 = flattened, wedge-like engines. */
  wedge: number;
  /** Number of fins/vanes per engine (2..4). */
  fins: number;
}

export interface PodStats {
  /** Forward acceleration in m/s² at low speed. */
  thrust: number;
  /** Top speed in m/s without boost. */
  topSpeed: number;
  /** Turn rate (rad/s) and grip (how fast the velocity follows the heading). */
  turn: number;
  grip: number;
  /** Boost meter: seconds of boost when full, and refill per second. */
  boostTime: number;
  boostRefill: number;
}

export interface PodDesign {
  id: string;
  name: string;
  /** One-line description for the garage. */
  blurb: string;
  /** Price in credits (0 = starter). */
  price: number;
  shape: PodShape;
  livery: PodLivery;
  stats: PodStats;
}

export const PODS: PodDesign[] = [
  {
    id: 'ember',
    name: 'Ember',
    blurb: 'Reliable all-rounder. Orange and white, scuffed from a hundred races.',
    price: 0,
    shape: { engineLength: 5.2, engineRadius: 1.05, engineSpread: 5.6, cockpitLength: 2.8, cockpitTrail: 5.2, wedge: 0.15, fins: 3 },
    livery: { primary: '#ece6dc', secondary: '#e8742a', accent: '#2a2a33', glow: '#4fd2ff' },
    stats: { thrust: 34, topSpeed: 100, turn: 1.6, grip: 4.4, boostTime: 3.2, boostRefill: 0.05 },
  },
  {
    id: 'viper',
    name: 'Viper',
    blurb: 'Long purple needles. Brutal top speed, twitchy in the bends.',
    price: 2600,
    shape: { engineLength: 6.4, engineRadius: 0.85, engineSpread: 5.0, cockpitLength: 2.4, cockpitTrail: 6.0, wedge: 0.55, fins: 2 },
    livery: { primary: '#6b2fb3', secondary: '#c9c2d6', accent: '#1d1724', glow: '#d27bff' },
    stats: { thrust: 33, topSpeed: 106, turn: 1.45, grip: 3.7, boostTime: 3.0, boostRefill: 0.05 },
  },
  {
    id: 'gilded',
    name: 'Gilded',
    blurb: 'Fat golden turbines. Huge thrust off the line.',
    price: 3400,
    shape: { engineLength: 4.8, engineRadius: 1.25, engineSpread: 6.0, cockpitLength: 3.0, cockpitTrail: 4.6, wedge: 0.0, fins: 4 },
    livery: { primary: '#d9a93b', secondary: '#3a2b1d', accent: '#f3e3b0', glow: '#ffb347' },
    stats: { thrust: 42, topSpeed: 101, turn: 1.5, grip: 4.5, boostTime: 3.6, boostRefill: 0.055 },
  },
  {
    id: 'tide',
    name: 'Tide',
    blurb: 'Teal racing wedge. Corners like it is on rails.',
    price: 4200,
    shape: { engineLength: 5.6, engineRadius: 0.95, engineSpread: 5.4, cockpitLength: 2.6, cockpitTrail: 5.4, wedge: 0.8, fins: 3 },
    livery: { primary: '#1f8f8a', secondary: '#e9efe9', accent: '#14272a', glow: '#5cf2d6' },
    stats: { thrust: 36, topSpeed: 103, turn: 1.8, grip: 5.4, boostTime: 3.4, boostRefill: 0.06 },
  },
  {
    id: 'crimson',
    name: 'Crimson Comet',
    blurb: 'The champion’s pod. Everything, turned up.',
    price: 7800,
    shape: { engineLength: 6.0, engineRadius: 1.1, engineSpread: 5.8, cockpitLength: 2.9, cockpitTrail: 5.6, wedge: 0.4, fins: 4 },
    livery: { primary: '#c42b2b', secondary: '#f2efe8', accent: '#1a1a1f', glow: '#ff7a4a' },
    stats: { thrust: 41, topSpeed: 107, turn: 1.72, grip: 5.0, boostTime: 4.0, boostRefill: 0.065 },
  },
];

export function podById(id: string): PodDesign {
  return PODS.find((p) => p.id === id) ?? PODS[0];
}

/** Upgrade levels per category, 0..MAX_UPGRADE, bought in the garage. */
export interface Upgrades {
  thrust: number;
  topSpeed: number;
  handling: number;
  boost: number;
}
export const MAX_UPGRADE = 5;
export const NO_UPGRADES: Upgrades = { thrust: 0, topSpeed: 0, handling: 0, boost: 0 };

/** Stats after upgrades: every level adds a few percent. */
export function applyUpgrades(s: PodStats, u: Upgrades): PodStats {
  return {
    thrust: s.thrust * (1 + 0.05 * u.thrust),
    topSpeed: s.topSpeed * (1 + 0.035 * u.topSpeed),
    turn: s.turn * (1 + 0.035 * u.handling),
    grip: s.grip * (1 + 0.06 * u.handling),
    boostTime: s.boostTime * (1 + 0.1 * u.boost),
    boostRefill: s.boostRefill * (1 + 0.1 * u.boost),
  };
}

/** Physics speed (m/s) to the km/h figure the HUD shows: the game is scaled up so it reads like the concept art. */
export const DISPLAY_KMH = 3.6 * 2;
