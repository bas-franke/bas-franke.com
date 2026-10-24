// The small creatures of the enchanted library, soft and warm and chunky, made to read from high above and in front:
//   bat    — a glowing golden moth fairy with patterned wings and a little red banner (short words, fast)
//   meteor — a black fluffy soot sprite balancing a stack of books on its head (medium words)
//   ghost  — a snail whose shell is a rolled parchment scroll (long words, slow)
//   zmeu   — a soot sprite lugging a big red book with gold corners (the longest words)
//   rock   — a glossy teal ink-slime drop; a sentence is a row of them
//   head   — one head of the balaur boss (see ./boss)
// Every creature can wear a bubble shield (see ./shield), which carries the word in the language you read.
//
// Each model's origin is the ground contact point (y = 0), the body is above it and it faces +z. Static parts are
// merged into a few vertex-coloured geometries that are built once and shared by every instance (marked
// `userData.shared` so Game doesn't dispose them); only parts that animate on their own are separate meshes.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeHead } from './boss';
import { detectQuality } from './engine';
import { flatVertexColorMaterial, vertexColorMaterial } from './toon';

export { makeBalaurBody, makeHead } from './boss';
export { makeBubble, tickBubbles, type Bubble } from './shield';

export type Kind = 'meteor' | 'bat' | 'ghost' | 'zmeu' | 'rock' | 'head';

export interface Model {
  root: THREE.Group;
  /** Rough radius, for bubbles, effects and label placement. */
  radius: number;
  /** Top of the creature above its origin (the ground point), for label placement. */
  height: number;
  /** Main body colour, for the poof effect. */
  color: number;
  animate(dt: number, t: number): void;
  /** A quick squash when hit by a beam. */
  hit(): void;
}

// ---- building kit -------------------------------------------------------------------------------------------------

type Vec = [number, number, number];
/** A colour for a part: one hex, or a function of the vertex position in the part's own (untransformed) space. */
type Paint = number | ((x: number, y: number, z: number) => number);

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * What a part is, for morph targets: animated pieces of a merged mesh move by morph targets (one draw call) rather
 * than by transforms of separate meshes. `eye` is the centre an eye blinks about (in the bake's final space).
 */
interface Tag {
  foot?: number;
  load?: boolean;
  crawl?: boolean;
  stalk?: boolean;
  shell?: boolean;
  eye?: THREE.Vector3;
}
/** A morph target as a function moving one vertex (final space) of a part with the given tag. */
type Morph = (tag: Tag, v: THREE.Vector3) => void;

/** Collects primitives with a colour and a transform, and merges them into one vertex-coloured geometry. */
class Bake {
  private parts: { g: THREE.BufferGeometry; tag: Tag }[] = [];
  /** Tag for the parts added from now on. */
  tag: Tag = {};
  /** An extra transform applied after each part's own (a sub-assembly's place in the whole). */
  frame: THREE.Matrix4 | null = null;
  /** Bakes lighting into the colours of the parts added from now on (`c` linear, `n` final normal), for unlit meshes. */
  light: ((c: THREE.Color, n: THREE.Vector3) => void) | null = null;

  /** `rot` is Euler angles or a quaternion; `scale` a number or per-axis; `paint` null keeps the geometry's colours. */
  add(geo: THREE.BufferGeometry, paint: Paint | null, pos: Vec = [0, 0, 0], rot: Vec | THREE.Quaternion = [0, 0, 0], scale: number | Vec = 1) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && (paint !== null || name !== 'color')) g.deleteAttribute(name);
    const p = g.attributes.position;
    if (paint !== null) {
      const col = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        _c.setHex(typeof paint === 'number' ? paint : paint(p.getX(i), p.getY(i), p.getZ(i)));
        col[i * 3] = _c.r;
        col[i * 3 + 1] = _c.g;
        col[i * 3 + 2] = _c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    if (Array.isArray(rot)) _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
    else _q.copy(rot);
    if (typeof scale === 'number') _s.setScalar(scale);
    else _s.set(scale[0], scale[1], scale[2]);
    g.applyMatrix4(_m.compose(_v.set(pos[0], pos[1], pos[2]), _q, _s));
    if (this.frame) g.applyMatrix4(this.frame);
    if (this.light) {
      const n = g.attributes.normal;
      const col = g.attributes.color;
      for (let i = 0; i < n.count; i++) {
        _c.fromBufferAttribute(col as THREE.BufferAttribute, i);
        this.light(_c, _v.fromBufferAttribute(n, i));
        col.setXYZ(i, _c.r, _c.g, _c.b);
      }
    }
    this.parts.push({ g, tag: this.tag });
    return this;
  }

  /** Bends the normals of the last part towards `dir` by `k`, so a spiky tuft shades like part of a soft ball. */
  soften(dir: THREE.Vector3, k: number) {
    const n = this.parts[this.parts.length - 1].g.attributes.normal;
    for (let i = 0; i < n.count; i++) {
      _v.set(n.getX(i), n.getY(i), n.getZ(i)).multiplyScalar(1 - k).addScaledVector(dir, k).normalize();
      n.setXYZ(i, _v.x, _v.y, _v.z);
    }
    return this;
  }

  /** Merges the parts; each of `morphs` becomes a (relative) morph target, influence i moving the parts it touches. */
  build(morphs: Morph[] = []): THREE.BufferGeometry {
    const from = new THREE.Vector3();
    if (morphs.length)
      for (const { g, tag } of this.parts) {
        const p = g.attributes.position;
        g.morphAttributes.position = morphs.map((fn) => {
          const d = new Float32Array(p.count * 3);
          for (let i = 0; i < p.count; i++) {
            from.fromBufferAttribute(p, i);
            fn(tag, _v.copy(from));
            d[i * 3] = _v.x - from.x;
            d[i * 3 + 1] = _v.y - from.y;
            d[i * 3 + 2] = _v.z - from.z;
          }
          return new THREE.BufferAttribute(d, 3);
        });
        g.morphTargetsRelative = true;
      }
    const g = mergeGeometries(this.parts.map((p) => p.g)) as THREE.BufferGeometry;
    for (const p of this.parts) p.g.dispose();
    // mergeGeometries keeps the morph attributes but not this flag: without it the deltas read as absolute positions.
    g.morphTargetsRelative = morphs.length > 0;
    g.computeBoundingSphere();
    if (morphs.length) g.boundingSphere!.radius += 0.2;
    g.userData.shared = true;
    return g;
  }
}

/** Rotates `v` about `pivot` by `q` (in place). */
function rotAbout(v: THREE.Vector3, pivot: THREE.Vector3, q: THREE.Quaternion) {
  return v.sub(pivot).applyQuaternion(q).add(pivot);
}

/** Flattens an eye to 12 % of its height about its own centre: the blink morph target. */
const blinkMorph: Morph = (tag, v) => {
  if (tag.eye) v.y = tag.eye.y + (v.y - tag.eye.y) * 0.12;
};

/**
 * A morph target that moves nothing. three compiles one shader program per morph target count, so meshes pad their
 * targets to share programs: lit meshes have 5 targets, unlit faces 4.
 */
