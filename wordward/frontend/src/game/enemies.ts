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

/** Collects primitives with a colour and a transform, and merges them into one vertex-coloured geometry. */
class Bake {
  private parts: THREE.BufferGeometry[] = [];

  /** `rot` is Euler angles or a quaternion; `scale` a number or per-axis. */
  add(geo: THREE.BufferGeometry, paint: Paint, pos: Vec = [0, 0, 0], rot: Vec | THREE.Quaternion = [0, 0, 0], scale: number | Vec = 1) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      _c.setHex(typeof paint === 'number' ? paint : paint(p.getX(i), p.getY(i), p.getZ(i)));
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (Array.isArray(rot)) _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
    else _q.copy(rot);
    if (typeof scale === 'number') _s.setScalar(scale);
    else _s.set(scale[0], scale[1], scale[2]);
    g.applyMatrix4(_m.compose(_v.set(pos[0], pos[1], pos[2]), _q, _s));
    this.parts.push(g);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts) as THREE.BufferGeometry;
    for (const p of this.parts) p.dispose();
    g.computeBoundingSphere();
    g.userData.shared = true;
    return g;
  }
}

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

/** Soft, matte, lit by the scene's warm lamps: fur, paper, books, snail skin. */
const matSoft = once(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 }));
/** Wet and glossy: the ink slime. */
const matGloss = once(() => new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 45, specular: 0x3f6670 }));
/** Unlit: eyes, highlights, little mouths, so faces stay crisp in any light. */
const matFace = once(() => new THREE.MeshBasicMaterial({ vertexColors: true }));
/** The moth glows from within. */
const matGlow = once(
  () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, emissive: 0xc07a18, emissiveIntensity: 0.75 }),
);

const glowTex = once(() =>
  canvasTexture(64, 64, (g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    r.addColorStop(0.6, 'rgba(255,255,255,0.14)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
  }),
);

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
  bake.add(new THREE.SphereGeometry(1, 14, 10), 0x110c10, at, q, [r * 0.86, r, r * 0.55]);
  const glint = (lx: number, ly: number, gr: number) => {
    const p = new THREE.Vector3(lx * r, ly * r, r * 0.5).applyQuaternion(q);
    bake.add(new THREE.SphereGeometry(gr, 8, 6), 0xffffff, [at[0] + p.x, at[1] + p.y, at[2] + p.z], q, [1, 1, 0.5]);
  };
  glint(-0.3, 0.38, r * 0.3);
  glint(0.28, -0.3, r * 0.14);
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

/** Eyes that close for a moment every few seconds (scaled flat on y around their own centre). */
function blinker(eyes: THREE.Object3D) {
  let next = 1 + Math.random() * 4;
  let closed = 0;
  return (dt: number) => {
    next -= dt;
    if (next <= 0) {
      closed = 0.13;
      next = 2.5 + Math.random() * 3.5;
    }
    closed = Math.max(0, closed - dt);
    eyes.scale.y = closed > 0 ? 0.12 : 1;
  };
}

// ---- moth fairy (bat) ---------------------------------------------------------------------------------------------

const MOTH_Y = 1.2;

const wingMat = once(() => {
  const tex = canvasTexture(256, 256, (g) => {
    // The right-hand wing pair, root at the left middle: a big pointed fore wing and a round hind wing.
    const fore = new Path2D();
    fore.moveTo(4, 122);
    fore.bezierCurveTo(30, 40, 120, -6, 200, 8);
    fore.bezierCurveTo(250, 18, 254, 70, 232, 98);
    fore.bezierCurveTo(190, 132, 90, 140, 4, 134);
    fore.closePath();
    const hind = new Path2D();
    hind.moveTo(4, 136);
    hind.bezierCurveTo(70, 132, 150, 150, 160, 196);
    hind.bezierCurveTo(168, 240, 120, 254, 90, 240);
    hind.bezierCurveTo(48, 222, 16, 176, 4, 140);
    hind.closePath();
    for (const [path, inner, outer] of [
      [hind, 'rgba(255,240,200,0.92)', 'rgba(244,190,92,0.92)'],
      [fore, 'rgba(255,246,214,0.94)', 'rgba(246,196,98,0.94)'],
    ] as const) {
      const grad = g.createRadialGradient(10, 128, 10, 10, 128, 250);
      grad.addColorStop(0, outer);
      grad.addColorStop(0.35, inner);
      grad.addColorStop(1, outer);
      g.fillStyle = grad;
      g.fill(path);
      g.save();
      g.clip(path);
      // Veins fanning out from the root.
      g.strokeStyle = 'rgba(160,100,30,0.75)';
      g.lineWidth = 2;
      for (let i = 0; i < 9; i++) {
        const a = -1.25 + i * 0.3;
        g.beginPath();
        g.moveTo(6, 130);
        g.quadraticCurveTo(80 * Math.cos(a), 130 + 70 * Math.sin(a), 6 + 260 * Math.cos(a), 130 + 220 * Math.sin(a));
        g.stroke();
      }
      g.restore();
      g.strokeStyle = 'rgba(200,130,40,1)';
      g.lineWidth = 5;
      g.stroke(path);
    }
    // Little stars on the wings.
    const star = (x: number, y: number, r: number) => {
      g.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const rr = i % 2 ? r * 0.3 : r;
        g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      g.closePath();
      g.fillStyle = 'rgba(150,84,24,0.95)';
      g.fill();
    };
    star(170, 50, 13);
    star(110, 78, 9);
    star(205, 85, 7);
    star(105, 196, 10);
  });
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.05 });
  // One pass, not the back-then-front pair three uses for double-sided transparency (flat wings don't need it).
  m.forceSinglePass = true;
  return m;
});
const wingGeo = once(() => {
  const g = new THREE.PlaneGeometry(1.25, 1.25).translate(0.6, 0, 0);
  g.userData.shared = true;
  return g;
});

