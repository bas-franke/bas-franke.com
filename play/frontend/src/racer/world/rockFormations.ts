// The rocks that shape the course, in the terrain's sandstone shader so they read as part of the canyon:
// - the boulder walls along both edges of the corridor (where the physics walls are): rounded boulders, blocks, and
//   now and then a hoodoo or a spire, bigger and more crowded in the narrow passes, low in front of the grandstands;
// - the formations on the course (track.obstacles, the same circles physics and the AI use): blocky ridges that grow
//   out of the walls, boulder heaps, hoodoo pillars with cap rocks, and buttes topped with a spire;
// - the caves: a rock hill the course runs through, a hall of blocky rock inside with jagged skylights (god rays,
//   pools of light and the bright mouths in caveLight.ts), and over each tunnel shortcut's lane a tight lumpy tube
//   with cool light in its crevices, embers and a glowing exit;
// - the shortcut ridges and the slot walls, laid square to the course so their gaps look as narrow as they are.
// Rocks are a handful of instanced shapes (one draw call each); each cave is two meshes plus its light effects.

import * as THREE from 'three';
import { ROOF_CLEAR, TUNNEL_DEPTH, rng, type Shortcut, type Track } from '../core/track';
import type { TerrainField } from './terrainField';
import { buildCaveFx, CaveRockBuilder, createCaveRockMaterial, type EmberSpot, type Mouth, type Shaft } from './caveLight';
import { sunDirection } from './sky';
import { GeoBuilder } from './terrainGeo';
import { hash2, noise1, noise2 } from './terrainNoise';
import { onBridge } from './trackBarriers';
import type { Quality } from './types';
import { zonesFor } from './zones';

/** Rock classes for the terrain shader's aRock: edge boulders (dark desert varnish) and course formations (warm, with
 * pale caps), so both stand out from the canyon walls behind them. */
export const ROCK_EDGE = 2;
export const ROCK_COURSE = 3;

/** Bakes the shader attributes: rock of a class, darker towards the foot. Base at y = 0, top at about y = 1. */
function finish(g: THREE.BufferGeometry, cls = ROCK_EDGE): THREE.BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  flat.computeVertexNormals();
  const p = flat.attributes.position;
  const n = p.count;
  const shade = new Float32Array(n);
  for (let i = 0; i < n; i++) shade[i] = 0.62 + 0.38 * THREE.MathUtils.clamp(p.getY(i) / 0.8, 0, 1);
  flat.setAttribute('aRock', new THREE.Float32BufferAttribute(new Float32Array(n).fill(cls), 1));
  flat.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
  flat.computeBoundingSphere();
  return flat;
}

/** A rounded, faceted boulder of unit radius, sunk a little into the sand. */
function boulderShape(seed: number, detail: number, cls: number) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const planes = [0, 1, 2, 3].map((k) => new THREE.Vector3(Math.sin(k * 2.3 + seed), Math.cos(k * 1.7 + seed) * 0.6, Math.cos(k * 2.9 - seed)).normalize());
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + (noise2(v.x * 1.9 + seed, v.z * 1.9 + v.y * 1.5) - 0.5) * 0.4);
    for (const pl of planes) {
      const d = v.dot(pl);
      if (d > 0.8) v.addScaledVector(pl, 0.8 - d);
    }
    p.setXYZ(i, v.x, (Math.max(v.y, -0.6) + 0.35) / 1.35, v.z);
  }
  return finish(g, cls);
}

/** A weathered sandstone block, 2 x 1 x 2 (unit half-width), tapering up, with ledges and a lumpy top. */
function blockShape(seed: number, cls: number) {
  const g = new THREE.BoxGeometry(2, 1, 2, 3, 5, 3);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const y = p.getY(i) + 0.5;
    // Same displacement for every copy of a corner, so the faces stay closed.
    const k = (1 - 0.2 * y) * (1 + (noise2(x * 1.3 + seed, z * 1.3 + y * 2.1) - 0.5) * 0.35) * (1 - 0.07 * (Math.floor(y * 3.2) % 2));
    const top = y > 0.99 ? (noise2(x * 2 + seed, z * 2) - 0.5) * 0.16 : 0;
    p.setXYZ(i, x * k, y + top, z * k);
  }
  return finish(g, cls);
}

/** A hoodoo: a pinched, tapering column of unit base radius with a wider, flat cap rock on top. */
function hoodooShape(seed: number, cls: number) {
  const prof: THREE.Vector2[] = [];
  const steps = 9;
  for (let k = 0; k <= steps; k++) {
    const y = (k / steps) * 0.86;
    const pinch = 0.12 * Math.sin((y / 0.86) * Math.PI * 2.5 + seed) ** 2;
    prof.push(new THREE.Vector2(Math.max(0.2, 1 - 0.55 * (y / 0.86) - pinch), y));
  }
  prof.push(new THREE.Vector2(0.62, 0.87), new THREE.Vector2(0.68, 0.94), new THREE.Vector2(0.55, 1), new THREE.Vector2(0.001, 1.01));
  const g = new THREE.LatheGeometry(prof, 8);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + (noise2(Math.atan2(z, x) * 1.6 + seed, y * 4) - 0.5) * 0.3;
    p.setXYZ(i, x * k, y, z * k);
  }
  return finish(g, cls);
}

