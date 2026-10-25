// Garden Sentinels ambient life: butterflies and bees on the flower beds, dragonflies skimming the water, songbirds that
// fly in and land, fireflies around lamps / water / shade, petals and leaves on the wind, gnome robots pottering along
// the board edges, watering drones, glowing mushrooms and a little static garden decor (logs, benches, beehives,
// planters, stepping stones, sprinklers, wind chimes) outside the grid border.
//
// Everything is instanced: one InstancedMesh per mesh of each critter / prop, re-filled every frame for the movers and
// once for the static decor, plus two Points clouds (fireflies, water drops). Models come from /models/garden/decor.glb
// (roots `Decor_<name>`, children `_wingL/_wingR` hinges, `_prop` / `_head` spinners, `_chimes`), built at real-world
// size, so critters are scaled up to gameplay-readable sizes here. Until (or without) the GLB, primitive stand-ins
// with the same node naming are used. Placement only uses blocked decor cells (f, T, R, l, ~, o) and the ring outside
// the grid; never path, bridge or buildable cells.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { G } from '@shared/garden/constants';
import { cellToWorld, type BoardOrigin } from '@shared/garden/board';
import type { GMapDef } from '@shared/garden/maps';
import type { Quality } from './api';

export interface Ambience {
  update(dt: number, time: number, camera: THREE.Camera): void;
  scare(x: number, z: number, radius: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

const TAU = Math.PI * 2;
const QF: Record<Quality, number> = { low: 0.3, medium: 0.6, high: 1 };

function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};
/** Yaw facing a direction (0 = facing -z, positive turns left). */
const yawOf = (dx: number, dz: number) => Math.atan2(-dx, -dz);

// ---- rigs: a model split into instancable parts ---------------------------------------------------------------------

type PartKind = 'body' | 'wingL' | 'wingR' | 'spin' | 'head' | 'sway';

interface RigPart {
  kind: PartKind;
  /** -1 left, +1 right (wings: which way "up" rotates). */
  side: number;
  /** Part hinge relative to the creature origin (fit scale included). */
  pivot: THREE.Matrix4;
  meshes: { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; tint: boolean }[];
}

interface Rig {
  parts: RigPart[];
  glow: THREE.MeshStandardMaterial[];
  /** Size after fitting (x, y, z) in metres. */
  size: THREE.Vector3;
  owned: THREE.Material[];
}

function partKindOf(name: string): PartKind | null {
  if (/wing_?L/.test(name)) return 'wingL';
  if (/wing_?R/.test(name)) return 'wingR';
  if (/_prop/i.test(name) || /sprinkler_head/i.test(name)) return 'spin';
  if (/_head/i.test(name)) return 'head';
  if (/_chimes/i.test(name)) return 'sway';
  return null;
}

/**
 * Splits a model into body / wing / spinner parts with geometry baked into each part's local space. `fit` scales the
 * model so its largest dimension is `fit` metres. `tintWings`: the dominant wing material is cloned white so per
 * instance colours show true.
 */
function rigFrom(root: THREE.Object3D, fit: number | null, tintWings: boolean, tintAll = false): Rig {
  root.updateMatrixWorld(true);
  const rp = new THREE.Vector3().setFromMatrixPosition(root.matrixWorld);
  const inv = new THREE.Matrix4().makeTranslation(-rp.x, -rp.y, -rp.z);
  const map = new Map<THREE.Object3D, RigPart>();
  const glow = new Set<THREE.MeshStandardMaterial>();
  const owned: THREE.Material[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    let node: THREE.Object3D | null = mesh;
    let kind: PartKind = 'body';
    let pnode: THREE.Object3D = root;
    while (node && node !== root) {
      const k = partKindOf(node.name);
      if (k) {
        kind = k;
        pnode = node;
        break;
      }
      node = node.parent;
    }
    let part = map.get(pnode);
    if (!part) {
      part = { kind, side: kind === 'wingL' ? -1 : 1, pivot: inv.clone().multiply(pnode.matrixWorld), meshes: [] };
      map.set(pnode, part);
    }
    const local = pnode.matrixWorld.clone().invert().multiply(mesh.matrixWorld);
    const geo = mesh.geometry.clone().applyMatrix4(local);
    part.meshes.push({ geo, mat: mesh.material, tint: tintAll });
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial && /^Glow/i.test(m.name)) glow.add(m as THREE.MeshStandardMaterial);
  });
  const parts = [...map.values()];
  // Bounds in creature space.
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const p of parts)
    for (const m of p.meshes) {
      m.geo.computeBoundingBox();
      tmp.copy(m.geo.boundingBox!).applyMatrix4(p.pivot);
      box.union(tmp);
    }
  const size = box.isEmpty() ? new THREE.Vector3(0.1, 0.1, 0.1) : box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-4);
  const s = fit ? fit / maxDim : 1;
  if (s !== 1) {
    const S = new THREE.Matrix4().makeScale(s, s, s);
    for (const p of parts) p.pivot.premultiply(S);
    size.multiplyScalar(s);
  }
  for (const p of parts) {
    if (p.kind !== 'wingL' && p.kind !== 'wingR') continue;
    // Which side is the wing on: decides which rotation lifts it.
    const c = new THREE.Vector3();
    const b = new THREE.Box3();
    for (const m of p.meshes) b.union(m.geo.boundingBox!);
    b.getCenter(c).applyMatrix4(p.pivot);
    const hinge = new THREE.Vector3().setFromMatrixPosition(p.pivot);
    if (Math.abs(c.x - hinge.x) > 1e-5) p.side = c.x < hinge.x ? -1 : 1;
    if (tintWings && p.meshes.length) {
      // Tint the biggest wing mesh (the membrane); spots and veins keep their colour.
      let best = p.meshes[0];
      for (const m of p.meshes) if ((m.geo.index?.count ?? m.geo.attributes.position.count) > (best.geo.index?.count ?? best.geo.attributes.position.count)) best = m;
      if (!Array.isArray(best.mat)) {
        const cm = best.mat.clone() as THREE.MeshStandardMaterial;
        if (cm.color) cm.color.setRGB(1, 1, 1);
        owned.push(cm);
        best.mat = cm;
      }
      best.tint = true;
    }
  }
  return { parts, glow: [...glow], size, owned };
}

function disposeRig(r: Rig) {
  for (const p of r.parts) for (const m of p.meshes) m.geo.dispose();
  for (const m of r.owned) m.dispose();
}

// ---- herds: one instanced draw per mesh of a rig --------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _r2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const WHITE = new THREE.Color(1, 1, 1);

function compose(out: THREE.Matrix4, x: number, y: number, z: number, yaw: number, pitch: number, roll: number, s: number) {
  _e.set(pitch, yaw, roll, 'YXZ');
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _s.set(s, s, s);
  return out.compose(_v, _q, _s);
}

interface HerdOpts {
  cast?: boolean;
  receive?: boolean;
}

class Herd {
  private parts: { part: RigPart; ims: { im: THREE.InstancedMesh; tint: boolean }[] }[] = [];
  n = 0;
  constructor(
    private group: THREE.Group,
    public rig: Rig,
    public readonly cap: number,
    private opts: HerdOpts,
  ) {
    this.build();
  }

  private build() {
    const cap = Math.max(1, this.cap);
    for (const part of this.rig.parts) {
      const ims = part.meshes.map((m) => {
        const im = new THREE.InstancedMesh(m.geo, m.mat, cap);
        im.frustumCulled = false;
        im.castShadow = !!this.opts.cast;
        im.receiveShadow = !!this.opts.receive;
        im.count = 0;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (m.tint) for (let i = 0; i < cap; i++) im.setColorAt(i, WHITE);
        this.group.add(im);
        return { im, tint: m.tint };
      });
      this.parts.push({ part, ims });
    }
  }

  private clear() {
    for (const p of this.parts)
      for (const { im } of p.ims) {
        this.group.remove(im);
        im.dispose();
      }
    this.parts = [];
  }

  setRig(rig: Rig) {
    this.clear();
    disposeRig(this.rig);
    this.rig = rig;
    this.build();
  }

  setShadow(cast: boolean) {
    this.opts.cast = cast;
    for (const p of this.parts) for (const { im } of p.ims) im.castShadow = cast;
  }

  begin() {
    this.n = 0;
  }

  /** One instance: base transform, wing flap angle (+ lifts), spinner angle, head / sway angle, optional tint. */
  put(base: THREE.Matrix4, flap: number, spin: number, aux: number, color?: THREE.Color) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    for (const { part, ims } of this.parts) {
      _m.multiplyMatrices(base, part.pivot);
      switch (part.kind) {
        case 'wingL':
        case 'wingR':
          _m.multiply(_r.makeRotationZ(flap * part.side));
          break;
        case 'spin':
          _m.multiply(_r.makeRotationY(spin));
          break;
        case 'head':
          _m.multiply(_r.makeRotationY(aux));
          break;
        case 'sway':
          _m.multiply(_r.makeRotationX(aux)).multiply(_r2.makeRotationZ(aux * 0.6));
          break;
      }
      for (const { im, tint } of ims) {
        im.setMatrixAt(i, _m);
        if (tint && color) im.setColorAt(i, color);
      }
    }
  }

  end() {
    for (const p of this.parts)
      for (const { im } of p.ims) {
        im.count = this.n;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
  }

  dispose() {
    this.clear();
    disposeRig(this.rig);
  }
}

// ---- primitive stand-ins (same node naming as decor.glb) ------------------------------------------------------------

/** Where primitive() puts the materials it makes (the calling ambience disposes them). */
let primMats: THREE.Material[] = [];
function pm(color: number, o: THREE.MeshStandardMaterialParameters = {}, name = '') {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...o });
  m.name = name;
  primMats.push(m);
  return m;
}

