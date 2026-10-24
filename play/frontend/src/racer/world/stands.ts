// Race-day atmosphere along the track: spectator balconies built onto the canyon wall at the zones' stand spans
// (stepped wooden terraces on a steel trestle, railings, red sail-cloth awnings on poles, pennant strings, lamp and
// speaker masts), crowds of tiny cheering people, and tall team banners on pole frames lining the barrier, denser
// near the stands and the start. Four draw calls in all: merged structure, merged cloth (awnings + pennants,
// flapping in the vertex shader), the instanced crowd and the instanced banners.

import * as THREE from 'three';
import type { Track } from '../core/track';
import { rng } from '../core/track';
import { buildBanners, type Banner } from './bannerCloth';
import { buildCrowd, type Spectator } from './standCrowd';
import { GeoBuilder } from './standGeom';
import type { WorldBuilder } from './types';
import { zonesFor, type Span } from './zones';

const UP = new THREE.Vector3(0, 1, 0);

/** Distance from s to a span along the lap (0 inside it). */
function spanDist(track: Track, s: number, sp: Span) {
  const len = sp.s1 - sp.s0;
  const d = track.wrap(s - sp.s0);
  if (d <= len) return 0;
  return Math.min(d - len, track.length - d);
}

/** Horizontal frame at s: position on the centreline, flat forward and flat right. */
function flatFrame(track: Track, s: number) {
  const f = track.frameAt(s);
  const fwd = f.tangent.clone().setY(0).normalize();
  const right = fwd.clone().cross(UP).normalize();
  return { f, fwd, right };
}

