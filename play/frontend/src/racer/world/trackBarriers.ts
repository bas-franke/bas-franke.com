// The barriers at +-width/2 (the physics walls): a continuous low wall of 3.6 m panels. On corners the outside wall
// carries the yellow-on-black chevrons (pointing along the direction of travel, i.e. into the turn) and in tight
// corners the inside gets red/white kerb panels plus a flat kerb strip on the road; straights mix chevron, steel and
// stone runs. Gorge bridges get railings instead (trackBridge.ts). Also the checkered start/finish line on the road.
// All of it uses the barrier atlas, merged into ~200 m chunks.

import * as THREE from 'three';
import { rng, type Track } from '../core/track';
import { GeoBuilder, type UV } from './trackGeo';
import { ROW, rowV } from './trackTextures';
import type { Zones } from './zones';

export const WALL_HEIGHT = 1.7;
const PANEL = 3.6;
const CHUNK_LEN = 200;

type Kind = 'chevron' | 'steel' | 'stone' | 'kerb';

/** True when s lies in one of the gorge bridge stretches (plus `margin` metres either side). */
export function onBridge(track: Track, zones: Zones, s: number, margin = 4) {
  for (const g of zones.gorges) {
    const a = g.s0 - margin;
    if (track.wrap(s - a) <= g.s1 - g.s0 + margin * 2) return true;
  }
  return false;
}