function primitive(name: string): THREE.Object3D {
  const root = new THREE.Group();
  root.name = `Decor_${name}`;
  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.scale.set(sx, sy, sz);
    parent.add(m);
    return m;
  };
  const child = (suffix: string, x = 0, y = 0, z = 0) => {
    const c = new THREE.Group();
    c.name = `Decor_${name}_${suffix}`;
    c.position.set(x, y, z);
    root.add(c);
    return c;
  };
  /** Flat wing outline in the XZ plane (front = -z), extending to -x; mirrored for the right wing. */
  const wingGeo = (pts: [number, number][], mirror: boolean) => {
    const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(mirror ? -x : x, y)));
    return new THREE.ShapeGeometry(sh).rotateX(-Math.PI / 2);
  };
  const ink = pm(0x2d2a33, { roughness: 0.6 });
  const cream = pm(0xf5e7d6, { roughness: 0.45 });
  const amber = pm(0xffa940, { roughness: 0.5 });
  const wood = pm(0x8a5e3c, { roughness: 0.85 });
  const stone = pm(0xd9c9aa, { roughness: 0.95 });
  const copper = pm(0xc4783a, { roughness: 0.35, metalness: 0.7 });
  const mint = pm(0x4ee6d9, { emissive: 0x7ff5ea, emissiveIntensity: 2 }, 'GlowMint');
  const wingMat = pm(0xffffff, { side: THREE.DoubleSide, roughness: 0.5 });
  const clearWing = pm(0xd8fff9, { side: THREE.DoubleSide, transparent: true, opacity: 0.55, roughness: 0.2, depthWrite: false });
  switch (name) {
    case 'butterfly': {
      add(root, new THREE.CylinderGeometry(0.012, 0.01, 0.16, 6).rotateX(Math.PI / 2), ink);
      const wing: [number, number][] = [[0, 0.03], [-0.09, 0.1], [-0.19, 0.09], [-0.2, 0.02], [-0.12, -0.01], [-0.16, -0.09], [-0.07, -0.11], [0, -0.04]];
      // Shape y -> -z after rotateX(-90), so +y points to the front.
      add(child('wingL', -0.01), wingGeo(wing, false), wingMat);
      add(child('wingR', 0.01), wingGeo(wing, true), wingMat);
      break;
    }
    case 'bee': {
      add(root, new THREE.SphereGeometry(0.05, 10, 8), amber, 0, 0, 0, 0, 0, 0, 0.8, 0.8, 1.3);
      add(root, new THREE.CylinderGeometry(0.042, 0.042, 0.022, 10).rotateX(Math.PI / 2), ink, 0, 0, 0.015);
      add(root, new THREE.SphereGeometry(0.028, 8, 6), ink, 0, 0.005, -0.07);
      const w: [number, number][] = [[0, 0.01], [-0.03, 0.03], [-0.06, 0.0], [-0.03, -0.02]];
      add(child('wingL', -0.01, 0.035, -0.01), wingGeo(w, false), clearWing);
      add(child('wingR', 0.01, 0.035, -0.01), wingGeo(w, true), clearWing);
      break;
    }
    case 'dragonfly': {
      const teal = pm(0x2eb3ff, { emissive: 0x1a6fa0, emissiveIntensity: 0.4, roughness: 0.3, metalness: 0.3 });
      add(root, new THREE.CylinderGeometry(0.008, 0.012, 0.34, 6).rotateX(Math.PI / 2), teal, 0, 0, 0.07);
      add(root, new THREE.SphereGeometry(0.025, 8, 6), teal, 0, 0, -0.11);
      const fw: [number, number][] = [[0, 0.015], [-0.12, 0.03], [-0.2, 0.012], [-0.12, -0.005], [0, 0]];
      const hw: [number, number][] = [[0, 0], [-0.12, 0.0], [-0.19, -0.02], [-0.11, -0.035], [0, -0.02]];
      for (const [side, m] of [['wingL', false], ['wingR', true]] as const) {
        const c = child(side, m ? 0.01 : -0.01, 0.012, -0.06);
        add(c, wingGeo(fw, m), clearWing);
        add(c, wingGeo(hw, m), clearWing);
      }
      break;
    }
    case 'bird': {
      const brown = pm(0x9a6e4c, { roughness: 0.8 });
      const chest = pm(0xff8a4a, { roughness: 0.8 });
      add(root, new THREE.SphereGeometry(0.1, 10, 8), brown, 0, 0.1, 0, 0, 0, 0, 0.7, 0.7, 1.15);
      add(root, new THREE.SphereGeometry(0.07, 10, 8), chest, 0, 0.08, -0.04, 0, 0, 0, 0.8, 0.8, 0.9);
      add(root, new THREE.SphereGeometry(0.06, 10, 8), brown, 0, 0.17, -0.09);
      add(root, new THREE.ConeGeometry(0.018, 0.05, 6).rotateX(-Math.PI / 2), amber, 0, 0.165, -0.155);
      add(root, new THREE.BoxGeometry(0.06, 0.012, 0.1), brown, 0, 0.12, 0.14, 0.3);
      const w: [number, number][] = [[0, 0.05], [-0.1, 0.05], [-0.22, 0.0], [-0.12, -0.05], [0, -0.04]];
      add(child('wingL', -0.05, 0.13, 0), wingGeo(w, false), brown);
      add(child('wingR', 0.05, 0.13, 0), wingGeo(w, true), brown);
      break;
    }
    case 'gnome_bot': {
      add(root, new THREE.CylinderGeometry(0.11, 0.14, 0.24, 12), cream, 0, 0.16);
      add(root, new THREE.SphereGeometry(0.04, 8, 6), ink, -0.07, 0.04);
      add(root, new THREE.SphereGeometry(0.04, 8, 6), ink, 0.07, 0.04);
      const h = child('head', 0, 0.3);
      add(h, new THREE.SphereGeometry(0.1, 12, 8), cream, 0, 0.06);
      add(h, new THREE.BoxGeometry(0.12, 0.035, 0.03), mint, 0, 0.07, -0.085);
      add(h, new THREE.ConeGeometry(0.1, 0.22, 12), amber, 0, 0.24);
      add(root, new THREE.CylinderGeometry(0.03, 0.04, 0.07, 8), copper, 0.14, 0.14, -0.03, 0, 0, 0.3);
      break;
    }
    case 'watering_drone': {
      add(root, new THREE.SphereGeometry(0.15, 14, 10), cream, 0, 0, 0, 0, 0, 0, 1, 0.6, 1);
      add(root, new THREE.CylinderGeometry(0.07, 0.07, 0.1, 12), pm(0x2eb3ff, { transparent: true, opacity: 0.7, roughness: 0.1 }), 0, -0.1);
      add(root, new THREE.TorusGeometry(0.15, 0.012, 6, 20).rotateX(Math.PI / 2), mint);
      add(root, new THREE.ConeGeometry(0.03, 0.08, 8).rotateX(Math.PI), copper, 0, -0.18);
      add(root, new THREE.CylinderGeometry(0.012, 0.012, 0.1, 6), copper, 0, 0.1);
      const p = child('prop', 0, 0.15);
      add(p, new THREE.BoxGeometry(0.5, 0.008, 0.04), ink);
      add(p, new THREE.BoxGeometry(0.04, 0.008, 0.5), ink);
      break;
    }
    case 'mushroom_a':
    case 'mushroom_b': {
      const glowCap = pm(name === 'mushroom_a' ? 0x4ee6d9 : 0xa869ff, { emissive: name === 'mushroom_a' ? 0x4ee6d9 : 0xa869ff, emissiveIntensity: 1.6, roughness: 0.4 }, 'GlowMushroom');
      const tall = name === 'mushroom_b' ? 1.5 : 1;
      add(root, new THREE.CylinderGeometry(0.03, 0.045, 0.18 * tall, 8), cream, 0, 0.09 * tall);
      add(root, new THREE.SphereGeometry(name === 'mushroom_a' ? 0.12 : 0.08, 12, 6, 0, TAU, 0, Math.PI / 2), glowCap, 0, 0.17 * tall, 0, 0, 0, 0, 1, 0.7, 1);
      break;
    }
    case 'log':
      add(root, new THREE.CylinderGeometry(0.2, 0.23, 1.5, 10).rotateZ(Math.PI / 2), wood, 0, 0.2);
      add(root, new THREE.SphereGeometry(0.12, 8, 4, 0, TAU, 0, Math.PI / 2), pm(0x5e9c3a, { roughness: 0.9 }), 0.3, 0.36, 0, 0, 0, 0, 1.6, 0.5, 1.2);
      break;
    case 'bench':
      add(root, new THREE.BoxGeometry(1.4, 0.07, 0.42), wood, 0, 0.44);
      add(root, new THREE.BoxGeometry(1.4, 0.3, 0.05), wood, 0, 0.7, 0.2, -0.15);
      for (const x of [-0.6, 0.6]) add(root, new THREE.BoxGeometry(0.08, 0.44, 0.38), cream, x, 0.22);
      break;
    case 'beehive':
      add(root, new THREE.CylinderGeometry(0.06, 0.06, 0.4, 6), wood, 0, 0.2);
      add(root, new THREE.BoxGeometry(0.5, 0.2, 0.4), cream, 0, 0.5);
      add(root, new THREE.BoxGeometry(0.5, 0.2, 0.4), amber, 0, 0.7);
      add(root, new THREE.ConeGeometry(0.4, 0.2, 4).rotateY(Math.PI / 4), wood, 0, 0.9);
      add(root, new THREE.BoxGeometry(0.12, 0.04, 0.02), ink, 0, 0.44, -0.2);
      break;
    case 'planter_box':
      add(root, new THREE.BoxGeometry(1.1, 0.35, 0.5), wood, 0, 0.175);
      add(root, new THREE.BoxGeometry(1.0, 0.16, 0.42), pm(0x6baf4b, { roughness: 0.9 }), 0, 0.4);
      for (let i = 0; i < 4; i++) add(root, new THREE.SphereGeometry(0.06, 6, 4), pm([0xff8fb8, 0xffe27a, 0xa869ff, 0xffffff][i]), -0.36 + i * 0.24, 0.5, (i % 2) * 0.1 - 0.05);
      break;
    case 'stepping_stone':
      add(root, new THREE.CylinderGeometry(0.3, 0.33, 0.06, 9), stone, 0, 0.03);
      break;
    case 'sprinkler': {
      add(root, new THREE.CylinderGeometry(0.03, 0.05, 0.2, 8), copper, 0, 0.1);
      const h = child('head', 0, 0.2);
      add(h, new THREE.BoxGeometry(0.22, 0.02, 0.03), copper);
      break;
    }
    case 'windchime': {
      add(root, new THREE.CylinderGeometry(0.025, 0.03, 1.5, 6), wood, 0, 0.75);
      add(root, new THREE.BoxGeometry(0.35, 0.03, 0.03), wood, 0.15, 1.48);
      const c = child('chimes', 0.3, 1.46);
      add(c, new THREE.CylinderGeometry(0.06, 0.06, 0.02, 10), copper, 0, -0.03);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU;
        add(c, new THREE.CylinderGeometry(0.008, 0.008, 0.18 + i * 0.03, 5), copper, Math.cos(a) * 0.045, -0.15 - i * 0.015, Math.sin(a) * 0.045);
      }
      break;
    }
    default:
      add(root, new THREE.BoxGeometry(0.2, 0.2, 0.2), cream, 0, 0.1);
  }
  return root;
}

// ---- species table --------------------------------------------------------------------------------------------------

/** Gameplay size of each model (largest dimension, metres); null keeps the GLB's own size (static decor). */
const SPECIES: Record<string, { fit: number | null; prim: number; tintWings?: boolean }> = {
  butterfly: { fit: 0.5, prim: 0.5, tintWings: true },
  bee: { fit: 0.24, prim: 0.24 },
  dragonfly: { fit: 0.56, prim: 0.56 },
  bird: { fit: 0.5, prim: 0.5 },
  gnome_bot: { fit: 0.62, prim: 0.62 },
  watering_drone: { fit: 0.62, prim: 0.62 },
  mushroom_a: { fit: 0.42, prim: 0.42 },
  mushroom_b: { fit: 0.36, prim: 0.36 },
  log: { fit: null, prim: 1.5 },
  bench: { fit: null, prim: 1.4 },
  beehive: { fit: null, prim: 0.95 },
  planter_box: { fit: null, prim: 1.1 },
  stepping_stone: { fit: null, prim: 0.66 },
  sprinkler: { fit: null, prim: 0.25 },
  windchime: { fit: null, prim: 1.5 },
};

// ---- world data -----------------------------------------------------------------------------------------------------

interface V2 {
  x: number;
  z: number;
}

interface Perch extends V2 {
  /** Surface height (resolved by a ray down once), fallback until then. */
  y: number;
  done: boolean;
}

interface Board {
  o: BoardOrigin;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  flowers: Perch[];
  foliage: Perch[];
  water: V2[];
  lamps: V2[];
  shade: V2[];
  /** Ground spots outside the grid (birds land, drones visit). */
  ring: Perch[];
  hive: V2 | null;
  /** Gnome loop around the board, `off` metres outside the grid edge, sampled every LOOP_STEP for blocked stretches. */
  loopP: number;
  loopOff: number;
  /** Metres of open lane (runs of 2 m+). */
  laneRuns: number;
  loopBlocked: Uint8Array;
  entries: V2[];
  dist: number;
}

