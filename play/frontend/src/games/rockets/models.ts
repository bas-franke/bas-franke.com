// Procedural low-poly models for Rockets in a cel-shaded comic style: the launcher (a chunky Quake-style gun with the
// next rocket's nose peeking out of the muzzle), the rocket projectile, the player droid, its death debris and the
// pickups. Every part gets an ink outline.
//
// Draw calls are the budget: parts carry their colour as a vertex colour, so a whole sub-model merges into ONE lit
// mesh, at most one unlit "glow" mesh and one ink hull, all sharing two module-wide materials. Only parts that must
// move on their own get a sub-model. Finished models are cached per colour and cloned, which shares geometry.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hullGeometry, inkMaterial, toonRamp } from '../../engine/toon';

type V3 = [number, number, number];

const CREAM = 0xf3ecd9;
const RED = 0xe8392e;
const YELLOW = 0xffc83a;
const STEEL = 0x95a3bd;
const GUN = 0x3a4563;
const GUN_TOP = 0x6d7fa8;
const DARK = 0x252935;
const LENS = 0x9be7ff;
const SHINE = 0xeef8ff;
const BORE = 0x0d0b12;
const FIRE = 0xff9a1f;
const FIRE_CORE = 0xfff0a0;
const PINK = 0xff4fa3;

// ---- geometry kit ------------------------------------------------------------------------------------------------

let litMat: THREE.MeshToonMaterial | null = null;
let glowMat: THREE.MeshBasicMaterial | null = null;
/** The one cel-shaded material every model shares; colour comes from the vertices. */
const litMaterial = () => (litMat ??= new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: toonRamp() }));
/** The one unlit material for lenses, lamps, highlights and flames. */
const glowMaterial = () => (glowMat ??= new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }));
/** Droids get a slightly thinner line so their team colour still wins when they are a few pixels tall. */
const droidInk = () => inkMaterial(0.003, 0.006);

/** Collects transformed, vertex-coloured primitives and merges them into one lit mesh, one glow mesh and one hull. */
class Kit {
  private readonly lit: THREE.BufferGeometry[] = [];
  private readonly glow: THREE.BufferGeometry[] = [];
  private readonly hulls: THREE.BufferGeometry[] = [];
  /** Applied after each part's own transform, so a builder can place its parts inside another model. */
  base = new THREE.Matrix4();

  /** `glowAsLit` folds glow parts into the lit mesh: one draw call less where the glow does not matter. */
  constructor(private readonly glowAsLit = false) {}

  add(geo: THREE.BufferGeometry, color: number, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1], ink = true) {
    return this.put(this.lit, geo, color, pos, rot, scale, ink);
  }

  /** An unlit part: always full brightness, no ink unless asked. */
  glowing(geo: THREE.BufferGeometry, color: number, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1], ink = false) {
    return this.put(this.glowAsLit ? this.lit : this.glow, geo, color, pos, rot, scale, ink);
  }

  private put(list: THREE.BufferGeometry[], geo: THREE.BufferGeometry, color: number, pos: V3, rot: V3, scale: V3, ink: boolean) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
      new THREE.Vector3(...scale),
    );
    m.premultiply(this.base);
    if (ink) this.hulls.push(hullGeometry(geo).applyMatrix4(m));
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    if (g.getAttribute('uv')) g.deleteAttribute('uv');
    g.applyMatrix4(m);
    const c = new THREE.Color(color);
    const n = g.getAttribute('position').count;
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) rgb.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    list.push(g);
    return this;
  }

  build(name = '', shadows = true, ink: THREE.Material = inkMaterial()): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    const merge = (list: THREE.BufferGeometry[]) => {
      if (!list.length) return null;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      list.length = 0;
      return merged;
    };
    const lit = merge(this.lit);
    if (lit) {
      const mesh = new THREE.Mesh(lit, litMaterial());
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    const glow = merge(this.glow);
    if (glow) group.add(new THREE.Mesh(glow, glowMaterial()));
    const hull = merge(this.hulls);
    if (hull) group.add(new THREE.Mesh(hull, ink));
    return group;
  }
}

