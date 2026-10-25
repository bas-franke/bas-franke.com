// Zombie navigation: one flow field over the whole map (room and yard), recomputed a few times a second.
//
// The map is cut into 0.5 m cells, aligned with the wall chunks so a wall is exactly one cell thick. Every cell is
// free, blocked (lockers, posts, the boundary), a window (the sill under an opening) or bashable (standing wall or
// prop chunks). A multi-source Dijkstra from every standing player gives each cell its distance to the nearest one;
// a zombie walks to its cheapest neighbour. Boarded windows and bashable cells are passable at a price, so zombies
// head for the windows and tear the boards off, but will break through a wall when that is much shorter, and a hole
// blasted in a wall becomes a free path the moment its chunks are gone.

import type { Vec3 } from '../../shared/math.js';
import { ZB } from '../../shared/zombies/constants.js';
import { forChunks, type World } from '../../shared/zombies/world.js';

export const CELL = 0.5;
export const enum Kind {
  Free = 0,
  Bash = 1,
  Blocked = 2,
  Window = 3,
}

const BASH_COST = 46;
const OPEN_WINDOW_COST = 2;
const BOARD_COST = 1.6;
/** Bodies only collide below this height, so chunks above it do not block a cell. */
const BODY_TOP = 1.75;

export class NavField {
  readonly nx: number;
  readonly nz: number;
  readonly x0: number;
  readonly z0: number;
  readonly kind: Uint8Array;
  /** Window index for window cells, else -1. */
  readonly win: Int8Array;
  readonly dist: Float32Array;
  private readonly heap: Int32Array;
  private readonly heapKey: Float32Array;
  private heapN = 0;
  private dirty = new Set<number>();
  private boards: readonly number[] = [];
  /** Free cells next to a wall or prop (see cost()); refreshed whenever cells change. */
  private near: Uint8Array;
  private nearStale = true;

