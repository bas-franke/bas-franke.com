// Lab: the terrain module on its own (plus sky and track if they load), orbit camera, stats overlay.
//   /race/lab/terrain?track=falls&at=0.6&h=5&quality=high&view=chase|high|top|gorge&with=sky,track,water
// Modules are imported one by one so a broken neighbour does not take the lab down. `window.__lab` exposes the scene.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Track } from '../core/track';
import { trackById } from '../core/tracks';
import type { FrameView, Quality, WorldBuilder, WorldContext, WorldPart } from '../world/types';
import { zonesFor } from '../world/zones';

const LOADERS: Record<string, () => Promise<WorldBuilder>> = {
  sky: () => import('../world/sky').then((m) => m.buildSky),
  terrain: () => import('../world/terrain').then((m) => m.buildTerrain),
  track: () => import('../world/trackSurface').then((m) => m.buildTrackSurface),
  water: () => import('../world/water').then((m) => m.buildWater),
  landmarks: () => import('../world/landmarks').then((m) => m.buildLandmarks),
};

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
  const info = document.createElement('div');
  info.style.cssText = 'position:absolute;left:8px;top:8px;font:12px monospace;color:#fff;background:#0008;padding:6px 8px;white-space:pre;pointer-events:none';
  el.appendChild(info);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(def.theme.skyHorizon);
  const camera = new THREE.PerspectiveCamera(Number(p.get('fov') ?? 70), 1, 0.3, 6000);
  const quality = (p.get('quality') as Quality) ?? 'high';
  const ctx: WorldContext = { track, theme: def.theme, renderer, scene, camera, quality };

  const zones = zonesFor(track);
  const view = p.get('view') ?? 'chase';
  let at = Number(p.get('at') ?? 0.02) * track.length;
  if (view === 'gorge' && zones.gorges[0]) at = zones.gorges[0].s0 - 60;
  const f = track.frameAt(at);
  const look = track.frameAt(at + 25).pos.clone().add(new THREE.Vector3(0, 2, 0));
  camera.position.copy(f.pos).addScaledVector(f.tangent, -14).add(new THREE.Vector3(0, Number(p.get('h') ?? 5), 0));
  if (view === 'high') {
    camera.position.copy(f.pos).addScaledVector(f.tangent, -120).addScaledVector(f.right, Number(p.get('side') ?? 0) * 60).add(new THREE.Vector3(0, 90, 0));
    look.copy(track.frameAt(at + 150).pos);
  } else if (view === 'gorgetop' && zones.gorges[0]) {
    const g = zones.gorges[0];
    const gf = track.frameAt((g.s0 + g.s1) / 2);
    camera.position.copy(gf.pos).addScaledVector(gf.tangent, -350).add(new THREE.Vector3(0, 420, 0));
    look.copy(gf.pos);
  } else if (view === 'top') {
    const c = track.bounds.getCenter(new THREE.Vector3());
    camera.position.set(c.x, 2400, c.z + 1400);
    look.copy(c);
  }
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(look);
  controls.update();

  // Fallback lights in case the sky module is not loaded.
  const fallback = new THREE.Group();
  if (!(p.get('with') ?? 'sky,track').split(',').includes('sky')) {
    const sun = new THREE.DirectionalLight(def.theme.sunColor, 2.6);
    const el2 = def.theme.sunElevation;
    sun.position.set(Math.sin(def.theme.sunAzimuth) * Math.cos(el2), Math.sin(el2), Math.cos(def.theme.sunAzimuth) * Math.cos(el2)).multiplyScalar(500);
    fallback.add(sun, new THREE.HemisphereLight(def.theme.skyTop, def.theme.sand, 1.1));
    if (!view.includes('top')) scene.fog = new THREE.Fog(def.theme.haze, 200, def.theme.hazeDistance * 2);
  }
  scene.add(fallback);

  const parts: WorldPart[] = [];
  let buildMs = 0;
  let disposed = false;
  const names = ['terrain', ...(p.get('with') ?? 'sky,track').split(',').filter((n) => n && n !== 'terrain')];
  (async () => {
    for (const name of names) {
      try {
        const build = await LOADERS[name]?.();
        if (!build || disposed) continue;
        const t0 = performance.now();
        const part = build(ctx);
        if (name === 'terrain') {
          buildMs = performance.now() - t0;
          const tris: Record<string, number> = {};
          part.object?.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            const key = m.name.split('-').slice(0, 2).join('-') || o.type;
            const n = (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3;
            tris[key] = (tris[key] ?? 0) + n * ((m as THREE.InstancedMesh).count ?? 1);
          });
          console.warn('terrain tris', JSON.stringify(tris));
        }
        if (part.object) scene.add(part.object);
        parts.push(part);
      } catch (err) {
        console.error(`lab: module ${name} failed`, err);
      }
    }
  })();

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
  let fps = 60;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    fps = fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    last = now;
    time += dt;
    const fv: FrameView = { dt, time, camera, playerPos: controls.target, playerForward: f.tangent, speed01: 0, boosting: false, playerS: at };
    for (const part of parts) part.update?.(fv);
    renderer.render(scene, camera);
    const r = renderer.info.render;
    info.textContent = `${def.id} ${quality}  terrain build ${buildMs.toFixed(0)} ms\ncalls ${r.calls}  tris ${(r.triangles / 1000).toFixed(0)}k  fps ${fps.toFixed(0)}`;
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as { __lab: unknown }).__lab = { scene, camera, controls, renderer, track };
  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    for (const part of parts) {
      if (part.object) scene.remove(part.object);
      part.dispose?.();
    }
    renderer.dispose();
    renderer.domElement.remove();
    info.remove();
  };
}
