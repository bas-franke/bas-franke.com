// The Rockets player robot, after the concept art: a chunky, heroic low-poly biped in chamfered orange armour with
// cream panels, a gunmetal under-suit, a big round helmet with a wide black visor, glowing "^ ^" eyes and cyan-ringed
// ear pods, wide layered shoulder pads, gauntlet forearms with big hands, thick thighs and big boots with cream toe
// caps. It holds the launcher with both hands: the right on the main grip, its stock tucked under the arm, the left
// on the front grip. Every look (colours, paint pattern, helmet, face, shoulders, backpack, boots, emblem) is built
// from the same parts, here, for the customiser preview and the game alike.
//
// Draw calls are the budget: the whole robot, launcher included, is ONE skinned mesh plus ONE skinned ink hull.
// Every rigid part is weighted fully to one bone, so a "skin" is just a cheap way to move a dozen parts in one draw.
// Lit and glowing parts share a material: a vertex colour above 2 means "unlit", and a negative one means "take the
// body, trim or visor colour from the material". So geometry is shared by every colour and paint pattern; each look
// only costs one material (all looks share one shader program), and each part combination one template.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { type Backpack, type Boots, DEFAULT_LOOK, type Emblem, type Face, type Helmet, type Look, PATTERNS, type Pattern, type Shoulders } from '@shared/rockets/cosmetics';
import { hullGeometry, inkMaterial, toonRamp } from '../../engine/toon';
import { buildLauncher } from './models';

type V3 = [number, number, number];

/** Paint slots: these vertices take their colour from the look (see lookMaterial). */
const BODY = -1;
const TRIM = -2;
const VISOR = -3;
/**
 * Secondary plates: body and trim that the two-tone pattern swaps (BODY2 turns trim, TRIM2 turns body). The
 * vertex colour's blue channel carries the plate kind: 0 primary, 1 secondary, 2 never patterned (the launcher), 3
 * the helmet shell (SHELL: two-tone like a primary plate, but kept clean of stripes, chevrons and camo).
 */
const BODY2 = -4;
const TRIM2 = -5;
const SHELL = -6;
/** Under-suit, joints and the visor glass. */
const SUIT = 0x30343d;
const JOINT = 0x1d1f25;
const GLASS = 0x0b0d12;

// ---- materials ---------------------------------------------------------------------------------------------------

/**
 * The paint pattern for a lit body or trim vertex, from its plate kind and its rest-pose position (`vRkRest`, model
 * space, so the paint stays put on a moving limb). 0 plain, 1 two-tone, 2 stripes, 3 chevrons, 4 camo blocks.
 */
const PAINT = /* glsl */ `
uniform vec3 rkBody;
uniform vec3 rkTrim;
uniform vec3 rkVisor;
uniform float rkPattern;
varying vec3 vRkRest;
vec3 rkPaint( float slot, float plate ) {
	bool trim = slot < -1.5;
	if ( rkPattern < 0.5 || abs( plate - 2.0 ) < 0.5 ) return trim ? rkTrim : rkBody;
	if ( rkPattern < 1.5 ) return ( trim != ( abs( plate - 1.0 ) < 0.5 ) ) ? rkTrim : rkBody;
	if ( trim || plate > 2.5 ) return trim ? rkTrim : rkBody;
	vec3 p = vRkRest;
	if ( rkPattern < 2.5 ) return fract( ( p.y + p.x * 0.4 ) * 3.6 ) < 0.3 ? rkTrim : rkBody;
	if ( rkPattern < 3.5 ) return fract( ( p.y - abs( p.x ) * 0.9 ) * 4.0 + 0.3 ) < 0.3 ? rkTrim : rkBody;
	float h = fract( sin( dot( floor( p * vec3( 6.0, 5.0, 6.0 ) ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
	return h < 0.15 ? rkTrim : ( h < 0.5 ? rkBody * 0.6 : rkBody );
}
`;

/**
 * Decodes the vertex colour: slot vertices (r < 0) take a look colour, with g > 0.5 marking them unlit and b the
 * plate kind for the paint pattern; fixed colours above 2 are unlit too. `rkGlow` then swaps the cel-shaded result
 * for the flat colour.
 */
const COLOR_FRAGMENT = /* glsl */ `
float rkGlow = 0.0;
#if defined( USE_COLOR )
	vec3 rkC = vColor.rgb;
	if ( rkC.r < 0.0 ) {
		rkGlow = step( 0.5, rkC.g );
		rkC = rkC.r > -2.5 ? rkPaint( rkC.r, rkGlow > 0.5 ? 2.0 : rkC.b ) : rkVisor;
	} else if ( rkC.r > 1.5 ) {
		rkGlow = 1.0;
		rkC -= 2.0;
	}
	diffuseColor.rgb *= rkC;
#endif`;

const looks = new Map<string, THREE.MeshToonMaterial>();
/** The robot material for one set of colours and a paint pattern, cached. Cel-shaded with the toon rim band; glow parts unlit. */
function lookMaterial(body: number, trim: number, visor: number, pattern: Pattern = 'plain'): THREE.MeshToonMaterial {
  const key = `${body}:${trim}:${visor}:${pattern}`;
  let m = looks.get(key);
  if (m) return m;
  m = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true, gradientMap: toonRamp() });
  m.defines = { TOON_RIM: '' };
  const uniforms = {
    rkBody: { value: new THREE.Color(body) },
    rkTrim: { value: new THREE.Color(trim) },
    rkVisor: { value: new THREE.Color(visor) },
    rkPattern: { value: Math.max(0, PATTERNS.indexOf(pattern)) },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute vec3 rkRest;\nvarying vec3 vRkRest;\nvoid main() {')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRkRest = rkRest;');
    shader.fragmentShader =
      PAINT +
      shader.fragmentShader
        .replace('#include <color_fragment>', COLOR_FRAGMENT)
        .replace('#include <opaque_fragment>', 'outgoingLight = mix( outgoingLight, diffuseColor.rgb, rkGlow );\n#include <opaque_fragment>');
  };
  m.customProgramCacheKey = () => 'rk-robot';
  looks.set(key, m);
  return m;
}

/** Same line as the droids had: a little thinner than the world's, so the body colour still wins at a distance. */
const INK_PER_DEPTH = 0.003;
const INK_MIN = 0.006;
const robotInk = () => inkMaterial(INK_PER_DEPTH, INK_MIN);

const P11_REF = 1 / Math.tan((82 / 2) * THREE.MathUtils.DEG2RAD);
const skinInkPx = { value: 2 / 720 };
const inkBuffer = new THREE.Vector2();
let skinInk: THREE.MeshBasicMaterial | null = null;
/**
 * engine/toon's ink, for skinned hulls: the same constant-on-screen push, but along the skinned normal so the line
 * stays even on a bent knee. It follows the shared ink's visibility (the outlines quality switch).
 */
function skinnedInk(): THREE.MeshBasicMaterial {
  if (skinInk) return skinInk;
  const m = new THREE.MeshBasicMaterial({ color: robotInk().color, side: THREE.BackSide, fog: true });
  Object.defineProperty(m, 'visible', { get: () => robotInk().visible, set: () => {} });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.inkPx = skinInkPx;
    shader.vertexShader = shader.vertexShader.replace('void main() {', 'uniform float inkPx;\nvoid main() {').replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      #ifdef USE_SKINNING
        vec3 inkN = normalize( normalMatrix * objectNormal );
      #else
        vec3 inkN = normalize( normalMatrix * normal );
      #endif
      float inkDepth = max( -mvPosition.z, 0.0 );
      float inkP11 = projectionMatrix[ 1 ][ 1 ];
      mvPosition.xyz += inkN * max( ${INK_MIN.toFixed(4)}, inkDepth * max( ${(INK_PER_DEPTH * P11_REF).toFixed(5)}, inkPx ) / inkP11 );
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  m.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(inkBuffer);
    if (inkBuffer.y > 0) skinInkPx.value = 2 / inkBuffer.y;
  };
  m.customProgramCacheKey = () => 'rk-robot-ink';
  return (skinInk = m);
}

// ---- geometry kit ------------------------------------------------------------------------------------------------

