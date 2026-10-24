// Tiny geometry kit for the stands module: accumulates oriented boxes, quads and swept profiles into flat
// position/normal/colour arrays (plus optional per-vertex cloth attributes) and turns them into one merged,
// non-indexed BufferGeometry. Everything static along the track ends up in a handful of draw calls this way.

import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());

export class GeoBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  /** Cloth only: how much a vertex moves (0 = pinned) and the direction it moves in. */
  readonly flap: number[] = [];
  readonly dir: number[] = [];

  constructor(readonly cloth = false) {}

  /** Triangle with a flat normal; `w` and `d` are cloth weights/direction for each vertex. */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, w?: [number, number, number], d?: THREE.Vector3) {
    _a.subVectors(b, a);
    _b.subVectors(c, a);
    _n.crossVectors(_a, _b).normalize();
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(_n.x, _n.y, _n.z);
      this.col.push(color.r, color.g, color.b);
    }
    if (this.cloth) {
      const dd = d ?? _n;
      for (let i = 0; i < 3; i++) {
        this.flap.push(w ? w[i] : 0);
        this.dir.push(dd.x, dd.y, dd.z);
      }
    }
  }

  /** Quad a-b-c-d (counter-clockwise seen from the front). */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color, w?: [number, number, number, number], dir?: THREE.Vector3) {
    this.tri(a, b, c, color, w && [w[0], w[1], w[2]], dir);
    this.tri(a, c, d, color, w && [w[0], w[2], w[3]], dir);
  }

  /**
   * Box centred at `c` with half extents along three (unit, orthogonal) axes. Bottom face skipped when `open` (nobody
   * sees it, saves triangles).
   */
  box(c: THREE.Vector3, ax: THREE.Vector3, ay: THREE.Vector3, az: THREE.Vector3, hx: number, hy: number, hz: number, color: THREE.Color, open = false) {
    for (let i = 0; i < 8; i++) {
      _corners[i]
        .copy(c)
        .addScaledVector(ax, i & 1 ? hx : -hx)
        .addScaledVector(ay, i & 2 ? hy : -hy)
        .addScaledVector(az, i & 4 ? hz : -hz);
    }
    const k = _corners;
    // Faces wound so their normals point outwards for a right-handed (ax, ay, az).
    this.quad(k[1], k[3], k[7], k[5], color); // +x
    this.quad(k[0], k[4], k[6], k[2], color); // -x
    this.quad(k[2], k[6], k[7], k[3], color); // +y
    if (!open) this.quad(k[0], k[1], k[5], k[4], color); // -y
    this.quad(k[4], k[5], k[7], k[6], color); // +z
    this.quad(k[0], k[2], k[3], k[1], color); // -z
  }

  /** A beam (square section, side `t`) from p to q. */
  beam(p: THREE.Vector3, q: THREE.Vector3, t: number, color: THREE.Color) {
    const ay = _beamY.subVectors(q, p);
    const len = ay.length();
    if (len < 1e-4) return;
    ay.divideScalar(len);
    const ax = _beamX.set(0, 1, 0).cross(ay);
    if (ax.lengthSq() < 1e-4) ax.set(1, 0, 0).cross(ay);
    ax.normalize();
    const az = _beamZ.crossVectors(ax, ay).normalize();
    const c = _beamC.addVectors(p, q).multiplyScalar(0.5);
    this.box(c, ax, ay, az, t / 2, len / 2, t / 2, color);
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.cloth) {
      g.setAttribute('aFlap', new THREE.Float32BufferAttribute(this.flap, 1));
      g.setAttribute('aDir', new THREE.Float32BufferAttribute(this.dir, 3));
    }
    g.computeBoundingSphere();
    return g;
  }
}

const _beamX = new THREE.Vector3();
const _beamY = new THREE.Vector3();
const _beamZ = new THREE.Vector3();
const _beamC = new THREE.Vector3();
