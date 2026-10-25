// Lab: the pod models on a sand plane under a desert sun, with its own sky reflections and bloom (so the glow reads
// the way it will with the real post-processing).
//   /race/lab/pod                      turntable of all five designs (drag to orbit)
//   /race/lab/pod?view=ref             the concept-art shot: camera close behind Ember, rivals ahead, flying
//                                      (&cam=chase uses the game's chase camera instead)
//   /race/lab/pod?view=single&pod=viper&cam=back|front|side|left|top|q|chase &zoom=0.5 (closer)
// Extra: &quality=low|medium|high &throttle=0..1 &boost &steer=-1..1 (default: a slow weave) &nobloom &spin=0
// Damage (every pod in the view): &dmg=finL,canopy,binderR (broken, with the parts they carry)
//   &hurt=0.4 (health of every other part) or &hurt=intakeL:0.3,flapR:0.5 &dent=1..n (a few preset dents, n times; &dentd=0.1 their depth)
//   &detach (break the broken parts off and lay them on the sand beside the pod)
// `window.__lab` exposes { scene, camera, renderer, pods }.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { PARTS, PART_IDS, newPodDamage, podLayout, type PartId } from '../core/damage';
import { PODS, podById, type PodDesign } from '../core/pods';
import { ChaseCamera } from '../fx/camera';
import { createPod } from '../vehicle/pod';
import type { PodVisual, Quality } from '../world/types';

/** Applies the URL's damage to a pod: broken and hurt parts, dents, and (with &detach) the broken parts laid out. */
function applyDamage(v: PodVisual, design: PodDesign, p: URLSearchParams, scene: THREE.Scene, at: THREE.Vector3) {
  const dmg = newPodDamage();
  const hurt = p.get('hurt') ?? '';
  for (const id of PART_IDS) if (/^[\d.]+$/.test(hurt)) dmg.health[id] = Number(hurt);
  for (const pair of hurt.split(',')) {
    const [id, h] = pair.split(':');
    if (h !== undefined && id in PARTS) dmg.health[id as PartId] = Number(h);
  }
  const breakPart = (id: PartId) => {
    dmg.broken.add(id);
    dmg.health[id] = 0;
    for (const c of PARTS[id].carries ?? []) breakPart(c);
  };
  for (const id of (p.get('dmg') ?? '').split(',')) if (id in PARTS) breakPart(id as PartId);
  v.setPartHealth?.(dmg.health, dmg.broken);
  // Dents in pod space: the left nacelle's outboard side and top front (the mirrored engine), the right nacelle's
  // upper back, and the cockpit's right flank.
  const { L, R, xE, zE, yC, zC, ca, cb } = podLayout(design.shape);
  const dents: [number[], number[], number][] = [
    [[-xE - R, 0.1, zE + 0.1 * L], [1, 0, 0], 0.3],
    [[-xE, R, zE - 0.15 * L], [0, -1, 0], 0.25],
    [[xE + 0.7 * R, 0.7 * R, zE + 0.25 * L], [-0.7, -0.7, 0], 0.3],
    [[ca, yC + 0.3 * cb, zC], [-1, 0, 0], 0.22],
  ];
  for (let n = 0; n < Number(p.get('dent') ?? 0); n++) {
    for (const [pt, dir, depth] of dents) {
      v.dent?.(new THREE.Vector3(...pt), new THREE.Vector3(...dir).normalize(), Number(p.get('dentd') ?? depth));
    }
  }
  if (!p.has('detach')) return;
  v.object.position.copy(at);
  v.object.updateMatrixWorld(true);
  let x = 0;
  for (const id of dmg.broken) {
    const piece = v.breakOff?.(id);
    if (!piece) continue;
    piece.position.x += 9 + x;
    x += 4;
    scene.add(piece);
  }
}

function skyEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  // A gradient dome (blue zenith, pale horizon, orange sand below) plus a sun disc, prefiltered for reflections.
  const env = new THREE.Scene();
  const geo = new THREE.SphereGeometry(50, 32, 16);
  const col: number[] = [];
  const pos = geo.attributes.position;
  const top = new THREE.Color('#3d7fd6');
  const hor = new THREE.Color('#d9ecf5');
  const sand = new THREE.Color('#c27a45');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 50;
    const c = y > 0 ? hor.clone().lerp(top, Math.pow(y, 0.6)) : hor.clone().lerp(sand, Math.min(1, -y * 4));
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  env.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sun = new THREE.Mesh(new THREE.SphereGeometry(4, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(12, 10, 8) }));
  sun.position.set(30, 30, -25);
  env.add(sun);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.02).texture;
  pm.dispose();
  return tex;
}

function sandTexture(): THREE.Texture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c8814a';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    g.fillStyle = Math.random() < 0.5 ? 'rgba(120,62,30,0.08)' : 'rgba(240,180,120,0.08)';
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) g.fillRect(x + dx, y + dy, 1 + Math.random() * 3, 20 + Math.random() * 80);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(200, 200);
  t.anisotropy = 8;
  return t;
}

