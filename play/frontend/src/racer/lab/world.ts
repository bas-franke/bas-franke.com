// Lab: the whole world for one track with an orbit camera, no race.
//   /race/lab/world?track=falls&only=sky,terrain&at=0.3&h=5&nopost
// Drag to orbit, wheel to zoom. `window.__lab` exposes { scene, camera, controls, renderer, track }.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Track } from '../core/track';
import { trackById } from '../core/tracks';
import { createPostFx } from '../fx/post';
import { buildWorld } from '../world';
import type { FxView, Quality, WorldContext } from '../world/types';

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
  const camera = new THREE.PerspectiveCamera(Number(p.get('fov') ?? 70), 1, 0.3, 6000);
  const ctx: WorldContext = { track, theme: def.theme, renderer, scene, camera, quality: (p.get('quality') as Quality) ?? 'high' };
  const only = p.get('only')?.split(',');
  const world = buildWorld(ctx, only);
  const post = p.has('nopost') ? null : createPostFx(ctx);
  // Start where the chase camera would be at ?at=<fraction of the lap>, looking down the track.
  const at = Number(p.get('at') ?? 0.02) * track.length;
  const f = track.frameAt(at);
  const look = track.frameAt(at + 25).pos.clone().add(new THREE.Vector3(0, 2, 0));
  camera.position.copy(f.pos).addScaledVector(f.tangent, -14).add(new THREE.Vector3(0, Number(p.get('h') ?? 5), 0));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(look);
  controls.update();
  const fit = () => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
    post?.setSize(el.clientWidth, el.clientHeight, renderer.getPixelRatio());
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
    const view: FxView = { dt, time, camera, playerPos: controls.target, playerForward: f.tangent, speed01: 0, boosting: false, playerS: at, pods: [] };
    world.update(view);
    if (post) post.render(view);
    else renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as { __lab: unknown }).__lab = { scene, camera, controls, renderer, track };
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    world.dispose();
    post?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
