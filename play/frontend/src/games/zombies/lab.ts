// Dev lab for the Last Light graphics: /lab-zombies.html?map=storage&q=medium
// Fly with WASD (Shift faster, Z / X down / up), drag to look. B breaks chunks, N blasts a hole in the nearest wall,
// 0-6 set every window's boards, P puffs dust ahead, F shoots where you look (tiles chip), G drops a grenade ahead,
// L flashlight, H hurt, 7 / 8 / 9 quality, M next map.
// ?cam=x,y,z,yaw,pitch parks the camera (screenshots); ?models=0 skips models.ts.

import * as THREE from 'three';
import { MAPS, zmapById } from '@shared/zombies/maps';
import type { ImpactMat } from '@shared/zombies/protocol';
import { buildWorld, chunksInSphere, collapse, damageChunk, raycast, type World } from '@shared/zombies/world';
import { Engine } from '../../engine/engine';
import type { Flashlight, Fx, Models, Pipeline, Quality, WorldView } from './api';
import { createFx } from './fx';
import { createPipeline } from './post';
import { createWorldView } from './world';

const params = new URLSearchParams(location.search);
let mapIndex = Math.max(0, MAPS.findIndex((m) => m.id === (params.get('map') ?? 'hotel')));
let quality = (params.get('q') as Quality) || 'medium';

const stubModels: Models = {
  ready: Promise.resolve(),
  zombie: () => {
    throw new Error('stub');
  },
  survivor: () => {
    throw new Error('stub');
  },
  weapon: () => {
    throw new Error('stub');
  },
  arms: () => new THREE.Group(),
  prop: () => {
    throw new Error('stub');
  },
};

async function loadModels(): Promise<Models> {
  if (params.get('models') === '0') return stubModels;
  const mods = import.meta.glob('./models.ts');
  const load = mods['./models.ts'];
  if (!load) return stubModels;
  try {
    const m = (await load()) as Record<string, unknown>;
    const make = (m.createModels ?? m.loadModels ?? m.models ?? m.default) as (() => Models) | Models | undefined;
    const models = typeof make === 'function' ? (make as () => Models)() : make;
    return models && 'ready' in models ? models : stubModels;
  } catch (e) {
    console.warn('models.ts failed, using stand-ins', e);
    return stubModels;
  }
}

const container = document.getElementById('app')!;
const info = document.getElementById('info')!;
const engine = new Engine(container, { fov: 72, near: 0.05, far: 220 });
engine.shadowHz = 30;
const { scene, camera, renderer } = engine;
renderer.toneMapping = THREE.NoToneMapping;
camera.rotation.order = 'YXZ';

let world: World;
let view: WorldView;
let pipe: Pipeline;
let fx: Fx;
let models: Models = stubModels;

const flash = new THREE.SpotLight(0xfff1dc, 60, 32, 0.5, 0.9, 2);
flash.castShadow = true;
flash.shadow.mapSize.set(1024, 1024);
flash.shadow.bias = -0.0004;
flash.shadow.normalBias = 0.02;
flash.shadow.camera.near = 0.2;
flash.userData.worldOnly = true;
scene.add(flash, flash.target);
// A stand-in gun on the viewmodel layer, to check its exposure next to the camera.
scene.add(camera);
const gun = new THREE.Group();
{
  const steel = new THREE.MeshStandardMaterial({ color: 0x2b2d2e, roughness: 0.4, metalness: 0.85 });
  const poly = new THREE.MeshStandardMaterial({ color: 0x1a1a18, roughness: 0.7, metalness: 0 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.42), steel);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 10).rotateX(Math.PI / 2), steel);
  barrel.position.set(0, 0.015, -0.33);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.05), poly);
  grip.position.set(0, -0.08, 0.1);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.14, 0.06), poly);
  mag.position.set(0, -0.1, -0.06);
  gun.add(body, barrel, grip, mag);
  gun.position.set(0.16, -0.17, -0.38);
  gun.traverse((o) => o.layers.set(1));
  camera.add(gun);
}
let flashOn = true;
let hurt = 0;

