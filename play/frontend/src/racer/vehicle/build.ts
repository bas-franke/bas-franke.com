// Geometry helpers for the pod models. Every painted part ends up in the same "surface" layout (non-indexed
// position/normal/uv/color/aMat) so a whole engine or cockpit merges into one mesh with one material: colour, metalness
// and roughness are per face, carried in vertex attributes. Glow parts use the "glow" layout (color + aKind).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** How a face is painted: linear colour, metalness, roughness. */
export interface Paint {
  c: THREE.Color;
  metal: number;
  rough: number;
}

export function paint(hex: THREE.ColorRepresentation, metal: number, rough: number): Paint {
  return { c: new THREE.Color(hex), metal, rough };
}

/** Superellipse cross-section: n = 2 is a circle, larger n gets boxier; sx/sy stretch it. */
export interface Section {
  n: number;
  sx: number;
  sy: number;
}

const se = (c: number, n: number) => Math.sign(c) * Math.pow(Math.abs(c), 2 / n);

/** Point on the section outline at angle `a` (0 = +x, pi/2 = +y) and radius r. */
export function sectionPoint(a: number, r: number, s: Section): [number, number] {
  return [r * s.sx * se(Math.cos(a), s.n), r * s.sy * se(Math.sin(a), s.n)];
}

type PaintFn = (angle: number, z: number, radius: number) => Paint;

export interface Band {
  /** Profile points [z, r] in order. Walking towards +z with r on the left makes the normal face outwards. */
  pts: [number, number][];
  paint: Paint | PaintFn;
}

/**
 * Lathe around the z axis with a superellipse section. Each band is a separate strip (hard edge between bands) painted
 * per face, so stripes come out sharp. The seam sits underneath. UVs are in metres (u around, v along the profile).
 * With `maxStep`, profile segments longer than that are split into more rings (so the skin can be dented smoothly).
 */