/** Colour attribute values for `color` (a hex or a paint slot), lit or unlit. */
function encode(color: number, glow: boolean): V3 {
  if (color === BODY2 || color === TRIM2) return [color === BODY2 ? BODY : TRIM, glow ? 1 : 0, 1];
  if (color === SHELL) return [BODY, glow ? 1 : 0, 3];
  if (color < 0) return [color, glow ? 1 : 0, 0];
  const c = new THREE.Color(color);
  return glow ? [c.r + 2, c.g + 2, c.b + 2] : [c.r, c.g, c.b];
}

function keepOnly(g: THREE.BufferGeometry, names: string[]) {
  for (const name of Object.keys(g.attributes)) if (!names.includes(name)) g.deleteAttribute(name);
  return g;
}

/** One rigid part: lit+glow surface (non-indexed: position, normal, color) and ink hull (indexed: position, normal). */
interface Part {
  bone: BoneName;
  lit: THREE.BufferGeometry;
  hull: THREE.BufferGeometry | null;
}

/** Collects transformed, vertex-coloured primitives for one bone. Parts are authored in model space; `base` maps them into the bone. */
class Kit {
  private readonly lit: THREE.BufferGeometry[] = [];
  private readonly hulls: THREE.BufferGeometry[] = [];
  base = new THREE.Matrix4();

  add(geo: THREE.BufferGeometry, color: number, pos: V3 = [0, 0, 0], rot: V3 | THREE.Quaternion = [0, 0, 0], scale: V3 = [1, 1, 1], ink = true) {
    return this.put(geo, color, false, pos, rot, scale, ink);
  }

  /** An unlit part: always full brightness, no ink unless asked. */
  glow(geo: THREE.BufferGeometry, color: number, pos: V3 = [0, 0, 0], rot: V3 | THREE.Quaternion = [0, 0, 0], scale: V3 = [1, 1, 1], ink = false) {
    return this.put(geo, color, true, pos, rot, scale, ink);
  }

  /** Bakes a finished models.ts model (lit, glow and ink meshes) into this part at `at`. */
  graft(src: THREE.Object3D, at: THREE.Matrix4) {
    src.updateMatrixWorld(true);
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.matrixWorld.clone().premultiply(at).premultiply(this.base);
      const mat = mesh.material as THREE.Material;
      const g = mesh.geometry.clone().applyMatrix4(m);
      if (mat.side === THREE.BackSide) {
        this.hulls.push(keepOnly(g.index ? g : mergeIndex(g), ['position', 'normal']));
        return;
      }
      const flat = keepOnly(g.index ? g.toNonIndexed() : g, ['position', 'normal', 'color']);
      const glow = (mat as THREE.MeshBasicMaterial).isMeshBasicMaterial;
      const c = flat.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < c.count; i++) {
        // Paint slots stay unpatterned (plate kind 2); fixed glow colours move above 2.
        if (c.getX(i) < 0) c.setXYZ(i, c.getX(i), glow ? 1 : 0, 2);
        else if (glow) c.setXYZ(i, c.getX(i) + 2, c.getY(i) + 2, c.getZ(i) + 2);
      }
      this.lit.push(flat);
    });
    return this;
  }

  private put(geo: THREE.BufferGeometry, color: number, glow: boolean, pos: V3, rot: V3 | THREE.Quaternion, scale: V3, ink: boolean) {
    const q = rot instanceof THREE.Quaternion ? rot : new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...pos), q, new THREE.Vector3(...scale)).premultiply(this.base);
    if (ink) this.hulls.push(hullGeometry(geo).applyMatrix4(m));
    const g = keepOnly(geo.index ? geo.toNonIndexed() : geo.clone(), ['position', 'normal']);
    geo.dispose();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g.applyMatrix4(m);
    const [r, gr, b] = encode(color, glow);
    const n = g.getAttribute('position').count;
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = r;
      rgb[i * 3 + 1] = gr;
      rgb[i * 3 + 2] = b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    this.lit.push(g);
    return this;
  }

  part(bone: BoneName): Part {
    const lit = mergeGeometries(this.lit, false);
    // The rest-pose model-space position, for the paint pattern: base is a pure translation by -origin.
    const rest = (lit.getAttribute('position') as THREE.BufferAttribute).clone();
    const o = new THREE.Vector3().setFromMatrixPosition(this.base);
    for (let i = 0; i < rest.count; i++) rest.setXYZ(i, rest.getX(i) - o.x, rest.getY(i) - o.y, rest.getZ(i) - o.z);
    lit.setAttribute('rkRest', rest);
    const hull = this.hulls.length ? mergeGeometries(this.hulls, false) : null;
    for (const g of [...this.lit, ...this.hulls]) g.dispose();
    return { bone, lit, hull };
  }
}

/** An indexed copy (each vertex its own index), so a non-indexed hull can merge with indexed ones. */
function mergeIndex(g: THREE.BufferGeometry) {
  const n = g.getAttribute('position').count;
  g.setIndex(Array.from({ length: n }, (_, i) => i));
  return g;
}

/**
 * A hard-surface block: `w` x `h` x `d` with every edge chamfered by `b`. `top` and `bot` scale the top and bottom
 * faces ([x, z] or one number), for tapered armour plates. Flat-shaded.
 */
function block(w: number, h: number, d: number, b: number, top: number | [number, number] = 1, bot: number | [number, number] = 1): THREE.BufferGeometry {
  const [tx, tz] = typeof top === 'number' ? [top, top] : top;
  const [bx, bz] = typeof bot === 'number' ? [bot, bot] : bot;
  const pts: THREE.Vector3[] = [];
  for (const sy of [-1, 1]) {
    const x = (w / 2) * (sy > 0 ? tx : bx);
    const z = (d / 2) * (sy > 0 ? tz : bz);
    const y = h / 2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        pts.push(new THREE.Vector3(sx * (x - b), sy * y, sz * (z - b)));
        pts.push(new THREE.Vector3(sx * (x - b), sy * (y - b), sz * z));
        pts.push(new THREE.Vector3(sx * x, sy * (y - b), sz * (z - b)));
      }
    }
  }
  return new ConvexGeometry(pts);
}

const box = (x: number, y: number, z: number) => new THREE.BoxGeometry(x, y, z);
const cyl = (rt: number, rb: number, h: number, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg);
/** Rotations that lay a Y-axis primitive along X or Z. */
const ALONG_X: V3 = [0, 0, Math.PI / 2];
const ALONG_Z: V3 = [Math.PI / 2, 0, 0];
const FACE_X: V3 = [0, Math.PI / 2, 0];

const vec = (p: V3) => new THREE.Vector3(...p);
const tuple = (v: THREE.Vector3): V3 => [v.x, v.y, v.z];
const Y_UP = new THREE.Vector3(0, 1, 0);
/** Rotation turning +Y toward `dir`. */
const toward = (dir: THREE.Vector3) => new THREE.Quaternion().setFromUnitVectors(Y_UP, dir.clone().normalize());
/** `p` moved by `offset` in the frame `q`. */
const local = (p: THREE.Vector3, q: THREE.Quaternion, offset: V3): V3 => tuple(vec(offset).applyQuaternion(q).add(p));

/** A cyan (visor colour) slit light in a black recess, on a face whose outward normal is `out` (in the frame `q`). */
function slit(k: Kit, at: THREE.Vector3, q: THREE.Quaternion, size: V3, out: V3) {
  const o = vec(out);
  k.add(box(size[0] + 0.014, size[1] + 0.014, size[2] + 0.014), JOINT, local(at, q, tuple(o.clone().multiplyScalar(-0.004))), q, undefined, false);
  k.glow(box(...size), VISOR, local(at, q, tuple(o.clone().multiplyScalar(0.004))), q);
}

// ---- skeleton ----------------------------------------------------------------------------------------------------

const BONES = ['hips', 'torso', 'head', 'armL', 'foreL', 'aim', 'recoil', 'legL', 'shinL', 'footL', 'legR', 'shinR', 'footR'] as const;
type BoneName = (typeof BONES)[number];

const PARENT: Record<BoneName, BoneName | null> = {
  hips: null,
  torso: 'hips',
  head: 'torso',
  armL: 'torso',
  foreL: 'armL',
  aim: 'torso',
  recoil: 'aim',
  legL: 'hips',
  shinL: 'legL',
  footL: 'shinL',
  legR: 'hips',
  shinR: 'legR',
  footR: 'shinR',
};

