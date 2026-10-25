// Garden ambience lab: one map's boards with ambience.ts running on top.
//   /lab-garden-ambience.html?map=<id>&boards=<n>&q=<low|medium|high>&world=<1|0>&focus=<x,z>&dist=<m>&yaw=<deg>
// world=1 (default) uses world.ts / models.ts / post.ts for the backdrop when they load, else a flat grid coloured by
// cell type. Left-drag = pan, right-drag = orbit, wheel = zoom, click = scare there, X = scare near flowers,
// 1/2/3 = quality.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { G } from '@shared/garden/constants';
import { boardOrigin, cellToWorld } from '@shared/garden/board';
import { GMAPS, type GMapDef, type GRoute } from '@shared/garden/maps';
import type { Pipeline, Quality, WorldView } from '../api';
import { createAmbience } from '../ambience';

const params = new URLSearchParams(location.search);
const hud = document.getElementById('hud')!;

// ---- demo map (used until GMAPS has maps) ---------------------------------------------------------------------------

function demoMap(): GMapDef {
  const W = 28;
  const H = 18;
  const g = Array.from({ length: H }, () => Array.from({ length: W }, () => '.'));
  const rect = (c0: number, r0: number, c1: number, r1: number, ch: string) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (g[r]?.[c] !== undefined) g[r][c] = ch;
  };
  const routes: GRoute[] = [
    { entry: 0, half: 1, pts: [[2, 3], [12, 3], [12, 9], [18, 9]] },
    { entry: 1, half: 1, pts: [[2, 15], [9, 15], [9, 9], [18, 9]] },
  ];
  rect(4, 5, 7, 11, '~');
  rect(14, 13, 24, 15, '~');
  rect(20, 0, 21, 12, '~');
  for (const rt of routes)
    for (let i = 1; i < rt.pts.length; i++) {
      const [ax, ay] = rt.pts[i - 1];
      const [bx, by] = rt.pts[i];
      for (let r = Math.min(ay, by) - 1; r < Math.max(ay, by) + 1; r++)
        for (let c = Math.min(ax, bx) - 1; c < Math.max(ax, bx) + 1; c++) if (g[r]?.[c] !== undefined) g[r][c] = g[r][c] === '~' ? '=' : '#';
    }
  rect(0, 2, 1, 3, 'E');
  rect(0, 14, 1, 15, 'E');
  rect(18, 7, 21, 10, 'G');
  const deco: [number, number, string][] = [
    [14, 5, 'f'], [15, 5, 'f'], [14, 6, 'f'], [15, 6, 'T'], [16, 6, 'f'], [3, 12, 'T'], [3, 13, 'f'], [10, 12, 'f'], [11, 12, 'f'],
    [11, 13, 'T'], [24, 3, 'T'], [25, 3, 'T'], [24, 4, 'f'], [25, 4, 'f'], [26, 10, 'R'], [26, 11, 'T'], [5, 0, 'T'], [6, 0, 'f'],
    [16, 1, 'R'], [17, 1, 'f'], [14, 11, 'l'], [8, 7, 'l'], [22, 8, 'l'], [5, 4, 'f'], [6, 4, 'f'], [24, 12, 'o'], [5, 8, 'o'],
    [15, 14, 'o'], [26, 16, 'T'], [25, 16, 'f'], [1, 8, 'T'], [1, 9, 'f'], [17, 16, 'f'], [23, 6, 'f'],
  ];
  for (const [c, r, ch] of deco) if (g[r][c] === '.' || (ch === 'o' && g[r][c] === '~')) g[r][c] = ch;
  return {
    id: 'demo',
    name: 'Demo garden',
    blurb: 'Ambience lab map',
    modes: ['coop', 'vs'],
    grid: g.map((r) => r.join('')),
    entries: [
      { x: 1, y: 3, facing: 0 },
      { x: 1, y: 15, facing: 0 },
    ],
    goal: { x: 20, y: 9 },
    routes,
  };
}

const def: GMapDef = GMAPS.find((m) => m.id === params.get('map')) ?? GMAPS[0] ?? demoMap();
const nBoards = Math.max(1, Math.min(6, Number(params.get('boards') ?? 1)));
let quality = (['low', 'medium', 'high'].includes(params.get('q') ?? '') ? params.get('q') : 'high') as Quality;
const origins = Array.from({ length: nBoards }, (_, b) => boardOrigin(def, b, nBoards));

// ---- renderer / scene -----------------------------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app')!.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfdcae);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.3, 600);

const W = def.grid[0].length;
const H = def.grid.length;
const C = G.cell;

