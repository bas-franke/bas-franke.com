// Dev lab for fx.ts: /lab-zombies-fx.html. A plain three.js view of the Cold Storage walls (flat-coloured chunks,
// a ceiling lamp and a flashlight) with a stub pipeline, so the effects can be tuned without the rest of the game.
// Click: bullet impact · B: break chunks · X: grenade · G: gib · H: blood · R: rise · T / Y: board tear / fix ·
// M / N / K: shotgun / sniper / rifle-burst muzzle and casings · C: clear. `?demo` plays a scripted sequence; window.__lab exposes everything.

import * as THREE from 'three';
import { MAPS } from '@shared/zombies/maps';
import type { ImpactMat } from '@shared/zombies/protocol';
import { buildWorld, collapse, damageChunk, raycast } from '@shared/zombies/world';
import type { Pipeline } from './api';
import { createFx, type EffectsImpl } from './fx';

const world = buildWorld(MAPS[0]);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.FogExp2(0x05070a, 0.04);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 120);
camera.position.set(-6, 1.6, -9.5);
camera.lookAt(-6, 1.3, -15);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

scene.add(new THREE.HemisphereLight(0x8090a8, 0x201810, new URLSearchParams(location.search).has('bright') ? 2.2 : 0.35));
const lamp = new THREE.SpotLight(0xffb46b, 60, 16, 1.0, 0.6, 2);
lamp.position.set(-5, 4, -11);
lamp.target.position.set(-6, 0, -14);
lamp.castShadow = true;
lamp.shadow.mapSize.set(1024, 1024);
scene.add(lamp, lamp.target);
const torch = new THREE.SpotLight(0xfff2dd, 40, 25, 0.45, 0.5, 2);
camera.add(torch, torch.target);
torch.position.set(-0.3, 0.15, 0);
torch.target.position.set(0, 0, -5);
scene.add(camera);

// Chunks: one instanced mesh per material.
const colors: Record<string, number> = { brick: 0x6e3526, plaster: 0xb3ab9a, concrete: 0x66645f, wood: 0x5e4129, metal: 0x50555a };
const meshes = new Map<string, { mesh: THREE.InstancedMesh; index: Map<number, number> }>();
for (const mat of Object.keys(colors)) {
  const ids = world.chunks.map((c, i) => (c.mat === mat ? i : -1)).filter((i) => i >= 0);
  if (!ids.length) continue;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: colors[mat], roughness: 0.9 }), ids.length);
  mesh.castShadow = mesh.receiveShadow = true;
  const index = new Map<number, number>();
  const m = new THREE.Matrix4();
  ids.forEach((ci, k) => {
    const c = world.chunks[ci];
    m.compose(
      new THREE.Vector3((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2),
      new THREE.Quaternion(),
      new THREE.Vector3(c.max.x - c.min.x - 0.004, c.max.y - c.min.y - 0.004, c.max.z - c.min.z - 0.004),
    );
    mesh.setMatrixAt(k, m);
    index.set(ci, k);
  });
  scene.add(mesh);
  meshes.set(mat, { mesh, index });
}
const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x3a3936, roughness: 0.85 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
for (const s of world.solids) {
  if (s.kind !== 'post' && s.kind !== 'locker') continue;
  const b = new THREE.Mesh(new THREE.BoxGeometry(s.max.x - s.min.x, s.max.y - s.min.y, s.max.z - s.min.z), new THREE.MeshStandardMaterial({ color: s.kind === 'locker' ? 0x404850 : 0x55534f, roughness: 0.6 }));
  b.position.set((s.min.x + s.max.x) / 2, (s.min.y + s.max.y) / 2, (s.min.z + s.max.z) / 2);
  b.castShadow = b.receiveShadow = true;
  scene.add(b);
}

let puffs = 0;
const pipeline: Pipeline = { render() {}, puff: () => void puffs++, setQuality() {}, dispose() {} };
const fx = createFx(scene, world, pipeline) as EffectsImpl;

