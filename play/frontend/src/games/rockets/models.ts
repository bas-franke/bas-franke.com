// Procedural low-poly models for Rockets in a cel-shaded comic style: the launcher (a heavy gunmetal hard-surface
// launcher with the next rocket's nose deep in the bore), the rocket projectile, the player droid, its death debris and the
// pickups. Every part gets an ink outline.
//
// Draw calls are the budget: parts carry their colour as a vertex colour, so a whole sub-model merges into ONE lit
// mesh, at most one unlit "glow" mesh and one ink hull, all sharing two module-wide materials. Only parts that must
// move on their own get a sub-model. Finished models are cached and cloned, which shares geometry. Droids and their
// wrecks paint team parts with the TEAM stand-in colour and take the real one from a per-colour material, so every
// team shares one set of geometry: a new player colour costs two materials, not twenty geometries and a hitch.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hullGeometry, inkMaterial, toonRamp } from '../../engine/toon';

type V3 = [number, number, number];

const CREAM = 0xf3ecd9;
const RED = 0xe8392e;
const YELLOW = 0xffc83a;
const STEEL = 0x95a3bd;
const DARK = 0x252935;
const LENS = 0x9be7ff;
const SHINE = 0xeef8ff;
const BORE = 0x0d0b12;
const FIRE = 0xff9a1f;
const FIRE_CORE = 0xfff0a0;
const PINK = 0xff4fa3;
/** Stand-in for the team colour: those vertices take their colour from the material (see teamMaterials). */
const TEAM = -1;

// ---- geometry kit ------------------------------------------------------------------------------------------------

let litMat: THREE.MeshToonMaterial | null = null;
let glowMat: THREE.MeshBasicMaterial | null = null;
/** The one cel-shaded material every model shares; colour comes from the vertices. */
const litMaterial = () => (litMat ??= new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: toonRamp() }));
/** The one unlit material for lenses, lamps, highlights and flames. */
const glowMaterial = () => (glowMat ??= new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }));
/** Droids get a slightly thinner line so their team colour still wins when they are a few pixels tall. */
const droidInk = () => inkMaterial(0.003, 0.006);

/** TEAM vertices carry a negative vertex colour; those fragments take the material's team colour instead. */
const TEAM_COLOR_FRAGMENT = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	diffuseColor *= vColor.r < 0.0 ? vec4( teamColor, 1.0 ) : vColor;
#endif`;

/** A copy of `base` that paints TEAM vertices in `color`. Every team shares one shader program. */
function teamPainted<M extends THREE.Material>(base: M, color: number, key: string): M {
  const m = base.clone() as M;
  const team = { value: new THREE.Color(color) };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.teamColor = team;
    shader.fragmentShader = 'uniform vec3 teamColor;\n' + shader.fragmentShader.replace('#include <color_fragment>', TEAM_COLOR_FRAGMENT);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

const teams = new Map<number, { lit: THREE.MeshToonMaterial; glow: THREE.MeshBasicMaterial }>();
/** The lit and glow materials for one team colour, cached. */
function teamMaterials(color: number) {
  let t = teams.get(color);
  if (!t) teams.set(color, (t = { lit: teamPainted(litMaterial(), color, 'team-lit'), glow: teamPainted(glowMaterial(), color, 'team-glow') }));
  return t;
}

/** Swaps the shared lit and glow materials under `root` for `color`'s team copies. */
function paintTeam<O extends THREE.Object3D>(root: O, color: number): O {
  const t = teamMaterials(color);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.material === litMat) mesh.material = t.lit;
    else if (mesh.material === glowMat) mesh.material = t.glow;
  });
  return root;
}

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
    const c = color === TEAM ? new THREE.Color(-1, -1, -1) : new THREE.Color(color);
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

const GUN = 0x4d545e;
const GUN_LIGHT = 0x707a87;
const GUN_DARK = 0x30353c;
const IRON = 0x1b1d21;
/** Oxide red on the muzzle bands: the one warm colour on the steel. */
const OXIDE = 0x9a3020;
const HAZARD = 0xe0a81e;
const METAL = 0x2a2d33;
const BLACK = 0x111215;
/** Hot ember behind vents and in the sights: reads as "live" without the toy-like cyan. */
const EMBER = 0xff5a14;

