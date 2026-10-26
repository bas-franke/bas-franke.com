// Airships drifting above the circuit: bulbous cigar hulls with banded plating, cross tail fins, little propeller
// engines on pylons and a gondola underneath, like the one in the concept art's sky. They fly slow, wide loops at
// 150-400 m and bob gently; a few tiny distant ships cross the far sky as specks. One InstancedMesh per kind.

import * as THREE from 'three';
import { rng } from '../core/track';
import { GeoBin, at, capFog } from './cityKit';
import type { WorldContext, WorldPart } from './types';

/** One airship model, nose towards -Z, ~60 m long. */
function airshipGeometry(detail: boolean): THREE.BufferGeometry {
  const bin = new GeoBin();
  const L = 60;
  const R = 9.5;
  // Hull: lathe along +Y (tail at -L/2, nose at +L/2), then turned so the nose points to -Z. Fuller towards the nose.
  const prof: THREE.Vector2[] = [];
  const n = detail ? 22 : 12;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const w = Math.pow(Math.sin(Math.pow(u, 1.3) * Math.PI), 0.62);
    prof.push(new THREE.Vector2(Math.max(0.01, R * w), -L / 2 + u * L));
  }
  const hull = new THREE.LatheGeometry(prof, detail ? 18 : 10);
  // Vertex colours: pale grey plating, darker rib bands, an orange band near the nose, a dark tail cap.
  const pos = hull.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const light = new THREE.Color('#d2cbc0');
  const rib = new THREE.Color('#8a8279');
  const orange = new THREE.Color('#d8742c');
  const dark = new THREE.Color('#4b4642');
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getY(i) + L / 2) / L;
    c.copy(light);
    if (Math.abs(((u * 9) % 1) - 0.5) < 0.06) c.copy(rib);
    if (u > 0.72 && u < 0.78) c.copy(orange);
    if (u < 0.05 || u > 0.97) c.copy(dark);
    // Darker belly: a cheap occlusion hint.
    if (pos.getZ(i) < -R * 0.6) c.multiplyScalar(0.85);
    col.set([c.r, c.g, c.b], i * 3);
  }
  hull.setAttribute('color', new THREE.BufferAttribute(col, 3));
  hull.rotateX(-Math.PI / 2);
  bin.add(hull);

  // Cross tail fins.
  const fin = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(14, 0), new THREE.Vector2(10, 9), new THREE.Vector2(3, 9)]);
  for (let k = 0; k < 4; k++) {
    const g = new THREE.ExtrudeGeometry(fin, { depth: 0.6, bevelEnabled: false });
    g.translate(0, R * 0.25, -0.3);
    // Shape x runs along the hull (towards the tail), y outward.
    const m = new THREE.Matrix4().makeRotationZ((k * Math.PI) / 2 + Math.PI / 4).multiply(new THREE.Matrix4().makeRotationY(-Math.PI / 2));
    m.setPosition(0, 0, L / 2 - 16);
    bin.add(g, k % 2 ? '#b8b0a6' : '#c96a2e', m);
  }
  // Engines on pylons, two per side, with a propeller ring.
  for (const sx of [-1, 1]) {
    for (const [z, y] of [
      [4, -2],
      [-12, -3],
    ]) {
      const x = sx * (R + 3.5);
      bin.beam(new THREE.Vector3(sx * R * 0.8, y + 1, z), new THREE.Vector3(x, y, z), 0.8, 0.5, '#5a544e');
      bin.add(new THREE.CylinderGeometry(1.6, 1.9, 6, detail ? 10 : 6), '#6b645d', new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(x, y, z));
      bin.add(new THREE.SphereGeometry(1.6, 8, 4), '#c96a2e', new THREE.Matrix4().makeTranslation(x, y, z - 3));
      if (detail) bin.add(new THREE.TorusGeometry(2.6, 0.18, 3, 12), '#3b3734', new THREE.Matrix4().makeTranslation(x, y, z + 3.4));
      bin.add(new THREE.CylinderGeometry(0.9, 0.9, 0.4, 8), '#9fe4ff', new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(x, y, z + 3.1));
    }
  }
  // Gondola: a capsule under the hull with a dark window band, hung on struts.
  const gy = -R - 3.5;
  bin.add(new THREE.CapsuleGeometry(3, 14, 3, detail ? 10 : 6), '#bfb6aa', new THREE.Matrix4().makeRotationX(Math.PI / 2).scale(new THREE.Vector3(1, 1, 0.8)).setPosition(0, gy, -4));
  bin.add(new THREE.BoxGeometry(6.3, 1.2, 14), '#2c2830', at(0, gy + 0.6, -4));
  bin.add(new THREE.BoxGeometry(6.6, 0.4, 16), '#c96a2e', at(0, gy - 0.7, -4));
  for (const z of [-10, 2]) for (const sx of [-1, 1]) bin.beam(new THREE.Vector3(sx * 2, gy + 2, z), new THREE.Vector3(sx * 3.5, -R * 0.75, z), 0.4, 0.4, '#5a544e');
  // A small antenna mast and a flag pennant on top.
  bin.beam(new THREE.Vector3(0, R - 0.5, -6), new THREE.Vector3(0, R + 5, -4), 0.3, 0.3, '#5a544e');
  return bin.build();
}