const bannerMat = once(() => {
  const tex = canvasTexture(64, 128, (g) => {
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
  });
  return new THREE.MeshStandardMaterial({
    map: tex,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.8,
    emissive: 0x3a0a04,
  });
});
const bannerGeo = once(() => {
  const g = new THREE.PlaneGeometry(0.4, 0.8).translate(0, -0.4, 0);
  g.userData.shared = true;
  return g;
});

const glowMat = once(
  () =>
    new THREE.SpriteMaterial({
      map: glowTex(),
      color: 0xffb648,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
);

const mothGeo = once(() => {
  const gold = 0xf2b443;
  const body = new Bake()
    .add(new THREE.SphereGeometry(0.3, 18, 14), (_x, y) => lerpHex(0xd98a22, 0xffd36a, (y + 0.3) / 0.6), [0, 0, 0], [0, 0, 0], [1, 0.96, 0.94])
    // Fuzzy collar and a little tail.
    .add(new THREE.SphereGeometry(0.17, 10, 8), 0xe9a53a, [0, -0.2, -0.12], [0.5, 0, 0], [1, 1.3, 1]);
  for (const s of [-1, 1]) {
    const stalk = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, -s * 0.38));
    const top = new THREE.Vector3(0, 0.36, 0).applyQuaternion(stalk);
    body.add(new THREE.CylinderGeometry(0.014, 0.018, 0.36, 5).translate(0, 0.18, 0), 0xb57a2a, [s * 0.09, 0.24, -0.02], stalk);
    // Feathery leaf tips.
    body.add(new THREE.SphereGeometry(1, 8, 6), gold, [s * 0.09 + top.x, 0.24 + top.y + 0.07, -0.02 + top.z], stalk, [0.05, 0.12, 0.025]);
  }
  const face = new Bake();
  const look = new THREE.Vector3(0, 0.35, 1).normalize();
  for (const s of [-1, 1]) eye(face, [s * 0.115, 0.03, 0.24], new THREE.Vector3(s * 0.25, 0.35, 1).normalize(), 0.085);
  smile(face, [0, -0.1, 0.28], 0.04, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), look));
  for (const s of [-1, 1]) face.add(new THREE.SphereGeometry(0.04, 8, 6), 0xff8f6a, [s * 0.2, -0.06, 0.21], [0, 0, 0], [1, 0.7, 0.4]);
  return { body: body.build(), face: face.build() };
});

