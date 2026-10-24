// Small geometry kit for the sky city and airships: a bin that merges many painted primitives into one draw call,
// helpers to place boxes between two points and along curves, the layered sandstone column generator used for the
// mesa and its pillars, a fog cap so far-away silhouettes stay readable through the haze, and the mist texture.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

/** Non-indexed geometry with only position, normal and color, so everything merges. */
export function prep(geo: THREE.BufferGeometry, color?: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') g.deleteAttribute(k);
  g.morphAttributes = {};
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.color) {
    const c = new THREE.Color(color ?? '#ffffff');
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  return g;
}

/** Collects painted primitives and merges them into one geometry. */
export class GeoBin {
  private parts: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, color?: THREE.ColorRepresentation, m?: THREE.Matrix4) {
    const g = prep(geo, color);
    if (m) g.applyMatrix4(m);
    this.parts.push(g);
    return this;
  }

  /** A box of width w, height h stretched from p to q. */
  beam(p: THREE.Vector3, q: THREE.Vector3, w: number, h: number, color: THREE.ColorRepresentation) {
    const len = p.distanceTo(q);
    if (len < 1e-3) return this;
    tmpV.subVectors(q, p).normalize();
    const up = Math.abs(tmpV.y) > 0.95 ? X : UP;
    tmpM.lookAt(p, q, up);
    tmpM.setPosition(tmpV.addVectors(p, q).multiplyScalar(0.5));
    return this.add(new THREE.BoxGeometry(w, h, len), color, tmpM);
  }

  /** Thin tube along points (ropes, cables). */
  rope(points: THREE.Vector3[], radius: number, color: THREE.ColorRepresentation, segs = 24) {
    const curve = new THREE.CatmullRomCurve3(points);
    return this.add(new THREE.TubeGeometry(curve, segs, radius, 3, false), color);
  }

  get empty() {
    return this.parts.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    return g;
  }
}

/** Translation + rotation about Y + uniform/non-uniform scale. */
export function at(x: number, y: number, z: number, rotY = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationY(rotY);
  m.scale(new THREE.Vector3(sx, sy, sz));
  m.setPosition(x, y, z);
  return m;
}

/**
 * Keeps fog from swallowing a material completely: the fog factor is capped at `max`, so mesas and airships far away
 * read as hazy silhouettes, the way they do in the concept art. Works with Fog and FogExp2 (and leaves a custom fog
 * chunk alone if it does not contain three's usual mix line).
 */
export function capFog<T extends THREE.Material>(mat: T, max: number): T {
  mat.onBeforeCompile = (sh) => {
    const chunk = THREE.ShaderChunk.fog_fragment.replace(
      /mix\(\s*gl_FragColor\.rgb\s*,\s*fogColor\s*,\s*fogFactor\s*\)/,
      `mix( gl_FragColor.rgb, fogColor, min( fogFactor, ${max.toFixed(3)} ) )`,
    );
    sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', chunk);
  };
  mat.customProgramCacheKey = () => `fogcap${max}`;
  return mat;
}

export interface RockPalette {
  lit: THREE.Color;
  strata: THREE.Color;
  shade: THREE.Color;
  top: THREE.Color;
}

export interface ColumnOpts {
  x: number;
  z: number;
  /** Bottom and height. */
  y0: number;
  height: number;
  /** Base radius and the top radius as a fraction of it. */
  radius: number;
  top: number;
  tiers: number;
  seg: number;
  seed: () => number;
  /** Horizontal lean of the top relative to the base, metres. */
  leanX?: number;
  leanZ?: number;
  /** Stretch in x/z for less perfectly round columns. */
  squash?: number;
}

/**
 * A sandstone column: stacked tiers with horizontal ledges between them, vertical erosion grooves running through
 * all tiers, strata bands in the vertex colours and darker grooves. Flat-shaded, it reads as chunky blocky rock.
 * Returns the geometry and the actual top height and approximate top radius.
 */
