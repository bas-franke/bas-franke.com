// The skyline: clusters of slender, blocky sandstone spires right behind the canyon walls all along the course (the
// "spire forest" of the concept art), distant mesas, buttes and spire clusters ringing the circuit in depth layers from
// ~300 m to ~3 km out, a huge blocky arch between two massive buttresses in the mid distance ahead of a straight once
// per block, arches on the horizon, and the great natural arch the racers fly under (zones.arch). Placement keeps
// clear of the canyon walls, the mesa city, the waterfalls and the river below the gorge bridge (see zones.ts).
// The near spires are merged per ~1.5 km of course (frustum culled); everything distant is one faceted mesh (one draw
// call, no shadows); the track arch is its own mesh so it can cast its shadow across the road.

import * as THREE from 'three';
import { rng, type Track } from '../core/track';
import { addArch, addBlockSpire, addMesa, addSpire, RockBuilder } from './landmarkGeometry';
import { createRockMaterial } from './landmarkMaterial';
import type { WorldBuilder } from './types';
import { zonesFor, type Zones } from './zones';

/** Depth layers: distance from the nearest point of the track, and what grows there. */
interface Layer {
  near: number;
  far: number;
  spires: number;
  buttes: number;
  mesas: number;
  /** Scale of heights/radii, so each layer still rises above the one in front of it. */
  scale: number;
}

const LAYERS: Layer[] = [
  { near: 300, far: 650, spires: 14, buttes: 6, mesas: 3, scale: 1 },
  { near: 650, far: 1300, spires: 14, buttes: 7, mesas: 7, scale: 1.35 },
  { near: 1300, far: 2200, spires: 10, buttes: 4, mesas: 11, scale: 1.8 },
  { near: 2200, far: 3200, spires: 6, buttes: 2, mesas: 13, scale: 2.4 },
];

/** Length of course whose near spires share one mesh. */
const NEAR_CHUNK = 1500;

