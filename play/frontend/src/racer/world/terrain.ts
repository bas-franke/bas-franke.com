// Ground and canyon around the track. Three kinds of geometry, all with the procedural sandstone/sand shader
// (terrainMaterial.ts) and all sharing the height functions in terrainField.ts so they meet without seams:
// - track chunks (one mesh per ~250 m of track): the ground ribbon from the centreline (the race surface is sand) to
//   the canyon wall (or ~110 m out where a side is open) and the stratified cliff walls at zones.wallOffset;
// - one mesh per gorge: the chasm's stepped walls dropping `depth` metres under the bridge;
// - a heightfield of ~1 km tiles out to ~1.7 km past the track: plateaus behind the walls, the chasm floor and the
//   rock blocks the waterfalls pour from, open desert with distant buttes. Finer near the track, coarse far away.
// Plus instanced boulders, pebbles and scrub (rockScatter.ts), and the rocks that shape the course (rockFormations.ts):
// the boulder walls along its edges, the formations to steer round and the caves. Chunks are frustum-culled by three.

import * as THREE from 'three';
import { addCliff, type CliffColumn } from './rockCliff';
import { buildFormations } from './rockFormations';
import { buildScatter } from './rockScatter';
import { TerrainField, type Gorge } from './terrainField';
import { GeoBuilder } from './terrainGeo';
import { createTerrainMaterial } from './terrainMaterial';
import { makeStrata, type Strata } from './terrainNoise';
import type { Quality, WorldBuilder } from './types';
import { zonesFor } from './zones';

interface Settings {
  /** Track frames (~2 m) per column of the ribbon and walls. */
  stride: number;
  /** Lateral vertices of the ground ribbon. */
  ribbon: number;
  /** Columns per track chunk. */
  chunk: number;
  /** Heightfield cell sizes: gorge, near the track, middle distance, far; tile size; margin around the track. */
  cells: [number, number, number, number];
  tile: number;
  margin: number;
  flutes: number;
}

const SETTINGS: Record<Quality, Settings> = {
  high: { stride: 2, ribbon: 18, chunk: 64, cells: [4, 10, 20, 40], tile: 240, margin: 1500, flutes: 1.1 },
  medium: { stride: 3, ribbon: 14, chunk: 44, cells: [6, 12, 24, 48], tile: 240, margin: 1600, flutes: 0.8 },
  low: { stride: 4, ribbon: 10, chunk: 32, cells: [8, 16, 30, 60], tile: 240, margin: 1300, flutes: 0 },
};

export const buildTerrain: WorldBuilder = (ctx) => {
  const t0 = performance.now();
  const { track, theme, quality } = ctx;
  const S = SETTINGS[quality] ?? SETTINGS.high;
  const zones = zonesFor(track);
  const strata = makeStrata(track.def.seed);
  const field = new TerrainField(track, zones, S.stride, S.margin);
  const mat = createTerrainMaterial(theme, strata, quality);
  const group = new THREE.Group();
  group.name = 'terrain';
  const geos: THREE.BufferGeometry[] = [];
  const addMesh = (b: GeoBuilder, name: string, cast: boolean) => {
    const g = b.toGeometry();
    if (!g) return;
    geos.push(g);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  };

  buildTrackChunks(field, strata, S, track.length, addMesh);
  for (const g of field.gorges) buildChasm(field, g, strata, S, addMesh);
  buildHeightfield(field, S, addMesh);
  const scatter = buildScatter(track, field, theme, quality, mat, S.stride);
  for (const m of scatter.meshes) group.add(m);
  const formations = buildFormations(track, field, quality, mat);
  for (const m of formations.meshes) group.add(m);

  const ms = performance.now() - t0;
  group.userData.buildMs = ms;
  if (import.meta.env.DEV) console.info(`terrain: ${group.children.length} meshes, built in ${ms.toFixed(0)} ms`);

  return {
    object: group,
    dispose() {
      for (const g of geos) g.dispose();
      scatter.dispose();
      formations.dispose();
      mat.dispose();
    },
  };
};

type AddMesh = (b: GeoBuilder, name: string, cast: boolean) => void;