const still: Morph = () => {};

/** Fewer, chunkier fur clumps on weak devices. */
const LOW = detectQuality() === 'low';

/** Lazily built, module-wide shared value. */
function once<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= make());
}

/** Deterministic random numbers, so shared geometries look the same every run. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function lerpHex(a: number, b: number, k: number) {
  return _c.setHex(a).lerp(new THREE.Color(b), Math.min(1, Math.max(0, k))).getHex();
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ---- shared materials ----------------------------------------------------------------------------------------------

// Every creature is at most three draw calls: its contact shadow, one soft lit mesh (`vertexColorMaterial`, shared
// with the library props) and one unlit mesh for eyes, mouths and highlights (`flatVertexColorMaterial`).

/** Soft, matte, lit by the scene's warm lamps: fur, paper, books, snail skin. */
const matSoft = () => vertexColorMaterial(true);
/** Wet and glossy: the ink slime. */
const matGloss = once(() => new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 120, specular: 0x4f7f88, emissive: 0x06222a }));
/** Unlit: eyes, highlights, little mouths, so faces stay crisp in any light. */
const matFace = () => flatVertexColorMaterial();

// A soft contact shadow under every creature: one quad, much cheaper than shadow maps.
const shadowGeo = once(() => {
  const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  g.userData.shared = true;
  return g;
});
const shadowMat = once(() => {
  const tex = canvasTexture(64, 64, (g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(0,0,0,0.85)');
    r.addColorStop(0.5, 'rgba(0,0,0,0.45)');
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  });
  return new THREE.MeshBasicMaterial({ map: tex, color: 0x1a1008, transparent: true, opacity: 0.55, depthWrite: false });
});

function blobShadow(parent: THREE.Object3D, w: number, d = w, opacity = 1) {
  const m = new THREE.Mesh(shadowGeo(), shadowMat());
  m.scale.set(w, 1, d);
  m.position.y = 0.015;
  m.renderOrder = -1;
  if (opacity < 1) m.scale.multiplyScalar(opacity);
  parent.add(m);
  return m;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, pos?: Vec) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  parent.add(m);
  return m;
}

/**
 * A glossy cartoon eye for `bake`, centred at `at`, looking along `dir`: a black lens and two white glints.
 * `r` is the lens radius.
 */
function eye(bake: Bake, at: Vec, dir: THREE.Vector3, r: number) {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  const outer = bake.tag;
  const centre = new THREE.Vector3(at[0], at[1], at[2]);
  if (bake.frame) centre.applyMatrix4(bake.frame);
  bake.tag = { ...outer, eye: centre };
  // Small eyes need fewer segments; they are a few pixels across on a phone.
  const big = r > 0.09;
  bake.add(new THREE.SphereGeometry(1, big ? 12 : 9, big ? 8 : 6), 0x110c10, at, q, [r * 0.86, r, r * 0.55]);
  const glint = (lx: number, ly: number, gr: number, seg: number) => {
    const p = new THREE.Vector3(lx * r, ly * r, r * 0.5).applyQuaternion(q);
    bake.add(new THREE.SphereGeometry(gr, seg, 3), 0xffffff, [at[0] + p.x, at[1] + p.y, at[2] + p.z], q, [1, 1, 0.5]);
  };
  glint(-0.3, 0.38, r * 0.3, 6);
  glint(0.28, -0.3, r * 0.14, 5);
  bake.tag = outer;
}

/** A little arc of a smile in the xy plane, facing +z before `rot`. */
function smile(bake: Bake, at: Vec, w: number, rot: Vec | THREE.Quaternion, color = 0x2a1a1a) {
  bake.add(new THREE.TorusGeometry(w, w * 0.22, 4, 10, Math.PI * 0.8).rotateZ(Math.PI * 1.1), color, at, rot);
}

/** Squash and stretch on hit, decaying over a fraction of a second, around the body's base scale. */
function squash(body: THREE.Object3D, base = 1) {
  let k = 0;
  return {
    hit() {
      k = 1;
    },
    step(dt: number) {
      if (k <= 0) return;
      k = Math.max(0, k - dt * 5);
      const s = 1 + Math.sin(k * Math.PI) * 0.22 * k;
      body.scale.set(base * s, base / (s * s), base * s);
    },
  };
}

/** Eyes that close for a moment every few seconds: the step returns whether they are closed now. */
function blinker() {
  let next = 1 + Math.random() * 4;
  let closed = 0;
  return (dt: number) => {
    next -= dt;
    if (next <= 0) {
      closed = 0.13;
      next = 2.5 + Math.random() * 3.5;
    }
    closed = Math.max(0, closed - dt);
    return closed > 0;
  };
}

// ---- moth fairy (bat) ---------------------------------------------------------------------------------------------
// Three draw calls: the shadow, the glowing body and face (unlit, light baked into the vertex colours, blinking by a
// morph target), and one alpha-blended mesh for the wings, the halo and the banner, textured from a single atlas and
// animated by morph targets (flap, halo pulse, banner sway).

const MOTH_Y = 1.2;