function clothMaterial() {
  const uniforms = { uTime: { value: 0 } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        attribute float aFlap;
        attribute vec3 aDir;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // World-space geometry (the mesh sits at the origin): ripple travels along the cloth with position.
        float cph = dot(position.xz, vec2(0.21, 0.17));
        float flutter = sin(uTime * 2.3 + cph) + 0.5 * sin(uTime * 5.1 + cph * 2.7);
        transformed += aDir * aFlap * flutter * 0.28;`,
      );
  };
  return { mat, uniforms };
}

export const buildStands: WorldBuilder = (ctx) => {
  const { track, theme, quality } = ctx;
  const zones = zonesFor(track);
  const r = rng(track.def.seed * 13 + 7);
  const low = quality === 'low';

  const group = new THREE.Group();
  group.name = 'stands';
  const struct = new GeoBuilder();
  const cloth = new GeoBuilder(true);
  const people: Spectator[] = [];
  const banners: Banner[] = [];

  const C = (hex: string) => new THREE.Color(hex);
  const steel = C('#3d3836');
  const steelLight = C('#6a625c');
  const wood = C('#9a6440');
  const woodDark = C('#6b4229');
  const fascia = C('#4a3a33');
  const lampGlass = C('#fff3d0');
  const teamA = C(theme.banners[0]);
  const teamB = C(theme.banners[1] ?? theme.banners[0]);
  const emblem = C(theme.banners[2] ?? '#f2f2f2');
  const sail = C('#c8382a').lerp(teamB, 0.25);
  // Per strip of the awning grid (front to back) and panel (alternate seams): faint shading, darker towards the wall.
  const sailShades = Array.from({ length: 8 }, (_, i) => sail.clone().multiplyScalar((1 - Math.floor(i / 2) * 0.07) * (i % 2 ? 0.94 : 1)));
  const pennantCols = [teamA, teamB, C('#f2c230'), emblem];

  const tmpB = new THREE.Vector3();

  /** Mast with a lamp head and a speaker box, its foot at `foot`, the arm reaching towards `inward`. */
  const mast = (foot: THREE.Vector3, inward: THREE.Vector3, fwd: THREE.Vector3, height: number) => {
    const top = foot.clone().addScaledVector(UP, height);
    struct.beam(foot.clone().addScaledVector(UP, -8), top, 0.28, steel);
    const armEnd = top.clone().addScaledVector(inward, 2.2);
    struct.beam(top.clone().addScaledVector(UP, -0.2), armEnd, 0.16, steel);
    const side = new THREE.Vector3().crossVectors(UP, inward).normalize();
    struct.box(armEnd.clone().addScaledVector(UP, -0.35), side, UP, inward, 0.6, 0.18, 0.35, steelLight);
    struct.box(armEnd.clone().addScaledVector(UP, -0.56), side, UP, inward, 0.5, 0.04, 0.27, lampGlass, true);
    // Speakers: two boxes on the mast, one aimed each way along the track.
    for (const dir of [-1, 1]) {
      const z = fwd.clone().multiplyScalar(dir);
      const x = new THREE.Vector3().crossVectors(UP, z).normalize();
      struct.box(top.clone().addScaledVector(UP, -2.2).addScaledVector(z, 0.45), x, UP, z, 0.35, 0.45, 0.3, steel);
    }
  };

  // ---------------------------------------------------------------- balconies
  for (const st of zones.stands) {
    const side = st.side;
    const step = 3;
    const n = Math.max(2, Math.round((st.s1 - st.s0) / step));
    const deckH = 10 + r() * 5;
    const depth = 9;
    // Cross-section points along the stand, null where the wall is missing.
    type Sec = { s: number; base: THREE.Vector3; out: THREE.Vector3; fwd: THREE.Vector3; front: number; wall: number };
    const secs: (Sec | null)[] = [];
    for (let i = 0; i <= n; i++) {
      const s = st.s0 + ((st.s1 - st.s0) * i) / n;
      const wall = zones.wallOffset(s, side);
      if (!Number.isFinite(wall)) {
        secs.push(null);
        continue;
      }
      const { f, fwd, right } = flatFrame(track, s);
      secs.push({ s, base: f.pos.clone(), out: right.clone().multiplyScalar(side), fwd, front: wall - depth, wall });
    }
    const P = (c: Sec, d: number, h: number, out = new THREE.Vector3()) => out.copy(c.base).addScaledVector(c.out, d).addScaledVector(UP, h);
    // Stepped terrace profile: [offset from the front edge (or 'wall'), height above the deck].
    const prof: [number, number, THREE.Color][] = [
      [0, -1.3, fascia],
      [0, 0, wood],
      [3, 0, woodDark],
      [3, 0.8, wood],
      [6, 0.8, woodDark],
      [6, 1.6, wood],
      [depth + 4, 1.6, fascia],
      [depth + 4, -1.3, fascia],
      [0, -1.3, fascia],
    ];
    for (let i = 0; i < n; i++) {
      const a = secs[i];
      const b = secs[i + 1];
      if (!a || !b) continue;
      for (let k = 0; k < prof.length - 1; k++) {
        const [d0, h0, col] = prof[k];
        const [d1, h1] = prof[k + 1];
        struct.quad(P(a, a.front + d0, deckH + h0), P(b, b.front + d0, deckH + h0), P(b, b.front + d1, deckH + h1), P(a, a.front + d1, deckH + h1), col);
      }
      // Railing along the front edge.
      for (const h of [1.1, 0.55]) struct.beam(P(a, a.front + 0.15, deckH + h), P(b, b.front + 0.15, deckH + h), h > 1 ? 0.12 : 0.07, steel);
      for (let t = 0; t < 2; t++) {
        const u = t / 2;
        const p = P(a, a.front + 0.15, deckH).lerp(P(b, b.front + 0.15, deckH), u);
        struct.beam(p, p.clone().addScaledVector(UP, 1.1), 0.07, steel);
      }
    }
    // Ends: close the terrace with side walls so it doesn't look hollow.
    for (const end of [secs.find((x) => x), [...secs].reverse().find((x) => x)]) {
      if (!end) continue;
      const c = P(end, (end.front + end.wall + 4) / 2, deckH + 0.15);
      struct.box(c, end.out, UP, new THREE.Vector3().crossVectors(end.out, UP).normalize(), (end.wall + 4 - end.front) / 2, 1.45, 0.2, fascia);
    }

    // Trestle (posts reach well below the road level in case the ground dips): posts under the front edge every two sections, X-braces between them, struts back to the wall.
    let prevPost: Sec | null = null;
    for (let i = 0; i <= n; i += 2) {
      const c = secs[i];
      if (!c) {
        prevPost = null;
        continue;
      }
      struct.beam(P(c, c.front + 0.4, -12), P(c, c.front + 0.4, deckH - 1.3), 0.38, steel);
      struct.beam(P(c, c.front + 0.4, deckH - 4.5), P(c, c.wall, deckH - 1.3), 0.22, steel);
      if (prevPost) {
        struct.beam(P(prevPost, prevPost.front + 0.4, 0.3), P(c, c.front + 0.4, deckH - 1.5), 0.16, steel);
        struct.beam(P(c, c.front + 0.4, 0.3), P(prevPost, prevPost.front + 0.4, deckH - 1.5), 0.16, steel);
      }
      prevPost = c;
    }

    // Awnings: poles at the front every ~9 m, red sail-cloth with a scalloped front edge.
    const poleEvery = 3;
    const poles: Sec[] = [];
    for (let i = 0; i <= n; i += poleEvery) if (secs[i]) poles.push(secs[i]!);
    // Sail-cloth tilted up towards the road like the concept art: high outer edge overhanging the railing, low at the
    // wall, so racers below see its full red underside.
    const awnFront = 8;
    const awnBack = 4.5;
    const awnOver = -3;
    for (const c of poles) {
      // Masts from the ground in front of the balcony, braced back to the deck edge.
      struct.beam(P(c, c.front + awnOver, -12), P(c, c.front + awnOver, deckH + awnFront + 0.6), 0.26, steel);
      struct.beam(P(c, c.front + awnOver, deckH - 1.0), P(c, c.front, deckH - 1.0), 0.18, steel);
    }
    for (let i = 0; i + 1 < poles.length; i++) {
      const a = poles[i];
      const b = poles[i + 1];
      if (b.s - a.s > poleEvery * step * 1.6) continue;
      struct.beam(P(a, a.front + awnOver, deckH + awnFront), P(b, b.front + awnOver, deckH + awnFront), 0.1, steel);
      const NU = 6;
      const NV = 3;
      const grid: THREE.Vector3[][] = [];
      const wts: number[][] = [];
      for (let u = 0; u <= NU; u++) {
        const t = u / NU;
        const row: THREE.Vector3[] = [];
        const wr: number[] = [];
        const sag = Math.sin(t * Math.PI);
        for (let v = 0; v <= NV; v++) {
          const q = v / NV; // 0 front, 1 back at the wall
          const fa = P(a, a.front + awnOver + (a.wall + 1 - a.front - awnOver) * q, deckH + awnFront + (awnBack - awnFront) * q);
          const fb = P(b, b.front + awnOver + (b.wall + 1 - b.front - awnOver) * q, deckH + awnFront + (awnBack - awnFront) * q);
          const p = fa.lerp(fb, t);
          // Belly between the poles, deepest at the front edge (the scallop).
          p.y -= sag * (0.35 + 0.55 * (1 - q) * (1 - q));
          row.push(p);
          wr.push(sag * (1 - q) * 0.9 + sag * 0.15);
        }
        grid.push(row);
        wts.push(wr);
      }
      for (let u = 0; u < NU; u++) {
        for (let v = 0; v < NV; v++) {
          const col = sailShades[v * 2 + (u % 2)];
          cloth.quad(grid[u][v], grid[u + 1][v], grid[u + 1][v + 1], grid[u][v + 1], col, [wts[u][v], wts[u + 1][v], wts[u + 1][v + 1], wts[u][v + 1]], UP);
        }
      }
      // Pennant string a little under the awning edge.
      if (!low) {
        const pa = P(a, a.front + awnOver - 0.1, deckH + awnFront - 0.3);
        const pb = P(b, b.front + awnOver - 0.1, deckH + awnFront - 0.3);
        const len = pa.distanceTo(pb);
        const count = Math.floor(len / 0.8);
        const dir = a.out.clone();
        for (let k = 0; k < count; k++) {
          const t0 = (k + 0.15) / count;
          const t1 = (k + 0.85) / count;
          const p0 = pa.clone().lerp(pb, t0);
          const p1 = pa.clone().lerp(pb, t1);
          p0.y -= Math.sin(t0 * Math.PI) * 1.1;
          p1.y -= Math.sin(t1 * Math.PI) * 1.1;
          const tip = p0.clone().lerp(p1, 0.5).addScaledVector(UP, -0.6);
          cloth.tri(p0, p1, tip, pennantCols[(k + i) % pennantCols.length], [0.05, 0.05, 0.8], dir);
        }
      }
    }

    // Crowd on the three steps.
    const rows: [number, number][] = low
      ? [
          [1.6, 0],
          [7.6, 1.6],
        ]
      : [
          [1.3, 0],
          [2.3, 0],
          [4.6, 0.8],
          [7.2, 1.6],
          [8.4, 1.6],
        ];
    const gap = low ? 1.5 : 0.78;
    const L = st.s1 - st.s0;
    for (const [dOff, hOff] of rows) {
      for (let s = st.s0 + 2 + r() * gap; s < st.s1 - 2; s += gap * (0.8 + r() * 0.4)) {
        // Thin out towards the ends and leave a few gaps.
        const edge = Math.min(s - st.s0, st.s1 - s) / Math.min(30, L / 3);
        if (r() > Math.min(1, edge) * 0.9) continue;
        const wall = zones.wallOffset(s, side);
        if (!Number.isFinite(wall)) continue;
        const { f, right } = flatFrame(track, s);
        const out = right.multiplyScalar(side);
        const pos = f.pos.clone().addScaledVector(out, wall - depth + dOff + (r() - 0.5) * 0.3).addScaledVector(UP, deckH + hOff);
        const yaw = (r() - 0.5) * 0.7;
        const facing = out.clone().negate().applyAxisAngle(UP, yaw);
        people.push({ pos, facing, scale: 0.9 + r() * 0.2, tint: r() });
      }
    }

    // Banners hanging off the balcony front, and lamp/speaker masts in front of it.
    let flip = r() < 0.5 ? 0 : 1;
    for (let i = 2; i < n - 1; i += 7) {
      const c = secs[i];
      if (!c) continue;
      const facing = c.out.clone().negate();
      banners.push({ top: P(c, c.front - 0.25, deckH + 1.0), facing, width: 2.2, height: 5.6, color: flip++ % 2 ? teamB : teamA });
    }
    for (let i = 4; i < n - 3; i += 15) {
      const c = secs[i];
      if (!c) continue;
      mast(P(c, c.front - 3, 0), c.out.clone().negate(), c.fwd, deckH + 11);
    }
  }

  // ---------------------------------------------------------------- track-side banners
  const nearStart = (s: number) => Math.min(track.wrap(s), track.length - track.wrap(s)) < 280;
  const nearStand = (s: number) => zones.stands.some((st) => spanDist(track, s, st) < 60);
  const onGorge = (s: number) => zones.gorges.some((g) => spanDist(track, s, g) < 25);
  for (const side of [-1, 1] as const) {
    let s = r() * 40 + (side > 0 ? 18 : 0);
    let k = side > 0 ? 1 : 0;
    while (s < track.length - 10) {
      const dense = nearStart(s) || nearStand(s);
      const next = dense ? 34 + r() * 16 : 80 + r() * 70;
      if (onGorge(s)) {
        s += next;
        continue;
      }
      const { f, fwd, right } = flatFrame(track, s);
      const half = f.width / 2;
      const off = half + 4 + r() * 1.5;
      const wall = zones.wallOffset(s, side);
      if (wall < off + 2) {
        s += next;
        continue;
      }
      // Ground under the banner: the road edge height (banked roads lift one edge).
      const edge = track.toWorld(s, side * half, 0, tmpB);
      const out = right.clone().multiplyScalar(side);
      const foot = f.pos.clone().addScaledVector(out, off);
      foot.y = edge.y;
      // Face the road, turned towards oncoming racers so the emblem reads from the chase camera.
      const facing = out.clone().negate().addScaledVector(fwd, -0.8).normalize();
      const bw = 3.2;
      const bh = 8.5 + r() * 2;
      const topH = bh + 3.5;
      const along = new THREE.Vector3().crossVectors(UP, facing).normalize();
      for (const e of [-1, 1]) {
        const pf = foot.clone().addScaledVector(along, e * (bw / 2 + 0.18));
        struct.beam(pf.clone().addScaledVector(UP, -6), pf.clone().addScaledVector(UP, topH + 0.9), 0.22, steel);
        struct.box(pf.clone().addScaledVector(UP, topH + 1.05), along, UP, facing, 0.17, 0.17, 0.17, steelLight);
      }
      const top = foot.clone().addScaledVector(UP, topH);
      struct.beam(top.clone().addScaledVector(along, -(bw / 2 + 0.4)), top.clone().addScaledVector(along, bw / 2 + 0.4), 0.16, steel);
      banners.push({ top: top.addScaledVector(UP, -0.1), facing, width: bw, height: bh, color: k++ % 2 ? teamB : teamA });
      if (dense && !low && r() < 0.35) mast(f.pos.clone().addScaledVector(out, off + 3).setY(edge.y), out.clone().negate(), fwd, 14);
      s += next;
    }
  }

  // ---------------------------------------------------------------- meshes
  const structGeo = struct.build();
  const structMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.15, side: THREE.DoubleSide });
  const structMesh = new THREE.Mesh(structGeo, structMat);
  structMesh.castShadow = true;
  structMesh.receiveShadow = true;
  structMesh.frustumCulled = false; // spans the whole lap anyway
  group.add(structMesh);

  const clothGeo = cloth.build();
  const { mat: clothMat, uniforms: clothU } = clothMaterial();
  const clothMesh = new THREE.Mesh(clothGeo, clothMat);
  clothMesh.castShadow = true;
  clothMesh.receiveShadow = true;
  clothMesh.frustumCulled = false;
  group.add(clothMesh);

  const crowd = buildCrowd(people, !low);
  group.add(crowd.mesh);
  const flags = buildBanners(banners, emblem, quality !== 'low');
  group.add(flags.mesh);

  return {
    object: group,
    update(view) {
      clothU.uTime.value = view.time;
      crowd.uniforms.uTime.value = view.time;
      crowd.uniforms.uPlayer.value.copy(view.playerPos);
      flags.uniforms.uTime.value = view.time;
    },
    dispose() {
      structGeo.dispose();
      structMat.dispose();
      clothGeo.dispose();
      clothMat.dispose();
      crowd.dispose();
      flags.dispose();
    },
  };
};
