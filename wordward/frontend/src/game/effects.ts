// Short-lived, friendly effects: star beams, twinkling sparkles, poof clouds when a creature is defeated, splashes
// when a bubble shield pops, and dust when something bonks the castle. Everything is pooled per kind and reuses
// cached materials, so a fast typist does not create garbage every keystroke.

import * as THREE from 'three';
import { flat, hullGeometry, inkMaterial, toon } from './toon';

type FxKind = 'beam' | 'spark' | 'puff' | 'ring' | 'drop' | 'star';

interface Live {
  obj: THREE.Object3D;
  age: number;
  life: number;
  vel?: THREE.Vector3;
  spin?: number;
  size: number;
  kind: FxKind;
  /** Pool the object returns to. */
  key: string;
}

const UP = new THREE.Vector3(0, 1, 0);
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).translate(0, 0.5, 0);
const puffGeo = new THREE.IcosahedronGeometry(1, 2);
const puffHull = hullGeometry(puffGeo);
const ringGeo = new THREE.RingGeometry(0.8, 1, 32);
const dropGeo = new THREE.SphereGeometry(1, 8, 6);

function starGeometry(points = 5, inner = 0.45) {
  const s = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 ? inner : 1;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  return new THREE.ShapeGeometry(s);
}
const starGeo = starGeometry();

export const BEAM = 0xff6fb5;
const SPARK_COLORS = [0xffd23f, 0xff6fb5, 0x7ee0ff, 0xffffff, 0x9cf27a];

export class Effects {
  private live: Live[] = [];
  private pools = new Map<string, THREE.Object3D[]>();

  constructor(private readonly scene: THREE.Scene) {}

  private take(key: string, make: () => THREE.Object3D) {
    const obj = this.pools.get(key)?.pop() ?? make();
    obj.visible = true;
    this.scene.add(obj);
    return obj;
  }

  private release(l: Live) {
    l.obj.visible = false;
    this.scene.remove(l.obj);
    let pool = this.pools.get(l.key);
    if (!pool) this.pools.set(l.key, (pool = []));
    pool.push(l.obj);
  }

  private push(l: Omit<Live, 'age'> & { age?: number }) {
    this.live.push({ age: 0, ...l });
  }

  /** A candy-striped beam from `from` to `to`: coloured sheath around a white core, gone in a tenth of a second. */
  beam(from: THREE.Vector3, to: THREE.Vector3, color = BEAM) {
    const key = `beam${color}`;
    const obj = this.take(key, () => {
      const g = new THREE.Group();
      const ink = new THREE.Mesh(beamGeo, flat(0x1b1630));
      ink.scale.set(0.3, 1, 0.3);
      const outer = new THREE.Mesh(beamGeo, flat(color));
      outer.scale.set(0.22, 1, 0.22);
      const inner = new THREE.Mesh(beamGeo, flat(0xffffff));
      inner.scale.set(0.09, 1, 0.09);
      g.add(ink, outer, inner);
      return g;
    });
    const dir = to.clone().sub(from);
    obj.position.copy(from);
    obj.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
    obj.scale.set(1, dir.length(), 1);
    this.push({ obj, life: 0.13, size: 1, kind: 'beam', key });
    this.star(from, 0.55, 0xffd23f, 0.2);
  }

  /** One spinning star that grows and fades in place. */
  star(at: THREE.Vector3, size: number, color: number, life = 0.35) {
    const key = `star${color}`;
    const obj = this.take(key, () => {
      const g = new THREE.Group();
      const ink = new THREE.Mesh(starGeo, flat(0x1b1630));
      ink.scale.setScalar(1.25);
      ink.position.z = -0.01;
      g.add(ink, new THREE.Mesh(starGeo, flat(color)));
      return g;
    });
    obj.position.copy(at);
    obj.position.z += 0.8;
    this.push({ obj, life, size, kind: 'star', spin: 6, key });
  }

