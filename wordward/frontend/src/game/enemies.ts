// Enemy models from Romanian folklore and the night sky, built from primitives with toon shading and ink outlines:
//   meteorit — a burning rock (medium words)
//   liliac   — a bat that flutters down fast (short words)
//   strigoi  — a restless ghost that sways (long words)
//   zmeu     — a horned dragon head, big and slow (the longest words)
//   convoy   — a chain of small rocks, one word each, for sentences

import * as THREE from 'three';
import { flat, hullGeometry, inkMaterial, toon } from './toon';
import { inked } from './world';

export type Kind = 'meteor' | 'bat' | 'ghost' | 'zmeu' | 'rock';

export interface Model {
  root: THREE.Group;
  /** Rough radius, for explosions and label placement. */
  radius: number;
  animate(dt: number, t: number): void;
}

function lumpy(radius: number, detail: number, seed: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  // Displace by direction only, so the duplicated vertices of a face-split icosahedron move together and stay welded.
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    const k = 1 + 0.18 * Math.sin(n.x * 5 + seed) * Math.cos(n.y * 4 + seed * 2) + 0.08 * Math.sin(n.z * 9 + seed);
    v.copy(n).multiplyScalar(radius * k);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

const eye = (parent: THREE.Object3D, x: number, y: number, z: number, r: number, color = 0xfff36b) => {
  const white = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), flat(color));
  white.position.set(x, y, z);
  white.add(new THREE.Mesh(hullGeometry(new THREE.SphereGeometry(r, 12, 8)), inkMaterial()));
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(r * 0.45, 8, 6), flat(0x16121c));
  pupil.position.set(0, -r * 0.2, r * 0.75);
  white.add(pupil);
  parent.add(white);
  return white;
};

/** Flat comic flames trailing behind a falling object, licking upwards (the direction it came from). */
function flames(parent: THREE.Object3D, radius: number) {
  const g = new THREE.Group();
  const shape = (w: number, h: number) => {
    const f = new THREE.Shape();
    f.moveTo(-w, 0);
    f.quadraticCurveTo(-w * 1.05, h * 0.45, -w * 0.55, h * 0.62);
    f.quadraticCurveTo(-w * 0.45, h * 0.8, -w * 0.62, h * 0.88);
    f.quadraticCurveTo(-w * 0.1, h * 0.75, 0, h);
    f.quadraticCurveTo(w * 0.15, h * 0.7, w * 0.5, h * 0.72);
    f.quadraticCurveTo(w * 0.35, h * 0.55, w * 0.8, h * 0.4);
    f.quadraticCurveTo(w * 1.05, h * 0.2, w, 0);
    f.absarc(0, 0, w, 0, Math.PI, true);
    return new THREE.ShapeGeometry(f, 8);
  };
  const layers: [number, number, number][] = [
    [0x16121c, 1.12, -0.75],
    [0xff4f2a, 1, -0.7],
    [0xffa23d, 0.7, -0.65],
    [0xfff1a1, 0.42, -0.6],
  ];
  for (const [c, s, z] of layers) {
    const m = new THREE.Mesh(shape(radius * 0.95 * s, radius * 3.3 * s), flat(c));
    m.position.set(0, c === 0x16121c ? -radius * 0.06 : 0, z);
    g.add(m);
  }
  parent.add(g);
  return g;
}

export function makeMeteor(radius = 1.1, seed = Math.random() * 10): Model {
  const root = new THREE.Group();
  const trail = flames(root, radius);
  const body = new THREE.Group();
  root.add(body);
  inked(body, lumpy(radius, 1, seed), 0x8a5a9c);
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(new THREE.CircleGeometry(radius * (0.16 + Math.random() * 0.12), 10), flat(0x5e3a72));
    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() * 0.6 + 0.4).normalize();
    c.position.copy(dir.multiplyScalar(radius * 1.02));
    c.lookAt(c.position.clone().multiplyScalar(2));
    body.add(c);
  }
  const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2);
  return {
    root,
    radius,
    animate(dt, t) {
      body.rotation.x += spin.x * dt;
      body.rotation.y += spin.y * dt;
      body.rotation.z += spin.z * dt;
      const f = 1 + Math.sin(t * 22 + seed) * 0.08;
      trail.scale.set(f, 1 + Math.sin(t * 17 + seed) * 0.12, f);
    },
  };
}

export function makeRock(radius = 0.85): Model {
  const m = makeMeteor(radius);
  m.root.children[0].scale.setScalar(0.6);
  return m;
}

export function makeBat(): Model {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  inked(body, new THREE.SphereGeometry(0.62, 16, 12), 0x4a3070);
  for (const s of [-1, 1]) {
    inked(body, new THREE.ConeGeometry(0.2, 0.55, 6).translate(s * 0.3, 0.75, 0), 0x4a3070);
  }
  eye(body, -0.22, 0.12, 0.5, 0.15);
  eye(body, 0.22, 0.12, 0.5, 0.15);
  const fang = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 4), flat(0xffffff));
  fang.rotation.x = Math.PI;
  fang.position.set(0.1, -0.22, 0.55);
  body.add(fang);
  // Scalloped wing as a flat shape; the ink hull of a flat shape is invisible, so give it an ink twin slightly larger.
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0.25);
  wingShape.lineTo(1.6, 0.6);
  wingShape.lineTo(1.9, -0.1);
  wingShape.quadraticCurveTo(1.5, -0.05, 1.35, -0.45);
  wingShape.quadraticCurveTo(1.0, -0.2, 0.8, -0.55);
  wingShape.quadraticCurveTo(0.5, -0.25, 0, -0.25);
  wingShape.lineTo(0, 0.25);
  const wingGeo = new THREE.ShapeGeometry(wingShape);
  const wings: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.45, 0.05, 0);
    pivot.scale.x = s;
    const wing = new THREE.Mesh(wingGeo, new THREE.MeshBasicMaterial({ color: 0x6b4a9a, side: THREE.DoubleSide }));
    const ink = new THREE.Mesh(wingGeo, new THREE.MeshBasicMaterial({ color: 0x16121c, side: THREE.DoubleSide }));
    ink.scale.setScalar(1.08);
    ink.position.set(-0.06, -0.02, -0.02);
    pivot.add(ink, wing);
    body.add(pivot);
    wings.push(pivot);
  }
  const phase = Math.random() * 10;
  return {
    root,
    radius: 0.9,
    animate(_dt, t) {
      const flap = Math.sin(t * 14 + phase) * 0.7;
      wings[0].rotation.y = flap;
      wings[1].rotation.y = -flap;
      body.position.y = Math.sin(t * 14 + phase + 1) * 0.12;
    },
  };
}