export function makeBat(): Model {
  const root = new THREE.Group();
  const shadow = blobShadow(root, 1.1, 0.8);
  const body = new THREE.Group();
  root.add(body);
  const fly = new THREE.Group();
  fly.position.y = MOTH_Y;
  body.add(fly);
  const g = mothGeo();
  mesh(g.body, matGlow(), fly);
  const face = mesh(g.face, matFace(), fly);
  const glow = new THREE.Sprite(glowMat());
  glow.geometry.userData.shared = true;
  glow.scale.setScalar(2.1);
  glow.renderOrder = 4;
  fly.add(glow);
  const wings: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const w = mesh(wingGeo(), wingMat(), fly, [s * 0.16, 0.08, -0.08]);
    w.scale.x = s;
    w.renderOrder = 3;
    wings.push(w);
  }
  const banner = mesh(bannerGeo(), bannerMat(), fly, [0, -0.2, 0.12]);
  const phase = Math.random() * 10;
  const sq = squash(fly);
  const blink = blinker(face);
  return {
    root,
    radius: 0.9,
    height: MOTH_Y + 0.65,
    color: 0xf2b443,
    hit: sq.hit,
    animate(dt, t) {
      const tt = t + phase;
      const flap = 0.15 + Math.sin(tt * 14) * 0.65;
      // Wings tilted back to face the camera above, flapping about their root.
      wings[0].rotation.set(-0.55, flap, 0.12);
      wings[1].rotation.set(-0.55, -flap, -0.12);
      const bob = Math.sin(tt * 3) * 0.12 + Math.sin(tt * 14 + 1.2) * 0.03;
      fly.position.y = MOTH_Y + bob;
      fly.rotation.z = Math.sin(tt * 1.7) * 0.08;
      banner.rotation.set(-0.35 + Math.sin(tt * 3 + 0.8) * 0.12, 0, Math.sin(tt * 2.3) * 0.16);
      glow.material.opacity = 0.55 + Math.sin(tt * 5) * 0.08;
      const k = 1 - bob * 0.8;
      shadow.scale.set(1.1 * k, 1, 0.8 * k);
      blink(dt);
      sq.step(dt);
    },
  };
}

// ---- soot sprites (meteor, zmeu) ------------------------------------------------------------------------------------

const SOOT_DARK = 0x0f0d12;
const SOOT_TIP = 0x3c3a42;
const FACE_DIR = new THREE.Vector3(0, 0.32, 1).normalize();

