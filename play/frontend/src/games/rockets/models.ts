// Procedural low-poly models for Rockets in a cel-shaded comic style: the launcher (a chunky finned rocket with its
// warhead loaded in the muzzle), the rocket projectile and the player droid. Every part gets an ink outline. Parts are
// merged into one mesh per material plus one outline mesh, so a droid costs a handful of draw calls; finished models
// are cached per colour and cloned, which shares geometry and materials between players.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { flat, hullGeometry, inkMaterial, toon } from '../../engine/toon';

type V3 = [number, number, number];

const CREAM = 0xf3ecd9;
const RED = 0xe8392e;
const YELLOW = 0xffc83a;
const STEEL = 0x59606e;
const DARK = 0x2c303a;
const LENS = 0x9be7ff;
const FIRE = 0xff9a1f;
const FIRE_CORE = 0xfff0a0;

// ---- geometry kit ------------------------------------------------------------------------------------------------

/** Collects transformed primitives, merges them per material and builds one ink hull around all of them. */
class Kit {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly hulls: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, mat: THREE.Material, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1], ink = true) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
      new THREE.Vector3(...scale),
    );
    if (ink) this.hulls.push(hullGeometry(geo).applyMatrix4(m));
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    g.applyMatrix4(m);
    let list = this.parts.get(mat);
    if (!list) this.parts.set(mat, (list = []));
    list.push(g);
    return this;
  }

  build(name = '', shadows = true): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      const lit = (mat as THREE.MeshToonMaterial).isMeshToonMaterial;
      mesh.castShadow = shadows && lit;
      mesh.receiveShadow = lit;
      group.add(mesh);
    }
    if (this.hulls.length) {
      const merged = mergeGeometries(this.hulls, false);
      for (const g of this.hulls) g.dispose();
      if (merged) group.add(new THREE.Mesh(merged, inkMaterial()));
    }
    return group;
  }
}

/** Cylinder lying along -Z: radiusFront at the -Z end. */
const tube = (radiusFront: number, radiusBack: number, length: number, sides = 8) => new THREE.CylinderGeometry(radiusFront, radiusBack, length, sides);
const ALONG_Z: V3 = [-Math.PI / 2, 0, 0];
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);

/** Four fins around the Z axis at radius r, centred at z. */
function fins(kit: Kit, mat: THREE.Material, r: number, z: number, size: V3) {
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    kit.add(box(...size), mat, [Math.cos(a) * r, Math.sin(a) * r, z], [0, 0, a - Math.PI / 2]);
  }
}

// ---- launcher ----------------------------------------------------------------------------------------------------

/** Where the loaded warhead sits; the client slides it back and forward again on every shot. */
export const WARHEAD_REST_Z = 0;

function buildLauncherFresh(accent: number): THREE.Group {
  const k = new Kit();
  const cream = toon(CREAM);
  const steel = toon(STEEL);
  const dark = toon(DARK);
  const team = toon(accent);
  const yellow = toon(YELLOW);

  // A fat rocket-shaped tube: cream body, yellow bands, team stripe.
  k.add(tube(0.1, 0.1, 0.72), cream, [0, 0, -0.28], ALONG_Z);
  k.add(tube(0.104, 0.104, 0.05), yellow, [0, 0, -0.16], ALONG_Z, undefined, false);
  k.add(tube(0.104, 0.104, 0.05), yellow, [0, 0, -0.5], ALONG_Z, undefined, false);
  k.add(tube(0.103, 0.103, 0.14), team, [0, 0, -0.33], ALONG_Z, undefined, false);
  // Tail: flared steel housing, dark nozzle with a fire-orange throat, big team fins.
  k.add(tube(0.1, 0.13, 0.16), steel, [0, 0, 0.16], ALONG_Z);
  k.add(tube(0.085, 0.085, 0.02), dark, [0, 0, 0.243], ALONG_Z, undefined, false);
  k.add(tube(0.05, 0.05, 0.02), flat(FIRE), [0, 0, 0.247], ALONG_Z, undefined, false);
  fins(k, team, 0.14, 0.14, [0.02, 0.1, 0.16]);
  // Muzzle collar.
  k.add(tube(0.118, 0.108, 0.09), steel, [0, 0, -0.66], ALONG_Z);
  // Scope with a bright lens, grips.
  k.add(box(0.055, 0.06, 0.26), dark, [0, 0.14, -0.22]);
  k.add(tube(0.03, 0.03, 0.02, 8), flat(LENS), [0, 0.14, -0.355], ALONG_Z, undefined, false);
  k.add(box(0.025, 0.04, 0.035), steel, [0, 0.105, -0.13]);
  k.add(box(0.025, 0.04, 0.035), steel, [0, 0.105, -0.3]);
  k.add(box(0.055, 0.17, 0.075), dark, [0, -0.13, 0], [0.3, 0, 0]);
  k.add(box(0.06, 0.06, 0.13), steel, [0, -0.095, -0.06]);
  k.add(box(0.05, 0.12, 0.06), dark, [0, -0.12, -0.4]);
  const body = k.build('launcher');

  const w = new Kit();
  w.add(new THREE.ConeGeometry(0.085, 0.24, 8), toon(RED), [0, 0, -0.82], ALONG_Z);
  w.add(tube(0.087, 0.087, 0.03), yellow, [0, 0, -0.705], ALONG_Z);
  const warhead = w.build('warhead');
  warhead.position.z = WARHEAD_REST_Z;
  body.add(warhead);
  return body;
}