/** Ground ribbons and canyon walls, chunked along the track. */
function buildTrackChunks(field: TerrainField, strata: Strata, S: Settings, length: number, addMesh: AddMesh) {
  const n = field.n;
  const track = field.track;
  // Kickers and shortcut lanes shape the ground across the corridor: there every frame is a column, and the ribbon
  // gets extra rows across the corridor so ramps, ledges and the tunnel's drop keep their edges.
  const dense = (i: number) => {
    const s = track.frames[i].s;
    return track.kickers.some((k) => s > k.s0 - 6 && s < k.s1 + 6) || track.shortcuts.some((c) => s > c.s0 - 6 && s < c.s1 + 14);
  };
  const EXTRA = Math.round(S.ribbon * 3.5);
  const cols: number[] = [];
  for (let c = 0; c < n; c++) if (c % S.stride === 0 || dense(c)) cols.push(c);
  if (cols[cols.length - 1] !== n - 1) cols.push(n - 1); // the open end of the course
  const step = length / n;
  const edgeOf = (i: number): Gorge | undefined => field.gorges.find((g) => g.edge0 === i || g.edge1 === i);
  const N = S.ribbon;

  for (let c0 = 0; c0 < cols.length - 1; c0 += S.chunk) {
    const chunk = cols.slice(c0, Math.min(cols.length, c0 + S.chunk + 1));
    const b = new GeoBuilder();
    for (const side of [-1, 1] as const) {
      const si = side < 0 ? 0 : 1;
      // Ground ribbon, in runs of columns outside the gorges.
      let run: number[] = [];
      let runDense = false;
      const flushRibbon = () => {
        const R = runDense ? N + EXTRA : N;
        if (run.length >= 2) {
          const p = new Float32Array(run.length * R * 3);
          const sh = new Float32Array(run.length * R);
          run.forEach((cc, k) => {
            const i = cc % n;
            const g = edgeOf(i);
            const rx = (g ? g.rx : field.rx[i]) * side;
            const rz = (g ? g.rz : field.rz[i]) * side;
            const dEnd = field.dEnd[si][i];
            // From the centreline out: the race surface is part of the sand, there is no separate road. Dense columns
            // keep every usual row (so they meet ordinary ones) plus even rows out to just past the corridor.
            const ds: number[] = [];
            for (let j = 0; j < N; j++) ds.push(dEnd * Math.pow(j / (N - 1), 1.4));
            if (runDense) {
              const D = Math.min(dEnd, field.x0[i] + 14);
              for (let j = 1; j <= EXTRA; j++) ds.push((D * j) / (EXTRA + 1));
              ds.sort((a, b) => a - b);
            }
            for (let j = 0; j < R; j++) {
              const d = ds[j];
              sh[k * R + j] = field.caveShade[i];
              const x = field.posX[i] + rx * d;
              const z = field.posZ[i] + rz * d;
              const q = (k * R + j) * 3;
              p[q] = x;
              p[q + 1] = field.groundY(i, side, d, x, z);
              p[q + 2] = z;
            }
          });
          b.addGrid(p, run.length, R, side < 0 ? 1 : -1, 0, sh);
        }
        run = [];
      };
      for (const cc of chunk) {
        if (field.gorgeAtFrame(cc % n)) {
          flushRibbon();
          continue;
        }
        // Switching between ordinary and dense columns: this column closes one run and opens the next.
        const dn = dense(cc % n);
        if (run.length && dn !== runDense) {
          run.push(cc);
          flushRibbon();
        }
        runDense = dn;
        run.push(cc);
      }
      flushRibbon();

      // Canyon wall, in runs where the side is closed (not at gorge edges or open vistas).
      let wall: CliffColumn[] = [];
      const flushWall = () => {
        if (wall.length >= 2)
          addCliff(b, wall, strata, { lean: 0.04, buttress: 9, cleft: 6, flutes: S.flutes, period: 20, lift: 0.4, crown: 16, seed: si * 17 + 3 });
        wall = [];
      };
      for (const cc of chunk) {
        const i = cc % n;
        const W = field.W[si][i];
        if (!Number.isFinite(W) || field.gorgeAtFrame(i) || edgeOf(i) || field.crest[si][i] - field.posY[i] < 0.5) {
          flushWall();
          continue;
        }
        wall.push({
          x: field.posX[i] + field.rx[i] * side * W,
          z: field.posZ[i] + field.rz[i] * side * W,
          ox: -field.rx[i] * side,
          oz: -field.rz[i] * side,
          along: cc * step,
          bottom: Math.min(field.posY[i], field.groundY(i, side, W - 14, field.posX[i] + field.rx[i] * side * (W - 14), field.posZ[i] + field.rz[i] * side * (W - 14))) - 0.4,
          top: field.crest[si][i],
          back: field.back,
        });
      }
      flushWall();
    }
    addMesh(b, `terrain-track-${c0}`, true);
  }
}