/** Joint positions in model space (feet at the origin, facing -Z, about 1.8 m tall). */
const HIP_Y = 0.92;
const LEG_X = 0.15;
const PIVOT: Record<BoneName, V3> = {
  hips: [0, HIP_Y, 0],
  torso: [0, 1.02, 0],
  head: [0, 1.42, 0],
  armL: [-0.36, 1.33, 0],
  foreL: [-0.385, 1.02, 0],
  aim: [0.36, 1.33, 0],
  recoil: [0.36, 1.33, 0],
  legL: [-LEG_X, 0.88, 0],
  shinL: [-LEG_X, 0.49, 0],
  footL: [-LEG_X, 0.12, 0],
  legR: [LEG_X, 0.88, 0],
  shinR: [LEG_X, 0.49, 0],
  footR: [LEG_X, 0.12, 0],
};
/** The left hand's centre at rest (end of the foreL bone). */
const HAND_L: V3 = [-0.395, 0.6, -0.01];

/**
 * The hold: the upper body turns this far (radians, to the right) at the waist, like a rifle stance, so the left
 * shoulder comes forward and the left hand reaches the launcher; the gun arm and the head turn back to face ahead.
 */
const TWIST = -0.6;
/**
 * The launcher's size in the robot's hands, its grip origin in the hold (model space), and where the left hand goes
 * (gun space: the front grip under the coupling, the hand wrapping it from the left).
 */
const GUN_SCALE = 0.8;
const GUN_AT: V3 = [0.22, 1.15, -0.36];
const LEFT_GRIP: V3 = [-0.02, -0.13, -0.48];
const BACK_GRIP: V3 = [-0.03, -0.13, -0.24];
/** How far the left shoulder reaches forward while holding the gun. */
const REACH = 0.14;

/** Where a point attached to the torso ends up after the hold twist. */
function twisted(p: V3): THREE.Vector3 {
  const t = PIVOT.torso;
  return vec(p).sub(vec(t)).applyAxisAngle(Y_UP, TWIST).add(vec(t));
}
/** The gun shoulder in the hold; the gun arm is authored there in model space (its bone turns back by -TWIST). */
const AIM_HELD = twisted(PIVOT.aim);

const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
/**
 * Elbow for a two-bone limb from `s` reaching for `t` (lengths l1, l2), bending toward `pole`. Out-of-reach targets
 * straighten the limb toward them. Writes into `out`; no allocations.
 */
function solveElbow(s: THREE.Vector3, t: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, out: THREE.Vector3) {
  _d.subVectors(t, s);
  const d = THREE.MathUtils.clamp(_d.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  _d.normalize();
  const a = Math.acos(THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  _n.copy(pole).addScaledVector(_d, -pole.dot(_d)).normalize();
  return out.copy(s).addScaledVector(_d, Math.cos(a) * l1).addScaledVector(_n, Math.sin(a) * l1);
}

// ---- parts -------------------------------------------------------------------------------------------------------

/** Hips: gunmetal pelvis, an orange belt with round hip discs, a front plate. */
function hipParts(k: Kit) {
  k.add(block(0.38, 0.2, 0.28, 0.06, 1.1, 0.8), SUIT, [0, 0.9, 0]);
  k.add(block(0.48, 0.09, 0.32, 0.03), BODY, [0, 0.99, 0]);
  k.add(block(0.21, 0.17, 0.08, 0.03, [1.25, 1], [0.65, 1]), BODY, [0, 0.89, -0.165]);
  k.add(block(0.1, 0.05, 0.02, 0.008), TRIM, [0, 0.925, -0.207], undefined, undefined, false);
  k.add(box(0.09, 0.04, 0.02), JOINT, [0, 0.99, -0.165], undefined, undefined, false);
  k.add(block(0.3, 0.13, 0.07, 0.02), BODY, [0, 0.93, 0.15]);
  for (const s of [-1, 1]) {
    k.add(cyl(0.088, 0.088, 0.06, 12), BODY2, [s * 0.26, 0.96, 0], ALONG_X);
    k.add(cyl(0.045, 0.045, 0.02, 10), JOINT, [s * 0.295, 0.96, 0], ALONG_X, undefined, false);
  }
}

/** Thigh: dark core under a thick orange plate with a cream outer panel. `s` is -1 left, 1 right. */
function thighParts(k: Kit, s: number) {
  const x = s * LEG_X;
  k.add(cyl(0.1, 0.085, 0.42, 8), SUIT, [x, 0.68, 0.01]);
  k.add(block(0.29, 0.33, 0.31, 0.07, [1.05, 1], [0.82, 0.88]), BODY, [x + s * 0.01, 0.69, -0.01]);
  k.add(block(0.035, 0.22, 0.17, 0.014), TRIM, [x + s * 0.163, 0.7, -0.01]);
  k.add(box(0.08, 0.1, 0.012), JOINT, [x + s * 0.01, 0.63, -0.16], undefined, undefined, false);
}

/** Shin: orange greave with a cyan slit, cream side panel, a cream knee pad and the knee joint. */
function shinParts(k: Kit, s: number) {
  const x = s * LEG_X;
  k.add(cyl(0.08, 0.07, 0.36, 8), SUIT, [x, 0.3, 0.02]);
  k.add(block(0.25, 0.3, 0.26, 0.055, [1.05, 1.1], [0.85, 0.85]), BODY2, [x, 0.32, -0.01]);
  slit(k, vec([x, 0.32, -0.148]), new THREE.Quaternion(), [0.026, 0.13, 0.01], [0, 0, -1]);
  k.add(block(0.028, 0.21, 0.14, 0.01), TRIM2, [x + s * 0.126, 0.31, 0]);
  k.add(cyl(0.08, 0.08, 0.19, 10), JOINT, [x, 0.49, 0.02], ALONG_X);
  k.add(block(0.19, 0.17, 0.1, 0.04, [0.85, 1]), TRIM, [x, 0.51, -0.11], [0.15, 0, 0]);
}

/** An ankle disc with a cyan ring on the outside of the boot. */
function ankle(k: Kit, x: number, s: number, y: number, out: number) {
  k.add(cyl(0.068, 0.068, 0.03, 12), JOINT, [x + s * out, y, 0], ALONG_X);
  k.glow(new THREE.TorusGeometry(0.046, 0.011, 4, 12), VISOR, [x + s * (out + 0.017), y, 0], FACE_X);
}

/**
 * Boots. Standard (the concept): orange upper on a black sole, a big cream toe cap. Heavy: wider and taller with a
 * tread sole, armoured cuff and a cream band. Spring: a slim boot on a coil and a sole pad.
 */
function bootParts(k: Kit, s: number, kind: Boots) {
  const x = s * LEG_X;
  if (kind === 'heavy') {
    k.add(block(0.34, 0.07, 0.6, 0.02), JOINT, [x, 0.035, -0.08]);
    for (const z of [-0.3, -0.16, 0.02, 0.16]) k.add(box(0.35, 0.03, 0.05), JOINT, [x, 0.02, z], undefined, undefined, false);
    k.add(block(0.33, 0.2, 0.52, 0.07, [0.88, 0.75]), BODY, [x, 0.165, -0.07]);
    k.add(block(0.31, 0.15, 0.2, 0.05, [0.8, 0.6]), TRIM, [x, 0.14, -0.27], [-0.15, 0, 0]);
    k.add(block(0.3, 0.15, 0.31, 0.045, 0.9), BODY2, [x, 0.3, 0]);
    k.add(block(0.31, 0.03, 0.32, 0.01), TRIM2, [x, 0.36, 0]);
    k.add(block(0.26, 0.1, 0.09, 0.02), JOINT, [x, 0.09, 0.17]);
    slit(k, vec([x, 0.3, -0.158]), new THREE.Quaternion(), [0.1, 0.016, 0.01], [0, 0, -1]);
    ankle(k, x, s, 0.21, 0.155);
    return;
  }
  if (kind === 'spring') {
    k.add(block(0.25, 0.04, 0.4, 0.015), JOINT, [x, 0.02, -0.05]);
    for (const [i, y] of [0.055, 0.08, 0.105].entries()) {
      if (i === 1) k.glow(new THREE.TorusGeometry(0.075, 0.012, 4, 14), VISOR, [x, y, 0.0], ALONG_Z);
      else k.add(new THREE.TorusGeometry(0.075, 0.016, 4, 14), SUIT, [x, y, 0.0], ALONG_Z);
    }
    k.add(block(0.25, 0.12, 0.4, 0.05, [0.85, 0.7]), BODY, [x, 0.17, -0.05]);
    k.add(block(0.23, 0.09, 0.14, 0.035, [0.8, 0.6]), TRIM, [x, 0.17, -0.19], [-0.12, 0, 0]);
    k.add(block(0.23, 0.07, 0.25, 0.025), BODY2, [x, 0.25, 0]);
    ankle(k, x, s, 0.19, 0.125);
    return;
  }
  k.add(block(0.3, 0.06, 0.52, 0.02), JOINT, [x, 0.03, -0.07]);
  k.add(block(0.29, 0.17, 0.46, 0.06, [0.88, 0.72]), BODY, [x, 0.14, -0.06]);
  k.add(block(0.27, 0.12, 0.17, 0.045, [0.8, 0.6]), TRIM, [x, 0.12, -0.23], [-0.15, 0, 0]);
  k.add(block(0.25, 0.1, 0.09, 0.02), JOINT, [x, 0.08, 0.16]);
  k.add(block(0.26, 0.08, 0.27, 0.03), BODY2, [x, 0.24, 0]);
  ankle(k, x, s, 0.17, 0.145);
}

/** Torso: segmented dark abdomen, the big orange chest with a cream centre plate and cyan lights, a back plate. */
function torsoParts(k: Kit) {
  k.add(block(0.32, 0.17, 0.24, 0.04), SUIT, [0, 1.08, 0]);
  for (const y of [1.05, 1.1]) k.add(block(0.34, 0.02, 0.255, 0.007), JOINT, [0, y, 0], undefined, undefined, false);
  for (const s of [-1, 1]) {
    k.add(block(0.07, 0.15, 0.2, 0.025), BODY2, [s * 0.165, 1.08, -0.01]);
    k.glow(box(0.012, 0.07, 0.012), VISOR, [s * 0.2, 1.08, -0.06]);
  }
  k.add(block(0.62, 0.32, 0.4, 0.08, [1, 0.95], [0.75, 0.82]), BODY, [0, 1.29, 0]);
  // The cream centre plate: a tall hexagon over the sternum, lower and wider at the top.
  k.add(block(0.25, 0.24, 0.07, 0.035, [1.12, 1], [0.6, 1]), TRIM, [0, 1.25, -0.185], [0.12, 0, 0]);
  slit(k, vec([0, 1.405, -0.19]), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, 0)), [0.13, 0.018, 0.01], [0, 0, -1]);
  for (const s of [-1, 1]) slit(k, vec([s * 0.2, 1.2, -0.168]), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s * 0.5, s * -0.3)), [0.07, 0.013, 0.01], [0, 0, -1]);
  k.add(block(0.32, 0.06, 0.26, 0.02), SUIT, [0, 1.45, 0]);
  k.add(block(0.4, 0.28, 0.12, 0.04), BODY, [0, 1.28, 0.24]);
  k.add(block(0.22, 0.1, 0.03, 0.01), TRIM, [0, 1.31, 0.305]);
  for (const s of [-1, 1]) k.add(new THREE.SphereGeometry(0.11, 8, 6), JOINT, [s * 0.34, 1.33, 0]);
}

