// The rocks that shape the course, in the terrain's sandstone shader so they read as part of the canyon:
// - the boulder walls along both edges of the corridor (where the physics walls are): rounded boulders, blocks, and
//   now and then a hoodoo or a spire, bigger and more crowded in the narrow passes, low in front of the grandstands;
// - the formations on the course (track.obstacles, the same circles physics and the AI use): blocky ridges that grow
//   out of the walls, boulder heaps, hoodoo pillars with cap rocks, and buttes topped with a spire;
// - the caves: a rock hill the course runs through, with a rough mouth at each end and a dim inside, and the same over
//   each tunnel shortcut's lane only;
// - the shortcut ridges and the slot walls, laid square to the course so their gaps look as narrow as they are.
// Rocks are a handful of instanced shapes (one draw call each); each cave is one mesh.

import * as THREE from 'three';
import { ROOF_CLEAR, TUNNEL_DEPTH, rng, type Shortcut, type Track } from '../core/track';
import type { TerrainField } from './terrainField';
import { GeoBuilder } from './terrainGeo';
import { noise1, noise2 } from './terrainNoise';
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

  // Boulder walls along the edges.
  const density = quality === 'low' ? 0.6 : 1;
  for (const side of [-1, 1] as const) {
    let s = 2;
    while (s < track.length - 2) {
      const f = track.frameAt(s);
      const hw = f.width / 2;
      const stand = zones.stands.some((st) => st.side === side && s > st.s0 - 10 && s < st.s1 + 10);
      if (onBridge(track, zones, s, 6) || track.inCave(s, -6)) {
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

  const meshes: THREE.Mesh[] = [];
  const geos: THREE.BufferGeometry[] = [];
  cls = 'edge';
  const lamps: THREE.Matrix4[] = [];
  const tunnels = track.shortcuts.filter((c) => c.kind === 'tunnel');
  const roofs: [number, number, Shortcut | undefined][] = [...track.caves.map((c): [number, number, undefined] => [c.s0, c.s1, undefined]), ...tunnels.map((c): [number, number, Shortcut] => [c.roof0, c.roof1, c])];
  for (const [s0, s1, lane] of roofs) {
    const g = caveGeometry(track, field, s0, s1, (p, rad) => place('block', p, rad, rad * (0.8 + r() * 1.4), 0.3), (p) => lamps.push(m.compose(p, q.identity(), sc.set(1, 1, 1)).clone()), lane);
    geos.push(g);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'cave';
    mesh.castShadow = mesh.receiveShadow = true;
    meshes.push(mesh);
  }
  // Lanterns along the cave walls: warm points that stream past in the dark (bright enough to bloom).
  const lampGeo = new THREE.OctahedronGeometry(0.8, 0);
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.0, 0.28) });
  geos.push(lampGeo);
  if (lamps.length) {
    const im = new THREE.InstancedMesh(lampGeo, lampMat, lamps.length);
    lamps.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.name = 'cave-lamps';
    meshes.push(im);
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
      lampMat.dispose();
    },
  };
}

/**
 * A cave from s0 to s1: an arched rock tube over the corridor inside, a hill of rock over it outside, and at each end
 * a rough mouth face joining the two. Cross sections use the frame's flat right and world up, so banking does not tilt
 * them. With `lane` it is a tunnel shortcut's roof instead: a lower arch over just the sunken lane, from its ridge to
 * past the corridor wall.
 */
