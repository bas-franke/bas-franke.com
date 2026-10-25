// Units lab: every tower (kind x level) aiming at a moving dummy, every enemy kind walking a loop with hits, slows,
// stuns, casts and deaths, plus the selection ring and the placement ghost. /lab-garden-units.html?view=towers|enemies|all
// Extra: &n=600 enemies (stress test), &shadows=0.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ENEMY_KINDS, type EnemyKind } from '@shared/garden/enemies';
import type { GMapDef } from '@shared/garden/maps';
import { EFlag, TFlag, type TowerInfo } from '@shared/garden/protocol';
import { TOWER_KINDS, TOWERS, type Level } from '@shared/garden/towers';
import { cellToWorld } from '@shared/garden/board';
import type { EnemyFrame, KitName } from '../api';
import { createModels, type ModelsReport } from '../models';
import { createUnits } from '../units';

const q = new URLSearchParams(location.search);
const view = (q.get('view') ?? 'all') as 'towers' | 'enemies' | 'all';
const showTowers = view !== 'enemies';
const showEnemies = view !== 'towers';
const enemyCount = Number(q.get('n') ?? (showTowers ? 20 : 30));
const hud = document.getElementById('hud')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = q.get('shadows') !== '0';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfe0ef);
scene.fog = new THREE.Fog(0xbfe0ef, 70, 140);
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x5a7a4a, 1.3));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
sun.position.set(-14, 26, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 80 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.03;
scene.add(sun);

// Flat garden board: 20 x 14 cells (40 x 28 m) with faint cell lines.
const COLS = 20;
const ROWS = 14;
const def: GMapDef = {
  id: 'lab',
  name: 'Lab',
  blurb: '',
  modes: ['coop'],
  grid: Array.from({ length: ROWS }, () => '.'.repeat(COLS)),
  entries: [],
  goal: { x: 10, y: 7 },
  routes: [],
};
const origins = [{ x: 0, z: 0 }];
{
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#7fb257';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 500; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(60,110,40,0.25)' : 'rgba(170,210,110,0.25)';
    g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  g.strokeStyle = 'rgba(40,80,30,0.25)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(COLS + 10, ROWS + 10);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry((COLS + 10) * 2, (ROWS + 10) * 2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
  ground.receiveShadow = true;
  scene.add(ground);
}

const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.5, 300);
const controls = new OrbitControls(camera, renderer.domElement);
const pitch = (55 * Math.PI) / 180;
const dist = Number(q.get('dist') ?? (showTowers ? 44 : 34));
controls.target.set(Number(q.get('tx') ?? 0), 0, Number(q.get('tz') ?? (showTowers ? 1 : 0)));
camera.position.set(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist + controls.target.z);
controls.enableDamping = true;
controls.maxPolarAngle = 1.35;
controls.update();
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const models = createModels() as ReturnType<typeof createModels> & { report: ModelsReport };
await models.ready;
const units = createUnits(scene, def, origins, models);
// Resolve every kit piece and enemy once so the report lists found / missing GLB nodes and clips.
const KIT: KitName[] = ['rock_a', 'rock_b', 'rock_c', 'bush_a', 'bush_b', 'fern', 'tree_a', 'tree_b', 'flowers_a', 'flowers_b', 'flowers_c', 'grass_tuft', 'reeds', 'lilypad', 'lamp', 'solar', 'bridge', 'portal', 'greenhouse', 'path_stone', 'pebble'];
for (const k of KIT) models.kitParts(k);
for (const k of ENEMY_KINDS) models.enemy(k).dispose();
for (const k of TOWER_KINDS) for (const lv of [1, 2, 3] as Level[]) models.tower(k, lv, 0xffffff).dispose();
if (models.report.missing.length) console.warn('Garden units lab: missing GLB parts:', models.report.missing.join(', '));
// Kit lineup along the top edge (?kit=1).
if (q.get('kit') === '1')
  KIT.forEach((k, i) => {
    const o = models.kit(k);
    o.position.set(-22 + (i % 11) * 4.4, 0, -20 - Math.floor(i / 11) * 7);
    scene.add(o);
  });

// Towers: kinds along x, levels along z.
const towers: TowerInfo[] = [];
const COLORS = [0x4fa3ff, 0xff7a59, 0x9b6bff, 0x3ccf8e, 0xffc94f];
if (showTowers) {
  let id = 1;
  TOWER_KINDS.forEach((k, i) => {
    for (const lv of [1, 2, 3] as Level[]) {
      const t: TowerInfo = { id: id++, k, lv, b: 0, x: 4 + i * 3, y: 4 + (lv - 1) * 3, own: 'p', tm: 0, spent: 0 };
      towers.push(t);
      setTimeout(() => units.addTower(t, COLORS[i]), 200 + t.id * 90);
    }
  });
}

