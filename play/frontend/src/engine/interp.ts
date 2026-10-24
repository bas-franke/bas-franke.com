// Snapshot interpolation: remote entities are rendered a little in the past, between two received snapshots.

export const INTERP_DELAY = 0.1;

export interface Stamped<T> {
  at: number;
  snap: T;
}

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

export const lerpAngle = (a: number, b: number, t: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/** Exponential approach, frame-rate independent. */
export const damp = (current: number, target: number, lambda: number, dt: number) => current + (target - current) * (1 - Math.exp(-lambda * dt));
