// The skyline: distant mesas, buttes and needle spires ringing the circuit in depth layers from ~300 m to ~3 km out,
// one or two arches on the horizon, and the great natural arch the racers fly under (zones.arch). Placement keeps
// clear of the canyon walls, the mesa city, the waterfalls and the river below the gorge bridge (see zones.ts).
// Everything distant is merged into one faceted mesh (one draw call, no shadows); the track arch is its own mesh so
// it can cast its shadow across the road.

import * as THREE from 'three';
import { rng, type Track } from '../core/track';
import { addArch, addMesa, addSpire, RockBuilder } from './landmarkGeometry';
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
  { near: 300, far: 650, spires: 6, buttes: 6, mesas: 2, scale: 1 },
  { near: 650, far: 1300, spires: 6, buttes: 7, mesas: 7, scale: 1.35 },
  { near: 1300, far: 2200, spires: 4, buttes: 4, mesas: 11, scale: 1.8 },
  { near: 2200, far: 3200, spires: 0, buttes: 2, mesas: 13, scale: 2.4 },
];

export const buildLandmarks: WorldBuilder = (ctx) => {
  const { track, theme, quality } = ctx;
  const zones = zonesFor(track);
  const r = rng(track.def.seed * 13 + 101);
  const low = quality === 'low';
  const density = low ? 0.55 : quality === 'medium' ? 0.8 : 1;
  const segScale = low ? 0.6 : 1;

  // Track footprint for distance queries (every ~8 m), and the general ground level.
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < track.frames.length; i += 4) pts.push(track.frames[i].pos);
  let ground = 0;
  for (const p of pts) ground += p.y;
  ground = ground / pts.length - 6;
  const nearestTrack = (x: number, z: number) => {
    let best = Infinity;
    for (const p of pts) {
      const dx = p.x - x;
      const dz = p.z - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  const keepOut = keepOutAreas(track, zones);
  const blocked = (x: number, z: number, rad: number) => keepOut.some((k) => k.test(x, z, rad));

  const centre = track.bounds.getCenter(new THREE.Vector3());
  const size = track.bounds.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.z) / 2;

  const placed: { x: number; z: number; rad: number }[] = [];
  /** Random spot whose nearest track distance is inside [near, far] (after allowing for the rock's own footprint). */
  const findSpot = (layer: Layer, rad: number, spacing: number): { x: number; z: number; d: number } | null => {
    for (let tries = 0; tries < 60; tries++) {
      const a = r() * Math.PI * 2;
      const dist = Math.sqrt(r()) * (extent + layer.far + 200);
      const x = centre.x + Math.cos(a) * dist;
      const z = centre.z + Math.sin(a) * dist;
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

  const spireCluster = (x: number, z: number, sc: number, tall: number, seg: number) => {
    const n = 1 + Math.floor(r() * 3.2);
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2;
      const off = k === 0 ? 0 : (20 + r() * 35) * sc;
      tint();
      addSpire(skyline, r, {
        x: x + Math.cos(a) * off,
        z: z + Math.sin(a) * off,
        ground,
        height: (k === 0 ? 200 + r() * 160 : 100 + r() * 130) * sc * tall,
        radius: (k === 0 ? 13 + r() * 8 : 8 + r() * 7) * sc * Math.sqrt(tall),
        seg,
      });
    }
  };

  // Hero needles first: where the road bends, the view straight ahead leaves the canyon and lands on open desert a
  // few hundred metres out. Towering spires there are what you see framed between the walls, as in the concept art.
  const heroes = Math.round((low ? 4 : 7) * density);
  const heroLayer: Layer = { near: 280, far: 800, spires: 0, buttes: 0, mesas: 0, scale: 1 };
  const step = track.length / 24;
  const offset = r() * step;
  for (let i = 0, made = 0; i < 24 && made < heroes; i++) {
    const s = offset + i * step * 2.3;
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
      spireCluster(x, z, 1, 1.6, Math.round(10 * segScale));
      made++;
      break;
    }
  }

  for (const layer of LAYERS) {
    const sc = layer.scale;
    const seg = (n: number) => Math.max(7, Math.round(n * segScale * (layer.near > 1200 ? 0.65 : 1)));
    // Spire clusters: one to four needles around a shared rubble mound.
    for (let i = 0; i < Math.round(layer.spires * density); i++) {
      const spot = findSpot(layer, 60 * sc, 1.1);
      if (!spot) continue;
      placed.push({ x: spot.x, z: spot.z, rad: 60 * sc });
      spireCluster(spot.x, spot.z, sc, 1, seg(9));
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
      placed.push({ x: spot.x, z: spot.z, rad: rad * 1.35 });
      tint();
      // Far mesas stretch sideways (along the ring around the circuit) into long ridges that close the horizon.
      const toward = Math.atan2(spot.z - centre.z, spot.x - centre.x);
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

  // One or two arches on the skyline, facing the circuit so their openings show against the sky.
  const skyArches = low ? 1 : 2;
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
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const skyMat = createRockMaterial(theme);
  const skyGeo = skyline.geometry();
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.name = 'landmarks-skyline';
  geos.push(skyGeo);
  mats.push(skyMat);
  group.add(skyMesh);

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
  const legThick = 28;
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
