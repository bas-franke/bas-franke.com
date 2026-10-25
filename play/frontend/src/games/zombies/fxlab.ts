// Dev lab for fx.ts: /lab-zombies-fx.html. A plain three.js view of the hotel (MAPS[0]) as flat-coloured chunks per
// material, furniture included, with a ceiling lamp, a flashlight and a stub pipeline, so the effects can be tuned
// without the rest of the game.
// Click: bullet impact · B: break chunks · X: grenade · G: gib · H: blood · R: rise · T / Y: board tear / fix ·
// M / N / K: shotgun / sniper / rifle-burst muzzle and casings · C: clear · 1-9, 0 / [ ]: material of the test wall
// (the facade panes in front of the start view) · F / Shift+F: next / previous material show.
// URL: `?mat=brick` test-wall material, `?show=sofa` frame and play one show, `?demo` plays every show in turn,
// `?bright` for light. window.__lab exposes everything (show(name) returns a promise; SHOWS lists the names).

import * as THREE from 'three';
import type { Vec3 } from '@shared/math';
import { MAPS, type Mat } from '@shared/zombies/maps';
import type { ImpactMat } from '@shared/zombies/protocol';
import { buildWorld, collapse, damageChunk, raycast } from '@shared/zombies/world';
import type { Pipeline } from './api';
import { createFx, type EffectsImpl } from './fx';
import { ChunkParts } from './wreck';

const params = new URLSearchParams(location.search);
const world = buildWorld(MAPS[0]);
const parts = new ChunkParts(world);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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

scene.add(new THREE.HemisphereLight(0x8090a8, 0x201810, params.has('bright') ? 2.2 : 0.35));
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

// ---- chunks: one instanced mesh per material, rebuilt when the test wall changes material -------------------------

const MATS: Mat[] = ['brick', 'plaster', 'concrete', 'wood', 'metal', 'marble', 'travertine', 'walnut', 'glass', 'fabric', 'leather', 'ceramic', 'brass', 'foliage'];
const colors: Record<Mat, number> = {
  brick: 0x6e3526,
  plaster: 0xb3ab9a,
  concrete: 0x66645f,
  wood: 0x5e4129,
  metal: 0x50555a,
  marble: 0xd8d4cc,
  travertine: 0xb09a74,
  walnut: 0x3a2214,
  glass: 0x9fc4cc,
  fabric: 0xd8cebc,
  leather: 0x4a2418,
  ceramic: 0x1a1914,
  brass: 0xb08436,
  foliage: 0x2f4a1e,
};
const chunkMats = new Map<Mat, THREE.MeshStandardMaterial>();
for (const m of MATS)
  chunkMats.set(
    m,
    m === 'glass'
      ? new THREE.MeshStandardMaterial({ color: colors[m], roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.35, depthWrite: false })
      : new THREE.MeshStandardMaterial({ color: colors[m], roughness: m === 'brass' ? 0.35 : 0.85, metalness: m === 'brass' || m === 'metal' ? 0.8 : 0 }),
  );
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const meshes = new Map<Mat, { mesh: THREE.InstancedMesh; index: Map<number, number> }>();
const _m4 = new THREE.Matrix4();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
function rebuild() {
  for (const { mesh } of meshes.values()) {
    scene.remove(mesh);
    mesh.dispose();
  }
  meshes.clear();
  for (const mat of MATS) {
    const ids = world.chunks.map((c, i) => (c.mat === mat ? i : -1)).filter((i) => i >= 0);
    if (!ids.length) continue;
    const mesh = new THREE.InstancedMesh(boxGeo, chunkMats.get(mat)!, ids.length);
    mesh.castShadow = mat !== 'glass';
    mesh.receiveShadow = true;
    const index = new Map<number, number>();
    ids.forEach((ci, k) => {
      const c = world.chunks[ci];
      if (!world.alive[ci]) mesh.setMatrixAt(k, ZERO);
      else
        mesh.setMatrixAt(
          k,
          _m4.compose(
            new THREE.Vector3((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2),
            new THREE.Quaternion(),
            new THREE.Vector3(c.max.x - c.min.x - 0.004, c.max.y - c.min.y - 0.004, c.max.z - c.min.z - 0.004),
          ),
        );
      index.set(ci, k);
    });
    scene.add(mesh);
    meshes.set(mat, { mesh, index });
  }
}

/** The test wall: the facade panes (and their frames) straight ahead of the start view. */
const testWall = world.chunks
  .map((c, i) => ({ c, i }))
  .filter(({ c }) => c.furn === undefined && (c.min.z + c.max.z) / 2 > -18.6 && (c.min.z + c.max.z) / 2 < -17.6 && c.min.x > -10.5 && c.max.x < -1.5 && c.min.y < 4)
  .map(({ i }) => i);
const wallOrig = testWall.map((i) => world.chunks[i].mat);
let wallMat: Mat | null = null;
function setWallMat(m: Mat | null) {
  wallMat = m;
  testWall.forEach((ci, k) => (world.chunks[ci].mat = m ?? wallOrig[k]));
  rebuild();
}
const qMat = params.get('mat') as Mat | null;
if (qMat && MATS.includes(qMat)) setWallMat(qMat);
else rebuild();

const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x55534e, roughness: 0.85 }));
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
  e.mesh.setMatrixAt(k, ZERO);
  e.mesh.instanceMatrix.needsUpdate = true;
}