/** A fluffy black ball of fur tufts with a cream face patch, centred at height `c` with core radius `r`. */
function sootFur(bake: Bake, r: number, c: number, seed: number) {
  const rand = rng(seed);
  bake.add(new THREE.SphereGeometry(r * 0.86, 16, 12), SOOT_DARK, [0, c, 0]);
  const n = 150;
  const dir = new THREE.Vector3();
  const tilt = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    // Fibonacci sphere, so the tufts cover it evenly.
    const y = 1 - ((i + 0.5) / n) * 2;
    const ring = Math.sqrt(1 - y * y);
    const a = i * 2.399963;
    dir.set(Math.cos(a) * ring, y, Math.sin(a) * ring);
    const facing = dir.dot(FACE_DIR);
    if (facing > 0.8 || y < -0.75) continue;
    const len = r * (0.32 + rand() * 0.18) * (facing > 0.55 ? 0.8 : 1);
    const wide = r * (0.2 + rand() * 0.07);
    // Tufts droop a little under their own weight and splay at random.
    tilt.copy(dir).addScaledVector(UP, -0.3).add(_v.set(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.5)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, tilt);
    const tip = lerpHex(SOOT_TIP, 0x5e5862, rand() < 0.15 ? 1 : 0);
    bake.add(
      new THREE.ConeGeometry(wide, len, 6, 1, true).translate(0, len / 2, 0),
      (_x, ly) => lerpHex(SOOT_DARK, tip, (ly / len) * 1.2),
      [dir.x * r * 0.7, c + dir.y * r * 0.7, dir.z * r * 0.7],
      q,
    );
  }
  // The face patch, sitting in the ring of fur, turned a little up towards the camera.
  const fq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), FACE_DIR);
  const fc = FACE_DIR.clone().multiplyScalar(r * 0.8);
  bake.add(new THREE.SphereGeometry(1, 18, 12), (x, y) => lerpHex(0xf1dfc4, 0xd8bf9c, -y * 0.8 + Math.abs(x) * 0.3), [0, c + fc.y, fc.z], fq, [r * 0.56, r * 0.44, r * 0.24]);
  // Two little fangs under the mouth.
  for (const s of [-1, 1]) {
    const p = new THREE.Vector3(s * r * 0.09, -r * 0.2, r * 0.2).applyQuaternion(fq).add(fc);
    bake.add(new THREE.ConeGeometry(r * 0.035, r * 0.09, 5).rotateX(Math.PI), 0xfdf8ee, [p.x, c + p.y, p.z], fq);
  }
}

/** Eyes and mouth of a soot sprite, relative to the eye centre (returned) so the mesh can blink about it. */
function sootFace(r: number, c: number): { geo: THREE.BufferGeometry; at: Vec } {
  const fq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), FACE_DIR);
  const fc = FACE_DIR.clone().multiplyScalar(r * 0.8);
  const center = new THREE.Vector3(0, r * 0.06, r * 0.22).applyQuaternion(fq).add(fc);
  const face = new Bake();
  for (const s of [-1, 1]) {
    const p = new THREE.Vector3(s * r * 0.22, r * 0.06, r * 0.22).applyQuaternion(fq).add(fc).sub(center);
    eye(face, [p.x, p.y, p.z], FACE_DIR, r * 0.1);
  }
  const m = new THREE.Vector3(0, -r * 0.13, r * 0.24).applyQuaternion(fq).add(fc).sub(center);
  face.add(new THREE.SphereGeometry(r * 0.06, 10, 6), 0x2a1416, [m.x, m.y, m.z], fq, [1.4, 0.55, 0.4]);
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
    bake.add(new THREE.CylinderGeometry(Math.min(w, d) * 0.18, Math.min(w, d) * 0.18, 0.012, 4), 0xe6b54c, at(0, h / 2 + 0.002, -0.02), q);
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

const BOOK_COLOURS = [0x8f2a22, 0x2e4c5c, 0x6e4a2c, 0x3f5a3a, 0x7a2f4a];