const cam = { x: 0, y: 1.62, z: 4, yaw: 0, pitch: 0 };
const camParam = params.get('cam');
if (camParam) {
  const [x, y, z, yaw, pitch] = camParam.split(',').map(Number);
  Object.assign(cam, { x, y, z, yaw: yaw || 0, pitch: pitch || 0 });
}

function build() {
  fx?.dispose();
  pipe?.dispose();
  view?.dispose();
  const def = MAPS[mapIndex];
  const zonesParam = params.get('zones');
  world = zonesParam ? buildWorld(zmapById(def.id)!, zonesParam.split(',') as never) : buildWorld(zmapById(def.id)!);
  const t0 = performance.now();
  view = createWorldView(scene, world, models, quality);
  const t1 = performance.now();
  pipe = createPipeline(renderer, scene, camera, world, view, quality);
  fx = createFx(scene, world, pipe);
  engine.renderHook = () => pipe.render(frameParams());
  engine.invalidateShadows();
  console.log(`[lab] ${def.name}: world ${(t1 - t0).toFixed(0)} ms, pipeline ${(performance.now() - t1).toFixed(0)} ms, ${world.chunks.length} chunks`);
}

let time = 0;
let lastDt = 1 / 60;
function frameParams() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const fl: Flashlight[] = [{ pos: { x: flash.position.x, y: flash.position.y, z: flash.position.z }, dir: { x: dir.x, y: dir.y, z: dir.z }, on: flashOn ? 1 : 0 }];
  return { time, dt: lastDt, hurt, hit: 0, downed: false, flashlights: fl, flashes: fx.flashes() };
}

const broke = (list: number[]) => {
  const fallen = collapse(world);
  for (const i of [...list, ...fallen]) view.breakChunk(i);
  engine.invalidateShadows();
};

function blast(c: THREE.Vector3, r = 1.6) {
  const out: number[] = [];
  chunksInSphere(world, c, r, (i, d) => {
    if (damageChunk(world, i, 400 * (1 - d / r))) out.push(i);
    else view.setChunkHp(i, world.hp[i]);
  });
  broke(out);
  pipe.puff(c, 1.5, 0.9, 6, 0.5);
  return out.length;
}

/** A bullet from the eye along `d`, like the client's own shots. */
function shoot(o: THREE.Vector3, d: THREE.Vector3) {
  d.normalize();
  const hit = raycast(world, o, d, 80);
  if (!hit) return null;
  const p = o.clone().addScaledVector(d, hit.t);
  fx.impact(p, hit.n, hit.mat as ImpactMat, hit.chunk);
  return { p, mat: hit.mat, chunk: hit.chunk };
}

const keys = new Set<string>();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  switch (e.code) {
    case 'KeyB': {
      const out: number[] = [];
      for (let k = 0; k < 40; k++) {
        const i = Math.floor(Math.random() * world.chunks.length);
        if (Math.random() < 0.5) {
          if (damageChunk(world, i, 1e6)) out.push(i);
        } else {
          damageChunk(world, i, world.chunks[i].maxHp * 0.6);
          view.setChunkHp(i, world.hp[i]);
        }
      }
      broke(out);
      break;
    }
    case 'KeyN':
      // Blast where the camera looks, 4 m ahead.
      blast(camera.position.clone().addScaledVector(fwd, 4));
      break;
    case 'KeyF':
      shoot(camera.position.clone(), fwd.clone());
      break;
    case 'KeyG': {
      const hit = raycast(world, camera.position, fwd, 12);
      const p = camera.position.clone().addScaledVector(fwd, hit ? hit.t - 0.3 : 4);
      fx.explosion(p);
      blast(p, 1.6);
      break;
    }
    case 'KeyP': {
      const c = camera.position.clone().addScaledVector(fwd, 3);
      pipe.puff(c, 1.2, 0.8, 5, 0.4);
      break;
    }
    case 'KeyL':
      flashOn = !flashOn;
      break;
    case 'KeyH':
      hurt = hurt > 0 ? 0 : 0.8;
      break;
    case 'KeyM':
      mapIndex = (mapIndex + 1) % MAPS.length;
      build();
      break;
    case 'Digit7':
    case 'Digit8':
    case 'Digit9':
      quality = (['low', 'medium', 'high'] as const)[Number(e.code.slice(5)) - 7];
      view.setQuality(quality);
      pipe.setQuality(quality);
      engine.invalidateShadows();
      break;
    default:
      if (/^Digit[0-6]$/.test(e.code)) for (const w of world.windows) view.setBoards(w.i, Number(e.code.slice(5)));
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
let drag = false;
container.addEventListener('mousedown', () => (drag = true));
window.addEventListener('mouseup', () => (drag = false));
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  cam.yaw -= e.movementX * 0.004;
  cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - e.movementY * 0.004));
});

