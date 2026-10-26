// Lab: the track surface (with sky lighting) and an orbit camera aimed at one of its features.
//   /race/lab/track?track=falls&focus=bridge|gantry|pad&pad=0&ride&at=0.3&quality=high&dist=40&h=12&only=sky,track
// `focus` overrides `at`: bridge = the first gorge bridge seen from the side, gantry = the start line, pad = boost pad.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { padPosition } from '../core/physics';
import { Track } from '../core/track';
import { trackById } from '../core/tracks';
import { buildWorld } from '../world';
import type { FxView, Quality, WorldContext } from '../world/types';
import { zonesFor } from '../world/zones';

export function mount(el: HTMLElement): () => void {
  const p = new URLSearchParams(location.search);
  const def = trackById(p.get('track') ?? 'redrock');
  const track = new Track(def);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'racer-canvas';
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(Number(p.get('fov') ?? 60), 1, 0.3, 6000);
  const ctx: WorldContext = { track, theme: def.theme, renderer, scene, camera, quality: (p.get('quality') as Quality) ?? 'high' };
  const world = buildWorld(ctx, (p.get('only') ?? 'sky,track').split(','));

  const focus = p.get('focus');
  let s = Number(p.get('at') ?? 0.05) * track.length;
  let side = 0;
  let dist = Number(p.get('dist') ?? 30);
  let h = Number(p.get('h') ?? 6);
  if (focus === 'bridge') {
    const g = zonesFor(track).gorges[0];
    if (g) {
      // &ride: on the road just before the bridge, looking along it.
      s = p.has('ride') ? g.s0 - 10 : (g.s0 + g.s1) / 2;
      side = p.has('ride') ? 0 : 1;
      dist = Number(p.get('dist') ?? 170);
      h = Number(p.get('h') ?? -30);
    }
  } else if (focus === 'gantry') {
    s = 0;
  } else if (focus === 'pad') {
    const pad = def.boostPads[Number(p.get('pad') ?? 0)] ?? def.boostPads[0];
    s = padPosition(track, pad).s;
  }
  const f = track.frameAt(s);
  const target = f.pos.clone().add(new THREE.Vector3(0, side ? -20 : 2, 0));
  if (side) camera.position.copy(f.pos).addScaledVector(f.right, dist).addScaledVector(f.tangent, -dist * 0.5).add(new THREE.Vector3(0, h, 0));
  else camera.position.copy(f.pos).addScaledVector(f.tangent, -dist).add(new THREE.Vector3(0, h, 0));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.update();

  const fit = () => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
  };
  fit();
  window.addEventListener('resize', fit);
  let raf = 0;
  let last = performance.now();
  let time = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    const view: FxView = { dt, time, camera, playerPos: controls.target, playerForward: f.tangent, speed01: 0, boosting: false, playerS: s, pods: [] };
    world.update(view);
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as { __lab: unknown }).__lab = { scene, camera, controls, renderer, track };
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    world.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
