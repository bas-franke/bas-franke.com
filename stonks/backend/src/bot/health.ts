/** A running bot ticks every 15 s; this much silence means the loop is stuck. */
export const TICK_STALE_SEC = 120;

/** The verdict of GET /api/health. lastTickAt is also set by a failed tick, so a tick only counts with no error. */
export function healthVerdict(h: { enabled: boolean; database: boolean; lastTickAt: number | null; lastTickError: string | null; uptimeSec: number; now: number }) {
  const ageSec = h.lastTickAt === null ? null : Math.round((h.now - h.lastTickAt) / 1000);
  // No tick yet is only a problem once the process has had time for its first one.
  const stale = (ageSec ?? h.uptimeSec) > TICK_STALE_SEC;
  const lastError = h.lastTickError !== null;
  return {
    status: (h.enabled && stale) || lastError || !h.database ? ('degraded' as const) : ('ok' as const),
    tick: { ageSec, ok: !stale && !lastError },
    lastError,
  };
}
