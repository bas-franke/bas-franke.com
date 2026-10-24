// Lab: the sky city and airships with the rest of the world around them.
//   /race/lab/skyCity?track=redrock&view=track|near|aerial|ship&only=sky,skyCity&t=30&nopost
// view=track looks from the start straight towards the mesa city; near/aerial orbit the city; ship follows an airship.
// `t` fast-forwards the airship clock. Drag to orbit, wheel to zoom.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Track } from '../core/track';
import { trackById } from '../core/tracks';
import { createPostFx } from '../fx/post';
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
  const camera = new THREE.PerspectiveCamera(Number(p.get('fov') ?? 70), 1, 0.3, 6000);
  const ctx: WorldContext = { track, theme: def.theme, renderer, scene, camera, quality: (p.get('quality') as Quality) ?? 'high' };
  const world = buildWorld(ctx, p.get('only')?.split(','));
  const post = p.has('nopost') ? null : createPostFx(ctx);

  const city = zonesFor(track).city;
  const view = p.get('view') ?? 'track';
  const controls = new OrbitControls(camera, renderer.domElement);
  const at = Number(p.get('at') ?? 0.93) * track.length;
  const f = track.frameAt(at);
  const cityTop = city ? city.pos.clone().setY(city.height + 40) : f.pos.clone().add(new THREE.Vector3(0, 250, 0));
  if (view === 'near' && city) {
    camera.position.copy(city.pos).add(new THREE.Vector3(260, city.height + 90, 300));
    controls.target.copy(cityTop);
  } else if (view === 'aerial' && city) {
    camera.position.copy(city.pos).add(new THREE.Vector3(700, 450, 600));
    controls.target.copy(cityTop);
  } else {
    camera.position.copy(f.pos).add(new THREE.Vector3(0, Number(p.get('h') ?? 5), 0));
    controls.target.copy(cityTop);
  }
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
  let time = Number(p.get('t') ?? 0);
  const fleet = () => scene.getObjectByName('airshipFleet') as THREE.InstancedMesh | undefined;
  const m = new THREE.Matrix4();
  const shipPos = new THREE.Vector3();
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    const v: FxView = { dt, time, camera, playerPos: controls.target, playerForward: f.tangent, speed01: 0, boosting: false, playerS: at, pods: [] };
    world.update(v);
    const fl = fleet();
    if (view === 'ship' && fl) {
      fl.getMatrixAt(Number(p.get('ship') ?? 0), m);
      shipPos.setFromMatrixPosition(m);
      controls.target.copy(shipPos);
      camera.position.copy(shipPos).add(new THREE.Vector3(70, 15, 90));
      camera.lookAt(shipPos);
    }
    if (post) post.render(v);
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