/**
 * A hard-surface octagonal prism along -Z: `w` wide, `h` tall, its four corners cut by `cut` times the shorter side,
 * and its front (-Z) end scaled by `taper`. Flat-shaded, centred on the origin.
 */
function oct(w: number, h: number, len: number, cut = 0.25, taper = 1): THREE.BufferGeometry {
  const a = w / 2;
  const b = h / 2;
  const c = cut * Math.min(w, h);
  return prism([[a, b - c], [a - c, b], [-a + c, b], [-a, b - c], [-a, -b + c], [-a + c, -b], [a - c, -b], [a, -b + c]], len, taper);
}

/**
 * A peaked prism along -Z, the launcher's triangular look: flat sides from `below` under the axis up to `shoulder`
 * above it, then two steep slopes meeting in a narrow ridge (`ridge` half-wide) at `top`. Chamfered underneath.
 */
function peak(w: number, below: number, shoulder: number, top: number, len: number, ridge = 0.03, taper = 1): THREE.BufferGeometry {
  const a = w / 2;
  const c = 0.12 * w;
  return prism([[a, shoulder], [ridge, top], [-ridge, top], [-a, shoulder], [-a, -below + c], [-a + c, -below], [a - c, -below], [a, -below + c]], len, taper);
}

/** A flat-shaded prism along -Z from a convex 8-point ring (counter-clockwise), its front end scaled by `taper`. */
function prism(ring: [number, number][], len: number, taper: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const back = (i: number) => [ring[i][0], ring[i][1], len / 2];
  const front = (i: number) => [ring[i][0] * taper, ring[i][1] * taper, -len / 2];
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    pos.push(...back(i), ...front(i), ...front(j), ...back(i), ...front(j), ...back(j));
  }
  for (let i = 1; i < 7; i++) pos.push(...back(0), ...back(i), ...back(i + 1), ...front(0), ...front(i + 1), ...front(i));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** An open tube along -Z seen from the inside (for bore walls; unlit, so its normals do not matter). */
function boreWall(r: number, len: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, 12, 1, true).rotateX(-Math.PI / 2);
  const idx = g.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const t = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, t);
  }
  return g;
}

/** A flat ring facing -Z. */
const annulus = (inner: number, outer: number) => new THREE.RingGeometry(inner, outer, 12).rotateY(Math.PI);

/** Runs `parts` with the kit's frame moved to `pos`/`rot` (and scaled), for sub-assemblies like an angled grip. */
function inFrame(k: Kit, pos: V3, rot: V3, parts: () => void, scale: V3 = [1, 1, 1]) {
  const keep = k.base.clone();
  k.base.multiply(new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...scale)));
  parts();
  k.base.copy(keep);
}

/** A vent: a dark recess with an ember glow deep inside. `size` is the glow; the recess is a little bigger around it. */
function vent(k: Kit, pos: V3, size: V3, out: V3) {
  k.add(box(size[0] + 0.012, size[1] + 0.012, size[2] + 0.012), BLACK, [pos[0] - out[0] * 0.004, pos[1] - out[1] * 0.004, pos[2] - out[2] * 0.004], undefined, undefined, false);
  k.glowing(box(...size), EMBER, [pos[0] + out[0] * 0.004, pos[1] + out[1] * 0.004, pos[2] + out[2] * 0.004]);
}