/** Atlas (512×256): the right-hand wing pair in x 0–256, the banner in x 288–352 (top half), the halo in x 384–512. */
const mothTex = once(() =>
  canvasTexture(512, 256, (g) => {
    // The right-hand wing pair, root at the left middle: a big pointed fore wing sweeping up to a sharp tip, and a
    // smaller round hind wing below it.
    const fore = new Path2D();
    fore.moveTo(6, 120);
    fore.bezierCurveTo(30, 76, 120, 22, 250, 4);
    fore.bezierCurveTo(240, 46, 214, 92, 168, 114);
    fore.bezierCurveTo(118, 136, 56, 138, 6, 134);
    fore.closePath();
    const hind = new Path2D();
    hind.moveTo(6, 138);
    hind.bezierCurveTo(56, 136, 112, 148, 120, 182);
    hind.bezierCurveTo(128, 214, 96, 226, 74, 216);
    hind.bezierCurveTo(40, 200, 16, 170, 6, 142);
    hind.closePath();
    for (const path of [hind, fore]) {
      // Parchment cream membrane with a warm golden glow at the root.
      const grad = g.createRadialGradient(8, 130, 8, 8, 130, 250);
      grad.addColorStop(0, 'rgba(255,196,96,0.98)');
      grad.addColorStop(0.3, 'rgba(248,220,160,0.96)');
      grad.addColorStop(0.8, 'rgba(243,226,184,0.94)');
      grad.addColorStop(1, 'rgba(232,206,152,0.96)');
      g.fillStyle = grad;
      g.fill(path);
      g.save();
      g.clip(path);
      // Brown veins fanning out from the root, with a few cross veins.
      g.strokeStyle = 'rgba(138,90,42,0.9)';
      g.lineWidth = 2.5;
      for (let i = 0; i < 8; i++) {
        const a = -1.25 + i * 0.33;
        g.beginPath();
        g.moveTo(6, 130);
        g.quadraticCurveTo(80 * Math.cos(a), 130 + 70 * Math.sin(a), 6 + 280 * Math.cos(a), 130 + 240 * Math.sin(a));
        g.stroke();
      }
      g.lineWidth = 1.8;
      for (const rr of [90, 170]) {
        g.beginPath();
        g.arc(6, 130, rr, -1.3, 1.3);
        g.stroke();
      }
      g.restore();
      g.strokeStyle = 'rgba(138,90,42,1)';
      g.lineWidth = 5;
      g.stroke(path);
    }
    // Small brown star marks on the wings.
    const star = (x: number, y: number, r: number) => {
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const rr = i % 2 ? r * 0.28 : r;
        g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      g.closePath();
      g.fillStyle = 'rgba(138,90,42,0.95)';
      g.fill();
    };
    star(176, 46, 13);
    star(116, 84, 9);
    star(214, 30, 7);
    star(70, 178, 10);

    // The banner, 64×128 at x 288.
    g.save();
    g.translate(288, 0);
    const flag = new Path2D();
    flag.moveTo(6, 8);
    flag.lineTo(58, 8);
    flag.lineTo(58, 122);
    flag.lineTo(32, 100);
    flag.lineTo(6, 122);
    flag.closePath();
    g.fillStyle = '#9b2320';
    g.fill(flag);
    g.strokeStyle = '#e9b44c';
    g.lineWidth = 5;
    g.stroke(flag);
    // Rod.
    g.fillStyle = '#f2c35a';
    g.fillRect(0, 2, 64, 8);
    // A golden fleur.
    g.fillStyle = '#f0c055';
    g.beginPath();
    g.ellipse(32, 46, 6, 15, 0, 0, Math.PI * 2);
    g.ellipse(21, 52, 5, 10, -0.7, 0, Math.PI * 2);
    g.ellipse(43, 52, 5, 10, 0.7, 0, Math.PI * 2);
    g.fill();
    g.fillRect(20, 62, 24, 5);
    g.beginPath();
    g.moveTo(28, 66);
    g.lineTo(36, 66);
    g.lineTo(32, 80);
    g.fill();
    g.restore();

    // The halo, 128×128 at x 384.
    const r = g.createRadialGradient(448, 64, 0, 448, 64, 64);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    r.addColorStop(0.6, 'rgba(255,255,255,0.14)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(384, 0, 128, 128);
  }),
);

const mothFxMat = once(() => {
  const m = new THREE.MeshBasicMaterial({ map: mothTex(), vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  // One pass, not the back-then-front pair three uses for double-sided transparency (flat cards don't need it).
  m.forceSinglePass = true;
  return m;
});

/** Wing card size: the fore wing fills it (1.3× the old one), the hind wing is drawn smaller inside it. */
const WING = 1.24;
/** Camera pitch the halo card faces (it hangs at the moth's centre, like the sprite it replaces). */
const HALO_TILT = -0.98;

/**
 * Floor glow, wings, halo and banner in one geometry, drawn in that order (the glow lies under everything, the halo
 * brightens the wings behind the body, the banner hangs in front). Morph targets: 0 flaps the wings (base swept
 * down, target swept up; the straight-line blend shortens them a little mid-flap, which reads as the wing turning
 * edge-on), 1 swells the halo and the glow, 2 and 3 swing the banner about its rod (x and z).
 */
const mothFxGeo = once(() => {
  const parts: THREE.BufferGeometry[] = [];
  /** `make(target)` builds the part's pose for morph target `target` (-1 = the base); uv is remapped into `rect`. */
  const part = (make: (target: number) => THREE.BufferGeometry, rect: [number, number, number, number], rgba: [number, number, number, number]) => {
    const g = make(-1);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, rect[0] + uv.getX(i) * (rect[2] - rect[0]), rect[1] + uv.getY(i) * (rect[3] - rect[1]));
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 4);
    _c.setRGB(rgba[0], rgba[1], rgba[2]);
    for (let i = 0; i < n; i++) col.set([_c.r, _c.g, _c.b, rgba[3]], i * 4);
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    const base = g.attributes.position;
    g.morphAttributes.position = [0, 1, 2, 3].map((t) => {
      const pose = make(t).attributes.position;
      const d = new Float32Array(n * 3);
      for (let i = 0; i < n * 3; i++) d[i] = pose.array[i] - base.array[i];
      return new THREE.BufferAttribute(d, 3);
    });
    g.morphTargetsRelative = true;
    parts.push(g);
  };
  const wings = (t: number) => {
    const flap = t === 0 ? 0.6 : -0.4;
    const both: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(WING, WING).translate(WING * 0.48, 0, 0);
      // Mirror the left wing (the material is double-sided, so the flipped winding doesn't matter).
      g.applyMatrix4(_m.makeScale(s, 1, 1));
      // Tilted back to face the camera above, flapping about the root, set at the shoulder.
      g.applyMatrix4(_m.makeRotationFromEuler(_e.set(-0.55, s * flap, s * 0.12)));
      g.translate(s * 0.15, 0.14, -0.08);
      both.push(g);
    }
    return mergeGeometries(both) as THREE.BufferGeometry;
  };
  // A soft pool of light on the floor under the moth (above it by the bob's reach, so it never sinks into it).
  part(
    (t) => new THREE.PlaneGeometry(1.5, 1.2).scale(t === 1 ? 1.1 : 1, t === 1 ? 1.1 : 1, 1).rotateX(-Math.PI / 2).translate(0, -MOTH_Y + 0.17, 0.05),
    [0.75, 0.5, 1, 1],
    [1, 0.62, 0.2, 0.5],
  );
  // A warm tint on the parchment cream, as the lamps (and the moth's own glow) would leave it.
  part(wings, [0, 0, 0.5, 1], [1, 0.9, 0.74, 1]);
  part(
    (t) => new THREE.PlaneGeometry(1.35, 1.35).scale(t === 1 ? 1.14 : 1, t === 1 ? 1.14 : 1, 1).rotateX(HALO_TILT),
    [0.75, 0.5, 1, 1],
    // The halo is alpha-blended now (it shares the wings' draw call), so a little stronger than the additive sprite.
    [1, 0.66, 0.22, 0.46],
  );
  part(
    (t) =>
      new THREE.PlaneGeometry(0.4, 0.8)
        .translate(0, -0.4, 0)
        .applyMatrix4(_m.makeRotationFromEuler(_e.set(-0.35 + (t === 2 ? 0.12 : 0), 0, t === 3 ? 0.16 : 0)))
        .translate(0, -0.2, 0.12),
    [0.5625, 0.5, 0.6875, 1],
    // Unlit now: a touch darker than the texture, as the lamps left the lit banner.
    [0.86, 0.84, 0.84, 1],
  );
  const g = mergeGeometries(parts) as THREE.BufferGeometry;
  for (const p of parts) p.dispose();
  g.morphTargetsRelative = true;
  g.computeBoundingSphere();
  g.boundingSphere!.radius += 0.3;
  g.userData.shared = true;
  return g;
});

/** The body glows from within: lamp light from the front left baked in, plus a warm inner glow. */
const MOTH_LIGHT = new THREE.Vector3(-0.35, 0.8, 0.5).normalize();
const MOTH_EMIT = new THREE.Color(0xffb84a).multiplyScalar(0.5);

