// Rockets tuning. Units are metres and seconds; the numbers are Quake 3 values converted at roughly 32 units per metre.

export const RK = {
  /** Simulation step. Every input command advances a player by exactly one step. */
  dt: 1 / 60,
  /** The server loop runs at this rate and sends one snapshot per loop. */
  loopHz: 30,

  gravity: 25,
  jumpSpeed: 8.6,
  groundSpeed: 9.5,
  groundAccel: 10,
  friction: 6,
  stopSpeed: 3,
  airSpeed: 9.5,
  airAccel: 1.2,
  /** Extra steering while airborne with only forward pressed (CPM-style). Makes rocket jumps controllable. */
  airControl: 2.6,
  stepHeight: 0.5,

  halfWidth: 0.4,
  height: 1.8,
  eyeHeight: 1.55,
  maxPitch: 1.5,

  maxHealth: 100,
  rocketSpeed: 28,
  rocketRadius: 0.2,
  rocketLife: 6,
  fireInterval: 0.75,
  /** Rocket spawns this far in front of the eyes so it does not hit the shooter. */
  muzzleOffset: 0.9,
  splashRadius: 3.8,
  splashDamage: 90,
  directDamage: 100,
  selfDamageScale: 0.4,
  /** Velocity added at the centre of the blast for a full-damage hit. */
  knockback: 14,
  /** Rocket jumps feel better with a little extra lift. */
  selfKnockbackScale: 1.2,
  /** Minimum upward share of the knockback so ground hits lift players. */
  knockbackLift: 0.25,

  respawnDelay: 2.2,
  spawnProtection: 1.5,
  matchSeconds: 300,
  fragLimit: 15,

  healthPackAmount: 25,
  healthPackRespawn: 20,
  pickupRadius: 1.0,

  /** Falling below this height kills (the arena is walled, but rocket jumps are creative). */
  killY: -12,
  /** Upper bound on buffered input commands we process per player per loop (anti speed-hack). */
  maxCommandsPerLoop: 6,
} as const;
