// Lab: the debris system on a real stretch of course. Every `every` seconds it fires `count` pod-part-shaped pieces
// (engine nacelles, fins, flaps, nozzles, plates) down the track at `speed` m/s with random spin, plus a shrapnel burst.
// Smoking pieces show as grey (smoke) or orange (burning) markers sized by their smoke amount.
//   /race/lab/debris?track=redrock&at=0.3&count=3&speed=80&every=1&cam=side|chase|top|back|pod
// Extra: &warm=<s> pre-simulates that long before the first frame, &freeze stops time after it (for screenshots),
// &seed=<n> makes the randomness repeatable, &wall fires the pieces at the corridor wall, &nopost, &quality=.
// Pods through the debris: &drive fires for &shots=<s> (4) seconds, then from &podstart=<s> (8) `pods` (1) pod-sized
// boxes run through the lying field at &podspeed=<m/s> (60), every few seconds, &podh=<m> above hover height (over 2 m
// they count as airborne and should pass over). The label shows the average debris.update() time.
// Drag to orbit. `window.__lab` exposes { scene, camera, controls, renderer, track, debris }.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Track } from '../core/track';
import { trackById } from '../core/tracks';
import { createPostFx } from '../fx/post';
import { buildWorld } from '../world';
import { DebrisSystem } from '../world/debris';
import type { FxView, Quality, WorldContext } from '../world/types';

