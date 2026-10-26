// Low-poly rock shapes for the skyline: mesas, buttes, needle spires and natural arches. Every shape is a stack of
// rings (closed outlines) joined into faceted quads and written into one shared RockBuilder, so the whole skyline is a
// single merged geometry. Shapes are chunky on purpose: the strata shader (landmarkMaterial.ts) does the detail.

import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Accumulates faceted triangles (position, normal, colour) for one merged mesh. */
export class RockBuilder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  /** Vertex colour (linear) for everything added next: a per-rock tint the shader multiplies in. */
  tint: [number, number, number] = [1, 1, 1];

  private push(p: THREE.Vector3, n: THREE.Vector3) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.col.push(this.tint[0], this.tint[1], this.tint[2]);
  }

  /**
   * Joins consecutive rings (same vertex count) into a closed surface; optionally caps the last ring flat. `smooth`
   * blends each corner's normal from the quad's own (0: crisp facets) to the average of the quads around it (1).
   */
  rings(rings: THREE.Vector3[][], capTop = false, smooth = 0) {
    const K = rings.length - 1;
    const n = rings[0].length;
    // Quad normals, oriented away from the local centre of the two rings.
    const qn: THREE.Vector3[][] = [];
    const centre = new THREE.Vector3();
    for (let k = 0; k < K; k++) {
      const A = rings[k];
      const B = rings[k + 1];
      centre.set(0, 0, 0);
      for (const p of A) centre.add(p);
      for (const p of B) centre.add(p);
      centre.multiplyScalar(1 / (2 * n));
      const row: THREE.Vector3[] = [];
      for (let j = 0; j < n; j++) {
        const a0 = A[j], a1 = A[(j + 1) % n], b0 = B[j], b1 = B[(j + 1) % n];
        const nn = new THREE.Vector3().crossVectors(_a.subVectors(b1, a0), _b.subVectors(a1, b0));
        if (nn.lengthSq() > 1e-10) nn.normalize();
        _c.copy(a0).add(a1).add(b0).add(b1).multiplyScalar(0.25).sub(centre);
        if (nn.dot(_c) < 0) nn.negate();
        row.push(nn);
      }
      qn.push(row);
    }
    const corner = (k: number, j: number, own: THREE.Vector3, out: THREE.Vector3) => {
      if (smooth <= 0) return out.copy(own);
      out.set(0, 0, 0);
      for (const kk of [k - 1, k]) {
        if (kk < 0 || kk >= K) continue;
        out.add(qn[kk][(j - 1 + n) % n]).add(qn[kk][j % n]);
      }
      return out.normalize().lerp(own, 1 - smooth).normalize();
    };
    const n0 = new THREE.Vector3(), n1 = new THREE.Vector3(), n2 = new THREE.Vector3(), n3 = new THREE.Vector3();
    for (let k = 0; k < K; k++) {
      const A = rings[k];
      const B = rings[k + 1];
      for (let j = 0; j < n; j++) {
        const own = qn[k][j];
        if (own.lengthSq() < 0.5) continue;
        const j1 = (j + 1) % n;
        corner(k, j, own, n0);
        corner(k, j + 1, own, n1);
        corner(k + 1, j, own, n2);
        corner(k + 1, j + 1, own, n3);
        // Winding so the geometric normal agrees with `own`.
        _n.crossVectors(_a.subVectors(B[j1], A[j]), _b.subVectors(A[j1], A[j]));
        if (_n.dot(own) >= 0) {
          this.push(A[j], n0), this.push(B[j1], n3), this.push(A[j1], n1);
          this.push(A[j], n0), this.push(B[j], n2), this.push(B[j1], n3);
        } else {
          this.push(A[j], n0), this.push(A[j1], n1), this.push(B[j1], n3);
          this.push(A[j], n0), this.push(B[j1], n3), this.push(B[j], n2);
        }
      }
    }
    if (capTop) this.cap(rings[rings.length - 1]);
  }

  /** Fan cap over a ring, normal facing up. */
  cap(ring: THREE.Vector3[]) {
    const c = new THREE.Vector3();
    for (const p of ring) c.add(p);
    c.multiplyScalar(1 / ring.length);
    const n = ring.length;
    for (let j = 0; j < n; j++) {
      const p = ring[j];
      const q = ring[(j + 1) % n];
      _a.subVectors(q, c);
      _b.subVectors(p, c);
      _n.crossVectors(_a, _b);
      if (_n.lengthSq() < 1e-10) continue;
      _n.normalize();
      if (_n.y < 0) {
        _n.negate();
        this.push(c, _n), this.push(p, _n), this.push(q, _n);
      } else {
        this.push(c, _n), this.push(q, _n), this.push(p, _n);
      }
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

type Rand = () => number;

/** Closed, lumpy outline: unit-ish radii per angle with a few random harmonics (bays and promontories). */
function outline(r: Rand, seg: number, lumpy: number): number[] {
  const harm = [2, 3, 5].map((k) => ({ k, a: (r() - 0.3) * lumpy / k * 1.6, p: r() * Math.PI * 2 }));
  const out: number[] = [];
  for (let j = 0; j < seg; j++) {
    const t = (j / seg) * Math.PI * 2;
    let v = 1;
    for (const h of harm) v += h.a * Math.sin(h.k * t + h.p);
    out.push(Math.max(0.45, v * (1 + (r() - 0.5) * lumpy * 0.35)));
  }
  return out;
}

/** Smoothed random per-angle noise in -1..1: vertical erosion grooves that run the height of a cliff band. */
function grooves(r: Rand, seg: number): number[] {
  const raw = Array.from({ length: seg }, () => r() * 2 - 1);
  // Mostly flat faces with the odd deep notch: buttresses and gullies rather than a uniformly crinkled drum.
  return raw.map((v, j) => {
    const s = (v * 2 + raw[(j + 1) % seg] * 0.5 + raw[(j - 1 + seg) % seg] * 0.5) / 3;
    return Math.sign(s) * Math.pow(Math.abs(s), 0.6);
  });
}

export interface MesaOpts {
  x: number;
  z: number;
  /** Ground level at the foot; the shape continues 60 m below it so it never floats. */
  ground: number;
  height: number;
  radius: number;
  /** Stretch of the outline along `rot` (1 = round). */
  elong: number;
  rot: number;
  seg: number;
  /** 'mesa': wide and flat; 'butte': narrower and taller with a big talus apron. */
  kind: 'mesa' | 'butte';
}

/** Mesa or butte: a talus apron, two or three vertical cliff bands separated by inset ledges, and a flat top. */
export function addMesa(b: RockBuilder, r: Rand, o: MesaOpts) {
  const seg = o.seg;
  const base = outline(r, seg, o.kind === 'mesa' ? 0.5 : 0.35);
  const groove = grooves(r, seg);
  const cos = Math.cos(o.rot);
  const sin = Math.sin(o.rot);
  const H = o.height;
  const talus = o.kind === 'butte' ? 1.42 : 1.22;
  const tH = H * (o.kind === 'butte' ? 0.24 : 0.17);
  // [height above ground (m), radius scale, groove depth, per-vertex jitter, height jitter (m), band lumps]
  type Ring = [number, number, number, number, number, number[] | null];
  const prof: Ring[] = [
    [-60, talus + 0.55, 0, 0.06, 0, null],
    [-12, talus + 0.15, 0.02, 0.08, 0, null],
    [0, talus, 0.02, 0.08, 0, null],
    // Concave scree apron: shallow at the foot, steepening up to the cliff.
    [tH * 0.35, 1 + (talus - 1) * 0.55, 0.04, 0.07, tH * 0.15, null],
    [tH * 0.75, 1 + (talus - 1) * 0.22, 0.08, 0.05, tH * 0.12, null],
    [tH, 1.04, 0.12, 0.03, tH * 0.08, null],
  ];
  // Cliff bands with ledges between them. Each band gets its own lumps, constant over its height, so the faces stay
  // vertical while the ledges come out uneven: wide shelves in places, flush cliff in others.
  const bands = 2 + Math.floor(r() * 2);
  let y = tH + 1;
  let s = 1.02;
  for (let i = 0; i < bands; i++) {
    const top = i === bands - 1 ? H : y + (H - y) * (0.3 + r() * 0.35);
    const lumps = Array.from({ length: seg }, () => 1 - Math.pow(r(), 3) * 0.22);
    prof.push([y + 0.5, s, 0.2, 0.025, 0, lumps]);
    prof.push([top - 2, s * (0.97 + r() * 0.02), 0.22, 0.025, 0, lumps]);
    if (i < bands - 1) {
      s *= 0.84 + r() * 0.1;
      prof.push([top - 0.5, s * 1.03, 0.08, 0.04, 0, null]);
    } else {
      prof.push([top, s * 0.95, 0.06, 0.03, 0, lumps]);
    }
    y = top;
  }
  const rings: THREE.Vector3[][] = [];
  for (const [h, scale, g, jit, hj, lumps] of prof) {
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j < seg; j++) {
      const t = (j / seg) * Math.PI * 2;
      const rad = o.radius * base[j] * scale * (lumps ? lumps[j] : 1) * (1 + groove[j] * g + (r() - 0.5) * jit * 2);
      const lx = Math.cos(t) * rad * o.elong;
      const lz = Math.sin(t) * rad;
      ring.push(new THREE.Vector3(o.x + lx * cos - lz * sin, o.ground + h + (r() - 0.5) * hj * 2, o.z + lx * sin + lz * cos));
    }
    rings.push(ring);
  }
  b.rings(rings, true);
}

export interface SpireOpts {
  x: number;
  z: number;
  ground: number;
  height: number;
  /** Radius of the column near its base (the talus mound is wider). */
  radius: number;
  seg: number;
}

/**
 * Needle spire / hoodoo: a talus mound, then a tall column of blocky drums that wander off-axis, narrow towards the
 * top and often end in a wider caprock.
 */
export function addSpire(b: RockBuilder, r: Rand, o: SpireOpts) {
  const seg = o.seg;
  const base = outline(r, seg, 0.3);
  const groove = grooves(r, seg);
  const H = o.height;
  const R = o.radius;
  const rings: THREE.Vector3[][] = [];
  const leanX = (r() - 0.5) * 0.08;
  const leanZ = (r() - 0.5) * 0.08;
  const ring = (h: number, rad: number, g: number, jit: number, rot: number, ox = 0, oz = 0) => {
    const out: THREE.Vector3[] = [];
    for (let j = 0; j < seg; j++) {
      const t = (j / seg) * Math.PI * 2 + rot;
      const rr = rad * base[j] * (1 + groove[j] * g + (r() - 0.5) * jit * 2);
      out.push(new THREE.Vector3(o.x + ox + Math.cos(t) * rr, o.ground + h, o.z + oz + Math.sin(t) * rr));
    }
    rings.push(out);
  };
  ring(-60, R * 3.8, 0, 0.06, 0);
  ring(-12, R * 2.7, 0.02, 0.08, 0);
  ring(0, R * 2.35, 0.03, 0.1, 0);
  ring(H * 0.04, R * 1.7, 0.06, 0.08, 0);
  ring(H * 0.09, R * 1.3, 0.12, 0.05, 0);
  // The column: continuous taper with slow swelling and pinching, a few sharp joints where it steps in, and often a
  // wider caprock on top (hoodoo). Grooves are constant up the column, so it reads as fluted.
  const n = 9 + Math.floor(r() * 4);
  const cap = r() < 0.5;
  const ph = r() * Math.PI * 2;
  const freq = 1.5 + r() * 2;
  let wob = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const h = H * (0.1 + 0.9 * t);
    let rad = R * (1 - 0.5 * t) * (1 + 0.16 * Math.sin(t * freq * Math.PI * 2 + ph));
    if (cap && i >= n - 1) rad *= 1.3;
    wob += (r() - 0.5) * 0.12;
    const ox = leanX * h;
    const oz = leanZ * h;
    // A joint: a ring just above the previous one but stepped in or out, giving a small ledge.
    if (i > 0 && r() < 0.35) ring(h - H * 0.012, rad * (1.08 + r() * 0.08), 0.18, 0.03, wob, ox, oz);
    ring(h, rad, 0.2, 0.03, wob, ox, oz);
  }
  b.rings(rings, true, 0.45);
}