/** Cylinder lying along -Z: radiusFront at the -Z end. */
const tube = (radiusFront: number, radiusBack: number, length: number, sides = 8) => new THREE.CylinderGeometry(radiusFront, radiusBack, length, sides);
const ALONG_Z: V3 = [-Math.PI / 2, 0, 0];
const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const hex: V3 = [0, Math.PI / 6, 0];

/** Four fins around the Z axis at radius r, centred at z. */
function fins(kit: Kit, color: number, r: number, z: number, size: V3) {
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    kit.add(box(...size), color, [Math.cos(a) * r, Math.sin(a) * r, z], [0, 0, a - Math.PI / 2]);
  }
}

// ---- launcher ----------------------------------------------------------------------------------------------------

/** Where the loaded warhead sits; the client slides it back and forward again on every shot. */
export const WARHEAD_REST_Z = 0;

/** Height of the barrel axis above the grip origin. */
const BORE_Y = 0.07;

/** The launcher's parts, grip at the origin, pointing down -Z. The loaded rocket's nose goes into `nose`. */
function launcherParts(k: Kit, accent: number, nose: Kit) {
  // Quake-style: a deep blue gunmetal receiver with a light top rail, team armour plates with a shine line, a heavy
  // light-steel barrel and a wide muzzle. Light against dark everywhere, so the shape reads from any angle.
  k.add(box(0.18, 0.2, 0.46), GUN, [0, -0.02, -0.02]);
  k.add(box(0.15, 0.03, 0.42), GUN_TOP, [0, 0.085, -0.03]);
  for (const side of [-1, 1]) {
    k.add(box(0.026, 0.15, 0.36), accent, [side * 0.1, -0.01, -0.04]);
    k.glowing(box(0.028, 0.014, 0.3), SHINE, [side * 0.1, 0.05, -0.05]);
  }
  k.add(box(0.15, 0.16, 0.14), DARK, [0, 0.0, 0.27]);
  k.glowing(box(0.1, 0.035, 0.02), FIRE, [0, 0.03, 0.345]);
  k.glowing(box(0.1, 0.035, 0.02), FIRE, [0, -0.03, 0.345]);
  // Barrel with a comic shine streak, heat-sink ribs, muzzle shroud with a hazard band, a team lip and a dark bore.
  k.add(tube(0.075, 0.075, 0.62), STEEL, [0, BORE_Y, -0.5], ALONG_Z);
  k.glowing(box(0.02, 0.008, 0.18), SHINE, [-0.03, BORE_Y + 0.068, -0.64], [0, 0, 0.4]);
  for (const z of [-0.32, -0.42, -0.52]) k.add(tube(0.097, 0.097, 0.035), DARK, [0, BORE_Y, z], ALONG_Z);
  k.add(tube(0.118, 0.1, 0.16), GUN, [0, BORE_Y, -0.83], ALONG_Z);
  k.add(tube(0.121, 0.121, 0.035), YELLOW, [0, BORE_Y, -0.78], ALONG_Z, undefined, false);
  k.add(tube(0.124, 0.124, 0.03), accent, [0, BORE_Y, -0.895], ALONG_Z, undefined, false);
  k.glowing(tube(0.072, 0.072, 0.01), BORE, [0, BORE_Y, -0.912], ALONG_Z);
  // Carry handle with sight posts, grip, trigger guard and an under-barrel pump.
  k.add(box(0.04, 0.03, 0.3), DARK, [0, 0.2, -0.08]);
  k.add(box(0.03, 0.06, 0.03), DARK, [0, 0.165, 0.04]);
  k.add(box(0.03, 0.06, 0.03), DARK, [0, 0.165, -0.2]);
  k.glowing(box(0.02, 0.04, 0.02), FIRE, [0, 0.215, -0.2]);
  k.add(box(0.06, 0.18, 0.08), DARK, [0, -0.17, 0.08], [0.25, 0, 0]);
  k.add(box(0.02, 0.05, 0.09), GUN, [0, -0.14, -0.03]);
  k.add(box(0.07, 0.08, 0.2), DARK, [0, -0.06, -0.38]);
  nose.add(new THREE.ConeGeometry(0.055, 0.14, 8), RED, [0, BORE_Y, -0.88], ALONG_Z);
}