const mothGeo = once(() => {
  const gold = 0xf2b443;
  const body = new Bake();
  body.light = (c, n) => {
    const d = Math.max(0, n.dot(MOTH_LIGHT));
    c.multiplyScalar(0.38 + 0.45 * d).add(MOTH_EMIT);
  };
  body
    .add(new THREE.SphereGeometry(0.3, 16, 12), (_x, y) => lerpHex(0x9a4808, 0xf09430, (y + 0.3) / 0.6), [0, 0, 0], [0, 0, 0], [1, 0.96, 0.94])
    // Fuzzy collar and a little tail.
    .add(new THREE.SphereGeometry(0.17, 10, 8), 0xe9a53a, [0, -0.2, -0.12], [0.5, 0, 0], [1, 1.3, 1]);
  for (const s of [-1, 1]) {
    const stalk = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, -s * 0.38));
    const top = new THREE.Vector3(0, 0.36, 0).applyQuaternion(stalk);
    body.add(new THREE.CylinderGeometry(0.014, 0.018, 0.36, 5, 1, true).translate(0, 0.18, 0), 0xb57a2a, [s * 0.09, 0.24, -0.02], stalk);
    // Feathery leaf tips.
    body.add(new THREE.SphereGeometry(1, 8, 6), gold, [s * 0.09 + top.x, 0.24 + top.y + 0.07, -0.02 + top.z], stalk, [0.05, 0.12, 0.025]);
  }
  // The face stays crisp: no baked light.
  body.light = null;
  const look = new THREE.Vector3(0, 0.35, 1).normalize();
  for (const s of [-1, 1]) eye(body, [s * 0.125, 0.11, 0.22], new THREE.Vector3(s * 0.3, 0.45, 1).normalize(), 0.105);
  smile(body, [0, -0.03, 0.28], 0.04, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), look));
  for (const s of [-1, 1]) body.add(new THREE.SphereGeometry(0.04, 6, 4), 0xff8f6a, [s * 0.2, 0.0, 0.215], [0, 0, 0], [1, 0.7, 0.4]);
  return body.build([blinkMorph, still, still, still]);
});

export function makeBat(): Model {
  const root = new THREE.Group();
  const shadow = blobShadow(root, 1.1, 0.8);
  const body = new THREE.Group();
  root.add(body);
  const fly = new THREE.Group();
  fly.position.y = MOTH_Y;
  body.add(fly);
  const face = mesh(mothGeo(), matFace(), fly);
  const fx = mesh(mothFxGeo(), mothFxMat(), fly);
  fx.renderOrder = 3;
  const fxm = fx.morphTargetInfluences!;
  const phase = Math.random() * 10;
  const sq = squash(fly);
  const blink = blinker();
  return {
    root,
    radius: 0.9,
    height: MOTH_Y + 0.65,
    color: 0xf2b443,
    hit: sq.hit,
    animate(dt, t) {
      const tt = t + phase;
      fxm[0] = 0.5 + Math.sin(tt * 14) * 0.5;
      fxm[1] = 0.5 + Math.sin(tt * 5) * 0.5;
      fxm[2] = Math.sin(tt * 3 + 0.8);
      fxm[3] = Math.sin(tt * 2.3);
      const bob = Math.sin(tt * 3) * 0.12 + Math.sin(tt * 14 + 1.2) * 0.03;
      fly.position.y = MOTH_Y + bob;
      fly.rotation.z = Math.sin(tt * 1.7) * 0.08;
      const k = 1 - bob * 0.8;
      shadow.scale.set(1.1 * k, 1, 0.8 * k);
      face.morphTargetInfluences![0] = blink(dt) ? 1 : 0;
      sq.step(dt);
    },
  };
}

// ---- soot sprites (meteor, zmeu) ------------------------------------------------------------------------------------

// Slightly cool greys, so the warm lamp light leaves them charcoal rather than brown.
const SOOT_DARK = 0x111217;
const SOOT_TIP = 0x2e3038;
/** The face looks well up, towards the camera above, so it sits in the middle of the ball as seen from there. */
const FACE_DIR = new THREE.Vector3(0, 0.62, 1).normalize();
/** Rough direction to the camera (pitched ~55° down): clumps on the far side of the ball are never seen. */
const VIEW_DIR = new THREE.Vector3(0, 0.82, 0.57).normalize();
/** Face patch: centre distance from the ball's centre and its half-size (x, y, depth), in core radii. */
const FACE_AT = 0.76;
const FACE_SIZE: Vec = [0.43, 0.35, 0.21];

/** A round fluffy black ball of soft fur clumps with a small cream face set into it, at height `c`, core radius `r`. */
function sootFur(bake: Bake, r: number, c: number, seed: number, tome: boolean) {
  const rand = rng(seed);
  bake.add(new THREE.SphereGeometry(r * 0.86, 12, 8), SOOT_DARK, [0, c, 0], [0, 0, 0], [1, 1.04, 1]);
  // Soft rounded clumps (flattened balls), not spikes: a lumpy outline that still reads as one round ball.
  const n = LOW ? 60 : 84;
  // Fewer clumps on 'low' are wider, so the ball stays covered.
  const fat = Math.sqrt(84 / n);
  const dir = new THREE.Vector3();
  const tilt = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    // Fibonacci sphere, so the clumps cover it evenly.
    const y = 1 - ((i + 0.5) / n) * 2;
    const ring = Math.sqrt(1 - y * y);
    const a = i * 2.399963;
    dir.set(Math.cos(a) * ring, y, Math.sin(a) * ring);
    const facing = dir.dot(FACE_DIR);
    // Leave a hole for the face, and skip the underside and the back the camera never sees.
    if (facing > 0.9 || y < -0.8 || dir.dot(VIEW_DIR) < -0.5) continue;
    // The tome carried on the back hides the upper back.
    if (tome && dir.z < -0.25 && y > 0) continue;
    // Clumps ringing the face are smaller: a soft collar the face sits in.
    const rim = facing > 0.68;
    const w = r * (0.3 + rand() * 0.08) * fat * (rim ? 0.72 : 1);
    const h = w * (0.66 + rand() * 0.16);
    // Clumps droop a little under their own weight and splay at random.
    tilt.copy(dir).addScaledVector(UP, -0.22).add(_v.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.4)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, tilt);
    // Lamp light catches the upper clumps: lighter crowns on top, a few frosted ones.
    const tip = lerpHex(lerpHex(SOOT_TIP, 0x50525e, Math.max(0, y) * 0.7), 0x60626e, rand() < 0.12 ? 1 : 0);
    const out = rim ? 0.82 : 0.8;
    bake
      .add(new THREE.SphereGeometry(1, 6, 3), (_x, ly) => lerpHex(0x07080b, tip, ly * 1.1), [dir.x * r * out, c + dir.y * r * out, dir.z * r * out], q, [w, h, w])
      .soften(dir, 0.2);
  }
  // The face patch, recessed into the ring of fur.
  const fq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), FACE_DIR);
  const fc = FACE_DIR.clone().multiplyScalar(r * FACE_AT);
  bake.add(new THREE.SphereGeometry(1, 14, 9), (x, y) => lerpHex(0xf3e2c6, 0xd6bc98, -y * 0.8 + Math.abs(x) * 0.3), [0, c + fc.y, fc.z], fq, [r * FACE_SIZE[0], r * FACE_SIZE[1], r * FACE_SIZE[2]]);
  // Two tiny white fangs under the mouth.
  for (const s of [-1, 1]) {
    const p = new THREE.Vector3(s * r * 0.085, -r * 0.15, r * 0.18).applyQuaternion(fq).add(fc);
    bake.add(new THREE.ConeGeometry(r * 0.034, r * 0.085, 4).rotateX(Math.PI), 0xffffff, [p.x, c + p.y, p.z], fq);
  }
}