/** Breaks `broken` (already damaged to death) plus whatever lost its support, like the client does. */
function settle(broken: number[], from: Vec3, blast: boolean) {
  const fallen = collapse(world);
  for (const i of [...broken, ...fallen]) {
    hideChunk(i);
    fx.chunkBroken(i);
  }
  fx.debris(broken, from, blast);
  if (fallen.length) fx.debris(fallen, from, false);
  return { broken: broken.length, fallen: fallen.length };
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
  return settle(broken, { x: p.x, y: p.y, z: p.z - (blast ? 0 : -1) }, blast);
}

/** Breaks the given chunks, as a bullet would (from the camera's side). */
function breakChunks(ids: number[]) {
  const broken = ids.filter((i) => world.alive[i] && !world.chunks[i].hard && damageChunk(world, i, 1e6));
  return settle(broken, { x: camera.position.x, y: camera.position.y, z: camera.position.z }, false);
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
  return { p: o.clone().addScaledVector(d, hit.t), n: hit.n, chunk: hit.chunk, mat: hit.mat as ImpactMat, o: o.clone(), d: d.clone() };
}

const tmp = new THREE.Vector3();
function fire(a: ReturnType<typeof aim>) {
  fx.muzzle(muzzle, 'rifle', false);
  fx.casing(muzzle, 'rifle');
  if (!a) return;
  muzzle.getWorldPosition(tmp);
  fx.tracer({ x: tmp.x, y: tmp.y, z: tmp.z }, a.p, 'lmg');
  fx.impact(a.p, a.n, a.mat, a.chunk, { x: a.d.x, y: a.d.y, z: a.d.z });
}
const shoot = (ev?: { clientX: number; clientY: number }) => fire(aim(ev));

/** Shoots from the camera at a world point (shows aim at chunks directly). */
function shootAt(x: number, y: number, z: number) {
  const o = camera.position;
  const d = new THREE.Vector3(x - o.x, y - o.y, z - o.z).normalize();
  const hit = raycast(world, o, d, 60);
  fire(hit ? { p: o.clone().addScaledVector(d, hit.t), n: hit.n, chunk: hit.chunk, mat: hit.mat as ImpactMat, o: o.clone(), d } : null);
}

