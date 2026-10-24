// Snapshot interpolation: remote entities are rendered a little in the past, between two received snapshots.

export const INTERP_DELAY = 0.1;

export interface Stamped<T> {
  at: number;
  snap: T;
}

/**
 * Simple buffer keyed by arrival time. Network jitter and bursts show up directly as stutter, so prefer
 * `SnapshotTimeline` for anything moving fast.
 */
export class SnapshotBuffer<T> {
  private readonly buf: Stamped<T>[] = [];

  push(snap: T, at = performance.now() / 1000) {
    this.buf.push({ at, snap });
    if (this.buf.length > 60) this.buf.splice(0, this.buf.length - 60);
  }

  get latest(): T | undefined {
    return this.buf[this.buf.length - 1]?.snap;
  }

  get latestAt(): number {
    return this.buf[this.buf.length - 1]?.at ?? 0;
  }

  /** The pair of snapshots around `renderTime` and the blend factor between them. */
  sample(renderTime: number): { a: T; b: T; alpha: number } | null {
    const buf = this.buf;
    if (!buf.length) return null;
    if (renderTime >= buf[buf.length - 1].at) {
      const last = buf[buf.length - 1].snap;
      return { a: last, b: last, alpha: 0 };
    }
    for (let i = buf.length - 2; i >= 0; i--) {
      if (buf[i].at <= renderTime) {
        const a = buf[i];
        const b = buf[i + 1];
        const span = b.at - a.at;
        return { a: a.snap, b: b.snap, alpha: span > 0 ? (renderTime - a.at) / span : 0 };
      }
    }
    const first = buf[0].snap;
    return { a: first, b: first, alpha: 0 };
  }

  /** Drop everything older than `seconds` before the newest. */
  trim(seconds = 1) {
    const cutoff = this.latestAt - seconds;
    while (this.buf.length > 2 && this.buf[0].at < cutoff) this.buf.shift();
  }
}

/** Seconds of history the clock-offset minimum is taken over. Short enough to follow a server hitch. */
const OFFSET_WINDOW = 1.5;
/** Never extrapolate remote entities further than this past the newest snapshot. */
const MAX_EXTRAPOLATION = 0.1;
/** Packets the jitter percentile is taken over (about 4 s at 30 Hz), and which percentile has to arrive in time. */
const JITTER_SAMPLES = 120;
const JITTER_PERCENTILE = 0.9;
/** Assumed until real packets have been measured. */
const DEFAULT_JITTER = 0.04;

/**
 * Snapshots keyed by SERVER time (the simulation time they describe), played back on a smooth local clock.
 *
 * - The server-to-local clock offset is the minimum of (arrival - server time) over a short window: the least
 *   delayed packet is the best estimate of the true offset; everything above it is jitter.
 * - The interpolation delay adapts to the measured jitter (one snapshot interval plus the 90th percentile of the
 *   extra delay over the last few seconds), so a clean link renders closer to the present and a jittery one stops starving the buffer.
 * - The playback clock runs at real-time speed and is nudged by at most 10% toward its target, so offset or delay
 *   changes never show as a jump. Big gaps (hidden tab, new match) snap it.
 * - Bursts (several snapshots in one millisecond) cost nothing: their arrival time is only used for statistics.
 */
export class SnapshotTimeline<T> {
  private readonly buf: Stamped<T>[] = [];
  /** local seconds - server seconds, for the least delayed recent packet. */
  private offset = NaN;
  private winMin = Infinity;
  private prevMin = Infinity;
  private winStart = 0;
  /** Recent delays above `offset` (ring buffer) and a scratch copy for the percentile. */
  private readonly extra = new Float64Array(JITTER_SAMPLES).fill(DEFAULT_JITTER);
  private readonly sorted = new Float64Array(JITTER_SAMPLES);
  private extraNext = 0;
  /** The JITTER_PERCENTILE of `extra`. */
  private jitter = DEFAULT_JITTER;
  /** Server-time spacing between snapshots. */
  private interval = 1 / 30;
  private clock = NaN;
  private lastNow = NaN;
  /** Current interpolation delay in seconds (adaptive). */
  delay = 0.12;
  /** local - server time as seen by the playback clock; changes slowly, unlike `offset`. */
  private smoothOffset = NaN;

  constructor(
    private readonly minDelay = 0.05,
    private readonly maxDelay = 0.25,
  ) {}