// A gun-ish stand-in in the viewmodel position for muzzle tests.
const gun = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.5), new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.7, roughness: 0.4 }));
gun.position.set(0.16, -0.14, -0.4);
gun.scale.setScalar(0.6);
camera.add(gun);
const muzzle = new THREE.Object3D();
muzzle.position.set(0, 0.01, -0.27);
gun.add(muzzle);

const flashLight = new THREE.PointLight(0xffa860, 0, 8, 2);
scene.add(flashLight);

function hideChunk(i: number) {
  const c = world.chunks[i];
  const e = meshes.get(c.mat);
  const k = e?.index.get(i);
  if (!e || k === undefined) return;
  e.mesh.setMatrixAt(k, new THREE.Matrix4().makeScale(0, 0, 0));
  e.mesh.instanceMatrix.needsUpdate = true;
}

function breakAround(p: THREE.Vector3, r: number, blast: boolean) {
  const broken: number[] = [];
  world.chunks.forEach((c, i) => {
    if (!world.alive[i] || c.hard) return;
    const cx = (c.min.x + c.max.x) / 2;
    const cy = (c.min.y + c.max.y) / 2;
    const cz = (c.min.z + c.max.z) / 2;
    if (Math.hypot(cx - p.x, cy - p.y, cz - p.z) < r && damageChunk(world, i, 1e6)) broken.push(i);
  });
  const fallen = collapse(world);
  for (const i of [...broken, ...fallen]) {
    hideChunk(i);
    fx.chunkBroken(i);
  }
  // Like the client: what broke, then what lost its support.
  const from = { x: p.x, y: p.y, z: p.z - (blast ? 0 : -1) };
  fx.debris(broken, from, blast);
  if (fallen.length) fx.debris(fallen, from, false);
  return { broken: broken.length, fallen: fallen.length };
}

const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
function aim(ev?: { clientX: number; clientY: number }) {
  if (ev) mouse.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const o = ray.ray.origin;
  const d = ray.ray.direction;
  const hit = raycast(world, o, d, 60);
  if (!hit) return null;
  return { p: o.clone().addScaledVector(d, hit.t), n: hit.n, chunk: hit.chunk, mat: hit.mat as ImpactMat, o: o.clone() };
}

function shoot(ev?: { clientX: number; clientY: number }) {
  const a = aim(ev);
  fx.muzzle(muzzle, 'rifle', false);
  fx.casing(muzzle, 'rifle');
  if (!a) return;
  muzzle.getWorldPosition(tmp);
  fx.tracer({ x: tmp.x, y: tmp.y, z: tmp.z }, a.p, 'lmg');
  fx.impact(a.p, a.n, a.mat, a.chunk);
}
const tmp = new THREE.Vector3();

addEventListener('mousemove', (e) => mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1));
renderer.domElement.addEventListener('mousedown', (e) => shoot(e));
addEventListener('keydown', (e) => {
  const a = aim();
  switch (e.code) {
    case 'KeyB':
      if (a) breakAround(a.p, 0.6, false);
      break;
    case 'KeyX':
      if (a) {
        const p = a.p.clone().addScaledVector(new THREE.Vector3(a.n.x, a.n.y, a.n.z), 0.3);
        fx.explosion(p);
        breakAround(p, 1.6, true);
      }
      break;
    case 'KeyG':
      fx.gib({ x: -6, y: 1.5, z: -12.5 }, { x: 0.3, y: 0.2, z: -1 });
      break;
    case 'KeyH':
      fx.blood({ x: -6, y: 1.3, z: -13 }, { x: 0, y: 0, z: -1 }, 1);
      break;
    case 'KeyR':
      fx.rise({ x: -5, y: 0, z: -12.5 });
      break;
    case 'KeyT':
      fx.board(0, true);
      break;
    case 'KeyY':
      fx.board(0, false);
      break;
    case 'KeyM':
      fx.muzzle(muzzle, 'shotgun', false);
      fx.casing(muzzle, 'shotgun');
      break;
    case 'KeyN':
      fx.muzzle(muzzle, 'sniper', false);
      fx.casing(muzzle, 'sniper');
      break;
    case 'KeyK':
      for (let i = 0; i < 6; i++) setTimeout(() => (fx.muzzle(muzzle, 'rifle', false), fx.casing(muzzle, 'rifle')), i * 80);
      break;
    case 'KeyC':
      fx.clearAll();
      break;
  }
});

