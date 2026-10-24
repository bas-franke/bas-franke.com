// The boss "balaur": a big, chubby library dragon in ink blue and teal that sits on the floor hugging a book. Its
// wings are fanned-out book pages, its tail ends in a rolled-up scroll, and it has one head per word (the game places
// the heads, each a separate `Model` from `makeHead`, at offsets relative to the body; a neck runs to each one).
//
// Built for few draw calls: every rigid part is merged into one soft-lit vertex-coloured mesh, the
// face details into one flat vertex-coloured mesh. Body 1, contact shadow 1, wings 2, tail 1, each head 2: a
// three-headed balaur is 11 draw calls. Head geometry is shared by every head.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { shadowBlob, toonRamp, vertexColorMaterial } from './toon';
import type { Model } from './enemies';

// ---- palette ------------------------------------------------------------------------------------------------------

const BLUE = 0x2d5f9e; // ink-blue hide
const TEAL = 0x3fa9a4; // fins, spikes, wing covers
const MUZZLE = 0x6cbcc9;
const CREAM = 0xf3e2b4; // belly, scroll, claws
const GOLD = 0xe9b54a;
const RED = 0xa8383f; // the book it hugs
const INKY = 0x1b1630;
const PINK = 0xff8fb1;

// ---- shared materials ---------------------------------------------------------------------------------------------

/** Soft lit with per-vertex colours (and the warm rim), so a whole creature part is one draw call. */
const vcToon = () => vertexColorMaterial(true);

let flatVC: THREE.MeshBasicMaterial | null = null;
/** Unlit per-vertex colour: eyes, highlights, blush, mouths. */
function vcFlat() {
  if (!flatVC) flatVC = new THREE.MeshBasicMaterial({ vertexColors: true });
  return flatVC;
}

let pageMat: THREE.MeshToonMaterial | null = null;
/**
 * The wing texture is an atlas: the left 72% is a book page (cream paper, lines of ink text, a golden illumination,
 * a dark outline at the edge), the right part is the leather cover (teal with a gold trim).
 */
function pageMaterial() {
  if (!pageMat) {
    const W = 1024;
    const H = 512;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    const PW = 736;
    const paper = g.createLinearGradient(0, 0, PW, 0);
    paper.addColorStop(0, '#d9c08c');
    paper.addColorStop(0.18, '#f6e8c6');
    paper.addColorStop(1, '#fbf1d8');
    g.fillStyle = paper;
    g.fillRect(0, 0, PW, H);
    // Lines of handwriting: short dashes of varying length in brown ink.
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.strokeStyle = 'rgba(92, 62, 40, 0.75)';
    g.lineCap = 'round';
    g.lineWidth = 5;
    for (let y = 70; y < H - 50; y += 30) {
      let x = y < 200 ? 250 : 70;
      while (x < PW - 70) {
        const len = 18 + rnd() * 60;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(Math.min(x + len, PW - 70), y);
        g.stroke();
        x += len + 14;
      }
    }
    // An illuminated drop cap: a golden roundel with a star.
    g.fillStyle = '#e9b54a';
    g.beginPath();
    g.arc(150, 130, 70, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#8a4b22';
    g.lineWidth = 6;
    g.stroke();
    g.fillStyle = '#a8383f';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 ? 22 : 50;
      g.lineTo(150 + Math.cos(a) * r, 130 + Math.sin(a) * r);
    }
    g.fill();
    // Cover leather with a gold trim.
    g.fillStyle = '#1f5a6e';
    g.fillRect(PW + 32, 0, W - PW - 32, H);
    g.strokeStyle = '#e9b54a';
    g.lineWidth = 10;
    g.strokeRect(PW + 62, 30, W - PW - 92, H - 60);
    // Dark ink outline at the edge of both regions (it follows the wing outline, since the UVs span the sheet).
    g.strokeStyle = '#5a3524';
    g.lineWidth = 12;
    g.strokeRect(9, 9, PW - 18, H - 18);
    g.strokeRect(PW + 32 + 9, 9, W - PW - 32 - 18, H - 18);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    pageMat = new THREE.MeshToonMaterial({ map: tex, gradientMap: toonRamp(), side: THREE.DoubleSide });
  }
  return pageMat;
}
const PAGE_U = 0.7; // where the page region ends in the atlas
const COVER_U0 = 0.75;