/** Offsets (metres outside the grid edge) tried for the gnome lane; the one with the most open ground wins. */
const LOOP_OFFS = [0.25, 0.8, 1.5, 2.3, 3.2];
const LOOP_STEP = 0.5;

// ---- creatures ------------------------------------------------------------------------------------------------------

interface Flyer {
  b: number;
  rank: number;
  on: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  /** 0 fly, 1 perch / hover, 2 flee. */
  st: number;
  t: number;
  target: Perch | null;
  hive: boolean;
  ph: number;
  color: THREE.Color;
}

interface Dragon {
  b: number;
  rank: number;
  on: boolean;
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  u: number;
  dur: number;
  hold: number;
  yaw: number;
  ph: number;
  x: number;
  y: number;
  z: number;
  flee: number;
}

interface Bird {
  b: number;
  rank: number;
  on: boolean;
  /** 0 away, 1 flying in, 2 on the ground, 3 flying off. */
  st: number;
  t: number;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  lx: number;
  ly: number;
  lz: number;
  dur: number;
  yaw: number;
  hop: number;
  peck: number;
  ph: number;
  vx: number;
  vy: number;
  vz: number;
}

interface Gnome {
  b: number;
  rank: number;
  on: boolean;
  s: number;
  dir: number;
  pause: number;
  walk: number;
  lat: number;
  latT: number;
  hop: number;
  hurry: number;
  head: number;
  headT: number;
  yaw: number;
  ph: number;
  /** Lane mode (null) walks the loop around the board; otherwise potters around this open spot. */
  home: { x: number; z: number; clr: number } | null;
  x: number;
  z: number;
  tx: number;
  tz: number;
  lean: number;
}

interface Drone {
  b: number;
  rank: number;
  on: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  tx: number;
  tz: number;
  ty: number;
  st: number;
  t: number;
  spin: number;
  yaw: number;
  ph: number;
  drop: number;
}

interface Petal {
  on: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  wx: number;
  wy: number;
  wz: number;
  st: number;
  t: number;
  s: number;
  fall: number;
  ph: number;
  b: number;
  ci: number;
}

const BUTTERFLY_COLORS = [0xffa940, 0x4ee6d9, 0xa869ff, 0x2eb3ff, 0xfff1c9, 0xff8fb8, 0xffd84a].map((c) => new THREE.Color(c));
const PETAL_COLORS = [0xffc2d6, 0xffe0ec, 0xfff6e0, 0xffd27a, 0x9ccc5a, 0x7fb84a, 0xc9e27a, 0xffb0c8].map((c) => new THREE.Color(c));

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---- the module -----------------------------------------------------------------------------------------------------

