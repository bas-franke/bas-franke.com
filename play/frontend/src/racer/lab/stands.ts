// Lab for the stands module: the world lab with a camera placed in track space, plus (with &wall) a crude stand-in
// canyon wall, a vertical ribbon at the zones' wall offset, to judge the balconies without the terrain module.
//   /race/lab/stands?track=redrock&only=sky,track,terrain,stands&at=0.97
// Optional camera in track space relative to `at`: &cam=<x>,<h>,<ds>&tgt=<x>,<h>,<ds> (lateral, height, along).

import * as THREE from 'three';
import type { Track } from '../core/track';
import { zonesFor } from '../world/zones';
import { mount as mountWorld } from './world';

export function mount(el: HTMLElement): () => void {
  const stop = mountWorld(el);
  const lab = (window as unknown as { __lab: { scene: THREE.Scene; track: Track; camera: THREE.Camera; controls: { target: THREE.Vector3; update(): void } } }).__lab;
  const { scene, track } = lab;
  const q = new URLSearchParams(location.search);
  const at = Number(q.get('at') ?? 0.02) * track.length;
  const place = (v: string | null, out: THREE.Vector3) => {
    if (!v) return false;
    const [x, h, ds] = v.split(',').map(Number);
    const f = track.frameAt(at + (ds || 0));
    out.copy(f.pos).addScaledVector(f.right, x || 0);
    out.y += h || 0;
    return true;
  };
  place(q.get('cam'), lab.camera.position);
  if (place(q.get('tgt'), lab.controls.target)) lab.controls.update();
  if (!q.has('wall')) return stop;
  const zones = zonesFor(track);
  const pos: number[] = [];
  for (const side of [-1, 1] as const) {
    for (let s = 0; s < track.length; s += 4) {
      const quad: THREE.Vector3[] = [];
      for (const ss of [s, s + 4]) {
        const f = track.frameAt(ss);
        const off = zones.wallOffset(ss, side);
        const h = zones.wallHeight(ss, side);
        const right = f.tangent.clone().setY(0).normalize().cross(new THREE.Vector3(0, 1, 0)).normalize();
        const base = f.pos.clone().addScaledVector(right, side * (Number.isFinite(off) ? off : 1e4));
        quad.push(base.clone().setY(base.y - 5), base.clone().setY(base.y + (Number.isFinite(off) ? h : -5)));
      }
      const [a, b, c, d] = quad;
      if (a.distanceTo(c) > 50) continue;
      pos.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z, a.x, a.y, a.z, d.x, d.y, d.z, b.x, b.y, b.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const wall = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: track.def.theme.rockLit, roughness: 1, side: THREE.DoubleSide }));
  wall.receiveShadow = true;
  scene.add(wall);
  return () => {
    scene.remove(wall);
    geo.dispose();
    (wall.material as THREE.Material).dispose();
    stop();
  };
}