/** Shared parts of a soot sprite of core radius `r`; `kind` picks its load. */
function sootGeo(r: number, load: 'stack2' | 'stack3' | 'tome') {
  const c = r + 0.18;
  const fur = new Bake();
  sootFur(fur, r, c, load === 'tome' ? 11 : 7);
  const face = sootFace(r, c);
  const foot = new Bake().add(new THREE.SphereGeometry(r * 0.2, 10, 6), SOOT_DARK, [0, r * 0.1, 0], [0, 0, 0], [1, 0.75, 1.35]).build();
  const books = new Bake();
  const top = c + r * 0.98;
  if (load === 'tome') {
    // A big red book carried like a backpack, cover facing up and front.
    book(books, r * 1.6, r * 0.62, r * 1.35, 0x9a2722, [0, 0, 0], [0, 0, 0], true, true);
  } else {
    const rand = rng(load === 'stack3' ? 5 : 3);
    let y = 0;
    const n = load === 'stack3' ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const h = 0.15 + rand() * 0.06;
      const w = r * (1.05 - i * 0.08) + rand() * 0.08;
      book(books, w, h, w * 0.72, BOOK_COLOURS[Math.floor(rand() * BOOK_COLOURS.length)], [(rand() - 0.5) * 0.08, y + h / 2, (rand() - 0.5) * 0.06], [0, (rand() - 0.5) * 0.6, 0], i === n - 1);
      y += h;
    }
  }
  return { fur: fur.build(), face, foot, books: books.build(), top };
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
  mesh(g.fur, matSoft(), waddle);
  const eyes = mesh(g.face.geo, matFace(), waddle, g.face.at);
  const feet = [-1, 1].map((s) => mesh(g.foot, matSoft(), body, [s * r * 0.42, 0, r * 0.3]));
  const load = mesh(g.books, matSoft(), waddle);
  if (zmeu) {
    // Held up behind the head, tipped back so its cover faces the camera.
    load.position.set(0, g.top - r * 0.3, -r * 0.62);
    load.rotation.x = 0.42;
  } else load.position.set(0, g.top - 0.08, -0.04);
  const loadY = load.position.y;
  const phase = Math.random() * 10;
  const sq = squash(body);
  const blink = blinker(eyes);
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
      waddle.rotation.z = Math.sin(w) * 0.09;
      waddle.position.y = Math.abs(Math.cos(w)) * 0.06;
      feet[0].position.y = Math.max(0, Math.sin(w)) * 0.1;
      feet[1].position.y = Math.max(0, -Math.sin(w)) * 0.1;
      load.rotation.z = -Math.sin(w - 0.6) * 0.07;
      load.position.y = loadY + Math.abs(Math.cos(w - 0.5)) * 0.03;
      blink(dt);
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

const scrollMat = once(() => {
  const tex = canvasTexture(
    256,
    256,
    (g) => {
      g.fillStyle = '#f1e4c6';
      g.fillRect(0, 0, 256, 256);
      // Faint paper fibres.
      const rand = rng(17);
      for (let i = 0; i < 300; i++) {
        g.fillStyle = `rgba(150,110,60,${0.03 + rand() * 0.05})`;
        g.fillRect(rand() * 256, rand() * 256, 2 + rand() * 6, 1);
      }
      // Rows of handwriting (only between u 0.12 and 0.88; the rest stays plain for the sheet's edges).
      g.strokeStyle = 'rgba(70,44,24,0.85)';
      g.lineWidth = 2.2;
      g.lineCap = 'round';
      for (let row = 0; row < 11; row++) {
        const y = 14 + row * 23;
        let x = 34 + rand() * 10;
        while (x < 222) {
          const len = 10 + rand() * 26;
          g.beginPath();
          g.moveTo(x, y);
          for (let k = 0; k <= len; k += 3) g.lineTo(x + k, y + Math.sin(k * 0.9 + row) * 3 - (rand() < 0.1 ? 5 : 0));
          g.stroke();
          x += len + 6 + rand() * 6;
        }
      }
    },
    true,
  );
  return new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, side: THREE.DoubleSide, roughness: 0.92 });
});

/**
 * A rolled-up sheet of parchment: a thick spiral strip around the x axis (seen from the side it is a spiral), with
 * its free end unrolled down to the ground at the back. Vertex colours shade the inner turns, uv carries the writing.
 */