// ---- geometry kit -------------------------------------------------------------------------------------------------

const tmpColor = new THREE.Color();
const placer = new THREE.Object3D();

/** Gives `geo` a flat vertex colour (in the linear working space, like material colours). */
function paint(geo: THREE.BufferGeometry, hex: number) {
  tmpColor.setHex(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = tmpColor.r;
    arr[i * 3 + 1] = tmpColor.g;
    arr[i * 3 + 2] = tmpColor.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Collects coloured primitives and merges them into one geometry. */
class Parts {
  private list: THREE.BufferGeometry[] = [];
  /** Adds `geo` in `color`, moved to `pos`, optionally rotated (Euler) first or turned to face `look`. */
  add(geo: THREE.BufferGeometry, color: number, pos?: THREE.Vector3Like, rot?: THREE.Euler, look?: THREE.Vector3Like) {
    placer.position.set(pos?.x ?? 0, pos?.y ?? 0, pos?.z ?? 0);
    placer.rotation.set(0, 0, 0);
    if (rot) placer.rotation.copy(rot);
    if (look) placer.lookAt(look.x, look.y, look.z);
    placer.scale.set(1, 1, 1);
    placer.updateMatrix();
    geo.applyMatrix4(placer.matrix);
    this.list.push(paint(geo, color));
    return geo;
  }
  /** Adds a geometry that already has its own vertex colours. */
  raw(geo: THREE.BufferGeometry) {
    this.list.push(geo);
    return geo;
  }
  merge(): THREE.BufferGeometry {
    const g = mergeGeometries(this.list)!;
    for (const p of this.list) p.dispose();
    this.list = [];
    return g;
  }
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A soft-lit vertex-coloured mesh. */
function meshVC(parent: THREE.Object3D, geo: THREE.BufferGeometry) {
  const mesh = new THREE.Mesh(geo, vcToon());
  parent.add(mesh);
  return mesh;
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

/** A tube along `curve` whose radius goes from r0 to r1, with the underside (normal pointing down) in `belly`. */
function taperedTube(curve: THREE.Curve<THREE.Vector3>, r0: number, r1: number, color: number, belly?: number, segs = 20, radial = 10) {
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const c = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    curve.getPointAt(i / segs, c);
    const r = r0 + (r1 - r0) * (i / segs);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      pos.setXYZ(k, c.x + (pos.getX(k) - c.x) * r, c.y + (pos.getY(k) - c.y) * r, c.z + (pos.getZ(k) - c.z) * r);
    }
  }
  paint(g, color);
  if (belly !== undefined) {
    const col = g.attributes.color;
    const b = new THREE.Color(belly);
    for (let k = 0; k < nor.count; k++) if (nor.getY(k) < -0.35 || nor.getZ(k) > 0.75) col.setXYZ(k, b.r, b.g, b.b);
  }
  return g;
}

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
      const s = 1 + Math.sin(k * Math.PI) * 0.18;
      body.scale.set(s, 1 / s, s);
    },
  };
}

// ---- head ---------------------------------------------------------------------------------------------------------

/** Head centre above the chin (the head's origin). */
const HEAD_C = 0.95;
const headGeos: { toon: THREE.BufferGeometry; face: THREE.BufferGeometry }[] = [];

