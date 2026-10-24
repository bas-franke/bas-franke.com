// Small geometry builder for the track modules: flat-shaded quads, boxes and beams appended into one non-indexed
// buffer (with optional UVs and vertex colours), so a whole structure becomes a single merged mesh.

import * as THREE from 'three';

const e1 = new THREE.Vector3();
const e2 = new THREE.Vector3();
const n = new THREE.Vector3();

export type UV = [number, number];

export class GeoBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uvs: number[] = [];
  private col: number[] = [];
  private color = new THREE.Color(1, 1, 1);

  constructor(private readonly withUv: boolean, private readonly withColor: boolean) {}

  get empty() {
    return this.pos.length === 0;
  }

  setColor(c: THREE.Color | string | number) {
    this.color.set(c);
    return this;
  }

  /**
   * Quad p0-p1-p2-p3 (in order around the edge). The normal is (p1-p0)x(p3-p0); when `hint` is given and points the
   * other way, the winding is flipped so the face looks towards `hint`.
   */
  quad(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, uv?: [UV, UV, UV, UV], hint?: THREE.Vector3) {
    e1.subVectors(p1, p0);
    e2.subVectors(p3, p0);
    n.crossVectors(e1, e2);
    if (n.lengthSq() < 1e-12) {
      e1.subVectors(p2, p0);
      n.crossVectors(e1, e2);
    }
    n.normalize();
    let order = [0, 1, 2, 0, 2, 3];
    if (hint && n.dot(hint) < 0) {
      n.negate();
      order = [0, 2, 1, 0, 3, 2];
    }
    const ps = [p0, p1, p2, p3];
    for (const k of order) {
      const p = ps[k];
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      if (this.withUv) {
        const t = uv ? uv[k] : [0, 0];
        this.uvs.push(t[0], t[1]);
      }
      if (this.withColor) this.col.push(this.color.r, this.color.g, this.color.b);
    }
  }

  /**
   * Box from 8 corners: c[0..3] the bottom ring, c[4..7] the top ring (same order). Faces point away from the centre.
   * `uvFor(face)` may supply UVs per face (0 bottom, 1 top, 2..5 the sides starting at edge c0-c1).
   */
  box(c: THREE.Vector3[], uvFor?: (face: number) => [UV, UV, UV, UV] | undefined) {
    const centre = new THREE.Vector3();
    for (const p of c) centre.add(p);
    centre.multiplyScalar(1 / 8);
    const hint = new THREE.Vector3();
    const face = (a: number, b: number, cc: number, d: number, i: number) => {
      hint.copy(c[a]).add(c[b]).add(c[cc]).add(c[d]).multiplyScalar(0.25).sub(centre);
      this.quad(c[a], c[b], c[cc], c[d], uvFor?.(i), hint);
    };
    face(0, 1, 2, 3, 0);
    face(4, 5, 6, 7, 1);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      // u along the bottom edge, v up the side.
      face(i, j, j + 4, i + 4, 2 + i);
    }
  }

  /** Rectangular beam from a to b, `w` wide and `h` deep; `up` orients the cross-section (default world up). */
  beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, up = WORLD_UP) {
    const dir = new THREE.Vector3().subVectors(b, a).normalize();
    const side = new THREE.Vector3().crossVectors(dir, up);
    if (side.lengthSq() < 1e-6) side.crossVectors(dir, X_AXIS);
    side.normalize().multiplyScalar(w / 2);
    const top = new THREE.Vector3().crossVectors(side, dir).normalize().multiplyScalar(h / 2);
    const ring = (p: THREE.Vector3) => [
      p.clone().sub(side).sub(top),
      p.clone().add(side).sub(top),
      p.clone().add(side).add(top),
      p.clone().sub(side).add(top),
    ];
    const ra = ring(a);
    const rb = ring(b);
    this.box([...ra, ...rb]);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (this.withUv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (this.withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

export const WORLD_UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
