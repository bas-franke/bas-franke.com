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
  /** Steering while airborne (CPM-style), strongest with only forward or back pressed. Makes rocket jumps controllable. */
  airControl: 5,
  /** Share of the air control that still applies with a strafe key held. */
  airControlStrafeScale: 0.45,
  stepHeight: 0.5,

  halfWidth: 0.4,
  height: 1.8,
  eyeHeight: 1.55,
  maxPitch: 1.5,

  maxHealth: 100,
  /** Faster than a strafe-jumping player, so nobody simply outruns a rocket; still slow enough to dodge at range. */
  rocketSpeed: 34,
  rocketRadius: 0.2,
  rocketLife: 6,
  fireInterval: 0.75,
  /** Rocket spawns this far in front of the eyes so it does not hit the shooter. */
  muzzleOffset: 0.9,
  splashRadius: 3.8,
  /** Kept below directDamage so a hit on the body always beats a shot at the feet. */
  splashDamage: 80,
  /** A full-health player survives one direct hit (like Quake's 125 spawn health): two rockets, or one plus splash. */
  directDamage: 85,
  /** Direct hit on a target at least airshotHeight above the ground (higher than a plain jump): always a kill. */
  airshotDamage: 100,
  airshotHeight: 2.5,
  /** Your own rockets never hurt you: rocket jumps and point-blank shots only cost you the knockback. */
  selfDamageScale: 0,
  /** Velocity added at the centre of the blast for a full-damage hit. */
  knockback: 13,
  /** Rocket jumps feel better with a little extra lift: a jump plus a rocket at the feet climbs about 15 m. */
  selfKnockbackScale: 1.2,
  /** Minimum upward share of the knockback so ground hits lift players. */
  knockbackLift: 0.2,

  /** A fall into the void within this many seconds of being hit is a frag for the shooter, not a suicide. */
  fallCreditSeconds: 4,
  respawnDelay: 2.2,
  spawnProtection: 1.5,
  /** @deprecated The clock is per mode: MODES[mode].seconds in modes.ts (this mirrors free for all). */
  matchSeconds: 420,
  /** @deprecated The goal is per mode: MODES[mode].limit in modes.ts (this mirrors free for all). */
  fragLimit: 25,

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