function buildHead(glasses: boolean) {
  const C = HEAD_C;
  const p = new Parts();
  p.add(new THREE.SphereGeometry(0.85, 22, 16).scale(1.15, 0.95, 1), BLUE, v3(0, C, 0));
  p.add(new THREE.SphereGeometry(0.55, 18, 12).scale(1.2, 0.72, 0.95), MUZZLE, v3(0, C - 0.3, 0.55));
  for (const s of [-1, 1]) {
    // Little curled golden horns and soft teal ear fins.
    p.add(new THREE.ConeGeometry(0.14, 0.55, 8).translate(0, 0.27, 0), GOLD, v3(s * 0.42, C + 0.62, -0.12), new THREE.Euler(-0.45, 0, -s * 0.45));
    p.add(new THREE.ConeGeometry(0.2, 0.62, 8).scale(1, 1, 0.35).translate(0, 0.3, 0), TEAL, v3(s * 0.9, C + 0.05, -0.15), new THREE.Euler(0, 0, -s * 1.2));
    // Cheek tufts.
    p.add(new THREE.ConeGeometry(0.13, 0.4, 6).translate(0, 0.2, 0), TEAL, v3(s * 0.8, C - 0.35, 0.05), new THREE.Euler(0.3, 0, -s * 1.9));
  }
  for (let i = 0; i < 3; i++) {
    p.add(new THREE.ConeGeometry(0.13 - i * 0.02, 0.36, 6).translate(0, 0.18, 0), TEAL, v3(0, C + 0.72 - i * 0.22, -0.35 - i * 0.28), new THREE.Euler(-0.7 - i * 0.45, 0, 0));
  }
  const toonGeo = gradeByHeight(p.merge(), 0.1, 1.9);

  const f = new Parts();
  for (const s of [-1, 1]) {
    const ex = s * 0.36;
    const ey = C + 0.17;
    const ez = 0.72;
    f.add(new THREE.SphereGeometry(0.21, 16, 12).scale(0.82, 1.08, 0.5), INKY, v3(ex, ey, ez));
    f.add(new THREE.SphereGeometry(0.075, 10, 8), 0xffffff, v3(ex - 0.05, ey + 0.09, ez + 0.08));
    f.add(new THREE.SphereGeometry(0.035, 8, 6), 0xffffff, v3(ex + 0.06, ey - 0.06, ez + 0.08));
    f.add(new THREE.CircleGeometry(0.12, 14), PINK, v3(s * 0.6, C - 0.1, 0.62), undefined, v3(s * 1.8, C - 0.1, 4.6));
    f.add(new THREE.SphereGeometry(0.045, 6, 4), INKY, v3(s * 0.15, C - 0.18, 1.05));
    if (glasses) f.add(new THREE.TorusGeometry(0.26, 0.035, 6, 22), GOLD, v3(ex, ey, ez + 0.1), undefined, v3(ex * 1.4, ey + 0.4, 5));
  }
  if (glasses) f.add(new THREE.TorusGeometry(0.1, 0.03, 5, 10, Math.PI), GOLD, v3(0, C + 0.2, 0.86));
  f.add(new THREE.RingGeometry(0.09, 0.14, 14, 1, Math.PI * 1.1, Math.PI * 0.8), INKY, v3(0, C - 0.33, 1.02), undefined, v3(0, C + 0.4, 4));
  f.add(new THREE.ConeGeometry(0.05, 0.12, 4).rotateX(Math.PI), 0xffffff, v3(0.1, C - 0.47, 0.98));
  const faceGeo = f.merge();
  for (const g of [toonGeo, faceGeo]) g.userData.shared = true;
  return { toon: toonGeo, face: faceGeo };
}

let headCount = 0;

/** A balaur head with its own word, origin at its chin; every other head wears round golden reading glasses. */
export function makeHead(): Model {
  const variant = headCount++ % 2;
  const geos = (headGeos[variant] ??= buildHead(variant === 1));
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  // Pivot at the head centre, tipped up a little so the face reads from the high camera.
  const head = new THREE.Group();
  head.position.y = HEAD_C;
  body.add(head);
  const tilt = new THREE.Group();
  tilt.position.y = -HEAD_C;
  tilt.rotation.x = -0.32;
  head.add(tilt);
  tilt.add(new THREE.Mesh(geos.toon, vcToon()), new THREE.Mesh(geos.face, vcFlat()));
  const phase = Math.random() * 10;
  const sq = squash(body);
  const model: Model & { height: number } = {
    root,
    radius: 1.0,
    height: 2.0,
    color: BLUE,
    hit: sq.hit,
    animate(dt, t) {
      head.rotation.z = Math.sin(t * 1.8 + phase) * 0.14;
      head.rotation.y = Math.sin(t * 1.1 + phase) * 0.2;
      head.rotation.x = Math.sin(t * 1.4 + phase * 1.3) * 0.06;
      sq.step(dt);
    },
  };
  return model;
}

// ---- body ---------------------------------------------------------------------------------------------------------