export function rockColumn(o: ColumnOpts, pal: RockPalette): { geo: THREE.BufferGeometry; topY: number; topR: number } {
  const r = o.seed;
  const seg = o.seg;
  // Groove profile around the column: a few sines with random phases, sharpened.
  const gk = [3, 5, 9, 14, 23, 37];
  const gp = gk.map(() => r() * Math.PI * 2);
  const ga = gk.map((k) => 1 / Math.sqrt(k));
  const groove = (th: number) => {
    let v = 0;
    for (let i = 0; i < gk.length; i++) v += Math.sin(th * gk[i] + gp[i]) * ga[i];
    return v / 1.4;
  };
  const squash = o.squash ?? 1;
  const bandPhase = r() * 10;
  const rings: { y: number; r: number; cx: number; cz: number; tier: number }[] = [];
  let cx = 0;
  let cz = 0;
  const tierH = o.height / o.tiers;
  for (let t = 0; t < o.tiers; t++) {
    const f = o.tiers === 1 ? 0 : t / (o.tiers - 1);
    const rt = o.radius * (1 - (1 - o.top) * f) * (1 + (r() - 0.5) * 0.08);
    const ya = o.y0 + t * tierH;
    const yb = ya + tierH * (0.92 + r() * 0.16);
    const lean = (t + 1) / o.tiers;
    const tx = (o.leanX ?? 0) * lean + cx;
    const tz = (o.leanZ ?? 0) * lean + cz;
    // Each tier: slight flare at its foot, straight face, a lip under the ledge.
    rings.push({ y: ya, r: rt * 1.035, cx: tx, cz: tz, tier: t });
    rings.push({ y: ya + (yb - ya) * 0.35, r: rt, cx: tx, cz: tz, tier: t });
    rings.push({ y: yb - 1.2, r: rt * 0.99, cx: tx, cz: tz, tier: t });
    rings.push({ y: yb, r: rt * 1.012, cx: tx, cz: tz, tier: t });
    cx += (r() - 0.5) * rt * 0.06;
    cz += (r() - 0.5) * rt * 0.06;
  }
  const topY = rings[rings.length - 1].y;
  const topR = rings[rings.length - 1].r;
  const tierNoise = Array.from({ length: o.tiers }, () => [r() * 6.28, r() * 6.28]);

  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const paint = (y: number, g: number, isTop: boolean) => {
    if (isTop) {
      c.copy(pal.top);
    } else {
      const band = Math.sin(y * 0.38 + bandPhase + Math.sin(y * 0.07) * 2);
      c.copy(pal.lit).lerp(pal.strata, THREE.MathUtils.smoothstep(band, 0.35, 0.8) * 0.75);
      // Deep grooves darker (fake occlusion), and the foot fades darker too.
      c.lerp(pal.shade, THREE.MathUtils.clamp(-g * 0.55, 0, 0.45));
      c.lerp(pal.shade, THREE.MathUtils.clamp(1 - (y - o.y0) / (o.height * 0.35), 0, 1) * 0.35);
    }
    col.push(c.r, c.g, c.b);
  };
  const vert = (ri: number, k: number) => {
    const ring = rings[ri];
    const th = (k / seg) * Math.PI * 2;
    const g = groove(th);
    const [p1, p2] = tierNoise[ring.tier];
    const rr = ring.r * (1 + 0.11 * g + 0.03 * Math.sin(th * 7 + p1) * Math.sin(th * 3 + p2));
    return { x: o.x + ring.cx + Math.cos(th) * rr * squash, y: ring.y, z: o.z + ring.cz + Math.sin(th) * rr / squash, g };
  };
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const a = vert(i, k);
      const b = vert(i, k + 1);
      const cc = vert(i + 1, k + 1);
      const d = vert(i + 1, k);
      for (const v of [a, cc, b, a, d, cc]) {
        pos.push(v.x, v.y, v.z);
        paint(v.y, v.g, false);
      }
    }
  }
  // Top cap: a slightly domed fan.
  const last = rings.length - 1;
  const ctr = { x: o.x + rings[last].cx, y: topY + 1.5, z: o.z + rings[last].cz };
  for (let k = 0; k < seg; k++) {
    const a = vert(last, k);
    const b = vert(last, k + 1);
    for (const v of [ctr, b, a]) {
      pos.push(v.x, v.y, v.z);
      paint(v.y, 0, true);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return { geo, topY, topR: topR * 0.9 };
}

/** Wispy mist band texture: transparent at the top, dense low down, with horizontal streaks. */
export function mistTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 64;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(w, h);
  const ph = Array.from({ length: 6 }, () => Math.random() * 6.28);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1); // 0 top, 1 bottom
    const vert = Math.pow(Math.sin(Math.min(1, v * 1.15) * Math.PI * 0.5), 1.6) * (1 - Math.max(0, v - 0.85) * 2.5);
    for (let x = 0; x < w; x++) {
      const u = (x / w) * Math.PI * 2;
      const wisp =
        0.55 +
        0.25 * Math.sin(u * 3 + ph[0] + v * 3) +
        0.15 * Math.sin(u * 7 + ph[1] - v * 5) +
        0.1 * Math.sin(u * 13 + ph[2] + v * 9);
      const a = THREE.MathUtils.clamp(vert * wisp, 0, 1);
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