// Dev handle for scripted screenshots.
(window as unknown as { __lab: unknown }).__lab = {
  cam,
  get world() {
    return world;
  },
  get view() {
    return view;
  },
  get pipe() {
    return pipe;
  },
  engine,
  blast: (x: number, y: number, z: number, r?: number) => blast(new THREE.Vector3(x, y, z), r),
  setFlash: (on: boolean) => (flashOn = on),
  get fx() {
    return fx;
  },
  shoot: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) => shoot(new THREE.Vector3(ox, oy, oz), new THREE.Vector3(dx, dy, dz)),
};

let fpsAcc = 0;
let fpsN = 0;
let fpsShown = 0;
models = await loadModels();
build();
const tick = (dt: number, now: number) => {
  lastDt = dt;
  time = now;
  const speed = (keys.has('ShiftLeft') ? 9 : 3.5) * dt;
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const u = (keys.has('KeyX') ? 1 : 0) - (keys.has('KeyZ') ? 1 : 0);
  cam.x += (-Math.sin(cam.yaw) * f + Math.cos(cam.yaw) * s) * speed;
  cam.z += (-Math.cos(cam.yaw) * f - Math.sin(cam.yaw) * s) * speed;
  cam.y += u * speed;
  camera.position.set(cam.x, cam.y, cam.z);
  camera.rotation.set(cam.pitch, cam.yaw, 0);
  camera.updateMatrixWorld();
  // Flashlight a little right of and below the eye, aimed where we look.
  const right = new THREE.Vector3(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  flash.position.copy(camera.position).addScaledVector(right, 0.18).add(new THREE.Vector3(0, -0.12, 0));
  flash.target.position.copy(flash.position).addScaledVector(dir, 10);
  flash.target.updateMatrixWorld();
  flash.intensity = flashOn ? 60 : 0;
  view.update(dt, now);
  fx.update(dt, camera);
  fpsAcc += dt;
  fpsN++;
  if (now - fpsShown > 0.5) {
    fpsShown = now;
    const st = engine.stats;
    info.textContent = `${MAPS[mapIndex].name} · ${quality} · ${(fpsN / fpsAcc).toFixed(0)} fps · ${st.calls} calls · ${(st.triangles / 1000).toFixed(0)}k tris · render ${st.renderMs.toFixed(1)} ms · x${st.ratio}`;
    fpsAcc = 0;
    fpsN = 0;
  }
};
engine.start(tick);
// GPU-synced cost of one full frame (update + all passes), averaged over n frames, in ms.
(window as unknown as { __lab: Record<string, unknown> }).__lab.bench = (n = 60) => {
  const gl = engine.renderer.getContext();
  const run = () => {
    time += 1 / 60;
    tick(1 / 60, time);
    engine.renderHook?.();
  };
  for (let i = 0; i < 10; i++) run();
  gl.finish();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    run();
    gl.finish();
  }
  return (performance.now() - t0) / n;
};
(window as unknown as { __lab: Record<string, unknown> }).__lab.settled = () => import('./textures').then((m) => m.texturesSettled());
// Background tabs get no animation frames: scripted screenshots step the lab by hand.
(window as unknown as { __lab: Record<string, unknown> }).__lab.step = (n = 1, shadows = true) => {
  for (let i = 0; i < n; i++) {
    time += 1 / 60;
    tick(1 / 60, time);
    // The game refreshes shadows at 30 Hz; profiling passes false on every other step to match.
    if (shadows) engine.renderer.shadowMap.needsUpdate = true;
    engine.renderHook?.();
  }
};