/** A rubberised grip hanging down from its frame's origin: finger grooves and a steel heel plate. */
function gripParts(k: Kit, w: number, h: number, d: number) {
  k.add(oct(w, d, h, 0.22), IRON, [0, -h / 2, 0], [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 4; i++) k.add(box(w + 0.006, 0.01, 0.012), GUN_DARK, [0, -0.035 - (i * (h - 0.05)) / 4, -d / 2], undefined, undefined, false);
  k.add(oct(w + 0.01, d + 0.014, 0.025, 0.25), GUN_DARK, [0, -h, 0], [Math.PI / 2, 0, 0]);
}

/** How far the muzzle head sits back from where its parts are written: a short barrel keeps it big on screen. */
const HEAD_BACK = 0.16;

/**
 * The launcher's parts, grip at the origin, pointing down -Z. The loaded rocket's nose goes into `nose`. A heavy
 * gunmetal launcher after the arena-shooter classics, every block peaked into a steep ridge so it reads triangular: a
 * fat muzzle head around a big round bore, a thick barrel under a slotted heat shield, an armoured receiver narrowing
 * toward the barrel, and a breech block at the back with the next rocket showing through its loading port. Ember glow only in the muzzle vents. `accent` paints a thin stripe.
 */
function launcherParts(k: Kit, accent: number, nose: Kit) {
  // Grown 10% across (not along), about the bore axis, so the head steps out of the barrel.
  inFrame(k, [0, -BORE_Y * 0.1, HEAD_BACK], [0, 0, 0], () => {
    // Muzzle head (z -0.84..-0.53, built 16cm further out and pulled back): wider and taller than everything behind it, tapering a touch toward the face.
    // Peaked like the rest of the gun: steep slopes up to a ridge well above the bore.
    k.add(peak(0.29, 0.135, 0.09, 0.22, 0.28, 0.035, 0.95), GUN, [0, BORE_Y, -0.86]);
    k.add(peak(0.3, 0.14, 0.094, 0.228, 0.03, 0.038), OXIDE, [0, BORE_Y, -0.735]);
    k.add(peak(0.296, 0.138, 0.092, 0.225, 0.012, 0.037), IRON, [0, BORE_Y, -0.71]);
    k.add(peak(0.25, 0.12, 0.08, 0.19, 0.022, 0.03), GUN_LIGHT, [0, BORE_Y, -0.692]);
    // Face: an iron frame and a big round bore, recessed deep, with an iron inner ring.
    k.add(peak(0.275, 0.128, 0.085, 0.208, 0.02, 0.033), IRON, [0, BORE_Y, -0.995]);
    k.add(new THREE.CylinderGeometry(0.112, 0.112, 0.03, 16, 1, true), GUN_LIGHT, [0, BORE_Y, -1.015], ALONG_Z);
    k.add(annulus(0.1, 0.112), GUN_LIGHT, [0, BORE_Y, -1.03], undefined, undefined, false);
    k.glowing(boreWall(0.1, 0.05), METAL, [0, BORE_Y, -1.005]);
    k.glowing(annulus(0.085, 0.1), IRON, [0, BORE_Y, -0.98]);
    k.glowing(boreWall(0.085, 0.06), BLACK, [0, BORE_Y, -0.95]);
    k.glowing(annulus(0, 0.085), BORE, [0, BORE_Y, -0.92]);
    // Bolts in the face corners, and three ember vents down each flank of the head.
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) k.add(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 6), GUN_LIGHT, [sx * 0.112, BORE_Y + sy * 0.1, -1.008], ALONG_Z, undefined, false);
    for (const side of [-1, 1])
      for (let i = 0; i < 3; i++) vent(k, [side * 0.144, BORE_Y, -0.94 + i * 0.055], [0.004, 0.14, 0.022], [side, 0, 0]);
    // A vent along the ridge, so the head reads as live from the shooter's eye, and a front sight blade on its tip.
    vent(k, [0, BORE_Y + 0.219, -0.84], [0.03, 0.004, 0.13], [0, 1, 0]);
    k.add(box(0.014, 0.035, 0.06), IRON, [0, BORE_Y + 0.23, -0.95]);
  }, [1.1, 1.1, 1]);

  // Barrel (z -0.54..-0.34): short, thick and peaked, two thin clamp rings, a slotted heat shield capping the ridge.
  k.add(peak(0.22, 0.105, 0.05, 0.155, 0.2, 0.03), IRON, [0, BORE_Y, -0.44]);
  for (const z of [-0.5, -0.39]) k.add(peak(0.232, 0.111, 0.054, 0.163, 0.016, 0.034), GUN_LIGHT, [0, BORE_Y, z]);
  k.add(box(0.07, 0.018, 0.17), GUN_DARK, [0, BORE_Y + 0.16, -0.45]);
  for (let i = 0; i < 3; i++) k.add(box(0.05, 0.004, 0.035), BLACK, [0, BORE_Y + 0.1705, -0.505 + i * 0.055], undefined, undefined, false);

  // Receiver (z -0.36..0.1): a peaked slab narrowing toward the barrel, an inset armour plate, bolts, a seam and the team stripe.
  k.add(peak(0.21, 0.11, 0.03, 0.15, 0.46, 0.025, 0.92), GUN, [0, 0.06, -0.13]);
  for (const side of [-1, 1]) {
    k.add(oct(0.016, 0.1, 0.38, 0.25), GUN_LIGHT, [side * 0.111, 0.035, -0.13]);
    k.add(box(0.004, 0.006, 0.36), IRON, [side * 0.12, -0.005, -0.13], undefined, undefined, false);
    k.add(box(0.004, 0.016, 0.3), accent, [side * 0.12, 0.045, -0.13], undefined, undefined, false);
    for (const z of [-0.3, -0.13, 0.04]) k.add(new THREE.CylinderGeometry(0.011, 0.011, 0.01, 6), IRON, [side * 0.122, 0.074, z], [0, 0, Math.PI / 2], undefined, false);
  }
  // One small hazard stripe on the right, ahead of the plate.
  for (let i = 0; i < 3; i++) k.add(box(0.003, 0.03, 0.012), i % 2 ? BLACK : HAZARD, [0.121, 0.07, -0.345 + i * 0.012], [0.6, 0, 0], undefined, false);
  // A low rear sight notch on the ridge.
  for (const side of [-1, 1]) k.add(box(0.014, 0.03, 0.025), IRON, [side * 0.018, 0.212, 0.05]);

  // Breech block (z 0.1..0.42): peaked and taller than the receiver, with a loading port showing the next rocket.
  k.add(peak(0.23, 0.13, 0.05, 0.18, 0.32, 0.03), GUN_DARK, [0, BORE_Y, 0.26]);
  k.add(peak(0.244, 0.137, 0.054, 0.19, 0.03, 0.034), IRON, [0, BORE_Y, 0.11]);
  k.add(peak(0.236, 0.133, 0.052, 0.185, 0.025, 0.032), OXIDE, [0, BORE_Y, 0.14]);
  // A loading port on the right face; the rocket behind it bulges just through.
  k.add(box(0.004, 0.1, 0.18), BLACK, [0.116, BORE_Y, 0.23], undefined, undefined, false);
  // The rocket in the port: a red nose cone, a dark ring, then the cream body.
  k.add(tube(0.065, 0.065, 0.11, 12), CREAM, [0.057, BORE_Y, 0.265], ALONG_Z, undefined, false);
  k.add(tube(0.067, 0.067, 0.014, 12), GUN_DARK, [0.057, BORE_Y, 0.203], ALONG_Z, undefined, false);
  k.add(new THREE.CylinderGeometry(0.022, 0.066, 0.07, 12), RED, [0.057, BORE_Y, 0.161], ALONG_Z, undefined, false);
  // A seam and two big bolts low on each flank, so the near face reads as machined metal.
  for (const side of [-1, 1]) {
    k.add(box(0.004, 0.006, 0.28), IRON, [side * 0.116, BORE_Y - 0.06, 0.27], undefined, undefined, false);
    for (const z of [0.2, 0.36]) k.add(new THREE.CylinderGeometry(0.016, 0.016, 0.012, 6), GUN_LIGHT, [side * 0.118, BORE_Y - 0.095, z], [0, 0, Math.PI / 2]);
  }
  for (const z of [0.125, 0.335]) k.add(box(0.012, 0.1, 0.016), IRON, [0.118, BORE_Y, z]);
  // End plate: iron, a thin oxide rim and a dark exhaust throat.
  k.add(peak(0.24, 0.135, 0.053, 0.188, 0.03, 0.033), IRON, [0, BORE_Y, 0.435]);
  k.add(peak(0.246, 0.138, 0.055, 0.192, 0.01, 0.035), OXIDE, [0, BORE_Y, 0.415]);
  k.add(tube(0.08, 0.08, 0.03, 14), GUN, [0, BORE_Y, 0.46], ALONG_Z);
  k.glowing(new THREE.CircleGeometry(0.065, 14), BORE, [0, BORE_Y, 0.476]);

  // Pistol grip (leaning back) with a guard and trigger.
  inFrame(k, [0, -0.04, 0], [-0.28, 0, 0], () => gripParts(k, 0.058, 0.17, 0.075));
  k.add(box(0.02, 0.014, 0.12), GUN_DARK, [0, -0.13, -0.085]);
  k.add(box(0.02, 0.085, 0.016), GUN_DARK, [0, -0.085, -0.142]);
  k.add(box(0.012, 0.045, 0.014), GUN_LIGHT, [0, -0.075, -0.075], [0.3, 0, 0]);
  // A charge pack ahead of the grip, bolted to the receiver.
  k.add(oct(0.09, 0.1, 0.12, 0.15), GUN_DARK, [0, -0.07, -0.25]);
  // Fore grip under the barrel on a clamp, raked forward.
  k.add(box(0.12, 0.03, 0.1), GUN, [0, -0.05, -0.45]);
  for (const side of [-1, 1]) k.add(new THREE.CylinderGeometry(0.018, 0.018, 0.012, 6), GUN_LIGHT, [side * 0.065, -0.05, -0.45], [0, 0, Math.PI / 2], undefined, false);
  inFrame(k, [0, -0.065, -0.45], [0.32, 0, 0], () => gripParts(k, 0.05, 0.11, 0.065));

  // The next rocket's nose deep in the bore: a red tip on a cream body, like the rockets in flight.
  nose.add(new THREE.CylinderGeometry(0.02, 0.07, 0.09, 14), RED, [0, BORE_Y, -0.715], ALONG_Z);
  nose.add(tube(0.07, 0.07, 0.1, 14), CREAM, [0, BORE_Y, -0.62], ALONG_Z, undefined, false);
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