/** The two stepped walls of a gorge chasm, facing each other across the bridge. */
function buildChasm(field: TerrainField, g: Gorge, strata: Strata, S: Settings, addMesh: AddMesh) {
  const b = new GeoBuilder();
  const footShift = 5;
  const colStep = S.stride * 2;
  for (const [edge, dir] of [[g.edge0, 1], [g.edge1, -1]] as const) {
    const cols: CliffColumn[] = [];
    const ex = field.posX[edge];
    const ez = field.posZ[edge];
    for (let d = -g.reach; d <= g.reach; d += colStep) {
      const side = d < 0 ? -1 : 1;
      const si = side < 0 ? 0 : 1;
      const ad = Math.abs(d);
      // Crest: the ground ribbon's height near the road, the wall top beside it, the open terrain beyond.
      const cx = ex + g.rx * d;
      const cz = ez + g.rz * d;
      const W = field.W[si][edge];
      let top: number;
      if (ad < field.x0[edge]) top = field.posY[edge] - 0.6;
      else if (ad < field.dEnd[si][edge] && (!Number.isFinite(W) || ad < W)) top = field.groundY(edge, side, ad, cx, cz) - 0.25;
      else if (Number.isFinite(W) && ad < W + field.back) top = field.crest[si][edge];
      else top = field.regular(cx - g.ax * dir * (g.back + 3), cz - g.az * dir * (g.back + 3));
      const fx = cx + g.ax * dir * footShift;
      const fz = cz + g.az * dir * footShift;
      const bottom = field.chasmFloor(g, d, fx, fz);
      cols.push({ x: fx, z: fz, ox: g.ax * dir, oz: g.az * dir, along: d + dir * 977, bottom, top: Math.max(top, bottom + 0.5), back: g.back + footShift });
    }
    addCliff(b, cols, strata, { lean: 0.035, buttress: 4, cleft: 2, flutes: S.flutes, period: 28, lift: -0.25, seed: edge });
  }
  addMesh(b, 'terrain-chasm', true);
}

/** Heightfield tiles, finer near the track and the gorges, merged into ~1 km meshes. */
function buildHeightfield(field: TerrainField, S: Settings, addMesh: AddMesh) {
  const T = S.tile;
  const a = field.area;
  const ntx = Math.ceil((a.max.x - a.min.x) / T);
  const ntz = Math.ceil((a.max.y - a.min.y) / T);
  const G = 4; // tiles per merged mesh side
  const gorgeBoxes = field.gorges.map((g) => {
    const box = new THREE.Box2();
    for (const [aa, dd] of [[g.a0 - 40, -g.reach], [g.a0 - 40, g.reach], [g.a1 + 40, -g.reach], [g.a1 + 40, g.reach]]) {
      box.expandByPoint(new THREE.Vector2(g.mx + g.ax * aa + g.rx * dd, g.mz + g.az * aa + g.rz * dd));
    }
    return box;
  });
  // Cell size per tile first, so skirts are only added where a neighbour has a different resolution.
  const cells = new Float32Array(ntx * ntz);
  for (let tz = 0; tz < ntz; tz++) {
    for (let tx = 0; tx < ntx; tx++) {
      const x0 = a.min.x + tx * T;
      const z0 = a.min.y + tz * T;
      const tileBox = new THREE.Box2(new THREE.Vector2(x0, z0), new THREE.Vector2(x0 + T, z0 + T));
      field.nearest(x0 + T / 2, z0 + T / 2);
      const dist = Math.abs(field.qd) - T * 0.75;
      cells[tz * ntx + tx] = gorgeBoxes.some((gb) => gb.intersectsBox(tileBox)) ? S.cells[0] : dist < 380 ? S.cells[1] : dist < 950 ? S.cells[2] : S.cells[3];
    }
  }
  const cellAt = (tx: number, tz: number) => (tx < 0 || tz < 0 || tx >= ntx || tz >= ntz ? -1 : cells[tz * ntx + tx]);
  for (let gz = 0; gz < ntz; gz += G) {
    for (let gx = 0; gx < ntx; gx += G) {
      const b = new GeoBuilder();
      for (let tz = gz; tz < Math.min(ntz, gz + G); tz++) {
        for (let tx = gx; tx < Math.min(ntx, gx + G); tx++) {
          const c = cellAt(tx, tz);
          const skirts: [boolean, boolean, boolean, boolean] = [cellAt(tx, tz - 1) !== c, cellAt(tx, tz + 1) !== c, cellAt(tx - 1, tz) !== c, cellAt(tx + 1, tz) !== c];
          addTile(b, field, a.min.x + tx * T, a.min.y + tz * T, T, c, skirts);
        }
      }
      addMesh(b, `terrain-field-${gx}-${gz}`, false);
    }
  }
}

