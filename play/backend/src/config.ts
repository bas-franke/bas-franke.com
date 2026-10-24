const env = process.env;

export const config = {
  port: Number(env.PORT ?? 3004),
  host: env.HOST ?? '127.0.0.1',

  /** Hard cap on simultaneous rooms; each room runs its own simulation loop on the shared EC2 instance. */
  maxRooms: Number(env.MAX_ROOMS ?? 40),
  /** A room with no connected humans is closed after this grace period (survives a page refresh). */
  emptyRoomGraceMs: Number(env.EMPTY_ROOM_GRACE_MS ?? 15_000),
  /** A freshly created room that nobody joins is closed after this long. */
  unclaimedRoomMs: Number(env.UNCLAIMED_ROOM_MS ?? 60_000),
  /** Room creations allowed per IP per minute. */
  createRateLimit: Number(env.CREATE_RATE_LIMIT ?? 10),
  /** Client messages per second per socket before we drop the connection. */
  maxMessagesPerSecond: Number(env.MAX_MESSAGES_PER_SECOND ?? 200),
};