/** Eyes and mouth of a soot sprite, relative to the eye centre (returned) so the mesh can blink about it. */
function sootFace(r: number, c: number): { geo: THREE.BufferGeometry; at: Vec } {
  const fq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), FACE_DIR);
  const fc = FACE_DIR.clone().multiplyScalar(r * FACE_AT);
  const center = new THREE.Vector3(0, r * 0.04, r * 0.19).applyQuaternion(fq).add(fc);
  const face = new Bake();
  for (const s of [-1, 1]) {
    const p = new THREE.Vector3(s * r * 0.17, r * 0.04, r * 0.19).applyQuaternion(fq).add(fc).sub(center);
    eye(face, [p.x, p.y, p.z], FACE_DIR, r * 0.095);
  }
  const m = new THREE.Vector3(0, -r * 0.1, r * 0.21).applyQuaternion(fq).add(fc).sub(center);
  face.add(new THREE.SphereGeometry(r * 0.035, 8, 4), 0x2a1416, [m.x, m.y, m.z], fq, [1.3, 0.4, 0.4]);
  return { geo: face.build(), at: [0, c + center.y, center.z] };
}

/** A book as one box-ish part list: coloured covers and spine, cream page block, a gold band or emblem. */
function book(bake: Bake, w: number, h: number, d: number, cover: number, pos: Vec, rot: Vec, emblem = false, corners = false) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
  const at = (x: number, y: number, z: number): Vec => {
    const p = new THREE.Vector3(x, y, z).applyQuaternion(q);
    return [pos[0] + p.x, pos[1] + p.y, pos[2] + p.z];
  };
  const t = Math.min(0.06, h * 0.16);
  const dark = lerpHex(cover, 0x000000, 0.35);
  // Pages (inset), covers top and bottom, spine at the front (+z) with gold bands.
  bake.add(new THREE.BoxGeometry(w - 0.06, h - t * 2, d - 0.05), 0xeee0c0, at(0.02, 0, -0.02), q);
  for (const s of [-1, 1]) bake.add(new THREE.BoxGeometry(w, t, d), (_x, y) => (y * s > 0 ? cover : dark), at(0, s * (h / 2 - t / 2), 0), q);
  bake.add(new THREE.BoxGeometry(w, h, t), cover, at(0, 0, d / 2 - t / 2), q);
  for (const bx of [-w * 0.3, w * 0.3]) bake.add(new THREE.BoxGeometry(0.035, h + 0.008, t + 0.01), 0xd9a441, at(bx, 0, d / 2 - t / 2), q);
  if (emblem) {
    // A gold diamond flower on the top cover.
    bake.add(new THREE.CylinderGeometry(Math.min(w, d) * 0.24, Math.min(w, d) * 0.24, 0.012, 4), 0xe6b54c, at(0, h / 2 + 0.002, -0.02), q);
    bake.add(new THREE.CylinderGeometry(Math.min(w, d) * 0.08, Math.min(w, d) * 0.08, 0.02, 8), 0xfff0b0, at(0, h / 2 + 0.006, -0.02), q);
  }
  if (corners) {
    // Gold corner brackets (an L with a knob) on the top cover, and a thin inset gold frame.
    const c = Math.min(w, d) * 0.24;
    const b = 0.045;
    const y = h / 2 + 0.006;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const x0 = sx * (w / 2 - c / 2);
        const z0 = sz * (d / 2 - c / 2);
        bake.add(new THREE.BoxGeometry(c, 0.02, b), 0xe8b64e, at(x0, y, sz * (d / 2 - b / 2)), q);
        bake.add(new THREE.BoxGeometry(b, 0.02, c), 0xe8b64e, at(sx * (w / 2 - b / 2), y, z0), q);
        bake.add(new THREE.CylinderGeometry(b * 0.9, b * 0.9, 0.03, 8), 0xffd77a, at(sx * (w / 2 - c * 0.7), y, sz * (d / 2 - c * 0.7)), q);
      }
    const fw = w - c * 1.1;
    const fd = d - c * 1.1;
    for (const s of [-1, 1]) {
      bake.add(new THREE.BoxGeometry(fw, 0.012, 0.018), 0xc9973c, at(0, y - 0.003, s * fd / 2), q);
      bake.add(new THREE.BoxGeometry(0.018, 0.012, fd), 0xc9973c, at(s * fw / 2, y - 0.003, 0), q);
    }
  }
}

/**
 * Shared parts of a soot sprite of core radius `r`; `kind` picks its load. Fur, feet and load are one lit mesh whose
 * morph targets step the feet (0, 1), keep them planted through the hop (2) and let the load lag (3 tilt, 4 lift).
 */
function sootGeo(r: number, load: 'stack2' | 'stack3' | 'tome') {
  const c = r + 0.18;
  const fur = new Bake();
  sootFur(fur, r, c, load === 'tome' ? 11 : 7, load === 'tome');
  const face = sootFace(r, c);
  for (const s of [-1, 1]) {
    fur.tag = { foot: s };
    fur.add(new THREE.SphereGeometry(r * 0.2, 8, 5), SOOT_DARK, [s * r * 0.42, r * 0.1, r * 0.3], [0, 0, 0], [1, 0.75, 1.35]);
  }
  const top = c + r * 0.98;
  // The load's place: held up behind the head for the tome (tipped back so its cover faces the camera and turned so
  // the page edges show), balanced on the head for a stack.
  const frame = new THREE.Matrix4().compose(
    load === 'tome' ? new THREE.Vector3(0, top - r * 0.3, -r * 0.62) : new THREE.Vector3(0, top - 0.08, -0.04),
    new THREE.Quaternion().setFromEuler(load === 'tome' ? new THREE.Euler(0.42, -0.42, 0) : new THREE.Euler()),
    new THREE.Vector3(1, 1, 1),
  );
  fur.tag = { load: true };
  fur.frame = frame;
  if (load === 'tome') {
    // A big red book carried like a backpack, cover facing up and front.
    book(fur, r * 1.6, r * 0.62, r * 1.35, 0x9a2722, [0, 0, 0], [0, 0, 0], true, true);
  } else {
    const rand = rng(load === 'stack3' ? 5 : 3);
    // A neat stack: earthy blue and brown below, the red one with the gold emblem on top.
    const covers = load === 'stack3' ? [0x6e4a2c, 0x2e5470, 0x82241e] : [0x2e5470, 0x82241e];
    let y = 0;
    const n = covers.length;
    for (let i = 0; i < n; i++) {
      const h = 0.15 + rand() * 0.05;
      const w = r * (1.08 - i * 0.07) + rand() * 0.06;
      // Turned so the cream page edges face the camera and the spine shows at the side.
      book(fur, w, h, w * 0.74, covers[i], [(rand() - 0.5) * 0.06, y + h / 2, (rand() - 0.5) * 0.05], [0, Math.PI * 0.8 + (rand() - 0.5) * 0.35, 0], i === n - 1);
      y += h;
    }
  }
  fur.frame = null;
  const inv = frame.clone().invert();
  const tilt = new THREE.Matrix4().makeRotationZ(0.07);
  const lag = frame.clone().multiply(tilt).multiply(inv);
  const geo = fur.build([
    (t, v) => void (t.foot === -1 && (v.y += 0.1)),
    (t, v) => void (t.foot === 1 && (v.y += 0.1)),
    (t, v) => void (t.foot && (v.y -= 0.06)),
    (t, v) => void (t.load && v.applyMatrix4(lag)),
    (t, v) => void (t.load && (v.y += 0.03)),
  ]);
  return { fur: geo, face, top };
}

