// Lab: the sky module alone over a test yard (sand plane, rock blocks at several distances, metal and matte balls)
// to judge the sky, clouds, fog, sun shadows and reflections per theme.
//   /race/lab/sky?track=sunspire&yaw=0.4&pitch=0.05&nopost
// `yaw` turns the camera (radians, 0 = looking along -z), `pitch` tilts it. Drag to orbit.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Track, rng } from '../core/track';
import { trackById } from '../core/tracks';
import { createPostFx } from '../fx/post';
import { buildSky } from '../world/sky';
import { makeCloudAtlas } from '../world/skyClouds';
import type { FxView, Quality, WorldContext } from '../world/types';

export function mount(el: HTMLElement): () => void {
  const p = new URLSearchParams(location.search);
  if (p.has('atlas')) return showAtlas(el, p.get('atlas') ?? 'a');
  const def = trackById(p.get('track') ?? 'redrock');
  const theme = def.theme;
  const track = new Track(def);
  const quality = (p.get('quality') as Quality) ?? 'high';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = quality !== 'low';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'racer-canvas';
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(Number(p.get('fov') ?? 70), 1, 0.3, 6000);
  const ctx: WorldContext = { track, theme, renderer, scene, camera, quality };
  const sky = buildSky(ctx);
  if (sky.object) scene.add(sky.object);

  // Test yard.
  const yard = new THREE.Group();
  const sandMat = new THREE.MeshStandardMaterial({ color: theme.dirt, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000), sandMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  yard.add(ground);
  const rockMat = new THREE.MeshStandardMaterial({ color: theme.rockLit, roughness: 0.95 });
  const box = new THREE.BoxGeometry(1, 1, 1);
  const r = rng(5);
  for (let i = 0; i < 70; i++) {
    const d = 90 + Math.pow(r(), 1.4) * 2600;
    const a = r() * Math.PI * 2;
    const w = 10 + d * 0.05 * r() + r() * 20;
    const h = 15 + r() * (25 + d * 0.08);
    const m = new THREE.Mesh(box, rockMat);
    m.scale.set(w, h, w * (0.6 + r()));
    m.position.set(Math.sin(a) * d, h / 2, -Math.cos(a) * d);
    m.rotation.y = r() * 3;
    m.castShadow = m.receiveShadow = true;
    yard.add(m);
  }
  const ball = new THREE.SphereGeometry(2, 48, 24);
  const mats = [
    new THREE.MeshStandardMaterial({ color: '#d8d8d8', metalness: 1, roughness: 0.2 }),
    new THREE.MeshStandardMaterial({ color: '#f0e6d8', metalness: 0, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: '#e07a2e', metalness: 0.3, roughness: 0.45 }),
  ];
  mats.forEach((mat, i) => {
    const m = new THREE.Mesh(ball, mat);
    m.position.set((i - 1) * 6, 3, -12);
    m.castShadow = m.receiveShadow = true;
    yard.add(m);
  });
  scene.add(yard);

  const post = p.has('nopost') ? null : createPostFx(ctx);
  const yaw = Number(p.get('yaw') ?? 0);
  const pitch = Number(p.get('pitch') ?? 0.08);
  camera.position.set(0, Number(p.get('h') ?? 5), 0);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(Math.sin(yaw) * 20, camera.position.y + Math.tan(pitch) * 20, -Math.cos(yaw) * 20);
  controls.update();
  const fit = () => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
    post?.setSize(el.clientWidth, el.clientHeight, renderer.getPixelRatio());
  };
  fit();
  window.addEventListener('resize', fit);
  const forward = new THREE.Vector3(0, 0, -1);
  let raf = 0;
  let last = performance.now();
  let time = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    const view: FxView = { dt, time, camera, playerPos: controls.target, playerForward: forward, speed01: 0, boosting: false, playerS: 0, pods: [] };
    sky.update?.(view);
    if (post) post.render(view);
    else renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as { __lab: unknown }).__lab = { scene, camera, controls, renderer };
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    sky.dispose?.();
    post?.dispose();
    box.dispose();
    ball.dispose();
    ground.geometry.dispose();
    sandMat.dispose();
    rockMat.dispose();
    mats.forEach((m) => m.dispose());
    renderer.dispose();
    renderer.domElement.remove();
  };
}

/** ?atlas=a|n|b: the cloud atlas's coverage, normals or thickness on a 2D canvas. */
function showAtlas(el: HTMLElement, mode: string): () => void {
  const tex = makeCloudAtlas(384);
  const { data, width, height } = tex.image as { data: Uint8Array; width: number; height: number };
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#4a7fd0';
  const g = c.getContext('2d')!;
  const img = g.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const a = data[o + 3];
    if (mode === 'n') img.data.set([data[o], data[o + 1], 255, a], o);
    else if (mode === 'b') img.data.set([data[o + 2], data[o + 2], data[o + 2], a], o);
    else {
      // Quick preview lit from the upper right.
      const nx = data[o] / 127.5 - 1;
      const ny = data[o + 1] / 127.5 - 1;
      const l = Math.max(0, nx * 0.5 + ny * 0.7 + Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 0.5);
      img.data.set([120 + l * 135, 130 + l * 120, 160 + l * 90, a], o);
    }
  }
  g.putImageData(img, 0, 0);
  el.appendChild(c);
  return () => {
    c.remove();
    tex.dispose();
  };
}
