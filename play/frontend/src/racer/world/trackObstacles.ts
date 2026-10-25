// What sits on the road itself: the sandstone rocks the pods must dodge (track.obstacles, the same ones physics and
// the AI use) and the markings on the jump ramps (chevrons up the kicker, a hazard band at the lip). Rocks are one
// merged flat-shaded mesh; the ramp markings go into the shared barrier-atlas geometry.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAMP_LEN, rng, type Track } from '../core/track';
import type { Theme } from '../core/tracks';
import type { GeoBuilder, UV } from './trackGeo';
import { noise2 } from './terrainNoise';
import { ROW, rowV } from './trackTextures';

/** A blocky sandstone rock, unit radius, base at y = 0 and top at y = 1, coloured from shade at the foot to lit on top. */
function rockGeometry(seed: number, lit: THREE.Color, shade: THREE.Color) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // Same displacement for every copy of a corner, so the facets stay closed.
    const k = 1 + (noise2(v.x * 1.7 + seed, v.z * 1.7 + v.y * 1.3) - 0.5) * 0.5;
    v.x *= k;
    v.z *= k;
    // A flat top, slightly narrower than the base: a weathered pillar, not a ball.
    const y = Math.min(0.75, v.y);
    v.y = (y + 1) / 1.75;
    v.x *= 1 - v.y * 0.25;
    v.z *= 1 - v.y * 0.25;
    p.setXYZ(i, v.x, v.y, v.z);
    c.copy(shade).lerp(lit, Math.min(1, v.y * 1.3));
    c.toArray(col, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

export function buildObstacles(track: Track, theme: Theme, atlasGeo: GeoBuilder) {
  const r = rng(track.def.seed * 17 + 9);
  const lit = new THREE.Color(theme.rockLit);
  const shade = new THREE.Color(theme.rockShade);
  const parts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  for (const o of track.obstacles) {
    const g = rockGeometry(r() * 100, lit, shade);
    const base = track.toWorld(o.s, o.x, -0.6);
    q.setFromAxisAngle(UP, r() * Math.PI * 2);
    // Radius plus a little: the collision circle sits inside the bumpy surface.
    m.compose(base, q, new THREE.Vector3(o.r * 1.08, o.h + 0.6, o.r * 1.08));
    g.applyMatrix4(m);
    parts.push(g);
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0 });
  const geo = parts.length ? mergeGeometries(parts)! : new THREE.BufferGeometry();
  for (const g of parts) g.dispose();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'obstacles';
  mesh.castShadow = mesh.receiveShadow = true;

  // Ramp markings: strips across the kicker, chevrons on the climb and hazard stripes over the last metres.
  const fa = track.frameAt(0);
  const fb = track.frameAt(0);
  const pts = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const strip = (s0: number, s1: number, row: number) => {
    track.frameAt(s0, fa);
    track.frameAt(s1, fb);
    const [v0, v1] = rowV(row);
    const segs = 6;
    for (let i = 0; i < segs; i++) {
      const xa = -0.9 + (1.8 * i) / segs;
      const xb = -0.9 + (1.8 * (i + 1)) / segs;
      const put = (f: typeof fa, xf: number, out: THREE.Vector3) => out.copy(f.pos).addScaledVector(f.right, (xf * f.width) / 2).addScaledVector(f.up, 0.06);
      put(fa, xa, pts[0]);
      put(fa, xb, pts[1]);
      put(fb, xb, pts[2]);
      put(fb, xa, pts[3]);
      const ua = ((xa + 1) * fa.width) / 2 / 3.6;
      const ub = ((xb + 1) * fa.width) / 2 / 3.6;
      const uv: [UV, UV, UV, UV] = [
        [ua, v0],
        [ub, v0],
        [ub, v1],
        [ua, v1],
      ];
      atlasGeo.quad(pts[0], pts[1], pts[2], pts[3], uv, fa.up);
    }
  };
  for (const j of track.jumps) {
    for (let s = j.s0 + 4; s < j.lip - 6; s += RAMP_LEN / 4) strip(s, s + 2.4, ROW.chevron);
    strip(j.lip - 3.2, j.lip, ROW.hazard);
  }

  return {
    object: mesh,
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