addEventListener('mousemove', (e) => mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1));
renderer.domElement.addEventListener('mousedown', (e) => shoot(e));
addEventListener('keydown', (e) => {
  const a = aim();
  if (/^Digit\d$/.test(e.code)) {
    const k = (Number(e.code.slice(5)) + 9) % 10;
    setWallMat(MATS[k]);
    return;
  }
  switch (e.code) {
    case 'BracketLeft':
    case 'BracketRight': {
      const k = wallMat ? MATS.indexOf(wallMat) : -1;
      setWallMat(MATS[(k + (e.code === 'BracketRight' ? 1 : MATS.length - 1)) % MATS.length]);
      break;
    }
    case 'KeyF':
      showIndex = (showIndex + (e.shiftKey ? SHOWS.length - 1 : 1)) % SHOWS.length;
      void show(SHOWS[showIndex]);
      break;
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
let label = '';
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
    hud.textContent = `${label ? label + '\n' : ''}fps ${fps.toFixed(0)}  fx ${(t1 - t0).toFixed(2)} ms  calls ${renderer.info.render.calls}  puffs ${puffs}  wall ${wallMat ?? 'as built'}\nclick shoot · B break · X grenade · G gib · H blood · R rise · T/Y board · M muzzle · C clear · 1-0 [ ] wall material · F show`;
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
  return settle(broken, { x: (x0 + x1) / 2, y: 1, z: z + 4 }, false);
}

// ---- material shows: frame one material (or furniture part), shoot it, break a chunk of it ------------------------

interface Show {
  /** The chunk to shoot and break. */
  pick: () => number;
  /** Test-wall material for the classic materials. */
  wall?: Mat;
  /** Camera distance. */
  dist?: number;
  /** Grenade instead of a bullet break. */
  grenade?: boolean;
  /** Break this many neighbouring chunks of the same part too (a whole lamp shade, a canopy). */
  spread?: number;
}

const center = (i: number) => {
  const c = world.chunks[i];
  return new THREE.Vector3((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2);
};
/** The live chunk of furniture `kind` (n-th piece of that kind) whose part is `part`, highest first. */
function furnChunk(kind: string, part: string, nth = 0) {
  const f = world.furniture.filter((x) => x.kind === kind)[nth];
  if (!f) return -1;
  let best = -1;
  for (let i = f.c0; i < f.c1; i++) if (world.alive[i] && parts.name(i) === part && (best < 0 || world.chunks[i].max.y > world.chunks[best].max.y)) best = i;
  return best;
}
/** The live chunk of `mat` (not furniture) closest to p. */
function nearest(mat: Mat, p: THREE.Vector3) {
  let best = -1;
  let bd = Infinity;
  world.chunks.forEach((c, i) => {
    if (!world.alive[i] || c.mat !== mat || c.furn !== undefined || c.hard) return;
    const d = center(i).distanceToSquared(p);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}
const wallPane = () => nearest(wallMat ?? 'glass', new THREE.Vector3(-6, 1.25, -18.1));

const SHOW: Record<string, Show> = {
  glass: { pick: () => nearest('glass', new THREE.Vector3(-6, 1.25, -18.1)), dist: 1.7 },
  marble: { pick: () => furnChunk('coffeeTable', 'top', 1) },
  travertine: { pick: wallPane, wall: 'travertine', dist: 2.2 },
  walnut: { pick: () => furnChunk('booth', 'panel', 0), dist: 2.2 },
  sofa: { pick: () => furnChunk('sofa', 'seat', 0), dist: 2 },
  armchair: { pick: () => furnChunk('armchair', 'back', 1), dist: 1.8 },
  leather: { pick: () => furnChunk('booth', 'seat', 1), dist: 2 },
  stool: { pick: () => furnChunk('stool', 'seat', 2), dist: 1.4 },
  luggage: { pick: () => furnChunk('luggageCart', 'case', 0), dist: 1.8 },
  ceramic: { pick: () => furnChunk('planter', 'pot', 0), dist: 1.6 },
  foliage: { pick: () => furnChunk('planter', 'canopy', 1), dist: 2.6, spread: 3 },
  flowers: { pick: () => furnChunk('centerpiece', 'flowers', 0), dist: 2.4, spread: 2 },
  vase: { pick: () => furnChunk('centerpiece', 'vase', 0), dist: 1.8 },
  brass: { pick: () => furnChunk('coffeeTable', 'body', 0), dist: 1.6 },
  shade: { pick: () => furnChunk('floorLamp', 'shade', 1), dist: 1.8, spread: 4 },
  cloth: { pick: () => furnChunk('diningTable', 'cloth', 0), dist: 2.2 },
  brick: { pick: wallPane, wall: 'brick', dist: 2.2 },
  plaster: { pick: wallPane, wall: 'plaster', dist: 2.2 },
  concrete: { pick: wallPane, wall: 'concrete', dist: 2.2 },
  wood: { pick: wallPane, wall: 'wood', dist: 2.2 },
  metal: { pick: wallPane, wall: 'metal', dist: 2.2 },
  grenade: { pick: () => furnChunk('sofa', 'back', 2), dist: 3.6, grenade: true },
};
const SHOWS = Object.keys(SHOW);
let showIndex = -1;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Frames the show's target from its open side, lights it, shoots it a few times and breaks it. */
async function show(name: string, opts: { shots?: number; breakAt?: number } = {}) {
  const s = SHOW[name];
  if (!s) throw new Error(`no show ${name}`);
  label = `show: ${name}`;
  fx.clearAll();
  if (s.wall !== undefined || wallMat) setWallMat(s.wall ?? null);
  let ci = s.pick();
  if (ci < 0) throw new Error(`show ${name}: nothing left to break`);
  const t = center(ci);
  // From the open side: the horizontal direction with the most room, leaning towards the middle of the atrium.
  const dist = s.dist ?? 1.8;
  let bestDir = new THREE.Vector3(0, 0, 1);
  let bestScore = -Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const from = t.clone().addScaledVector(d, 0.35);
    from.y = Math.max(t.y, 0.9);
    const hit = raycast(world, from, d, dist + 0.5);
    const room = hit ? hit.t : dist + 0.5;
    const toMid = -(t.x * d.x + t.z * d.z) / (Math.hypot(t.x, t.z) || 1);
    const score = Math.min(room, dist + 0.3) * 3 + toMid * 0.6;
    if (score > bestScore) {
      bestScore = score;
      bestDir = d;
    }
  }
  camera.position.copy(t).addScaledVector(bestDir, dist);
  camera.position.y = Math.max(0.9, t.y + 0.35 + dist * 0.2);
  camera.lookAt(t.x, t.y - 0.1, t.z);
  lamp.position.set(t.x + bestDir.x * 1.2 + 0.6, t.y + 2.6, t.z + bestDir.z * 1.2 - 0.4);
  lamp.target.position.copy(t);
  // Of that part, the chunk facing the camera (so the break is in view).
  const f = world.chunks[ci].furn;
  if (f !== undefined) {
    const name = parts.name(ci);
    let bd = Infinity;
    for (let i = world.furniture[f].c0; i < world.furniture[f].c1; i++) {
      if (!world.alive[i] || parts.name(i) !== name) continue;
      const d = center(i).distanceToSquared(camera.position);
      if (d < bd) {
        bd = d;
        ci = i;
      }
    }
  }
  await wait(120);
  const c = world.chunks[ci];
  const shots = opts.shots ?? 6;
  for (let i = 0; i < shots; i++) {
    shootAt(c.min.x + (c.max.x - c.min.x) * (0.25 + Math.random() * 0.5), c.min.y + (c.max.y - c.min.y) * (0.25 + Math.random() * 0.5), c.min.z + (c.max.z - c.min.z) * (0.25 + Math.random() * 0.5));
    await wait(70);
  }
  await wait(opts.breakAt ?? 250);
  if (s.grenade) {
    const p = t.clone();
    p.y = 0.4;
    fx.explosion(p);
    return breakAround(p, 1.7, true);
  }
  // The target plus its nearest live neighbours of the same part.
  const same = [ci];
  if (s.spread) {
    const cand = world.chunks.map((_, i) => i).filter((i) => i !== ci && world.alive[i] && world.chunks[i].furn === f && parts.name(i) === parts.name(ci));
    cand.sort((a, b) => center(a).distanceTo(t) - center(b).distanceTo(t));
    same.push(...cand.slice(0, s.spread - 1));
  }
  return breakChunks(same);
}

const lab = { fx, world, camera, shoot, shootAt, breakAround, breakChunks, undercut, aim, muzzle, THREE, step: true, show, SHOWS, setWallMat, parts };
(window as unknown as { __lab: typeof lab }).__lab = lab;

if (params.get('show')) void show(params.get('show')!);
else if (params.has('demo')) {
  // Every show in turn, ~3.5 s each.
  void (async () => {
    for (const name of SHOWS) {
      await show(name);
      await wait(3200);
    }
  })();
}
