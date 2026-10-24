// Lab: the gorge, its river and waterfalls. Wraps the world lab and points its orbit camera at the first gorge.
//   /race/lab/water?track=falls&view=bridge|side|river|fall|over&fall=0&only=sky,terrain,track,water
// view=bridge: chase-camera height on the bridge looking along the track; river: low over the water looking upstream;
// fall: in front of waterfall `fall`; over: high above the gorge;
// side: on the bridge looking out to the falls on `side` (-1 left, 1 right). Without `only` it shows sky, terrain, landmarks, track and water.

import * as THREE from 'three';
import { Track } from '../core/track';
import { trackById } from '../core/tracks';
import { zonesFor } from '../world/zones';
import { mount as mountWorld } from './world';

export function mount(el: HTMLElement): () => void {
  const p = new URLSearchParams(location.search);
  const track = new Track(trackById(p.get('track') ?? 'falls'));
  const zones = zonesFor(track);
  const g = zones.gorges[0];
  const mid = g ? (g.s0 + g.s1) / 2 : 0;
  if (!p.has('at')) p.set('at', String((mid - 60) / track.length));
  if (!p.has('h')) p.set('h', '6');
  if (!p.has('only')) p.set('only', 'sky,terrain,landmarks,track,water');
  history.replaceState(null, '', `${location.pathname}?${p}`);
  const unmount = mountWorld(el);
  const lab = (window as unknown as { __lab: { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update(): void }; track: Track } }).__lab;
  (window as unknown as { __zones: unknown }).__zones = zones;
  const view = p.get('view') ?? 'bridge';
  if (g && view !== 'bridge') {
    const fc = track.frameAt(mid);
    const ax = fc.right.clone().setY(0).normalize();
    const riverY = fc.pos.y - g.depth;
    if (view === 'side') {
      const sd = Number(p.get('side') ?? 1);
      lab.camera.position.copy(fc.pos).addScaledVector(ax, sd * 6).setY(fc.pos.y + 9);
      lab.controls.target.copy(fc.pos).addScaledVector(ax, sd * 200).setY(fc.pos.y - 30);
    } else if (view === 'over') {
      lab.camera.position.copy(fc.pos).addScaledVector(fc.tangent, -320).setY(fc.pos.y + 260);
      lab.controls.target.copy(fc.pos).setY(riverY);
    } else if (view === 'river') {
      lab.camera.position.copy(fc.pos).addScaledVector(ax, 40).setY(riverY + 14);
      lab.controls.target.copy(fc.pos).addScaledVector(ax, -300).setY(riverY + 40);
    } else {
      const f = zones.waterfalls[Number(p.get('fall') ?? 0)] ?? zones.waterfalls[0];
      const mid3 = f.top.clone().setY(f.top.y - f.drop / 2);
      lab.camera.position.copy(mid3).addScaledVector(f.facing, f.drop * 1.6).setY(riverY + 30);
      lab.controls.target.copy(mid3);
    }
    lab.controls.update();
  }
  return unmount;
}