/** A tiny far-away ship: hull and fins only. */
function speckGeometry(): THREE.BufferGeometry {
  const bin = new GeoBin();
  const prof = [0, 0.6, 0.9, 1, 0.9, 0.55, 0].map((w, i, a) => new THREE.Vector2(Math.max(0.01, w * 2), -5 + (i / (a.length - 1)) * 10));
  bin.add(new THREE.LatheGeometry(prof, 6).rotateX(-Math.PI / 2), '#8f8780');
  bin.add(new THREE.BoxGeometry(5, 0.3, 2.5), '#6d6660', at(0, 0, 4));
  bin.add(new THREE.BoxGeometry(0.3, 3, 2.5), '#6d6660', at(0, 1, 4));
  bin.add(new THREE.BoxGeometry(1.2, 1, 3), '#5a544e', at(0, -2.2, -0.5));
  return bin.build();
}

interface Flight {
  cx: number;
  cz: number;
  radius: number;
  alt: number;
  /** Angular speed (rad/s), signed. */
  w: number;
  phase: number;
  scale: number;
  bob: number;
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler(0, 0, 0, 'YXZ');
const p = new THREE.Vector3();
const s = new THREE.Vector3();

function place(mesh: THREE.InstancedMesh, flights: Flight[], time: number) {
  for (let i = 0; i < flights.length; i++) {
    const f = flights[i];
    const th = f.phase + f.w * time;
    p.set(f.cx + Math.cos(th) * f.radius, f.alt + Math.sin(time * 0.25 + f.phase * 3) * f.bob, f.cz + Math.sin(th) * f.radius);
    // Direction of travel is d/dθ scaled by the sign of w; nose (-Z) points along it.
    const dx = -Math.sin(th) * Math.sign(f.w);
    const dz = Math.cos(th) * Math.sign(f.w);
    e.set(Math.cos(time * 0.25 + f.phase * 3) * 0.02, Math.atan2(-dx, -dz), -Math.sign(f.w) * 0.06);
    q.setFromEuler(e);
    s.setScalar(f.scale);
    m4.compose(p, q, s);
    mesh.setMatrixAt(i, m4);
  }
  mesh.instanceMatrix.needsUpdate = true;
}

export function buildAirships(ctx: WorldContext, city: { pos: THREE.Vector3; height: number } | null): WorldPart {
  const { track, quality } = ctx;
  const r = rng(track.def.seed * 977 + 5);
  const low = quality === 'low';
  const group = new THREE.Group();
  group.name = 'airships';
  const size = track.bounds.getSize(new THREE.Vector3());
  // Long courses repeat a base layout in blocks (TrackDef.blocks): each block gets its own fleet, circling the middle
  // of its stretch of the course at the scale of a base layout.
  const B = track.blocks;
  const span = Math.max(size.x, size.z) / 2 / B;
  const ground = track.bounds.min.y;
  const centreOf = (k: number) => {
    if (B === 1) return track.bounds.getCenter(new THREE.Vector3());
    const a = track.frameAt((track.length * k) / B).pos;
    const b = track.frameAt((track.length * (k + 1)) / B).pos;
    return a.clone().add(b).multiplyScalar(0.5);
  };

  const ships: Flight[] = [];
  const nShips = low ? 2 : 3;
  for (let n = 0; n < nShips * B; n++) {
    const i = n % nShips;
    const c = centreOf(Math.floor(n / nShips));
    const R = span * (0.35 + i * 0.3) + r() * 120;
    // Speed 8-14 m/s along the loop.
    const v = 8 + r() * 6;
    ships.push({
      cx: c.x + (r() - 0.5) * span * 0.4,
      cz: c.z + (r() - 0.5) * span * 0.4,
      radius: R,
      alt: ground + 160 + i * 90 + r() * 60,
      w: (v / R) * (i % 2 ? -1 : 1),
      phase: r() * Math.PI * 2,
      scale: 0.9 + r() * 0.4,
      bob: 3 + r() * 3,
    });
  }
  // One more ship circling the mesa city, when there is one.
  if (city && !low) {
    const R = 260;
    ships.push({ cx: city.pos.x, cz: city.pos.z, radius: R, alt: city.pos.y + city.height + 140, w: 9 / R, phase: r() * 6.28, scale: 1.25, bob: 4 });
  }
  const specks: Flight[] = [];
  const nSpecks = low ? 4 : 8;
  for (let i = 0; i < nSpecks * B; i++) {
    const c = centreOf(Math.floor(i / nSpecks));
    const R = span + 900 + r() * 1400;
    const v = 18 + r() * 25;
    specks.push({
      cx: c.x + (r() - 0.5) * 600,
      cz: c.z + (r() - 0.5) * 600,
      radius: R,
      alt: ground + 250 + r() * 450,
      w: (v / R) * (r() < 0.5 ? -1 : 1),
      phase: r() * Math.PI * 2,
      scale: 0.8 + r() * 0.8,
      bob: 2,
    });
  }

  const shipGeo = airshipGeometry(!low);
  const shipMat = capFog(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 }), 0.55);
  const shipMesh = new THREE.InstancedMesh(shipGeo, shipMat, ships.length);
  shipMesh.frustumCulled = false;
  shipMesh.name = 'airshipFleet';
  const speckGeo = speckGeometry();
  const speckMat = capFog(new THREE.MeshLambertMaterial({ vertexColors: true }), 0.5);
  const speckMesh = new THREE.InstancedMesh(speckGeo, speckMat, specks.length);
  speckMesh.frustumCulled = false;
  speckMesh.name = 'airshipSpecks';
  group.add(shipMesh, speckMesh);
  place(shipMesh, ships, 0);
  place(speckMesh, specks, 0);

  return {
    object: group,
    update(view) {
      place(shipMesh, ships, view.time);
      place(speckMesh, specks, view.time);
    },
    dispose() {
      shipGeo.dispose();
      shipMat.dispose();
      speckGeo.dispose();
      speckMat.dispose();
      shipMesh.dispose();
      speckMesh.dispose();
    },
  };
}
