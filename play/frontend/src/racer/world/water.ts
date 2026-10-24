// Waterfalls and the river in the gorge, for themes with waterfalls. Each fall from zones.waterfalls is a curved sheet
// that runs over a short ledge, rolls off a bright lip and drops in a parabola, with streaks scrolling down it, a small
// block of wet rock behind it so it never floats, and billowing mist at its foot. A turquoise river with foam rapids
// runs along each gorge (zones.gorges, the ground `depth` metres below the road) under the bridge, through the foot of
// every fall, from a wide pair of distant falls at the head of the gorge. Mist hangs over the river.
// Four draw calls in all: sheets, rock, river, mist (one instanced quad per puff).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '../core/track';
import type { Theme } from '../core/tracks';
import type { WorldBuilder } from './types';
import { fallMaterial, makeNoiseTexture, mistMaterial, riverMaterial, sunDirection, type WaterShared } from './waterMaterials';
import { zonesFor } from './zones';

interface Fall {
  top: THREE.Vector3;
  width: number;
  drop: number;
  facing: THREE.Vector3;
  /** Bigger rock backing (distant falls at the head of the gorge stand on their own). */
  big?: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
/** Horizontal speed of the water over the lip: x = OUT * sqrt(drop) metres out from the lip after dropping `drop`. */
const OUT = 1.35;

const across = (f: THREE.Vector3) => new THREE.Vector3(-f.z, 0, f.x);
const fallBase = (f: Fall) => f.top.clone().addScaledVector(f.facing, OUT * Math.sqrt(f.drop)).addScaledVector(UP, -f.drop);

export const buildWater: WorldBuilder = (ctx) => {
  const { track, theme, quality } = ctx;
  if (!theme.waterfalls) return {};
  const zones = zonesFor(track);
  if (!zones.waterfalls.length && !zones.gorges.length) return {};
  const high = quality !== 'low';
  const r = rng(track.def.seed * 13 + 5);

  const falls: Fall[] = zones.waterfalls.map((w) => ({ ...w }));
  const rivers: { points: THREE.Vector3[]; widths: number[] }[] = [];

  for (const g of zones.gorges) {
    const fc = track.frameAt((g.s0 + g.s1) / 2);
    const ax = fc.right.clone().setY(0).normalize();
    const tg = fc.tangent.clone().setY(0).normalize();
    const y = fc.pos.y - g.depth + 1;
    const local = (p: THREE.Vector3) => {
      const d = p.clone().sub(fc.pos);
      return { lat: d.dot(ax), along: d.dot(tg) };
    };
    const near = falls.filter((f) => f.top.distanceTo(fc.pos) < 600);
    const lats = near.map((f) => local(fallBase(f)).lat);
    const minLat = Math.min(-150, ...lats);
    const maxLat = Math.max(150, ...lats);

    // The head of the gorge: a wide fall straight down the river and a narrower one off the chasm side beside it. The
    // terrain's chasm floor stays flat out to ~340 m and rises beyond, so the river and these falls stay inside that.
    const head = -Math.max(330, Math.min(380, -minLat + 70));
    const headTop = fc.pos.clone().addScaledVector(ax, head);
    headTop.y = fc.pos.y + 30 + r() * 15;
    const headFalls: Fall[] = [
      { top: headTop, width: 44 + r() * 10, drop: headTop.y - y + 1, facing: ax.clone(), big: true },
    ];
    const side = r() < 0.5 ? -1 : 1;
    const t2 = fc.pos.clone().addScaledVector(ax, head + 60).addScaledVector(tg, side * 70);
    t2.y = fc.pos.y + 15 + r() * 10;
    headFalls.push({ top: t2, width: 20 + r() * 8, drop: t2.y - y + 1, facing: ax.clone().multiplyScalar(0.35).addScaledVector(tg, -side).normalize(), big: true });
    falls.push(...headFalls);

    // River centreline in gorge space (lat across the track, along it), through the foot of every fall.
    // Wide enough to fill most of the chasm floor (the chasm is about as wide as the bridge is long).
    const baseW = THREE.MathUtils.clamp((g.s1 - g.s0) * 0.6, 56, 110);
    const ctrl: { lat: number; along: number; w: number }[] = [
      { lat: local(fallBase(headFalls[0])).lat - 25, along: 0, w: headFalls[0].width * 1.3 },
      { lat: 0, along: 0, w: baseW },
      { lat: Math.max(maxLat + 60, 340), along: (r() - 0.5) * 30, w: baseW * 1.1 },
    ];
    for (const f of [...near, headFalls[0]]) {
      const l = local(fallBase(f));
      ctrl.push({ lat: l.lat, along: l.along, w: Math.max(baseW, f.width * 1.6) });
    }
    ctrl.sort((a, b) => a.lat - b.lat);
    const merged: typeof ctrl = [];
    for (const c of ctrl) {
      const last = merged[merged.length - 1];
      if (last && c.lat - last.lat < 35) {
        last.along = (last.along + c.along) / 2;
        last.w = Math.max(last.w, c.w);
      } else merged.push({ ...c });
    }
    const curve = new THREE.CatmullRomCurve3(merged.map((c) => new THREE.Vector3(c.lat, 0, c.along)));
    const n = Math.max(20, Math.round(curve.getLength() / (high ? 8 : 14)));
    const pts = curve.getSpacedPoints(n);
    const widths = pts.map((p) => {
      // Width follows the nearest control points, smoothly.
      let ws = 0;
      let wt = 0;
      for (const c of merged) {
        const k = Math.exp(-(((p.x - c.lat) / 45) ** 2));
        ws += c.w * k;
        wt += k;
      }
      return wt > 1e-4 ? ws / wt : baseW;
    });
    const points = pts.map((p) => fc.pos.clone().addScaledVector(ax, p.x).addScaledVector(tg, p.z).setY(y));
    rivers.push({ points, widths });
  }

  const shared: WaterShared = {
    time: { value: 0 },
    noise: { value: makeNoiseTexture() },
    sunDir: { value: sunDirection(theme) },
  };
  const group = new THREE.Group();
  group.name = 'water';
  const disposables: { dispose(): void }[] = [shared.noise.value];

  const sheetGeo = buildSheets(falls, high);
  const sheetMat = fallMaterial(shared, theme);
  const sheets = new THREE.Mesh(sheetGeo, sheetMat);
  sheets.renderOrder = 1;
  disposables.push(sheetGeo, sheetMat);

  const rockGeo = buildRocks(falls, theme, r, high);
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true });
  const rocks = new THREE.Mesh(rockGeo, rockMat);
  rocks.castShadow = rocks.receiveShadow = true;
  disposables.push(rockGeo, rockMat);
  group.add(rocks, sheets);

  if (rivers.length) {
    const spots = falls.map((f) => {
      const b = fallBase(f);
      return new THREE.Vector4(b.x, b.z, f.width * 0.55, 0);
    });
    const riverGeo = buildRiver(rivers, high);
    const riverMat = riverMaterial(shared, theme, spots);
    const river = new THREE.Mesh(riverGeo, riverMat);
    disposables.push(riverGeo, riverMat);
    group.add(river);
  }

  const mistGeo = buildMist(falls, rivers, r, high);
  const mistMat = mistMaterial(shared, theme);
  const mist = new THREE.Mesh(mistGeo, mistMat);
  mist.frustumCulled = false;
  mist.renderOrder = 2;
  disposables.push(mistGeo, mistMat);
  group.add(mist);

  return {
    object: group,
    update: (view) => {
      shared.time.value = view.time;
    },
    dispose: () => {
      for (const d of disposables) d.dispose();
    },
  };
};