/** Two fanned book pages and a cover, bent like an open book, as one mesh extending along +x from the spine. */
function wingGeometry(len: number, tall: number) {
  const sheets: THREE.BufferGeometry[] = [];
  const SEG = 16;
  for (let k = 0; k < 4; k++) {
    const cover = k === 3;
    const L = len * (cover ? 1.04 : 1 - k * 0.05);
    const g = new THREE.PlaneGeometry(1, 1, SEG, 2);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) + 0.5; // 0 at the spine, 1 at the tip
      const v = pos.getY(i) + 0.5;
      // Wing outline: the top edge sweeps up to the tip, the bottom edge is scalloped like a dragon wing.
      const top = tall * (0.62 + 0.38 * Math.sin(u * Math.PI * 0.5));
      const bottom = -tall * (0.32 - 0.12 * u) + Math.abs(Math.sin(u * Math.PI * 2.5)) * tall * 0.16 * u;
      const y = bottom + (top - bottom) * v;
      // Pages bulge forward away from the spine and curl back at the tip.
      const z = Math.sin(u * Math.PI) * 0.35 * (1 - k * 0.15) - u * u * 0.3;
      pos.setXYZ(i, u * L, y, z);
      uv.setX(i, cover ? COVER_U0 + u * (1 - COVER_U0) : u * PAGE_U);
    }
    // Fan the sheets back about the spine, the cover furthest back.
    g.rotateY(k * 0.12);
    g.translate(0, 0, -k * 0.03);
    g.computeVertexNormals();
    sheets.push(g);
  }
  const g = mergeGeometries(sheets)!;
  for (const s of sheets) s.dispose();
  return g;
}