/** A tall, crooked spire of unit base radius. */
function spireShape(seed: number, cls: number) {
  const prof: THREE.Vector2[] = [];
  for (let k = 0; k <= 8; k++) {
    const y = k / 8;
    prof.push(new THREE.Vector2(Math.max(0.001, (1 - y) ** 0.8 * (1 - 0.1 * Math.sin(y * 9 + seed))), y));
  }
  const g = new THREE.LatheGeometry(prof, 7);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const k = 1 + (noise2(p.getX(i) * 2 + seed, p.getZ(i) * 2 + y * 3) - 0.5) * 0.35;
    p.setXYZ(i, p.getX(i) * k + Math.sin(seed) * 0.25 * y * y, y, p.getZ(i) * k);
  }
  return finish(g, cls);
}

type Shape = 'boulder' | 'block' | 'hoodoo' | 'spire';
type Key = `${'edge' | 'course'}-${Shape}`;

export function buildFormations(track: Track, field: TerrainField, quality: Quality, mat: THREE.Material) {
  const r = rng(track.def.seed * 41 + 13);
  const zones = zonesFor(track);
  const lists: Partial<Record<Key, THREE.Matrix4[]>> = {};
  let cls: 'edge' | 'course' = 'edge';
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const sc = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const place = (shape: Shape, p: THREE.Vector3, rad: number, h: number, tilt = 0.12) => {
    e.set((r() - 0.5) * tilt, r() * Math.PI * 2, (r() - 0.5) * tilt);
    q.setFromEuler(e);
    (lists[`${cls}-${shape}`] ??= []).push(m.compose(p, q, sc.set(rad * (0.9 + r() * 0.25), h, rad * (0.9 + r() * 0.25))).clone());
  };
  const step = track.length / (field.n - 1);
  /** Ground point at track distance s, lateral offset x (beyond the corridor the loose sand's height). */
  const ground = (s: number, x: number, out: THREE.Vector3) => {
    const i = Math.max(0, Math.min(field.n - 1, Math.round(s / step)));
    const side = x < 0 ? -1 : 1;
    const ad = Math.abs(x);
    const px = field.posX[i] + field.rx[i] * x;
    const pz = field.posZ[i] + field.rz[i] * x;
    const y = ad < field.x0[i] ? track.toWorld(s, x, 0).y : field.groundY(i, side, ad, px, pz);
    return out.set(px, y - 0.3, pz);
  };

  const tunnels = track.shortcuts.filter((c) => c.kind === 'tunnel');
  /** The tunnel shortcut whose roofed stretch s is in (with a margin), on that side. */
  const roofed = (s: number, side: number, margin: number) => tunnels.some((c) => c.side === side && s > c.roof0 - margin && s < c.roof1 + margin);

  // Boulder walls along the edges.
  const density = quality === 'low' ? 0.6 : 1;
  for (const side of [-1, 1] as const) {
    let s = 2;
    while (s < track.length - 2) {
      const f = track.frameAt(s);
      const hw = f.width / 2;
      const stand = zones.stands.some((st) => st.side === side && s > st.s0 - 10 && s < st.s1 + 10);
      // Not inside the caves, nor beside a tunnel's tube (the tube is the wall there).
      if (onBridge(track, zones, s, 6) || track.inCave(s, -6) || roofed(s, side, 6)) {
        s += 4;
        continue;
      }
      // Narrow passes get bigger, more crowded rocks. Tall ones only where there is room in front of the canyon wall:
      // a spire cutting into the cliff behind it looks see-through.
      const fi = Math.max(0, Math.min(field.n - 1, Math.round(s / step)));
      const room = field.W[side < 0 ? 0 : 1][fi] - field.x0[fi];
      const tight = THREE.MathUtils.clamp(70 / f.width, 0.8, 1.6);
      let big = !stand && r() < 0.12;
      let rad = stand ? 1.2 + r() * 0.8 : (big ? 4.5 + r() * 3.5 : 2 + r() * 2.6) * tight;
      if (big && room < rad * 2.4) {
        big = false;
        rad = Math.min(rad, 4.5);
      }
      ground(s, side * (hw + rad * 0.85 + r() * 1.2), pos);
      const pick = r();
      if (stand) place('boulder', pos, rad, rad * 0.8);
      else if (big) place(pick < 0.4 ? 'spire' : pick < 0.7 ? 'hoodoo' : 'block', pos, rad, rad * (pick < 0.4 ? 3 + r() * 1.5 : 1.8 + r() * 1.2));
      else if (pick < 0.62) place('boulder', pos, rad, rad * (0.65 + r() * 0.45), 0.4);
      else place('block', pos, rad, rad * (0.8 + r() * 0.9));
      // A second, taller row behind now and then, so the edge has depth.
      if (!stand && r() < 0.35 * density && room > rad * 3.5) {
        const rad2 = rad * (1.2 + r() * 0.6);
        ground(s + (r() - 0.5) * 4, side * (hw + rad * 1.6 + rad2 * 0.6), pos);
        place(r() < 0.7 ? 'block' : 'boulder', pos, rad2, rad2 * (1 + r() * 1.2));
      }
      s += rad * (1.05 + r() * 0.6) / density;
    }
  }

  /** A block turned square to the course: `across` and `along` are half sizes (the shape is about 1.17 at its base). */
  const square = (p: THREE.Vector3, s: number, across: number, along: number, h: number) => {
    const t = track.frameAt(s).tangent;
    e.set((r() - 0.5) * 0.04, Math.atan2(t.x, t.z), (r() - 0.5) * 0.04);
    q.setFromEuler(e);
    (lists[`${cls}-block`] ??= []).push(m.compose(p, q, sc.set(across / 1.17, h, along)).clone());
  };

  // Formations on the course.
  cls = 'course';
  for (const o of track.obstacles) {
    track.toWorld(o.s, o.x, -0.5, pos);
    const rad = o.r * 1.12;
    if (o.kind === 'ridge' || o.kind === 'slot') {
      // Standing on the lower ground beside it (the field next to a ledge, the floor beside a tunnel), so it never
      // floats; the slot rocks no wider than their circles, so a slot looks as tight as it is.
      const low = Math.min(track.lift(o.s, o.x - o.r), track.lift(o.s, o.x + o.r));
      const drop = track.lift(o.s, o.x) - low;
      pos.y -= drop;
      if (o.kind === 'ridge') {
        // Under a tunnel's roof the tube's own wall is the ridge.
        if (roofed(o.s, Math.sign(o.x), -3)) continue;
        square(pos, o.s, o.r * 1.05, 3.4 + r() * 0.8, o.h + drop + r() * 3);
        if (r() < 0.3) place('boulder', pos.clone().setY(pos.y + o.h + drop - 0.5), o.r * 0.5, o.r * 0.45, 0.5);
      } else {
        square(pos, o.s, o.r * 0.97, 3 + r() * 1.5, o.h + r() * 4);
      }
    } else if (o.kind === 'spur') {
      place('block', pos, rad, o.h + 0.5);
      // Rubble at its foot, and near the wall an extra tower so the ridge reads as part of the wall.
      if (r() < 0.6) place('boulder', track.toWorld(o.s + (r() - 0.5) * o.r * 2, o.x + (r() - 0.5) * o.r, -0.4, new THREE.Vector3()), o.r * 0.45, o.r * 0.4, 0.5);
      if (o.t < 0.25) place('block', track.toWorld(o.s + (r() - 0.5) * 3, o.x + o.side * o.r * 0.6, -0.5, new THREE.Vector3()), rad * 0.8, o.h * 1.35);
    } else if (o.kind === 'island') {
      place('block', pos, rad, o.h + 0.5);
      if (o.t === 0) place('spire', pos.clone().setY(pos.y + o.h * 0.85), o.r * 0.45, o.h * 0.7, 0.05);
    } else if (o.kind === 'pillar') {
      place('hoodoo', pos, rad, o.h + 0.5, 0.05);
    } else {
      place('boulder', pos, rad, o.h + 0.6, 0.5);
    }
  }

  const meshes: THREE.Object3D[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const fx: { dispose(): void }[] = [];
  cls = 'edge';
  const caveMat = createCaveRockMaterial();
  const roofs: [number, number, Shortcut | undefined][] = [...track.caves.map((c): [number, number, undefined] => [c.s0, c.s1, undefined]), ...tunnels.map((c): [number, number, Shortcut] => [c.roof0, c.roof1, c])];
  for (const [s0, s1, lane] of roofs) {
    const cave = caveGeometry(track, field, s0, s1, (p, rad) => place('block', p, rad, rad * (0.8 + r() * 1.4), 0.3), lane);
    const outer = new THREE.Mesh(cave.outer, mat);
    const inner = new THREE.Mesh(cave.inner, caveMat);
    outer.name = lane ? 'tunnel-hill' : 'cave-hill';
    inner.name = lane ? 'tunnel-rock' : 'cave-rock';
    for (const mesh of [outer, inner]) {
      mesh.castShadow = mesh.receiveShadow = true;
      geos.push(mesh.geometry);
      meshes.push(mesh);
    }
    const lights = buildCaveFx(track, quality, cave.shafts, cave.mouths, cave.embers);
    meshes.push(...lights.meshes);
    fx.push(lights);
  }

  const detail = quality === 'low' ? 0 : 1;
  const shapes: Record<Shape, (c: number) => THREE.BufferGeometry> = {
    boulder: (c) => boulderShape(2.3, detail, c),
    block: (c) => blockShape(5.1, c),
    hoodoo: (c) => hoodooShape(1.4, c),
    spire: (c) => spireShape(3.7, c),
  };
  for (const key of Object.keys(lists) as Key[]) {
    const list = lists[key]!;
    const [c, shape] = key.split('-') as ['edge' | 'course', Shape];
    const geo = shapes[shape](c === 'edge' ? ROCK_EDGE : ROCK_COURSE);
    geos.push(geo);
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = quality !== 'low';
    im.receiveShadow = true;
    im.computeBoundingSphere();
    im.name = `rocks-${key}`;
    meshes.push(im);
  }

  return {
    meshes,
    dispose() {
      for (const g of geos) g.dispose();
      for (const f of fx) f.dispose();
      caveMat.dispose();
    },
  };
}

/** God rays come down this steeply (radians above the horizon), from the sun's side: the real dusk sun is too low. */
const SHAFT_SLANT = 1.08;

/** -0.5..0.5 per block: the rock is broken into blocks `size` m along the course in `bands` bands round the arch,
 * each band's joints offset from its neighbours', so the surface steps in and out in chunky fracture blocks. */
function blockStep(s: number, th: number, size: number, bands: number, seed: number) {
  const band = Math.floor((th / Math.PI) * bands);
  const cell = Math.floor((s + hash2(band, seed) * size) / size);
  return hash2(band * 7.31 + seed, cell * 1.37) - 0.5;
}

const C = (hex: string) => new THREE.Color(hex);
const ROCK_DARK = C('#581815');
const ROCK_RED = C('#8a2a1c');
const ROCK_DUST = C('#a4482a');
const ROCK_LIT = C('#c8642c');
const WARM = new THREE.Color(1.0, 0.42, 0.13);
const VIOLET = new THREE.Color(0.42, 0.16, 0.85);
const BLUE = new THREE.Color(0.1, 0.24, 1.0);
const EXIT = new THREE.Color(1.0, 0.36, 0.08);

/**
 * A cave from s0 to s1: a hall of blocky rock over the corridor inside (an inner shell in the cave rock material,
 * lit by baked glow) with jagged skylights in its roof, a hill of rock over it outside (in the terrain material, cut
 * through at the skylights, the cuts joined by short chimney walls), and at each end a rough mouth face joining the
 * two. Cross sections use the frame's flat right and world up, so banking does not tilt them. With `lane` it is a
 * tunnel shortcut's roof instead: a tight, lumpy tube over just the sunken lane (no skylights, embers and cool crevice
 * light instead), from the ridge to past the corridor wall.
 */
function caveGeometry(
  track: Track,
  field: TerrainField,
  s0: number,
  s1: number,
  onTop: (p: THREE.Vector3, rad: number) => void,
  lane?: Shortcut,
): { outer: THREE.BufferGeometry; inner: THREE.BufferGeometry; shafts: Shaft[]; mouths: Mouth[]; embers: EmberSpot[] } {
  const b = new GeoBuilder();
  const rock = new CaveRockBuilder();
  const ROWS = lane ? 25 : 33;
  const cols = Math.max(2, Math.round((s1 - s0) / 2.5) + 1);
  const inner = new Float32Array(cols * ROWS * 3);
  const outer = new Float32Array(cols * ROWS * 3);
  const crev = new Float32Array(cols * ROWS);
  const step = track.length / (field.n - 1);
  const sAt = (c: number) => s0 + ((s1 - s0) * c) / (cols - 1);
  const uc = lane ? (lane.xIn + lane.xOut) / 2 : 0;
  const floor = lane ? -TUNNEL_DEPTH : 0;
  const hallH = (s: number) => 25 + noise1(s * 0.02, 2) * 7;
  // Profile at column c, angle index j (0 = right foot, ROWS - 1 = left foot): lateral offset and height over the
  // centre line; for the inner shell also how far the rock is recessed there (0..1, crevices).
  const prof = (c: number, j: number, outside: boolean): [number, number, number] => {
    const s = sAt(c);
    const hw = track.frameAt(s).width / 2;
    const th = (j / (ROWS - 1)) * Math.PI;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    if (lane) {
      // Lane space u = side * x: th = 0 is the corridor wall, th = PI the ridge. The tube hugs the physics walls (the
      // ridge's face, the corridor's edge) and its crown keeps the roof clearance; the rock only bulges outwards.
      const out = ct * lane.side > 0;
      const a = outside ? (out ? lane.xOut + 14 - uc : uc - (lane.xIn - 5)) : out ? lane.xOut + 1.5 - uc : uc - (lane.xIn + 3.3);
      const h = outside ? TUNNEL_DEPTH + ROOF_CLEAR + 6 + noise1(s * 0.02, 9) * 3 : TUNNEL_DEPTH + ROOF_CLEAR + 0.6;
      let disp = 0;
      if (!outside) disp = Math.max(-0.3, blockStep(s, th, 4.5, 9, 3) * 2.4 + (noise2(s * 0.09, th * 3.1) - 0.5) * 2.2 + (noise2(s * 0.4, th * 12) - 0.5) * 0.6);
      else disp = (noise2(s * 0.03, th * 2.7 + 11) - 0.5) * 3;
      const ex = Math.sign(ct) * Math.abs(ct) ** 0.85;
      const ey = st ** 0.8;
      const u = uc + lane.side * (ex * a + ct * disp);
      return [lane.side * u, floor + ey * h + st * disp - 1.2 * (1 - st), THREE.MathUtils.clamp(disp / 2 + 0.3, 0, 1)];
    }
    // The hall: boxy (sheer walls, a high flat-ish roof) and broken into blocks.
    const ex = Math.sign(ct) * Math.abs(ct) ** 0.7;
    const ey = st ** 0.6;
    if (outside) {
      const a = hw + 30 + noise1(s * 0.02, 5) * 8;
      const h = hallH(s) + 11 + noise1(s * 0.015, 9) * 6;
      const k = 1 + (noise2(s * 0.03, th * 2.7 + 11) - 0.5) * 0.24 + (noise2(s * 0.11, th * 8 + 3) - 0.5) * 0.1;
      return [ex * a * k, ey * h * k - 1.2, 0];
    }
    const disp = blockStep(s, th, 8, 11, 1) * 5 + (noise2(s * 0.05, th * 2.7) - 0.5) * 4 + (noise2(s * 0.25, th * 9) - 0.5) * 1.2;
    const a = hw + 7 + Math.abs(ct) * Math.max(-1.5, disp);
    const h = hallH(s) + st * disp;
    return [ex * a, ey * h - 1.2, THREE.MathUtils.clamp(disp / 6 + 0.5, 0, 1)];
  };
  const put = (c: number, x: number, y: number, out: Float32Array, o: number) => {
    const i = Math.max(0, Math.min(field.n - 1, Math.round(sAt(c) / step)));
    out[o] = field.posX[i] + field.rx[i] * x;
    // Sheared with the road's bank, so the tube's feet stay on a banked floor (the section itself stays upright).
    out[o + 1] = field.posY[i] + y + field.slope[i] * x;
    out[o + 2] = field.posZ[i] + field.rz[i] * x;
  };
  for (let c = 0; c < cols; c++) {
    for (let j = 0; j < ROWS; j++) {
      const o = (c * ROWS + j) * 3;
      const [xi, yi, cv] = prof(c, j, false);
      let [xo, yo] = prof(c, j, true);
      // The hill always at least a few metres outside the hall.
      const ri = Math.hypot(xi - (lane ? lane.side * uc : 0), yi - floor);
      const ro = Math.hypot(xo - (lane ? lane.side * uc : 0), yo - floor);
      const min = ri + (lane ? 3.5 : 6);
      if (ro < min) {
        const k = min / Math.max(ro, 1e-3);
        xo = (lane ? lane.side * uc : 0) + (xo - (lane ? lane.side * uc : 0)) * k;
        yo = floor + (yo - floor) * k;
      }
      put(c, xi, yi, inner, o);
      put(c, xo, yo, outer, o);
      crev[c * ROWS + j] = cv;
    }
  }

  // Skylights (halls only): pick where each shaft should land, follow it up towards the sun to the roof, and cut the
  // cells round that point out of both shells.
  const shafts: Shaft[] = [];
  const skylights: Mouth[] = [];
  const holes: { cc: number; jc: number; rc: number; rj: number; land: THREE.Vector3; s: number; x: number }[] = [];
  if (!lane) {
    const sun = sunDirection(track.def.theme);
    const hl = Math.hypot(sun.x, sun.z) || 1;
    const dir = new THREE.Vector3((sun.x / hl) * Math.cos(SHAFT_SLANT), Math.sin(SHAFT_SLANT), (sun.z / hl) * Math.cos(SHAFT_SLANT));
    const len = s1 - s0;
    const n = Math.max(2, Math.floor((len - 70) / 36));
    for (let k = 0; k < n; k++) {
      const sp = s0 + 38 + ((len - 76) * (k + 0.5)) / n + (hash2(s0, k) - 0.5) * 12;
      const f = track.frameAt(sp);
      const hw = f.width / 2;
      const xp = (hash2(k, s0 * 0.1) - 0.5) * hw * 1.2;
      const land = track.toWorld(sp, xp, 0);
      const up = hallH(sp) / dir.y;
      const tl = Math.hypot(f.tangent.x, f.tangent.z) || 1;
      const rl = Math.hypot(f.right.x, f.right.z) || 1;
      const sh = sp + (up * (dir.x * f.tangent.x + dir.z * f.tangent.z)) / tl;
      const xh = xp + (up * (dir.x * f.right.x + dir.z * f.right.z)) / rl;
      if (sh < s0 + 22 || sh > s1 - 22) continue;
      const q = THREE.MathUtils.clamp(Math.abs(xh) / (hw + 7), 0, 0.92) ** (1 / 0.7);
      const th = THREE.MathUtils.clamp(Math.acos(Math.sign(xh) * q), Math.PI * 0.27, Math.PI * 0.73);
      holes.push({ cc: ((sh - s0) / len) * (cols - 1), jc: (th / Math.PI) * (ROWS - 1), rc: 1.8 + hash2(k, 3.3) * 1.6, rj: 1.5 + hash2(k, 5.1) * 1.3, land, s: sp, x: xp });
    }
  }
  const holeAt = (i: number, j: number) =>
    holes.findIndex((h) => ((i + 0.5 - h.cc) / h.rc) ** 2 + ((j + 0.5 - h.jc) / h.rj) ** 2 < 1 + (hash2(i * 1.7, j * 2.3) - 0.5) * 0.9);
  const cut = new Int16Array((cols - 1) * (ROWS - 1)).fill(-1);
  if (holes.length) for (let i = 0; i < cols - 1; i++) for (let j = 0; j < ROWS - 1; j++) cut[i * (ROWS - 1) + j] = holeAt(i, j);
  const isCut = (i: number, j: number) => i >= 0 && j >= 0 && i < cols - 1 && j < ROWS - 1 && cut[i * (ROWS - 1) + j] >= 0;
  const v = new THREE.Vector3();
  for (let hi = 0; hi < holes.length; hi++) {
    // The shaft starts at the middle of the cut in the inner roof and lands on the floor along the sun's slant.
    const top = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < cols - 1; i++) {
      for (let j = 0; j < ROWS - 1; j++) {
        if (cut[i * (ROWS - 1) + j] !== hi) continue;
        const o = (i * ROWS + j) * 3;
        top.x += inner[o];
        top.y += inner[o + 1];
        top.z += inner[o + 2];
        n++;
      }
    }
    if (!n) continue;
    top.multiplyScalar(1 / n);
    const h = holes[hi];
    // And a blaze of sky in the opening at the hill's surface, seen from below through the jagged cut.
    const sky = new THREE.Vector3();
    for (let i = 0; i < cols - 1; i++) {
      for (let j = 0; j < ROWS - 1; j++) {
        if (cut[i * (ROWS - 1) + j] !== hi) continue;
        const o = (i * ROWS + j) * 3;
        sky.x += outer[o];
        sky.y += outer[o + 1];
        sky.z += outer[o + 2];
      }
    }
    sky.multiplyScalar(1 / n);
    const fr = track.frameAt(h.s);
    skylights.push({ center: sky.setY(sky.y + 1.5), normal: new THREE.Vector3(0, -1, 0), across: new THREE.Vector3(fr.right.x, 0, fr.right.z).normalize(), width: h.rj * 4.5, height: h.rc * 3.6, color: new THREE.Color(2.6, 1.7, 0.9), fill: 1 });
    const cell = (s1 - s0) / (cols - 1);
    shafts.push({ top, bottom: h.land.clone(), radius: Math.max(2.5, Math.sqrt((n * cell * 2.6) / Math.PI) * 0.75), s: h.s, x: h.x });
  }

  // Bake the inner shell's albedo and light: the warm key's radiance and where it comes from, and the cool fill.
  const N3 = cols * ROWS * 3;
  const ci = new Float32Array(N3);
  const wi = new Float32Array(N3);
  const coi = new Float32Array(N3);
  const ki = new Float32Array(N3);
  const col = new THREE.Color();
  const warmC = new THREE.Color();
  const coolC = new THREE.Color();
  const key = new THREE.Vector3();
  const seg = new THREE.Line3();
  const near = new THREE.Vector3();
  const xm = lane ? lane.side * uc : 0;
  const mouthAt = (s: number) => track.toWorld(s, xm, lane ? 3 : hallH(s) * 0.35);
  const exitP = mouthAt(s1 + 6);
  const entryP = mouthAt(s0 - 6);
  const addKey = (from: THREE.Vector3, to: THREE.Vector3, w: number) => {
    near.subVectors(to, from);
    const l = near.length();
    if (l > 1e-3) key.addScaledVector(near, w / l);
  };
  for (let c = 0; c < cols; c++) {
    const s = sAt(c);
    const iy = Math.max(0, Math.min(field.n - 1, Math.round(s / step)));
    for (let j = 0; j < ROWS; j++) {
      const k = c * ROWS + j;
      const o = k * 3;
      const th = (j / (ROWS - 1)) * Math.PI;
      const cv = crev[k];
      const blk = blockStep(s, th, lane ? 4.5 : 8, lane ? 9 : 11, 7) + 0.5;
      v.set(inner[o], inner[o + 1], inner[o + 2]);
      const hgt = v.y - field.posY[iy] - field.slope[iy] * (field.rx[iy] * (v.x - field.posX[iy]) + field.rz[iy] * (v.z - field.posZ[iy])) - floor;
      col.copy(ROCK_DARK).lerp(ROCK_RED, 0.3 + 0.6 * blk * (1 - 0.6 * cv));
      if (hgt < 4) col.lerp(ROCK_DUST, 0.5 * (1 - hgt / 4));
      key.set(0, 0, 0);
      const dExit = Math.max(0, s1 - s);
      const dEntry = Math.max(0, s - s0);
      let warm: number;
      if (lane) {
        // Lit red from the glowing exit (and a little from the way in), cool blue in the crevices and low on the walls.
        const low = 1 - THREE.MathUtils.smoothstep(hgt, 1, 5);
        const ex = 0.6 + 2.6 * Math.max(0, 1 - dExit / 80) ** 2;
        const en = 0.25 + 1.0 * Math.max(0, 1 - dEntry / 40) ** 2;
        addKey(v, exitP, ex);
        addKey(v, entryP, en);
        warm = (ex + en) * (1 - 0.5 * cv);
        warmC.copy(col).multiply(EXIT).multiplyScalar(warm * 0.75);
        coolC.copy(BLUE).multiplyScalar(0.015 + 0.42 * cv ** 2 + 0.12 * low);
      } else {
        // Warm from the shafts (towards the nearest point of each) and the mouths, violet fill in the recesses.
        warm = 0;
        for (const sh of shafts) {
          seg.set(sh.top, sh.bottom);
          seg.closestPointToPoint(v, true, near.set(0, 0, 0));
          const lp = near.clone();
          const w = Math.exp(-((lp.distanceTo(v) / (sh.radius * 3.2)) ** 2)) * 1.0 + Math.exp(-((v.distanceTo(sh.bottom) / 18) ** 2)) * 0.5;
          addKey(v, lp, w);
          warm += w;
        }
        const ex = 0.05 + 1.3 * Math.max(0, 1 - dExit / 45) ** 2;
        const en = 0.03 + 0.9 * Math.max(0, 1 - dEntry / 35) ** 2;
        addKey(v, exitP, ex);
        addKey(v, entryP, en);
        warm = Math.min(1.8, warm) + ex + en;
        warmC.copy(col).multiply(WARM).multiplyScalar(warm * 1.3);
        coolC.copy(VIOLET).multiplyScalar(0.04 + 0.12 * cv);
      }
      col.toArray(ci, o);
      warmC.toArray(wi, o);
      coolC.toArray(coi, o);
      key.toArray(ki, o);
    }
  }
  rock.grid(inner, cols, ROWS, ci, wi, coi, ki, isCut);

  // Outer shell in the terrain material, with the skylight cells left out.
  const i0 = b.idx.length;
  b.addGrid(outer, cols, ROWS, 1, 1, 1);
  if (holes.length) {
    const keep: number[] = b.idx.slice(0, i0);
    for (let i = 0; i < cols - 1; i++) for (let j = 0; j < ROWS - 1; j++) if (!isCut(i, j)) keep.push(...b.idx.slice(i0 + (i * (ROWS - 1) + j) * 6, i0 + (i * (ROWS - 1) + j) * 6 + 6));
    b.idx = keep;
    // Chimney walls round each cut, from the inner shell's edge to the hill's, sunlit warm rock.
    const cIn = new THREE.Color();
    const gIn = new THREE.Color();
    const cool = new THREE.Color(0.02, 0.01, 0.04);
    const kIn = new THREE.Vector3();
    for (let i = 0; i < cols - 1; i++) {
      for (let j = 0; j < ROWS - 1; j++) {
        if (!isCut(i, j)) continue;
        const edges: [number, number, number, number][] = [];
        if (!isCut(i - 1, j)) edges.push([i, j, i, j + 1]);
        if (!isCut(i + 1, j)) edges.push([i + 1, j, i + 1, j + 1]);
        if (!isCut(i, j - 1)) edges.push([i, j, i + 1, j]);
        if (!isCut(i, j + 1)) edges.push([i, j + 1, i + 1, j + 1]);
        for (const [a1, b1, a2, b2] of edges) {
          const p = (a1 * ROWS + b1) * 3;
          const q = (a2 * ROWS + b2) * 3;
          const jag = (hash2(a1 + a2 * 0.3, b1 + b2 * 0.7) - 0.5) * 1.6;
          cIn.copy(ROCK_LIT).lerp(ROCK_RED, hash2(a1, b2));
          // Sunlit from above: the key straight down the chimney.
          gIn.copy(cIn).multiply(WARM).multiplyScalar(1.1);
          kIn.set(0, 1, 0);
          const A = rock.vertex(inner[p], inner[p + 1] + jag, inner[p + 2], cIn, gIn, cool, kIn);
          const B = rock.vertex(inner[q], inner[q + 1] + jag, inner[q + 2], cIn, gIn, cool, kIn);
          gIn.multiplyScalar(1.8);
          const Bo = rock.vertex(outer[q], outer[q + 1], outer[q + 2], cIn, gIn, cool, kIn);
          const Ao = rock.vertex(outer[p], outer[p + 1], outer[p + 2], cIn, gIn, cool, kIn);
          rock.quad(A, B, Bo, Ao);
        }
      }
    }
  }
  // Blocks broken loose on the hill, so its outline is not a smooth dome (not over the skylights).
  for (let c = 0; c < cols; c += 3) {
    for (const j of lane ? [4, 9, 14, 19] : [4, 9, 14, 19, 24, 28]) {
      if (isCut(c, j) || isCut(c - 2, j) || isCut(c + 2, j) || isCut(c, j - 2) || isCut(c, j + 2)) continue;
      const o = (c * ROWS + j) * 3;
      if (noise2(c * 0.7, j * 0.9) > 0.55) onTop(v.set(outer[o], outer[o + 1] - 2, outer[o + 2]), 5 + noise2(c, j) * 7);
    }
  }

  // Mouths: rings from the inner arch out to the hill's outline, and a glow just outside each one, facing in.
  const RINGS = 5;
  const mouths: Mouth[] = skylights;
  for (const [c, dir] of [[0, -1], [cols - 1, 1]] as const) {
    const s = sAt(c);
    const f = track.frameAt(s);
    const tx = f.tangent.x;
    const tz = f.tangent.z;
    const tl = Math.hypot(tx, tz) || 1;
    const p = new Float32Array(ROWS * RINGS * 3);
    const sh = new Float32Array(ROWS * RINGS);
    for (let j = 0; j < ROWS; j++) {
      const o = (c * ROWS + j) * 3;
      for (let k = 0; k < RINGS; k++) {
        const u = k / (RINGS - 1);
        const q = (j * RINGS + k) * 3;
        const jitter = k > 0 && k < RINGS - 1 ? (noise2(j * 0.9 + dir * 5, k * 1.3) - 0.5) * 3 : 0;
        // Bulging out of the hill along the course by a few metres between the arch and the outline: a rough brow.
        const back = dir * (Math.sin(u * Math.PI) * 3 + jitter);
        for (let a = 0; a < 3; a++) p[q + a] = inner[o + a] + (outer[o + a] - inner[o + a]) * u;
        p[q] += (tx / tl) * back;
        p[q + 1] += jitter;
        p[q + 2] += (tz / tl) * back;
        sh[j * RINGS + k] = 0.8 + 0.2 * u;
      }
    }
    b.addGrid(p, ROWS, RINGS, dir > 0 ? 1 : -1, 1, sh);
    const exit = dir > 0;
    const hw = f.width / 2;
    const ms = s + dir * 4;
    const x = lane ? lane.side * uc : 0;
    const h = lane ? TUNNEL_DEPTH + ROOF_CLEAR : hallH(s);
    mouths.push({
      center: track.toWorld(ms, x, lane ? 3 : h * 0.42),
      normal: new THREE.Vector3(-tx * dir, 0, -tz * dir).normalize(),
      across: new THREE.Vector3(f.right.x, 0, f.right.z).normalize(),
      width: lane ? (lane.xOut - lane.xIn) / 2 + 5 : (hw + 7) * 1.15,
      height: lane ? h * 0.85 : h * 0.62,
      color: lane ? (exit ? new THREE.Color(3.4, 1.15, 0.3) : new THREE.Color(1.3, 0.5, 0.16)) : exit ? new THREE.Color(1.2, 0.68, 0.32) : new THREE.Color(0.7, 0.4, 0.2),
    });
  }

  // Embers drifting down a tunnel.
  const embers: EmberSpot[] = [];
  if (lane) {
    for (let s = s0 - 10; s < s1 + 10; s += 1.2) {
      const f = track.frameAt(s);
      const u = lane.xIn + 4 + hash2(s, 1.3) * (lane.xOut - lane.xIn - 6);
      const pos = track.toWorld(s, lane.side * u, 0.4 + hash2(s, 2.9) * 6.5);
      embers.push({ pos, dir: f.tangent.clone().negate() });
    }
  }

  return { outer: b.toGeometry() ?? new THREE.BufferGeometry(), inner: rock.toGeometry(), shafts, mouths, embers };
}
