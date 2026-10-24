// The mesa-top settlement: a layered sandstone mesa with a cluster of round, domed, balconied buildings on top, a tall
// tower with a saucer crown, terraces hanging off the cliff edge, neighbouring rock pillars and spires tied to the mesa
// by steel catwalks and sagging rope bridges, and mist around the foot of it all. Everything static is merged into a
// handful of meshes (rock, buildings, sails, optional lit windows, mist).

import * as THREE from 'three';
import { rng } from '../core/track';
import { GeoBin, at, capFog, mistTexture, rockColumn, type RockPalette } from './cityKit';
import type { WorldContext, WorldPart } from './types';

const PLASTER = '#ebdfc8';
const PLASTER2 = '#dcc4a0';
const SANDSTONE = '#c99a6c';
const TRIM = '#7d6152';
const ROOF = '#b8623f';
const DOME = '#d8cfc0';
const DOME2 = '#86a3ad';
const METAL = '#55504c';
const WOOD = '#6e4a34';
const WINDOW = '#2a2430';
const ROPE = '#3e342c';

export interface CitySpot {
  pos: THREE.Vector3;
  radius: number;
  height: number;
}

export function buildCity(ctx: WorldContext, city: CitySpot): WorldPart {
  const { theme, quality } = ctx;
  const r = rng(ctx.track.def.seed * 131 + 17);
  const low = quality === 'low';
  const seg = low ? 32 : 64;
  const group = new THREE.Group();
  group.name = 'skyCity';
  group.position.copy(city.pos);

  const pal: RockPalette = {
    lit: new THREE.Color(theme.rockLit),
    strata: new THREE.Color(theme.rockStrata),
    shade: new THREE.Color(theme.rockShade),
    top: new THREE.Color(theme.sand).lerp(new THREE.Color(theme.rockStrata), 0.4),
  };

  const rock = new GeoBin();
  const bld = new GeoBin();
  const sails = new GeoBin();
  const glow = new GeoBin();
  const sunsetLights = theme.sunElevation < 0.2 && !low;

  // --- The mesa: a wide base skirt and the main column on top of it, both reaching below the desert floor.
  const base = -60;
  rock.add(rockColumn({ x: 0, z: 0, y0: base, height: 60 + city.height * 0.15, radius: city.radius * 1.16, top: 0.95, tiers: 2, seg, seed: r, squash: 1.1 }, pal).geo);
  const mesa = rockColumn({ x: 0, z: 0, y0: base + 30, height: city.height - base - 30, radius: city.radius, top: 0.92, tiers: 4, seg, seed: r, squash: 1.08 }, pal);
  rock.add(mesa.geo);
  const topY = mesa.topY + 1.2;
  const topR = mesa.topR * 0.92;

  const tc = ctx.track.bounds.getCenter(new THREE.Vector3());
  const toTrack = Math.atan2(tc.z - city.pos.z, tc.x - city.pos.x);

  // --- Buildings on top. A free-placement disc: the tower in the middle, then rejection-sampled round buildings.
  const placed: { x: number; z: number; r: number }[] = [];
  const free = (x: number, z: number, rad: number) => placed.every((p) => Math.hypot(p.x - x, p.z - z) > p.r + rad + 3);

  const windowsRing = (x: number, y: number, z: number, rad: number, n: number, w: number, h: number, litChance: number) => {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.08;
      const m = at(x + Math.cos(a) * rad, y, z + Math.sin(a) * rad, -a + Math.PI / 2);
      bld.add(new THREE.BoxGeometry(w, h, 0.6), WINDOW, m);
      if (sunsetLights && r() < litChance) glow.add(new THREE.PlaneGeometry(w * 0.8, h * 0.8), '#ffc27a', at(x + Math.cos(a) * (rad + 0.35), y, z + Math.sin(a) * (rad + 0.35), -a + Math.PI / 2));
    }
  };
  const drum = (x: number, y: number, z: number, rad: number, h: number, color: string, sides = 18) => {
    bld.add(new THREE.CylinderGeometry(rad, rad * 1.02, h, sides), color, at(x, y + h / 2, z));
  };
  const balcony = (x: number, y: number, z: number, rad: number, sides = 20) => {
    bld.add(new THREE.CylinderGeometry(rad + 2.6, rad + 2.2, 0.9, sides), PLASTER2, at(x, y, z));
    bld.add(new THREE.TorusGeometry(rad + 2.4, 0.18, 3, sides), METAL, new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(x, y + 1.4, z));
    // Railing posts, sparse.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      bld.add(new THREE.BoxGeometry(0.25, 1.4, 0.25), METAL, at(x + Math.cos(a) * (rad + 2.4), y + 0.7, z + Math.sin(a) * (rad + 2.4)));
    }
  };
  const dome = (x: number, y: number, z: number, rad: number, squash: number, color: string) => {
    bld.add(new THREE.SphereGeometry(rad, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2), color, at(x, y, z, 0, 1, squash, 1));
  };
  const antenna = (x: number, y: number, z: number, h: number) => {
    bld.add(new THREE.CylinderGeometry(0.2, 0.35, h, 4), METAL, at(x, y + h / 2, z));
    bld.add(new THREE.BoxGeometry(2.2, 0.15, 0.15), METAL, at(x, y + h * 0.7, z, r() * 3));
    bld.add(new THREE.SphereGeometry(0.6, 6, 4), '#d24a32', at(x, y + h, z));
  };
  // A sail awning: a triangle of cloth from a wall point out to two poles, drooping a little.
  const awningColors = ['#c63c2c', '#efe2c4', '#d9782e', ...theme.banners.slice(0, 2)];
  const sail = (x: number, y: number, z: number, rad: number, a: number, size: number) => {
    const p0 = new THREE.Vector3(x + Math.cos(a) * rad, y + size * 0.35, z + Math.sin(a) * rad);
    const a1 = a - 0.35;
    const a2 = a + 0.35;
    const out = rad + size;
    const p1 = new THREE.Vector3(x + Math.cos(a1) * out, y, z + Math.sin(a1) * out);
    const p2 = new THREE.Vector3(x + Math.cos(a2) * out, y - size * 0.1, z + Math.sin(a2) * out);
    const mid = p1.clone().add(p2).multiplyScalar(0.5).lerp(p0, 0.35);
    mid.y -= size * 0.12;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...p0.toArray(), ...p1.toArray(), ...mid.toArray(), ...p0.toArray(), ...mid.toArray(), ...p2.toArray()], 3));
    g.computeVertexNormals();
    sails.add(g, awningColors[Math.floor(r() * awningColors.length)]);
    bld.beam(p1, new THREE.Vector3(p1.x, y - size * 0.8, p1.z), 0.3, 0.3, METAL);
    bld.beam(p2, new THREE.Vector3(p2.x, y - size * 0.8, p2.z), 0.3, 0.3, METAL);
  };

  // The tall tower with a saucer crown (the landmark you see from the track).
  {
    const tx = (r() - 0.5) * topR * 0.2;
    const tz = (r() - 0.5) * topR * 0.2;
    placed.push({ x: tx, z: tz, r: 20 });
    drum(tx, topY, tz, 16, 14, PLASTER, 24);
    windowsRing(tx, topY + 8, tz, 16, 22, 1.6, 2.4, 0.5);
    balcony(tx, topY + 14, tz, 16, 24);
    drum(tx, topY + 14, tz, 11, 10, PLASTER2, 20);
    const shaftH = 85;
    bld.add(new THREE.CylinderGeometry(4.5, 7, shaftH, 12), PLASTER, at(tx, topY + 24 + shaftH / 2, tz));
    // Thin vertical window slits up the shaft.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      bld.add(new THREE.BoxGeometry(1, shaftH * 0.8, 0.6), WINDOW, at(tx + Math.cos(a) * 5.6, topY + 24 + shaftH / 2, tz + Math.sin(a) * 5.6, -a + Math.PI / 2));
    }
    const sy = topY + 24 + shaftH;
    // Saucer: a lathe profile, fat lens with a rim band.
    const prof = [
      new THREE.Vector2(0.01, -3),
      new THREE.Vector2(9, -4),
      new THREE.Vector2(20, -1.5),
      new THREE.Vector2(24, 0),
      new THREE.Vector2(24, 2.2),
      new THREE.Vector2(19, 4),
      new THREE.Vector2(10, 5.2),
      new THREE.Vector2(0.01, 5.6),
    ];
    bld.add(new THREE.LatheGeometry(prof, 28), DOME, at(tx, sy, tz));
    bld.add(new THREE.CylinderGeometry(24.15, 24.15, 1.4, 28, 1, true), WINDOW, at(tx, sy + 1, tz));
    if (sunsetLights) glow.add(new THREE.CylinderGeometry(24.3, 24.3, 0.8, 28, 1, true), '#ffc27a', at(tx, sy + 1, tz));
    drum(tx, sy + 5, tz, 8, 4, PLASTER2, 16);
    dome(tx, sy + 9, tz, 8, 0.7, ROOF);
    antenna(tx, sy + 14, tz, 16);
    bld.add(new THREE.TorusGeometry(24.5, 0.3, 3, 28), TRIM, new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(tx, sy + 2.6, tz));
  }

  // Round buildings: drums, stacked tiers, domes, balconies, windows, antennas, awnings.
  const target = low ? 16 : 34;
  let tries = 0;
  while (placed.length < target && tries++ < 600) {
    const rad = 7 + r() * 12;
    // The first tries line the rim (houses on the cliff edge read best from below), the rest fill the top.
    const d = tries < 120 ? topR - rad - 3 : Math.sqrt(r()) * (topR - rad - 4);
    const a = r() * Math.PI * 2;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (!free(x, z, rad)) continue;
    placed.push({ x, z, r: rad });
    const tiers = 1 + Math.floor(r() * (rad > 12 ? 2 : 3));
    let y = topY - 1;
    let rr = rad;
    const wall = r() < 0.6 ? PLASTER : r() < 0.5 ? PLASTER2 : SANDSTONE;
    for (let t = 0; t < tiers; t++) {
      const h = 8 + r() * 9;
      drum(x, y, z, rr, h, t % 2 ? PLASTER2 : wall);
      windowsRing(x, y + h * 0.55, z, rr, Math.max(6, Math.round(rr * 1.6)), 1.2, 1.8, 0.35);
      // A dark trim band at the top of the tier.
      bld.add(new THREE.CylinderGeometry(rr + 0.2, rr + 0.2, 0.7, 18), TRIM, at(x, y + h - 0.35, z));
      y += h;
      if (r() < 0.65) balcony(x, y, z, rr);
      if (t === 0 && r() < 0.6) sail(x, y - h * 0.15, z, rr, Math.atan2(z, x) + (r() - 0.5) * 1.5, 6 + r() * 6);
      rr *= 0.68 + r() * 0.12;
    }
    const roof = r();
    if (roof < 0.75) {
      dome(x, y, z, rr * 1.02, 0.55 + r() * 0.5, r() < 0.65 ? DOME : r() < 0.6 ? ROOF : DOME2);
      if (r() < 0.6) antenna(x, y + rr * 0.6, z, 5 + r() * 10);
    } else {
      bld.add(new THREE.CylinderGeometry(rr + 0.6, rr + 0.6, 0.8, 18), TRIM, at(x, y + 0.4, z));
      antenna(x + rr * 0.4, y, z, 6 + r() * 10);
      sail(x, y + 3, z, rr * 0.2, r() * 6.28, rr * 0.9);
    }
  }
  // Low walls/plazas: flat discs in the sand between buildings.
  for (let i = 0; i < (low ? 4 : 10); i++) {
    const a = r() * Math.PI * 2;
    const d = r() * topR * 0.8;
    bld.add(new THREE.CylinderGeometry(4 + r() * 6, 4.5 + r() * 6, 1.2, 12), SANDSTONE, at(Math.cos(a) * d, topY - 0.3, Math.sin(a) * d));
  }

  // Terraces hanging off the cliff edge: a round platform on struts, a little hut, an awning.
  const nTer = low ? 3 : 6;
  for (let i = 0; i < nTer; i++) {
    const a = (i / nTer) * Math.PI * 2 + r() * 0.6;
    const y = topY - 8 - r() * 30;
    const pr = 7 + r() * 5;
    const d = mesaRadiusAt(city.radius, topY, y) + pr * 0.4;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    bld.add(new THREE.CylinderGeometry(pr, pr * 0.9, 1.2, 16), PLASTER2, at(x, y, z));
    bld.add(new THREE.TorusGeometry(pr - 0.3, 0.15, 3, 16), METAL, new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(x, y + 1.3, z));
    for (const da of [-0.5, 0.5]) {
      const tip = new THREE.Vector3(x + Math.cos(a + da * 0.3) * pr * 0.6, y - 0.5, z + Math.sin(a + da * 0.3) * pr * 0.6);
      const foot = new THREE.Vector3(Math.cos(a + da * 0.08) * (d - pr * 1.6), y - pr * 1.5, Math.sin(a + da * 0.08) * (d - pr * 1.6));
      bld.beam(tip, foot, 0.6, 0.6, METAL);
    }
    const hr = pr * 0.45;
    drum(x - Math.cos(a) * pr * 0.3, y + 0.6, z - Math.sin(a) * pr * 0.3, hr, 4, PLASTER);
    dome(x - Math.cos(a) * pr * 0.3, y + 4.6, z - Math.sin(a) * pr * 0.3, hr, 0.6, DOME);
    windowsRing(x - Math.cos(a) * pr * 0.3, y + 2.6, z - Math.sin(a) * pr * 0.3, hr, 6, 1, 1.5, 0.5);
    sail(x, y + 3.5, z, pr * 0.3, a, pr * 0.8);
  }

  // --- Neighbouring pillars and spires, linked by bridges.
  type Pillar = { x: number; z: number; topY: number; topR: number };
  const pillars: Pillar[] = [];
  const nP = low ? 5 : 8;
  for (let i = 0; i < nP; i++) {
    // Spread around the mesa but keep the side facing the circuit clear so the city stays in view from the track.
    const a = toTrack + 0.8 + (i / (nP - 1)) * (Math.PI * 2 - 1.6) + (r() - 0.5) * 0.3;
    const spire = i % 2 === 1;
    const pr = spire ? 13 + r() * 6 : 20 + r() * 12;
    const d = city.radius + pr + 45 + r() * 90;
    const h = (spire ? 1.45 + r() * 0.5 : 0.75 + r() * 0.4) * city.height;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const col = rockColumn(
      { x, z, y0: base, height: h - base, radius: pr, top: spire ? 0.55 : 0.75, tiers: spire ? 6 : 4, seg: Math.round(seg * 0.6), seed: r, leanX: (r() - 0.5) * pr * 0.5, leanZ: (r() - 0.5) * pr * 0.5 },
      pal,
    );
    rock.add(col.geo);
    // The column leans: find its actual top centre from the geometry's top cap (last vertex group is centre).
    const pos = col.geo.attributes.position;
    const cxTop = pos.getX(pos.count - 3);
    const czTop = pos.getZ(pos.count - 3);
    pillars.push({ x: cxTop, z: czTop, topY: col.topY + 1, topR: col.topR * 0.8 });
  }
  for (const p of pillars) {
    // Something on every pillar top: a hut with a dome, or a platform with an antenna.
    if (r() < 0.6) {
      const hr = Math.min(8, p.topR * 0.45);
      drum(p.x, p.topY - 0.5, p.z, hr, 6, PLASTER);
      windowsRing(p.x, p.topY + 3, p.z, hr, 7, 1, 1.6, 0.5);
      dome(p.x, p.topY + 5.5, p.z, hr, 0.75, r() < 0.5 ? DOME : ROOF);
    }
    antenna(p.x + p.topR * 0.4, p.topY, p.z, 8 + r() * 12);
  }

  const bridge = (a: THREE.Vector3, b: THREE.Vector3, rope: boolean) => {
    const len = a.distanceTo(b);
    const n = Math.max(8, Math.round(len / (rope ? 6 : 8)));
    const dir = b.clone().sub(a).setY(0).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const sag = rope ? len * 0.07 : 0;
    const pt = (t: number) => a.clone().lerp(b, t).add(new THREE.Vector3(0, -sag * 4 * t * (1 - t), 0));
    const w = rope ? 2.4 : 3.2;
    const deck: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) deck.push(pt(i / n));
    for (let i = 0; i < n; i++) bld.beam(deck[i], deck[i + 1], w, rope ? 0.35 : 0.6, rope ? WOOD : METAL);
    if (rope) {
      // Handrail ropes above the deck with hangers, and a gentle extra sag in the ropes.
      for (const s of [-1, 1]) {
        const rail = deck.map((p, i) => p.clone().addScaledVector(side, (s * w) / 2).add(new THREE.Vector3(0, 1.6 - Math.sin((i / n) * Math.PI) * 0.4, 0)));
        bld.rope(rail, 0.12, ROPE, n * 2);
        for (let i = 1; i < n; i += 2) bld.beam(deck[i].clone().addScaledVector(side, (s * w) / 2), rail[i], 0.08, 0.08, ROPE);
      }
      // Anchor posts.
      for (const e of [a, b]) for (const s of [-1, 1]) bld.beam(e.clone().addScaledVector(side, (s * w) / 2), e.clone().addScaledVector(side, (s * w) / 2).setY(e.y + 3), 0.5, 0.5, WOOD);
    } else {
      // Steel catwalk: top rails and a zig-zag truss on both sides, a keel strut below for depth.
      for (const s of [-1, 1]) {
        const off = side.clone().multiplyScalar((s * w) / 2);
        bld.beam(a.clone().add(off).setY(a.y + 1.8), b.clone().add(off).setY(b.y + 1.8), 0.25, 0.25, METAL);
        for (let i = 0; i < n; i++) {
          const p = deck[i].clone().add(off);
          const q = deck[i + 1].clone().add(off).setY(deck[i + 1].y + 1.8);
          bld.beam(i % 2 ? p.setY(p.y + 1.8) : p, i % 2 ? q.setY(deck[i + 1].y) : q, 0.18, 0.18, METAL);
        }
      }
      const keel = Math.min(8, len * 0.06);
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const k0 = deck[i].clone().setY(deck[i].y - keel * Math.sin(t0 * Math.PI));
        const k1 = deck[i + 1].clone().setY(deck[i + 1].y - keel * Math.sin(t1 * Math.PI));
        bld.beam(k0, k1, 0.4, 0.4, METAL);
        if (i % 2 === 0) bld.beam(deck[i], k1, 0.25, 0.25, METAL);
      }
    }
  };
  const edgeOfMesa = (toward: THREE.Vector3) => {
    const d = toward.clone().setY(0).normalize();
    return new THREE.Vector3(d.x * topR * 0.97, topY, d.z * topR * 0.97);
  };
  const edgeOfPillar = (p: Pillar, toward: THREE.Vector3) => {
    const d = toward.clone().sub(new THREE.Vector3(p.x, 0, p.z)).setY(0).normalize();
    return new THREE.Vector3(p.x + d.x * p.topR, p.topY, p.z + d.z * p.topR);
  };
  for (const p of pillars) {
    const pc = new THREE.Vector3(p.x, p.topY, p.z);
    const e = edgeOfPillar(p, new THREE.Vector3());
    const m = edgeOfMesa(pc);
    // Pillar much higher or lower than the mesa: meet it at a terrace level on the mesa's cliff instead.
    if (p.topY > topY + 30) {
      // A tall spire: a long sagging rope bridge from its upper ledge down to the mesa edge.
      const hi = e.clone();
      hi.y = Math.min(p.topY - 12, topY + 45);
      bridge(m, hi, true);
    } else {
      bridge(m, e, Math.abs(p.topY - topY) > 12 || r() < 0.3);
    }
  }
  // Long spans between neighbouring pillars (every other pair).
  for (let i = 0; i < pillars.length; i += 2) {
    const p = pillars[i];
    const q = pillars[(i + 1) % pillars.length];
    const a = edgeOfPillar(p, new THREE.Vector3(q.x, 0, q.z));
    const b = edgeOfPillar(q, new THREE.Vector3(p.x, 0, p.z));
    const y = Math.min(a.y, b.y) - 2;
    a.y = Math.min(a.y, y + 20);
    b.y = Math.min(b.y, y + 20);
    bridge(a, b, true);
  }

  // --- Meshes.
  const disposables: { dispose(): void }[] = [];
  const mk = (bin: GeoBin, mat: THREE.Material, name: string) => {
    if (bin.empty) return null;
    const mesh = new THREE.Mesh(bin.build(), mat);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    disposables.push(mesh.geometry, mat);
    return mesh;
  };
  mk(rock, capFog(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 }), 0.6), 'cityRock');
  mk(bld, capFog(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 }), 0.6), 'cityBuildings');
  mk(sails, capFog(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }), 0.6), 'citySails');
  mk(glow, capFog(new THREE.MeshBasicMaterial({ vertexColors: true }), 0.7), 'cityLights');

  // --- Mist: concentric open bands around the foot, with scrolling wisps.
  const mistTex = mistTexture();
  disposables.push(mistTex);
  const mistColor = new THREE.Color(theme.haze).lerp(new THREE.Color('#ffffff'), 0.45);
  const mists: THREE.Mesh[] = [];
  const rings = low ? [[city.radius * 1.55, 55, 0]] : [[city.radius * 1.45, 60, 0], [city.radius * 2.3, 75, -8], [city.radius * 3.0, 50, -15]];
  for (const [rad, h, y] of rings) {
    const mat = new THREE.MeshBasicMaterial({ map: mistTex.clone(), color: mistColor, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide, fog: true });
    mat.map!.repeat.set(2 + Math.round(rad / 200), 1);
    mat.map!.offset.x = r();
    mat.map!.needsUpdate = true;
    const g = new THREE.CylinderGeometry(rad, rad * 1.08, h, low ? 24 : 40, 1, true);
    const m = new THREE.Mesh(g, mat);
    m.position.y = y + h / 2 - 8;
    m.renderOrder = 2;
    group.add(m);
    mists.push(m);
    disposables.push(g, mat, mat.map!);
  }

  return {
    object: group,
    update(view) {
      for (let i = 0; i < mists.length; i++) {
        const map = (mists[i].material as THREE.MeshBasicMaterial).map!;
        map.offset.x = (map.offset.x + view.dt * 0.004 * (i % 2 ? -1 : 1)) % 1;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Approximate mesa face radius at height y (it tapers from the base radius to ~0.86 of it at the top). */
function mesaRadiusAt(radius: number, topY: number, y: number) {
  const f = THREE.MathUtils.clamp(y / topY, 0, 1);
  return radius * (1 - 0.14 * f);
}