/** The balaur's body: sat on the floor hugging a book, page wings, a scroll tail and a neck up to each head (x, y). */
export function makeBalaurBody(heads: { x: number; y: number }[]): Model {
  const root = new THREE.Group();
  const maxX = Math.max(0, ...heads.map((h) => Math.abs(h.x)));
  const maxY = Math.max(0, ...heads.map((h) => h.y));
  const span = Math.max(2.3, maxX * 0.6);
  const TZ = -0.9; // torso centre, behind the heads
  const TY = 1.7;

  const p = new Parts();
  p.add(new THREE.SphereGeometry(1, 28, 20).scale(span, 1.65, 1.35), BLUE, v3(0, TY, TZ));
  p.add(new THREE.SphereGeometry(1, 22, 14).scale(span * 0.7, 1.3, 0.75), CREAM, v3(0, TY - 0.15, TZ + 0.68));
  for (const s of [-1, 1]) {
    const lx = s * span * 0.72;
    p.add(new THREE.SphereGeometry(0.8, 16, 12).scale(1, 0.85, 1.1), BLUE, v3(lx, 0.62, TZ + 0.45));
    p.add(new THREE.SphereGeometry(0.48, 14, 10).scale(1.25, 0.55, 1.4), BLUE, v3(lx, 0.22, TZ + 1.2));
    for (let c = -1; c <= 1; c++) p.add(new THREE.SphereGeometry(0.13, 8, 6).scale(1, 0.8, 1.2), CREAM, v3(lx + c * 0.24, 0.17, TZ + 1.85));
    // Stubby arms wrapped round the book.
    p.add(new THREE.SphereGeometry(0.34, 12, 10).scale(1, 1, 2.0), BLUE, v3(s * span * 0.62, TY + 0.2, TZ + 1.25), new THREE.Euler(0.5, -s * 0.6, 0));
    p.add(new THREE.SphereGeometry(0.28, 10, 8), BLUE, v3(s * 0.62, TY + 0.15, TZ + 1.95));
  }
  // The book it hugs: red cover, cream pages, gold clasp.
  const tilt = new THREE.Euler(-0.55, 0, 0);
  p.add(new THREE.BoxGeometry(1.5, 1.15, 0.36), RED, v3(0, TY + 0.05, TZ + 1.7), tilt);
  p.add(new THREE.BoxGeometry(1.42, 1.05, 0.28).translate(0.06, 0, 0), CREAM, v3(0, TY + 0.05, TZ + 1.7), tilt);
  p.add(new THREE.TorusGeometry(0.22, 0.05, 6, 16), GOLD, v3(0, TY + 0.2, TZ + 1.9), tilt);
  p.add(new THREE.SphereGeometry(0.1, 8, 6), GOLD, v3(0, TY + 0.2, TZ + 1.9));
  // Soft spikes down the back.
  for (let i = 0; i < 6; i++) {
    const a = 0.5 + i * 0.32;
    const at = v3(0, TY + 1.62 * Math.cos(a), TZ - 1.3 * Math.sin(a));
    p.add(new THREE.ConeGeometry(0.22 - i * 0.015, 0.55, 8).translate(0, 0.25, 0), TEAL, at, new THREE.Euler(-a, 0, 0));
  }
  // A neck up to each head: from the shoulders, up and out, into the back of the head.
  for (const h of heads) {
    const from = v3(h.x * 0.3, TY + 0.9, TZ + 0.1);
    const to = v3(h.x, h.y + 0.75, 0.15);
    const mid = v3(h.x * 0.55, Math.max(from.y, to.y) + 1.1, (from.z + to.z) / 2 - 0.5);
    p.raw(taperedTube(new THREE.QuadraticBezierCurve3(from, mid, to), 0.55, 0.42, BLUE));
  }
  const bodyGeo = gradeByHeight(p.merge(), 0, maxY + 1.5, 0.72, 1.1);
  const bodyMesh = meshVC(root, bodyGeo);
  const blob = shadowBlob(span * 1.25, 0.35);
  blob.geometry.userData.shared = true; // the blob plane is shared by every contact shadow
  blob.position.z = TZ + 0.2;
  blob.scale.z *= 0.8;
  root.add(blob);

  // Page wings behind the shoulders. The outer group mirrors the left one; the inner group flaps about the spine.
  const wings: THREE.Group[] = [];
  const wingGeo = wingGeometry(span * 1.3 + 1.6, 3.0);
  for (const s of [-1, 1]) {
    const side = new THREE.Group();
    side.position.set(s * span * 0.3, TY + 1.3, TZ - 0.7);
    side.scale.x = s;
    const flap = new THREE.Group();
    flap.rotation.set(-0.75, 0.3, 0.3);
    flap.add(new THREE.Mesh(wingGeo, pageMaterial()));
    side.add(flap);
    root.add(side);
    wings.push(flap);
  }

  // A tail curling round the right side on the floor, ending in a rolled-up scroll with golden knobs.
  const tail = new THREE.Group();
  tail.position.set(0.3, 0.5, TZ - 1.1);
  root.add(tail);
  const tp = new Parts();
  const curve = new THREE.CatmullRomCurve3([
    v3(0, 0, 0),
    v3(1.2, -0.12, -0.5),
    v3(span + 0.9, -0.2, 0.0),
    v3(span + 1.5, -0.18, 1.3),
    v3(span + 1.0, -0.15, 2.3),
  ]);
  tp.raw(taperedTube(curve, 0.55, 0.2, BLUE, CREAM, 28, 10));
  const end = curve.getPointAt(1);
  const dir = curve.getTangentAt(1);
  const scrollAt = end.clone().addScaledVector(dir, 0.15);
  scrollAt.y = -0.18;
  const across = Math.atan2(dir.x, dir.z);
  tp.add(new THREE.CylinderGeometry(0.3, 0.3, 1.3, 16).rotateZ(Math.PI / 2), CREAM, scrollAt, new THREE.Euler(0, across, 0));
  for (const s of [-1, 1]) {
    const knob = v3(s * 0.75, 0, 0).applyEuler(new THREE.Euler(0, across, 0)).add(scrollAt);
    tp.add(new THREE.SphereGeometry(0.16, 10, 8), GOLD, knob);
  }
  // The unrolled bit of the scroll, a curved sheet running back along the tail.
  tp.add(new THREE.BoxGeometry(1.1, 0.04, 0.7).translate(0, 0, -0.35), CREAM, scrollAt.clone().add(v3(0, 0.26, 0)), new THREE.Euler(0.25, across, 0));
  meshVC(tail, tp.merge());

  const sq = squash(bodyMesh);
  const model: Model & { height: number } = {
    root,
    radius: span,
    height: Math.max(3.4, maxY + 2.0),
    color: BLUE,
    hit: sq.hit,
    animate(dt, t) {
      // A slow book-like flap: the pages swing about the spine and lift a little.
      const flap = Math.sin(t * 2.6);
      for (const w of wings) {
        w.rotation.y = 0.3 + flap * 0.32;
        w.rotation.z = 0.3 + flap * 0.1;
      }
      tail.rotation.y = Math.sin(t * 1.3) * 0.12;
      sq.step(dt);
    },
  };
  return model;
}
