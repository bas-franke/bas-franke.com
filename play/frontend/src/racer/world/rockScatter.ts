// Loose stuff on the ground, all instanced: fallen sandstone blocks piled at the foot of the canyon walls, small rocks
// and pebble clusters on the sand beside the road, and sparse dry scrub on the ground and along the plateau rims.
// Three draw calls in total.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng, type Track } from '../core/track';
import type { Theme } from '../core/tracks';
import type { TerrainField } from './terrainField';
import { noise2 } from './terrainNoise';
import type { Quality } from './types';

/** A chunky faceted rock, roughly unit radius, flat-shaded, with the terrain shader's attributes. */
function rockGeometry(seed: number, detail: number) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  // Displace the shared corners consistently, then cut a few flat facets (blocky sandstone, not potatoes).
  const planes = [0, 1, 2, 3, 4].map((k) => new THREE.Vector3(Math.sin(k * 2.1 + seed), Math.cos(k * 1.3 + seed) * 0.8, Math.cos(k * 2.7 - seed)).normalize());
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = 1 + (noise2(v.x * 2.1 + seed, v.z * 2.1 + v.y * 1.7) - 0.5) * 0.45;
    v.multiplyScalar(r);
    for (const pl of planes) {
      const d = v.dot(pl);
      if (d > 0.72) v.addScaledVector(pl, 0.72 - d);
    }
    v.y = Math.max(v.y * 0.8, -0.55);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const flat = g; // icosahedra are already non-indexed: flat facets
  flat.computeVertexNormals();
  const n = flat.attributes.position.count;
  flat.setAttribute('aRock', new THREE.Float32BufferAttribute(new Float32Array(n).fill(1), 1));
  const shade = new Float32Array(n);
  const ps = flat.attributes.position;
  for (let i = 0; i < n; i++) shade[i] = 0.7 + 0.3 * THREE.MathUtils.clamp((ps.getY(i) + 0.55) / 1.2, 0, 1);
  flat.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
  return flat;
}

/** A low dry bush: a few lumpy faceted blobs clustered together, base at y = 0. */
function scrubGeometry() {
  const lumps: THREE.BufferGeometry[] = [];
  const spots: [number, number, number, number][] = [[0, 0.55, 0, 0.75], [0.55, 0.4, 0.2, 0.55], [-0.45, 0.4, -0.25, 0.6]];
  for (const [x, y, z, r] of spots) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const k = 1 + (noise2(p.getX(i) * 4 + x * 9, p.getZ(i) * 4 + p.getY(i) * 3) - 0.5) * 0.5;
      p.setXYZ(i, p.getX(i) * k + x, Math.max(p.getY(i) * k * 0.85 + y, 0), p.getZ(i) * k + z);
    }
    lumps.push(g);
  }
  const merged = mergeGeometries(lumps)!;
  for (const g of lumps) g.dispose();
  merged.computeVertexNormals();
  return merged;
}