/** The backpack on the back plate (torso bone). */
function backpackParts(k: Kit, kind: Backpack) {
  if (kind === 'thrusters') {
    // Two jump-jet pods, cream-capped, with glowing nozzles pointing down.
    for (const s of [-1, 1]) {
      const x = s * 0.12;
      k.add(cyl(0.075, 0.085, 0.3, 8), BODY2, [x, 1.25, 0.37]);
      k.add(cyl(0.06, 0.08, 0.05, 8), TRIM, [x, 1.42, 0.37]);
      k.add(cyl(0.085, 0.06, 0.08, 8), JOINT, [x, 1.07, 0.37]);
      k.glow(cyl(0.045, 0.045, 0.01, 8), VISOR, [x, 1.028, 0.37]);
      k.glow(box(0.012, 0.12, 0.012), VISOR, [x, 1.26, 0.452]);
    }
    k.add(block(0.18, 0.12, 0.08, 0.02), JOINT, [0, 1.3, 0.33]);
  } else if (kind === 'antenna-pack') {
    // A radio box with a tall whip antenna and a stubby one.
    k.add(block(0.32, 0.3, 0.15, 0.04, 0.92), BODY2, [0, 1.27, 0.37]);
    k.add(block(0.2, 0.1, 0.02, 0.008), TRIM, [0, 1.3, 0.448]);
    for (const x of [-0.06, 0, 0.06]) k.glow(box(0.02, 0.02, 0.01), VISOR, [x, 1.19, 0.448]);
    k.add(cyl(0.009, 0.014, 0.5, 6), JOINT, [0.1, 1.65, 0.38], [0.08, 0, -0.05]);
    k.glow(new THREE.IcosahedronGeometry(0.032, 0), VISOR, [0.112, 1.9, 0.4], undefined, undefined, true);
    k.add(cyl(0.012, 0.016, 0.18, 6), JOINT, [-0.1, 1.49, 0.38], [0.1, 0, 0.15]);
    k.add(block(0.05, 0.03, 0.05, 0.01), TRIM, [-0.113, 1.58, 0.389]);
  } else if (kind === 'tank') {
    // A fat cream tank, strapped across, with orange end caps and a glowing gauge.
    k.add(cyl(0.13, 0.13, 0.3, 10), TRIM2, [0, 1.27, 0.4]);
    for (const y of [1.44, 1.1]) k.add(cyl(y > 1.2 ? 0.08 : 0.13, y > 1.2 ? 0.13 : 0.08, 0.06, 10), BODY2, [0, y, 0.4]);
    k.add(cyl(0.03, 0.03, 0.06, 6), JOINT, [0, 1.49, 0.4]);
    for (const y of [1.2, 1.34]) k.add(cyl(0.136, 0.136, 0.025, 10), JOINT, [0, y, 0.4], undefined, undefined, false);
    k.glow(box(0.06, 0.02, 0.012), VISOR, [0, 1.27, 0.534]);
  }
}

/** Shoulder pads (on the torso, so the arms swing under them): a big plate with a cream cap over a second layer. */
function padFrame(kind: Shoulders, s: number) {
  const block = kind === 'block';
  const at = vec([s * (block ? 0.43 : 0.42), 1.39, 0]);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -s * (block ? 0.12 : 0.14)));
  /** Half the pad's width at its middle, where the emblem goes. */
  return { at, q, half: block ? 0.145 : 0.142 };
}

function padParts(k: Kit, kind: Shoulders) {
  for (const s of [-1, 1]) {
    const { at, q } = padFrame(kind, s);
    if (kind === 'block') {
      k.add(block(0.3, 0.26, 0.4, 0.03, 0.92), BODY, tuple(at), q);
      k.add(block(0.32, 0.04, 0.42, 0.01), TRIM, local(at, q, [0, 0.145, 0]), q);
      k.add(block(0.27, 0.11, 0.36, 0.025), BODY2, [s * 0.48, 1.23, 0], [0, 0, -s * 0.25]);
    } else {
      // Round (the concept) and spike: a big bevelled pad with a cream cap and a second layer.
      k.add(block(0.3, 0.25, 0.38, 0.05, [0.85, 0.9]), BODY, tuple(at), q);
      k.add(block(0.17, 0.045, 0.27, 0.015), TRIM, local(at, q, [s * 0.005, 0.118, 0]), q);
      k.add(block(0.26, 0.11, 0.34, 0.04, 1, 0.85), BODY2, [s * 0.46, 1.245, 0], [0, 0, -s * 0.22]);
      k.add(block(0.03, 0.08, 0.16, 0.01), TRIM2, [s * 0.46, 1.245, -0.165], [0, 0, -s * 0.22]);
      if (kind === 'spike') {
        for (const z of [-0.08, 0.08]) k.add(new THREE.ConeGeometry(0.06, 0.18, 6), TRIM, local(at, q, [s * 0.03, 0.2, z]), [0, 0, -s * 0.35]);
      }
    }
    // A cyan slit along the outside of the lower layer.
    const lq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -s * (kind === 'block' ? 0.25 : 0.22)));
    slit(k, vec([s * (kind === 'block' ? 0.48 : 0.46), kind === 'block' ? 1.23 : 1.245, 0]), lq, [0.01, 0.016, 0.2], [s, 0, 0]);
  }
}