export interface ArchOpts {
  /** Ground point under the middle of the arch. */
  centre: THREE.Vector3;
  /** Unit horizontal vector across the opening (foot to foot), and the arch plane normal (through the opening). */
  across: THREE.Vector3;
  through: THREE.Vector3;
  /** Distance between the centres of the two feet. */
  span: number;
  /** Clearance under the middle of the lintel, above `centre`. */
  clear: number;
  /** Rock thickness in the arch plane at the feet and at the crown; depth through the opening at feet and crown. */
  legThick: number;
  crownThick: number;
  legDepth: number;
  crownDepth: number;
  /** Number of rings along the arch and around its cross-section. */
  steps: number;
  around: number;
  /** Blocky: a boxier cross-section with crisp edges and a flatter, slab-like crown on steep shoulders. */
  blocky?: boolean;
}

/**
 * Natural arch: a blocky cross-section swept along a path that rises from below ground on one side, curves over and
 * plunges back down on the other. The legs are thick and the crown thinner, with lumps so it reads as eroded rock.
 */
export function addArch(b: RockBuilder, r: Rand, o: ArchOpts) {
  const half = o.span / 2;
  const top = o.clear + o.crownThick / 2;
  const spring = top * (0.35 + r() * 0.1);
  const up = new THREE.Vector3(0, 1, 0);
  // Path in the arch plane: (u across, v up) with the thickness/depth blend w (0 at the feet, 1 at the crown).
  const path: [number, number, number][] = [];
  const legN = Math.max(3, Math.round(o.steps * 0.18));
  const arcN = Math.max(8, o.steps - legN * 2);
  for (let i = 0; i < legN; i++) {
    const t = i / legN;
    path.push([-half * (1 + 0.06 * (1 - t)), -60 + (spring + 60) * t, 0]);
  }
  for (let i = 0; i <= arcN; i++) {
    const a = Math.PI * (1 - i / arcN);
    // A slightly squared-off ellipse: flatter crown, steeper shoulders.
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const u = half * Math.sign(ca) * Math.pow(Math.abs(ca), o.blocky ? 0.7 : 0.85);
    const v = spring + (top - spring) * Math.pow(sa, o.blocky ? 0.4 : 0.7);
    path.push([u, v, sa]);
  }
  for (let i = 1; i <= legN; i++) {
    const t = i / legN;
    path.push([half * (1 + 0.06 * t), spring + (-60 - spring) * t, 0]);
  }
  const lump = Array.from({ length: path.length }, () => 1 + (r() - 0.5) * (o.blocky ? 0.1 : 0.18));
  const sect = Array.from({ length: o.around }, () => 1 + (r() - 0.5) * 0.16);
  const ex = o.blocky ? 0.25 : 0.55;
  const rings: THREE.Vector3[][] = [];
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const C = new THREE.Vector3();
  const P = (i: number, out: THREE.Vector3) => {
    const [u, v] = path[Math.min(path.length - 1, Math.max(0, i))];
    return out.copy(o.centre).addScaledVector(o.across, u).addScaledVector(up, v);
  };
  const prev = new THREE.Vector3();
  const next = new THREE.Vector3();
  for (let i = 0; i < path.length; i++) {
    const w = path[i][2];
    P(i - 1, prev);
    P(i + 1, next);
    T.subVectors(next, prev).normalize();
    N.crossVectors(o.through, T).normalize();
    P(i, C);
    const thick = THREE.MathUtils.lerp(o.legThick, o.crownThick, w) * lump[i];
    const depth = THREE.MathUtils.lerp(o.legDepth, o.crownDepth, w) * (2 - lump[i]);
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k < o.around; k++) {
      const a = (k / o.around) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Superellipse: a rounded box, so the arch has flat faces and blocky edges.
      const cx = Math.sign(ca) * Math.pow(Math.abs(ca), ex) * sect[k];
      const cz = Math.sign(sa) * Math.pow(Math.abs(sa), ex) * sect[(k + i) % o.around];
      ring.push(C.clone().addScaledVector(N, (cx * thick) / 2).addScaledVector(o.through, (cz * depth) / 2));
    }
    rings.push(ring);
  }
  b.rings(rings, false, o.blocky ? 0.25 : 0.8);
}