/** All fall sheets in one geometry. uv = (across, along the flow) metres; aInfo = (across 0..1, drop 0..1, past lip). */
function buildSheets(falls: Fall[], high: boolean) {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const info: number[] = [];
  const idx: number[] = [];
  const cols = high ? 10 : 6;
  const dropRows = high ? 22 : 12;
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  for (const f of falls) {
    const ax = across(f.facing);
    // Path down the middle of the sheet: (x out from the lip, y up, metres along the flow, metres past the lip).
    const path: { x: number; y: number; t: number }[] = [-10, -6, -3, -1.2, 0].map((x) => ({ x, y: 0.15, t: 0 }));
    for (let i = 1; i <= dropRows; i++) {
      const d = f.drop * (i / dropRows) ** 1.8;
      path.push({ x: OUT * Math.sqrt(d), y: -d, t: d / f.drop });
    }
    const base = pos.length / 3;
    let len = 0;
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)];
      const b = path[Math.min(path.length - 1, i + 1)];
      const tx = b.x - a.x;
      const ty = b.y - a.y;
      const tl = Math.hypot(tx, ty) || 1;
      if (i > 0) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      const lip = path[i].x <= 0 ? path[i].x : len - 10;
      const w = f.width * (1 + 0.3 * path[i].t);
      nrm.copy(f.facing).multiplyScalar(-ty / tl).addScaledVector(UP, tx / tl).normalize();
      for (let c = 0; c <= cols; c++) {
        const u = c / cols;
        const bulge = path[i].t > 0 ? 0.9 * (1 - (2 * u - 1) ** 2) * Math.min(1, -path[i].y / 6) : 0;
        p.copy(f.top).addScaledVector(f.facing, path[i].x + bulge).addScaledVector(UP, path[i].y).addScaledVector(ax, (u - 0.5) * w);
        pos.push(p.x, p.y, p.z);
        nor.push(nrm.x, nrm.y, nrm.z);
        uv.push((u - 0.5) * w, len);
        info.push(u, path[i].t, lip);
      }
    }
    for (let i = 0; i < path.length - 1; i++) {
      for (let c = 0; c < cols; c++) {
        const a = base + i * (cols + 1) + c;
        const b = a + cols + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Chunky stratified rock behind and beside each fall: a stack of ledges behind the sheet, low banks either side of
 * the stream on top, and two pillars framing the drop. Vertex-coloured with strata bands, darker where it is wet.
 */
function buildRocks(falls: Fall[], theme: Theme, r: () => number, high: boolean) {
  const lit = new THREE.Color(theme.rockLit);
  const shade = new THREE.Color(theme.rockShade);
  const strata = new THREE.Color(theme.rockStrata);
  const parts: THREE.BufferGeometry[] = [];
  const basis = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const v = new THREE.Vector3();
  for (const f of falls) {
    const ax = across(f.facing);
    basis.makeBasis(ax, UP, f.facing).setPosition(f.top);
    const half = f.width / 2;
    const deep = f.big ? 60 : 8;
    const bottom = -f.drop - 6;
    const wet = (a: number, y: number, z: number) => Math.abs(a) < half * (1 + 0.3 * Math.min(1, -y / f.drop)) + 2 && z > -4 && y < 1;
    // [a0, a1, y0, y1, z0, z1] in the fall's frame: a across, y up from the lip, z out towards the facing.
    const boxes: number[][] = [];
    // A wet face right behind the sheet, in ledges. The terrain cuts the bigger block each zone fall pours from;
    // the falls this module adds at the head of the gorge get a whole small cliff.
    const tiers = high ? 6 : 3;
    const spread = f.big ? 10 : 3;
    for (let i = 0; i < tiers; i++) {
      const y1 = -0.5 - (f.drop * i) / tiers;
      const y0 = -0.5 - (f.drop * (i + 1)) / tiers - 6;
      const front = -0.8 - r() * 2.2 + (i === 0 ? 0.6 : 0);
      const wide = half * (1 + (0.3 * (i + 1)) / tiers) + spread + r() * 4;
      boxes.push([-wide, wide, y0, y1, front - deep, front]);
    }
    boxes.push([-half - 5, -half + 0.5, -1.2, 1 + r() * 1.5, -deep, -0.6]);
    boxes.push([half - 0.5, half + 5, -1.2, 1 + r() * 1.5, -deep, -0.6]);
    if (f.big) {
      const inner = f.width * 0.66 + 2;
      for (const s of [-1, 1]) {
        const w = 26 + r() * 10;
        const a0 = s < 0 ? -inner - w : inner;
        boxes.push([a0, a0 + w, bottom, 4 + r() * 6, -deep, 10 + r() * 12]);
      }
    }
    for (const [a0, a1, y0, y1, z0, z1] of boxes) {
      const h = y1 - y0;
      const box = new THREE.BoxGeometry(a1 - a0, h, z1 - z0, 1, Math.max(1, Math.round(h / 7)), 1);
      m.makeRotationY((r() - 0.5) * 0.08).premultiply(new THREE.Matrix4().makeTranslation((a0 + a1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
      box.applyMatrix4(m);
      const p = box.attributes.position;
      const colors = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const band = Math.sin((v.y + f.top.y) * 0.45 + Math.sin(v.y * 0.13) * 2);
        c.copy(lit).lerp(shade, 0.25 + 0.15 * Math.sin(v.y * 0.21 + v.x * 0.05));
        if (band > 0.55) c.lerp(strata, 0.55);
        if (wet(v.x, v.y, v.z)) c.multiplyScalar(0.55).lerp(shade, 0.3);
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      box.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      box.applyMatrix4(basis);
      parts.push(box);
    }
  }
  const merged = mergeGeometries(parts) ?? new THREE.BufferGeometry();
  for (const p of parts) p.dispose();
  return merged;
}

/** River ribbons. uv = (across metres, along metres downstream); aInfo = (across 0..1, along 0..1, 0). */
function buildRiver(rivers: { points: THREE.Vector3[]; widths: number[] }[], high: boolean) {
  const pos: number[] = [];
  const uv: number[] = [];
  const info: number[] = [];
  const idx: number[] = [];
  const cols = high ? 8 : 4;
  const side = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const { points, widths } of rivers) {
    const base = pos.length / 3;
    let len = 0;
    const total = points.reduce((s, q, i) => (i ? s + q.distanceTo(points[i - 1]) : 0), 0);
    for (let i = 0; i < points.length; i++) {
      if (i) len += points[i].distanceTo(points[i - 1]);
      dir.subVectors(points[Math.min(points.length - 1, i + 1)], points[Math.max(0, i - 1)]).setY(0).normalize();
      side.set(-dir.z, 0, dir.x);
      for (let c = 0; c <= cols; c++) {
        const u = c / cols;
        const a = (u - 0.5) * widths[i];
        p.copy(points[i]).addScaledVector(side, a);
        pos.push(p.x, p.y, p.z);
        uv.push(a, len);
        info.push(u, len / total, 0);
      }
    }
    for (let i = 0; i < points.length - 1; i++) {
      for (let c = 0; c < cols; c++) {
        const a = base + i * (cols + 1) + c;
        const b = a + cols + 1;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Mist puffs: splash and big billows at the foot of each fall, a veil of spray on it, and haze along the river. */
function buildMist(falls: Fall[], rivers: { points: THREE.Vector3[]; widths: number[] }[], r: () => number, high: boolean) {
  const center: number[] = [];
  const size: number[] = [];
  const move: number[] = [];
  const add = (p: THREE.Vector3, s: number, rise: number, opacity: number, drift: THREE.Vector3, seconds: number) => {
    center.push(p.x, p.y, p.z);
    size.push(s, r(), rise, opacity);
    move.push(drift.x, drift.z, 1 / seconds, r());
  };
  const q = high ? 1 : 0.5;
  const p = new THREE.Vector3();
  const drift = new THREE.Vector3();
  for (const f of falls) {
    const ax = across(f.facing);
    const base = fallBase(f);
    const splash = Math.round(10 * q);
    for (let i = 0; i < splash; i++) {
      const s = f.width * (0.45 + r() * 0.4) + 8;
      p.copy(base).addScaledVector(f.facing, 2 + r() * 12).addScaledVector(ax, (r() - 0.5) * f.width * 1.1).addScaledVector(UP, s * 0.2);
      add(p, s, 10 + r() * 16, 0.8, drift.copy(f.facing).multiplyScalar(6 + r() * 10), 5 + r() * 3);
    }
    const billows = Math.round(6 * q);
    for (let i = 0; i < billows; i++) {
      const s = f.width * (1.5 + r() * 0.8) + 20;
      p.copy(base).addScaledVector(f.facing, 8 + r() * 16).addScaledVector(ax, (r() - 0.5) * f.width * 1.2).addScaledVector(UP, 8 + r() * 8);
      add(p, s, 30 + r() * 35, 0.55, drift.copy(f.facing).multiplyScalar(10 + r() * 15), 9 + r() * 6);
    }
    const veil = Math.round(3 * q);
    for (let i = 0; i < veil; i++) {
      const d = f.drop * (0.45 + r() * 0.4);
      p.copy(f.top).addScaledVector(f.facing, OUT * Math.sqrt(d) + 4).addScaledVector(UP, -d).addScaledVector(ax, (r() - 0.5) * f.width * 0.6);
      add(p, f.width * 0.8 + 6, -10 - r() * 10, 0.28, drift.copy(f.facing).multiplyScalar(5), 6 + r() * 3);
    }
  }
  for (const { points, widths } of rivers) {
    const count = Math.round(24 * q);
    for (let i = 0; i < count; i++) {
      const k = Math.floor(r() * (points.length - 1));
      const dir = points[k + 1].clone().sub(points[k]).normalize();
      p.copy(points[k]).addScaledVector(new THREE.Vector3(-dir.z, 0, dir.x), (r() - 0.5) * widths[k]).addScaledVector(UP, 8 + r() * 22);
      add(p, 45 + r() * 40, 6 + r() * 6, 0.22, drift.copy(dir).multiplyScalar(25), 18 + r() * 10);
    }
  }
  const quad = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.attributes.position);
  g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(new Float32Array(center), 3));
  g.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(size), 4));
  g.setAttribute('aMove', new THREE.InstancedBufferAttribute(new Float32Array(move), 4));
  g.instanceCount = center.length / 3;
  return g;
}