/** The emblem's outline, about 1 across, centred. */
function emblemShape(kind: Emblem): THREE.Shape {
  const poly = (pts: [number, number][]) => new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const around = (n: number, r: (i: number) => number, turn = 0) =>
    poly(Array.from({ length: n }, (_, i) => [Math.sin((i / n) * Math.PI * 2 + turn) * r(i), Math.cos((i / n) * Math.PI * 2 + turn) * r(i)] as [number, number]));
  switch (kind) {
    case 'star':
      return around(10, (i) => (i % 2 ? 0.21 : 0.52));
    case 'bolt':
      return poly([[0.14, 0.52], [-0.26, -0.02], [-0.02, -0.02], [-0.14, -0.52], [0.26, 0.08], [0.02, 0.08]]);
    case 'ring': {
      const sh = around(16, () => 0.5);
      sh.holes.push(new THREE.Path(Array.from({ length: 16 }, (_, i) => new THREE.Vector2(Math.sin((-i / 16) * Math.PI * 2) * 0.27, Math.cos((-i / 16) * Math.PI * 2) * 0.27))));
      return sh;
    }
    case 'diamond':
      return poly([[0, 0.52], [0.34, 0], [0, -0.52], [-0.34, 0]]);
    case 'cross':
      return poly([[-0.15, 0.5], [0.15, 0.5], [0.15, 0.15], [0.5, 0.15], [0.5, -0.15], [0.15, -0.15], [0.15, -0.5], [-0.15, -0.5], [-0.15, -0.15], [-0.5, -0.15], [-0.5, 0.15], [-0.15, 0.15]]);
    default: {
      // Heart: the classic parametric curve.
      const pts: [number, number][] = [];
      for (let i = 0; i < 24; i++) {
        const t = (i / 24) * Math.PI * 2;
        pts.push([(16 * Math.sin(t) ** 3) / 33, (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 33 + 0.08]);
      }
      return poly(pts);
    }
  }
}

/** The emblem decal on the outside of the left shoulder pad: trim on a thin black backing. */
function emblemParts(k: Kit, kind: Emblem, shoulders: Shoulders) {
  if (kind === 'none') return;
  const { at, q, half } = padFrame(shoulders, -1);
  const face = q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0)));
  const flat = () => new THREE.ExtrudeGeometry(emblemShape(kind), { depth: 1, bevelEnabled: false, curveSegments: 4 }).translate(0, 0, -0.5);
  k.add(flat(), JOINT, local(at, q, [-half - 0.002, -0.005, 0]), face, [0.155, 0.155, 0.008], false);
  k.add(flat(), TRIM, local(at, q, [-half - 0.007, -0.005, 0]), face, [0.125, 0.125, 0.006], false);
}

/** The free-hanging pose of the left upper arm: dark sleeve under an orange bicep plate. */
function upperArmL(k: Kit) {
  k.add(cyl(0.07, 0.065, 0.3, 8), SUIT, [-0.372, 1.18, 0]);
  k.add(block(0.17, 0.18, 0.18, 0.045), BODY, [-0.375, 1.15, 0]);
}

/** A hand: dark palm, orange back plate, four fingers with orange tips and a thumb. Built hanging down, palm toward +X. */
function hand(k: Kit, at: THREE.Vector3, q: THREE.Quaternion, s: number, curl: number) {
  k.add(block(0.1, 0.13, 0.13, 0.025), JOINT, tuple(at), q);
  k.add(block(0.04, 0.11, 0.12, 0.014), BODY, local(at, q, [s * 0.055, 0, 0]), q);
  const fq = q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -s * curl)));
  for (const z of [-0.05, -0.017, 0.017, 0.05]) {
    k.add(box(0.034, 0.09, 0.03), JOINT, local(at, q, [-s * 0.008, -0.1, z]), fq);
    k.add(block(0.036, 0.036, 0.032, 0.009), BODY, local(at, q, [-s * (0.008 + curl * 0.06), -0.155, z]), fq, undefined, false);
  }
  k.add(box(0.036, 0.085, 0.036), JOINT, local(at, q, [-s * 0.05, -0.035, -0.078]), q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0, -s * 0.5))));
}

/** A gauntlet forearm from `elbow` to `wrist`: a big orange block, a cream panel, a cyan slit on the outside (`s` side). */
function forearm(k: Kit, elbow: THREE.Vector3, wrist: THREE.Vector3, s: number) {
  const q = toward(elbow.clone().sub(wrist));
  const mid = elbow.clone().add(wrist).multiplyScalar(0.5);
  const len = elbow.distanceTo(wrist);
  k.add(new THREE.SphereGeometry(0.078, 8, 6), JOINT, tuple(elbow));
  k.add(block(0.23, len, 0.24, 0.06, 1.05, 0.86), BODY2, tuple(mid), q);
  k.add(block(0.17, len * 0.72, 0.035, 0.014), TRIM2, local(mid, q, [0, 0.01, -0.12]), q);
  k.add(block(0.035, len * 0.4, 0.15, 0.012), TRIM2, local(mid, q, [s * 0.115, len * 0.2, 0.01]), q);
  slit(k, vec(local(mid, q, [s * 0.116, -len * 0.15, 0.02])), q, [0.01, len * 0.32, 0.024], [s, 0, 0]);
  k.add(cyl(0.058, 0.058, 0.06, 8), JOINT, tuple(wrist), q);
}

/** Left forearm and hand, hanging at rest (the hold pose comes from IK at runtime). */
function foreArmL(k: Kit) {
  const elbow = vec(PIVOT.foreL);
  const wrist = vec([-0.39, 0.705, -0.005]);
  forearm(k, elbow, wrist, -1);
  hand(k, vec(HAND_L), new THREE.Quaternion(), -1, 0.35);
}

/** The gun arm in the hold (model space, authored around AIM_HELD), and the launcher in its hand. */
function gunArmParts(k: Kit) {
  const gun = vec(GUN_AT);
  const s = GUN_SCALE;
  k.graft(buildLauncher(BODY), new THREE.Matrix4().compose(gun, new THREE.Quaternion(), new THREE.Vector3(s, s, s)));
  // Hand on the main grip, wrist behind it, elbow solved out and down.
  const palm = gun.clone().add(new THREE.Vector3(0.04, -0.09, 0.02).multiplyScalar(s));
  const wrist = palm.clone().add(new THREE.Vector3(0.03, 0.05, 0.1));
  const elbow = solveElbow(AIM_HELD, wrist, 0.31, 0.31, new THREE.Vector3(1, -0.7, 0.4), new THREE.Vector3());
  const upper = toward(AIM_HELD.clone().sub(elbow));
  const umid = AIM_HELD.clone().add(elbow).multiplyScalar(0.5);
  k.add(cyl(0.068, 0.062, AIM_HELD.distanceTo(elbow), 8), SUIT, tuple(umid), upper);
  k.add(block(0.17, 0.18, 0.18, 0.045), BODY, local(umid, upper, [0.01, -0.02, 0]), upper);
  forearm(k, elbow, wrist, 1);
  // The hand wraps the grip from the right: palm on the outside, fingers across the front.
  hand(k, palm, toward(wrist.clone().sub(palm)), 1, 1.2);
}

/** Helmet centre, scale and visor radius: the face glyphs sit on the visor. */
const HEAD_C: V3 = [0, 1.6, 0.01];
const HEAD_S: V3 = [1.05, 0.9, 1];
const SHELL_R = 0.27;
const VISOR_R = 0.283;

/** Position and rotation on the visor's surface at (x, y), facing out. */
function onVisor(x: number, y: number, lift = 0.004): { pos: V3; rot: V3 } {
  const nx = x / HEAD_S[0];
  const ny = (y - HEAD_C[1]) / HEAD_S[1];
  const r = VISOR_R + lift;
  const z = Math.sqrt(Math.max(0, r * r - nx * nx - ny * ny));
  return { pos: [x, y, HEAD_C[2] - z * HEAD_S[2]], rot: [Math.asin(ny / r), -Math.asin(nx / r), 0] };
}