  constructor(private readonly world: World) {
    const b = world.bounds;
    this.x0 = b.minX;
    this.z0 = b.minZ;
    this.nx = Math.round((b.maxX - b.minX) / CELL);
    this.nz = Math.round((b.maxZ - b.minZ) / CELL);
    const n = this.nx * this.nz;
    this.kind = new Uint8Array(n);
    this.win = new Int8Array(n).fill(-1);
    this.dist = new Float32Array(n).fill(Infinity);
    this.near = new Uint8Array(n);
    this.heap = new Int32Array(n * 8);
    this.heapKey = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) this.classify(i);
    // Window cells: the wall cells under each opening.
    for (const w of world.windows) {
      const along = w.out.x === 0 ? 'x' : 'z';
      for (let k = -1; k <= 1; k++) {
        const x = w.center.x + (along === 'x' ? k * CELL : 0);
        const z = w.center.z + (along === 'z' ? k * CELL : 0);
        const c = this.cellOf(x, z);
        if (c >= 0) {
          // Entrances of a closed wing are walled off for zombies.
          this.kind[c] = w.active ? Kind.Window : Kind.Blocked;
          this.win[c] = w.i;
        }
      }
    }
  }

  cellOf(x: number, z: number) {
    const i = Math.floor((x - this.x0) / CELL);
    const k = Math.floor((z - this.z0) / CELL);
    if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) return -1;
    return i * this.nz + k;
  }

  center(c: number): Vec3 {
    const i = Math.floor(c / this.nz);
    const k = c - i * this.nz;
    return { x: this.x0 + (i + 0.5) * CELL, y: 0, z: this.z0 + (k + 0.5) * CELL };
  }

  private classify(c: number) {
    if (this.kind[c] === Kind.Window) return;
    const i = Math.floor(c / this.nz);
    const k = c - i * this.nz;
    const box = {
      min: { x: this.x0 + i * CELL + 0.03, y: 0.05, z: this.z0 + k * CELL + 0.03 },
      max: { x: this.x0 + (i + 1) * CELL - 0.03, y: BODY_TOP, z: this.z0 + (k + 1) * CELL - 0.03 },
    };
    const w = this.world;
    for (const s of w.solids) {
      if (s.kind === 'clip' || s.kind === 'floor' || s.kind === 'ceiling') continue;
      if (box.min.x < s.max.x && box.max.x > s.min.x && box.min.y < s.max.y && box.max.y > s.min.y && box.min.z < s.max.z && box.max.z > s.min.z) {
        this.kind[c] = Kind.Blocked;
        return;
      }
    }
    let bash = false;
    let hard = false;
    forChunks(w, box, (j) => {
      if (!w.alive[j]) return;
      const ch = w.chunks[j];
      if (box.min.x < ch.max.x && box.max.x > ch.min.x && box.min.y < ch.max.y && box.max.y > ch.min.y && box.min.z < ch.max.z && box.max.z > ch.min.z) {
        if (ch.hard) hard = true;
        else bash = true;
      }
    });
    this.kind[c] = hard ? Kind.Blocked : bash ? Kind.Bash : Kind.Free;
  }

  /** A chunk broke or fell: its cells get re-checked before the next solve. */
  chunkChanged(j: number): boolean {
    const ch = this.world.chunks[j];
    if (ch.min.y >= BODY_TOP) return false;
    for (let x = ch.min.x; x < ch.max.x + CELL - 1e-6; x += CELL)
      for (let z = ch.min.z; z < ch.max.z + CELL - 1e-6; z += CELL) {
        const c = this.cellOf(Math.min(x, ch.max.x - 1e-3), Math.min(z, ch.max.z - 1e-3));
        if (c >= 0) this.dirty.add(c);
      }
    return true;
  }

  /** Chunks standing in a bash cell, below body height. */
  bashChunks(c: number, out: number[]) {
    out.length = 0;
    const i = Math.floor(c / this.nz);
    const k = c - i * this.nz;
    const box = {
      min: { x: this.x0 + i * CELL + 0.03, y: 0.05, z: this.z0 + k * CELL + 0.03 },
      max: { x: this.x0 + (i + 1) * CELL - 0.03, y: BODY_TOP, z: this.z0 + (k + 1) * CELL - 0.03 },
    };
    const w = this.world;
    forChunks(w, box, (j) => {
      const ch = w.chunks[j];
      if (w.alive[j] && !ch.hard && box.min.y < ch.max.y && box.max.y > ch.min.y && box.min.x < ch.max.x && box.max.x > ch.min.x && box.min.z < ch.max.z && box.max.z > ch.min.z) out.push(j);
    });
    return out;
  }

  private cost(c: number, boards: readonly number[]) {
    switch (this.kind[c]) {
      case Kind.Free:
        // Hugging a wall or prop is dearer, so paths keep a body width off corners the zombie would catch on.
        return this.near[c] ? 1.6 : 1;
      case Kind.Bash:
        return BASH_COST;
      case Kind.Window: {
        const b = boards[this.win[c]] ?? 0;
        return b > 0 ? OPEN_WINDOW_COST + 2 + b * BOARD_COST : OPEN_WINDOW_COST;
      }
      default:
        return Infinity;
    }
  }

  /** A free cell with a wall, prop or post on one of its four sides (windows do not count). */
  private nearSolid(c: number) {
    const nz = this.nz;
    const i = Math.floor(c / nz);
    const k = c - i * nz;
    const solid = (n: number) => this.kind[n] === Kind.Bash || this.kind[n] === Kind.Blocked;
    return (i > 0 && solid(c - nz)) || (i < this.nx - 1 && solid(c + nz)) || (k > 0 && solid(c - 1)) || (k < nz - 1 && solid(c + 1));
  }

  /** Recomputes distances from the given points (standing players). */
  solve(sources: readonly Vec3[], boards: readonly number[]) {
    if (this.dirty.size) this.nearStale = true;
    for (const c of this.dirty) this.classify(c);
    this.dirty.clear();
    if (this.nearStale) {
      this.nearStale = false;
      for (let c = 0; c < this.near.length; c++) this.near[c] = this.nearSolid(c) ? 1 : 0;
    }
    this.boards = boards;
    const dist = this.dist;
    dist.fill(Infinity);
    this.heapN = 0;
    for (const s of sources) {
      const c = this.cellOf(s.x, s.z);
      if (c < 0) continue;
      dist[c] = 0;
      this.push(c, 0);
    }
    const nz = this.nz;
    while (this.heapN > 0) {
      const c = this.pop();
      const d = this.popD;
      if (d > dist[c]) continue;
      const i = Math.floor(c / nz);
      const k = c - i * nz;
      const here = this.cost(c, boards);
      if (!Number.isFinite(here)) continue;
      for (let di = -1; di <= 1; di++)
        for (let dk = -1; dk <= 1; dk++) {
          if (!di && !dk) continue;
          const ni = i + di;
          const nk = k + dk;
          if (ni < 0 || nk < 0 || ni >= this.nx || nk >= nz) continue;
          const n = ni * nz + nk;
          const diag = di !== 0 && dk !== 0;
          // Diagonals only between two free cells, so nobody cuts a corner through a wall or a window frame.
          if (diag && (this.kind[n] !== Kind.Free || this.kind[i * nz + nk] !== Kind.Free || this.kind[ni * nz + k] !== Kind.Free)) continue;
          // Leaving a non-free cell costs that cell's price (so the price is paid once, at the obstacle).
          const step = here * (diag ? Math.SQRT2 : 1);
          if (!Number.isFinite(step) || this.kind[n] === Kind.Blocked) continue;
          const nd = d + step;
          if (nd < dist[n]) {
            dist[n] = nd;
            this.push(n, nd);
          }
        }
    }
  }

  /** The neighbour of `c` on the cheapest way to a player (its distance plus the price of stepping into it), or -1. */
  next(c: number): number {
    if (c < 0) return -1;
    const nz = this.nz;
    const i = Math.floor(c / nz);
    const k = c - i * nz;
    let best = -1;
    let bestD = this.dist[c] + 1e-3;
    for (let di = -1; di <= 1; di++)
      for (let dk = -1; dk <= 1; dk++) {
        if (!di && !dk) continue;
        const ni = i + di;
        const nk = k + dk;
        if (ni < 0 || nk < 0 || ni >= this.nx || nk >= nz) continue;
        const n = ni * nz + nk;
        if (di && dk && (this.kind[n] !== Kind.Free || this.kind[i * nz + nk] !== Kind.Free || this.kind[ni * nz + k] !== Kind.Free)) continue;
        const d = this.dist[n] + this.cost(n, this.boards) * (di && dk ? Math.SQRT2 : 1);
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
    return best;
  }

  private push(c: number, d: number) {
    let i = this.heapN++;
    const h = this.heap;
    const key = this.heapKey;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (key[p] <= d) break;
      h[i] = h[p];
      key[i] = key[p];
      i = p;
    }
    h[i] = c;
    key[i] = d;
  }

  /** Key of the cell the last pop() returned (kept in a field so the hot loop allocates nothing). */
  private popD = 0;

  private pop(): number {
    const h = this.heap;
    const key = this.heapKey;
    const top = h[0];
    const topD = key[0];
    const last = h[--this.heapN];
    const lastD = key[this.heapN];
    let i = 0;
    for (;;) {
      let child = i * 2 + 1;
      if (child >= this.heapN) break;
      if (child + 1 < this.heapN && key[child + 1] < key[child]) child++;
      if (key[child] >= lastD) break;
      h[i] = h[child];
      key[i] = key[child];
      i = child;
    }
    h[i] = last;
    key[i] = lastD;
    this.popD = topD;
    return top;
  }
}

export const zombieHalf = ZB.zombieRadius;