export function mount(el: HTMLElement): () => void {
  const p = new URLSearchParams(location.search);
  const realRandom = Math.random;
  if (p.has('seed')) {
    let s = Number(p.get('seed')) * 7919 + 1;
    Math.random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  }
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
  const world = buildWorld(ctx, (p.get('only') ?? 'sky,terrain,track').split(','));
  const post = p.has('nopost') ? null : createPostFx(ctx);
  const debris = new DebrisSystem(ctx);
  scene.add(debris.object);

  const count = Number(p.get('count') ?? 3);
  const speed = Number(p.get('speed') ?? 80);
  const every = Number(p.get('every') ?? 1);
  const atWall = p.has('wall');
  const s0 = Number(p.get('at') ?? 0.3) * track.length;
  const f0 = track.frameAt(s0);

  // Pod-part shapes. Geometry and materials are shared between pieces (as pod parts share cached geometry), so the
  // debris system must leave them alone: no debrisOwns* flags.
  const metal = new THREE.MeshStandardMaterial({ color: '#8a8f96', metalness: 0.8, roughness: 0.35 });
  const paint = new THREE.MeshStandardMaterial({ color: '#c8461e', metalness: 0.4, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: '#2b2d31', metalness: 0.6, roughness: 0.5 });
  const nacelleGeo = new THREE.CylinderGeometry(0.5, 0.55, 5, 18).rotateX(Math.PI / 2);
  const nozzleGeo = new THREE.CylinderGeometry(0.55, 0.42, 1.1, 16).rotateX(Math.PI / 2);
  const finGeo = new THREE.BoxGeometry(0.08, 1.2, 1.7);
  const flapGeo = new THREE.BoxGeometry(1.4, 0.06, 1.0);
  const plateGeo = new THREE.BoxGeometry(0.9, 0.05, 0.7);
  const geos = [nacelleGeo, nozzleGeo, finGeo, flapGeo, plateGeo];
  const make = (kind: number): { obj: THREE.Object3D; smoke: number; burning: boolean } => {
    const g = new THREE.Group();
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    };
    if (kind === 0) {
      // A whole engine: nacelle with its nozzle and fin (off-centre children, so the centre of mass is not the origin).
      add(nacelleGeo, paint);
      add(nozzleGeo, dark, 0, 0, 2.9);
      add(finGeo, paint, 0, 0.9, 0.6);
      return { obj: g, smoke: 1, burning: true };
    }
    if (kind === 1) add(nozzleGeo, dark);
    else if (kind === 2) add(finGeo, paint);
    else if (kind === 3) add(flapGeo, metal);
    else add(plateGeo, metal);
    return { obj: g, smoke: kind === 1 ? 0.6 : Math.random() < 0.3 ? 0.3 : 0, burning: false };
  };

  const vel = new THREE.Vector3();
  const spin = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let newest: THREE.Object3D | null = null;
  let k = 0;
  const fire = () => {
    for (let i = 0; i < count; i++) {
      const kind = (k++ % 5 === 0) ? 0 : 1 + Math.floor(Math.random() * 4);
      const { obj, smoke, burning } = make(kind);
      const x = (Math.random() - 0.5) * 8;
      track.toWorld(s0, x, 2.5 + Math.random() * 1.5, obj.position);
      obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f0.right, f0.up, tmp.copy(f0.tangent).negate()));
      obj.rotateY((Math.random() - 0.5) * 0.6);
      vel.copy(f0.tangent).multiplyScalar(speed * (0.85 + Math.random() * 0.2));
      if (atWall) vel.addScaledVector(f0.right, speed * 0.45);
      else vel.addScaledVector(f0.right, (Math.random() - 0.5) * 12);
      vel.addScaledVector(f0.up, 2 + Math.random() * 7);
      spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(kind === 0 ? 6 : 16);
      debris.spawn(obj, vel, spin, { smoke, burning });
      newest = obj;
    }
    track.toWorld(s0, 0, 2, tmp);
    debris.shrapnel(tmp, vel.copy(f0.tangent).addScaledVector(f0.up, 0.3).normalize(), 40, speed * 0.6);
  };

  // Smoke markers: one small sphere per possible source.
  const markerGeo = new THREE.SphereGeometry(1, 10, 8);
  const smokeMat = new THREE.MeshBasicMaterial({ color: '#555555', transparent: true, opacity: 0.6, depthWrite: false });
  const fireMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.2, 0.3), transparent: true, opacity: 0.8, depthWrite: false });
  const markers: THREE.Mesh[] = [];
  for (let i = 0; i < 60; i++) {
    const m = new THREE.Mesh(markerGeo, smokeMat);
    m.visible = false;
    scene.add(m);
    markers.push(m);
  }

  const cam = p.get('cam') ?? 'side';
  const target = new THREE.Vector3();
  if (cam === 'top') {
    track.toWorld(s0 + 90, 0, 0, target);
    camera.position.copy(target).addScaledVector(f0.right, 30).add(new THREE.Vector3(0, 120, 0));
  } else if (cam === 'back') {
    track.toWorld(s0 + 70, 0, 0, target);
    track.toWorld(s0 - 25, 0, 9, camera.position);
  } else {
    track.toWorld(s0 + 80, 0, 0, target);
    const fs = track.frameAt(s0 + 55);
    camera.position.copy(fs.pos).addScaledVector(fs.right, -fs.width * 0.42).add(new THREE.Vector3(0, 9, 0));
  }
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.update();

  const label = document.createElement('div');
  label.style.cssText = 'position:absolute;left:12px;top:12px;color:#fff;font:12px monospace;text-shadow:0 1px 2px #000;pointer-events:none';
  el.appendChild(label);

  const fit = () => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
    post?.setSize(el.clientWidth, el.clientHeight, renderer.getPixelRatio());
  };
  fit();
  window.addEventListener('resize', fit);

  // Pod-sized boxes (6.8 x 2.4 x 10 m, the debris system's footprint) driving down the course through the debris.
  const drive = p.has('drive');
  const shots = Number(p.get('shots') ?? 4);
  const podStart = Number(p.get('podstart') ?? 8);
  const podSpeed = Number(p.get('podspeed') ?? 60);
  const podH = Number(p.get('podh') ?? 0);
  const podN = drive ? Number(p.get('pods') ?? 1) : 0;
  const podRun = 300 / podSpeed + 1.5;
  const podGeo = new THREE.BoxGeometry(6.8, 2.4, 10);
  const podMat = new THREE.MeshStandardMaterial({ color: '#3a7bd5', transparent: true, opacity: 0.55, roughness: 0.5 });
  const podObjs: THREE.Mesh[] = [];
  for (let i = 0; i < podN; i++) {
    const m = new THREE.Mesh(podGeo, podMat);
    m.castShadow = true;
    m.visible = false;
    scene.add(m);
    podObjs.push(m);
  }
  const podVel = new THREE.Vector3();
  const podSide = new THREE.Vector3();
  const podBasis = new THREE.Matrix4();
  const movePods = () => {
    const u = time - podStart;
    let n = 0;
    if (u >= 0) {
      const t = u % podRun;
      for (let i = 0; i < podN; i++) {
        // Spread across the field, a little staggered, so each lane meets different pieces.
        const s = s0 - 20 + (t - i * 0.15) * podSpeed;
        const x = podN === 1 ? -2 : -9 + (18 * i) / (podN - 1);
        const f = track.frameAt(s);
        const m = podObjs[i];
        m.visible = true;
        track.toWorld(s, x, 1.5 + podH, m.position);
        m.quaternion.setFromRotationMatrix(podBasis.makeBasis(f.right, f.up, tmp.copy(f.tangent).negate()));
        podVel.copy(f.tangent).multiplyScalar(podSpeed);
        debris.setPod(i, m.position, podVel, m.quaternion, podH > 2);
        n++;
      }
    }
    debris.setPodCount(n);
  };

  let time = 0;
  let nextFire = 0;
  let updMs = 0;
  let smokeCount = 0;
  const view: FxView = { dt: 0, time: 0, camera, playerPos: target, playerForward: f0.tangent, speed01: 0, boosting: false, playerS: s0, pods: [] };
  const step = (dt: number) => {
    time += dt;
    if (time >= nextFire && (!drive || time < shots)) {
      fire();
      nextFire += every;
    }
    view.dt = dt;
    view.time = time;
    movePods();
    const t0 = performance.now();
    const sources = debris.update(view);
    updMs += (performance.now() - t0 - updMs) * 0.05;
    smokeCount = sources.length;
    view.smokeSources = sources;
    for (let i = 0; i < markers.length; i++) {
      const s = sources[i];
      markers[i].visible = !!s;
      if (!s) continue;
      markers[i].position.copy(s.pos);
      markers[i].scale.setScalar(0.2 + s.amount * 0.6);
      markers[i].material = s.burning ? fireMat : smokeMat;
    }
  };
  const warm = Number(p.get('warm') ?? 0);
  for (let t = 0; t < warm; t += 1 / 60) step(1 / 60);
  const freeze = p.has('freeze');

  let chaseS = s0;
  let first = true;
  let raf = 0;
  let last = performance.now();
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!freeze) step(dt);
    if (cam === 'pod' && podObjs[0]?.visible) {
      // Behind and beside the first pod box, looking past it at what it ploughs into.
      const m = podObjs[0];
      tmp.set(0, 0, -1).applyQuaternion(m.quaternion);
      controls.target.copy(m.position).addScaledVector(tmp, 14);
      camera.position.copy(m.position).addScaledVector(tmp, -16).add(podSide.set(1, 0, 0).applyQuaternion(m.quaternion).multiplyScalar(7));
      camera.position.y += 6;
      controls.update();
    }
    if (cam === 'chase' && newest) {
      // Behind the newest piece along the course where it is now (not where it was fired), so bends do not put the
      // camera inside a wall.
      const o = newest as THREE.Object3D;
      const at = track.toTrack(o.position, chaseS);
      chaseS = at.s;
      const k = first ? 1 : 1 - Math.exp(-dt * 3);
      controls.target.lerp(o.position, k);
      track.toWorld(at.s - 16, at.x * 0.6, 6, tmp);
      camera.position.lerp(tmp, first ? 1 : 1 - Math.exp(-dt * 2));
      controls.update();
      first = false;
    }
    label.textContent = `t ${time.toFixed(1)} s · smoke sources ${smokeCount} · count ${count} · speed ${speed} · update ${updMs.toFixed(2)} ms`;
    world.update(view);
    if (post) post.render(view);
    else renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as { __lab: unknown }).__lab = { scene, camera, controls, renderer, track, debris };
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    Math.random = realRandom;
    debris.dispose();
    for (const g of geos) g.dispose();
    podGeo.dispose();
    podMat.dispose();
    for (const m of [metal, paint, dark, smokeMat, fireMat]) m.dispose();
    markerGeo.dispose();
    label.remove();
    world.dispose();
    post?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