const hud = document.getElementById('hud')!;
let last = performance.now();
let frames = 0;
let fpsT = 0;
let fps = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t0 = performance.now();
  fx.update(dt, camera);
  const fl = fx.flashes();
  let best = 0;
  for (const f of fl)
    if (f.intensity > best) {
      best = f.intensity;
      flashLight.position.set(f.pos.x, f.pos.y, f.pos.z);
      flashLight.color.copy(f.color);
    }
  flashLight.intensity = best * 3;
  const t1 = performance.now();
  renderer.render(scene, camera);
  frames++;
  fpsT += dt;
  if (fpsT > 0.5) {
    fps = frames / fpsT;
    frames = 0;
    fpsT = 0;
    hud.textContent = `fps ${fps.toFixed(0)}  fx ${(t1 - t0).toFixed(2)} ms  calls ${renderer.info.render.calls}  puffs ${puffs}\nclick shoot · B break · X grenade · G gib · H blood · R rise · T/Y board · M muzzle · C clear`;
  }
}
requestAnimationFrame(frame);

/** Cuts a wall panel loose (bottom row, top row and both edge columns) so the panel in between collapses. */
function undercut(x0: number, x1: number, z: number) {
  const broken: number[] = [];
  const top = world.height - 0.55;
  world.chunks.forEach((c, i) => {
    if (!world.alive[i] || c.hard || !c.wall) return;
    const cx = (c.min.x + c.max.x) / 2;
    const cz = (c.min.z + c.max.z) / 2;
    if (Math.abs(cz - z) > 0.5 || cx < x0 - 0.3 || cx > x1 + 0.3) return;
    const edge = cx < x0 || cx > x1;
    if ((edge || c.min.y < 0.1 || c.min.y > top) && damageChunk(world, i, 1e6)) broken.push(i);
  });
  const fallen = collapse(world);
  for (const i of [...broken, ...fallen]) {
    hideChunk(i);
    fx.chunkBroken(i);
  }
  fx.debris(broken, { x: (x0 + x1) / 2, y: 1, z: z + 4 }, false);
  if (fallen.length) fx.debris(fallen, { x: (x0 + x1) / 2, y: 1, z: z + 4 }, false);
  return { broken: broken.length, fallen: fallen.length };
}

const lab = { fx, world, camera, shoot, breakAround, undercut, aim, muzzle, THREE, step: true };
(window as unknown as { __lab: typeof lab }).__lab = lab;

// Scripted demo for screenshots: a burst on the wall, a hole, a grenade, gore.
if (new URLSearchParams(location.search).has('demo')) {
  const at = (x: number, y: number) => ({ clientX: innerWidth * x, clientY: innerHeight * y });
  let k = 0;
  const burst = setInterval(() => {
    shoot(at(0.62 + Math.sin(k) * 0.04, 0.45 + Math.cos(k * 1.7) * 0.05));
    if (++k > 18) clearInterval(burst);
  }, 70);
  setTimeout(() => breakAround(new THREE.Vector3(-3.6, 1.2, -15.2), 0.7, false), 1600);
  setTimeout(() => {
    const p = new THREE.Vector3(-8.5, 0.4, -14.6);
    fx.explosion(p);
    breakAround(p, 1.7, true);
  }, 2200);
  setTimeout(() => fx.gib({ x: -5.2, y: 1.5, z: -12.8 }, { x: 0.4, y: 0.2, z: -1 }), 2600);
  setTimeout(() => fx.board(0, true), 2800);
}