let droidTemplate: THREE.Group | null = null;
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
  droidTemplate ??= buildDroidFresh(TEAM);
  return paintTeam(droidTemplate.clone(true), color);
}

// ---- droid death breakup -----------------------------------------------------------------------------------------

/** One flying piece of a destroyed droid. The client adds `object` to the scene and calls updateDroidPieces. */
export interface DroidPiece {
  object: THREE.Group;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
}

/** Piece templates (painted TEAM), each centred on its own pivot and placed in droid space. */
let wrecks: THREE.Group[] | null = null;
function wreckTemplates(): THREE.Group[] {
  if (wrecks) return wrecks;
  const color = TEAM;
  const ink = droidInk();
  const piece = (name: string, centre: V3, parts: (k: Kit) => void, shift: V3 = [0, 0, 0]) => {
    const k = new Kit(true);
    k.base = translate(shift[0] - centre[0], shift[1] - centre[1], shift[2] - centre[2]);
    parts(k);
    const g = k.build(name, false, ink);
    g.position.set(...centre);
    return g;
  };
  wrecks = [
    piece('hover', [0, 0.45, 0], (k) => hoverParts(k, color)),
    piece('chest', [0, 1.0, 0], (k) => chestParts(k, color)),
    piece('arm', [-0.47, 0.82, -0.05], (k) => leftArmParts(k, color)),
    piece('head', [0, 1.4, 0], (k) => headParts(k, color)),
    piece('gun', [0.38, 0.92, -0.3], (k) => gunArmParts(k, color), SHOULDER),
  ];
  return wrecks;
}

/**
 * The pieces of `droid` (a buildDroid group, already placed in the world) blowing apart: head, chest, hover unit,
 * free arm and gun arm, each flung out from the body plus `push` (e.g. the killing blast's direction times 4).
 * About ten draw calls while they fly; drop them after a couple of seconds.
 */
export function buildDroidPieces(color: number, droid: THREE.Object3D, push?: THREE.Vector3): DroidPiece[] {
  droid.updateWorldMatrix(true, false);
  const q = droid.getWorldQuaternion(new THREE.Quaternion());
  return wreckTemplates().map((t) => {
    const object = paintTeam(t.clone(true), color);
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

// ---- warmup ------------------------------------------------------------------------------------------------------

/**
 * One of every model a match spawns after the world is built (a droid, its wreck pieces, a rocket, the pickups), for
 * Engine.warmup: their shaders compile and their geometry uploads up front, so the first rocket or the first death
 * does not hitch. All team colours share the same programs and geometry, so one colour covers them all.
 */
export function warmupModels(): THREE.Object3D[] {
  const droid = buildDroid(RED);
  return [droid, ...buildDroidPieces(RED, droid).map((p) => p.object), buildRocket(), buildPickup('health'), buildPickup('armor'), buildPickup('mega')];
}
