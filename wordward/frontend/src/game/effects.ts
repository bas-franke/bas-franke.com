// Short-lived visual effects: laser beams, letter sparks, inked fireballs and debris. Everything is pooled per kind
// and reuses cached materials, so a fast typist does not create garbage every keystroke.

import * as THREE from 'three';
import { flat, hullGeometry, inkMaterial, toon } from './toon';

interface Live {
  obj: THREE.Object3D;
  age: number;
  life: number;
  vel?: THREE.Vector3;
  spin?: number;
  size: number;
  kind: 'laser' | 'spark' | 'fire' | 'ring' | 'debris';
  /** Pool the object returns to. */
  key: string;
}

const UP = new THREE.Vector3(0, 1, 0);
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0);
const sparkGeo = new THREE.OctahedronGeometry(1);
const fireGeo = new THREE.IcosahedronGeometry(1, 1);
const fireHull = hullGeometry(fireGeo);
const ringGeo = new THREE.RingGeometry(0.85, 1, 32);
const debrisGeo = new THREE.TetrahedronGeometry(1);
const debrisHull = hullGeometry(debrisGeo);

export const LASER = 0xff3d8b;
const SPARK_COLORS = [0xff3d8b, 0xffd36b, 0x7cf4c9, 0xffffff];
const FIRE_COLORS = [0xff4f2a, 0xffa23d, 0xffe27a];

export class Effects {
  private live: Live[] = [];
  private pools = new Map<string, THREE.Object3D[]>();

  constructor(private readonly scene: THREE.Scene) {}

  private take(key: string, make: () => THREE.Object3D) {
    const pool = this.pools.get(key);
    const obj = pool?.pop() ?? make();
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

  /** A beam from `from` to `to`: a thick coloured core with a white centre, fading in a tenth of a second. */
  laser(from: THREE.Vector3, to: THREE.Vector3, color = LASER) {
    const obj = this.take(`laser${color}`, () => {
      const g = new THREE.Group();
      const outer = new THREE.Mesh(beamGeo, flat(color));
      outer.scale.set(0.22, 1, 0.22);
      const inner = new THREE.Mesh(beamGeo, flat(0xffffff));
      inner.scale.set(0.09, 1, 0.09);
      g.add(outer, inner);
      return g;
    });
    const dir = to.clone().sub(from);
    obj.position.copy(from);
    obj.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
    obj.scale.set(1, dir.length(), 1);
    this.live.push({ obj, age: 0, life: 0.12, size: 1, kind: 'laser', key: `laser${color}` });
    // A tiny flash ring at the muzzle.
    this.ring(from, 0.6, color, 0.15);
  }

  sparks(at: THREE.Vector3, count = 6, speed = 6, size = 0.16) {
    for (let i = 0; i < count; i++) {
      const color = SPARK_COLORS[(Math.random() * SPARK_COLORS.length) | 0];
      const obj = this.take(`spark${color}`, () => new THREE.Mesh(sparkGeo, flat(color)));
      obj.position.copy(at);
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, (Math.random() - 0.5) * 0.4)
        .normalize()
        .multiplyScalar(speed * (0.5 + Math.random()));
      this.live.push({ obj, age: 0, life: 0.35 + Math.random() * 0.25, vel, size: size * (0.6 + Math.random() * 0.8), kind: 'spark', key: `spark${color}` });
    }
  }

  ring(at: THREE.Vector3, size: number, color: number, life = 0.35) {
    const obj = this.take(`ring${color}`, () => new THREE.Mesh(ringGeo, flat(color)));
    obj.position.copy(at);
    obj.position.z += 0.5;
    this.live.push({ obj, age: 0, life, size, kind: 'ring', key: `ring${color}` });
  }

  /** An inked fireball that swells and collapses, with flying debris. */
  explode(at: THREE.Vector3, size = 1.2, debrisColor = 0x8a5a9c) {
    for (let i = 0; i < 3; i++) {
      const color = FIRE_COLORS[i];
      const obj = this.take(`fire${color}`, () => {
        const m = new THREE.Mesh(fireGeo, toon(color));
        m.add(new THREE.Mesh(fireHull, inkMaterial()));
        return m;
      });
      obj.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * size * 0.6, (Math.random() - 0.5) * size * 0.6, i * 0.2));
      this.live.push({ obj, age: -i * 0.04, life: 0.45 + i * 0.05, size: size * (1.2 - i * 0.25), kind: 'fire', key: `fire${color}` });
    }
    this.ring(at, size * 2.6, 0xfff1c1, 0.4);
    for (let i = 0; i < 7; i++) {
      const obj = this.take(`debris${debrisColor}`, () => {
        const m = new THREE.Mesh(debrisGeo, toon(debrisColor));
        m.add(new THREE.Mesh(debrisHull, inkMaterial()));
        return m;
      });
      obj.position.copy(at);
      const vel = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, (Math.random() - 0.5) * 0.5).normalize().multiplyScalar(5 + Math.random() * 7);
      this.live.push({ obj, age: 0, life: 0.9 + Math.random() * 0.4, vel, spin: (Math.random() - 0.5) * 14, size: size * (0.12 + Math.random() * 0.14), kind: 'debris', key: `debris${debrisColor}` });
    }
    this.sparks(at, 10, 9, 0.2);
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
        case 'laser': {
          const w = 1 - k;
          l.obj.scale.x = l.obj.scale.z = w;
          break;
        }
        case 'spark':
        case 'debris':
          l.vel!.y -= 16 * dt;
          l.obj.position.addScaledVector(l.vel!, dt);
          l.obj.scale.setScalar(l.size * (l.kind === 'spark' ? 1 - k : 1 - k * k));
          if (l.spin) {
            l.obj.rotation.x += l.spin * dt;
            l.obj.rotation.y += l.spin * 0.7 * dt;
          }
          break;
        case 'fire': {
          // Fast swell, slower collapse.
          const s = k < 0.3 ? k / 0.3 : 1 - (k - 0.3) / 0.7;
          l.obj.scale.setScalar(l.size * Math.max(0.01, Math.sqrt(s)));
          l.obj.position.y += dt * 1.2;
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