function scrollGeometry(width: number, outerR: number) {
  const turns = 2.6;
  const r0 = 0.09;
  const tk = 0.04;
  const tMax = turns * Math.PI * 2;
  const alpha = tMax - Math.PI / 2;
  const pts: { p: THREE.Vector2; n: THREE.Vector2; s: number }[] = [];
  const steps = Math.round(turns * 44);
  let arc = 0;
  for (let i = 0; i <= steps; i++) {
    const th = (i / steps) * tMax;
    const r = r0 + ((outerR - r0) * th) / tMax;
    const phi = alpha - th;
    const p = new THREE.Vector2(r * Math.cos(phi), r * Math.sin(phi)); // (y, z)
    if (pts.length) arc += p.distanceTo(pts[pts.length - 1].p);
    pts.push({ p, n: p.clone().normalize(), s: arc });
  }
  // The free end: from the back of the roll straight down and slightly out, ending in a little curl.
  const end = pts[pts.length - 1];
  for (let i = 1; i <= 5; i++) {
    const k = i / 5;
    const p = new THREE.Vector2(end.p.x - k * outerR * 1.05, end.p.y - k * k * 0.22);
    arc += p.distanceTo(pts[pts.length - 1].p);
    pts.push({ p, n: new THREE.Vector2(-k * 0.5, -1).normalize(), s: arc });
  }
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const outerCol = new THREE.Color(0xf4e8cc);
  const innerCol = new THREE.Color(0x9c7f58);
  const edgeCol = new THREE.Color(0xe2cfa6);
  const quad = (
    a: Vec, b: Vec, c: Vec, d: Vec, n1: Vec, n2: Vec, color: THREE.Color, uvs: [number, number][],
  ) => {
    // a-b at sample i, c-d at sample i+1; two triangles a b c, b d c.
    for (const [v, n, t] of [[a, n1, uvs[0]], [b, n1, uvs[1]], [c, n2, uvs[2]], [b, n1, uvs[1]], [d, n2, uvs[3]], [c, n2, uvs[2]]] as [Vec, Vec, [number, number]][]) {
      pos.push(...v);
      nor.push(...n);
      col.push(color.r, color.g, color.b);
      uv.push(...t);
    }
  };
  const w = width / 2;
  const plain: [number, number][] = [[0.02, 0.02], [0.02, 0.02], [0.02, 0.02], [0.02, 0.02]];
  for (let i = 0; i < pts.length - 1; i++) {
    const A = pts[i];
    const B = pts[i + 1];
    const oA: Vec = [0, A.p.x, A.p.y];
    const oB: Vec = [0, B.p.x, B.p.y];
    const iA: Vec = [0, A.p.x - A.n.x * tk, A.p.y - A.n.y * tk];
    const iB: Vec = [0, B.p.x - B.n.x * tk, B.p.y - B.n.y * tk];
    const at = (v: Vec, x: number): Vec => [x, v[1], v[2]];
    const nA: Vec = [0, A.n.x, A.n.y];
    const nB: Vec = [0, B.n.x, B.n.y];
    const last = B.s > pts[steps].s - 4.2;
    // Inner turns are shaded darker (they sit in the roll's shadow); the outer turn is bright and written on.
    const shade = innerCol.clone().lerp(outerCol, Math.min(1, (A.s / pts[steps].s) ** 2.2));
    const vA = A.s / 1.2;
    const vB = B.s / 1.2;
    quad(at(oA, -w), at(oA, w), at(oB, -w), at(oB, w), nA, nB, last ? outerCol : shade, [[0.06, vA], [0.94, vA], [0.06, vB], [0.94, vB]]);
    quad(at(iA, w), at(iA, -w), at(iB, w), at(iB, -w), [0, -A.n.x, -A.n.y], [0, -B.n.x, -B.n.y], innerCol, plain);
    for (const s of [-1, 1]) {
      const x = s * w;
      const ec = edgeCol.clone().lerp(innerCol, 0.6 * (1 - A.s / B.s) + (1 - Math.min(1, A.s / pts[steps].s)) * 0.35);
      quad(at(oA, x), at(iA, x), at(oB, x), at(iB, x), [s, 0, 0], [s, 0, 0], ec, plain);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  g.userData.shared = true;
  return g;
}

const SNAIL_SKIN = 0xf1dcbc;
const HEAD = new THREE.Vector3(0, 0.62, 0.8);
const SHELL_Y = 0.86;

const snailGeo = once(() => {
  const skin = (_x: number, y: number) => lerpHex(0x9a7552, SNAIL_SKIN, (y + 0.4) * 1.6);
  const body = new Bake()
    // A long low foot, a neck rising to a round head at the front.
    .add(new THREE.SphereGeometry(1, 20, 12), skin, [0, 0.2, 0.05], [0, 0, 0], [0.42, 0.24, 1.0])
    .add(new THREE.SphereGeometry(1, 14, 10), skin, [0, 0.38, 0.58], [0.5, 0, 0], [0.34, 0.38, 0.36])
    .add(new THREE.SphereGeometry(0.36, 18, 14), SNAIL_SKIN, [0, 0.62, 0.8], [0, 0, 0], [1.05, 0.95, 0.95]);
  // A row of soft brown knobs along the foot's rim, like the reference's chunky little feet.
  for (const s of [-1, 1])
    for (const z of [-0.6, -0.15, 0.3, 0.68])
      body.add(new THREE.SphereGeometry(0.1, 8, 6), 0x6e5038, [s * 0.34, 0.05, z], [0, 0, 0], [1.2, 0.6, 1.3]);
  // The face sits high on the front of the head, turned up towards the camera.
  const face = new Bake();
  const onHead = (x: number, y: number, z: number, out = 0): [Vec, THREE.Quaternion] => {
    const d = new THREE.Vector3(x, y, z).normalize();
    const p = d.clone().multiplyScalar(0.355 + out).add(HEAD);
    return [[p.x, p.y, p.z], new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d)];
  };
  for (const s of [-1, 1]) {
    const [ep, eq] = onHead(s * 0.36, 0.55, 0.78);
    eye(face, ep, new THREE.Vector3(0, 0, 1).applyQuaternion(eq), 0.05);
    const [cp, cq] = onHead(s * 0.62, 0.36, 0.72);
    face.add(new THREE.SphereGeometry(0.055, 8, 6), 0xf09a88, cp, cq, [1, 0.62, 0.3]);
  }
  const [mp, mq] = onHead(0, 0.36, 1, 0.005);
  smile(face, mp, 0.045, mq);
  // Stalk eyes: built upright at the origin, the group sits on top of the head.
  const stalks = new Bake();
  const pupils = new Bake();
  const look = new THREE.Vector3(0, 0.5, 1).normalize();
  for (const s of [-1, 1]) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.05, 0, -s * 0.38));
    const tip = new THREE.Vector3(0, 0.42, 0).applyQuaternion(q).add(new THREE.Vector3(s * 0.1, 0, 0));
    stalks.add(new THREE.CylinderGeometry(0.035, 0.055, 0.42, 7).translate(0, 0.21, 0), SNAIL_SKIN, [s * 0.1, 0, 0], q);
    stalks.add(new THREE.SphereGeometry(0.11, 12, 10), 0xfaf3e6, [tip.x, tip.y, tip.z]);
    const p = look.clone().multiplyScalar(0.085).add(tip);
    eye(pupils, [p.x, p.y, p.z], look, 0.07);
  }
  return {
    body: body.build(),
    face: face.build(),
    stalks: stalks.build(),
    pupils: pupils.build(),
    shell: scrollGeometry(0.8, 0.64),
  };
});