export function lathe(bands: Band[], segs: number, s: Section, maxStep = 0): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let vAcc = 0;
  for (const band of bands) {
    const pts: [number, number][] = [band.pts[0]];
    for (let j = 1; j < band.pts.length; j++) {
      const [z0, r0] = band.pts[j - 1];
      const [z1, r1] = band.pts[j];
      const n = maxStep > 0 ? Math.max(1, Math.ceil(Math.hypot(z1 - z0, r1 - r0) / maxStep)) : 1;
      for (let k = 1; k <= n; k++) pts.push([z0 + ((z1 - z0) * k) / n, r0 + ((r1 - r0) * k) / n]);
    }
    const rings = pts.length;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j < rings; j++) {
      const [z, r] = pts[j];
      if (j > 0) {
        const [pz, pr] = pts[j - 1];
        vAcc += Math.hypot(z - pz, r - pr);
      }
      for (let i = 0; i <= segs; i++) {
        const a = -Math.PI / 2 + (i / segs) * Math.PI * 2;
        const [x, y] = sectionPoint(a, r, s);
        pos.push(x, y, z);
        uv.push((i / segs) * Math.PI * 2 * Math.max(0.3, r), vAcc);
      }
    }
    for (let j = 0; j < rings - 1; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * (segs + 1) + i;
        const b = a + segs + 1;
        const c = b + 1;
        const d = a + 1;
        idx.push(a, d, b, d, c, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const p = band.paint;
    parts.push(
      surface(
        g,
        (centre) => {
          if (typeof p !== 'function') return p;
          const a = Math.atan2(centre.y / s.sy, centre.x / s.sx);
          return p(a, centre.z, Math.hypot(centre.x, centre.y));
        },
        undefined,
        1,
        true,
      ),
    );
    g.dispose();
  }
  return merge(parts);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Converts a geometry to the surface layout, painting each triangle (by its centre, in the geometry's own space) and
 * then applying `m`. UVs are multiplied by `uvScale` (primitives come with 0..1 UVs; the grime texture wants metres).
 * With `quads`, triangles are painted in pairs (lathe quads) so stripe edges follow the grid instead of zigzagging.
 */
export function surface(
  geo: THREE.BufferGeometry,
  p: Paint | ((centre: THREE.Vector3) => Paint),
  m?: THREE.Matrix4,
  uvScale = 1,
  quads = false,
): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  const pos = g.attributes.position;
  const n = pos.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  else if (uvScale !== 1) {
    const uv = g.attributes.uv;
    for (let i = 0; i < n; i++) uv.setXY(i, uv.getX(i) * uvScale, uv.getY(i) * uvScale);
  }
  const col = new Float32Array(n * 3);
  const mat = new Float32Array(n * 2);
  const step = quads ? 6 : 3;
  for (let t = 0; t < n; t += step) {
    let pt: Paint;
    if (typeof p === 'function') {
      _a.fromBufferAttribute(pos, t);
      _b.fromBufferAttribute(pos, t + 1);
      _c.fromBufferAttribute(pos, t + 2);
      _a.add(_b).add(_c);
      // A lathe quad is (a, d, b) + (d, c, b): its fourth corner is vertex t + 4.
      if (quads) _a.add(_b.fromBufferAttribute(pos, t + 4)).multiplyScalar(1 / 4);
      else _a.multiplyScalar(1 / 3);
      pt = p(_a);
    } else pt = p;
    for (let k = t; k < Math.min(n, t + step); k++) {
      col[k * 3] = pt.c.r;
      col[k * 3 + 1] = pt.c.g;
      col[k * 3 + 2] = pt.c.b;
      mat[k * 2] = pt.metal;
      mat[k * 2 + 1] = pt.rough;
    }
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aMat', new THREE.Float32BufferAttribute(mat, 2));
  if (m) g.applyMatrix4(m);
  return g;
}

/** Where a shell panel is: its section, angles a0..a1 (round the section), z0..z1 (along it) and radius r. */
export interface PanelSpan {
  a0: number;
  a1: number;
  z0: number;
  z1: number;
  r: number;
}

/**
 * A curved plate lying on a lathe skin (armour): the patch of the section outline over `span`, `thick` metres thick
 * (growing outwards), closed on every edge, subdivided na x nz so it dents and buckles smoothly. Painted per face by
 * where it is on the plate (u across a0..a1, v along z0..z1, both 0..1), already in the surface layout. With `bulge`
 * it gets a relative morph target: every vertex pushed out along the skin's normal by bulge(u, v) metres (the plate
 * buckling), so a dent in the base geometry and the buckle add up. `out` receives each vertex's (u, v) when given.
 */
export function shellPanel(
  s: Section,
  span: PanelSpan,
  thick: number,
  na: number,
  nz: number,
  p: (u: number, v: number) => Paint,
  bulge?: (u: number, v: number) => number,
): THREE.BufferGeometry {
  const { a0, a1, z0, z1, r } = span;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvs: number[] = [];
  const col: number[] = [];
  const mat: number[] = [];
  const del: number[] = [];
  const at = (u: number, layer: number) => {
    const [x, y] = sectionPoint(a0 + (a1 - a0) * u, r + layer * thick, s);
    return [x, y];
  };
  /** Outward skin normal at u: the outline's tangent turned a quarter (outline runs anticlockwise seen from +z). */
  const skinN = (u: number): [number, number] => {
    const e = 0.002;
    const [x0, y0] = at(u - e, 0);
    const [x1, y1] = at(u + e, 0);
    const l = Math.hypot(x1 - x0, y1 - y0) || 1;
    return [(y1 - y0) / l, -(x1 - x0) / l];
  };
  const width = Math.abs(a1 - a0) * r;
  // One vertex: (u, v) on the plate, layer 0 inside / 1 outside, its normal, and the face's paint.
  const vert = (u: number, v: number, layer: number, n: [number, number, number], pt: Paint) => {
    const [x, y] = at(u, layer);
    pos.push(x, y, z0 + (z1 - z0) * v);
    nrm.push(...n);
    uvs.push(u * width, v * (z1 - z0));
    col.push(pt.c.r, pt.c.g, pt.c.b);
    mat.push(pt.metal, pt.rough);
    if (bulge) {
      const [nx, ny] = skinN(u);
      const b = bulge(u, v);
      del.push(nx * b, ny * b, 0);
    }
  };
  type V = [number, number, number, [number, number, number]];
  /** A quad (corners in order round it), wound so its face points along `face`. */
  const quad = (q: V[], face: [number, number, number], pt: Paint) => {
    const pts = q.map(([u, v, l]) => {
      const [x, y] = at(u, l);
      return new THREE.Vector3(x, y, z0 + (z1 - z0) * v);
    });
    const n = _b.copy(pts[1]).sub(pts[0]).cross(_c.copy(pts[2]).sub(pts[0]));
    const flip = n.x * face[0] + n.y * face[1] + n.z * face[2] < 0;
    const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const k of order) vert(q[k][0], q[k][1], q[k][2], q[k][3], pt);
  };
  const smooth = (u: number, sign: number): [number, number, number] => {
    const [x, y] = skinN(u);
    return [x * sign, y * sign, 0];
  };
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nz; j++) {
      const [u0, u1, v0, v1] = [i / na, (i + 1) / na, j / nz, (j + 1) / nz];
      const pt = p((u0 + u1) / 2, (v0 + v1) / 2);
      const mid = smooth((u0 + u1) / 2, 1);
      quad([[u0, v0, 1, smooth(u0, 1)], [u1, v0, 1, smooth(u1, 1)], [u1, v1, 1, smooth(u1, 1)], [u0, v1, 1, smooth(u0, 1)]], mid, pt);
      quad([[u0, v0, 0, smooth(u0, -1)], [u1, v0, 0, smooth(u1, -1)], [u1, v1, 0, smooth(u1, -1)], [u0, v1, 0, smooth(u0, -1)]], [-mid[0], -mid[1], 0], pt);
    }
  }
  // The rims: front and back edges (normal along z), and the two side edges (normal along the outline).
  for (let i = 0; i < na; i++) {
    const [u0, u1] = [i / na, (i + 1) / na];
    for (const [v, sz] of [[0, -1], [1, 1]] as const) {
      const n: [number, number, number] = [0, 0, sz];
      quad([[u0, v, 0, n], [u1, v, 0, n], [u1, v, 1, n], [u0, v, 1, n]], n, p((u0 + u1) / 2, v));
    }
  }
  for (let j = 0; j < nz; j++) {
    const [v0, v1] = [j / nz, (j + 1) / nz];
    for (const [u, su] of [[0, -1], [1, 1]] as const) {
      const [x0, y0] = at(u - 0.002 * su, 0);
      const [x1, y1] = at(u, 0);
      const l = Math.hypot(x1 - x0, y1 - y0) || 1;
      const n: [number, number, number] = [(x1 - x0) / l, (y1 - y0) / l, 0];
      quad([[u, v0, 0, n], [u, v1, 0, n], [u, v1, 1, n], [u, v0, 1, n]], n, p(u, (v0 + v1) / 2));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aMat', new THREE.Float32BufferAttribute(mat, 2));
  if (bulge) {
    g.morphAttributes.position = [new THREE.Float32BufferAttribute(del, 3)];
    g.morphTargetsRelative = true;
  }
  return g;
}

/**
 * Gives a merged geometry made of equal pieces of `per` vertices after a `lead` of other vertices (a fan's hub, then its
 * blades) a relative morph target: `delta(position, piece)` is the offset of each vertex (piece -1 for the lead).
 */
export function morphBy(g: THREE.BufferGeometry, lead: number, per: number, delta: (p: THREE.Vector3, piece: number) => THREE.Vector3) {
  const pos = g.attributes.position;
  const out = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const d = delta(p, i < lead ? -1 : Math.floor((i - lead) / per));
    out[i * 3] = d.x;
    out[i * 3 + 1] = d.y;
    out[i * 3 + 2] = d.z;
  }
  g.morphAttributes.position = [new THREE.Float32BufferAttribute(out, 3)];
  g.morphTargetsRelative = true;
  return g;
}