function addTile(b: GeoBuilder, field: TerrainField, x0: number, z0: number, T: number, cell: number, skirts: boolean[]) {
  const m = Math.round(T / cell);
  const R = m + 3; // with a one-cell border for normals
  const h = new Float32Array(R * R);
  const rock = new Float32Array(R * R);
  for (let j = 0; j < R; j++) {
    for (let i = 0; i < R; i++) {
      h[j * R + i] = field.height(x0 + (i - 1) * cell, z0 + (j - 1) * cell);
      rock[j * R + i] = field.rock;
    }
  }
  const V = m + 1;
  const p = new Float32Array(V * V * 3);
  const nrm = new Float32Array(V * V * 3);
  const rk = new Float32Array(V * V);
  const nv = new THREE.Vector3();
  // Column-major for addGrid: columns along x, rows along z.
  for (let i = 0; i < V; i++) {
    for (let j = 0; j < V; j++) {
      const q = i * V + j;
      const hi = (j + 1) * R + (i + 1);
      p[q * 3] = x0 + i * cell;
      p[q * 3 + 1] = h[hi];
      p[q * 3 + 2] = z0 + j * cell;
      nv.set(h[hi - 1] - h[hi + 1], 2 * cell, h[hi - R] - h[hi + R]).normalize();
      nrm[q * 3] = nv.x;
      nrm[q * 3 + 1] = nv.y;
      nrm[q * 3 + 2] = nv.z;
      rk[q] = rock[hi];
    }
  }
  b.addGrid(p, V, V, -1, rk, 1, undefined, nrm);
  // Skirts hide cracks against neighbouring tiles of another resolution (drawn both ways round).
  const edges: number[][] = [[], [], [], []];
  for (let k = 0; k < V; k++) {
    edges[0].push(k * V); // z = z0
    edges[1].push(k * V + V - 1); // z = z0 + T
    edges[2].push(k); // x = x0
    edges[3].push((V - 1) * V + k); // x = x0 + T
  }
  edges.forEach((e, ei) => {
    if (!skirts[ei]) return;
    const sp = new Float32Array(e.length * 2 * 3);
    const sn = new Float32Array(e.length * 2 * 3);
    const sr = new Float32Array(e.length * 2);
    e.forEach((q, k) => {
      for (let r = 0; r < 2; r++) {
        const o = (k * 2 + r) * 3;
        sp[o] = p[q * 3];
        sp[o + 1] = p[q * 3 + 1] - r * 25;
        sp[o + 2] = p[q * 3 + 2];
        sn[o] = nrm[q * 3];
        sn[o + 1] = nrm[q * 3 + 1];
        sn[o + 2] = nrm[q * 3 + 2];
        sr[k * 2 + r] = rk[q];
      }
    });
    b.addGrid(sp, e.length, 2, 1, sr, 1, undefined, sn);
    b.addGrid(sp, e.length, 2, -1, sr, 1, undefined, sn);
  });
}