/** Neck, the big round helmet shell, the wide black visor, a chin guard and the ear pods with cyan rings. */
function headParts(k: Kit) {
  k.add(cyl(0.08, 0.09, 0.1), SUIT, [0, 1.43, 0]);
  k.add(new THREE.SphereGeometry(SHELL_R, 18, 14), SHELL, HEAD_C, undefined, HEAD_S);
  // Visor: a wide sector of a slightly bigger sphere across the lower front, ear to ear.
  k.add(new THREE.SphereGeometry(VISOR_R, 20, 6, Math.PI * 1.5 - 1.25, 2.5, 1.33, 0.8), GLASS, HEAD_C, undefined, HEAD_S, false);
  k.add(block(0.26, 0.08, 0.1, 0.035, [1, 1.1], [0.7, 1]), BODY2, [0, 1.405, -0.2], [-0.4, 0, 0]);
  k.add(box(0.1, 0.018, 0.02), JOINT, [0, 1.42, -0.252], [-0.4, 0, 0], undefined, false);
  for (const s of [-1, 1]) {
    k.add(cyl(0.1, 0.1, 0.08, 16), BODY2, [s * 0.27, 1.585, 0.0], ALONG_X);
    k.add(cyl(0.074, 0.074, 0.02, 16), JOINT, [s * 0.315, 1.585, 0.0], ALONG_X, undefined, false);
    k.glow(new THREE.TorusGeometry(0.06, 0.012, 4, 16), VISOR, [s * 0.326, 1.585, 0.0], FACE_X);
    k.add(cyl(0.028, 0.028, 0.02, 10), SUIT, [s * 0.328, 1.585, 0.0], ALONG_X, undefined, false);
  }
}

/** The wide cream stripe over the top of the helmet, front to back. */
function stripe(k: Kit, color: number) {
  const g = new THREE.TorusGeometry(SHELL_R - 0.012, 0.024, 4, 20, 3.2).rotateZ(0.35);
  k.add(g, color, HEAD_C, FACE_X, [HEAD_S[2], HEAD_S[1], 2.6]);
}

function helmetParts(k: Kit, kind: Helmet) {
  stripe(k, TRIM);
  const top = HEAD_C[1] + SHELL_R * HEAD_S[1];
  if (kind === 'crest') {
    k.add(block(0.05, 0.15, 0.4, 0.016, [1, 0.6], [1, 1]), TRIM, [0, top + 0.035, 0.03], [-0.1, 0, 0]);
  } else if (kind === 'antenna') {
    k.add(cyl(0.009, 0.013, 0.26, 6), JOINT, [0.29, 1.76, 0.03], [0, 0, -0.12]);
    k.glow(new THREE.IcosahedronGeometry(0.033, 0), VISOR, [0.306, 1.895, 0.03], undefined, undefined, true);
  } else if (kind === 'horns') {
    for (const s of [-1, 1]) k.add(new THREE.ConeGeometry(0.05, 0.22, 6), TRIM, [s * 0.17, top - 0.015, 0], [0.15, 0, -s * 0.55]);
  }
}

/** Glowing face shapes on the visor, in the visor colour. */
function faceParts(k: Kit, kind: Face) {
  const eyeY = 1.565;
  if (kind === 'smile') {
    // "^ ^": two upturned arcs.
    for (const s of [-1, 1]) {
      const p = onVisor(s * 0.1, eyeY - 0.01);
      k.glow(new THREE.TorusGeometry(0.044, 0.013, 4, 10, Math.PI), VISOR, p.pos, p.rot, [1, 1, 0.4]);
    }
  } else if (kind === 'visor') {
    // One glowing band across, curved with the glass.
    const theta = Math.acos((eyeY - HEAD_C[1]) / HEAD_S[1] / VISOR_R);
    k.glow(new THREE.SphereGeometry(VISOR_R + 0.003, 20, 1, Math.PI * 1.5 - 0.9, 1.8, theta - 0.06, 0.12), VISOR, HEAD_C, undefined, HEAD_S);
  } else if (kind === 'cyclops') {
    const p = onVisor(0, eyeY);
    k.glow(new THREE.TorusGeometry(0.06, 0.015, 4, 16), VISOR, p.pos, p.rot, [1, 1, 0.4]);
    const c = onVisor(0, eyeY, 0.006);
    k.glow(cyl(0.026, 0.026, 0.006, 10), VISOR, c.pos, [c.rot[0] + Math.PI / 2, c.rot[1], 0]);
  } else {
    // Grin: two tall eyes over a wide smile.
    for (const s of [-1, 1]) {
      const p = onVisor(s * 0.085, eyeY + 0.03);
      k.glow(box(0.03, 0.058, 0.01), VISOR, p.pos, p.rot);
    }
    const m = onVisor(0, eyeY - 0.015);
    k.glow(new THREE.TorusGeometry(0.088, 0.012, 4, 14, Math.PI).rotateZ(Math.PI), VISOR, m.pos, m.rot, [1, 1, 0.4]);
  }
}

// ---- assembly ----------------------------------------------------------------------------------------------------

const parts = new Map<string, Part>();
/** A part cached by key, authored in model space and stored in `bone`'s space. `origin` is where model space puts the bone. */
function part(key: string, bone: BoneName, build: (k: Kit) => void, origin: THREE.Vector3 = vec(PIVOT[bone])): Part {
  let p = parts.get(key);
  if (!p) {
    const k = new Kit();
    k.base.makeTranslation(-origin.x, -origin.y, -origin.z);
    build(k);
    p = k.part(bone);
    parts.set(key, p);
  }
  return p;
}

function partsFor(look: Look): Part[] {
  const backpack = look.backpack ?? DEFAULT_LOOK.backpack;
  const boots = look.boots ?? DEFAULT_LOOK.boots;
  const emblem = look.emblem ?? DEFAULT_LOOK.emblem;
  const list = [
    part('hips', 'hips', hipParts),
    part('torso', 'torso', torsoParts),
    part(`pads:${look.shoulders}`, 'torso', (k) => padParts(k, look.shoulders)),
    part('head', 'head', headParts),
    part(`helmet:${look.helmet}`, 'head', (k) => helmetParts(k, look.helmet)),
    part(`face:${look.face}`, 'head', (k) => faceParts(k, look.face)),
    part('armL', 'armL', upperArmL),
    part('foreL', 'foreL', foreArmL),
    part('gun', 'recoil', gunArmParts, AIM_HELD),
    part('legL', 'legL', (k) => thighParts(k, -1)),
    part('shinL', 'shinL', (k) => shinParts(k, -1)),
    part(`footL:${boots}`, 'footL', (k) => bootParts(k, -1, boots)),
    part('legR', 'legR', (k) => thighParts(k, 1)),
    part('shinR', 'shinR', (k) => shinParts(k, 1)),
    part(`footR:${boots}`, 'footR', (k) => bootParts(k, 1, boots)),
  ];
  if (backpack !== 'none') list.push(part(`pack:${backpack}`, 'torso', (k) => backpackParts(k, backpack)));
  if (emblem !== 'none') list.push(part(`emblem:${emblem}:${look.shoulders}`, 'torso', (k) => emblemParts(k, emblem, look.shoulders)));
  return list;
}

/** Identifies the geometry (template) of a look: everything but the colours and the paint pattern. */
const variantKey = (look: Look) =>
  `${look.helmet}|${look.face}|${look.shoulders}|${look.backpack ?? DEFAULT_LOOK.backpack}|${look.boots ?? DEFAULT_LOOK.boots}|${look.emblem ?? DEFAULT_LOOK.emblem}`;
/** Identifies the material of a look in `body` (the team colour in team modes). */
const paintKey = (look: Look, body: number) => `${body}|${look.trim}|${look.visor}|${look.pattern ?? DEFAULT_LOOK.pattern}`;
const paint = (look: Look, body: number) => lookMaterial(body, look.trim, look.visor, look.pattern ?? DEFAULT_LOOK.pattern);

/** Skin attributes binding every vertex of `g` fully to bone `index`. */
function skin(g: THREE.BufferGeometry, index: number) {
  const n = g.getAttribute('position').count;
  const idx = new Uint16Array(n * 4);
  const w = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    idx[i * 4] = index;
    w[i * 4] = 1;
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
  return g;
}

/** Generous bounds for culling (the launcher reaches well in front at any pitch). */
const BOUNDS = new THREE.Sphere(new THREE.Vector3(0, 1, -0.2), 1.7);

