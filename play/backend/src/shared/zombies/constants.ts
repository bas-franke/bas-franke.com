// Last Light tuning. Units are metres and seconds. Movement is deliberately heavier than Rockets: no bunny hopping,
// a short jump, and a sprint that is only a little faster than the walk, so the room feels claustrophobic.

export const ZB = {
  /** Simulation step. Every input command advances a player by exactly one step. */
  dt: 1 / 60,
  /** The server loop runs at this rate and sends one snapshot per loop. */
  loopHz: 30,

  gravity: 17,
  jumpSpeed: 5.2,
  walkSpeed: 4.2,
  sprintSpeed: 6.3,
  adsSpeed: 2.4,
  crawlSpeed: 0.9,
  groundAccel: 34,
  airAccel: 5,
  stepHeight: 0.42,

  halfWidth: 0.3,
  height: 1.8,
  eyeHeight: 1.62,
  downedEye: 0.55,
  maxPitch: 1.5,

  maxHealth: 100,
  /** Health comes back after this many seconds without being hit. */
  regenDelay: 4,
  regenRate: 45,
  /** Armor vest: absorbs this share of every hit until it is gone. */
  armorMax: 100,
  armorShare: 0.6,

  startPoints: 500,
  pointsHit: 10,
  pointsKill: 60,
  pointsHead: 100,
  pointsKnife: 130,
  pointsBoard: 10,
  /** Board repairs pay out at most this many points per wave per player (CoD's cap). */
  boardPointsCap: 100,
  pointsRevive: 100,

  /** Seconds a downed player has before bleeding out, and to revive one. */
  bleedOut: 30,
  reviveTime: 3,
  useRange: 1.8,
  /** Seconds per board repaired while holding the use key. */
  repairTime: 0.85,

  boardsPerWindow: 6,
  /** Seconds a zombie needs to pull one board. */
  tearTime: 1.35,
  vaultTime: 1.3,
  riseTime: 1.6,

  zombieRadius: 0.28,
  zombieHeadY: 1.58,
  zombieHeadR: 0.15,
  zombieBodyR: 0.3,
  zombieBodyH: 1.45,
  zombieReach: 1.05,
  zombieDamage: 34,
  zombieWindup: 0.55,
  zombieAttackCd: 1.25,
  /** Damage per second a zombie bashing through a wall deals to the chunks in front of it. */
  bashDps: 30,
  maxZombiesAlive: 32,

  waveBreak: 10,
  firstWaveDelay: 6,

  knifeDamage: 150,
  knifeRange: 1.6,
  knifeCooldown: 0.65,

  nadeMax: 4,
  nadeFuse: 2.4,
  nadeSpeed: 15,
  nadeRadius: 4.6,
  nadeDamage: 520,
  /** Chunk damage at the centre of a grenade blast. */
  nadeWorldDamage: 360,
  nadeSelfDamage: 35,

  /** How far back the server rewinds zombies to the shooter's view (seconds). */
  maxRewind: 0.25,
  maxCommandsPerLoop: 6,
  killY: -10,
} as const;

/** Zombies in wave `n` for a party of `players` (CoD-like growth, more for bigger parties). */
export function waveCount(n: number, players: number) {
  const base = n < 10 ? [6, 8, 13, 18, 24, 27, 28, 28, 29][n - 1] : Math.round(0.09 * n * n + 0.0029 * n * n * n + 18);
  return Math.round(base * (0.55 + 0.45 * Math.max(1, players)));
}

/** Zombie health in wave `n`: +100 a wave up to 9, then +10% a wave. */
export function waveHealth(n: number) {
  return n < 10 ? 150 + 100 * (n - 1) : Math.round(950 * Math.pow(1.1, n - 9));
}

/** Seconds between two zombies rising, one by one. */
export const spawnInterval = (n: number, players: number) => Math.max(0.45, (2.6 - n * 0.12) / (0.7 + 0.3 * Math.max(1, players)));

/** Share of a wave that shambles faster (still not a sprint). */
export const joggerShare = (n: number) => (n < 6 ? 0 : Math.min(0.45, (n - 5) * 0.06));