export function makeGhost(): Model {
  const root = new THREE.Group();
  blobShadow(root, 1.6, 2.6);
  const body = new THREE.Group();
  root.add(body);
  const g = snailGeo();
  const crawl = new THREE.Group();
  body.add(crawl);
  // Seen three-quarters on, like the reference, so the scroll's spiral end shows.
  body.rotation.y = 0.75;
  mesh(g.body, matSoft(), crawl);
  const head = new THREE.Group();
  crawl.add(head);
  mesh(g.face, matFace(), head);
  const stalks = new THREE.Group();
  stalks.position.set(0, 0.9, 0.82);
  head.add(stalks);
  mesh(g.stalks, matSoft(), stalks);
  const pupils = new THREE.Group();
  pupils.position.y = 0.4;
  stalks.add(pupils);
  mesh(g.pupils, matFace(), pupils).position.y = -0.4;
  const shell = mesh(g.shell, scrollMat(), body, [0, SHELL_Y, -0.22]);
  const phase = Math.random() * 10;
  const sq = squash(body);
  const blink = blinker(pupils);
  return {
    root,
    radius: 1.1,
    height: 1.45,
    color: SNAIL_SKIN,
    hit: sq.hit,
    animate(dt, t) {
      const tt = t + phase;
      // A slow inchworm stretch of the foot, the head nodding along and the stalks wobbling a beat behind.
      crawl.scale.z = 1 + Math.sin(tt * 2.4) * 0.05;
      stalks.rotation.z = Math.sin(tt * 1.9) * 0.12;
      stalks.rotation.x = Math.sin(tt * 2.4 - 1.2) * 0.1;
      shell.rotation.z = Math.sin(tt * 2.4 + 0.5) * 0.04;
      shell.position.y = SHELL_Y + Math.sin(tt * 2.4 + 0.3) * 0.015;
      blink(dt);
      sq.step(dt);
    },
  };
}

