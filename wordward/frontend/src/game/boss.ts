// The boss "balaur", the Bookwyrm: a chubby ink-blue library dragon sat on the floor hugging a book. Its wings are
// open books (fanned cream pages with lines of text and a gilded drop cap, a teal leather cover), its tail curls round
// on the floor and ends in a rolled-up scroll, and it has one head per word (the game places the heads, each a
// separate `Model` from `makeHead`, at offsets relative to the body; a neck arches up to each one).
//
// Draw calls: the whole body (torso, necks, wings, tail) is ONE soft-lit vertex-coloured mesh whose wings and tail
// move by morph targets, plus its contact shadow; each head is one lit mesh and one unlit face mesh (the face blinks
// by a morph target). A three-headed Bookwyrm is 2 + 3 x 2 = 8 draw calls. Head geometry is shared by every head;
// the materials are the shared `vertexColorMaterial(true)` / `flatVertexColorMaterial()` of every creature, and the
// morph target counts (5 lit, 4 face) match enemies.ts so no extra shader programs are compiled.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { flatVertexColorMaterial, shadowBlob, vertexColorMaterial } from './toon';
import type { Model } from './enemies';

// ---- palette ------------------------------------------------------------------------------------------------------

const HIDE = 0x3166a6; // ink-blue hide
const TEAL = 0x3aa69a; // fins, spikes, ear frills
const CREAM = 0xf3e2b4; // belly, muzzle, scroll, claws
const BELLY_LINE = 0xdcc38c; // belly plates
const GOLD = 0xe9b54a;
const RED = 0xa8383f; // the book it hugs
const LEATHER = 0x1f5a6e; // wing covers
const PAPER = 0xfbf1d8;
const INK_TEXT = 0x9a7352;
const INKY = 0x1b1630;
const PINK = 0xff8fb1;

// ---- materials ----------------------------------------------------------------------------------------------------

/** Soft lit with per-vertex colours and the warm rim: shared with every creature. */
const matSoft = () => vertexColorMaterial(true);
/** Unlit per-vertex colour: eyes, highlights, blush, mouths. */
const matFace = () => flatVertexColorMaterial();

// ---- geometry kit -------------------------------------------------------------------------------------------------

type Paint = number | ((p: THREE.Vector3) => number);

const _c = new THREE.Color();
const _v = new THREE.Vector3();
const placer = new THREE.Object3D();
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Gives `geo` vertex colours (linear, like material colours): one hex or a function of the vertex position. */
function paint(geo: THREE.BufferGeometry, color: Paint) {
  const p = geo.attributes.position;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    _c.setHex(typeof color === 'number' ? color : color(_v.fromBufferAttribute(p, i)));
    arr[i * 3] = _c.r;
    arr[i * 3 + 1] = _c.g;
    arr[i * 3 + 2] = _c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Keeps only position, normal and colour, indexed, so every part merges with every other. */
function clean(geo: THREE.BufferGeometry) {
  for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') geo.deleteAttribute(name);
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

/** Reverses the triangle winding (after a mirroring transform, or for the back of a sheet). */
function flipWinding(geo: THREE.BufferGeometry) {
  const idx = geo.index!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  return geo;
}

/** Collects coloured primitives and merges them into one geometry. */
class Parts {
  list: THREE.BufferGeometry[] = [];
  /**
   * Adds `geo` scaled by `scale`, rotated by `rot` (or turned so +z faces `look`), moved to `pos`, then painted
   * (a paint function sees final positions).
   */
  add(geo: THREE.BufferGeometry, color: Paint | undefined, pos?: THREE.Vector3Like, rot?: THREE.Euler | null, look?: THREE.Vector3Like | null, scale?: THREE.Vector3Like) {
    placer.position.set(pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0);
    placer.rotation.set(0, 0, 0);
    if (rot) placer.rotation.copy(rot);
    if (look) placer.lookAt(look.x, look.y, look.z);
    placer.scale.set(scale?.x ?? 1, scale?.y ?? 1, scale?.z ?? 1);
    placer.updateMatrix();
    geo.applyMatrix4(placer.matrix);
    this.list.push(clean(color === undefined ? geo : paint(geo, color)));
    return geo;
  }
  /** Adds a geometry that already has its own vertex colours. */
  raw(geo: THREE.BufferGeometry) {
    this.list.push(clean(geo));
    return geo;
  }
  merge(): THREE.BufferGeometry {
    const g = mergeGeometries(this.list)!;
    for (const p of this.list) p.dispose();
    this.list = [];
    return g;
  }
}

/** Darkens vertex colours towards `y0` and lightens them towards `y1`: a soft painted gradient, top lit. */
function gradeByHeight(geo: THREE.BufferGeometry, y0: number, y1: number, lo = 0.78, hi = 1.12) {
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const k = THREE.MathUtils.clamp((pos.getY(i) - y0) / (y1 - y0), 0, 1);
    const m = lo + (hi - lo) * k * k * (3 - 2 * k);
    col.setXYZ(i, col.getX(i) * m, col.getY(i) * m, col.getZ(i) * m);
  }
  return geo;
}

/** A tube along `curve` whose radius goes from r0 to r1, with the underside and front (by normal) in `belly`. */
function taperedTube(curve: THREE.Curve<THREE.Vector3>, r0: number, r1: number, color: number, belly?: number, segs = 20, radial = 10, front = true) {
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const c = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    curve.getPointAt(i / segs, c);
    const t = i / segs;
    const r = r0 + (r1 - r0) * t;
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      pos.setXYZ(k, c.x + (pos.getX(k) - c.x) * r, c.y + (pos.getY(k) - c.y) * r, c.z + (pos.getZ(k) - c.z) * r);
    }
  }
  paint(g, color);
  if (belly !== undefined) {
    const col = g.attributes.color;
    const b = new THREE.Color(belly);
    for (let k = 0; k < nor.count; k++) if (nor.getY(k) < -0.3 || (front && nor.getZ(k) > 0.7)) col.setXYZ(k, b.r, b.g, b.b);
  }
  return g;
}