  /** Little stars flying out with a bit of gravity. */
  sparkles(at: THREE.Vector3, count = 5, speed = 5, size = 0.22) {
    for (let i = 0; i < count; i++) {
      const color = SPARK_COLORS[(Math.random() * SPARK_COLORS.length) | 0];
      const key = `spark${color}`;
      const obj = this.take(key, () => {
        const g = new THREE.Group();
        const ink = new THREE.Mesh(starGeo, flat(0x1b1630));
        ink.scale.setScalar(1.3);
        ink.position.z = -0.01;
        g.add(ink, new THREE.Mesh(starGeo, flat(color)));
        return g;
      });
      obj.position.copy(at);
      obj.position.z += 0.6;
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.1, 0).normalize().multiplyScalar(speed * (0.5 + Math.random()));
      this.push({ obj, life: 0.45 + Math.random() * 0.3, vel, spin: (Math.random() - 0.5) * 10, size: size * (0.6 + Math.random() * 0.8), kind: 'spark', key });
    }
  }

  ring(at: THREE.Vector3, size: number, color: number, life = 0.35) {
    const key = `ring${color}`;
    const obj = this.take(key, () => new THREE.Mesh(ringGeo, flat(color)));
    obj.position.copy(at);
    obj.position.z += 0.9;
    this.push({ obj, life, size, kind: 'ring', key });
  }

  /** A creature is defeated: a ring of fluffy cloud puffs, a burst of stars and confetti in its colour. */
  poof(at: THREE.Vector3, size = 1.2, color = 0xffffff) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const key = 'puff';
      const obj = this.take(key, () => {
        const m = new THREE.Mesh(puffGeo, toon(0xffffff));
        m.add(new THREE.Mesh(puffHull, inkMaterial(0.006, 0.01)));
        return m;
      });
      const a = (i / n) * Math.PI * 2;
      obj.position.copy(at).add(new THREE.Vector3(Math.cos(a) * size * 0.5, Math.sin(a) * size * 0.5, 0.3));
      const vel = new THREE.Vector3(Math.cos(a), Math.sin(a), 0).multiplyScalar(size * 2.2);
      this.push({ obj, life: 0.5 + Math.random() * 0.15, vel, size: size * (0.45 + Math.random() * 0.2), kind: 'puff', key, age: -Math.random() * 0.05 });
    }
    this.ring(at, size * 2.4, 0xffffff, 0.35);
    this.sparkles(at, 8, 8, 0.32);
    for (let i = 0; i < 6; i++) {
      const key = `drop${color}`;
      const obj = this.take(key, () => new THREE.Mesh(dropGeo, flat(color)));
      obj.position.copy(at);
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, (Math.random() - 0.5) * 0.3).normalize().multiplyScalar(6 + Math.random() * 5);
      this.push({ obj, life: 0.7, vel, size: 0.14 + Math.random() * 0.1, kind: 'drop', key });
    }
  }

  /** A bubble shield pops: a bright ring and droplets. */
  pop(at: THREE.Vector3, size: number) {
    this.ring(at, size * 1.3, 0x9fe8ff, 0.3);
    this.ring(at, size * 0.9, 0xffffff, 0.22);
    for (let i = 0; i < 12; i++) {
      const key = 'drop-bubble';
      const obj = this.take(key, () => new THREE.Mesh(dropGeo, flat(0xbff1ff)));
      const a = (i / 12) * Math.PI * 2;
      obj.position.copy(at).add(new THREE.Vector3(Math.cos(a) * size, Math.sin(a) * size, 0.5));
      const vel = new THREE.Vector3(Math.cos(a), Math.sin(a), 0).multiplyScalar(4 + Math.random() * 3);
      this.push({ obj, life: 0.45, vel, size: 0.12 + Math.random() * 0.08, kind: 'drop', key });
    }
  }

  /** Something bonked the castle: dust clouds along the wall. */
  dust(at: THREE.Vector3, size = 1.6) {
    for (let i = 0; i < 6; i++) {
      const key = 'dust';
      const obj = this.take(key, () => {
        const m = new THREE.Mesh(puffGeo, toon(0xe9dcc4));
        m.add(new THREE.Mesh(puffHull, inkMaterial(0.006, 0.01)));
        return m;
      });
      const s = i % 2 ? 1 : -1;
      obj.position.copy(at).add(new THREE.Vector3(s * (0.3 + i * 0.25), 0, 0.5));
      const vel = new THREE.Vector3(s * (2 + i * 0.6), 1.5 + Math.random(), 0);
      this.push({ obj, life: 0.7, vel, size: size * (0.35 + Math.random() * 0.25), kind: 'puff', key });
    }
    this.sparkles(at, 6, 7, 0.3);
  }

  update(dt: number) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i];
      l.age += dt;
      if (l.age < 0) {
        l.obj.visible = false;
        continue;
      }
      l.obj.visible = true;
      const k = l.age / l.life;
      if (k >= 1) {
        this.live.splice(i, 1);
        this.release(l);
        continue;
      }
      switch (l.kind) {
        case 'beam':
          l.obj.scale.x = l.obj.scale.z = 1 - k;
          break;
        case 'spark':
        case 'drop':
          l.vel!.y -= 14 * dt;
          l.obj.position.addScaledVector(l.vel!, dt);
          l.obj.scale.setScalar(l.size * (1 - k * k));
          if (l.spin) l.obj.rotation.z += l.spin * dt;
          break;
        case 'star':
          l.obj.rotation.z += (l.spin ?? 0) * dt;
          l.obj.scale.setScalar(l.size * Math.sin(Math.min(1, k * 1.4) * Math.PI));
          break;
        case 'puff': {
          // Swell fast, drift, shrink away.
          l.vel!.multiplyScalar(Math.max(0, 1 - dt * 4));
          l.obj.position.addScaledVector(l.vel!, dt);
          const s = k < 0.25 ? k / 0.25 : 1 - (k - 0.25) / 0.75;
          l.obj.scale.setScalar(l.size * Math.max(0.01, Math.sqrt(s)));
          break;
        }
        case 'ring':
          l.obj.scale.setScalar(l.size * (0.3 + k * 0.9));
          break;
      }
    }
  }

  clear() {
    for (const l of this.live) this.release(l);
    this.live = [];
  }
}