export interface BlockSpireOpts {
  x: number;
  z: number;
  ground: number;
  height: number;
  /** Half-width of the column near its base. */
  radius: number;
  /** Corners of the cross-section (4-7): few corners give flat, chiselled faces. */
  seg: number;
  /** Talus mound at the foot (scale of its radius; 0 = the column stands straight out of the ground). */
  talus?: number;
  /** How much the column narrows from foot to top (default 0.5). */
  taper?: number;
}

/**
 * Blocky sandstone column, the slender spires of the concept art: an irregular polygon (flat fracture faces, crisp
 * edges) stacked in drums of uneven height. Each drum keeps vertical faces; at every joint the next drum steps in,
 * shifts sideways a little and turns, so the column reads as fractured blocks stacked on each other, narrowing up to
 * a flat or caprocked top.
 */
export function addBlockSpire(b: RockBuilder, r: Rand, o: BlockSpireOpts) {
  const seg = Math.max(4, o.seg);
  const H = o.height;
  const R = o.radius;
  // Corner angles (jittered) and radii: an irregular, elongated polygon.
  const ang: number[] = [];
  for (let j = 0; j < seg; j++) ang.push(((j + (r() - 0.5) * 0.5) / seg) * Math.PI * 2);
  const elong = 1 + r() * 0.6;
  const rot = r() * Math.PI;
  const rings: THREE.Vector3[][] = [];
  let cx = o.x;
  let cz = o.z;
  const ring = (h: number, rad: number, mult: number[], turn: number) => {
    const out: THREE.Vector3[] = [];
    const c = Math.cos(rot + turn);
    const s = Math.sin(rot + turn);
    for (let j = 0; j < seg; j++) {
      const lx = Math.cos(ang[j]) * rad * mult[j] * elong;
      const lz = Math.sin(ang[j]) * rad * mult[j];
      out.push(new THREE.Vector3(cx + lx * c - lz * s, o.ground + h, cz + lx * s + lz * c));
    }
    rings.push(out);
  };
  const flat = new Array(seg).fill(1);
  const talus = o.talus ?? 1;
  if (talus > 0) {
    ring(-60, R * (1.6 + 1.4 * talus), flat, 0);
    ring(0, R * (1.3 + 0.9 * talus), flat, 0);
    ring(H * 0.04 * talus, R * (1.12 + 0.3 * talus), flat, 0);
  } else {
    ring(-60, R * 1.2, flat, 0);
  }
  const n = 4 + Math.floor(r() * 4);
  // Uneven drum heights: a few tall blocks and some short ones.
  const hs = Array.from({ length: n }, () => 0.4 + r());
  const sum = hs.reduce((a, v) => a + v, 0);
  const cap = r() < 0.35;
  let y = H * 0.05 * talus;
  let turn = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let rad = R * (1 - (o.taper ?? 0.5) * t) * (0.92 + r() * 0.16);
    if (cap && i === n - 1) rad = R * (0.75 + r() * 0.2);
    const mult = Array.from({ length: seg }, () => 0.8 + r() * 0.35);
    const top = y + ((H * 0.95 - H * 0.05 * talus) * hs[i]) / sum;
    // Joint: a narrow ledge, the drum above stepping in and turning a little.
    if (i > 0) ring(y, rad * 1.1, mult, turn);
    ring(y + 0.3, rad, mult, turn);
    ring(top, rad * (0.94 + r() * 0.05), mult, turn);
    y = top;
    turn += (r() - 0.5) * 0.35;
    cx += (r() - 0.5) * rad * 0.25;
    cz += (r() - 0.5) * rad * 0.25;
  }
  // A small broken crown on top.
  const crown = Array.from({ length: seg }, () => 0.6 + r() * 0.5);
  ring(y + H * 0.02, R * 0.32, crown, turn);
  b.rings(rings, true, 0);
}