/** A cone pointing along +y with its base at the origin, golden at the tip. */
const spike = (r: number, h: number, base = TEAL, tip = GOLD, radial = 7) => {
  const g = new THREE.ConeGeometry(r, h, radial).translate(0, h / 2, 0);
  return paint(g, (p) => (p.y > h * 0.62 ? tip : base));
};

/** Squash and stretch on hit, decaying over a fraction of a second. */
function squash(body: THREE.Object3D) {
  let k = 0;
  return {
    hit() {
      k = 1;
    },
    step(dt: number) {
      if (k <= 0) return;
      k = Math.max(0, k - dt * 6);
      const s = 1 + Math.sin(k * Math.PI) * 0.12;
      body.scale.set(s, 1 / s, s);
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

/** Relative morph targets for `geo`: one delta array per target (null = this part does not move for it). */
function setMorphs(geo: THREE.BufferGeometry, targets: (Float32Array | null)[]) {
  const n = geo.attributes.position.count;
  geo.morphAttributes.position = targets.map((d) => new THREE.BufferAttribute(d ?? new Float32Array(n * 3), 3));
  geo.morphTargetsRelative = true;
  return geo;
}

/** Positions of `geo` moved by `to` minus moved by `from`: a relative morph target. */
function delta(geo: THREE.BufferGeometry, from: THREE.Matrix4, to: THREE.Matrix4) {
  const p = geo.attributes.position;
  const d = new Float32Array(p.count * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    a.fromBufferAttribute(p, i).applyMatrix4(from);
    b.fromBufferAttribute(p, i).applyMatrix4(to);
    d[i * 3] = b.x - a.x;
    d[i * 3 + 1] = b.y - a.y;
    d[i * 3 + 2] = b.z - a.z;
  }
  return d;
}

/** Merges geometries that all carry the same number of morph targets (mergeGeometries drops the relative flag). */
function mergeMorphed(list: THREE.BufferGeometry[]) {
  const g = mergeGeometries(list)!;
  for (const p of list) p.dispose();
  g.morphTargetsRelative = true;
  return g;
}

// ---- head ---------------------------------------------------------------------------------------------------------

/** Head centre above the chin (the head's origin), and the cranium's radii. */
const HEAD_C = 1.0;
const HR = v3(1.1, 0.92, 0.95);
/** The face tips up towards the high camera by this much. */
const HEAD_TILT = -0.42;
const headGeos: { soft: THREE.BufferGeometry; face: THREE.BufferGeometry }[] = [];

/** The point of the cranium in direction (x, y, z) from its centre, and the surface normal there. */
function onCranium(x: number, y: number, z: number) {
  const d = v3(x, y, z).normalize();
  const p = v3(d.x * HR.x, HEAD_C + d.y * HR.y, d.z * HR.z);
  const n = v3(d.x / HR.x, d.y / HR.y, d.z / HR.z).normalize();
  return { p, n };
}

function buildHead(glasses: boolean) {
  const C = HEAD_C;
  const p = new Parts();
  p.add(new THREE.SphereGeometry(1, 20, 14), HIDE, v3(0, C, 0), null, null, HR);
  // A round cream snout, wide and short, with the cheeks puffing out at the sides.
  p.add(new THREE.SphereGeometry(0.6, 16, 10), CREAM, v3(0, C - 0.36, 0.55), null, null, v3(1.3, 0.72, 0.95));
  for (const s of [-1, 1]) {
    // Little golden horns curling back, soft teal ear frills, cheek tufts.
    p.add(spike(0.15, 0.58, GOLD, 0xf6d27a), undefined, v3(s * 0.45, C + 0.68, -0.18), new THREE.Euler(-0.65, 0, -s * 0.4));
    p.add(new THREE.ConeGeometry(0.24, 0.7, 8).scale(1, 1, 0.35).translate(0, 0.33, 0), TEAL, v3(s * 0.92, C + 0.1, -0.2), new THREE.Euler(-0.2, 0, -s * 1.15));
    p.add(new THREE.ConeGeometry(0.15, 0.42, 6).translate(0, 0.2, 0), TEAL, v3(s * 0.86, C - 0.38, 0.0), new THREE.Euler(0.3, 0, -s * 1.95));
  }
  for (let i = 0; i < 3; i++) {
    p.add(spike(0.15 - i * 0.025, 0.42 - i * 0.05, TEAL, TEAL), undefined, v3(0, C + 0.8 - i * 0.3, -0.3 - i * 0.3), new THREE.Euler(-0.6 - i * 0.5, 0, 0));
  }
  const soft = gradeByHeight(p.merge(), 0.1, 2.0, 0.8, 1.1);

  // The face, unlit so it stays crisp: big glossy eyes, blush, nostrils and a little smile with one fang.
  const f = new Parts();
  const eyeParts: { g: THREE.BufferGeometry; centre: THREE.Vector3; up: THREE.Vector3; dot: boolean }[] = [];
  for (const s of [-1, 1]) {
    const { p: at, n } = onCranium(s * 0.42, 0.3, 0.86);
    const up = v3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    const side = new THREE.Vector3().crossVectors(up, n);
    const eye = f.add(new THREE.SphereGeometry(0.27, 14, 9), INKY, at.clone().addScaledVector(n, -0.04), null, at.clone().add(n), v3(0.82, 1.08, 0.38));
    eyeParts.push({ g: eye, centre: at, up, dot: false });
    const hl = at.clone().addScaledVector(up, 0.1).addScaledVector(side, -0.07 * s).addScaledVector(n, 0.07);
    eyeParts.push({ g: f.add(new THREE.SphereGeometry(0.085, 8, 5), 0xffffff, hl), centre: hl, up, dot: true });
    const hl2 = at.clone().addScaledVector(up, -0.09).addScaledVector(side, 0.07 * s).addScaledVector(n, 0.07);
    eyeParts.push({ g: f.add(new THREE.SphereGeometry(0.04, 6, 4), 0xffffff, hl2), centre: hl2, up, dot: true });
    const blush = onCranium(s * 0.72, -0.12, 0.62);
    f.add(new THREE.CircleGeometry(0.15, 14), PINK, blush.p.addScaledVector(blush.n, 0.03), null, blush.p.clone().add(blush.n), v3(1.2, 0.8, 1));
    f.add(new THREE.SphereGeometry(0.05, 6, 4), 0x8a6a4a, v3(s * 0.2, C - 0.2, 1.08), null, null, v3(1.2, 0.7, 1));
    if (glasses) f.add(new THREE.TorusGeometry(0.31, 0.04, 5, 20), GOLD, at.clone().addScaledVector(n, 0.12), null, at.clone().add(n));
  }
  if (glasses) f.add(new THREE.TorusGeometry(0.12, 0.035, 5, 10, Math.PI), GOLD, v3(0, C + 0.36, 0.98), new THREE.Euler(-0.35, 0, 0));
  f.add(new THREE.TorusGeometry(0.13, 0.03, 5, 14, Math.PI * 0.9), INKY, v3(0, C - 0.4, 1.1), new THREE.Euler(0.2, 0, Math.PI * 1.05));
  f.add(new THREE.ConeGeometry(0.045, 0.11, 4).rotateX(Math.PI), 0xffffff, v3(0.09, C - 0.53, 1.06));
  // Blink morph (eyes flatten about their centre along the face's up, highlights shrink away), padded to the
  // 4 targets every creature face has.
  const n = f.list.map((g) => g.attributes.position.count);
  const blink = f.list.map((g, i) => {
    const e = eyeParts.find((x) => x.g === g);
    if (!e) return new Float32Array(n[i] * 3);
    const pos = g.attributes.position;
    const d = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) {
      _v.fromBufferAttribute(pos, k).sub(e.centre);
      const move = e.dot ? _v.clone().multiplyScalar(-1) : e.up.clone().multiplyScalar(-_v.dot(e.up) * 0.88);
      d[k * 3] = move.x;
      d[k * 3 + 1] = move.y;
      d[k * 3 + 2] = move.z;
    }
    return d;
  });
  f.list.forEach((g, i) => setMorphs(g, [blink[i], null, null, null]));
  const face = mergeMorphed(f.list);
  f.list = [];
  for (const g of [soft, face]) {
    g.computeBoundingSphere();
    g.userData.shared = true;
  }
  return { soft, face };
}

let headCount = 0;

/** A Bookwyrm head with its own word, origin at its chin; every other head wears round golden reading glasses. */
export function makeHead(): Model {
  const variant = headCount++ % 2;
  const geos = (headGeos[variant] ??= buildHead(variant === 1));
  const root = new THREE.Group();
  root.name = 'bookwyrm-head';
  const body = new THREE.Group();
  root.add(body);
  // Pivot at the head centre, tipped up so the face reads from the high camera.
  const head = new THREE.Group();
  head.position.y = HEAD_C;
  body.add(head);
  const tilt = new THREE.Group();
  tilt.position.y = -HEAD_C;
  tilt.rotation.x = HEAD_TILT;
  head.add(tilt);
  const face = new THREE.Mesh(geos.face, matFace());
  tilt.add(new THREE.Mesh(geos.soft, matSoft()), face);
  const fm = face.morphTargetInfluences!;
  const blink = blinker();
  const phase = Math.random() * 10;
  const sq = squash(body);
  return {
    root,
    radius: 1.15,
    height: 2.2,
    color: HIDE,
    hit: sq.hit,
    animate(dt, t) {
      head.rotation.z = Math.sin(t * 1.8 + phase) * 0.12;
      head.rotation.y = Math.sin(t * 1.1 + phase) * 0.18;
      head.rotation.x = Math.sin(t * 1.4 + phase * 1.3) * 0.06;
      fm[0] = blink(dt) ? 1 : 0;
      sq.step(dt);
    },
  };
}

// ---- wings --------------------------------------------------------------------------------------------------------

/** A point of wing sheet `k` (0 front page .. 3 cover) at (u along from the spine, v up), in the wing's own space. */
function sheetPoint(k: number, u: number, v: number, len: number, tall: number, out = new THREE.Vector3()) {
  const L = len * (k === 3 ? 1.04 : 1 - k * 0.05);
  // Outline: the top edge sweeps up to the tip, the bottom edge is scalloped like a dragon wing.
  const top = tall * (0.62 + 0.38 * Math.sin(u * Math.PI * 0.5));
  const bottom = -tall * (0.32 - 0.12 * u) + Math.abs(Math.sin(u * Math.PI * 2.5)) * tall * 0.16 * u;
  // Pages bulge forward away from the spine and curl back at the tip; the sheets fan back about the spine.
  const z = Math.sin(u * Math.PI) * 0.35 * (1 - k * 0.15) - u * u * 0.3 - k * 0.03;
  out.set(u * L, bottom + (top - bottom) * v, z);
  const a = k * 0.12;
  return out.set(out.x * Math.cos(a) + out.z * Math.sin(a), out.y, -out.x * Math.sin(a) + out.z * Math.cos(a));
}

/** A grid over sheet `k` with the given u/v rows, coloured per (u, v), front and back (back in `back`). */
function sheet(k: number, us: number[], vs: number[], len: number, tall: number, color: (u: number, v: number) => number, back: number) {
  const nu = us.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3();
  for (const v of vs) for (const u of us) pos.push(...sheetPoint(k, u, v, len, tall, p).toArray());
  for (let j = 0; j < vs.length - 1; j++)
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i;
      idx.push(a, a + 1, a + nu + 1, a, a + nu + 1, a + nu);
    }
  const front = new THREE.BufferGeometry();
  front.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  front.setIndex(idx);
  front.computeVertexNormals();
  const col: number[] = [];
  for (const v of vs) for (const u of us) col.push(..._c.setHex(color(u, v)).toArray());
  front.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // The back: the same sheet a hair behind, wound the other way, normals flipped.
  const rear = front.clone();
  const n = rear.attributes.normal;
  const rp = rear.attributes.position;
  for (let i = 0; i < n.count; i++) {
    rp.setXYZ(i, rp.getX(i) - n.getX(i) * 0.012, rp.getY(i) - n.getY(i) * 0.012, rp.getZ(i) - n.getZ(i) * 0.012);
    n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  }
  paint(rear, back);
  flipWinding(rear);
  return [front, rear];
}

/** A strip lying on the front page between u0..u1 around v (text lines), lifted off the paper a little. */
function pageStrip(u0: number, u1: number, v: number, h: number, len: number, tall: number, color: number) {
  const segs = Math.max(1, Math.round((u1 - u0) * 12));
  const pos: number[] = [];
  const idx: number[] = [];
  const p = new THREE.Vector3();
  for (const dv of [-h / 2, h / 2])
    for (let i = 0; i <= segs; i++) {
      sheetPoint(0, u0 + ((u1 - u0) * i) / segs, v + dv, len, tall, p);
      pos.push(p.x, p.y, p.z + 0.025);
    }
  for (let i = 0; i < segs; i++) idx.push(i, i + 1, i + segs + 2, i, i + segs + 2, i + segs + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return paint(g, color);
}

/**
 * An open-book wing in its own space, spine along y at the origin, extending along +x: three fanned pages (the front
 * one with lines of text and a gilded drop cap) and the teal leather cover behind, with a gold-capped spine.
 */
function wingGeometry(len: number, tall: number) {
  const parts = new Parts();
  const us = Array.from({ length: 15 }, (_, i) => i / 14);
  const pageV = [0, 0.03, 0.25, 0.5, 0.75, 0.97, 1];
  const shades = [PAPER, 0xf0dfb6, 0xe4cc98];
  for (let k = 0; k < 3; k++) {
    const shade = shades[k];
    for (const g of sheet(k, us, pageV, len, tall, (u, v) => {
      if (v <= 0 || v >= 1 || u >= 1) return 0xb08850; // the gilt-brown page edge
      return lerpHex(0xd9bf8a, shade, Math.min(1, u * 5));
    }, 0xe8d3a4))
      parts.raw(g);
  }
  const coverV = [0, 0.04, 0.96, 1];
  for (const g of sheet(3, us, coverV, len, tall, (u, v) => (v <= 0 || v >= 1 || u >= 1 ? GOLD : LEATHER), LEATHER)) parts.raw(g);
  // Lines of handwriting: dashes of varying length in brown ink, shorter beside the drop cap.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let v = 0.15; v < 0.88; v += 0.065) {
    let u = v > 0.56 ? 0.42 : 0.12;
    while (u < 0.86) {
      const l = 0.05 + rnd() * 0.12;
      const u1 = Math.min(u + l, 0.88);
      parts.raw(pageStrip(u, u1, v, 0.016, len, tall, INK_TEXT));
      u = u1 + 0.025;
    }
  }
  // The illuminated drop cap: a gold roundel with a red star, ringed in brown.
  const cap = sheetPoint(0, 0.24, 0.73, len, tall);
  cap.z += 0.04;
  const r = tall * 0.12;
  parts.add(new THREE.CircleGeometry(r, 20), GOLD, cap);
  parts.add(new THREE.RingGeometry(r, r * 1.18, 20), 0x7a4424, v3(cap.x, cap.y, cap.z + 0.002));
  const star = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const rr = i % 2 ? r * 0.32 : r * 0.72;
    if (i === 0) star.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    else star.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  parts.add(new THREE.ShapeGeometry(star), RED, v3(cap.x, cap.y, cap.z + 0.01));
  // The spine: a rounded leather roll with gold caps.
  parts.add(new THREE.CylinderGeometry(0.16, 0.16, tall * 1.02, 10), LEATHER, v3(0, tall * 0.15, -0.08));
  for (const y of [-tall * 0.36, tall * 0.66]) parts.add(new THREE.SphereGeometry(0.2, 10, 8), GOLD, v3(0, y, -0.08));
  return parts.merge();
}

function lerpHex(a: number, b: number, k: number) {
  return _c.setHex(a).lerp(new THREE.Color(b), Math.min(1, Math.max(0, k))).getHex();
}

// ---- body ---------------------------------------------------------------------------------------------------------

/** Morph targets of the body mesh (5, like every lit creature mesh). */
const M_WING_UP = 0;
const M_WING_DOWN = 1;
const M_TAIL = 2;
const M_BREATH = 3;
const BODY_TARGETS = 5;

/** The Bookwyrm's body: sat on the floor hugging a book, open-book wings, a scroll tail and a neck to each head (x, y). */
export function makeBalaurBody(heads: { x: number; y: number }[]): Model {
  const root = new THREE.Group();
  root.name = 'bookwyrm';
  const maxX = Math.max(0, ...heads.map((h) => Math.abs(h.x)));
  const maxY = Math.max(0, ...heads.map((h) => h.y));
  const W = 1.55; // torso half-width
  const TZ = -1.1; // torso centre, behind the heads
  const TY = 1.75;
  const pieces: THREE.BufferGeometry[] = [];
  const none = (): (Float32Array | null)[] => Array(BODY_TARGETS).fill(null);

  // Torso (breathes): a chubby pear sat on the floor, a plated cream belly, stubby arms round a big red book.
  const t = new Parts();
  t.add(new THREE.SphereGeometry(1, 24, 16), HIDE, v3(0, TY + 0.2, TZ), null, null, v3(W, 1.65, 1.35));
  t.add(new THREE.SphereGeometry(1, 20, 12), HIDE, v3(0, 1.05, TZ - 0.05), null, null, v3(W * 1.18, 1.05, 1.5));
  t.add(new THREE.SphereGeometry(1, 18, 14), (p) => (Math.floor((p.y - 0.2) / 0.34) % 2 ? BELLY_LINE : CREAM), v3(0, TY - 0.1, TZ + 0.62), null, null, v3(W * 0.74, 1.45, 0.82));
  for (const s of [-1, 1]) {
    t.add(new THREE.SphereGeometry(0.36, 12, 10), HIDE, v3(s * W * 0.82, TY + 0.35, TZ + 0.85), new THREE.Euler(0.4, -s * 0.7, 0), null, v3(1, 1, 2.0));
    t.add(new THREE.SphereGeometry(0.3, 10, 8), HIDE, v3(s * 0.6, TY + 0.25, TZ + 1.68));
    for (let c = -1; c <= 1; c++) t.add(new THREE.SphereGeometry(0.08, 6, 5), CREAM, v3(s * 0.48 + c * 0.1, TY + 0.38, TZ + 1.86));
  }
  // The book: red cover, cream page block showing at the top and side, a gold clasp and corners.
  const tilt = new THREE.Euler(-0.5, 0, 0);
  const bookAt = v3(0, TY + 0.05, TZ + 1.45);
  t.add(new THREE.BoxGeometry(1.5, 1.15, 0.4), RED, bookAt, tilt);
  t.add(new THREE.BoxGeometry(1.4, 1.08, 0.3), CREAM, v3(0, 0.05, 0.02).applyEuler(tilt).add(bookAt), tilt);
  t.add(new THREE.CircleGeometry(0.24, 16), GOLD, v3(0, 0, 0.205).applyEuler(tilt).add(bookAt), tilt);
  t.add(new THREE.CircleGeometry(0.13, 12), RED, v3(0, 0, 0.21).applyEuler(tilt).add(bookAt), tilt);
  for (const cx of [-1, 1]) for (const cy of [-1, 1]) t.add(new THREE.BoxGeometry(0.2, 0.2, 0.44), GOLD, v3(cx * 0.66, cy * 0.48, 0).applyEuler(tilt).add(bookAt), tilt);
  // Soft gold-tipped spikes down the back.
  for (let i = 0; i < 6; i++) {
    const a = 0.45 + i * 0.3;
    t.add(spike(0.24 - i * 0.02, 0.6 - i * 0.04), undefined, v3(0, TY + 0.2 + 1.62 * Math.cos(a), TZ - 1.32 * Math.sin(a)), new THREE.Euler(-a, 0, 0));
  }
  const torso = gradeByHeight(t.merge(), 0, TY + 1.9, 0.74, 1.08);
  const breath = new Float32Array(torso.attributes.position.count * 3);
  {
    const p = torso.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const k = THREE.MathUtils.clamp((p.getY(i) - 0.4) / 2.5, 0, 1); // the floor contact stays put
      breath[i * 3] = p.getX(i) * 0.05 * k;
      breath[i * 3 + 1] = (p.getY(i) - 0.4) * 0.035 * k;
      breath[i * 3 + 2] = (p.getZ(i) - TZ) * 0.05 * k;
    }
  }
  const tm = none();
  tm[M_BREATH] = breath;
  pieces.push(setMorphs(torso, tm));

  // Feet and necks (still).
  const l = new Parts();
  for (const s of [-1, 1]) {
    const fx = s * W * 0.7;
    l.add(new THREE.SphereGeometry(0.62, 12, 9), HIDE, v3(fx, 0.36, TZ + 1.0), null, null, v3(1.05, 0.62, 1.3));
    for (let c = -1; c <= 1; c++) l.add(new THREE.SphereGeometry(0.13, 8, 6), CREAM, v3(fx + c * 0.26, 0.2, TZ + 1.74), null, null, v3(1, 0.8, 1.2));
  }
  // A neck arching up from the shoulders into the back of each head, cream underneath, a few fins along the top.
  for (const h of heads) {
    const from = v3(THREE.MathUtils.clamp(h.x * 0.25, -0.8, 0.8), TY + 1.2, TZ + 0.15);
    const to = v3(h.x, h.y + 0.85, -0.1);
    const mid = v3(h.x * 0.55, Math.max(from.y, to.y) + 1.3, (from.z + to.z) / 2 - 0.5);
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    l.raw(taperedTube(curve, 0.5, 0.36, HIDE, CREAM, 16, 9, false));
    // A rounded end, so a neck whose head was defeated ends in a soft stump.
    l.add(new THREE.SphereGeometry(0.36, 8, 6), HIDE, to);
    for (const u of [0.3, 0.5, 0.7]) {
      const at = curve.getPointAt(u);
      const tan = curve.getTangentAt(u);
      const up = v3(0, 1, 0).addScaledVector(tan, -tan.y).normalize();
      const r = 0.5 + (0.36 - 0.5) * u;
      const q = new THREE.Quaternion().setFromUnitVectors(v3(0, 1, 0), up.clone().addScaledVector(tan, -0.5).normalize());
      l.add(spike(0.16, 0.38), undefined, at.addScaledVector(up, r * 0.85), new THREE.Euler().setFromQuaternion(q));
    }
  }
  pieces.push(setMorphs(gradeByHeight(l.merge(), 0, maxY + 1.5, 0.76, 1.08), none()));

  // Open-book wings behind the shoulders, flapping about the spine by two morph targets (up and down from the
  // middle pose, so the swing stays an arc rather than a chord).
  const len = 3.4 + Math.min(maxX, 6) * 0.22;
  const wing = wingGeometry(len, 2.9);
  const pose = (s: number, f: number) => {
    const side = new THREE.Matrix4().compose(v3(s * 0.75, TY + 1.15, TZ - 0.75), new THREE.Quaternion(), v3(s, 1, 1));
    const flap = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-0.72, 0.3 + f * 0.3, 0.3 + f * 0.1));
    return side.multiply(flap);
  };
  for (const s of [-1, 1]) {
    const g = wing.clone();
    const base = pose(s, 0);
    const tw = none();
    tw[M_WING_UP] = delta(g, base, pose(s, 1));
    tw[M_WING_DOWN] = delta(g, base, pose(s, -1));
    g.applyMatrix4(base);
    if (s < 0) flipWinding(g);
    pieces.push(setMorphs(g, tw));
  }
  wing.dispose();

  // A tail curling round the right side on the floor, ending in a rolled-up scroll with golden knobs; it sways by a
  // morph target (a turn about its root).
  const tp = new Parts();
  const curve = new THREE.CatmullRomCurve3([v3(0, 0, 0), v3(1.1, -0.1, -0.45), v3(W + 1.5, -0.16, 0.0), v3(W + 2.0, -0.15, 1.3), v3(W + 1.5, -0.12, 2.3)]);
  tp.raw(taperedTube(curve, 0.55, 0.2, HIDE, CREAM, 22, 9));
  for (const u of [0.25, 0.45, 0.65]) {
    const at = curve.getPointAt(u);
    const r = 0.55 + (0.2 - 0.55) * u;
    tp.add(spike(0.14, 0.32), undefined, at.add(v3(0, r * 0.85, 0)));
  }
  const end = curve.getPointAt(1);
  const dir = curve.getTangentAt(1);
  const scrollAt = end.clone().addScaledVector(dir, 0.18);
  scrollAt.y = -0.17;
  const across = Math.atan2(dir.x, dir.z);
  const turn = new THREE.Euler(0, across, 0);
  tp.add(new THREE.CylinderGeometry(0.3, 0.3, 1.3, 16).rotateZ(Math.PI / 2), CREAM, scrollAt, turn);
  for (const s of [-1, 1]) tp.add(new THREE.SphereGeometry(0.17, 10, 8), GOLD, v3(s * 0.75, 0, 0).applyEuler(turn).add(scrollAt));
  tp.add(new THREE.CylinderGeometry(0.31, 0.31, 0.16, 16).rotateZ(Math.PI / 2), RED, scrollAt, turn);
  const tail = tp.merge();
  const tailRoot = new THREE.Matrix4().makeTranslation(0.3, 0.5, TZ - 1.2);
  const tt = none();
  tt[M_TAIL] = delta(tail, tailRoot, tailRoot.clone().multiply(new THREE.Matrix4().makeRotationY(0.14)));
  tail.applyMatrix4(tailRoot);
  pieces.push(setMorphs(tail, tt));

  const geo = mergeMorphed(pieces);
  geo.computeBoundingSphere();
  geo.boundingSphere!.radius += 1.2; // the wings swing outside the rest pose
  const bodyMesh = new THREE.Mesh(geo, matSoft());
  root.add(bodyMesh);
  const m = bodyMesh.morphTargetInfluences!;

  const blob = shadowBlob(W * 2.0, 0.35);
  blob.geometry.userData.shared = true; // the blob plane is shared by every contact shadow
  blob.position.z = TZ + 0.3;
  blob.scale.z *= 0.75;
  root.add(blob);

  const sq = squash(bodyMesh);
  return {
    root,
    radius: Math.max(2.3, maxX * 0.6),
    height: Math.max(3.8, maxY + 2.2),
    color: HIDE,
    hit: sq.hit,
    animate(dt, t) {
      // A slow book-like flap: the pages swing about the spine.
      const f = Math.sin(t * 2.6);
      m[M_WING_UP] = Math.max(0, f);
      m[M_WING_DOWN] = Math.max(0, -f);
      m[M_TAIL] = Math.sin(t * 1.3);
      m[M_BREATH] = 0.5 + Math.sin(t * 2.1) * 0.5;
      sq.step(dt);
    },
  };
}

