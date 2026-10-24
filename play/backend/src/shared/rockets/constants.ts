// Rockets tuning. Units are metres and seconds. Started from Quake 3 values (roughly 32 units per metre), then gravity
// was lowered and knockback raised so jumps and rocket jumps carry further across the larger maps.

export const RK = {
  /** Simulation step. Every input command advances a player by exactly one step. */
  dt: 1 / 60,
  /** The server loop runs at this rate and sends one snapshot per loop. */
  loopHz: 30,

  gravity: 18,
  jumpSpeed: 9.2,
  groundSpeed: 9.5,
  groundAccel: 10,
  friction: 6,
  stopSpeed: 3,
  airSpeed: 9.5,
  /** Quake air acceleration, used for forward + strafe (strafe jumping) and for drifting with any key. */
  airAccel: 1.4,
  /** Air acceleration when the keys push against the current motion: a soft brake (about 7.6 m/s^2), so knockback keeps its punch. */
  airStopAccel: 0.8,
  /** Strafe-only extra push (CPM): tiny top speed, huge acceleration, so A/D plus mouse turns sharply in the air. */
  airStrafeSpeed: 0.9,
  airStrafeAccel: 60,
  /** Steering while airborne with only forward or back pressed (CPM-style). Makes rocket jumps controllable. */
  airControl: 5,
  stepHeight: 0.5,

  halfWidth: 0.4,
  height: 1.8,
  eyeHeight: 1.55,
  maxPitch: 1.5,

  maxHealth: 100,
  rocketSpeed: 30,
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
  knockback: 16,
  /** Rocket jumps feel better with a little extra lift. */
  selfKnockbackScale: 1.35,
  /** Minimum upward share of the knockback so ground hits lift players. */
  knockbackLift: 0.25,

  respawnDelay: 2.2,
  spawnProtection: 1.5,
  matchSeconds: 300,
  fragLimit: 15,

  healthPackAmount: 25,
  healthPackRespawn: 20,
  pickupRadius: 1.0,

  /** Falling below this height kills (some maps float over the void, and rocket jumps are creative). */
  killY: -14,
  /** Invisible clip walls around every map reach this high, so nobody rocket-jumps out of the arena. */
  ceiling: 60,
  /** Upper bound on buffered input commands we process per player per loop (anti speed-hack). */
  maxCommandsPerLoop: 6,
} as const;
