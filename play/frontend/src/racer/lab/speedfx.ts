// Lab: speed effects without the race sim. Eight pods fly scripted lines down a track (player behind the pack) with the
// chase camera, and the lab fires boost, boost-pad and wall-hit events on a timer so every effect shows up quickly.
//   /race/lab/speedfx?track=redrock&at=0.3&speed=1&only=sky,terrain,trackSurface&nopost&quality=low&freeze&calm (no events)&hide=dust,motes
// `window.__lab` exposes { scene, camera, renderer, fx }.

import * as THREE from 'three';
import { PODS } from '../core/pods';
import { Track } from '../core/track';
import { trackById } from '../core/tracks';
import { createPostFx } from '../fx/post';
import { createSpeedFx } from '../fx/speed';
import { createPod } from '../vehicle/pod';
import { buildWorld } from '../world';
import type { FxPod, FxView, Quality, WorldContext } from '../world/types';

export function mount(el: HTMLElement): () => void {
  const p = new URLSearchParams(location.search);
  const def = trackById(p.get('track') ?? 'redrock');
  const track = new Track(def);
  const quality = (p.get('quality') as Quality) ?? 'high';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'racer-canvas';
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, 1, 0.3, 6000);
  const ctx: WorldContext = { track, theme: def.theme, renderer, scene, camera, quality };
  const world = buildWorld(ctx, p.get('only')?.split(','));
  // Without the sky module (?only=...) still give the scene a sky colour, haze and light.
  if (!scene.background) scene.background = new THREE.Color(def.theme.skyHorizon);
  if (!scene.fog) scene.fog = new THREE.Fog(def.theme.haze, 200, def.theme.hazeDistance * 2);
  if (!scene.children.some((o) => (o as THREE.Light).isLight)) {
    const sun = new THREE.DirectionalLight(def.theme.sunColor, 3);
    sun.position.set(Math.sin(def.theme.sunAzimuth), Math.tan(def.theme.sunElevation), Math.cos(def.theme.sunAzimuth));
    scene.add(sun, new THREE.HemisphereLight(def.theme.skyTop, def.theme.dirt, 1.2));
  }
  const post = p.has('nopost') ? null : createPostFx(ctx);
  const fx = createSpeedFx(ctx);
  scene.add(fx.object);
  // ?hide=dust,trails,motes,lines,sparks,rings,cones
  for (const name of p.get('hide')?.split(',') ?? []) {
    const o = fx.object.getObjectByName(name);
    if (o) o.visible = false;
  }
  const freeze = p.has('freeze');
  const speedMul = Number(p.get('speed') ?? 1);

  // Pack layout: [metres ahead of the player, lateral fraction of half-width, speed factor]
  const allLines: [number, number, number][] = [
    [0, 0.05, 1],
    [22, -0.55, 0.97],
    [45, 0.45, 0.98],
    [70, -0.1, 0.99],
    [110, 0.6, 0.97],
    [150, -0.5, 1],
    [210, 0.2, 0.98],
    [280, -0.3, 0.99],
  ];
  const lines = allLines.slice(0, Number(p.get('pods') ?? allLines.length));
  const top = 130 * speedMul;
  const pods: FxPod[] = lines.map((_, i) => {
    const design = PODS[i % PODS.length];
    const visual = createPod(design, quality);
    scene.add(visual.object);
    return {
      visual,
      livery: design.livery,
      isPlayer: i === 0,
      speed01: speedMul,
      speed: top,
      boosting: false,
      surge: 0,
      velocity: new THREE.Vector3(),
      ground: new THREE.Vector3(),
      groundNormal: new THREE.Vector3(0, 1, 0),
      impact: 0,
      impactSide: 0,
      padHit: false,
    };
  });
  const s0 = Number(p.get('at') ?? 0.3) * track.length;
  const prev = pods.map(() => new THREE.Vector3());
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const m = new THREE.Matrix4();

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
  let simT = 2;
  let playerS = s0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    if (!freeze) simT += dt;
    // Event script, a 6 s cycle: player boost 1-2.5 s, pad hit at 3 s, wall scrape 4-4.4 s (rival 2 hits at 5 s).
    const c = p.has('calm') ? 0 : simT % 6;
    pods.forEach((fp, i) => {
      const [ahead, lat, sf] = lines[i];
      const s = s0 + ahead + simT * top * sf + Math.sin(simT * 0.3 + i) * 6;
      const f = track.frameAt(s);
      if (i === 0) playerS = s;
      const x = (lat + Math.sin(simT * 0.5 + i * 2) * 0.12) * f.width * 0.5;
      const f2 = track.frameAt(s + 3);
      fwd.copy(f2.pos).sub(f.pos).normalize();
      right.copy(fwd).cross(f.up).normalize();
      up.copy(right).cross(fwd).normalize();
      const pos = fp.visual.object.position;
      pos.copy(f.pos).addScaledVector(f.right, x).addScaledVector(f.up, 1.5 + Math.sin(time * 2.3 + i) * 0.1);
      m.makeBasis(right, up, fwd.clone().negate());
      fp.visual.object.quaternion.setFromRotationMatrix(m);
      if (dt > 0) fp.velocity.copy(pos).sub(prev[i]).divideScalar(dt);
      if (fp.velocity.length() > 400) fp.velocity.set(0, 0, 0);
      prev[i].copy(pos);
      fp.ground.copy(f.pos).addScaledVector(f.right, x);
      fp.groundNormal.copy(f.up);
      fp.boosting = i === 0 ? c > 1 && c < 2.5 : i === 3 && c > 2 && c < 4;
      fp.surge = i === 0 && c > 3 && c < 3.8 ? 0.8 : 0;
      fp.padHit = i === 0 && c > 3 && c < 3.05;
      const hit = (i === 0 && c > 4 && c < 4.4) || (i === 2 && c > 5 && c < 5.1);
      fp.impact = hit ? 0.6 : 0;
      fp.impactSide = i === 0 ? 1 : -1;
      fp.visual.update({ dt, time, speed01: fp.speed01, throttle: 1, steer: 0, boosting: fp.boosting, surge: fp.surge });
    });
    const pl = pods[0];
    const pf = new THREE.Vector3(0, 0, -1).applyQuaternion(pl.visual.object.quaternion);
    const pu = new THREE.Vector3(0, 1, 0).applyQuaternion(pl.visual.object.quaternion);
    // Own simple chase camera (the real one belongs to another module and may be mid-change).
    camera.position.copy(pl.visual.object.position).addScaledVector(pf, -13.5).addScaledVector(pu, 4);
    camera.up.copy(pu);
    camera.lookAt(fwd.copy(pl.visual.object.position).addScaledVector(pf, 14).addScaledVector(pu, 1.2));
    camera.fov = 80 + (pl.boosting ? 8 : 0);
    camera.updateProjectionMatrix();
    const view: FxView = {
      dt,
      time,
      camera,
      playerPos: pl.visual.object.position,
      playerForward: pf,
      speed01: pl.speed01,
      boosting: pl.boosting,
      playerS: track.wrap(playerS),
      pods,
    };
    world.update(view);
    fx.update(view);
    if (post) post.render(view);
    else renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as { __lab: unknown }).__lab = { scene, camera, renderer, fx };
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    world.dispose();
    fx.dispose();
    post?.dispose();
    for (const fp of pods) fp.visual.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
