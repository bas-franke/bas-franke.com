// Ruckus tuning. Metres and seconds.

export const RU = {
  dt: 1 / 60,
  loopHz: 30,

  speed: 7,
  accel: 40,
  friction: 12,
  dashSpeed: 16,
  dashTime: 0.18,
  dashCooldown: 1.5,
  gravity: 28,
  radius: 0.45,
  height: 1.1,

  /** How hard a dash shoves a pawn it touches, and plain body contact. */
  dashShove: 9,
  dashLift: 1.8,
  contactShove: 2.5,
  /** Seconds a pawn is stunned (no control, immune to bars) after a sweeper bar hits it. */
  sweepStun: 0.9,

  roundsDefault: 5,
  introSeconds: 4,
  resultsSeconds: 5,
  finalSeconds: 12,
  /** Falling below this height eliminates the pawn. */
  killY: -6,

  placementPoints: [10, 7, 5, 4, 3, 2, 1, 1],
  maxCommandsPerLoop: 6,
} as const;