export function mount(el: HTMLElement): () => void {
  const p = new URLSearchParams(location.search);
  const view = p.get('view') ?? 'turntable';
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
  scene.background = new THREE.Color('#9cc9ea');
  scene.fog = new THREE.Fog('#e9c9a6', 120, 900);
  scene.environment = skyEnvironment(renderer);
  scene.environmentIntensity = 0.7;
  const camera = new THREE.PerspectiveCamera(Number(p.get('fov') ?? (view === 'ref' ? 62 : 50)), 1, 0.2, 3000);
  const sunDir = new THREE.Vector3(0.55, 0.62, -0.55).normalize();
  const sun = new THREE.DirectionalLight('#fff1dc', 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 200 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight('#a9d2ff', '#c47a45', 0.6));

  const sandTex = sandTexture();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ map: sandTex, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.5;
  ground.receiveShadow = true;
  scene.add(ground);

  // Pods and where they sit relative to the player (index 0) for each view.
  const pods: { v: PodVisual; offset: THREE.Vector3; phase: number }[] = [];
  const add = (id: string, x: number, z: number) => {
    const v = createPod(podById(id), quality);
    scene.add(v.object);
    const offset = new THREE.Vector3(x, 0, z);
    applyDamage(v, podById(id), p, scene, offset);
    pods.push({ v, offset, phase: pods.length * 1.7 });
  };
  if (view === 'ref') {
    add('ember', 0, 0);
    add('viper', -11, -16);
    add('gilded', -6, -60);
    add('tide', 3, -95);
    add('crimson', 9, -140);
    add('viper', -2, -190);
  } else if (view === 'single') {
    add(p.get('pod') ?? 'ember', 0, 0);
  } else {
    PODS.forEach((d, i) => {
      const a = (i / PODS.length) * Math.PI * 2;
      add(d.id, Math.sin(a) * 13, Math.cos(a) * 13);
    });
  }

  const composer = p.has('nobloom') ? null : new EffectComposer(renderer);
  if (composer) {
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.45, 1.0));
    composer.addPass(new OutputPass());
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  const chase = new ChaseCamera(camera);
  const flying = view === 'ref' || p.get('cam') === 'chase';
  const cam = p.get('cam') ?? (view === 'ref' ? 'ref' : 'back');
  if (view === 'turntable') {
    camera.position.set(22, 10, 26);
    controls.target.set(0, 0, 0);
  } else if (view === 'single') {
    const at: Record<string, [number, number, number]> = { back: [4, 3.5, 13], front: [-5, 2.5, -12], side: [13, 2, 0], left: [-13, 2, 0], top: [0.1, 16, 2], q: [9, 5, 9] };
    camera.position.set(...(at[cam] ?? at.back)).multiplyScalar(Number(p.get('zoom') ?? 1));
    controls.target.set(0, 0, 0);
  }
  controls.enabled = !flying;
  controls.update();

  const fit = () => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
    composer?.setSize(el.clientWidth, el.clientHeight);
  };
  fit();
  window.addEventListener('resize', fit);

  const speed = 95;
  const player = new THREE.Vector3();
  const fwd = new THREE.Vector3(0, 0, -1);
  const up = new THREE.Vector3(0, 1, 0);
  const spin = Number(p.get('spin') ?? 0.15);
  const fixedSteer = p.get('steer');
  let raf = 0;
  let last = performance.now();
  let time = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;
    if (flying) player.z -= speed * dt;
    const throttle = Number(p.get('throttle') ?? 1);
    const boosting = p.has('boost');
    pods.forEach((pod, i) => {
      const steer = fixedSteer !== null ? Number(fixedSteer) : Math.sin(time * 0.7 + pod.phase) * 0.8;
      const o = pod.v.object;
      o.position.copy(player).add(pod.offset);
      o.position.y = Math.sin(time * 2.3 + pod.phase) * 0.12;
      o.rotation.set(0, 0, 0);
      if (view === 'turntable') o.rotation.y = time * spin + (i / pods.length) * Math.PI * 2;
      if (flying) {
        o.position.x += Math.sin(time * 0.7 + pod.phase) * 1.5;
        o.rotation.set(0.02, -steer * 0.06, -steer * 0.25);
      }
      pod.v.update({ dt, time, speed01: flying ? 0.95 : 0.5, throttle, steer, boosting, surge: 0 });
    });
    if (flying && cam === 'chase') chase.update(dt, { pos: pods[0].v.object.position, forward: fwd, up, speed01: 0.95, boosting, surge: 0, impact: 0 }, time);
    else if (flying) {
      // Framing of the concept art: close behind and above, looking down the track.
      camera.position.copy(player).add(new THREE.Vector3(0, 3.3, 9.5));
      camera.lookAt(player.x, 0.2, player.z - 12);
    }
    else controls.update();
    // Keep the ground and the sun's shadow box around the player.
    ground.position.x = Math.round(player.x / 20) * 20;
    ground.position.z = Math.round(player.z / 20) * 20;
    sun.target.position.copy(player);
    sun.position.copy(player).addScaledVector(sunDir, 100);
    if (composer) composer.render();
    else renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as { __lab: unknown }).__lab = { scene, camera, renderer, pods };
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    for (const pod of pods) {
      scene.remove(pod.v.object);
      pod.v.dispose();
    }
    controls.dispose();
    composer?.dispose();
    sandTex.dispose();
    scene.environment?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