const sootMeteor2 = once(() => sootGeo(0.62, 'stack2'));
const sootMeteor3 = once(() => sootGeo(0.62, 'stack3'));
const sootZmeu = once(() => sootGeo(0.74, 'tome'));

function makeSoot(zmeu: boolean): Model {
  const g = zmeu ? sootZmeu() : Math.random() < 0.5 ? sootMeteor2() : sootMeteor3();
  const r = zmeu ? 0.74 : 0.62;
  const root = new THREE.Group();
  blobShadow(root, r * 2.9, r * 2.4);
  const body = new THREE.Group();
  root.add(body);
  const waddle = new THREE.Group();
  body.add(waddle);
  const fur = mesh(g.fur, matSoft(), waddle);
  const m = fur.morphTargetInfluences!;
  const eyes = mesh(g.face.geo, matFace(), waddle, g.face.at);
  const phase = Math.random() * 10;
  const sq = squash(body);
  const blink = blinker();
  const speed = zmeu ? 5 : 7;
  return {
    root,
    radius: zmeu ? 1.1 : 0.95,
    height: zmeu ? g.top + r * 0.9 : g.top + 0.42,
    color: 0x2a2228,
    hit: sq.hit,
    animate(dt, t) {
      const w = (t + phase) * speed;
      // A side-to-side waddle with little hops, feet stepping in turn, the load lagging behind.
      const hop = Math.abs(Math.cos(w));
      waddle.rotation.z = Math.sin(w) * 0.09;
      waddle.position.y = hop * 0.06;
      m[0] = Math.max(0, Math.sin(w));
      m[1] = Math.max(0, -Math.sin(w));
      m[2] = hop;
      m[3] = -Math.sin(w - 0.6);
      m[4] = Math.abs(Math.cos(w - 0.5));
      eyes.scale.y = blink(dt) ? 0.12 : 1;
      sq.step(dt);
    },
  };
}

export function makeMeteor(): Model {
  return makeSoot(false);
}

export function makeZmeu(): Model {
  return makeSoot(true);
}

// ---- scroll snail (ghost) -------------------------------------------------------------------------------------------
// Three draw calls: the shadow, one lit mesh (foot, head, eye stalks, the scroll shell and the writing on it) and one
// unlit mesh (face, stalk eyes). Morph targets do the animation: 0 stretches the foot (inchworm), 1 and 2 wobble the
// stalks, and 3 rocks the shell (lit mesh) or closes the eyes (unlit mesh).

/** Paper tint (the old scroll texture's ground colour), multiplied into the shell's vertex colours. */
const PAPER = 0xfbf2dc;
const INK_LINE = 0x5a381e;

/**
 * A tightly rolled parchment scroll lying along the x axis: a solid roll of radius `R` (its outer turn written on in
 * rows of handwriting), end caps with the rolled layers drawn as a spiral on the -x end (the one the three-quarter
 * turned snail shows the camera), and the free end of the sheet hanging down at the back.
 */