// Dummy target for the towers (towers-only view) — a little glowing orb.
const dummy = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), new THREE.MeshStandardMaterial({ color: 0xff6a8a, emissive: 0xff3060, emissiveIntensity: 1.5 }));
dummy.castShadow = true;
scene.add(dummy);
dummy.visible = !showEnemies;

// Enemy loop: rounded rectangle around the towers.
const RX = showTowers ? 18 : 13;
const RZ = showTowers ? 12.5 : 9;
function loopPos(d: number, lateral: number, out: { x: number; z: number; yaw: number }) {
  // Superellipse-ish loop parameterised by angle; d is in metres (approximate).
  const per = 2 * Math.PI * Math.sqrt((RX * RX + RZ * RZ) / 2);
  const a = (d / per) * Math.PI * 2;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const p = 0.6;
  const sx = Math.sign(ca) * Math.pow(Math.abs(ca), p);
  const sz = Math.sign(sa) * Math.pow(Math.abs(sa), p);
  const a2 = a + 0.01;
  const nx = Math.sign(Math.cos(a2)) * Math.pow(Math.abs(Math.cos(a2)), p);
  const nz = Math.sign(Math.sin(a2)) * Math.pow(Math.abs(Math.sin(a2)), p);
  const dx = (nx - sx) * RX;
  const dz = (nz - sz) * RZ;
  const l = Math.hypot(dx, dz) || 1;
  out.x = sx * RX + (-dz / l) * lateral;
  out.z = sz * RZ + (dx / l) * lateral;
  out.yaw = Math.atan2(-dx, -dz);
}

interface LabEnemy {
  id: number;
  kind: EnemyKind;
  d: number;
  lat: number;
  hp: number;
  stunT: number;
  frame: EnemyFrame;
}
let nextId = 1000;
const labEnemies: LabEnemy[] = [];
function spawn(kind: EnemyKind, d: number) {
  const e: LabEnemy = { id: nextId++, kind, d, lat: (Math.random() - 0.5) * 2.4, hp: 1, stunT: 0, frame: { id: 0, kind, b: 0, x: 0, z: 0, yaw: 0, hp: 1, f: 0, speed: 1 } };
  e.frame.id = e.id;
  labEnemies.push(e);
}
if (showEnemies) {
  const kinds: EnemyKind[] = [...ENEMY_KINDS];
  // Small counts: an even lineup of kinds. Stress counts: a versus-like mix (mostly runners and skitters).
  const mix = (i: number): EnemyKind => {
    if (enemyCount <= 60) return kinds[i % kinds.length];
    const r = (i * 0.6180339) % 1;
    return r < 0.5 ? 'runner' : r < 0.85 ? 'skitter' : r < 0.93 ? 'disruptor' : r < 0.99 ? 'brute' : 'colossus';
  };
  for (let i = 0; i < enemyCount; i++) spawn(mix(i), (i / enemyCount) * 120);
}
const SPEED: Record<EnemyKind, number> = { runner: 3.2, skitter: 2.5, disruptor: 1.6, brute: 1.0, colossus: 0.65 };