export function buildScatter(track: Track, field: TerrainField, theme: Theme, quality: Quality, rockMat: THREE.Material, stride: number) {
  const density = quality === 'high' ? 1 : quality === 'medium' ? 0.6 : 0.25;
  const r = rng(track.def.seed * 31 + 7);
  const n = field.n;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const boulders: THREE.Matrix4[] = [];
  const pebbles: THREE.Matrix4[] = [];
  const scrubs: THREE.Matrix4[] = [];
  const scrubCol: THREE.Color[] = [];
  const place = (list: THREE.Matrix4[], x: number, y: number, z: number, sx: number, sy: number, sz: number, tilt = 0.25) => {
    e.set((r() - 0.5) * tilt, r() * Math.PI * 2, (r() - 0.5) * tilt);
    q.setFromEuler(e);
    list.push(m.compose(p.set(x, y, z), q, s.set(sx, sy, sz)).clone());
  };
  const base = new THREE.Color(theme.scrub);
  const dry = new THREE.Color(theme.sand).lerp(new THREE.Color('#9a5a2c'), 0.6);
  const green = new THREE.Color('#4f6a26');

  for (let c = 0; c < n; c += stride) {
    if (field.gorgeAtFrame(c)) continue;
    const near = field.gorges.some((g) => c === g.edge0 || c === g.edge1);
    for (const side of [-1, 1] as const) {
      const si = side < 0 ? 0 : 1;
      const W = field.W[si][c];
      const x0 = field.x0[c];
      const dEnd = field.dEnd[si][c];
      const rx = field.rx[c] * side;
      const rz = field.rz[c] * side;
      const tx = field.tx[c];
      const tz = field.tz[c];
      const at = (d: number, along: number): [number, number] => [field.posX[c] + rx * d + tx * along, field.posZ[c] + rz * d + tz * along];
      // Fallen blocks at the wall foot.
      if (Number.isFinite(W) && !near && field.crest[si][c] - field.posY[c] > 6) {
        const k = r() < 0.6 * density ? 1 + Math.floor(r() * 2) : 0;
        for (let j = 0; j < k; j++) {
          const big = r() < 0.18;
          const sc = big ? 3.5 + r() * 4.5 : 0.8 + r() * r() * 3;
          const d = W - (big ? sc * 0.4 : 1 + r() * 9);
          const [x, z] = at(d, (r() - 0.5) * stride * 2);
          place(sc > 2.5 ? boulders : pebbles, x, field.groundY(c, side, d, x, z) + sc * 0.15, z, sc * (0.9 + r() * 0.5), sc * (0.6 + r() * 0.5), sc * (0.9 + r() * 0.5), 0.5);
        }
      }
      // Small rocks on the sand.
      const nr = r() < 0.9 * density ? 1 + Math.floor(r() * 2) : 0;
      for (let j = 0; j < nr; j++) {
        const d = x0 + 4 + r() * (Math.min(dEnd, 90) - x0 - 4);
        const [x, z] = at(d, (r() - 0.5) * stride * 2);
        const sc = 0.25 + r() * r() * 1.1;
        place(pebbles, x, field.groundY(c, side, d, x, z) + sc * 0.1, z, sc, sc * (0.6 + r() * 0.4), sc * (0.8 + r() * 0.5), 0.6);
      }
      // Scrub on the ground and along the plateau rim.
      const ns = r() < 0.55 * density ? 1 + Math.floor(r() * 2) : 0;
      for (let j = 0; j < ns; j++) {
        const rim = Number.isFinite(W) && r() < 0.35;
        let d: number;
        let y: number;
        const sc = 0.6 + r() * 1.3;
        let x: number;
        let z: number;
        if (rim) {
          d = W + field.back + 2 + r() * 40;
          [x, z] = at(d, (r() - 0.5) * stride * 2);
          y = field.height(x, z);
        } else {
          d = x0 + 6 + r() * (Math.min(dEnd, 100) - x0 - 6);
          [x, z] = at(d, (r() - 0.5) * stride * 2);
          y = field.groundY(c, side, d, x, z);
        }
        place(scrubs, x, y - 0.1, z, sc * (1 + r() * 0.6), sc, sc * (1 + r() * 0.6), 0.2);
        const t = r();
        scrubCol.push(base.clone().lerp(t < 0.5 ? dry : green, r() * 0.7).multiplyScalar(0.85 + r() * 0.3));
      }
    }
  }

  const parts: THREE.InstancedMesh[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const make = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], cast: boolean) => {
    geos.push(geo);
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = cast;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    parts.push(im);
    return im;
  };
  make(rockGeometry(1.7, quality === 'low' ? 0 : 1), rockMat, boulders, quality !== 'low');
  make(rockGeometry(4.2, 0), rockMat, pebbles, false);
  const scrubMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true });
  const sm = make(scrubGeometry(), scrubMat, scrubs, false);
  if (sm) {
    scrubCol.forEach((c, i) => sm.setColorAt(i, c));
    if (sm.instanceColor) sm.instanceColor.needsUpdate = true;
  }
  return {
    meshes: parts,
    dispose() {
      for (const g of geos) g.dispose();
      scrubMat.dispose();
    },
  };
}