export function createAmbience(scene: THREE.Scene, def: GMapDef, origins: BoardOrigin[], quality: Quality): Ambience {
  const group = new THREE.Group();
  group.name = 'ambience';
  scene.add(group);
  let disposed = false;
  let q = quality;
  const C = G.cell;
  const W = def.grid[0]?.length ?? 1;
  const H = def.grid.length || 1;
  const nb = Math.max(1, origins.length);
  /** Many boards: each one gets a little less life (the camera sees one or two at a time). */
  const crowd = nb > 2 ? 0.7 : 1;

  const cell = (c: number, r: number) => def.grid[r]?.[c];

  // ---- surface heights ----
  // One ray down per perch, against a coarse 2 m grid index of the world's meshes / instances built once (raycasting
  // the whole scene costs milliseconds with thousands of instanced plants). Meshes wider than 24 m (terrain, water)
  // are skipped: the ground is y = 0.
  const ray = new THREE.Raycaster();
  ray.far = 15;
  const down = new THREE.Vector3(0, -1, 0);
  let rayBudget = 0;
  type Cand = { obj: THREE.Mesh; inst: number; x: number; z: number; r: number; top: number; foot: number };
  let index: Map<number, Cand[]> | null = null;
  const key = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
  const probe = new THREE.Mesh();
  const instM = new THREE.Matrix4();
  const hits: THREE.Intersection[] = [];
  const buildIndex = () => {
    index = new Map();
    const bs = new THREE.Sphere();
    const bb = new THREE.Box3();
    const add = (c: Cand) => {
      const { x, z, r } = c;
      for (let cx = Math.floor((x - r) / 2); cx <= Math.floor((x + r) / 2); cx++)
        for (let cz = Math.floor((z - r) / 2); cz <= Math.floor((z + r) / 2); cz++) {
          const k = key(cx, cz);
          let l = index!.get(k);
          if (!l) index!.set(k, (l = []));
          l.push(c);
        }
    };
    scene.updateMatrixWorld();
    for (const child of scene.children) {
      if (child === group) continue;
      child.traverseVisible((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || (mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh) return;
        const m = mesh.material as THREE.Material;
        if (!m || Array.isArray(m) || (m.transparent && m.opacity < 0.7)) return;
        const geo = mesh.geometry;
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        if (!geo.boundingBox) geo.computeBoundingBox();
        const im = mesh as THREE.InstancedMesh;
        if (im.isInstancedMesh) {
          for (let i = 0; i < im.count; i++) {
            im.getMatrixAt(i, instM);
            instM.premultiply(im.matrixWorld);
            bs.copy(geo.boundingSphere!).applyMatrix4(instM);
            if (bs.radius > 12) continue;
            bb.copy(geo.boundingBox!).applyMatrix4(instM);
            const foot = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2;
            add({ obj: im, inst: i, x: bs.center.x, z: bs.center.z, r: bs.radius, top: bb.max.y, foot });
          }
        } else {
          if (!geo.boundingBox) geo.computeBoundingBox();
          bb.copy(geo.boundingBox!).applyMatrix4(mesh.matrixWorld);
          if (bb.max.x - bb.min.x > 24 || bb.max.z - bb.min.z > 24) return;
          add({ obj: mesh, inst: -1, x: (bb.min.x + bb.max.x) / 2, z: (bb.min.z + bb.max.z) / 2, r: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2, top: bb.max.y, foot: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 });
        }
      });
    }
  };
  const surfaceY = (p: Perch) => {
    // A ray can cost a millisecond or two near dense plants: at most one per frame, until every perch is known.
    if (p.done || rayBudget <= 0) return p.y;
    rayBudget--;
    p.done = true;
    if (!index) buildIndex();
    return rayAt(p);
  };
  const rayAt = (p: Perch) => {
    const list = index!.get(key(Math.floor(p.x / 2), Math.floor(p.z / 2)));
    if (!list) return p.y;
    ray.set(_v.set(p.x, 14, p.z), down);
    let top = -1;
    for (const c of list) {
      hits.length = 0;
      if (c.inst >= 0) {
        const im = c.obj as THREE.InstancedMesh;
        im.getMatrixAt(c.inst, instM);
        probe.geometry = im.geometry;
        probe.material = im.material;
        probe.matrixWorld.multiplyMatrices(im.matrixWorld, instM);
        probe.raycast(ray, hits);
      } else c.obj.raycast(ray, hits);
      for (const h of hits) if (h.point.y > top) top = h.point.y;
    }
    if (top >= 0) p.y = clamp(top, 0, 5) + 0.03;
    return p.y;
  };

  /**
   * True if nothing of the world taller than `maxTop` stands within `r` of a point (judged from footprints), so
   * a prop or a walking robot there is not buried in the border hedges.
   */
  const clearAt = (x: number, z: number, r: number, maxTop = 0.5) => {
    if (!index) buildIndex();
    for (let cx = Math.floor((x - r) / 2); cx <= Math.floor((x + r) / 2); cx++)
      for (let cz = Math.floor((z - r) / 2); cz <= Math.floor((z + r) / 2); cz++) {
        const l = index!.get(key(cx, cz));
        if (!l) continue;
        for (const c of l) {
          if (c.top <= maxTop) continue;
          const rr = c.foot * 0.75 + r;
          if ((c.x - x) ** 2 + (c.z - z) ** 2 < rr * rr) return false;
        }
      }
    return true;
  };

  // ---- boards ----
  const boards: Board[] = origins.map((o, bi) => {
    const rand = mulberry(9157 + bi * 101);
    const minX = o.x - (W * C) / 2;
    const minZ = o.z - (H * C) / 2;
    const bd: Board = {
      o,
      minX,
      maxX: minX + W * C,
      minZ,
      maxZ: minZ + H * C,
      flowers: [],
      foliage: [],
      water: [],
      lamps: [],
      shade: [],
      ring: [],
      hive: null,
      loopP: 0,
      loopOff: 1,
      laneRuns: 0,
      loopBlocked: new Uint8Array(0),
      entries: def.entries.map((e) => cellToWorld(def, o, e.x, e.y)),
      dist: 0,
    };
    const pt = (c: number, r: number, j = 0.6) => cellToWorld(def, o, c + 0.5 + (rand() - 0.5) * j, r + 0.5 + (rand() - 0.5) * j);
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        const ch = cell(c, r);
        if (ch === 'f') {
          for (let k = 0; k < 2; k++) {
            const p = pt(c, r, 0.75);
            bd.flowers.push({ ...p, y: 0.5, done: false });
          }
        } else if (ch === 'T') {
          const p = pt(c, r, 0.5);
          bd.foliage.push({ ...p, y: 1.2, done: false });
          if (rand() < 0.5) bd.shade.push(pt(c, r, 1.6));
        } else if (ch === '~' || ch === 'o') {
          // Open water away from the bank reads best; any water cell will do.
          bd.water.push(pt(c, r, 0.5));
        } else if (ch === 'l') {
          bd.lamps.push(cellToWorld(def, o, c + 0.5, r + 0.5));
        }
      }
    return bd;
  });

  /**
   * True if a world point outside the grid is a bad spot: near a portal, next to a path running off the edge, or on a
   * stream running on under the border (world.ts continues edge water outwards).
   */
  const badRing = (bd: Board, x: number, z: number, keep = 6) => {
    for (const e of bd.entries) if ((e.x - x) ** 2 + (e.z - z) ** 2 < keep * keep) return true;
    const col = Math.floor((x - bd.minX) / C);
    const row = Math.floor((z - bd.minZ) / C);
    const cc = clamp(col, 0, W - 1);
    const rr = clamp(row, 0, H - 1);
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const ch = cell(cc + dc, rr + dr);
        if (ch === '#' || ch === '=' || ch === 'E' || ch === 'G' || ch === '~' || ch === 'o') return true;
      }
    // Inside the grid is never "outside" decor.
    return col >= 0 && col < W && row >= 0 && row < H;
  };

  /** A point on the board's perimeter at arc length s, pushed `off` metres outward. */
  const perim = (bd: Board, s: number, off: number, out: { x: number; z: number; nx: number; nz: number; tx: number; tz: number }) => {
    const w = bd.maxX - bd.minX + 2 * off;
    const h = bd.maxZ - bd.minZ + 2 * off;
    const x0 = bd.minX - off;
    const z0 = bd.minZ - off;
    const P = 2 * (w + h);
    s = ((s % P) + P) % P;
    if (s < w) Object.assign(out, { x: x0 + s, z: z0, nx: 0, nz: -1, tx: 1, tz: 0 });
    else if (s < w + h) Object.assign(out, { x: x0 + w, z: z0 + (s - w), nx: 1, nz: 0, tx: 0, tz: 1 });
    else if (s < 2 * w + h) Object.assign(out, { x: x0 + w - (s - w - h), z: z0 + h, nx: 0, nz: 1, tx: -1, tz: 0 });
    else Object.assign(out, { x: x0, z: z0 + h - (s - 2 * w - h), nx: -1, nz: 0, tx: 0, tz: -1 });
    return out;
  };
  const pp = { x: 0, z: 0, nx: 0, nz: 0, tx: 0, tz: 0 };

  for (const bd of boards) {
    let best: Uint8Array | null = null;
    let bestFree = -1;
    for (const off of LOOP_OFFS) {
      const P = 2 * (bd.maxX - bd.minX + 2 * off + (bd.maxZ - bd.minZ + 2 * off));
      const n = Math.ceil(P / LOOP_STEP);
      const blocked = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        perim(bd, i * LOOP_STEP, off, pp);
        blocked[i] = badRing(bd, pp.x, pp.z, 6.5) || !clearAt(pp.x, pp.z, 0.3) ? 1 : 0;
      }
      // Single free samples are no use to a walker: count only runs of 4+ (2 m).
      let runs = 0;
      for (let i = 0, run = 0; i <= n; i++) {
        if (i < n && !blocked[i]) run++;
        else {
          if (run >= 4) runs += run;
          run = 0;
        }
      }
      if (runs > bestFree) {
        bestFree = runs;
        best = blocked;
        bd.loopOff = off;
        bd.laneRuns = runs * LOOP_STEP;
        bd.loopP = P;
      }
    }
    bd.loopBlocked = best!;
  }
  const loopFree = (bd: Board, s: number) => {
    const n = bd.loopBlocked.length;
    const i = ((Math.floor(s / LOOP_STEP) % n) + n) % n;
    return bd.loopBlocked[i] === 0;
  };

  // ---- static decor placement ----
  // Candidate spots: blocked decor cells inside the grid (R, T, f, l, s) and the ring outside it, kept only where the
  // world left open ground (the border ring is mostly hedges and trees) and where the whole footprint stays on decor
  // cells or outside the grid.
  type StaticItem = { name: string; x: number; z: number; yaw: number; s: number };
  type Spot = { x: number; z: number; clr: number };
  const statics: StaticItem[] = [];
  const mushrooms: StaticItem[] = [];
  const decorChar = (ch: string | undefined) => ch === 'R' || ch === 'T' || ch === 'f' || ch === 'l' || ch === 's';
  const RING8 = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
  const cellsOk = (bd: Board, x: number, z: number, r: number) => {
    for (const [dx, dz] of RING8) {
      const px = x + dx * r;
      const pz = z + dz * r;
      const col = Math.floor((px - bd.minX) / C);
      const row = Math.floor((pz - bd.minZ) / C);
      if (col >= 0 && col < W && row >= 0 && row < H) {
        if (!decorChar(cell(col, row))) return false;
      } else if (badRing(bd, px, pz)) return false;
      // Keep off the banks: rock cells by the water are half stream.
      const wc = Math.floor((x + dx * (r + 0.5) - bd.minX) / C);
      const wr = Math.floor((z + dz * (r + 0.5) - bd.minZ) / C);
      const wch = cell(wc, wr);
      if (wch === '~' || wch === 'o') return false;
    }
    return true;
  };
  const RADII = [0.8, 0.6, 0.45, 0.3, 0.15];
  const homes: Spot[][] = [];
  boards.forEach((bd, bi) => {
    const rand = mulberry(4211 + bi * 37);
    const spots: Spot[] = [];
    const mushSpots: V2[] = [];
    const consider = (x: number, z: number) => {
      for (const r of RADII)
        if (clearAt(x, z, r) && cellsOk(bd, x, z, r)) {
          spots.push({ x, z, clr: r });
          return;
        }
      if (clearAt(x, z, 0.04, 0.6) && cellsOk(bd, x, z, 0.12)) mushSpots.push({ x, z });
    };
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++)
        if (decorChar(cell(c, r)))
          for (let k = 0; k < 2; k++) {
            const p = cellToWorld(def, bd.o, c + 0.15 + rand() * 0.7, r + 0.15 + rand() * 0.7);
            consider(p.x, p.z);
          }
    const P0 = 2 * (bd.maxX - bd.minX + (bd.maxZ - bd.minZ));
    for (let k = 0; k < 360; k++) {
      perim(bd, rand() * P0, 0, pp);
      const d = 0.2 + rand() * 6;
      consider(pp.x + pp.nx * d, pp.z + pp.nz * d);
    }
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    const placed: V2[] = [];
    const take = (r: number, sep: number, near?: V2) => {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < spots.length; i++) {
        const sp = spots[i];
        if (sp.clr < r || !placed.every((p) => (p.x - sp.x) ** 2 + (p.z - sp.z) ** 2 > sep * sep)) continue;
        const d = near ? (near.x - sp.x) ** 2 + (near.z - sp.z) ** 2 : 0;
        if (d < bestD) {
          bestD = d;
          best = i;
          if (!near) break;
        }
      }
      if (best < 0) return null;
      const sp = spots.splice(best, 1)[0];
      placed.push(sp);
      return sp;
    };
    const faceIn = (x: number, z: number) => yawOf(bd.o.x - x, bd.o.z - z);
    const flowerC = bd.flowers.length ? bd.flowers.reduce((a, f) => ({ x: a.x + f.x / bd.flowers.length, z: a.z + f.z / bd.flowers.length }), { x: 0, z: 0 }) : null;
    if (flowerC) {
      const h = take(0.45, 2, flowerC);
      if (h) {
        statics.push({ name: 'beehive', x: h.x, z: h.z, yaw: faceIn(h.x, h.z), s: 1 });
        bd.hive = { x: h.x, z: h.z };
      }
    }
    const items: [string, number, number][] = [['bench', 2, 0.6], ['log', 2, 0.6], ['planter_box', 2, 0.6], ['windchime', 1, 0.3], ['sprinkler', 3, 0.15]];
    for (const [name, n, r] of items)
      for (let i = 0; i < n; i++) {
        const sp = take(r, 2.2);
        if (!sp) continue;
        const yaw = name === 'bench' ? faceIn(sp.x, sp.z) : rand() * TAU;
        statics.push({ name, x: sp.x, z: sp.z, yaw, s: 0.9 + rand() * 0.2 });
      }
    // Stepping stones in little runs of two or three.
    for (let i = 0; i < 4; i++) {
      const sp = take(0.3, 1.5);
      if (!sp) continue;
      const a = rand() * TAU;
      const k = 2 + Math.floor(rand() * 2);
      for (let j = 0; j < k; j++) {
        const x = sp.x + Math.cos(a) * (j - (k - 1) / 2) * 0.5 * Math.min(1, sp.clr / 0.45);
        const z = sp.z + Math.sin(a) * (j - (k - 1) / 2) * 0.5 * Math.min(1, sp.clr / 0.45);
        statics.push({ name: 'stepping_stone', x, z, yaw: rand() * TAU, s: 0.55 + rand() * 0.2 });
      }
    }
    // Gnome homes (where a gnome potters about when there is no open lane around the board).
    const hs: Spot[] = [];
    for (let i = 0; i < 4; i++) {
      const sp = take(0.3, 3);
      if (sp) hs.push(sp);
    }
    homes.push(hs);
    // Glowing mushrooms: tucked at the foot of the plants and in open corners.
    const clumpN = Math.min(10, 2 + Math.ceil((mushSpots.length + spots.length) / 25));
    for (let i = 0; i < clumpN; i++) {
      const fromSpots = spots.length && (rand() < 0.4 || !mushSpots.length);
      const p = fromSpots ? spots.splice(Math.floor(rand() * spots.length), 1)[0] : mushSpots.length ? mushSpots.splice(Math.floor(rand() * mushSpots.length), 1)[0] : null;
      if (!p) break;
      const k = 2 + Math.floor(rand() * 3);
      for (let j = 0; j < k; j++)
        mushrooms.push({ name: rand() < 0.55 ? 'mushroom_a' : 'mushroom_b', x: p.x + (rand() - 0.5) * 0.3, z: p.z + (rand() - 0.5) * 0.3, yaw: rand() * TAU, s: 0.7 + rand() * 0.6 });
    }
    // Birds land on the border canopy (heights resolved by a ray) and on any open spot left.
    for (let i = 0; i < 10; i++) {
      perim(bd, rand() * P0, 0, pp);
      const d = 1 + rand() * 4;
      const x = pp.x + pp.nx * d;
      const z = pp.z + pp.nz * d;
      if (!badRing(bd, x, z)) bd.ring.push({ x, z, y: 1.5, done: false });
    }
    for (let i = 0; i < 4 && spots.length; i++) {
      const sp = spots.pop()!;
      bd.ring.push({ x: sp.x, z: sp.z, y: 0, done: true });
    }
  });

  // ---- herds ----
  const herds = new Map<string, Herd>();
  const ownMats: THREE.Material[] = [];
  const makeHerd = (name: string, cap: number, opts: HerdOpts) => {
    const sp = SPECIES[name];
    primMats = ownMats;
    const h = new Herd(group, rigFrom(primitive(name), sp.prim, !!sp.tintWings), cap, opts);
    herds.set(name, h);
    return h;
  };

  // ---- creature populations ----
  const flyers: Flyer[] = [];
  const bees: Flyer[] = [];
  const dragons: Dragon[] = [];
  const birds: Bird[] = [];
  const gnomes: Gnome[] = [];
  const drones: Drone[] = [];
  const caps = boards.map((bd) => {
    const nF = bd.flowers.length / 2;
    const nT = bd.foliage.length;
    const nW = bd.water.length;
    return {
      butterfly: Math.round(clamp(4 + nF * 0.5 + nT * 0.12, 4, 16) * crowd),
      bee: bd.flowers.length ? Math.round(clamp(2 + nF * 0.3, 2, 8) * crowd) : 0,
      dragon: nW ? Math.round(clamp(1 + nW / 10, 1, 5) * crowd) : 0,
      firefly: Math.round(clamp(6 + bd.lamps.length * 5 + nW * 0.4 + nT * 0.3, 8, 48) * crowd),
      gnome: bd.loopP > 120 ? 3 : 2,
      drone: nF > 20 ? 2 : 1,
      bird: 2,
    };
  });
  boards.forEach((bd, b) => {
    const rand = mulberry(777 + b * 13);
    const cp = caps[b];
    for (let i = 0; i < cp.butterfly; i++) {
      const p = bd.flowers[Math.floor(rand() * bd.flowers.length)] ?? bd.foliage[0] ?? { x: bd.o.x, z: bd.o.z, y: 0.4, done: true };
      flyers.push({ b, rank: i, on: true, x: p.x, y: 1 + rand(), z: p.z, vx: 0, vy: 0, vz: 0, yaw: rand() * TAU, st: 0, t: rand() * 3, target: null, hive: false, ph: rand() * TAU, color: BUTTERFLY_COLORS[Math.floor(rand() * BUTTERFLY_COLORS.length)].clone().lerp(WHITE, 0.15) });
    }
    for (let i = 0; i < cp.bee; i++) {
      const p = bd.flowers[Math.floor(rand() * bd.flowers.length)];
      bees.push({ b, rank: i, on: true, x: p.x, y: 0.8, z: p.z, vx: 0, vy: 0, vz: 0, yaw: 0, st: 0, t: rand(), target: null, hive: false, ph: rand() * TAU, color: WHITE });
    }
    for (let i = 0; i < cp.dragon; i++) {
      const p = bd.water[Math.floor(rand() * bd.water.length)];
      dragons.push({ b, rank: i, on: true, fx: p.x, fz: p.z, tx: p.x, tz: p.z, u: 1, dur: 1, hold: rand() * 2, yaw: rand() * TAU, ph: rand() * TAU, x: p.x, y: 0.5, z: p.z, flee: 0 });
    }
    for (let i = 0; i < cp.bird; i++)
      birds.push({ b, rank: i, on: true, st: 0, t: 2 + rand() * 10 + i * 6, x: 0, y: -50, z: 0, sx: 0, sy: 0, sz: 0, lx: 0, ly: 0, lz: 0, dur: 1, yaw: 0, hop: 0, peck: 0, ph: rand() * TAU, vx: 0, vy: 0, vz: 0 });
    for (let i = 0; i < cp.gnome; i++) {
      const lane = bd.laneRuns >= 6;
      let sl = rand() * bd.loopP;
      for (let k = 0; k < 60 && lane && !loopFree(bd, sl); k++) sl = rand() * bd.loopP;
      const home = lane ? null : homes[b][i] ?? null;
      const on = lane ? loopFree(bd, sl) : !!home;
      gnomes.push({ b, rank: i, on, s: sl, dir: rand() < 0.5 ? -1 : 1, pause: rand() * 2, walk: rand() * 10, lat: 0, latT: 0, hop: 0, hurry: 0, head: 0, headT: 0, yaw: rand() * TAU, ph: rand() * TAU, home, x: home?.x ?? 0, z: home?.z ?? 0, tx: home?.x ?? 0, tz: home?.z ?? 0, lean: 0 });
    }
    for (let i = 0; i < cp.drone; i++) {
      const p = bd.ring[i % Math.max(1, bd.ring.length)] ?? { x: bd.minX - 2, z: bd.minZ - 2 };
      drones.push({ b, rank: i, on: true, x: p.x, y: 2.4, z: p.z, vx: 0, vz: 0, tx: p.x, tz: p.z, ty: 2.4, st: 1, t: rand() * 2, spin: 0, yaw: 0, ph: rand() * TAU, drop: 0 });
    }
  });
  const fireflyAnchors: { x: number; z: number; y: number; r: number; b: number; rank: number; ph: number; w: number; on: boolean }[] = [];
  boards.forEach((bd, b) => {
    const rand = mulberry(3331 + b * 7);
    const n = caps[b].firefly;
    const pools: [V2[], number, number, number][] = [
      [bd.lamps, 0.55, 0.9, 1.0],
      [bd.shade, 0.25, 0.8, 0.9],
      [bd.water, 0.2, 0.5, 1.1],
      [bd.ring, 1, 0.5, 1.2],
    ];
    for (let i = 0; i < n; i++) {
      let pick = rand();
      let a: V2 | undefined;
      let y = 0.8;
      let r = 1;
      for (const [pool, w, py, pr] of pools) {
        if (!pool.length) continue;
        if (pick < w || pool === bd.ring) {
          a = pool[Math.floor(rand() * pool.length)];
          y = py;
          r = pr;
          break;
        }
        pick -= w;
      }
      if (!a) a = { x: bd.o.x, z: bd.o.z };
      fireflyAnchors.push({ x: a.x, z: a.z, y: y + rand() * 0.8, r: r * (0.4 + rand() * 0.8), b, rank: i, ph: rand() * TAU, w: 0.4 + rand() * 0.6, on: true });
    }
  });
  const petalCap = Math.min(300, 70 + 45 * nb);
  const petals: Petal[] = Array.from({ length: petalCap }, (_, i) => ({ on: false, x: 0, y: -10, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, st: 0, t: Math.random() * 6, s: 1, fall: 0.3, ph: i * 1.7, b: 0, ci: i % PETAL_COLORS.length }));

  const H_BUTTERFLY = makeHerd('butterfly', Math.max(1, flyers.length), { cast: q === 'high' });
  const H_BEE = makeHerd('bee', Math.max(1, bees.length), {});
  const H_DRAGON = makeHerd('dragonfly', Math.max(1, dragons.length), {});
  const H_BIRD = makeHerd('bird', Math.max(1, birds.length), { cast: q !== 'low' });
  const H_GNOME = makeHerd('gnome_bot', Math.max(1, gnomes.length), { cast: true });
  const H_DRONE = makeHerd('watering_drone', Math.max(1, drones.length), { cast: true });
  const staticCount = (name: string) => statics.filter((s) => s.name === name).length;
  const staticNames = ['beehive', 'bench', 'log', 'planter_box', 'stepping_stone'];
  for (const n of staticNames) makeHerd(n, Math.max(1, staticCount(n)), { cast: n !== 'stepping_stone', receive: true });
  const H_CHIME = makeHerd('windchime', Math.max(1, staticCount('windchime')), { cast: true, receive: true });
  const H_SPRINKLER = makeHerd('sprinkler', Math.max(1, staticCount('sprinkler')), { cast: true, receive: true });
  makeHerd('mushroom_a', Math.max(1, mushrooms.filter((m) => m.name === 'mushroom_a').length), { cast: false, receive: true });
  makeHerd('mushroom_b', Math.max(1, mushrooms.filter((m) => m.name === 'mushroom_b').length), { cast: false, receive: true });

  const fillStatics = () => {
    for (const n of [...staticNames, 'mushroom_a', 'mushroom_b']) {
      const h = herds.get(n)!;
      h.begin();
      for (const s of n.startsWith('mushroom') ? mushrooms : statics) {
        if (s.name !== n) continue;
        h.put(compose(_mb, s.x, 0, s.z, s.yaw, 0, 0, s.s), 0, s.yaw, 0);
      }
      h.end();
    }
  };
  const _mb = new THREE.Matrix4();
  fillStatics();

  let mushroomGlow: { m: THREE.MeshStandardMaterial; base: number }[] = [];
  const collectGlow = () => {
    mushroomGlow = [];
    for (const n of ['mushroom_a', 'mushroom_b']) for (const m of herds.get(n)!.rig.glow) mushroomGlow.push({ m, base: m.emissiveIntensity });
  };
  collectGlow();

  // ---- points: fireflies and water drops ----
  const glowTex = glowTexture();
  const ffCap = Math.max(1, fireflyAnchors.length);
  const ffPos = new Float32Array(ffCap * 3);
  const ffCol = new Float32Array(ffCap * 3);
  const ffGeo = new THREE.BufferGeometry();
  ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPos, 3).setUsage(THREE.DynamicDrawUsage));
  ffGeo.setAttribute('color', new THREE.BufferAttribute(ffCol, 3).setUsage(THREE.DynamicDrawUsage));
  const ffMat = new THREE.PointsMaterial({ size: 0.34, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, toneMapped: false });
  const fireflies = new THREE.Points(ffGeo, ffMat);
  fireflies.frustumCulled = false;
  group.add(fireflies);
  const ffDim = new Float32Array(ffCap);

  const dropCap = 96;
  const dropPos = new Float32Array(dropCap * 3);
  const dropVel = new Float32Array(dropCap * 3);
  const dropLife = new Float32Array(dropCap);
  const dropGeo = new THREE.BufferGeometry();
  dropGeo.setAttribute('position', new THREE.BufferAttribute(dropPos, 3).setUsage(THREE.DynamicDrawUsage));
  const dropMat = new THREE.PointsMaterial({ size: 0.09, map: glowTex, color: new THREE.Color(0.75, 0.92, 1.3), transparent: true, depthWrite: false, sizeAttenuation: true, opacity: 0.9 });
  const drops = new THREE.Points(dropGeo, dropMat);
  drops.frustumCulled = false;
  group.add(drops);
  let dropNext = 0;
  const emitDrop = (x: number, y: number, z: number) => {
    const i = dropNext;
    dropNext = (dropNext + 1) % dropCap;
    dropPos[i * 3] = x + (Math.random() - 0.5) * 0.08;
    dropPos[i * 3 + 1] = y;
    dropPos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.08;
    const a = Math.random() * TAU;
    const sp = 0.2 + Math.random() * 0.35;
    dropVel[i * 3] = Math.cos(a) * sp;
    dropVel[i * 3 + 1] = -0.6 - Math.random() * 0.5;
    dropVel[i * 3 + 2] = Math.sin(a) * sp;
    dropLife[i] = 1.4;
  };

  // ---- petals ----
  const petalGeo = (() => {
    const sh = new THREE.Shape();
    sh.moveTo(0, -0.06);
    sh.quadraticCurveTo(0.05, -0.01, 0, 0.06);
    sh.quadraticCurveTo(-0.05, -0.01, 0, -0.06);
    return new THREE.ShapeGeometry(sh, 3);
  })();
  const petalMat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.65 });
  const petalMesh = new THREE.InstancedMesh(petalGeo, petalMat, petalCap);
  petalMesh.frustumCulled = false;
  petalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < petalCap; i++) petalMesh.setColorAt(i, PETAL_COLORS[i % PETAL_COLORS.length]);
  petalMesh.count = 0;
  group.add(petalMesh);

  // ---- GLB ----
  const glbMats: THREE.Material[] = [];
  new GLTFLoader()
    .loadAsync('/models/garden/decor.glb')
    .then((gltf) => {
      if (disposed) return;
      gltf.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) for (const mm of Array.isArray(m) ? m : [m]) if (!glbMats.includes(mm)) glbMats.push(mm);
      });
      for (const [name, h] of herds) {
        const node = gltf.scene.getObjectByName(`Decor_${name}`);
        if (!node) continue;
        const sp = SPECIES[name];
        let fit = sp.fit;
        if (fit === null) {
          // Static decor keeps its size unless it is clearly off.
          const sz = new THREE.Box3().setFromObject(node).getSize(new THREE.Vector3());
          const md = Math.max(sz.x, sz.y, sz.z);
          if (!(md > sp.prim * 0.3 && md < sp.prim * 3)) fit = sp.prim;
        }
        try {
          const rig = rigFrom(node, fit, !!sp.tintWings);
          if (rig.parts.length) h.setRig(rig);
        } catch (err) {
          console.warn(`Garden ambience: Decor_${name} unusable`, err);
        }
      }
      fillStatics();
      collectGlow();
    })
    .catch((err) => console.warn('Garden ambience: decor.glb not available; using primitives', err?.message ?? err));

  // ---- quality ----
  const applyQuality = () => {
    const f = QF[q];
    const n = (cap: number, min = 0) => Math.max(min, Math.round(cap * f));
    for (const c of flyers) c.on = c.rank < n(caps[c.b].butterfly, 2);
    for (const c of bees) c.on = c.rank < n(caps[c.b].bee, caps[c.b].bee ? 1 : 0);
    for (const c of dragons) c.on = c.rank < n(caps[c.b].dragon, caps[c.b].dragon ? 1 : 0);
    for (const c of birds) c.on = c.rank < (q === 'high' ? 2 : 1);
    for (const c of gnomes) c.on = c.rank < (q === 'low' ? 1 : caps[c.b].gnome) && (c.home ? true : loopFree(boards[c.b], c.s));
    for (const c of drones) c.on = c.rank < (q === 'low' ? 1 : caps[c.b].drone);
    for (const a of fireflyAnchors) a.on = a.rank < n(caps[a.b].firefly, 4);
    H_BUTTERFLY.setShadow(q === 'high');
    H_BIRD.setShadow(q !== 'low');
  };
  applyQuality();
  // Diagnostics for the lab.
  group.userData.stats = () => ({
    statics: statics.length,
    mushrooms: mushrooms.length,
    gnomes: gnomes.filter((g) => g.on).length,
    butterflies: flyers.filter((c) => c.on).length,
    bees: bees.filter((c) => c.on).length,
    dragonflies: dragons.filter((c) => c.on).length,
    fireflies: fireflyAnchors.filter((c) => c.on).length,
    lanes: boards.map((b) => b.loopOff),
    ring: boards.map((b) => b.ring.length),
    where: () => ({ statics: statics.map((s) => [s.name, +s.x.toFixed(1), +s.z.toFixed(1)]), gnomes: gnomes.map((g) => [+g.x.toFixed(1), +g.z.toFixed(1), !!g.home]) }),
  });
  const petalActive = () => Math.round(petalCap * (q === 'high' ? 1 : q === 'medium' ? 0.6 : 0.3));

  // ---- behaviour helpers ----
  const pickPerch = (bd: Board, c: Flyer, rand: () => number, awayX?: number, awayZ?: number) => {
    const pool = bd.flowers.length && (rand() < 0.8 || !bd.foliage.length) ? bd.flowers : bd.foliage.length ? bd.foliage : bd.ring;
    if (!pool.length) return null;
    let best = pool[Math.floor(rand() * pool.length)];
    // Prefer a nearby one (short hops), away from a scare.
    let bestS = Infinity;
    for (let k = 0; k < 4; k++) {
      const p = pool[Math.floor(rand() * pool.length)];
      let s = Math.hypot(p.x - c.x, p.z - c.z) * (0.5 + rand());
      if (awayX !== undefined && awayZ !== undefined) s -= Math.hypot(p.x - awayX, p.z - awayZ) * 2;
      if (s < bestS) {
        bestS = s;
        best = p;
      }
    }
    return best;
  };
  const rnd = Math.random;

  let wind = { x: 1, z: 0.3, s: 0.5 };
  const camPos = new THREE.Vector3();

  const updateButterflies = (dt: number, time: number) => {
    H_BUTTERFLY.begin();
    for (const c of flyers) {
      if (!c.on) continue;
      const bd = boards[c.b];
      let dvx = 0;
      let dvy = 0;
      let dvz = 0;
      let flap: number;
      c.t -= dt;
      if (c.st === 1) {
        // Perched: sit, wings slowly opening and closing.
        const ty = c.target ? surfaceY(c.target) : c.y;
        if (c.target) {
          c.x += (c.target.x - c.x) * Math.min(1, dt * 6);
          c.z += (c.target.z - c.z) * Math.min(1, dt * 6);
          c.y += (ty - c.y) * Math.min(1, dt * 6);
        }
        c.vx = c.vy = c.vz = 0;
        flap = 1.25 - 0.9 * Math.pow(0.5 + 0.5 * Math.sin(time * 1.8 + c.ph), 2);
        if (c.t <= 0) {
          c.target = pickPerch(bd, c, rnd);
          c.st = 0;
          c.t = 12;
          c.vy = 0.8;
        }
      } else {
        if (c.st === 2 && c.t <= 0) {
          c.st = 0;
          c.t = 12;
        }
        if (!c.target) c.target = pickPerch(bd, c, rnd);
        const tg = c.target;
        if (c.st === 2) {
          dvx = c.vx;
          dvz = c.vz;
          dvy = 1.2;
        } else if (tg) {
          const ty = surfaceY(tg);
          const dx = tg.x - c.x;
          const dz = tg.z - c.z;
          const dh = Math.hypot(dx, dz) || 1e-3;
          const sp = Math.min(1.25, dh * 1.6 + 0.25);
          const w = time * 1.3 + c.ph;
          dvx = (dx / dh) * sp + Math.cos(w) * 0.55 * Math.min(1, dh) + wind.x * wind.s * 0.25;
          dvz = (dz / dh) * sp + Math.sin(w * 1.3) * 0.55 * Math.min(1, dh) + wind.z * wind.s * 0.25;
          const cruise = ty + Math.min(1.5, dh * 0.4) + Math.sin(time * 2.3 + c.ph) * 0.18;
          dvy = (cruise - c.y) * 2;
          if (dh < 0.22 && Math.abs(c.y - ty) < 0.25) {
            c.st = 1;
            c.t = 2 + rnd() * 5;
          } else if (c.t <= 0) c.target = pickPerch(bd, c, rnd);
        }
        const k = Math.min(1, dt * (c.st === 2 ? 1.5 : 2.6));
        c.vx += (dvx - c.vx) * k;
        c.vy += (dvy - c.vy) * k;
        c.vz += (dvz - c.vz) * k;
        c.x += c.vx * dt;
        c.y = Math.max(0.15, c.y + c.vy * dt);
        c.z += c.vz * dt;
        flap = 0.35 + Math.sin(time * (c.st === 2 ? 30 : 21) + c.ph) * 0.95;
        if (c.vx * c.vx + c.vz * c.vz > 0.01) c.yaw += wrapAngle(yawOf(c.vx, c.vz) - c.yaw) * Math.min(1, dt * 6);
      }
      // Gentle body bob in time with the wings.
      const bob = c.st === 1 ? 0 : Math.sin(time * 21 + c.ph) * 0.02;
      H_BUTTERFLY.put(compose(_mb, c.x, c.y + bob, c.z, c.yaw, c.st === 1 ? 0 : clamp(c.vy * 0.3, -0.4, 0.4), 0, 1), flap, 0, 0, c.color);
    }
    H_BUTTERFLY.end();
  };

  const updateBees = (dt: number, time: number) => {
    H_BEE.begin();
    for (const c of bees) {
      if (!c.on) continue;
      const bd = boards[c.b];
      c.t -= dt;
      if (c.st === 2 && c.t <= 0) {
        c.st = 0;
        c.t = 0;
      }
      if (c.st !== 2 && (!c.target || c.t <= 0) && c.st !== 1) {
        c.hive = !!bd.hive && rnd() < 0.2;
        c.target = c.hive && bd.hive ? { x: bd.hive.x, z: bd.hive.z, y: 0.75, done: true } : bd.flowers[Math.floor(rnd() * bd.flowers.length)] ?? null;
        c.t = 10;
      }
      let tx = c.x;
      let ty = c.y;
      let tz = c.z;
      if (c.st === 2) {
        tx = c.x + c.vx;
        tz = c.z + c.vz;
        ty = 2;
      } else if (c.target) {
        tx = c.target.x;
        tz = c.target.z;
        ty = surfaceY(c.target) + 0.18;
      }
      const dx = tx - c.x;
      const dz = tz - c.z;
      const dh = Math.hypot(dx, dz) || 1e-3;
      if (c.st === 1) {
        // Hovering at a flower, little figure-eights.
        tx += Math.sin(time * 3.1 + c.ph) * 0.12;
        tz += Math.sin(time * 6.2 + c.ph) * 0.06;
        if (c.t <= 0) {
          c.st = 0;
          c.target = null;
        }
      } else if (c.st === 0 && dh < 0.3) {
        c.st = 1;
        c.t = 0.8 + rnd() * 2.2;
      }
      const sp = c.st === 2 ? 3 : c.st === 1 ? 2 : Math.min(2.4, dh * 2 + 0.5);
      const zig = c.st === 0 ? Math.sin(time * 9 + c.ph) * 0.9 : 0;
      const fx = dx / dh;
      const fz = dz / dh;
      const cruise = c.st === 0 ? ty + Math.min(0.9, dh * 0.3) : ty;
      const dvx = c.st === 1 ? (tx - c.x) * 4 : fx * sp - fz * zig;
      const dvz = c.st === 1 ? (tz - c.z) * 4 : fz * sp + fx * zig;
      const k = Math.min(1, dt * 5);
      c.vx += (dvx - c.vx) * k;
      c.vz += (dvz - c.vz) * k;
      c.vy += ((cruise - c.y) * 3 - c.vy) * k;
      c.x += c.vx * dt;
      c.y = Math.max(0.12, c.y + c.vy * dt);
      c.z += c.vz * dt;
      if (c.vx * c.vx + c.vz * c.vz > 0.04) c.yaw += wrapAngle(yawOf(c.vx, c.vz) - c.yaw) * Math.min(1, dt * 8);
      const buzz = Math.sin(time * 70 + c.ph) * 0.012;
      H_BEE.put(compose(_mb, c.x, c.y + buzz, c.z, c.yaw, 0, 0, 1), 0.4 + Math.sin(time * 90 + c.ph) * 0.6, 0, 0);
    }
    H_BEE.end();
  };

  const updateDragons = (dt: number, time: number) => {
    H_DRAGON.begin();
    for (const c of dragons) {
      if (!c.on) continue;
      const bd = boards[c.b];
      if (c.u < 1) {
        c.u = Math.min(1, c.u + dt / c.dur);
        const e = c.u * c.u * (3 - 2 * c.u);
        c.x = c.fx + (c.tx - c.fx) * e;
        c.z = c.fz + (c.tz - c.fz) * e;
      } else {
        c.hold -= dt;
        if (c.hold <= 0 && bd.water.length) {
          // Dart to another bit of water nearby (or anywhere on the water after a scare).
          let p = bd.water[Math.floor(rnd() * bd.water.length)];
          for (let k = 0; k < 5; k++) {
            const qp = bd.water[Math.floor(rnd() * bd.water.length)];
            const d = Math.hypot(qp.x - c.x, qp.z - c.z);
            if (d > 1 && d < 7) {
              p = qp;
              break;
            }
          }
          c.fx = c.x;
          c.fz = c.z;
          c.tx = p.x + (rnd() - 0.5) * 1.2;
          c.tz = p.z + (rnd() - 0.5) * 1.2;
          const d = Math.hypot(c.tx - c.fx, c.tz - c.fz);
          c.dur = Math.max(0.25, d / (c.flee > 0 ? 7 : 4.5));
          c.u = 0;
          c.hold = 0.6 + rnd() * 2.4;
          if (d > 0.1) c.yaw = yawOf(c.tx - c.fx, c.tz - c.fz);
        }
      }
      c.flee = Math.max(0, c.flee - dt);
      const hover = c.u >= 1 ? Math.sin(time * 3 + c.ph) * 0.04 : 0;
      const y = 0.38 + (c.flee > 0 ? 0.6 : 0) + Math.sin(time * 0.7 + c.ph) * 0.12 + hover;
      c.y += (y - c.y) * Math.min(1, dt * 4);
      const jx = c.u >= 1 ? Math.sin(time * 2.1 + c.ph) * 0.03 : 0;
      H_DRAGON.put(compose(_mb, c.x + jx, c.y, c.z, c.yaw, c.u < 1 ? -0.12 : 0, 0, 1), 0.15 + Math.sin(time * 55 + c.ph) * 0.35, 0, 0);
    }
    H_DRAGON.end();
  };

  const startBirdIn = (c: Bird, bd: Board) => {
    // Land on a spot outside the grid, or on top of a tree.
    let l: Perch | undefined;
    if (bd.foliage.length && rnd() < 0.4) l = bd.foliage[Math.floor(rnd() * bd.foliage.length)];
    if (!l && bd.ring.length) l = bd.ring[Math.floor(rnd() * bd.ring.length)];
    if (!l) {
      c.t = 10;
      return;
    }
    c.lx = l.x;
    c.lz = l.z;
    c.ly = surfaceY(l);
    const a = rnd() * TAU;
    c.sx = l.x + Math.cos(a) * 34;
    c.sz = l.z + Math.sin(a) * 34;
    c.sy = 10 + rnd() * 4;
    c.dur = 34 / 6.5;
    c.t = 0;
    c.st = 1;
    c.yaw = yawOf(c.lx - c.sx, c.lz - c.sz);
  };
  const startBirdOut = (c: Bird, awayX?: number, awayZ?: number) => {
    let a = rnd() * TAU;
    if (awayX !== undefined && awayZ !== undefined) a = Math.atan2(c.z - awayZ, c.x - awayX) + (rnd() - 0.5) * 0.8;
    c.vx = Math.cos(a) * 6.5;
    c.vz = Math.sin(a) * 6.5;
    c.vy = 2.6;
    c.st = 3;
    c.t = 0;
    c.yaw = yawOf(c.vx, c.vz);
  };

  const updateBirds = (dt: number, time: number) => {
    H_BIRD.begin();
    for (const c of birds) {
      if (!c.on) {
        if (c.st !== 0) {
          c.st = 0;
          c.t = 5;
        }
        continue;
      }
      const bd = boards[c.b];
      let flap = 0;
      let pitch = 0;
      c.t += c.st === 0 ? -dt : dt;
      if (c.st === 0) {
        if (c.t <= 0) startBirdIn(c, bd);
        if (c.st === 0) continue;
      }
      if (c.st === 1) {
        const u = Math.min(1, c.t / c.dur);
        const e = 1 - (1 - u) * (1 - u);
        c.x = c.sx + (c.lx - c.sx) * e;
        c.z = c.sz + (c.lz - c.sz) * e;
        c.y = c.ly + (c.sy - c.ly) * Math.pow(1 - u, 1.6);
        // Flap in bursts, glide between; flare before touch-down.
        const glide = Math.sin(time * 1.4 + c.ph) > 0.35 && u < 0.8;
        flap = u > 0.85 ? 0.3 + Math.sin(time * 26) * 1.0 : glide ? 0.25 : Math.sin(time * 16 + c.ph) * 1.0 + 0.2;
        pitch = u > 0.85 ? 0.35 : -0.08;
        if (u >= 1) {
          c.st = 2;
          c.t = 0;
          c.hop = 4 + rnd() * 6;
          c.peck = 0;
        }
      } else if (c.st === 2) {
        // Hop about, peck, look around; leave after a while.
        flap = -1.05;
        c.peck -= dt;
        if (c.peck <= 0) {
          c.peck = 0.6 + rnd() * 1.6;
          if (rnd() < 0.5) c.yaw += (rnd() - 0.5) * 2;
          else if (c.ly < 0.2) {
            c.lx += -Math.sin(c.yaw) * 0.12;
            c.lz += -Math.cos(c.yaw) * 0.12;
          }
        }
        const ph = c.peck % 0.6;
        const hopY = c.peck > 0.45 && c.ly < 0.2 ? Math.sin(((c.peck - 0.45) / 0.15) * Math.PI) * 0.06 : 0;
        c.x += (c.lx - c.x) * Math.min(1, dt * 8);
        c.z += (c.lz - c.z) * Math.min(1, dt * 8);
        c.y = c.ly + hopY;
        pitch = ph < 0.2 ? -0.6 * Math.sin((ph / 0.2) * Math.PI) : 0;
        if (c.t > c.hop) startBirdOut(c);
      } else if (c.st === 3) {
        c.x += c.vx * dt;
        c.z += c.vz * dt;
        c.vy = Math.max(0.6, c.vy - dt * 0.3);
        c.y += c.vy * dt;
        flap = Math.sin(time * 17 + c.ph) * 1.05 + 0.2;
        pitch = 0.25;
        if (c.t > 6) {
          c.st = 0;
          c.t = (q === 'high' ? 6 : 12) + rnd() * 14;
          continue;
        }
      }
      H_BIRD.put(compose(_mb, c.x, c.y, c.z, c.yaw, pitch, 0, 1), flap, 0, 0);
    }
    H_BIRD.end();
  };

  const gp = { x: 0, z: 0, nx: 0, nz: 0, tx: 0, tz: 0 };
  const updateGnomes = (dt: number, time: number) => {
    H_GNOME.begin();
    for (const c of gnomes) {
      if (!c.on) continue;
      const bd = boards[c.b];
      c.hurry = Math.max(0, c.hurry - dt);
      c.hop = Math.max(0, c.hop - dt);
      let moving = false;
      if (c.home) {
        // Pottering about an open spot: shuffle to a nearby point, stop, look around, lean in to inspect the plants.
        const h = c.home;
        if (c.pause > 0 && c.hurry <= 0) {
          c.pause -= dt;
          c.headT -= dt;
          if (c.headT <= 0) {
            c.headT = 0.7 + rnd() * 1.4;
            c.head = (rnd() - 0.5) * 1.8;
            c.lean = rnd() < 0.3 ? -0.3 : 0;
          }
          if (c.pause <= 0) {
            c.pause = 0;
            const rr = Math.max(0.05, h.clr - 0.22);
            const a = rnd() * TAU;
            c.tx = h.x + Math.cos(a) * rr * rnd();
            c.tz = h.z + Math.sin(a) * rr * rnd();
            c.lean = 0;
          }
        } else {
          const dx = c.tx - c.x;
          const dz = c.tz - c.z;
          const d = Math.hypot(dx, dz);
          if (c.hurry > 0) c.yaw += dt * 9;
          else if (d < 0.03) {
            c.pause = 1.5 + rnd() * 3.5;
          } else {
            const st = Math.min(d, 0.3 * dt);
            c.x += (dx / d) * st;
            c.z += (dz / d) * st;
            moving = true;
            c.walk += dt * 8;
            c.yaw += wrapAngle(yawOf(dx, dz) - c.yaw) * Math.min(1, dt * 5);
          }
          c.head *= 1 - Math.min(1, dt * 3);
        }
        const bob = moving ? Math.abs(Math.sin(c.walk)) * 0.03 : 0;
        const hop = c.hop > 0 ? Math.sin((c.hop / 0.45) * Math.PI) * 0.25 : 0;
        if (!moving && c.pause > 0 && Math.sin(time * 0.31 + c.ph) > 0.97) c.yaw += dt * 1.2;
        H_GNOME.put(compose(_mb, c.x, bob + hop, c.z, c.yaw, c.lean, moving ? Math.sin(c.walk) * 0.07 : 0, 1), 0, 0, c.head + (moving ? 0 : Math.sin(time * 0.9 + c.ph) * 0.1));
        continue;
      }
      if (c.pause > 0 && c.hurry <= 0) {
        c.pause -= dt;
        c.headT -= dt;
        if (c.headT <= 0) {
          c.headT = 0.6 + rnd() * 1.2;
          c.head = (rnd() - 0.5) * 1.6;
        }
      } else {
        const sp = c.hurry > 0 ? 1.6 : 0.42;
        const next = c.s + c.dir * (sp * dt + 0.6);
        if (!loopFree(bd, next)) {
          c.dir = -c.dir;
          c.pause = c.hurry > 0 ? 0 : 0.8 + rnd();
        } else {
          c.s += c.dir * sp * dt;
          moving = true;
          c.walk += dt * (c.hurry > 0 ? 16 : 8);
          c.head *= 1 - Math.min(1, dt * 3);
          if (c.hurry <= 0 && rnd() < dt * 0.12) {
            c.pause = 1.5 + rnd() * 3;
            if (rnd() < 0.35) c.dir = -c.dir;
          }
        }
      }
      if (Math.abs(c.lat - c.latT) < 0.02 || rnd() < dt * 0.05) c.latT = (rnd() - 0.5) * 0.4;
      c.lat += clamp(c.latT - c.lat, -dt * 0.2, dt * 0.2);
      perim(bd, c.s, bd.loopOff + c.lat, gp);
      c.x = gp.x;
      c.z = gp.z;
      const yaw = yawOf(gp.tx * c.dir, gp.tz * c.dir);
      c.yaw += wrapAngle(yaw - c.yaw) * Math.min(1, dt * 5);
      const bob = moving ? Math.abs(Math.sin(c.walk)) * 0.035 : 0;
      const hop = c.hop > 0 ? Math.sin((c.hop / 0.45) * Math.PI) * 0.25 : 0;
      const roll = moving ? Math.sin(c.walk) * 0.08 : 0;
      H_GNOME.put(compose(_mb, gp.x, bob + hop, gp.z, c.yaw, 0, roll, 1), 0, 0, c.head + (moving ? 0 : Math.sin(time * 0.9 + c.ph) * 0.1));
    }
    H_GNOME.end();
  };

  const updateDrones = (dt: number, time: number) => {
    H_DRONE.begin();
    for (const c of drones) {
      if (!c.on) continue;
      const bd = boards[c.b];
      c.t -= dt;
      const dx = c.tx - c.x;
      const dz = c.tz - c.z;
      const d = Math.hypot(dx, dz);
      if (c.st === 0) {
        const sp = Math.min(1.9, d * 0.9 + 0.2);
        const k = Math.min(1, dt * 1.6);
        c.vx += ((dx / (d || 1)) * sp - c.vx) * k;
        c.vz += ((dz / (d || 1)) * sp - c.vz) * k;
        if (d < 0.25) {
          c.st = 1;
          c.t = 2.5 + rnd() * 3;
        }
      } else {
        c.vx *= 1 - Math.min(1, dt * 3);
        c.vz *= 1 - Math.min(1, dt * 3);
        c.x += dx * Math.min(1, dt * 2);
        c.z += dz * Math.min(1, dt * 2);
        // Watering: a sprinkle of drops when hovering over a flower bed.
        if (c.ty < 2.3 && q !== 'low') {
          c.drop += dt * 22;
          while (c.drop > 1) {
            c.drop -= 1;
            emitDrop(c.x, c.y - 0.15, c.z);
          }
        }
        if (c.t <= 0) {
          // Next stop: a flower bed (to water) or a spot outside the grid.
          const fl = bd.flowers.length && rnd() < 0.65 ? bd.flowers[Math.floor(rnd() * bd.flowers.length)] : null;
          const p = fl ?? bd.ring[Math.floor(rnd() * Math.max(1, bd.ring.length))] ?? { x: bd.minX - 2, z: bd.minZ - 2, y: 0, done: true };
          c.tx = p.x;
          c.tz = p.z;
          c.ty = fl ? Math.max(1.6, surfaceY(fl) + 1.1) : Math.max(2.4, surfaceY(p) + 1.3);
          c.st = 0;
        }
      }
      c.x += c.vx * dt;
      c.z += c.vz * dt;
      const ty = c.ty + Math.sin(time * 1.7 + c.ph) * 0.08;
      c.y += (ty - c.y) * Math.min(1, dt * 1.5);
      c.spin += dt * 38;
      const v2 = c.vx * c.vx + c.vz * c.vz;
      if (v2 > 0.04) c.yaw += wrapAngle(yawOf(c.vx, c.vz) - c.yaw) * Math.min(1, dt * 2.5);
      const fwd = Math.sqrt(v2);
      H_DRONE.put(compose(_mb, c.x, c.y, c.z, c.yaw, -fwd * 0.12, Math.sin(time * 1.3 + c.ph) * 0.05, 1), 0, c.spin, 0);
    }
    H_DRONE.end();
  };

  const updateFireflies = (dt: number, time: number) => {
    let n = 0;
    for (let i = 0; i < fireflyAnchors.length; i++) {
      const a = fireflyAnchors[i];
      if (!a.on) continue;
      const t = time * a.w + a.ph;
      ffDim[i] = Math.max(0, ffDim[i] - dt * 0.4);
      ffPos[n * 3] = a.x + Math.sin(t * 0.9) * a.r + Math.sin(t * 2.3) * 0.15;
      ffPos[n * 3 + 1] = a.y + Math.sin(t * 1.3 + 1) * 0.3;
      ffPos[n * 3 + 2] = a.z + Math.cos(t * 0.7) * a.r + Math.cos(t * 1.9) * 0.15;
      // Slow blink: mostly dim, a soft pulse every few seconds.
      const blink = Math.pow(Math.max(0, Math.sin(time * (0.9 + a.w) + a.ph * 3)), 6);
      const br = (0.35 + 2.6 * blink) * (1 - ffDim[i]);
      ffCol[n * 3] = 1.0 * br;
      ffCol[n * 3 + 1] = 0.92 * br;
      ffCol[n * 3 + 2] = 0.42 * br;
      n++;
    }
    ffGeo.setDrawRange(0, n);
    (ffGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (ffGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  };

  const updateDrops = (dt: number) => {
    for (let i = 0; i < dropCap; i++) {
      if (dropLife[i] <= 0) {
        dropPos[i * 3 + 1] = -100;
        continue;
      }
      dropLife[i] -= dt;
      dropVel[i * 3 + 1] -= 4 * dt;
      dropPos[i * 3] += dropVel[i * 3] * dt;
      dropPos[i * 3 + 1] += dropVel[i * 3 + 1] * dt;
      dropPos[i * 3 + 2] += dropVel[i * 3 + 2] * dt;
      if (dropPos[i * 3 + 1] < 0.3) dropLife[i] = 0;
    }
    (dropGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  };

  const spawnPetal = (p: Petal, boardW: number[], wsum: number) => {
    let r = rnd() * wsum;
    let b = 0;
    while (b < boardW.length - 1 && r > boardW[b]) r -= boardW[b++];
    const bd = boards[b];
    p.b = b;
    const src = rnd();
    if (src < 0.45 && bd.flowers.length) {
      const f = bd.flowers[Math.floor(rnd() * bd.flowers.length)];
      p.x = f.x;
      p.z = f.z;
      p.y = 0.5 + rnd() * 0.6;
    } else if (src < 0.75 && bd.foliage.length) {
      const f = bd.foliage[Math.floor(rnd() * bd.foliage.length)];
      p.x = f.x + (rnd() - 0.5) * 1.5;
      p.z = f.z + (rnd() - 0.5) * 1.5;
      p.y = 1.5 + rnd() * 2;
    } else {
      // Blown in from upwind, outside the board.
      const w = bd.maxX - bd.minX;
      const h = bd.maxZ - bd.minZ;
      p.x = bd.o.x - wind.x * (w * 0.5 + 2) + (rnd() - 0.5) * w * Math.abs(wind.z) * 1.2;
      p.z = bd.o.z - wind.z * (h * 0.5 + 2) + (rnd() - 0.5) * h * Math.abs(wind.x) * 1.2;
      p.y = 1.5 + rnd() * 3;
    }
    const leafy = src >= 0.45 && src < 0.75;
    p.ci = (leafy ? 4 : 0) + Math.floor(rnd() * 4);
    p.vx = wind.x;
    p.vz = wind.z;
    p.vy = 0;
    p.rx = rnd() * TAU;
    p.ry = rnd() * TAU;
    p.rz = rnd() * TAU;
    p.wx = (rnd() - 0.5) * 6;
    p.wy = (rnd() - 0.5) * 3;
    p.wz = (rnd() - 0.5) * 6;
    p.st = 0;
    p.t = 0;
    p.s = leafy ? 1.4 + rnd() * 0.5 : 0.9 + rnd() * 0.5;
    p.fall = 0.22 + rnd() * 0.2;
    p.on = true;
  };

  const boardW: number[] = [];
  const updatePetals = (dt: number, time: number) => {
    const active = petalActive();
    let wsum = 0;
    for (let b = 0; b < boards.length; b++) {
      const w = 1 / (1 + (boards[b].dist / 45) ** 2);
      boardW[b] = w;
      wsum += w;
    }
    let n = 0;
    for (let i = 0; i < active; i++) {
      const p = petals[i];
      if (!p.on) {
        p.t -= dt;
        if (p.t > 0) continue;
        spawnPetal(p, boardW, wsum);
      }
      if (p.st === 0) {
        const fl = Math.sin(time * 2.2 + p.ph);
        p.vx += (wind.x * wind.s * 1.6 + Math.sin(time * 1.3 + p.ph) * 0.35 - p.vx) * Math.min(1, dt * 1.5);
        p.vz += (wind.z * wind.s * 1.6 + Math.cos(time * 1.1 + p.ph) * 0.35 - p.vz) * Math.min(1, dt * 1.5);
        p.vy += (-p.fall + fl * 0.22 - p.vy) * Math.min(1, dt * 2);
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.rx += p.wx * dt;
        p.ry += p.wy * dt;
        p.rz += p.wz * dt;
        if (p.y <= 0.02) {
          p.y = 0.015;
          p.st = 1;
          p.t = 3 + rnd() * 5;
          p.rx = -Math.PI / 2;
          p.rz = 0;
        }
        const bd = boards[p.b];
        if (p.x < bd.minX - 10 || p.x > bd.maxX + 10 || p.z < bd.minZ - 10 || p.z > bd.maxZ + 10) {
          p.on = false;
          p.t = rnd();
          continue;
        }
      } else {
        p.t -= dt;
        if (p.t < 0) {
          p.s -= dt * 1.5;
          if (p.s <= 0.05) {
            p.on = false;
            p.t = rnd() * 2;
            continue;
          }
        }
      }
      compose(_mb, p.x, p.y, p.z, p.ry, p.rx, p.rz, p.s);
      petalMesh.setMatrixAt(n, _mb);
      petalMesh.setColorAt(n, PETAL_COLORS[p.ci]);
      n++;
    }
    petalMesh.count = n;
    petalMesh.instanceMatrix.needsUpdate = true;
    if (petalMesh.instanceColor) petalMesh.instanceColor.needsUpdate = true;
  };

  const updateChimes = (time: number) => {
    H_CHIME.begin();
    for (const s of statics) {
      if (s.name !== 'windchime') continue;
      const sw = Math.sin(time * 1.7 + s.x) * 0.12 * wind.s + Math.sin(time * 4.1 + s.z) * 0.04;
      H_CHIME.put(compose(_mb, s.x, 0, s.z, s.yaw, 0, 0, s.s), 0, 0, sw);
    }
    H_CHIME.end();
    H_SPRINKLER.begin();
    for (const s of statics) if (s.name === 'sprinkler') H_SPRINKLER.put(compose(_mb, s.x, 0, s.z, s.yaw, 0, 0, s.s), 0, time * 1.6 + s.x, 0);
    H_SPRINKLER.end();
  };

  let lastQ: Quality | null = null;
  let frame = 0;
  return {
    update(dt, time, camera) {
      if (disposed) return;
      dt = Math.min(dt, 0.1);
      frame++;
      rayBudget = 1;
      const wa = 0.7 + Math.sin(time * 0.05) * 0.5;
      wind = { x: Math.cos(wa), z: Math.sin(wa), s: 0.55 + Math.sin(time * 0.23) * 0.3 + Math.sin(time * 0.71) * 0.15 };
      camera.getWorldPosition(camPos);
      for (const bd of boards) bd.dist = Math.hypot(camPos.x - bd.o.x, camPos.z - bd.o.z);
      if (lastQ !== q) {
        applyQuality();
        lastQ = q;
      }
      updateButterflies(dt, time);
      updateBees(dt, time);
      updateDragons(dt, time);
      updateBirds(dt, time);
      updateGnomes(dt, time);
      updateDrones(dt, time);
      updateFireflies(dt, time);
      updateDrops(dt);
      updatePetals(dt, time);
      updateChimes(time);
      if (frame % 2 === 0) {
        const pulse = 0.82 + 0.18 * Math.sin(time * 1.3);
        for (const g of mushroomGlow) g.m.emissiveIntensity = g.base * pulse;
      }
    },

    scare(x, z, radius) {
      if (disposed) return;
      const r = Math.max(1, radius);
      const near = (px: number, pz: number, k: number) => (px - x) ** 2 + (pz - z) ** 2 < (r * k) ** 2;
      for (const c of flyers) {
        if (!c.on || !near(c.x, c.z, 2.2)) continue;
        const d = Math.hypot(c.x - x, c.z - z) || 1;
        c.st = 2;
        c.t = 1.6 + rnd() * 1.2;
        c.vx = ((c.x - x) / d) * (2.5 + rnd());
        c.vz = ((c.z - z) / d) * (2.5 + rnd());
        c.vy = 1.6;
        c.target = pickPerch(boards[c.b], c, rnd, x, z);
      }
      for (const c of bees) {
        if (!c.on || !near(c.x, c.z, 2)) continue;
        const d = Math.hypot(c.x - x, c.z - z) || 1;
        c.st = 2;
        c.t = 1.2 + rnd();
        c.vx = ((c.x - x) / d) * 3;
        c.vz = ((c.z - z) / d) * 3;
        c.target = null;
      }
      for (const c of dragons) {
        if (!c.on || !near(c.x, c.z, 2.2)) continue;
        c.flee = 2;
        c.hold = 0;
        c.u = 1;
      }
      for (const c of birds) {
        if (!c.on) continue;
        if ((c.st === 2 || c.st === 1) && near(c.x, c.z, 3)) startBirdOut(c, x, z);
      }
      for (const c of gnomes) {
        if (!c.on || !near(c.x, c.z, 2)) continue;
        c.hop = 0.45;
        c.hurry = c.home ? 0.6 : 2.2;
        c.pause = 0;
        if (c.home) continue;
        // Run away along the loop.
        perim(boards[c.b], c.s, boards[c.b].loopOff, gp);
        perim(boards[c.b], c.s + 1, boards[c.b].loopOff, pp);
        const farther = (pp.x - x) ** 2 + (pp.z - z) ** 2 > (gp.x - x) ** 2 + (gp.z - z) ** 2;
        c.dir = farther ? 1 : -1;
      }
      for (let i = 0; i < fireflyAnchors.length; i++) {
        const a = fireflyAnchors[i];
        if (near(a.x, a.z, 1.8)) ffDim[i] = 0.9;
      }
      for (const p of petals) {
        if (!p.on || !near(p.x, p.z, 1.5)) continue;
        const d = Math.hypot(p.x - x, p.z - z) || 1;
        const f = 1 - d / (r * 1.5);
        p.st = 0;
        p.s = Math.max(p.s, 0.9);
        p.vx += ((p.x - x) / d) * 3 * f;
        p.vz += ((p.z - z) / d) * 3 * f;
        p.vy = 1.5 + 2 * f;
        p.y = Math.max(p.y, 0.05);
        p.wx = (rnd() - 0.5) * 12;
        p.wz = (rnd() - 0.5) * 12;
      }
    },

    setQuality(nq) {
      q = nq;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(group);
      for (const h of herds.values()) h.dispose();
      herds.clear();
      ffGeo.dispose();
      ffMat.dispose();
      dropGeo.dispose();
      dropMat.dispose();
      glowTex.dispose();
      petalGeo.dispose();
      petalMat.dispose();
      petalMesh.dispose();
      for (const m of glbMats) m.dispose();
      for (const m of ownMats) m.dispose();
    },
  };
}