export const buildLandmarks: WorldBuilder = (ctx) => {
  const { track, theme, quality } = ctx;
  const zones = zonesFor(track);
  const r = rng(track.def.seed * 13 + 101);
  const low = quality === 'low';
  // Long courses (TrackDef.blocks) get as many landmarks per kilometre as a base layout.
  const B = track.blocks;
  const density = (low ? 0.55 : quality === 'medium' ? 0.8 : 1) * B;
  const segScale = low ? 0.6 : 1;

  // Track footprint for distance queries (every ~8 m), and the general ground level.
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < track.frames.length; i += 4) pts.push(track.frames[i].pos);
  let ground = 0;
  for (const p of pts) ground += p.y;
  ground = ground / pts.length - 6;
  /** Distance to the nearest point of the track; that point is left in `nearestPt`. */
  let nearestPt = pts[0];
  const nearestTrack = (x: number, z: number) => {
    let best = Infinity;
    for (const p of pts) {
      const dx = p.x - x;
      const dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        nearestPt = p;
      }
    }
    return Math.sqrt(best);
  };
  const keepOut = keepOutAreas(track, zones);
  const blocked = (x: number, z: number, rad: number) => keepOut.some((k) => k.test(x, z, rad));


  const placed: { x: number; z: number; rad: number }[] = [];
  /** Random spot whose nearest track distance is inside [near, far] (after allowing for the rock's own footprint).
   * Candidates are thrown out sideways from a random point of the course, so long, thin courses get them all along. */
  const findSpot = (layer: Layer, rad: number, spacing: number): { x: number; z: number; d: number } | null => {
    for (let tries = 0; tries < 60; tries++) {
      const p = pts[Math.floor(r() * pts.length)];
      const a = r() * Math.PI * 2;
      const dist = layer.near + rad + r() * (layer.far - layer.near + 200);
      const x = p.x + Math.cos(a) * dist;
      const z = p.z + Math.sin(a) * dist;
      const d = nearestTrack(x, z) - rad;
      if (d < layer.near || d > layer.far) continue;
      if (blocked(x, z, rad)) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < (p.rad + rad) * spacing)) continue;
      return { x, z, d };
    }
    return null;
  };

  const skyline = new RockBuilder();
  const lit = new THREE.Color(theme.rockLit);
  const strata = new THREE.Color(theme.rockStrata);
  const shade = new THREE.Color(theme.rockShade);
  const tint = () => {
    // Per-rock variation: a little brighter/paler or deeper red, so neighbouring rocks separate.
    const c = new THREE.Color(1, 1, 1);
    const k = r();
    const ratio = (o: THREE.Color) => new THREE.Color(o.r / lit.r, o.g / lit.g, o.b / lit.b);
    if (k < 0.35) c.lerp(ratio(strata), 0.12);
    else if (k > 0.7) c.lerp(ratio(shade), 0.18);
    c.multiplyScalar(0.92 + r() * 0.14);
    skyline.tint = [c.r, c.g, c.b];
  };

  /** A spire cluster as in the concept art: a massive fractured rock base (a stubby blocky butte) out of which a crowd
   * of slender blocky pinnacles rises, one main needle tallest, now and then a capped hoodoo beside it. `cols` scales
   * the pinnacle count (far layers get fewer, cheaper ones). */
  const spireCluster = (into: RockBuilder, x: number, z: number, sc: number, tall: number, seg: number, cols = 1, base = ground) => {
    const n = Math.max(1, Math.round((4 + r() * 5) * cols));
    const main = (210 + r() * 150) * sc * tall;
    const prev = skyline.tint;
    const paint = () => {
      tint();
      into.tint = skyline.tint;
    };
    // The base mass: wide, a third to half the height of the main needle.
    const Rb = (30 + r() * 22) * sc * Math.sqrt(tall);
    const hb = main * (0.3 + r() * 0.3);
    paint();
    addBlockSpire(into, r, { x, z, ground: base, height: hb, radius: Rb, seg: Math.max(5, Math.round(seg * 0.75)), talus: 1, taper: 0.3 });
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2;
      const off = k === 0 ? r() * Rb * 0.3 : Rb * (0.3 + r() * 0.65);
      paint();
      const h = k === 0 ? main : main * (0.5 + r() * 0.42);
      const px = x + Math.cos(a) * off;
      const pz = z + Math.sin(a) * off;
      if (k > 0 && r() < 0.12) {
        addSpire(into, r, { x: px, z: pz, ground: base, height: h * 0.7, radius: (7 + r() * 5) * sc, seg: Math.max(6, seg) });
      } else {
        addBlockSpire(into, r, {
          x: px,
          z: pz,
          ground: base,
          height: h,
          radius: (k === 0 ? 16 + r() * 8 : 9 + r() * 9) * sc * Math.sqrt(tall),
          seg: Math.max(4, Math.round(seg * (0.5 + r() * 0.3))),
          talus: 0,
        });
      }
    }
    skyline.tint = prev;
  };

  // Hero needles first: where the road bends, the view straight ahead leaves the canyon and lands on open desert a
  // few hundred metres out. Towering spires there are what you see framed between the walls, as in the concept art.
  const heroes = Math.round((low ? 4 : 7) * density);
  const heroLayer: Layer = { near: 280, far: 800, spires: 0, buttes: 0, mesas: 0, scale: 1 };
  const step = track.length / (24 * B);
  const offset = r() * step;
  for (let i = 0, made = 0; i < 24 * B && made < heroes; i++) {
    const s = (offset + i * step * 2.3) % track.length;
    const f = track.frameAt(s);
    // Only from corners: the straight-ahead line must be leaving the track.
    if (track.maxCurvature(s, 250) < 0.0016) continue;
    for (const D of [520, 680, 850]) {
      const x = f.pos.x + f.tangent.x * D;
      const z = f.pos.z + f.tangent.z * D;
      const d = nearestTrack(x, z) - 50;
      if (d < heroLayer.near || d > heroLayer.far || blocked(x, z, 50)) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.rad + 120)) continue;
      placed.push({ x, z, rad: 70 });
      spireCluster(skyline, x, z, 1, 1.5, Math.round(10 * segScale), 1.3);
      made++;
      break;
    }
  }

  // The great arch of the concept art, once per block: a thick, blocky span right across the canyon, its feet on the
  // rims behind the walls and two massive stepped buttresses beyond them rising over the crown, at the end of a long
  // straight so it shows framed between the walls from far off and the racers fly under it. Spire clusters crowd it.
  const bigArches = low ? Math.ceil(B / 2) : B;
  const bigArch = new RockBuilder();
  /** Course positions of the big arches (debug: group.userData.bigArches), and their feet, kept clear of spires. */
  const bigArchAt: number[] = [];
  const archFeet: { x: number; z: number }[] = [];
  const busy = (s: number, m: number) =>
    track.caves.some((c) => c.s1 > s - m && c.s0 < s + m) ||
    zones.slots.some((o) => o.s1 > s - m && o.s0 < s + m) ||
    zones.stands.some((st) => st.s1 > s - m && st.s0 < s + m) ||
    zones.gorges.some((g) => g.s1 > s - m && g.s0 < s + m) ||
    (zones.arch !== null && Math.abs(zones.arch.s - s) < m + 400) ||
    track.shortcuts.some((c) => c.s1 > s - m && c.s0 < s + m);
  for (let k = 0, made = 0; k < 80 * B && made < bigArches; k++) {
    const s = track.raceS((made + 0.12 + r() * 0.76) / B);
    // A straight run-up (the arch in view for a few seconds), the walls on both sides closed.
    if (track.maxCurvature(s - 300, 320) > 0.003 || busy(s - 200, 240) || bigArchAt.some((o) => Math.abs(o - s) < 2000)) continue;
    const Wl = zones.wallOffset(s, -1);
    const Wr = zones.wallOffset(s, 1);
    if (!Number.isFinite(Wl) || !Number.isFinite(Wr)) continue;
    const f = track.frameAt(s);
    const dir = f.tangent.clone().setY(0).normalize();
    const across = new THREE.Vector3(-dir.z, 0, dir.x);
    // `across` is the flat right of travel (as in terrainField): centre the span between the two wall feet.
    const legThick = 60 + r() * 16;
    const span = Wl + Wr + legThick + 40;
    const c = new THREE.Vector3(f.pos.x, Math.min(ground, f.pos.y - 8), f.pos.z).addScaledVector(across, (Wr - Wl) / 2);
    // The feet stand back from every part of the course (bends bring other stretches close).
    let ok = true;
    for (const side of [-1, 1]) {
      const fx = c.x + across.x * side * span * 0.5;
      const fz = c.z + across.z * side * span * 0.5;
      if (nearestTrack(fx, fz) < Math.min(Wl, Wr) + 10) ok = false;
    }
    if (!ok) continue;
    const wallTop = Math.max(zones.wallHeight(s, -1), zones.wallHeight(s, 1));
    const clear = Math.max(120 + r() * 40, wallTop + 60) + (f.pos.y - c.y);
    made++;
    bigArchAt.push(s);
    tint();
    bigArch.tint = skyline.tint;
    addArch(bigArch, r, {
      centre: c,
      across,
      through: dir,
      span,
      clear,
      legThick,
      crownThick: 40 + r() * 14,
      legDepth: 64,
      crownDepth: 50,
      steps: low ? 20 : 34,
      around: 8,
      blocky: true,
    });
    for (const side of [-1, 1]) {
      const bx = c.x + across.x * side * (span / 2 + 45);
      const bz = c.z + across.z * side * (span / 2 + 45);
      archFeet.push({ x: bx, z: bz }, { x: c.x + across.x * side * span * 0.5, z: c.z + across.z * side * span * 0.5 });
      tint();
      bigArch.tint = skyline.tint;
      addMesa(bigArch, r, {
        x: bx,
        z: bz,
        ground: c.y,
        height: clear + 50 + r() * 110,
        radius: 46 + r() * 16,
        elong: 1.5 + r() * 0.4,
        rot: Math.atan2(dir.z, dir.x) + (r() - 0.5) * 0.4,
        seg: Math.round(12 * segScale),
        kind: 'butte',
      });
      const sx = bx + across.x * side * 90 + dir.x * (r() - 0.5) * 120;
      const sz = bz + across.z * side * 90 + dir.z * (r() - 0.5) * 120;
      archFeet.push({ x: sx, z: sz });
      spireCluster(bigArch, sx, sz, 1, 1.15, Math.round(9 * segScale));
    }
  }

  // The spire forest: clusters of slender columns just behind the canyon walls on both sides, all along the course,
  // rising high above the rim. Not in the slot canyons (their walls hide everything) and not where the side is open.
  const near = new Map<number, RockBuilder>();
  const nearAt = (s: number) => {
    const k = Math.floor(s / NEAR_CHUNK);
    let nb = near.get(k);
    if (!nb) near.set(k, (nb = new RockBuilder()));
    return nb;
  };
  const nearPlaced: { x: number; z: number }[] = [];
  const nearStep = low ? 220 : quality === 'medium' ? 160 : 120;
  for (let s = 60; s < track.length - 60; s += nearStep * (0.7 + r() * 0.6)) {
    if (zones.slots.some((o) => s > o.s0 - 40 && s < o.s1 + 40)) continue;
    const f = track.frameAt(s);
    const flatRight = f.right.clone().setY(0).normalize();
    // Mostly where the canyon opens up (deep walls hide what is behind them).
    const open = zones.openness(s);
    for (const side of [-1, 1] as const) {
      if (r() > 0.3 + 0.65 * open) continue;
      const W = zones.wallOffset(s, side);
      if (!Number.isFinite(W)) continue;
      const dist = W + 40 + r() * r() * 380;
      const x = f.pos.x + flatRight.x * side * dist + f.tangent.x * (r() - 0.5) * 80;
      const z = f.pos.z + flatRight.z * side * dist + f.tangent.z * (r() - 0.5) * 80;
      // Clear of the whole corridor (bends bring other parts of the course close) and of each other.
      if (nearestTrack(x, z) < Math.max(W + 40, dist * 0.8)) continue;
      if (blocked(x, z, 40) || nearPlaced.some((p) => Math.hypot(p.x - x, p.z - z) < 85)) continue;
      if (archFeet.some((p) => Math.hypot(p.x - x, p.z - z) < 120)) continue;
      nearPlaced.push({ x, z });
      const h = zones.wallHeight(s, side);
      const sc = 0.7 + r() * 0.35;
      spireCluster(nearAt(s), x, z, sc, Math.max(1, (h + 120) / (285 * sc)), Math.round(9 * segScale), 0.9, Math.min(ground, f.pos.y - 8));
    }
  }

  // Stepped mesas close by where the canyon opens: flat tops and ledges just over the low rim, like the plateaus on
  // the right of the concept art, with the spire forest behind and between them.
  const mesaStep = low ? 900 : 550;
  for (let s = 200; s < track.length - 200; s += mesaStep * (0.7 + r() * 0.6)) {
    if (zones.openness(s) < 0.5) continue;
    const side = r() < 0.5 ? -1 : 1;
    const W = zones.wallOffset(s, side);
    if (!Number.isFinite(W)) continue;
    const f = track.frameAt(s);
    const flatRight = f.right.clone().setY(0).normalize();
    const rad = 45 + r() * 40;
    const dist = W + 40 + rad * 1.3 + r() * 120;
    const x = f.pos.x + flatRight.x * side * dist;
    const z = f.pos.z + flatRight.z * side * dist;
    if (nearestTrack(x, z) < W + 30 + rad * 1.25 || blocked(x, z, rad * 1.3)) continue;
    if (archFeet.some((p) => Math.hypot(p.x - x, p.z - z) < 120 + rad)) continue;
    nearPlaced.push({ x, z });
    tint();
    const nb = nearAt(s);
    nb.tint = skyline.tint;
    addMesa(nb, r, {
      x,
      z,
      ground: Math.min(ground, f.pos.y - 8),
      height: zones.wallHeight(s, side) + 40 + r() * 70,
      radius: rad,
      elong: 1.4 + r() * 0.8,
      rot: Math.atan2(f.tangent.z, f.tangent.x) + (r() - 0.5) * 0.6,
      seg: Math.round(16 * segScale),
      kind: 'mesa',
    });
  }

  for (const layer of LAYERS) {
    const sc = layer.scale;
    const seg = (n: number) => Math.max(7, Math.round(n * segScale * (layer.near > 1200 ? 0.65 : 1)));
    // Spire clusters: one to four needles around a shared rubble mound.
    for (let i = 0; i < Math.round(layer.spires * density); i++) {
      const spot = findSpot(layer, 60 * sc, 1.1);
      if (!spot) continue;
      placed.push({ x: spot.x, z: spot.z, rad: 60 * sc });
      spireCluster(skyline, spot.x, spot.z, sc, 1, seg(9), layer.near > 1200 ? 0.6 : 1);
    }
    for (let i = 0; i < Math.round(layer.buttes * density); i++) {
      const rad = (35 + r() * 35) * sc;
      const spot = findSpot(layer, rad * 1.75, 0.9);
      if (!spot) continue;
      placed.push({ x: spot.x, z: spot.z, rad: rad * 1.75 });
      tint();
      addMesa(skyline, r, {
        x: spot.x,
        z: spot.z,
        ground,
        height: (130 + r() * 120) * sc,
        radius: rad,
        elong: 1 + r() * 0.8,
        rot: r() * Math.PI,
        seg: seg(20),
        kind: 'butte',
      });
    }
    for (let i = 0; i < Math.round(layer.mesas * density); i++) {
      const rad = (90 + r() * 110) * sc;
      const spot = findSpot(layer, rad * 1.35, 0.75);
      if (!spot) continue;
      const near = nearestPt;
      placed.push({ x: spot.x, z: spot.z, rad: rad * 1.35 });
      tint();
      // Far mesas stretch sideways (square to the line to the nearest part of the course) into long ridges that close
      // the horizon.
      const toward = Math.atan2(spot.z - near.z, spot.x - near.x);
      addMesa(skyline, r, {
        x: spot.x,
        z: spot.z,
        ground,
        height: (110 + r() * 130) * sc * (layer.near > 2000 ? 1.15 : 1),
        radius: rad,
        elong: 1.3 + r() * (layer.near > 1200 ? 1.6 : 0.8),
        rot: toward + Math.PI / 2 + (r() - 0.5) * 0.8,
        seg: seg(30),
        kind: 'mesa',
      });
    }
  }

  // Haze silhouettes: many more spire clusters out to ~2.6 km, cheap (four-sided columns of two or three drums), so
  // layer after layer of needles recedes into the orange haze behind the near ones.
  const haze: Layer[] = [
    { near: 450, far: 1100, spires: low ? 10 : 26, buttes: 0, mesas: 0, scale: 1.15 },
    { near: 1100, far: 2600, spires: low ? 10 : 30, buttes: 0, mesas: 0, scale: 1.6 },
  ];
  for (const layer of haze) {
    for (let i = 0; i < Math.round(layer.spires * B); i++) {
      const sc = layer.scale * (0.8 + r() * 0.4);
      const spot = findSpot(layer, 40 * sc, 0.8);
      if (!spot) continue;
      placed.push({ x: spot.x, z: spot.z, rad: 40 * sc });
      const n = 2 + Math.floor(r() * 3);
      const main = (170 + r() * 170) * sc;
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2;
        const off = k === 0 ? 0 : (12 + r() * 30) * sc;
        tint();
        addBlockSpire(skyline, r, {
          x: spot.x + Math.cos(a) * off,
          z: spot.z + Math.sin(a) * off,
          ground,
          height: k === 0 ? main : main * (0.4 + r() * 0.5),
          radius: (k === 0 ? 15 + r() * 8 : 9 + r() * 8) * sc,
          seg: 4 + Math.floor(r() * 2),
          talus: k === 0 ? 0.5 : 0,
          drums: 2 + Math.floor(r() * 2),
        });
      }
    }
  }

  // One or two arches on the skyline, facing the circuit so their openings show against the sky.
  const skyArches = (low ? 1 : 2) * B;
  for (let i = 0; i < skyArches; i++) {
    const layer: Layer = { near: 700, far: 1500, spires: 0, buttes: 0, mesas: 0, scale: 1 };
    const span = 160 + r() * 90;
    const spot = findSpot(layer, span * 0.8, 0.8);
    if (!spot) continue;
    placed.push({ x: spot.x, z: spot.z, rad: span * 0.8 });
    // Through-axis points at the nearest track point, so you look through the opening from the road.
    let best = pts[0];
    let bd = Infinity;
    for (const p of pts) {
      const d = (p.x - spot.x) ** 2 + (p.z - spot.z) ** 2;
      if (d < bd) (bd = d), (best = p);
    }
    const through = new THREE.Vector3(best.x - spot.x, 0, best.z - spot.z).normalize();
    const across = new THREE.Vector3(-through.z, 0, through.x);
    const c = new THREE.Vector3(spot.x, ground, spot.z);
    tint();
    addArch(skyline, r, {
      centre: c,
      across,
      through,
      span,
      clear: 110 + r() * 70,
      legThick: 55 + r() * 20,
      crownThick: 30 + r() * 12,
      legDepth: 45,
      crownDepth: 30,
      steps: low ? 18 : 30,
      around: low ? 7 : 10,
    });
    // The rock masses the arch grows out of: a tall butte under one foot, a lower one under the other.
    for (const side of [-1, 1]) {
      const tall = side === (r() < 0.5 ? -1 : 1);
      addMesa(skyline, r, {
        x: c.x + across.x * side * (span / 2 + 25),
        z: c.z + across.z * side * (span / 2 + 25),
        ground,
        height: tall ? 150 + r() * 60 : 60 + r() * 40,
        radius: 45 + r() * 15,
        elong: 1.4,
        rot: Math.atan2(through.z, through.x),
        seg: Math.round(14 * segScale),
        kind: 'butte',
      });
    }
  }

  const group = new THREE.Group();
  group.name = 'landmarks';
  group.userData.bigArches = bigArchAt;
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const skyMat = createRockMaterial(theme);
  const skyGeo = skyline.geometry();
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.name = 'landmarks-skyline';
  geos.push(skyGeo);
  mats.push(skyMat);
  group.add(skyMesh);

  if (bigArch.pos.length) {
    const g = bigArch.geometry();
    const m = new THREE.Mesh(g, skyMat);
    m.name = 'landmarks-big-arches';
    m.castShadow = true;
    geos.push(g);
    group.add(m);
  }

  const nearMat = createRockMaterial(theme);
  mats.push(nearMat);
  for (const [k, nb] of near) {
    if (!nb.pos.length) continue;
    const g = nb.geometry();
    const m = new THREE.Mesh(g, nearMat);
    m.name = `landmarks-spires-${k}`;
    geos.push(g);
    group.add(m);
  }

  if (zones.arch) {
    const ab = new RockBuilder();
    buildTrackArch(ab, rng(track.def.seed * 31 + 7), track, zones.arch, low);
    const archGeo = ab.geometry();
    const archMat = createRockMaterial(theme);
    const arch = new THREE.Mesh(archGeo, archMat);
    arch.name = 'landmarks-arch';
    arch.castShadow = true;
    arch.receiveShadow = true;
    geos.push(archGeo);
    mats.push(archMat);
    group.add(arch);
  }

  return {
    object: group,
    dispose: () => {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
};

/** The great arch over the road: legs planted beyond the road edges, rubble buttresses around their feet. */
function buildTrackArch(b: RockBuilder, r: () => number, track: Track, arch: NonNullable<Zones['arch']>, low: boolean) {
  const f = track.frameAt(arch.s);
  const through = f.tangent.clone().setY(0).normalize();
  const across = new THREE.Vector3(-through.z, 0, through.x);
  const half = f.width / 2;
  const legThick = 34;
  // Foot centres sit so the inner face of each leg is well clear of the road edge (+4 m and more).
  const span = Math.max(arch.span, f.width + 2 * (4 + legThick * 0.6) + 8);
  // The road may be banked or climbing: use the lower edge as ground so neither foot floats.
  const ground = Math.min(f.pos.y - f.right.y * half, f.pos.y + f.right.y * half) - 1;
  const centre = new THREE.Vector3(f.pos.x, ground, f.pos.z);
  addArch(b, r, {
    centre,
    across,
    through,
    span,
    clear: arch.height + (f.pos.y - ground),
    legThick,
    crownThick: 18 + r() * 5,
    legDepth: 40,
    crownDepth: 28,
    steps: low ? 22 : 40,
    around: low ? 8 : 12,
  });
  // Buttresses: a tall rock mass behind each foot (away from the road), stretched along the track.
  for (const side of [-1, 1]) {
    const rad = 16 + r() * 6;
    const dist = Math.max(span / 2 + 18, half + 6 + rad * 2.1);
    addMesa(b, r, {
      x: centre.x + across.x * side * dist,
      z: centre.z + across.z * side * dist,
      ground,
      height: 30 + r() * 30,
      radius: rad,
      elong: 1.6,
      rot: Math.atan2(through.z, through.x),
      seg: low ? 9 : 14,
      kind: 'butte',
    });
  }
}

interface KeepOut {
  test(x: number, z: number, rad: number): boolean;
}

/** Areas the skyline must leave alone: the mesa city, waterfalls, the river corridor below gorge bridges, the arch. */
function keepOutAreas(track: Track, zones: Zones): KeepOut[] {
  const out: KeepOut[] = [];
  const circle = (x: number, z: number, R: number): KeepOut => ({ test: (px, pz, rad) => Math.hypot(px - x, pz - z) < R + rad });
  if (zones.city) out.push(circle(zones.city.pos.x, zones.city.pos.z, zones.city.radius + 260));
  for (const w of zones.waterfalls) out.push(circle(w.top.x, w.top.z, 160));
  if (zones.arch) {
    const p = track.frameAt(zones.arch.s).pos;
    out.push(circle(p.x, p.z, 220));
  }
  // The river runs across the track under each gorge bridge: keep a corridor open out to 1.6 km either side.
  for (const g of zones.gorges) {
    const f = track.frameAt((g.s0 + g.s1) / 2);
    const o = f.pos.clone();
    const dir = f.right.clone().setY(0).normalize();
    out.push({
      test: (px, pz, rad) => {
        const dx = px - o.x;
        const dz = pz - o.z;
        const along = dx * dir.x + dz * dir.z;
        const side = Math.abs(dx * dir.z - dz * dir.x);
        return Math.abs(along) < 1600 && side < 140 + rad;
      },
    });
  }
  return out;
}