const launchers = new Map<number, THREE.Group>();
/** A launcher pointing down -Z with its origin at the grip, painted in `accent`. */
export function buildLauncher(accent = RED): THREE.Group {
  let t = launchers.get(accent);
  if (!t) launchers.set(accent, (t = buildLauncherFresh(accent)));
  return t.clone(true);
}

// ---- rocket ------------------------------------------------------------------------------------------------------

let rocketTemplate: THREE.Group | null = null;
function buildRocketFresh(): THREE.Group {
  const k = new Kit();
  k.add(tube(0.07, 0.07, 0.38), toon(CREAM), [0, 0, 0], ALONG_Z);
  k.add(new THREE.ConeGeometry(0.07, 0.2, 8), toon(RED), [0, 0, -0.29], ALONG_Z);
  k.add(tube(0.073, 0.073, 0.04), toon(YELLOW), [0, 0, -0.12], ALONG_Z, undefined, false);
  fins(k, toon(RED), 0.1, 0.14, [0.015, 0.1, 0.13]);
  k.add(tube(0.05, 0.065, 0.06), toon(STEEL), [0, 0, 0.21], ALONG_Z);
  const body = k.build('body', false);

  // Comic flame: solid yellow and orange cones out of the nozzle, no glow needed.
  const f = new Kit();
  f.add(new THREE.ConeGeometry(0.075, 0.45, 7), flat(FIRE), [0, 0, 0.47], [Math.PI / 2, 0, 0]);
  f.add(new THREE.ConeGeometry(0.045, 0.26, 6), flat(FIRE_CORE), [0, 0, 0.37], [Math.PI / 2, 0, 0], undefined, false);
  const plume = f.build('flame', false);

  // Built nose-down -Z; turned round so Object3D.lookAt (which aims +Z) points the nose along the flight.
  const inner = new THREE.Group();
  inner.add(body, plume);
  inner.rotation.y = Math.PI;
  const root = new THREE.Group();
  root.add(inner);
  return root;
}

/** A rocket whose +Z axis is its nose; the child named "flame" is the exhaust plume. */
export function buildRocket(): THREE.Group {
  rocketTemplate ??= buildRocketFresh();
  return rocketTemplate.clone(true);
}

// ---- droid -------------------------------------------------------------------------------------------------------

const droids = new Map<number, THREE.Group>();
function buildDroidFresh(color: number): THREE.Group {
  const k = new Kit();
  const team = toon(color);
  const dark = toon(DARK);
  const steel = toon(STEEL);
  const cream = toon(CREAM);
  const visor = flat(LENS);
  const hex: V3 = [0, Math.PI / 6, 0];

  // Hover unit.
  k.add(new THREE.CylinderGeometry(0.2, 0.28, 0.2, 6), dark, [0, 0.42, 0], hex);
  k.add(new THREE.CylinderGeometry(0.13, 0.17, 0.16, 6), steel, [0, 0.6, 0], hex);
  // Torso, chest plate and badge.
  k.add(new THREE.CylinderGeometry(0.37, 0.24, 0.5, 6), team, [0, 0.93, 0], hex);
  k.add(box(0.3, 0.2, 0.05), cream, [0, 1.0, -0.29], [-0.22, 0, 0]);
  k.add(box(0.1, 0.1, 0.02), toon(YELLOW), [0, 1.0, -0.322], [-0.22, 0, Math.PI / 4], undefined, false);
  // Shoulders and arms.
  for (const side of [-1, 1]) {
    k.add(box(0.24, 0.15, 0.28), team, [side * 0.42, 1.15, 0], [0, 0, -side * 0.25]);
    k.add(box(0.11, 0.36, 0.12), dark, [side * 0.47, 0.88, 0]);
    k.add(box(0.13, 0.08, 0.14), steel, [side * 0.47, 0.67, 0]);
  }
  // Head with a big visor, crest and antenna.
  k.add(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 6), steel, [0, 1.22, 0]);
  k.add(new THREE.CylinderGeometry(0.16, 0.2, 0.24, 6), cream, [0, 1.37, 0], hex);
  k.add(box(0.27, 0.07, 0.03), visor, [0, 1.39, -0.17]);
  k.add(box(0.035, 0.08, 0.22), team, [0, 1.52, 0.02]);
  k.add(new THREE.CylinderGeometry(0.01, 0.01, 0.25, 4), steel, [0.1, 1.57, 0.06], undefined, undefined, false);
  k.add(new THREE.IcosahedronGeometry(0.035, 0), toon(RED), [0.1, 1.71, 0.06]);
  const root = k.build('droid');

  // Hover flame under the droid.
  const thrust = new Kit();
  thrust.add(new THREE.ConeGeometry(0.15, 0.36, 6), flat(FIRE), [0, 0.13, 0], [Math.PI, 0, 0]);
  thrust.add(new THREE.ConeGeometry(0.08, 0.2, 6), flat(FIRE_CORE), [0, 0.2, 0], [Math.PI, 0, 0], undefined, false);
  root.add(thrust.build('thrust', false));

  // The launcher rides on the right shoulder and pitches with the player's aim.
  const aim = new THREE.Group();
  aim.name = 'aim';
  aim.position.set(0, 1.18, 0);
  const launcher = buildLauncherFresh(color);
  launcher.position.set(0.46, 0.16, -0.08);
  aim.add(launcher);
  root.add(aim);
  return root;
}

/** A player droid in `color`, facing -Z, feet at the origin. Children: "aim" (pitch it), "thrust" (flicker it). */
export function buildDroid(color: number): THREE.Group {
  let t = droids.get(color);
  if (!t) droids.set(color, (t = buildDroidFresh(color)));
  return t.clone(true);
}