function flatBackdrop() {
  const colors: Record<string, number> = { '.': 0x7fbf5a, '#': 0xf0d9b5, '=': 0xc9a27a, '~': 0x2eb3ff, o: 0x3fa0d8, R: 0x9a948a, T: 0x3d7a2c, f: 0xff9fc6, l: 0xffe27a, s: 0x4a6a9a, E: 0x6a5a4a, G: 0xffd27a };
  const tile = new THREE.PlaneGeometry(C * 0.98, C * 0.98).rotateX(-Math.PI / 2);
  const mats = new Map<string, THREE.Material>();
  const lump = new THREE.SphereGeometry(0.8, 10, 6);
  for (const o of origins) {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W * C + 16, H * C + 16).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x4f8a3a }));
    ground.position.set(o.x, -0.02, o.z);
    ground.receiveShadow = true;
    scene.add(ground);
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        const ch = def.grid[r][c];
        let m = mats.get(ch);
        if (!m) mats.set(ch, (m = new THREE.MeshStandardMaterial({ color: colors[ch] ?? 0xff00ff, roughness: 0.9 })));
        const p = cellToWorld(def, o, c + 0.5, r + 0.5);
        const t = new THREE.Mesh(tile, m);
        t.position.set(p.x, 0, p.z);
        t.receiveShadow = true;
        scene.add(t);
        if (ch === 'T' || ch === 'f') {
          const l = new THREE.Mesh(lump, m);
          l.position.set(p.x, ch === 'T' ? 0.6 : 0.1, p.z);
          l.scale.set(1, ch === 'T' ? 1.2 : 0.45, 1);
          l.castShadow = true;
          scene.add(l);
        }
      }
  }
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
  sun.position.set(30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const ext = Math.max(W, H) * C * 0.5 * Math.max(1, Math.ceil(nBoards / 2)) + 10;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, far: 200 });
  scene.add(sun, new THREE.HemisphereLight(0xcfe8ff, 0x4a6b3a, 1.1));
}

let world: WorldView | null = null;
let pipeline: Pipeline | null = null;
let composer: EffectComposer | null = null;

async function setup() {
  if (params.get('world') !== '0') {
    try {
      const [{ createWorldView }, { createModels }, post] = await Promise.all([import('../world'), import('../models'), import('../post').catch(() => null)]);
      const models = createModels();
      await models.ready;
      world = createWorldView(scene, def, origins, models, quality);
      if (post && params.get('post') !== '0') {
        try {
          pipeline = post.createPipeline(renderer, scene, camera, quality);
          pipeline.setSize(innerWidth, innerHeight);
        } catch (err) {
          console.warn('post.ts failed; plain render', err);
          pipeline = null;
        }
      }
    } catch (err) {
      console.warn('world.ts unavailable; flat backdrop', err);
      world = null;
    }
  }
  if (!world) flatBackdrop();
  if (!pipeline) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.45, 0.5, 0.92));
    composer.addPass(new OutputPass());
  }
  return createAmbience(scene, def, origins, quality);
}

// ---- camera ---------------------------------------------------------------------------------------------------------

const focusParam = params.get('focus')?.split(',').map(Number);
const focus = new THREE.Vector3(focusParam?.[0] ?? origins[0].x, 0, focusParam?.[1] ?? origins[0].z);
// ?near=f (or ~, l, T): look at the densest patch of that cell type on board 0.
const nearCh = params.get('near');
if (nearCh) {
  let best = -1;
  def.grid.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      if (ch !== nearCh) return;
      let n = 0;
      for (let dr = -3; dr <= 3; dr++) for (let dc = -3; dc <= 3; dc++) if (def.grid[r + dr]?.[c + dc] === nearCh) n++;
      if (n > best) {
        best = n;
        const p = cellToWorld(def, origins[0], c + 0.5, r + 0.5);
        focus.set(p.x, 0, p.z);
      }
    }),
  );
}
let dist = Number(params.get('dist') ?? Math.max(W, H) * C * 1.35);
let yaw = (Number(params.get('yaw') ?? 0) * Math.PI) / 180;
const pitch = (55 * Math.PI) / 180;
function placeCamera() {
  camera.position.set(focus.x + Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, focus.z + Math.cos(yaw) * Math.cos(pitch) * dist);
  camera.lookAt(focus);
  pipeline?.setFocus(focus, dist);
}
placeCamera();