function uvRow(row: number, u0: number, u1: number, vf0 = 0, vf1 = 1): [UV, UV, UV, UV] {
  const [a, b] = rowV(row);
  const v0 = a + (b - a) * vf0;
  const v1 = a + (b - a) * vf1;
  return [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
}

export function buildBarriers(track: Track, zones: Zones, wallMat: THREE.Material, decalMat: THREE.Material) {
  const L = track.length;
  const count = Math.round(L / PANEL);
  const P = L / count;
  const r = rng(track.def.seed * 13 + 5);

  // Average curvature around a panel, biased ahead so the chevrons start before the corner does.
  const kAt = (s: number) => {
    let k = 0;
    let m = 0;
    for (let d = -6; d <= 40; d += 4, m++) k += track.frameAt(s + d).kappa;
    return k / m;
  };

  // Straight-run choice per block of 8 panels so variation comes in runs, not single panels.
  const straightKinds: Kind[][] = [];
  for (let b = 0; b < Math.ceil(count / 8); b++) {
    const pick = (): Kind => {
      const x = r();
      return x < 0.65 ? 'chevron' : x < 0.85 ? 'steel' : 'stone';
    };
    straightKinds.push([pick(), pick()]);
  }

  const kinds = (k: number, s: number): [Kind, Kind] => {
    const kap = kAt(s);
    const a = Math.abs(kap);
    const [sl, sr] = straightKinds[Math.floor(k / 8)];
    if (a < 1 / 450) return [sl, sr];
    // kappa > 0 turns left: the outside is the right wall.
    const outer: 1 | -1 = kap > 0 ? 1 : -1;
    const inner: Kind = a > 1 / 170 ? 'kerb' : sl === 'chevron' ? 'steel' : sl;
    return outer > 0 ? [inner, 'chevron'] : ['chevron', inner];
  };

  const builders = new Map<number, { wall: GeoBuilder; decal: GeoBuilder }>();
  const chunk = (s: number) => {
    const c = Math.floor(s / CHUNK_LEN);
    let b = builders.get(c);
    if (!b) {
      b = { wall: new GeoBuilder(true, false), decal: new GeoBuilder(true, false) };
      builders.set(c, b);
    }
    return b;
  };

  const fa = track.frameAt(0);
  const fb = track.frameAt(0);
  const hintIn = new THREE.Vector3();
  const v = () => new THREE.Vector3();
  const pts = Array.from({ length: 8 }, v);
  const kerbPts = Array.from({ length: 4 }, v);
  const bridge = Array.from({ length: count }, (_, k) => onBridge(track, zones, (k + 0.5) * P));
  const rowOf: Record<Kind, number> = { chevron: ROW.chevron, steel: ROW.steel, stone: ROW.stone, kerb: ROW.kerb };

  for (let k = 0; k < count; k++) {
    if (bridge[k]) continue;
    const sa = k * P;
    const sb = (k + 1) * P;
    track.frameAt(sa, fa);
    track.frameAt(sb, fb);
    const kk = kinds(k, sa + P / 2);
    const { wall, decal } = chunk(sa);
    for (const side of [-1, 1] as const) {
      const kind = kk[side < 0 ? 0 : 1];
      const at = (f: typeof fa, x: number, h: number, out: THREE.Vector3) =>
        out.copy(f.pos).addScaledVector(f.right, side * (f.width / 2 + x)).addScaledVector(f.up, h);
      // a = panel start, b = panel end: inner bottom, inner top, outer top, outer bottom.
      at(fa, 0, -0.15, pts[0]);
      at(fa, 0.12, WALL_HEIGHT, pts[1]);
      at(fa, 0.7, WALL_HEIGHT, pts[2]);
      at(fa, 0.85, -0.15, pts[3]);
      at(fb, 0, -0.15, pts[4]);
      at(fb, 0.12, WALL_HEIGHT, pts[5]);
      at(fb, 0.7, WALL_HEIGHT, pts[6]);
      at(fb, 0.85, -0.15, pts[7]);
      hintIn.copy(fa.right).multiplyScalar(-side);
      wall.quad(pts[0], pts[4], pts[5], pts[1], uvRow(rowOf[kind], 0, 1), hintIn);
      wall.quad(pts[1], pts[5], pts[6], pts[2], uvRow(ROW.steel, 0, 1, 0.94, 1), fa.up);
      wall.quad(pts[3], pts[7], pts[6], pts[2], uvRow(ROW.steel, 0, 1, 0.1, 0.9), hintIn.clone().negate());
      // End caps where the wall stops at a bridge.
      if (bridge[(k + 1) % count]) wall.quad(pts[4], pts[7], pts[6], pts[5], uvRow(ROW.hazard, 0, 0.4), fb.tangent);
      if (bridge[(k - 1 + count) % count]) wall.quad(pts[0], pts[3], pts[2], pts[1], uvRow(ROW.hazard, 0, 0.4), fa.tangent.clone().negate());

      if (kind === 'kerb') {
        // Flat kerb strip on the road at the foot of the inside wall.
        at(fa, -1.4, 0.035, kerbPts[0]);
        at(fb, -1.4, 0.035, kerbPts[1]);
        at(fb, 0, 0.035, kerbPts[2]);
        at(fa, 0, 0.035, kerbPts[3]);
        decal.quad(kerbPts[0], kerbPts[1], kerbPts[2], kerbPts[3], uvRow(ROW.kerb, 0, 1, 0.1, 0.9), fa.up);
      }
    }
  }

  // Checkered start/finish line across the road at s = 0, 3.2 m deep, squares of 0.8 m.
  {
    const { decal } = chunk(0);
    const segs = 8;
    const s0 = -1.6;
    const s1 = 1.6;
    track.frameAt(s0, fa);
    track.frameAt(s1, fb);
    const p = Array.from({ length: 4 }, v);
    for (let i = 0; i < segs; i++) {
      const xa = -1 + (2 * i) / segs;
      const xb = -1 + (2 * (i + 1)) / segs;
      const put = (f: typeof fa, xf: number, out: THREE.Vector3) => out.copy(f.pos).addScaledVector(f.right, (xf * f.width) / 2).addScaledVector(f.up, 0.03);
      put(fa, xa, p[0]);
      put(fa, xb, p[1]);
      put(fb, xb, p[2]);
      put(fb, xa, p[3]);
      const ua = ((xa + 1) * fa.width) / 2 / 6.4;
      const ub = ((xb + 1) * fa.width) / 2 / 6.4;
      decal.quad(p[0], p[1], p[2], p[3], uvRow(ROW.checker, ua, ub), fa.up);
    }
  }

  const group = new THREE.Group();
  group.name = 'barriers';
  for (const { wall, decal } of builders.values()) {
    if (!wall.empty) {
      const m = new THREE.Mesh(wall.build(), wallMat);
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }
    if (!decal.empty) {
      const m = new THREE.Mesh(decal.build(), decalMat);
      m.receiveShadow = true;
      group.add(m);
    }
  }
  return group;
}
