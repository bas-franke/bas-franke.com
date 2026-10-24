// Lab: the post chain on the real world, with a faked speed so the blur shows without racing.
//   /race/lab/post?track=sunspire&at=0.3&h=5&speed=1&boost&glow&quality=high&split&bench&lookSun=0.3
// speed=<speed01> and boost drive the blur/aberration; glow adds HDR emissive test spheres on the road (bloom);
// lookSun[=yaw offset] turns the camera towards the sun; any composite uniform can be set (&bloomStrength=0.5);
// split draws the left half without post; bench logs (and shows) the GPU-synced cost of the post chain in ms.

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
  const quality = (p.get('quality') as Quality) ?? 'high';
  const renderer = new THREE.WebGLRenderer({ antialias: quality !== 'low', powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Number(p.get('pr') ?? Math.min(devicePixelRatio, 1.5)));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = quality !== 'low';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'racer-canvas';
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(Number(p.get('fov') ?? 72), 1, 0.3, 6000);
  const ctx: WorldContext = { track, theme: def.theme, renderer, scene, camera, quality };
  const world = buildWorld(ctx, p.get('only')?.split(','));
  const post = createPostFx(ctx);
  post.params.speedOverride = Number(p.get('speed') ?? 1);
  post.params.boostOverride = p.has('boost') ? 1 : 0;
  // Any composite uniform can be overridden from the URL, e.g. &bloomStrength=0&veilStrength=0.
  for (const [k, v] of p) if (k in post.uniforms && typeof post.uniforms[k].value === 'number') post.uniforms[k].value = Number(v);

  const at = Number(p.get('at') ?? 0.02) * track.length;
  const f = track.frameAt(at);
  const look = track.frameAt(at + 25).pos.clone().add(new THREE.Vector3(0, 2, 0));
  camera.position.copy(f.pos).addScaledVector(f.tangent, -14).add(new THREE.Vector3(0, Number(p.get('h') ?? 4), 0));
  if (p.has('lookSun')) {
    // Aim a bit to the side of / below the sun so it sits in the upper part of the frame.
    const t = def.theme;
    const az = t.sunAzimuth + Number(p.get('lookSun') || 0.35);
    look.copy(camera.position).add(new THREE.Vector3(Math.sin(az), Math.tan(t.sunElevation) * 0.4, Math.cos(az)).multiplyScalar(60));
  }
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(look);
  controls.update();

  const extras: THREE.Object3D[] = [];
  if (p.has('glow')) {
    const geo = new THREE.SphereGeometry(0.9, 16, 12);
    const colors = ['#4fb8ff', '#ff6a1a', '#b46bff', '#38fff0'];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(colors[i % 4]).multiplyScalar(6) }));
      m.position.copy(track.toWorld(at + 20 + i * 18, (i % 2 ? 1 : -1) * 6, 2));
      scene.add(m);
      extras.push(m);
    }
  }

  const label = document.createElement('div');
  label.style.cssText = 'position:absolute;left:12px;bottom:12px;color:#fff;font:600 14px system-ui;text-shadow:0 1px 3px #000;pointer-events:none';
  el.appendChild(label);

  const fit = () => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
    post.setSize(el.clientWidth, el.clientHeight, renderer.getPixelRatio());
  };
  fit();
  window.addEventListener('resize', fit);

  const split = p.has('split');
  const bench = p.has('bench');
  let raf = 0;
  let last = performance.now();
  let time = 0;
  let frames = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    frames++;
    const forward = look.clone().sub(camera.position).normalize();
    const view: FxView = { dt, time, camera, playerPos: controls.target, playerForward: forward, speed01: 0, boosting: false, playerS: at, pods: [] };
    world.update(view);
    post.render(view);
    if (split) {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setScissorTest(true);
      renderer.setScissor(0, 0, w / 2, h);
      renderer.setViewport(0, 0, w, h);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      renderer.setScissorTest(false);
    }
    if (bench && frames === 90) {
      post.bench(20);
      const ms = Math.min(post.bench(100), post.bench(100));
      const gl = renderer.getContext();
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '?';
      const msg = `post chain ${ms.toFixed(2)} ms @ ${renderer.domElement.width}x${renderer.domElement.height} (${quality}) on ${gpu}`;
      label.textContent = msg;
      console.warn(msg);
    }
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as { __lab: unknown }).__lab = { scene, camera, controls, renderer, track, post };
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    world.dispose();
    post.dispose();
    for (const e of extras) {
      const m = e as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    renderer.dispose();
    renderer.domElement.remove();
    label.remove();
  };
}
