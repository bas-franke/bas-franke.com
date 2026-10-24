// Lab: the skyline and the great arch with sky and track only, from a free camera.
//   /race/lab/landmarks?track=archway&at=0.3&yaw=0&h=6&back=14&pitch=0.05&fov=70&only=sky,landmarks,track
//   /race/lab/landmarks?track=archway&arch=-120   (120 m before the great arch)
// `at` = fraction of the lap to stand at, `yaw` turns the view (radians, 0 = down the track), `h` camera height,
// `back` metres behind that point, `pitch` radians up. `top` gives a map view of the whole layout from above.

import * as THREE from 'three';
import { Track } from '../core/track';
import { trackById } from '../core/tracks';
import { buildWorld } from '../world';
import type { FxView, Quality, WorldContext } from '../world/types';
import { zonesFor } from '../world/zones';

export function mount(el: HTMLElement): () => void {
  const p = new URLSearchParams(location.search);
  const def = trackById(p.get('track') ?? 'archway');
  const track = new Track(def);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.domElement.className = 'racer-canvas';
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(Number(p.get('fov') ?? 70), 1, 0.3, 9000);
  const ctx: WorldContext = { track, theme: def.theme, renderer, scene, camera, quality: (p.get('quality') as Quality) ?? 'high' };
  const world = buildWorld(ctx, (p.get('only') ?? 'sky,landmarks,track').split(','));
  // `arch=<metres>` stands that far along the track from the great arch instead (negative = before it).
  const arch = zonesFor(track).arch;
  const at = p.has('arch') && arch ? arch.s + Number(p.get('arch')) : Number(p.get('at') ?? 0.3) * track.length;
  const f = track.frameAt(at);
  if (p.has('top')) {
    const c = track.bounds.getCenter(new THREE.Vector3());
    camera.position.set(c.x, Number(p.get('top') || 5500), c.z + 1);
    camera.lookAt(c);
  } else {
    const yaw = Number(p.get('yaw') ?? 0);
    const dir = f.tangent.clone().setY(0).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
    camera.position.copy(f.pos).addScaledVector(dir, -Number(p.get('back') ?? 14));
    camera.position.y += Number(p.get('h') ?? 6);
    const pitch = Number(p.get('pitch') ?? 0.05);
    camera.lookAt(camera.position.clone().add(dir.clone().setY(Math.tan(pitch))));
  }
  const fit = () => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
  };
  fit();
  window.addEventListener('resize', fit);
  let raf = 0;
  let time = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    time += 1 / 60;
    const view: FxView = { dt: 1 / 60, time, camera, playerPos: f.pos, playerForward: f.tangent, speed01: 0, boosting: false, playerS: at, pods: [] };
    world.update(view);
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as { __lab: unknown }).__lab = { scene, camera, renderer, track, info: () => renderer.info.render };
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    world.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