function scrollGeometry(width: number, R: number) {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const paper = new THREE.Color(PAPER);
  const outerCol = new THREE.Color(0xf6e6c4).multiply(paper);
  const backCol = new THREE.Color(0xe2cfa8).multiply(paper);
  const capRim = new THREE.Color(0xf2dfb8).multiply(paper);
  const capCore = new THREE.Color(0xcfb284).multiply(paper);
  const lineCol = new THREE.Color(0x9a7448);
  const ink = new THREE.Color(INK_LINE);
  const ea = new THREE.Vector3();
  const eb = new THREE.Vector3();
  const en = new THREE.Vector3();
  /** One triangle, wound so its front faces along its (summed) vertex normals. */
  const tri = (v: Vec[], n: Vec[], c: THREE.Color[]) => {
    ea.set(v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]);
    eb.set(v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]);
    en.set(n[0][0] + n[1][0] + n[2][0], n[0][1] + n[1][1] + n[2][1], n[0][2] + n[1][2] + n[2][2]);
    for (const i of ea.cross(eb).dot(en) >= 0 ? [0, 1, 2] : [0, 2, 1]) {
      pos.push(...v[i]);
      nor.push(...n[i]);
      col.push(c[i].r, c[i].g, c[i].b);
    }
  };
  /** A quad a b c d (in order around it). */
  const quad = (v: Vec[], n: Vec[], c: THREE.Color | THREE.Color[]) => {
    const cc = Array.isArray(c) ? c : [c, c, c, c];
    tri([v[0], v[1], v[2]], [n[0], n[1], n[2]], [cc[0], cc[1], cc[2]]);
    tri([v[0], v[2], v[3]], [n[0], n[2], n[3]], [cc[0], cc[2], cc[3]]);
  };
  // Angle a around the roll: 0 at the front (+z), π/2 on top, π at the back.
  const at = (x: number, a: number, r = R): Vec => [x, r * Math.sin(a), r * Math.cos(a)];
  const nrm = (a: number): Vec => [0, Math.sin(a), Math.cos(a)];
  const w = width / 2;

  // The roll and its end caps.
  const SEG = 36;
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * Math.PI * 2;
    const a1 = ((i + 1) / SEG) * Math.PI * 2;
    quad([at(-w, a0), at(w, a0), at(w, a1), at(-w, a1)], [nrm(a0), nrm(a0), nrm(a1), nrm(a1)], outerCol);
    for (const s of [-1, 1]) {
      const n: Vec = [s, 0, 0];
      tri([[s * w, 0, 0], at(s * w, a0), at(s * w, a1)], [n, n, n], [capCore, capRim, capRim]);
    }
  }
  // The rolled layers on the -x cap: a spiral line ending at the back, where the sheet leaves the roll.
  const turns = 3;
  const T = turns * Math.PI * 2;
  const steps = Math.round(turns * 22);
  const hw = 0.009;
  const cx = -w - 0.003;
  const capN: Vec = [-1, 0, 0];
  for (let i = 0; i < steps; i++) {
    const p = (k: number) => {
      const t = (k / steps) * T;
      return { a: Math.PI - (T - t), r: 0.035 + ((R - hw - 0.035) * t) / T };
    };
    const A = p(i);
    const B = p(i + 1);
    quad([at(cx, A.a, A.r - hw), at(cx, A.a, A.r + hw), at(cx, B.a, B.r + hw), at(cx, B.a, B.r - hw)], [capN, capN, capN, capN], lineCol);
  }
  // The free end of the sheet, hanging down from the back of the roll with a slight outward curl (both sides).
  const L = R * 0.9;
  const flap = (k: number): { y: number; z: number; n: [number, number] } => ({ y: -k * L, z: -R - k * k * 0.12, n: [-k * 0.24, -1] });
  for (let i = 0; i < 4; i++) {
    const A = flap(i / 4);
    const B = flap((i + 1) / 4);
    for (const side of [1, -1]) {
      const nA: Vec = [0, A.n[0] * side, A.n[1] * side];
      const nB: Vec = [0, B.n[0] * side, B.n[1] * side];
      const off = side * 0.006;
      quad(
        [[-w, A.y, A.z - off], [w, A.y, A.z - off], [w, B.y, B.z - off], [-w, B.y, B.z - off]],
        [nA, nA, nB, nB],
        side > 0 ? outerCol : backCol,
      );
    }
  }

  // Rows of handwriting on the outer turn, across the front, over the top and down the back the camera sees.
  const rand = rng(17);
  const lift = R + 0.004;
  const half = 0.0075 / R;
  for (let row = 0, a = -0.15; a < 2.1; row++, a += 0.16) {
    let x = -w + 0.05 + rand() * 0.03;
    while (x < w - 0.08) {
      const len = Math.min(0.1 + rand() * 0.18, w - 0.05 - x);
      const segs = len > 0.18 ? 4 : 3;
      let prev: { x: number; a: number } | null = null;
      for (let j = 0; j <= segs; j++) {
        const cur = { x: x + (len * j) / segs, a: a + (Math.sin((x + (len * j) / segs) * 45 + row) * 0.008) / R };
        if (prev)
          quad(
            [at(prev.x, prev.a - half, lift), at(cur.x, cur.a - half, lift), at(cur.x, cur.a + half, lift), at(prev.x, prev.a + half, lift)],
            [nrm(prev.a), nrm(cur.a), nrm(cur.a), nrm(prev.a)],
            ink,
          );
        prev = cur;
      }
      x += len + 0.03 + rand() * 0.02;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** Warm tan skin and a darker brown foot, so the body stands apart from the cream scroll. */
const SNAIL_SKIN = 0xc49a6c;
const SNAIL_FOOT = 0x5e4029;
/** Eye stalk length. */
const STALK = 0.63;
const HEAD = new THREE.Vector3(0, 0.62, 0.8);
const SHELL_Y = 0.86;
/** Where the eye stalks sit on the head (they wobble about it). */
const STALKS = new THREE.Vector3(0, 0.9, 0.82);
const SHELL_AT = new THREE.Vector3(0, SHELL_Y, -0.22);

const qStalkZ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.12);
const qStalkX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.1);
const qShell = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.04);
const snailStretch: Morph = (t, v) => void (t.crawl && (v.z *= 1.05));
const snailStalkZ: Morph = (t, v) => void (t.stalk && rotAbout(v, STALKS, qStalkZ));
const snailStalkX: Morph = (t, v) => void (t.stalk && rotAbout(v, STALKS, qStalkX));
const snailShell: Morph = (t, v) => void (t.shell && rotAbout(v, SHELL_AT, qShell).setY(v.y + 0.015));

const snailGeo = once(() => {
  const skin = (_x: number, y: number) => lerpHex(0x9c7448, SNAIL_SKIN, (y + 0.6) * 0.9);
  const foot = (_x: number, y: number) => lerpHex(0x3c2818, SNAIL_FOOT, (y + 1) * 0.8);
  const soft = new Bake();
  soft.tag = { crawl: true };
  soft
    // A long low foot, a neck rising to a round head at the front.
    .add(new THREE.SphereGeometry(1, 14, 9), foot, [0, 0.2, 0.05], [0, 0, 0], [0.42, 0.24, 1.0])
    .add(new THREE.SphereGeometry(1, 12, 8), skin, [0, 0.38, 0.58], [0.5, 0, 0], [0.34, 0.38, 0.36])
    .add(new THREE.SphereGeometry(0.36, 14, 10), (_x, y) => lerpHex(0xae8456, 0xd8b386, (y + 0.3) / 0.62), [0, 0.62, 0.8], [0, 0, 0], [1.05, 0.95, 0.95]);
  // A row of soft brown knobs along the foot's rim, like the reference's chunky little feet.
  for (const s of [-1, 1])
    for (const z of [-0.6, -0.15, 0.3, 0.68])
      soft.add(new THREE.SphereGeometry(0.1, 6, 4), 0x45301e, [s * 0.34, 0.05, z], [0, 0, 0], [1.2, 0.6, 1.3]);
  // The face sits high on the front of the head, turned up towards the camera.
  const face = new Bake();
  face.tag = { crawl: true };
  const onHead = (x: number, y: number, z: number, out = 0): [Vec, THREE.Quaternion] => {
    const d = new THREE.Vector3(x, y, z).normalize();
    const p = d.clone().multiplyScalar(0.355 + out).add(HEAD);
    return [[p.x, p.y, p.z], new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d)];
  };
  for (const s of [-1, 1]) {
    const [ep, eq] = onHead(s * 0.36, 0.55, 0.78);
    eye(face, ep, new THREE.Vector3(0, 0, 1).applyQuaternion(eq), 0.05);
    const [cp, cq] = onHead(s * 0.62, 0.36, 0.72);
    face.add(new THREE.SphereGeometry(0.055, 6, 4), 0xf09a88, cp, cq, [1, 0.62, 0.3]);
  }
  const [mp, mq] = onHead(0, 0.36, 1, 0.005);
  smile(face, mp, 0.045, mq);
  // Stalk eyes: built upright at the origin, placed on top of the head.
  const frame = new THREE.Matrix4().makeTranslation(STALKS.x, STALKS.y, STALKS.z);
  soft.tag = face.tag = { crawl: true, stalk: true };
  soft.frame = face.frame = frame;
  const look = new THREE.Vector3(0, 0.5, 1).normalize();
  for (const s of [-1, 1]) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.05, 0, -s * 0.38));
    const tip = new THREE.Vector3(0, STALK, 0).applyQuaternion(q).add(new THREE.Vector3(s * 0.1, 0, 0));
    soft.add(new THREE.CylinderGeometry(0.032, 0.052, STALK, 7, 1, true).translate(0, STALK / 2, 0), SNAIL_SKIN, [s * 0.1, 0, 0], q);
    soft.add(new THREE.SphereGeometry(0.11, 9, 6), 0xfaf3e6, [tip.x, tip.y, tip.z]);
    const p = look.clone().multiplyScalar(0.085).add(tip);
    eye(face, [p.x, p.y, p.z], look, 0.07);
  }
  soft.frame = face.frame = null;
  soft.tag = { shell: true };
  soft.add(scrollGeometry(0.86, 0.6), null, [SHELL_AT.x, SHELL_AT.y, SHELL_AT.z]);
  return {
    soft: soft.build([snailStretch, snailStalkZ, snailStalkX, snailShell, still]),
    face: face.build([snailStretch, snailStalkZ, snailStalkX, blinkMorph]),
  };
});