const launchers = new Map<number, THREE.Group>();
/**
 * A launcher pointing down -Z with its origin at the grip, painted in `accent`. Three meshes for the gun (lit, glow,
 * ink) plus the child "warhead" (the next rocket's nose; the client hides it after a shot and slides a new one in).
 */
export function buildLauncher(accent = RED): THREE.Group {
  let t = launchers.get(accent);
  if (!t) {
    const k = new Kit();
    const w = new Kit();
    launcherParts(k, accent, w);
    t = k.build('launcher', false);
    const warhead = w.build('warhead', false);
    warhead.position.z = WARHEAD_REST_Z;
    t.add(warhead);
    launchers.set(accent, t);
  }
  return t.clone(true);
}

// ---- rocket ------------------------------------------------------------------------------------------------------

let rocketTemplate: THREE.Group | null = null;
function buildRocketFresh(): THREE.Group {
  const k = new Kit();
  k.add(tube(0.07, 0.07, 0.38), CREAM, [0, 0, 0], ALONG_Z);
  k.add(new THREE.ConeGeometry(0.07, 0.2, 8), RED, [0, 0, -0.29], ALONG_Z);
  k.add(tube(0.073, 0.073, 0.04), YELLOW, [0, 0, -0.12], ALONG_Z, undefined, false);
  fins(k, RED, 0.1, 0.14, [0.015, 0.1, 0.13]);
  k.add(tube(0.05, 0.065, 0.06), STEEL, [0, 0, 0.21], ALONG_Z);
  const body = k.build('body', false);

  // Comic flame: solid yellow and orange cones out of the nozzle, no glow needed.
  const f = new Kit();
  f.glowing(new THREE.ConeGeometry(0.075, 0.45, 7), FIRE, [0, 0, 0.47], [Math.PI / 2, 0, 0], undefined, true);
  f.glowing(new THREE.ConeGeometry(0.045, 0.26, 6), FIRE_CORE, [0, 0, 0.37], [Math.PI / 2, 0, 0]);
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

/** Droid pivots, in droid space (feet at the origin, facing -Z). */
const TORSO_PIVOT_Y = 0.45;
const NECK_Y = 1.22;
const SHOULDER: V3 = [0.44, 1.16, 0];
const NOZZLE_Y = 0.3;

/** Hover unit: a dark hex drum on a team skirt, with a nozzle underneath. */
function hoverParts(k: Kit, team: number) {
  k.add(new THREE.CylinderGeometry(0.2, 0.28, 0.2, 6), DARK, [0, 0.43, 0], hex);
  k.add(new THREE.CylinderGeometry(0.31, 0.31, 0.07, 6), team, [0, 0.36, 0], hex);
  k.add(new THREE.CylinderGeometry(0.13, 0.1, 0.07, 6), STEEL, [0, NOZZLE_Y + 0.02, 0], hex, undefined, false);
  k.add(new THREE.CylinderGeometry(0.13, 0.17, 0.16, 6), STEEL, [0, 0.6, 0], hex);
}

/** Torso, cream chest plate (the front), dark backpack (the back) and big team shoulder pads. */
function chestParts(k: Kit, team: number) {
  k.add(new THREE.CylinderGeometry(0.4, 0.25, 0.52, 6), team, [0, 0.94, 0], hex);
  k.add(box(0.34, 0.22, 0.05), CREAM, [0, 1.0, -0.3], [-0.22, 0, 0]);
  k.add(box(0.1, 0.1, 0.02), YELLOW, [0, 1.0, -0.333], [-0.22, 0, Math.PI / 4], undefined, false);
  k.add(box(0.36, 0.34, 0.16), DARK, [0, 1.0, 0.33]);
  for (const side of [-1, 1]) k.add(tube(0.05, 0.06, 0.12), STEEL, [side * 0.1, 0.8, 0.35], [0, 0, 0]);
  for (const side of [-1, 1]) k.add(box(0.28, 0.18, 0.32), team, [side * 0.43, 1.16, 0], [0, 0, -side * 0.25]);
}

/** The free (left) arm, hanging a little forward. */
function leftArmParts(k: Kit, team: number) {
  k.add(box(0.12, 0.24, 0.13), team, [-0.47, 0.98, -0.02], [0.15, 0, 0]);
  k.add(box(0.11, 0.2, 0.12), DARK, [-0.47, 0.78, -0.07], [0.3, 0, 0]);
  k.add(box(0.13, 0.08, 0.14), STEEL, [-0.47, 0.65, -0.11], [0.3, 0, 0]);
}

/** Head around the neck pivot: a cream hex helmet, a wide glowing visor (the face) and a glowing team crest. */
function headParts(k: Kit, team: number) {
  k.add(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 6), STEEL, [0, NECK_Y, 0]);
  k.add(new THREE.CylinderGeometry(0.16, 0.2, 0.24, 6), CREAM, [0, 1.37, 0], hex);
  k.glowing(box(0.3, 0.085, 0.03), LENS, [0, 1.39, -0.175], undefined, undefined, true);
  for (const side of [-1, 1]) k.glowing(box(0.03, 0.07, 0.1), LENS, [side * 0.165, 1.39, -0.11], [0, side * 0.5, 0]);
  k.glowing(box(0.045, 0.1, 0.26), team, [0, 1.53, 0.02], undefined, undefined, true);
  k.add(new THREE.CylinderGeometry(0.01, 0.01, 0.25, 4), STEEL, [0.1, 1.57, 0.06], undefined, undefined, false);
  k.add(new THREE.IcosahedronGeometry(0.035, 0), RED, [0.1, 1.71, 0.06]);
}