/** A copy without morph targets (to merge with geometry that has none). */
export function unmorphed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = g.clone();
  c.morphAttributes = {};
  c.morphTargetsRelative = false;
  return c;
}

/** Glow layout: colour (linear, can be > 1 for HDR) and a kind the glow shader switches on. */
export function glow(geo: THREE.BufferGeometry, color: THREE.Color, kind: number, m?: THREE.Matrix4): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const k = new Float32Array(n).fill(kind);
  for (let i = 0; i < n; i++) {
    col[i * 3] = color.r;
    col[i * 3 + 1] = color.g;
    col[i * 3 + 2] = color.b;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(k, 1));
  if (m) g.applyMatrix4(m);
  return g;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('pod: geometry merge failed (attribute mismatch)');
  for (const p of parts) p.dispose();
  return g;
}

/** Mirror a non-indexed geometry across x (= the other side), fixing the winding so faces still point outwards. */
export function mirrorX(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.clone();
  g.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  for (const name of Object.keys(g.attributes)) {
    const at = g.attributes[name] as THREE.BufferAttribute;
    const s = at.itemSize;
    const arr = at.array as Float32Array;
    for (let t = 0; t < at.count; t += 3) {
      for (let c = 0; c < s; c++) {
        const i1 = (t + 1) * s + c;
        const i2 = (t + 2) * s + c;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
  }
  return g;
}

/** Matrix from a position, Euler rotation and scale. */
export function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** Matrix that maps the unit Y axis (a CylinderGeometry) onto the segment a→b, centred between them. */
export function along(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  const d = b.clone().sub(a);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, len, 1));
}

/**
 * A blade from a 2D outline: outline x maps to `ax`, outline y to `ay`, and the thickness runs along ax × ay. Used
 * for claws, fins and flaps.
 */
export function blade(outline: [number, number][], thickness: number, ax: THREE.Vector3, ay: THREE.Vector3, origin: THREE.Vector3): { geo: THREE.BufferGeometry; m: THREE.Matrix4 } {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 4 });
  geo.translate(0, 0, -thickness / 2);
  const az = ax.clone().cross(ay).normalize();
  const m = new THREE.Matrix4().makeBasis(ax.clone().normalize(), ay.clone().normalize(), az).setPosition(origin);
  return { geo, m };
}