export function makeGhost(): Model {
  const root = new THREE.Group();
  blobShadow(root, 1.6, 2.6);
  const body = new THREE.Group();
  root.add(body);
  const g = snailGeo();
  // Seen three-quarters on, like the reference, so the scroll's spiral end shows.
  body.rotation.y = 0.75;
  const soft = mesh(g.soft, matSoft(), body).morphTargetInfluences!;
  const face = mesh(g.face, matFace(), body).morphTargetInfluences!;
  const phase = Math.random() * 10;
  const sq = squash(body);
  const blink = blinker();
  return {
    root,
    radius: 1.1,
    height: 1.68,
    color: SNAIL_SKIN,
    hit: sq.hit,
    animate(dt, t) {
      const tt = t + phase;
      // A slow inchworm stretch of the foot, the head nodding along and the stalks wobbling a beat behind.
      soft[0] = face[0] = Math.sin(tt * 2.4);
      soft[1] = face[1] = Math.sin(tt * 1.9);
      soft[2] = face[2] = Math.sin(tt * 2.4 - 1.2);
      soft[3] = Math.sin(tt * 2.4 + 0.4);
      face[3] = blink(dt) ? 1 : 0;
      sq.step(dt);
    },
  };
}

// ---- ink slime (rock) -----------------------------------------------------------------------------------------------

const SLIME = 0x1d7590;
/** Drop profile (radius, height) from the bottom centre up to the pointed tip. */
const DROP: [number, number][] = [
  [0, 0], [0.36, 0.02], [0.55, 0.1], [0.64, 0.24], [0.66, 0.38], [0.62, 0.54], [0.53, 0.68],
  [0.41, 0.8], [0.3, 0.9], [0.22, 1.0], [0.16, 1.1], [0.1, 1.2], [0.05, 1.27], [0, 1.3],
];
// Eyes high on the drop, so they still face the camera looking down from above.
const EYE_Y = 0.6;
function dropRadius(y: number) {
  for (let i = 1; i < DROP.length; i++) {
    if (DROP[i][1] >= y) {
      const [r0, y0] = DROP[i - 1];
      const [r1, y1] = DROP[i];
      return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    }
  }
  return 0;
}

const slimeGeo = once(() => {
  const lathe = new THREE.LatheGeometry(DROP.map(([r, y]) => new THREE.Vector2(r, y)), 26, Math.PI);
  const p = lathe.attributes.position;
  // The tip curls back a little, like a drop caught mid-wobble.
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > 0.6) p.setZ(i, p.getZ(i) - ((y - 0.6) / 0.7) ** 2 * 0.36);
  }
  lathe.computeVertexNormals();
  const tone = (_x: number, y: number, z: number) =>
    lerpHex(lerpHex(0x0e3a50, SLIME, y * 3.2), 0x3aa0b8, Math.max(0, y - 0.45) * 1.3 + Math.max(0, z) * 0.15);
  const body = new Bake().add(lathe, tone);
  for (const s of [-1, 1]) {
    body.add(new THREE.SphereGeometry(0.14, 10, 8), 0x237d8c, [s * 0.66, 0.3, 0.08], [0, 0, s * 0.5], [1.15, 0.8, 0.9]);
    body.add(new THREE.SphereGeometry(0.13, 10, 6), 0x1a6273, [s * 0.27, 0.05, 0.42], [0, 0, 0], [1, 0.55, 1.2]);
  }
  // A few sparkly specks in the ink.
  const rand = rng(23);
  for (let i = 0; i < 9; i++) {
    const y = 0.15 + rand() * 0.75;
    const a = (rand() - 0.5) * 2.6 + (i % 3 === 0 ? Math.PI : 0);
    const r = dropRadius(y) + 0.004;
    body.add(new THREE.SphereGeometry(0.018 + rand() * 0.014, 6, 4), 0xd8f4ee, [Math.sin(a) * r, y, Math.cos(a) * r]);
  }
  // Wet highlights on the upper left, where the lamps catch the glossy ink.
  body.add(new THREE.SphereGeometry(1, 8, 6), 0xd6f6fa, [-0.3, 0.78, 0.34], [0.4, -0.6, 0.5], [0.11, 0.05, 0.03]);
  body.add(new THREE.SphereGeometry(1, 6, 4), 0xd6f6fa, [-0.42, 0.6, 0.38], [0.2, -0.8, 0.3], [0.04, 0.035, 0.02]);
  const face = new Bake();
  for (const s of [-1, 1]) {
    const y = EYE_Y;
    const x = s * 0.23;
    const z = Math.sqrt(dropRadius(y) ** 2 - x * x);
    eye(face, [x, y, z - 0.02], new THREE.Vector3(x * 0.7, 0.5, z).normalize(), 0.15);
  }
  const fq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.35, 1).normalize());
  smile(face, [0, 0.43, dropRadius(0.43) + 0.004], 0.045, fq, 0x061c22);
  return { body: body.build(), face: face.build() };
});

export function makeRock(): Model {
  const root = new THREE.Group();
  blobShadow(root, 1.7, 1.5);
  const body = new THREE.Group();
  root.add(body);
  const jiggle = new THREE.Group();
  body.add(jiggle);
  const g = slimeGeo();
  mesh(g.body, matGloss(), jiggle);
  const eyes = new THREE.Group();
  eyes.position.y = EYE_Y;
  jiggle.add(eyes);
  mesh(g.face, matFace(), eyes).position.y = -EYE_Y;
  const phase = Math.random() * 10;
  const sq = squash(body, 0.95);
  body.scale.setScalar(0.95);
  const blink = blinker();
  return {
    root,
    radius: 0.75,
    height: 1.24,
    color: SLIME,
    hit: sq.hit,
    animate(dt, t) {
      const tt = t + phase;
      // Jelly wobble: squash and stretch out of phase with a little sway of the tip.
      const k = Math.sin(tt * 5.5) * 0.05;
      jiggle.scale.set(1 + k, 1 - k * 1.4, 1 + k);
      jiggle.rotation.z = Math.sin(tt * 2.2) * 0.06;
      jiggle.rotation.x = Math.sin(tt * 2.9) * 0.04;
      eyes.scale.y = blink(dt) ? 0.12 : 1;
      sq.step(dt);
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
    case 'head':
      return makeHead();
    default:
      return makeMeteor();
  }
}