/** Gun arm and launcher around the shoulder pivot (aim space). */
function gunArmParts(k: Kit, team: number) {
  k.add(box(0.13, 0.26, 0.14), team, [0.03, -0.12, 0.02]);
  k.add(box(0.1, 0.1, 0.24), DARK, [-0.01, -0.26, -0.06], [0.45, 0, 0]);
  const keep = k.base.clone();
  k.base.multiply(new THREE.Matrix4().compose(new THREE.Vector3(-0.1, -0.2, -0.2), new THREE.Quaternion(), new THREE.Vector3(0.9, 0.9, 0.9)));
  launcherParts(k, team, k);
  k.base.copy(keep);
  k.add(box(0.1, 0.09, 0.11), STEEL, [-0.1, -0.33, -0.14]);
}

const translate = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

const droids = new Map<number, THREE.Group>();
function buildDroidFresh(color: number): THREE.Group {
  const ink = droidInk();

  // Torso (with the hover unit and the free arm): the lean pivot sits in the hover drum.
  const t = new Kit(true);
  t.base = translate(0, -TORSO_PIVOT_Y, 0);
  hoverParts(t, color);
  chestParts(t, color);
  leftArmParts(t, color);
  const torso = t.build('torso', true, ink);
  torso.position.y = TORSO_PIVOT_Y;

  const h = new Kit();
  h.base = translate(0, -NECK_Y, 0);
  headParts(h, color);
  const head = h.build('head', true, ink);
  head.position.y = NECK_Y - TORSO_PIVOT_Y;

  // Hover flame hanging from the nozzle; scale.y stretches it downwards.
  const f = new Kit();
  f.glowing(new THREE.ConeGeometry(0.15, 0.36, 6), FIRE, [0, -0.18, 0], [Math.PI, 0, 0]);
  f.glowing(new THREE.ConeGeometry(0.08, 0.2, 6), FIRE_CORE, [0, -0.1, 0], [Math.PI, 0, 0]);
  const thrust = f.build('thrust', false);
  thrust.position.y = NOZZLE_Y - TORSO_PIVOT_Y;

  // Gun arm: "aim" pitches at the shoulder, "recoil" inside it kicks back on a shot. The launcher's glow parts fold
  // into its lit mesh; nobody sees the shine lines at droid scale.
  const g = new Kit(true);
  gunArmParts(g, color);
  const recoil = g.build('recoil', false, ink);
  const aim = new THREE.Group();
  aim.name = 'aim';
  aim.position.set(SHOULDER[0], SHOULDER[1] - TORSO_PIVOT_Y, SHOULDER[2]);
  aim.add(recoil);

  torso.add(head, thrust, aim);
  const bob = new THREE.Group();
  bob.name = 'bob';
  bob.add(torso);
  const root = new THREE.Group();
  root.name = 'droid';
  root.add(bob);
  return root;
}