// Demo timeline.
let t = 0;
let nextKill = 2;
let nextHit = 0;
let nextSel = 1.5;
let selIdx = 0;
let nextCast = 2;
const tmp = { x: 0, z: 0, yaw: 0 };
const frames: EnemyFrame[] = [];
let last = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let fps = 0;
let msU = 0;
let msR = 0;

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  t += dt;
  fpsAcc += dt;
  fpsN++;
  if (fpsAcc > 0.5) {
    fps = Math.round(fpsN / fpsAcc);
    fpsAcc = 0;
    fpsN = 0;
  }

  // Enemies.
  frames.length = 0;
  for (const e of labEnemies) {
    const slowed = loopSlowZone(e);
    const mul = slowed ? 0.55 : 1;
    if (e.stunT > 0) e.stunT -= dt;
    else e.d += SPEED[e.kind] * mul * dt;
    loopPos(e.d, e.lat, tmp);
    const f = e.frame;
    f.x = tmp.x;
    f.z = tmp.z;
    f.yaw = tmp.yaw;
    f.hp = e.hp;
    f.speed = e.stunT > 0 ? 0 : mul;
    f.f = (slowed ? EFlag.slowed : 0) | (e.stunT > 0 ? EFlag.stunned : 0);
    frames.push(f);
  }
  units.syncEnemies(frames);

  if (showEnemies && labEnemies.length) {
    if (t > nextHit) {
      nextHit = t + 0.12;
      const e = labEnemies[(Math.random() * labEnemies.length) | 0];
      e.hp = Math.max(0.05, e.hp - 0.08 - Math.random() * 0.1);
      units.hit(e.id);
    }
    if (t > nextKill) {
      nextKill = t + 1.6;
      const i = (Math.random() * labEnemies.length) | 0;
      const e = labEnemies[i];
      units.kill(e.id);
      labEnemies.splice(i, 1);
      const kind = e.kind;
      setTimeout(() => spawn(kind, Math.random() * 120), 1500);
      // Stun someone else.
      const s = labEnemies[(Math.random() * labEnemies.length) | 0];
      if (s) s.stunT = 1.2;
    }
    if (t > nextCast) {
      nextCast = t + 2.5;
      for (const e of labEnemies) if (e.kind === 'disruptor') units.cast(e.id);
    }
  }

  // Tower aims: the nearest enemy in range, or the dummy.
  dummy.position.set(Math.cos(t * 0.5) * 12, 0.6 + Math.sin(t * 2) * 0.2, Math.sin(t * 0.5) * 8);
  for (const tw of towers) {
    const p = cellToWorld(def, origins[0], tw.x + 0.5, tw.y + 0.5);
    let aim: { x: number; y: number; z: number } | null = null;
    if (TOWERS[tw.k].targets) {
      if (!showEnemies) aim = { x: dummy.position.x, y: dummy.position.y, z: dummy.position.z };
      else {
        const range = TOWERS[tw.k].levels[tw.lv - 1].range;
        let best = range * range;
        for (const f of frames) {
          const d2 = (f.x - p.x) ** 2 + (f.z - p.z) ** 2;
          if (d2 < best) {
            best = d2;
            aim = { x: f.x, y: 0.4, z: f.z };
          }
        }
      }
    }
    // Disable one tower at a time, cycling; the beacon row is buffed.
    const disabled = Math.floor(t / 3) % towers.length === tw.id - 1;
    const flags = (disabled ? TFlag.disabled : 0) | (tw.k === 'beacon' ? TFlag.buffed : 0);
    units.setTowerState(tw.id, aim, flags);
  }
  if (showTowers && t > nextSel) {
    nextSel = t + 2.5;
    const tw = towers[selIdx++ % towers.length];
    units.select(tw.id);
    if (selIdx % 4 === 0) units.upgradeTower(tw.id, tw.lv); // no-op, sanity
  }
  // Ghost slides along the bottom row, red on every other cell.
  if (showTowers) {
    const col = 2 + (Math.floor(t * 0.8) % 16);
    const p = cellToWorld(def, origins[0], col + 0.5, 2.5);
    const kind = TOWER_KINDS[Math.floor(t / 6) % TOWER_KINDS.length];
    units.ghost({ kind, x: p.x, z: p.z, ok: col % 3 !== 0, range: TOWERS[kind].levels[0].range });
  }

  const t0 = performance.now();
  units.update(dt, camera);
  const t1 = performance.now();
  controls.update();
  renderer.render(scene, camera);
  const t2 = performance.now();
  msU += (t1 - t0 - msU) * 0.05;
  msR += (t2 - t1 - msR) * 0.05;
  const r = models.report;
  hud.textContent =
    `Garden units lab  view=${view}  fps ${fps}  draws ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k\n` +
    `towers ${towers.length}  enemies ${labEnemies.length}  units.update ${msU.toFixed(1)} ms  render ${msR.toFixed(1)} ms\n` +
    `GLB loaded: towers ${r.loaded.towers} enemies ${r.loaded.enemies} kit ${r.loaded.kit}\n` +
    `found ${r.found.length}\n` +
    `missing ${r.missing.length}: ${r.missing.join(', ') || '-'}`;
  requestAnimationFrame(tick);
}

function loopSlowZone(e: LabEnemy) {
  return e.frame.x > RX * 0.6;
}

// Click a tower to select it.
const ray = new THREE.Raycaster();
renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  ray.setFromCamera(new THREE.Vector2((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1), camera);
  const id = units.pickTower(ray.ray);
  if (id != null) {
    units.select(id);
    nextSel = t + 6;
  }
});
// U upgrades the selected cycle tower, X removes and re-adds (pop-in demo).
addEventListener('keydown', (ev) => {
  const tw = towers[(selIdx - 1 + towers.length) % towers.length];
  if (!tw) return;
  if (ev.key === 'u') {
    tw.lv = ((tw.lv % 3) + 1) as Level;
    units.upgradeTower(tw.id, tw.lv);
  }
  if (ev.key === 'x') {
    units.removeTower(tw.id);
    setTimeout(() => units.addTower(tw, 0xffffff), 300);
  }
});
(window as unknown as { units: unknown; __scene: unknown }).units = units;
(window as unknown as { __scene: unknown }).__scene = scene;

requestAnimationFrame(tick);