const templates = new Map<string, THREE.Group>();
function template(look: Look): THREE.Group {
  const key = variantKey(look);
  let root = templates.get(key);
  if (root) return root;
  root = new THREE.Group();
  root.name = 'robot';
  const bones = new Map<BoneName, THREE.Bone>();
  for (const name of BONES) {
    const b = new THREE.Bone();
    b.name = name;
    b.rotation.order = 'YXZ';
    const parent = PARENT[name];
    const p = vec(PIVOT[name]);
    if (parent) {
      b.position.copy(p.sub(vec(PIVOT[parent])));
      bones.get(parent)!.add(b);
    } else {
      b.position.copy(p);
      root.add(b);
    }
    bones.set(name, b);
  }
  root.updateMatrixWorld(true);
  const lit: THREE.BufferGeometry[] = [];
  const hulls: THREE.BufferGeometry[] = [];
  for (const p of partsFor(look)) {
    const i = BONES.indexOf(p.bone);
    const m = bones.get(p.bone)!.matrixWorld;
    lit.push(skin(p.lit.clone().applyMatrix4(m), i));
    if (p.hull) hulls.push(skin(p.hull.clone().applyMatrix4(m), i));
  }
  const skeleton = new THREE.Skeleton(BONES.map((n) => bones.get(n)!));
  const body = new THREE.SkinnedMesh(mergeGeometries(lit, false), lookMaterial(0xffffff, 0xffffff, 0xffffff));
  body.name = 'body';
  body.castShadow = true;
  body.receiveShadow = true;
  const ink = new THREE.SkinnedMesh(mergeGeometries(hulls, false), skinnedInk());
  ink.name = 'ink';
  for (const g of [...lit, ...hulls]) g.dispose();
  root.add(body, ink);
  body.bind(skeleton);
  ink.bind(skeleton);
  templates.set(key, root);
  return root;
}

// ---- public API --------------------------------------------------------------------------------------------------

/** Pose state kept per robot instance (in userData.rig). */
interface Rig {
  b: Record<BoneName, THREE.Bone>;
  /** Walk cycle phase (radians), amount of walk (0..1), air pose blend (0..1). */
  phase: number;
  amp: number;
  air: number;
  /** Landing squash (0..1, decays) and the leg yaw toward the movement direction. */
  squash: number;
  legYaw: number;
  ground: boolean;
  fallVy: number;
}

/**
 * The player robot in `look`, facing -Z with its feet at the origin, about 1.8 m tall. In team modes `teamColor`
 * replaces the body colour. Two draw calls (body and ink) plus shadow. Named bones (plain Object3Ds): "hips",
 * "torso", "head", "armL", "aim" (the gun arm, pivot at the right shoulder), "recoil" (inside aim), "legL", "legR".
 * Pose it every frame with animateCharacter.
 */
export function buildCharacter(look: Look, teamColor?: number): THREE.Group {
  const root = cloneSkinned(template(look)) as THREE.Group;
  const mat = paint(look, teamColor ?? look.body);
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    mesh.boundingSphere = BOUNDS.clone();
    if (mesh.name === 'body') mesh.material = mat;
  });
  const b = {} as Record<BoneName, THREE.Bone>;
  for (const name of BONES) b[name] = root.getObjectByName(name) as THREE.Bone;
  const rig: Rig = { b, phase: Math.random() * 6, amp: 0, air: 0, squash: 0, legYaw: 0, ground: true, fallVy: 0 };
  root.userData.rig = rig;
  root.userData.lookKey = characterKey(look, teamColor);
  animateCharacter(root, { speed: 0, vx: 0, vz: 0, yaw: 0, onGround: true, vy: 0, pitch: 0, t: 0, dt: 0 });
  return root;
}

/** Identifies what buildCharacter(look, teamColor) would build, to tell when a remote needs rebuilding. */
export const characterKey = (look: Look, teamColor?: number) => `${variantKey(look)}|${paintKey(look, teamColor ?? look.body)}`;

export interface CharacterState {
  /** Horizontal speed (m/s) and velocity; yaw is the facing (the root's rotation.y). */
  speed: number;
  vx: number;
  vz: number;
  yaw: number;
  onGround: boolean;
  vy: number;
  /** Look pitch (radians, up is positive). */
  pitch: number;
  /** Clock (seconds) and frame step. */
  t: number;
  dt: number;
  /** Shot kick, 1 right after a shot and decaying to 0. */
  firing?: number;
}

/** Top running speed the walk cycle is tuned for. */
const RUN = 9.5;
const LEG_UPPER = 0.39;
const LEG_LOWER = 0.37;
const ARM_UPPER = vec(PIVOT.foreL).distanceTo(vec(PIVOT.armL));
const ARM_LOWER = vec(HAND_L).distanceTo(vec(PIVOT.foreL));
const ARM_DIR = vec(PIVOT.foreL).sub(vec(PIVOT.armL)).normalize();
const FORE_DIR = vec(HAND_L).sub(vec(PIVOT.foreL)).normalize();
/** The left hand's grip on the launcher, in the recoil bone's space. */
const GRIP_IN_GUN = vec(GUN_AT).add(vec(LEFT_GRIP).multiplyScalar(GUN_SCALE)).sub(AIM_HELD);
/** The fallback hold under the receiver, and how far the arm reaches before the hand slides back to it. */
const BACK_IN_GUN = vec(GUN_AT).add(vec(BACK_GRIP).multiplyScalar(GUN_SCALE)).sub(AIM_HELD);
const ARM_REACH = (ARM_UPPER + ARM_LOWER) * 0.97;
const SHOULDER_L = vec(PIVOT.armL).sub(vec(PIVOT.torso));
const ELBOW_POLE = new THREE.Vector3(-0.6, -1, 0.5).normalize();

const damp = (a: number, b: number, rate: number, dt: number) => a + (b - a) * (1 - Math.exp(-rate * dt));
const clamp = THREE.MathUtils.clamp;

const _s = new THREE.Vector3();
const _t = new THREE.Vector3();
const _e = new THREE.Vector3();
const _u = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Poses a buildCharacter robot: a walk/run cycle scaled by speed (legs turn toward the movement, the upper body keeps
 * facing ahead), an airborne tuck, a landing squash, idle breathing, the head and gun following the look pitch, the
 * left hand kept on the launcher, and the shot kick. No allocations.
 */