/**
 * A player droid in `color`, facing -Z, feet at the origin. Eight meshes. Hooks (all plain transforms):
 * "bob" (position.y hover bob), "torso" (rotation.x/z lean, pivot in the hover drum), "head" (rotation.y/x look,
 * pivot at the neck), "aim" (rotation.x pitch, pivot at the gun shoulder), "recoil" (inside aim: position.z/rotation.x
 * kick) and "thrust" (scale.y flicker, hangs from the nozzle).
 */
export function buildDroid(color: number): THREE.Group {
  let t = droids.get(color);
  if (!t) droids.set(color, (t = buildDroidFresh(color)));
  return t.clone(true);
}

// ---- droid death breakup -----------------------------------------------------------------------------------------

/** One flying piece of a destroyed droid. The client adds `object` to the scene and calls updateDroidPieces. */
export interface DroidPiece {
  object: THREE.Group;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
}

/** Piece templates per colour, each centred on its own pivot and placed in droid space. */
const wrecks = new Map<number, THREE.Group[]>();
function wreckTemplates(color: number): THREE.Group[] {
  let list = wrecks.get(color);
  if (list) return list;
  const ink = droidInk();
  const piece = (name: string, centre: V3, parts: (k: Kit) => void, shift: V3 = [0, 0, 0]) => {
    const k = new Kit(true);
    k.base = translate(shift[0] - centre[0], shift[1] - centre[1], shift[2] - centre[2]);
    parts(k);
    const g = k.build(name, false, ink);
    g.position.set(...centre);
    return g;
  };
  list = [
    piece('hover', [0, 0.45, 0], (k) => hoverParts(k, color)),
    piece('chest', [0, 1.0, 0], (k) => chestParts(k, color)),
    piece('arm', [-0.47, 0.82, -0.05], (k) => leftArmParts(k, color)),
    piece('head', [0, 1.4, 0], (k) => headParts(k, color)),
    piece('gun', [0.38, 0.92, -0.3], (k) => gunArmParts(k, color), SHOULDER),
  ];
  wrecks.set(color, list);
  return list;
}

/**
 * The pieces of `droid` (a buildDroid group, already placed in the world) blowing apart: head, chest, hover unit,
 * free arm and gun arm, each flung out from the body plus `push` (e.g. the killing blast's direction times 4).
 * About ten draw calls while they fly; drop them after a couple of seconds.
 */
