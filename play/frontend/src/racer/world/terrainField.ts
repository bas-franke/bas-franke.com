// The terrain's height function. Everything is laid out relative to the nearest point of the track: loose ground that
// follows the road's elevation (and its banking right next to it), canyon walls at zones.wallOffset with a plateau on
// top of them, open desert with distant flat-topped buttes further out, and a chasm under each gorge bridge with rock
// blocks the waterfalls pour from. The ground ribbon beside the road and the cliff strips use the same functions, so
// the heightfield (which sits under them, pushed down where they cover it) meets them without seams.

import * as THREE from 'three';
import type { Track } from '../core/track';
import { fbm2, hash, noise1, noise2, smoothstep } from './terrainNoise';
import type { Zones } from './zones';

export interface Fall {
  x: number;
  z: number;
  topY: number;
  width: number;
  /** Horizontal unit direction away from the bridge (behind the fall). */
  ux: number;
  uz: number;
  dist: number;
}

export interface Gorge {
  s0: number;
  s1: number;
  depth: number;
  /** Centre of the crossing and its horizontal axes: a along the track, d across it (the chasm runs along d). */
  mx: number;
  my: number;
  mz: number;
  ax: number;
  az: number;
  rx: number;
  rz: number;
  /** Track-column indices of the last solid column before and the first after the chasm, and their a coordinates. */
  edge0: number;
  edge1: number;
  a0: number;
  a1: number;
  floorY: number;
  /** Half length of the chasm along d. */
  reach: number;
  /** Depth of rock behind each chasm edge face. */
  back: number;
  falls: Fall[];
}

const lerp = THREE.MathUtils.lerp;

export class TerrainField {
  readonly n: number;
  readonly posX: Float32Array;
  readonly posY: Float32Array;
  readonly posZ: Float32Array;
  /** Horizontal unit tangent and right vectors per frame. */
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  readonly rx: Float32Array;
  readonly rz: Float32Array;
  /** Road height change per metre to the right (banking). */
  readonly slope: Float32Array;
  /** Where the loose ground starts (just under the shoulder's outer edge), horizontal distance from the centre. */
  readonly x0: Float32Array;
  /** Per side (0 = left, 1 = right): wall foot distance (Infinity = open), crest height (world y), end of the ground
   * ribbon, plateau depth. */
  readonly W: [Float32Array, Float32Array];
  readonly crest: [Float32Array, Float32Array];
  readonly dEnd: [Float32Array, Float32Array];
  readonly plat: [Float32Array, Float32Array];
  readonly gorges: Gorge[] = [];
  readonly baseY: number;
  /** Depth of the canyon-wall rock behind the wall foot (where the plateau starts). */
  readonly back = 30;
  readonly area: THREE.Box2;

  private gx0: number;
  private gz0: number;
  private gc = 16;
  private gnx: number;
  private gnz: number;
  private near: Int32Array;
  private city: Zones['city'];
  /** Results of the last nearest() call. */
  qi = 0;
  qd = 0;
  /** Rockiness of the last height() sample (aRock attribute). */
  rock = 0;