const el = renderer.domElement;
el.addEventListener('contextmenu', (e) => e.preventDefault());
let drag: { x: number; y: number; btn: number; moved: number } | null = null;
el.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, btn: e.button, moved: 0 };
  el.setPointerCapture(e.pointerId);
});
el.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (drag.btn === 2) yaw -= dx * 0.005;
  else {
    const k = dist * 0.0016;
    focus.x -= (Math.cos(yaw) * dx + Math.sin(yaw) * dy) * k;
    focus.z -= (-Math.sin(yaw) * dx + Math.cos(yaw) * dy) * k;
  }
  placeCamera();
});
const ray = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let lastScare = '';
el.addEventListener('pointerup', (e) => {
  if (drag && drag.btn === 0 && drag.moved < 5 && amb) {
    ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(groundPlane, p)) doScare(p.x, p.z, 4);
  }
  drag = null;
});
el.addEventListener('wheel', (e) => {
  dist = THREE.MathUtils.clamp(dist * Math.exp(e.deltaY * 0.001), 6, 260);
  placeCamera();
});

// A ring flash where a scare happened.
const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffa940, transparent: true, opacity: 0, depthWrite: false }));
ring.position.y = 0.1;
scene.add(ring);
let ringT = 0;
function doScare(x: number, z: number, r: number) {
  amb?.scare(x, z, r);
  ring.position.set(x, 0.1, z);
  ring.scale.setScalar(r);
  ringT = 1;
  lastScare = `${x.toFixed(1)}, ${z.toFixed(1)} r${r}`;
}
function scareNearFlowers() {
  const cells: [number, number][] = [];
  def.grid.forEach((row, r) => [...row].forEach((ch, c) => ch === 'f' && cells.push([c, r])));
  const [c, r] = cells.length ? cells[Math.floor(Math.random() * cells.length)] : [W / 2, H / 2];
  const p = cellToWorld(def, origins[0], c + 0.5, r + 0.5);
  doScare(p.x, p.z, 4);
}

let amb: ReturnType<typeof createAmbience> | null = null;
const setQ = (q: Quality) => {
  quality = q;
  amb?.setQuality(q);
  world?.setQuality(q);
  pipeline?.setQuality(q);
};
addEventListener('keydown', (e) => {
  if (e.key === 'x' || e.key === 'X') scareNearFlowers();
  if (e.key === '1') setQ('low');
  if (e.key === '2') setQ('medium');
  if (e.key === '3') setQ('high');
});
document.getElementById('scare')!.onclick = scareNearFlowers;
document.getElementById('ql')!.onclick = () => setQ('low');
document.getElementById('qm')!.onclick = () => setQ('medium');
document.getElementById('qh')!.onclick = () => setQ('high');
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  composer?.setSize(innerWidth, innerHeight);
  pipeline?.setSize(innerWidth, innerHeight);
});

// ---- loop -----------------------------------------------------------------------------------------------------------

let lastNow = performance.now();
let t = 0;
let ambMs = 0;
let ambMax = 0;
let fps = 60;
let hudT = 0;
const lab = { ambMs: 0, ambMax: 0, scare: doScare };
(window as unknown as { __amb: typeof lab }).__amb = lab;
Object.defineProperty(window, "__ambScene", { get: () => (scene.getObjectByName("ambience")?.userData.stats as (() => { where: () => unknown }) | undefined)?.().where() });

setup().then((a) => {
  amb = a;
  if (params.get('scare')) setTimeout(scareNearFlowers, Number(params.get('scare')) * 1000);
});

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - lastNow) / 1000, 0.1);
  lastNow = now;
  renderer.info.reset();
  t += dt;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  if (amb) {
    const t0 = performance.now();
    amb.update(dt, t, camera);
    const ms = performance.now() - t0;
    ambMs += (ms - ambMs) * 0.05;
    ambMax = Math.max(ambMax * 0.995, ms);
    lab.ambMs = ambMs;
    lab.ambMax = ambMax;
  }
  world?.update(dt, t);
  if (ringT > 0) {
    ringT = Math.max(0, ringT - dt * 1.5);
    (ring.material as THREE.MeshBasicMaterial).opacity = ringT;
  }
  if (pipeline) pipeline.render(dt);
  else composer?.render(dt);
  hudT -= dt;
  if (hudT <= 0) {
    hudT = 0.25;
    const info = renderer.info.render;
    hud.textContent =
      `${def.name} (${def.id}) x${nBoards}  q=${quality}  backdrop=${world ? 'world.ts' : 'flat grid'}${pipeline ? ' + post.ts' : ''}\n` +
      `ambience ${ambMs.toFixed(3)} ms avg  ${ambMax.toFixed(2)} ms peak   fps ${fps.toFixed(0)}  calls ${info.calls}\n` +
      `${JSON.stringify((scene.getObjectByName('ambience')?.userData.stats as (() => unknown) | undefined)?.() ?? {})}
` +
      `drag pan, right-drag orbit, wheel zoom, click scare, X scare near flowers, 1/2/3 quality` +
      (lastScare ? `\nlast scare ${lastScare}` : '');
  }
});