export function buildDroidPieces(color: number, droid: THREE.Object3D, push?: THREE.Vector3): DroidPiece[] {
  droid.updateWorldMatrix(true, false);
  const q = droid.getWorldQuaternion(new THREE.Quaternion());
  return wreckTemplates(color).map((t) => {
    const object = t.clone(true);
    object.position.copy(t.position).applyMatrix4(droid.matrixWorld);
    object.quaternion.copy(q);
    const out = new THREE.Vector3(t.position.x, t.position.y - 0.8, t.position.z).applyQuaternion(q);
    out.y = Math.max(0, out.y);
    const vel = out.normalize().multiplyScalar(2.5 + Math.random() * 2.5);
    vel.x += (Math.random() - 0.5) * 2;
    vel.z += (Math.random() - 0.5) * 2;
    vel.y += 3.5 + Math.random() * 3;
    if (push) vel.add(push);
    const spin = new THREE.Vector3((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
    return { object, vel, spin };
  });
}

/** Moves the pieces one step: gravity, tumbling, and a few damped bounces on a floor at `floorY`. No allocations. */
export function updateDroidPieces(pieces: DroidPiece[], dt: number, floorY: number, gravity = 20) {
  for (const p of pieces) {
    const o = p.object;
    p.vel.y -= gravity * dt;
    o.position.addScaledVector(p.vel, dt);
    o.rotation.x += p.spin.x * dt;
    o.rotation.y += p.spin.y * dt;
    o.rotation.z += p.spin.z * dt;
    if (o.position.y < floorY + 0.1 && p.vel.y < 0) {
      o.position.y = floorY + 0.1;
      p.vel.y *= -0.35;
      p.vel.x *= 0.6;
      p.vel.z *= 0.6;
      p.spin.multiplyScalar(0.55);
    }
  }
}

// ---- pickups -----------------------------------------------------------------------------------------------------

export type PickupKind = 'health' | 'armor' | 'mega';

/** A chunky red plus standing proud of a cream plus backing, with comic shine marks on both faces. */
function healthParts(k: Kit) {
  k.add(box(0.58, 0.24, 0.12), CREAM);
  k.add(box(0.24, 0.58, 0.12), CREAM);
  k.add(box(0.5, 0.16, 0.2), RED, undefined, undefined, undefined, false);
  k.add(box(0.16, 0.5, 0.2), RED, undefined, undefined, undefined, false);
  for (const z of [-0.103, 0.103]) {
    k.glowing(box(0.1, 0.028, 0.005), SHINE, [-0.15, 0.045, z]);
    k.glowing(box(0.028, 0.1, 0.005), SHINE, [-0.045, 0.15, z]);
  }
}

/** A yellow hex shield on a dark rim with a cream chevron and a shine stripe, both faces. */
function armorParts(k: Kit) {
  const face: V3 = [Math.PI / 2, Math.PI / 6, 0];
  k.add(new THREE.CylinderGeometry(0.3, 0.3, 0.08, 6), DARK, [0, 0, 0], face, [1, 1, 1.25]);
  k.add(new THREE.CylinderGeometry(0.25, 0.25, 0.12, 6), YELLOW, [0, 0, 0], face, [1, 1, 1.25], false);
  for (const z of [-0.065, 0.065]) {
    for (const side of [-1, 1]) k.add(box(0.2, 0.06, 0.02), CREAM, [side * 0.07, -0.02, z], [0, 0, side * 0.6], undefined, false);
    k.glowing(box(0.035, 0.18, 0.005), SHINE, [-0.12, 0.08, z * 1.06], [0, 0, -0.5]);
  }
}

/** A big pink orb with a cream plus on both sides, a yellow ring and a shine blob. */
function megaParts(k: Kit) {
  k.add(new THREE.IcosahedronGeometry(0.34, 1), PINK);
  for (const z of [-0.3, 0.3]) {
    k.add(box(0.2, 0.065, 0.06), CREAM, [0, 0, z], undefined, undefined, false);
    k.add(box(0.065, 0.2, 0.06), CREAM, [0, 0, z], undefined, undefined, false);
  }
  k.add(new THREE.TorusGeometry(0.45, 0.035, 5, 18), YELLOW, [0, 0, 0], [Math.PI / 2 - 0.35, 0, 0.2]);
  k.glowing(new THREE.IcosahedronGeometry(0.06, 0), SHINE, [-0.15, 0.2, -0.22]);
}

const pickups = new Map<PickupKind, THREE.Group>();
/**
 * A pickup centred on its own pivot (spin it about Y and bob it, the origin stays put), about 0.5 m across (mega
 * about 0.9 m). Three meshes.
 */
export function buildPickup(kind: PickupKind): THREE.Group {
  let t = pickups.get(kind);
  if (!t) {
    const k = new Kit();
    if (kind === 'health') healthParts(k);
    else if (kind === 'armor') armorParts(k);
    else megaParts(k);
    t = k.build(`pickup-${kind}`, true);
    pickups.set(kind, t);
  }
  return t.clone(true);
}