  constructor(readonly track: Track, readonly zones: Zones, stride: number, margin: number) {
    const fr = track.frames;
    const n = (this.n = fr.length);
    const mk = () => new Float32Array(n);
    this.posX = mk();
    this.posY = mk();
    this.posZ = mk();
    this.tx = mk();
    this.tz = mk();
    this.rx = mk();
    this.rz = mk();
    this.slope = mk();
    this.x0 = mk();
    this.W = [mk(), mk()];
    this.crest = [mk(), mk()];
    this.dEnd = [mk(), mk()];
    this.plat = [mk(), mk()];
    this.city = zones.city;
    let sumY = 0;
    const arch = zones.arch;
    for (let i = 0; i < n; i++) {
      const f = fr[i];
      this.posX[i] = f.pos.x;
      this.posY[i] = f.pos.y;
      this.posZ[i] = f.pos.z;
      sumY += f.pos.y;
      const tl = Math.hypot(f.tangent.x, f.tangent.z);
      this.tx[i] = f.tangent.x / tl;
      this.tz[i] = f.tangent.z / tl;
      // Right of the direction of travel, flat: tangent x up.
      this.rx[i] = -this.tz[i];
      this.rz[i] = this.tx[i];
      const rh = Math.hypot(f.right.x, f.right.z);
      this.slope[i] = f.right.y / rh;
      this.x0[i] = (f.width / 2 + 2) * rh - 0.8;
      for (const si of [0, 1] as const) {
        const side = si === 0 ? -1 : 1;
        let W = zones.wallOffset(f.s, side);
        let H = zones.wallHeight(f.s, side);
        if (arch) {
          // Keep the canyon low around the arch so it stands against the sky.
          const d = Math.abs(f.s - arch.s);
          const k = 1 - smoothstep(50, 160, d);
          H = lerp(H, Math.min(H, arch.height * 0.45), k);
        }
        const inner = side * f.kappa > 0 ? 0 : 1; // kappa > 0 turns left: the left side is the inside
        const rMax = inner === 0 && Math.abs(f.kappa) > 1e-4 ? 0.8 / Math.abs(f.kappa) : Infinity;
        if (Number.isFinite(W) && W + this.back > rMax) W = Math.max(f.width / 2 + 8, rMax - this.back);
        this.W[si][i] = W;
        // Crest: smooth undulation plus blocky steps (towers and notches along the rim).
        const u = f.s / 45 + noise1(f.s * 0.01, si + 11) * 1.5;
        const cell = Math.floor(u);
        const fu = u - cell;
        const block = (hash(cell * 3.7 + si * 19) - 0.45) * 14 * smoothstep(0.05, 0.15, fu) * (1 - smoothstep(0.85, 0.95, fu));
        this.crest[si][i] = f.pos.y + H + ((noise1(f.s * 0.015, si * 7 + 1) - 0.5) * 8 + block) * Math.min(1, H / 30);
        this.dEnd[si][i] = Number.isFinite(W) ? W + 4 : Math.min(110, rMax);
        this.plat[si][i] = 80 + 170 * noise1(f.s * 0.005, si * 5 + 2);
      }
    }
    this.baseY = sumY / n - 4;

    // Coarse nearest-frame grid over the whole area (brute force on every 4th frame, then refined).
    const b = track.bounds;
    this.area = new THREE.Box2(new THREE.Vector2(b.min.x - margin, b.min.z - margin), new THREE.Vector2(b.max.x + margin, b.max.z + margin));
    this.gx0 = this.area.min.x;
    this.gz0 = this.area.min.y;
    this.gnx = Math.ceil((this.area.max.x - this.area.min.x) / this.gc) + 1;
    this.gnz = Math.ceil((this.area.max.y - this.area.min.y) / this.gc) + 1;
    this.near = new Int32Array(this.gnx * this.gnz);
    for (let cz = 0; cz < this.gnz; cz++) {
      const z = this.gz0 + cz * this.gc;
      for (let cx = 0; cx < this.gnx; cx++) {
        const x = this.gx0 + cx * this.gc;
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i < n; i += 4) {
          const dx = this.posX[i] - x;
          const dz = this.posZ[i] - z;
          const d = dx * dx + dz * dz;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        this.near[cz * this.gnx + cx] = this.refine(x, z, best, 4);
      }
    }

    this.buildGorges(stride);
  }