// ---- ink slime (rock) -----------------------------------------------------------------------------------------------

const SLIME = 0x16587a;
/** Drop profile (radius, height) from the bottom centre up to the pointed tip. */
const DROP: [number, number][] = [
  [0, 0], [0.36, 0.02], [0.55, 0.1], [0.64, 0.24], [0.66, 0.38], [0.62, 0.54], [0.53, 0.68],
  [0.41, 0.8], [0.3, 0.9], [0.22, 1.0], [0.16, 1.1], [0.1, 1.2], [0.05, 1.27], [0, 1.3],
];
const EYE_Y = 0.5;
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
    lerpHex(lerpHex(0x0a2c44, SLIME, y * 3), 0x2a82a6, Math.max(0, y - 0.5) * 1.2 + Math.max(0, z) * 0.12);
  const body = new Bake().add(lathe, tone);
  for (const s of [-1, 1]) {
    body.add(new THREE.SphereGeometry(0.14, 10, 8), 0x1b6874, [s * 0.66, 0.3, 0.08], [0, 0, s * 0.5], [1.15, 0.8, 0.9]);
    body.add(new THREE.SphereGeometry(0.13, 10, 6), 0x135561, [s * 0.27, 0.05, 0.42], [0, 0, 0], [1, 0.55, 1.2]);
  }
  // A few sparkly specks in the ink.
  const rand = rng(23);
  for (let i = 0; i < 9; i++) {
    const y = 0.15 + rand() * 0.75;
    const a = (rand() - 0.5) * 2.6 + (i % 3 === 0 ? Math.PI : 0);
    const r = dropRadius(y) + 0.004;
    body.add(new THREE.SphereGeometry(0.018 + rand() * 0.014, 6, 4), 0xd8f4ee, [Math.sin(a) * r, y, Math.cos(a) * r]);
  }
  const face = new Bake();
  for (const s of [-1, 1]) {
    const y = EYE_Y;
    const x = s * 0.23;
    const z = Math.sqrt(dropRadius(y) ** 2 - x * x);
    eye(face, [x, y, z - 0.02], new THREE.Vector3(x * 0.7, 0.3, z).normalize(), 0.15);
  }
  const fq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.2, 1).normalize());
  smile(face, [0, 0.33, dropRadius(0.33) + 0.004], 0.04, fq, 0x061c22);
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
  const sq = squash(body, 0.85);
  body.scale.setScalar(0.85);
  const blink = blinker(eyes);
  return {
    root,
    radius: 0.75,
    height: 1.12,
    color: SLIME,
    hit: sq.hit,
    animate(dt, t) {
      const tt = t + phase;
      // Jelly wobble: squash and stretch out of phase with a little sway of the tip.
      const k = Math.sin(tt * 5.5) * 0.05;
      jiggle.scale.set(1 + k, 1 - k * 1.4, 1 + k);
      jiggle.rotation.z = Math.sin(tt * 2.2) * 0.06;
      jiggle.rotation.x = Math.sin(tt * 2.9) * 0.04;
      blink(dt);
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