export function animateCharacter(obj: THREE.Object3D, s: CharacterState) {
  const r = obj.userData.rig as Rig | undefined;
  if (!r) return;
  const b = r.b;
  const dt = Math.min(s.dt, 0.1);

  // Movement relative to the facing; backwards runs the cycle in reverse with the legs facing ahead.
  const sy = Math.sin(s.yaw);
  const cy = Math.cos(s.yaw);
  const fwd = -sy * s.vx - cy * s.vz;
  const side = cy * s.vx - sy * s.vz;
  let a = s.speed > 0.6 ? Math.atan2(side, fwd) : 0;
  let dir = 1;
  if (a > Math.PI / 2) {
    a -= Math.PI;
    dir = -1;
  } else if (a < -Math.PI / 2) {
    a += Math.PI;
    dir = -1;
  }
  const run = clamp(s.speed / RUN, 0, 1);
  r.amp = damp(r.amp, s.onGround ? clamp(s.speed / 3, 0, 1) : 0, 10, dt);
  r.legYaw = damp(r.legYaw, -a * 0.8, 10, dt);
  if (s.onGround) r.phase += (dir * s.speed * Math.PI * 2 * dt) / (1.3 + 1.4 * run);
  r.air = damp(r.air, s.onGround ? 0 : 1, s.onGround ? 14 : 7, dt);
  if (s.onGround && !r.ground && r.fallVy < -4) r.squash = Math.max(r.squash, clamp((-r.fallVy - 4) / 12, 0.25, 1));
  if (!s.onGround) r.fallVy = s.vy;
  r.ground = s.onGround;
  r.squash = Math.max(0, r.squash - dt * 3);

  const amp = r.amp * (1 - r.air);
  const sp = Math.sin(r.phase);
  const cp = Math.cos(r.phase);
  const breathe = Math.sin(s.t * 1.9) * (1 - amp) * (1 - r.air);
  const swing = (0.35 + 0.35 * run) * amp;

  // Crouch keeps the feet under the hips: thigh forward k, knee back 2k, foot level.
  const squash = r.squash * r.squash * (3 - 2 * r.squash);
  const k = 0.1 + squash * 0.55 + amp * 0.08;
  const drop = (LEG_UPPER + LEG_LOWER) * (1 - Math.cos(k));
  // Air: knees up while rising, legs reaching down while falling.
  const tuck = clamp(0.75 + s.vy * 0.06, 0.3, 1) * r.air;

  for (let i = 0; i < 2; i++) {
    const leg = i === 0 ? b.legL : b.legR;
    const shin = i === 0 ? b.shinL : b.shinR;
    const foot = i === 0 ? b.footL : b.footR;
    const ph = i === 0 ? sp : -sp;
    const lift = Math.max(0, i === 0 ? cp * dir : -cp * dir);
    const thigh = k * (1 - r.air) + ph * swing + tuck * (i === 0 ? 1.05 : 0.45);
    const knee = -2 * k * (1 - r.air) - lift * (0.5 + 0.7 * run) * amp - tuck * (i === 0 ? 1.5 : 0.9) - r.air * 0.15;
    leg.rotation.set(thigh, 0, (i === 0 ? -1 : 1) * (0.06 + r.air * 0.08));
    shin.rotation.set(knee, 0, 0);
    foot.rotation.set(-(thigh + knee) * (1 - r.air) + r.air * 0.35, 0, 0);
  }

  b.hips.position.y = HIP_Y - drop + amp * 0.06 * (Math.abs(cp) - 1) + breathe * 0.004;
  b.hips.rotation.set(0, r.legYaw, -sp * 0.04 * amp);

  // Upper body: the hold twist, turned back from the legs so it faces ahead, a run lean and a little sway.
  // Looking up or down bends the chest along a little, so the long launcher does not swing across the face.
  // Aiming down bends the chest further, so the left hand can stay on the gun.
  const lean = -0.18 * run * amp * dir - 0.08 * r.air + breathe * 0.015 - squash * 0.15 + clamp(s.pitch, -1.2, 1) * (s.pitch < 0 ? 0.42 : 0.3);
  b.torso.rotation.set(lean, TWIST - r.legYaw - (s.firing ?? 0) * 0.06, sp * 0.03 * amp);
  b.head.rotation.set(clamp(s.pitch * 0.6, -0.55, 0.55) - lean, -TWIST, 0);
  b.aim.rotation.set(s.pitch - lean + cp * 0.03 * amp, -TWIST, 0);
  const kick = s.firing ?? 0;
  b.recoil.position.set(0, 0, kick * 0.1);
  b.recoil.rotation.set(kick * 0.3, 0, 0);

  // Left hand on the launcher: two-bone IK in torso space toward the front grip. Aiming far down swings the front
  // grip out of reach, so the hand slides back along the gun toward the receiver just enough to keep hold.
  b.armL.position.set(SHOULDER_L.x, SHOULDER_L.y, SHOULDER_L.z - REACH);
  _s.copy(b.armL.position);
  _t.copy(GRIP_IN_GUN).applyQuaternion(b.recoil.quaternion).add(b.recoil.position).applyQuaternion(b.aim.quaternion).add(b.aim.position);
  const front = _t.distanceTo(_s);
  if (front > ARM_REACH) {
    _e.copy(BACK_IN_GUN).applyQuaternion(b.recoil.quaternion).add(b.recoil.position).applyQuaternion(b.aim.quaternion).add(b.aim.position);
    const back = _e.distanceTo(_s);
    if (back < front) _t.lerp(_e, Math.min(1, (front - ARM_REACH) / (front - back)));
    // Still short (aiming steeply down): the shoulder reaches after it a little.
    const d = _t.distanceTo(_s);
    if (d > ARM_REACH) b.armL.position.copy(_s.lerp(_t, Math.min(0.12, d - ARM_REACH) / d));
  }
  solveElbow(_s, _t, ARM_UPPER, ARM_LOWER, ELBOW_POLE, _e);
  _u.subVectors(_e, _s).normalize();
  b.armL.quaternion.setFromUnitVectors(ARM_DIR, _u);
  _u.subVectors(_t, _e).normalize().applyQuaternion(_q.copy(b.armL.quaternion).invert());
  b.foreL.quaternion.setFromUnitVectors(FORE_DIR, _u);
}

/** One flying piece of a destroyed robot. The client adds `object` to the scene and calls updateCharacterPieces. */
export interface CharacterPiece {
  object: THREE.Group;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
}

/** Each piece: the bones whose parts it carries; it flies from the first one's pose. */
const PIECES: BoneName[][] = [['head'], ['torso'], ['hips'], ['armL', 'foreL'], ['recoil'], ['legL', 'shinL', 'footL'], ['legR', 'shinR', 'footR']];

/** Piece templates per variant: geometry centred on the piece, `userData.centre` its centre in the main bone's space. */
const wrecks = new Map<string, THREE.Group[]>();
function wreckTemplates(look: Look): THREE.Group[] {
  const key = variantKey(look);
  let list = wrecks.get(key);
  if (list) return list;
  const all = partsFor(look);
  list = PIECES.map((bones) => {
    const main = bones[0];
    const lit: THREE.BufferGeometry[] = [];
    const hulls: THREE.BufferGeometry[] = [];
    for (const p of all) {
      if (!bones.includes(p.bone)) continue;
      // Sub-bones sit at their rest offset from the main bone (the gun part lives in the recoil bone already).
      const o = vec(PIVOT[p.bone]).sub(vec(PIVOT[main]));
      lit.push(p.lit.clone().translate(o.x, o.y, o.z));
      if (p.hull) hulls.push(p.hull.clone().translate(o.x, o.y, o.z));
    }
    const litGeo = mergeGeometries(lit, false);
    litGeo.computeBoundingBox();
    const c = litGeo.boundingBox!.getCenter(new THREE.Vector3());
    litGeo.translate(-c.x, -c.y, -c.z);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(litGeo, lookMaterial(0xffffff, 0xffffff, 0xffffff)));
    if (hulls.length) g.add(new THREE.Mesh(mergeGeometries(hulls, false).translate(-c.x, -c.y, -c.z), robotInk()));
    g.userData.centre = c;
    g.userData.bone = main;
    for (const x of [...lit, ...hulls]) x.dispose();
    return g;
  });
  wrecks.set(key, list);
  return list;
}

const _p = new THREE.Vector3();
const _sc = new THREE.Vector3();
/**
 * The pieces of `obj` (a buildCharacter robot, already placed and posed in the world) blowing apart: head, chest,
 * hips, left arm, gun arm and both legs, each flung out from the body plus `push` (e.g. the blast direction times 4).
 * Fourteen draw calls while they fly; drop them after a couple of seconds.
 */
export function buildCharacterPieces(look: Look, teamColor: number | undefined, obj: THREE.Object3D, push?: THREE.Vector3): CharacterPiece[] {
  obj.updateWorldMatrix(true, true);
  const rig = obj.userData.rig as Rig | undefined;
  const origin = obj.getWorldPosition(new THREE.Vector3());
  const mat = paint(look, teamColor ?? look.body);
  return wreckTemplates(look).map((t) => {
    const object = t.clone(true);
    (object.children[0] as THREE.Mesh).material = mat;
    const bone = rig?.b[t.userData.bone as BoneName];
    const m = bone ? bone.matrixWorld : obj.matrixWorld;
    m.decompose(_p, object.quaternion, _sc);
    object.position.copy(t.userData.centre as THREE.Vector3).applyMatrix4(m);
    const out = object.position.clone().sub(origin);
    out.y = Math.max(0, out.y - 0.8);
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
export function updateCharacterPieces(pieces: CharacterPiece[], dt: number, floorY: number, gravity = 20) {
  for (const p of pieces) {
    const o = p.object;
    p.vel.y -= gravity * dt;
    o.position.addScaledVector(p.vel, dt);
    o.rotation.x += p.spin.x * dt;
    o.rotation.y += p.spin.y * dt;
    o.rotation.z += p.spin.z * dt;
    if (o.position.y < floorY + 0.15 && p.vel.y < 0) {
      o.position.y = floorY + 0.15;
      p.vel.y *= -0.35;
      p.vel.x *= 0.6;
      p.vel.z *= 0.6;
      p.spin.multiplyScalar(0.55);
    }
  }
}

/**
 * A robot and its wreck pieces, for Engine.warmup: the skinned and the plain variants of the robot shader compile
 * up front. Every look shares those programs.
 */
export function warmupCharacters(look: Look): THREE.Object3D[] {
  const robot = buildCharacter(look);
  return [robot, ...buildCharacterPieces(look, undefined, robot).map((p) => p.object)];
}