  private refine(x: number, z: number, i0: number, r: number) {
    const n = this.n;
    let best = i0;
    let bd = Infinity;
    for (let k = -r; k <= r; k++) {
      const i = Math.max(0, Math.min(n - 1, i0 + k));
      const dx = this.posX[i] - x;
      const dz = this.posZ[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  /** Nearest frame to (x, z): sets qi (frame index) and qd (signed horizontal lateral distance, + = right). */
  nearest(x: number, z: number) {
    const cx = Math.min(this.gnx - 1, Math.max(0, Math.round((x - this.gx0) / this.gc)));
    const cz = Math.min(this.gnz - 1, Math.max(0, Math.round((z - this.gz0) / this.gc)));
    const i = this.refine(x, z, this.near[cz * this.gnx + cx], 8);
    this.qi = i;
    this.qd = (x - this.posX[i]) * this.rx[i] + (z - this.posZ[i]) * this.rz[i];
  }

  private buildGorges(stride: number) {
    const { track, zones } = this;
    const n = this.n;
    for (const g of zones.gorges) {
      const inG = (i: number) => {
        const s = track.frames[Math.min(n - 1, i)].s;
        return s >= g.s0 && s < g.s1;
      };
      let edge0 = -1;
      let edge1 = -1;
      for (let c = 0; c < n; c += stride) {
        const next = Math.min(n - 1, c + stride);
        if (!inG(c) && inG(next)) edge0 = c;
        if (inG(c) && !inG(next)) edge1 = next;
      }
      if (edge0 < 0 || edge1 < 0) continue;
      const midS = (g.s0 + g.s1) / 2;
      const mf = track.frameAt(midS);
      const tl = Math.hypot(mf.tangent.x, mf.tangent.z);
      const ax = mf.tangent.x / tl;
      const az = mf.tangent.z / tl;
      const gg: Gorge = {
        s0: g.s0,
        s1: g.s1,
        depth: g.depth,
        mx: mf.pos.x,
        my: mf.pos.y,
        mz: mf.pos.z,
        ax,
        az,
        rx: -az,
        rz: ax,
        edge0,
        edge1,
        a0: 0,
        a1: 0,
        floorY: mf.pos.y - g.depth - 2,
        reach: 560,
        back: 16,
        falls: [],
      };
      gg.a0 = (this.posX[edge0] - gg.mx) * ax + (this.posZ[edge0] - gg.mz) * az;
      gg.a1 = (this.posX[edge1] - gg.mx) * ax + (this.posZ[edge1] - gg.mz) * az;
      for (const w of zones.waterfalls) {
        const a = (w.top.x - gg.mx) * ax + (w.top.z - gg.mz) * az;
        const d = (w.top.x - gg.mx) * gg.rx + (w.top.z - gg.mz) * gg.rz;
        if (Math.abs(a) > 200 || Math.abs(d) > gg.reach) continue;
        const fl = Math.hypot(w.facing.x, w.facing.z) || 1;
        gg.falls.push({ x: w.top.x, z: w.top.z, topY: w.top.y, width: w.width, ux: -w.facing.x / fl, uz: -w.facing.z / fl, dist: Math.abs(d) });
      }
      this.gorges.push(gg);
    }
  }

  /** Gorge whose chasm the track frame i crosses (strictly inside the edge columns), or null. */
  gorgeAtFrame(i: number): Gorge | null {
    const s = this.track.frames[i].s;
    for (const g of this.gorges) {
      const s0 = this.track.frames[g.edge0].s;
      const s1 = this.track.frames[g.edge1].s;
      if (s > s0 && s < s1) return g;
    }
    return null;
  }

  desert(x: number, z: number) {
    return this.baseY + (fbm2(x * 0.003, z * 0.003, 3) - 0.5) * 16 + (noise2(x * 0.025, z * 0.025) - 0.5) * 2.5;
  }

  /** Flat-topped buttes scattered over the far desert (height above the desert floor, 0 almost everywhere). */
  mesas(x: number, z: number) {
    const m = fbm2(x * 0.0021 + 7.3, z * 0.0021 - 3.1, 3);
    if (m < 0.57) return 0;
    const top = 45 + 110 * noise2(x * 0.0011 + 3, z * 0.0011 - 5);
    return smoothstep(0.57, 0.6, m) * top * 0.7 + smoothstep(0.62, 0.64, m) * top * 0.3;
  }

  /** Open ground far from the road: road level blending into the desert floor. */
  openFar(i: number, d: number, x: number, z: number) {
    return lerp(this.posY[i] - 0.35, this.desert(x, z), smoothstep(40, 420, d));
  }

  /** The loose ground beside the road (the ribbon): frame i, side (-1/1), horizontal distance d from the centreline. */
  groundY(i: number, side: number, d: number, x: number, z: number) {
    const si = side < 0 ? 0 : 1;
    const x0 = this.x0[i];
    const pY = this.posY[i];
    // Right beside the road the ground continues the banked road plane (under the shoulder, which sits at -0.12);
    // then it levels out, but never above the road edge on the low side of a banked corner, and only far from the
    // road does it come back up to the centreline's level.
    const plane = pY + this.slope[i] * side * d - 0.3;
    const edge = pY + this.slope[i] * side * x0 - 0.3;
    const lvl = pY - 0.35 + (noise2(x * 0.035, z * 0.035) - 0.5) * 1.4 * smoothstep(x0 + 8, x0 + 40, d);
    const near = lerp(plane, Math.min(lvl, edge - 0.2), smoothstep(x0 + 2, x0 + 22, d));
    let y = lerp(near, lvl, smoothstep(x0 + 30, x0 + 90, d));
    const W = this.W[si][i];
    if (Number.isFinite(W)) {
      // Sand and scree banked up against the foot of the wall.
      y += (2 + 2.5 * noise2(x * 0.05, z * 0.05)) * smoothstep(W - 18, W + 1, d);
    } else {
      const de = this.dEnd[si][i];
      y = lerp(y, this.openFar(i, d, x, z), smoothstep(Math.min(30, de * 0.5), de, d));
    }
    return y;
  }

  /** Height of the far terrain (the heightfield) at (x, z); sets `rock`. */
  height(x: number, z: number): number {
    for (const g of this.gorges) {
      const rx = x - g.mx;
      const rz = z - g.mz;
      const a = rx * g.ax + rz * g.az;
      const d = rx * g.rx + rz * g.rz;
      if (a > g.a0 - g.back + 2 && a < g.a1 + g.back - 2 && Math.abs(d) < g.reach) {
        const floor = this.chasmFloor(g, d, x, z);
        let y = floor;
        this.rock = 0.25;
        let basin = false;
        for (const f of g.falls) {
          const u = (x - f.x) * f.ux + (z - f.z) * f.uz;
          const v = Math.abs(-(x - f.x) * f.uz + (z - f.z) * f.ux);
          if (u < -1 && u > -f.dist && v < f.width / 2 + 6) basin = true;
        }
        if (!basin) {
          for (const f of g.falls) {
            const u = (x - f.x) * f.ux + (z - f.z) * f.uz;
            const v = Math.abs(-(x - f.x) * f.uz + (z - f.z) * f.ux);
            if (u > -1 && u < 45 && v < f.width / 2 + 14) {
              y = Math.max(y, f.topY + (noise2(x * 0.05, z * 0.05) - 0.5) * 2);
              this.rock = 0.6;
            }
          }
        }
        return y;
      }
    }
    return this.regular(x, z);
  }

  /** Chasm floor along the gorge, rising to meet the open terrain at the far ends. */
  chasmFloor(g: Gorge, d: number, x: number, z: number) {
    const t = smoothstep(g.reach - 220, g.reach, Math.abs(d));
    const f = g.floorY + (noise2(x * 0.04, z * 0.04) - 0.5) * 1.5;
    return t > 0 ? lerp(f, this.regular(x, z) - 1, t) : f;
  }

  /** Height ignoring gorges. */
  regular(x: number, z: number): number {
    this.nearest(x, z);
    const i = this.qi;
    const side = this.qd < 0 ? -1 : 1;
    const si = side < 0 ? 0 : 1;
    const ad = Math.abs(this.qd);
    const W = this.W[si][i];
    let y: number;
    this.rock = 0;
    let mesaMask: number;
    if (ad < this.x0[i]) {
      y = this.posY[i] - Math.abs(this.slope[i]) * this.x0[i] - 3;
      mesaMask = 0;
    } else if (Number.isFinite(W)) {
      if (ad < W + this.back - 2) {
        y = this.groundY(i, side, Math.min(ad, W + 4), x, z) - 3;
        mesaMask = 0;
      } else {
        const ramp = smoothstep(W + this.back, W + this.back + 60, ad);
        const top = this.crest[si][i] + (fbm2(x * 0.01, z * 0.01, 3) - 0.5) * 10 * ramp;
        const P = this.plat[si][i];
        y = ad < W + P ? top : lerp(top, this.desert(x, z), smoothstep(W + P, W + P + 40, ad));
        this.rock = 0.5;
        mesaMask = smoothstep(W + P + 40, W + P + 120, ad);
      }
    } else {
      const de = this.dEnd[si][i];
      y = ad < de ? this.groundY(i, side, ad, x, z) - 2.5 * smoothstep(de, de - 6, ad) : this.openFar(i, ad, x, z);
      mesaMask = smoothstep(220, 320, ad);
    }
    if (this.city) {
      const dc = Math.hypot(x - this.city.pos.x, z - this.city.pos.z);
      const k = smoothstep(this.city.radius + 220, this.city.radius + 60, dc);
      if (k > 0) y = lerp(y, this.city.pos.y - 1, k);
      mesaMask *= smoothstep(this.city.radius + 220, this.city.radius + 400, dc);
    }
    if (mesaMask > 0) {
      const m = this.mesas(x, z) * mesaMask;
      if (m > 0) {
        const dy = this.desert(x, z) + m;
        if (dy > y) {
          y = dy;
          this.rock = 0.55;
        }
      }
    }
    return y;
  }
}