export function makeGhost(): Model {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  // Bell-shaped sheet with a wavy hem: a lathe profile, then the hem rippled around the circumference.
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 0.5;
    profile.push(new THREE.Vector2(Math.sin(a) * 0.95 + 0.0001, 0.6 + Math.cos(a) * 0.9));
  }
  profile.push(new THREE.Vector2(1.05, -0.4), new THREE.Vector2(1.12, -0.9));
  // Lathe faces point outwards when the profile runs bottom to top.
  profile.reverse();
  const geo = new THREE.LatheGeometry(profile, 20);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < -0.8) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      pos.setY(i, y + Math.sin(a * 6) * 0.22);
    }
  }
  geo.computeVertexNormals();
  inked(body, geo, 0xd8fff4);
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), flat(0x16121c));
    e.scale.set(1, 1.5, 0.6);
    e.position.set(s * 0.32, 0.75, 0.85);
    body.add(e);
  }
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), flat(0x16121c));
  mouth.scale.set(1, 1.3, 0.5);
  mouth.position.set(0, 0.25, 0.95);
  body.add(mouth);
  const arms: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const arm = inked(body, new THREE.CapsuleGeometry(0.16, 0.6, 4, 8).translate(0, -0.3, 0), 0xd8fff4);
    arm.position.set(s * 0.95, 0.1, 0.2);
    arm.rotation.z = s * 0.9;
    arms.push(arm);
  }
  const phase = Math.random() * 10;
  return {
    root,
    radius: 1.1,
    animate(_dt, t) {
      body.rotation.z = Math.sin(t * 2.2 + phase) * 0.18;
      arms[0].rotation.z = -0.9 - Math.sin(t * 4 + phase) * 0.35;
      arms[1].rotation.z = 0.9 + Math.sin(t * 4 + phase) * 0.35;
      body.position.y = Math.sin(t * 3 + phase) * 0.15;
    },
  };
}

export function makeZmeu(): Model {
  const root = new THREE.Group();
  const head = new THREE.Group();
  root.add(head);
  const green = 0x3fae6b;
  inked(head, new THREE.SphereGeometry(1.2, 16, 12).scale(1.15, 0.95, 1), green);
  inked(head, new THREE.BoxGeometry(1.4, 0.75, 1.3).translate(0, -0.45, 0.95), green);
  const belly = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.2, 1.1), toon(0xf2d27a));
  belly.position.set(0, -0.86, 0.95);
  head.add(belly);
  for (const s of [-1, 1]) {
    inked(head, new THREE.ConeGeometry(0.26, 1.3, 7).rotateZ(-s * 0.5).translate(s * 0.85, 1.25, -0.1), 0xfff1c1);
    eye(head, s * 0.48, 0.35, 0.95, 0.24, 0xff5a3d);
    const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 4), flat(0x16121c));
    nostril.position.set(s * 0.3, -0.3, 1.62);
    head.add(nostril);
  }
  for (let i = 0; i < 4; i++) {
    const tooth = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.26, 4), flat(0xffffff));
    tooth.rotation.x = Math.PI;
    tooth.position.set(-0.45 + i * 0.3, -0.95, 1.5);
    head.add(tooth);
  }
  // Spiky frill behind the head.
  for (let i = 0; i < 5; i++) {
    const a = -0.9 + i * 0.45;
    inked(head, new THREE.ConeGeometry(0.3, 1.1, 5).translate(0, 0.55, 0).rotateZ(a).translate(0, 0.3, -0.7), 0xe0483a);
  }
  const smoke: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), flat(0xcfc6e8));
    head.add(puff);
    smoke.push(puff);
  }
  const phase = Math.random() * 10;
  return {
    root,
    radius: 1.6,
    animate(_dt, t) {
      head.rotation.z = Math.sin(t * 1.6 + phase) * 0.12;
      head.rotation.y = Math.sin(t * 1.1 + phase) * 0.25;
      smoke.forEach((p, i) => {
        const k = (t * 0.8 + i / smoke.length) % 1;
        const s = i % 2 ? 1 : -1;
        p.position.set(s * (0.3 + k * 0.5), -0.3 - k * 0.8, 1.65 + k * 0.3);
        p.scale.setScalar(0.5 + k * 1.4);
      });
    },
  };
}

export function makeModel(kind: Kind): Model {
  switch (kind) {
    case 'bat':
      return makeBat();
    case 'ghost':
      return makeGhost();
    case 'zmeu':
      return makeZmeu();
    case 'rock':
      return makeRock();
    default:
      return makeMeteor();
  }
}