function caveGeometry(
  track: Track,
  field: TerrainField,
  s0: number,
  s1: number,
  onTop: (p: THREE.Vector3, rad: number) => void,
  onLamp: (p: THREE.Vector3) => void,
  lane?: Shortcut,
): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const ROWS = 23;
  const cols = Math.max(2, Math.round((s1 - s0) / 3) + 1);
  const inner = new Float32Array(cols * ROWS * 3);
  const outer = new Float32Array(cols * ROWS * 3);
  const innerShade = new Float32Array(cols * ROWS);
  const step = track.length / (field.n - 1);
  // Profile at column c, angle index j (0 = right foot, ROWS - 1 = left foot), inner or outer surface.
  const at = (c: number, j: number, outside: boolean, out: Float32Array, o: number) => {
    const s = s0 + ((s1 - s0) * c) / (cols - 1);
    const i = Math.max(0, Math.min(field.n - 1, Math.round(s / step)));
    const hw = track.frameAt(s).width / 2;
    const th = (j / (ROWS - 1)) * Math.PI;
    let a = outside ? hw + 30 + noise1(s * 0.02, 5) * 8 : hw + 3;
    let h = outside ? 46 + noise1(s * 0.015, 9) * 16 : 17 + noise1(s * 0.03, 2) * 5;
    let mid = 0;
    let floor = 0;
    if (lane) {
      // Inner arch from the ridge's face to the wall, its crown a metre over the field; the hill over it is low.
      const u0 = outside ? lane.xIn - 5 : lane.xIn + 2;
      const u1 = outside ? lane.xOut + 14 : lane.xOut + 3;
      mid = (lane.side * (u0 + u1)) / 2;
      a = (u1 - u0) / 2;
      floor = -TUNNEL_DEPTH;
      h = outside ? TUNNEL_DEPTH + ROOF_CLEAR + 6 + noise1(s * 0.02, 9) * 3 : TUNNEL_DEPTH + ROOF_CLEAR + 1 + noise1(s * 0.03, 2) * 0.8;
    }
    // Lumpy rock: broad bulges plus finer ribs and pockets.
    const k = outside
      ? 1 + (noise2(s * 0.03, th * 2.7 + 11) - 0.5) * 0.3 + (noise2(s * 0.11, th * 8 + 3) - 0.5) * 0.12
      : 1 + (noise2(s * 0.07, th * 2.7) - 0.5) * 0.24 + (noise2(s * 0.3, th * 11) - 0.5) * 0.1;
    // Feet a little under the sand so the rock grows out of it.
    const x = mid + Math.cos(th) * a * k;
    const y = floor + Math.sin(th) * h * (lane && !outside ? Math.min(1, k) : k) - 1.2;
    out[o] = field.posX[i] + field.rx[i] * x;
    out[o + 1] = field.posY[i] + y;
    out[o + 2] = field.posZ[i] + field.rz[i] * x;
  };
  for (let c = 0; c < cols; c++) {
    for (let j = 0; j < ROWS; j++) {
      const o = (c * ROWS + j) * 3;
      at(c, j, false, inner, o);
      at(c, j, true, outer, o);
      // Dim inside, a little lighter near the mouths.
      const edge = Math.min(c, cols - 1 - c) * 4;
      innerShade[c * ROWS + j] = 0.85 - 0.4 * Math.min(1, edge / 30);
    }
  }
  b.addGrid(inner, cols, ROWS, -1, 1, innerShade);
  b.addGrid(outer, cols, ROWS, 1, 1, 1);
  // Blocks broken loose on the hill, so its outline is not a smooth dome; lanterns low on both walls inside.
  const v = new THREE.Vector3();
  for (let c = 0; c < cols; c += 4) {
    for (const j of [3, 7, 11, 15, 19]) {
      const o = (c * ROWS + j) * 3;
      if (noise2(c * 0.7, j * 0.9) > 0.55) onTop(v.set(outer[o], outer[o + 1] - 2, outer[o + 2]), 5 + noise2(c, j) * 7);
    }
    if (c % 8 === 4) {
      for (const j of [2, ROWS - 3]) {
        const o = (c * ROWS + j) * 3;
        // A little in from the wall, towards the corridor's centre line.
        const cx = (inner[o] + inner[(c * ROWS + (ROWS - 1 - j)) * 3]) / 2;
        const cz = (inner[o + 2] + inner[(c * ROWS + (ROWS - 1 - j)) * 3 + 2]) / 2;
        onLamp(v.set(inner[o] + (cx - inner[o]) * 0.04, inner[o + 1], inner[o + 2] + (cz - inner[o + 2]) * 0.04));
      }
    }
  }

  // Mouths: rings from the inner arch out to the hill's outline.
  const RINGS = 5;
  for (const [c, dir] of [[0, -1], [cols - 1, 1]] as const) {
    const s = s0 + ((s1 - s0) * c) / (cols - 1);
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
  }
  return b.toGeometry() ?? new THREE.BufferGeometry();
}