  /** `serverTime` in seconds: the moment of the simulation the snapshot shows (tick * dt). */
  push(snap: T, serverTime: number, arrival = performance.now() / 1000) {
    const buf = this.buf;
    const last = buf[buf.length - 1];
    if (last) {
      // Time went backwards by a lot: a new match (tick restarted). Start over.
      if (serverTime < last.at - 1) this.reset();
      // Duplicate or stale: WebSocket keeps order, so this only happens around a reset.
      else if (serverTime <= last.at) return;
      else this.interval += (Math.min(0.25, serverTime - last.at) - this.interval) * 0.1;
    }
    buf.push({ at: serverTime, snap });
    if (buf.length > 90) buf.splice(0, buf.length - 90);

    const d = arrival - serverTime;
    if (arrival - this.winStart > OFFSET_WINDOW) {
      this.prevMin = this.winMin;
      this.winMin = Infinity;
      this.winStart = arrival;
    }
    if (d < this.winMin) this.winMin = d;
    const first = Number.isNaN(this.offset);
    this.offset = Math.min(this.winMin, this.prevMin);
    if (first) return;
    this.extra[this.extraNext] = Math.max(0, d - this.offset);
    this.extraNext = (this.extraNext + 1) % JITTER_SAMPLES;
    // A percentile, not a mean: the odd retransmit stall should not drag the delay up for everyone.
    this.sorted.set(this.extra);
    this.sorted.sort();
    this.jitter = this.sorted[Math.floor(JITTER_SAMPLES * JITTER_PERCENTILE)];
  }

  /** The delay the jitter statistics ask for. */
  get targetDelay() {
    const want = this.interval + this.jitter + 0.01;
    return Math.min(this.maxDelay, Math.max(this.minDelay, want));
  }

  /** Server time currently being rendered (valid after the first `sample`). */
  get renderTime() {
    return this.clock;
  }

  /** Local time (performance.now() seconds) at which `serverTime` would have arrived on a jitter-free link. */
  toLocal(serverTime: number) {
    return serverTime + (Number.isNaN(this.smoothOffset) ? this.offset : this.smoothOffset);
  }

  /** Advance the playback clock to local time `now` (seconds) and return the snapshots around it. */
  sample(now: number): { a: T; b: T; alpha: number } | null {
    const buf = this.buf;
    if (!buf.length) return null;
    const dt = Number.isNaN(this.lastNow) ? 0 : Math.max(0, now - this.lastNow);
    this.lastNow = now;

    // The delay grows quickly when the link gets worse and shrinks slowly when it calms down.
    const want = this.targetDelay;
    this.delay += (want - this.delay) * (1 - Math.exp(-(want > this.delay ? 1.5 : 0.4) * dt));

    const target = now - this.offset - this.delay;
    if (Number.isNaN(this.clock)) this.clock = target;
    else {
      this.clock += dt;
      const err = target - this.clock;
      if (Math.abs(err) > 0.25) this.clock = target;
      else this.clock += Math.max(-0.1 * dt, Math.min(0.1 * dt, err * 2 * dt));
    }
    this.smoothOffset = now - this.clock - this.delay;

    const t = this.clock;
    const n = buf.length;
    if (t >= buf[n - 1].at) {
      // Starved: carry on along the last motion for a moment rather than freezing, then hold.
      if (n >= 2) {
        const a = buf[n - 2];
        const b = buf[n - 1];
        const span = b.at - a.at;
        if (span > 0 && span < 0.25) return { a: a.snap, b: b.snap, alpha: 1 + Math.min(t - b.at, MAX_EXTRAPOLATION) / span };
      }
      return { a: buf[n - 1].snap, b: buf[n - 1].snap, alpha: 0 };
    }
    for (let i = n - 2; i >= 0; i--) {
      if (buf[i].at <= t) {
        const a = buf[i];
        const b = buf[i + 1];
        return { a: a.snap, b: b.snap, alpha: (t - a.at) / (b.at - a.at) };
      }
    }
    return { a: buf[0].snap, b: buf[0].snap, alpha: 0 };
  }

  /** Drop snapshots more than `seconds` older than the one being rendered (always keeps the pair in use). */
  trim(seconds = 1) {
    const cutoff = (Number.isNaN(this.clock) ? (this.buf[this.buf.length - 1]?.at ?? 0) : this.clock) - seconds;
    while (this.buf.length > 2 && this.buf[1].at < cutoff) this.buf.shift();
  }

  /** Forget everything, e.g. when a new match starts. */
  reset() {
    this.buf.length = 0;
    this.offset = NaN;
    this.winMin = this.prevMin = Infinity;
    this.winStart = 0;
    this.clock = NaN;
    this.smoothOffset = NaN;
    this.extra.fill(DEFAULT_JITTER);
    this.extraNext = 0;
  }
}

export const lerpAngle = (a: number, b: number, t: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/** Exponential approach, frame-rate independent. */
export const damp = (current: number, target: number, lambda: number, dt: number) => current + (target - current) * (1 - Math.exp(-lambda * dt));
