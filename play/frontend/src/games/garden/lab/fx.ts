// Garden FX lab: /lab-garden-fx.html. A small garden board with stand-in towers and dummy enemies looping every
// effect of fx.ts through the real post pipeline (post.ts).
//   ?stress=1        six boards, many more lasers, enemies and deaths (versus worst case)
//   ?fields=1        wave-5 field clutter: 10 slow, 2 beacon, 4 shield fields overlapping on every board
//   ?q=low|medium|high   fx + post quality (keys 1/2/3 too)
//   ?t=<s>           fast-forward the loop before the first frame (for screenshots)
//   ?focus=x,z,dist  camera target and distance; ?yaw=<rad> ?pitch=<deg>
//   ?post=basic      plain UnrealBloomPass instead of post.ts
// Drag = pan, right-drag = orbit, wheel = zoom. window.__lab exposes fx and the boards.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Engine } from '../../../engine/engine';
import type { EnemyKind } from '@shared/garden/enemies';
import { ENEMIES } from '@shared/garden/enemies';
import type { Level, TowerKind } from '@shared/garden/towers';
import { TOWERS } from '@shared/garden/towers';
import type { P3, Quality } from '../api';
import { createFx } from '../fx';
import { createPipeline } from '../post';

const params = new URLSearchParams(location.search);
const hud = document.getElementById('hud')!;
const stress = params.get('stress') === '1';
const fieldsMode = params.get('fields') === '1';
let quality = (params.get('q') as Quality) || 'high';

const engine = new Engine(document.getElementById('app')!, { fov: 35, near: 0.5, far: 600, shadows: false });
const { scene, camera, renderer } = engine;
scene.background = new THREE.Color(0xbfd8c8);
scene.fog = new THREE.Fog(0xbfd8c8, 80, 260);
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x4a6b3a, 1.3));
const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
sun.position.set(-20, 40, 15);
scene.add(sun);

// Post: the real pipeline when it builds, else a basic bloom chain.
let render: () => void;
let setPostQuality: (q: Quality) => void = () => {};
const target = new THREE.Vector3();
let dist = stress ? 95 : 34;
let pipeFocus: ((t: P3, d: number) => void) | null = null;
try {
  if (params.get('post') === 'basic') throw new Error('basic post');
  const pipe = createPipeline(renderer, scene, camera, quality);
  render = () => pipe.render(1 / 60);
  setPostQuality = (q) => pipe.setQuality(q);
  pipeFocus = (t, d) => pipe.setFocus(t, d);
  addEventListener('resize', () => pipe.setSize(innerWidth, innerHeight));
} catch (e) {
  console.warn('post.ts unavailable, using UnrealBloomPass:', e);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.7, 0.5, 1.0));
  composer.addPass(new OutputPass());
  render = () => composer.render();
  addEventListener('resize', () => composer.setSize(innerWidth, innerHeight));
}
engine.renderHook = () => render();

const fx = createFx(scene, quality);

// ---- ground -----------------------------------------------------------------------------------------------------

function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6f9a4e';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const l = 38 + Math.random() * 22;
    g.fillStyle = `hsl(${85 + Math.random() * 25}, ${28 + Math.random() * 18}%, ${l}%)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(40, 40);
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: grassTexture(), roughness: 1 }));
scene.add(ground);

// ---- stand-ins ----------------------------------------------------------------------------------------------------

const stoneMat = new THREE.MeshStandardMaterial({ color: 0xd9cbb4, roughness: 0.85 });
const pathMat = new THREE.MeshStandardMaterial({ color: 0xcfb48a, roughness: 1 });
const KIND_TOP: Record<TowerKind, number> = { laser: 0xe9dcc6, shield: 0xffb24a, slow: 0x7ff0e4, missile: 0xc9a47a, beacon: 0x3fd8b8 };
function towerMesh(kind: TowerKind) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 0.5, 16), stoneMat);
  base.position.y = 0.25;
  g.add(base);
  const top = new THREE.Mesh(
    kind === 'slow' ? new THREE.SphereGeometry(0.42, 16, 10) : kind === 'shield' || kind === 'beacon' ? new THREE.SphereGeometry(0.38, 16, 10) : new THREE.BoxGeometry(0.7, 0.55, 0.8),
    new THREE.MeshStandardMaterial({ color: KIND_TOP[kind], roughness: 0.5, emissive: kind === 'laser' || kind === 'missile' ? 0x000000 : KIND_TOP[kind], emissiveIntensity: 0.5 }),
  );
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.25, 0.8, 10), stoneMat);
  post.position.y = 0.85;
  g.add(post);
  top.position.y = 1.35;
  g.add(top);
  return g;
}
const ENEMY_COL: Record<EnemyKind, number> = { runner: 0xff9a3a, skitter: 0x4ee6d9, disruptor: 0xa869ff, brute: 0x3fc8d8, colossus: 0xf0e0ff };
const HALF: Record<EnemyKind, number> = { runner: 0.4, skitter: 0.25, disruptor: 0.45, brute: 0.9, colossus: 1.5 };
function enemyMesh(kind: EnemyKind) {
  const h = HALF[kind];
  const geo =
    kind === 'brute' ? new THREE.BoxGeometry(h * 1.4, h * 2, h * 1.2) : kind === 'colossus' ? new THREE.IcosahedronGeometry(h, 0) : kind === 'disruptor' ? new THREE.OctahedronGeometry(h, 0) : new THREE.ConeGeometry(h * 0.7, h * 2, 6);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: ENEMY_COL[kind], roughness: 0.4, emissive: ENEMY_COL[kind], emissiveIntensity: 0.25, flatShading: true }));
  return m;
}

// ---- a board ------------------------------------------------------------------------------------------------------

const PATH: [number, number][] = [
  [-13, -2],
  [-4, -2],
  [-4, 5],
  [4, 5],
  [4, -3],
  [13, -3],
];
const KINDS: EnemyKind[] = ['runner', 'skitter', 'runner', 'disruptor', 'skitter', 'brute', 'runner', 'skitter', 'colossus', 'disruptor'];
const PLAYER_COLS = [0x4ea8ff, 0xff6b9a, 0xffc94a, 0x6ee06a, 0xb98aff, 0xff8a4a];

interface Tower {
  id: number;
  kind: TowerKind;
  lv: Level;
  x: number;
  z: number;
  mesh: THREE.Object3D;
  timer: number;
}
interface Enemy {
  id: number;
  kind: EnemyKind;
  s: number;
  speed: number;
  mesh: THREE.Mesh;
  x: number;
  z: number;
}

let nextId = 1;
let nextMissile = 1;
const beamList: { tw: number; from: P3; to: P3; lv: Level; chain: P3[] }[] = [];
const pending: { at: number; fn: () => void }[] = [];
let clock = 0;
const later = (dt: number, fn: () => void) => pending.push({ at: clock + dt, fn });

class Board {
  towers: Tower[] = [];
  enemies: Enemy[] = [];
  segLen: number[] = [];
  total = 0;
  shield!: Tower;
  slow!: Tower;
  beacon!: Tower;
  missile!: Tower;
  protectedLaser!: Tower;
  buildSpot: Tower;
  extraFields: Tower[] = [];
  t = { zap: 0.5, disrupt: 1.2, death: 0.8, ping: 2, cycle: 0, fieldLv: 0, blocked: false };
  constructor(
    readonly ox: number,
    readonly oz: number,
    readonly color: number,
  ) {
    for (let i = 1; i < PATH.length; i++) {
      const [ax, az] = PATH[i - 1];
      const [bx, bz] = PATH[i];
      const l = Math.hypot(bx - ax, bz - az);
      this.segLen.push(l);
      this.total += l;
      const p = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(bx - ax) + 2, 0.04, Math.abs(bz - az) + 2), pathMat);
      p.position.set(ox + (ax + bx) / 2, 0.01, oz + (az + bz) / 2);
      scene.add(p);
    }
    const portal = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.18, 8, 24), new THREE.MeshStandardMaterial({ color: 0x8a6cff, emissive: 0x8a6cff, emissiveIntensity: 1.2 }));
    portal.position.set(ox + PATH[0][0] - 0.5, 1.3, oz + PATH[0][1]);
    portal.rotation.y = Math.PI / 2;
    scene.add(portal);
    const gh = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.4, 3.2), new THREE.MeshStandardMaterial({ color: 0xd8f0ec, roughness: 0.2, transparent: true, opacity: 0.75 }));
    const end = PATH[PATH.length - 1];
    gh.position.set(ox + end[0] + 1.2, 1.2, oz + end[1]);
    scene.add(gh);

    const add = (kind: TowerKind, lv: Level, x: number, z: number) => {
      const mesh = towerMesh(kind);
      mesh.position.set(ox + x, 0, oz + z);
      scene.add(mesh);
      const t: Tower = { id: nextId++, kind, lv, x: ox + x, z: oz + z, mesh, timer: Math.random() };
      this.towers.push(t);
      return t;
    };
    this.protectedLaser = add('laser', 1, -7, 1.5);
    add('laser', 2, 0, 1.5);
    add('laser', 3, 7, -0.5);
    if (stress) {
      add('laser', 1, -9, -5);
      add('laser', 2, -1, -6);
      add('laser', 3, 1, 8);
      add('laser', 2, 9, 1);
      add('laser', 1, 7, -6);
      add('laser', 3, -7, 7);
    }
    this.missile = add('missile', stress ? 3 : 2, 0.5, -5.5);
    this.shield = add('shield', 2, -8, 3.5);
    this.slow = add('slow', 2, 0, 8.5);
    this.beacon = add('beacon', 2, 9, 2.5);
    this.buildSpot = add('laser', 1, 10, -7.5);
    this.buildSpot.mesh.visible = false;
    this.towers.pop();
    if (fieldsMode) {
      const spots: [TowerKind, number, number][] = [
        ['slow', -6, 0], ['slow', -2, 3], ['slow', 2, 3], ['slow', -2, -4], ['slow', 6, -1], ['slow', 2, -1], ['slow', -10, 0], ['slow', 10, -5], ['slow', 6, 7],
        ['beacon', -2, 7], ['shield', -10, -4], ['shield', 2, -8], ['shield', 6, 1],
      ];
      for (const [k, x, z] of spots) {
        const t = add(k, ((Math.abs(x + z) % 3) + 1) as Level, x, z);
        this.extraFields.push(t);
        fx.field(t.id, k as 'slow', this.at(t, 0), TOWERS[k].levels[t.lv - 1].range, t.lv);
      }
    }
    for (const t of [this.shield, this.slow, this.beacon]) fx.field(t.id, t.kind as 'shield', this.at(t, 0), TOWERS[t.kind].levels[t.lv - 1].range, t.lv);

    const count = stress ? 22 : 8;
    for (let i = 0; i < count; i++) {
      const kind = KINDS[i % KINDS.length];
      const mesh = enemyMesh(kind);
      scene.add(mesh);
      this.enemies.push({ id: nextId++, kind, s: (i / count) * this.total, speed: Math.min(3, ENEMIES[kind].speed) * 0.8, mesh, x: 0, z: 0 });
    }
  }
  at(t: { x: number; z: number }, y: number): P3 {
    return { x: t.x, y, z: t.z };
  }
  centre(e: Enemy): P3 {
    return { x: e.x, y: HALF[e.kind], z: e.z };
  }
  place(e: Enemy) {
    let s = e.s;
    for (let i = 0; i < this.segLen.length; i++) {
      if (s <= this.segLen[i] || i === this.segLen.length - 1) {
        const [ax, az] = PATH[i];
        const [bx, bz] = PATH[i + 1];
        const f = Math.min(1, s / this.segLen[i]);
        e.x = this.ox + ax + (bx - ax) * f;
        e.z = this.oz + az + (bz - az) * f;
        e.mesh.rotation.y = Math.atan2(bx - ax, bz - az);
        break;
      }
      s -= this.segLen[i];
    }
    const bob = e.kind === 'disruptor' ? 0.25 + Math.sin(clock * 3 + e.id) * 0.1 : 0;
    e.mesh.position.set(e.x, HALF[e.kind] + bob, e.z);
    e.mesh.rotation.x = e.kind === 'colossus' ? clock * 0.5 : 0;
  }
  respawn(e: Enemy) {
    e.s = 0;
    this.place(e);
    fx.spawn({ x: this.ox + PATH[0][0], y: 0, z: this.oz + PATH[0][1] });
  }
  nearest(x: number, z: number, range: number, skip?: Enemy, skip2?: Enemy): Enemy | null {
    let best: Enemy | null = null;
    let bd = range;
    for (const e of this.enemies) {
      if (e === skip || e === skip2) continue;
      const d = Math.hypot(e.x - x, e.z - z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }
  update(dt: number) {
    const slowR = TOWERS.slow.levels[this.slow.lv - 1].range;
    for (const e of this.enemies) {
      const slowed = Math.hypot(e.x - this.slow.x, e.z - this.slow.z) < slowR;
      e.s += e.speed * dt * (slowed ? 0.55 : 1);
      if (e.s >= this.total) {
        fx.leak({ x: this.ox + PATH[PATH.length - 1][0] + 1.2, y: 0, z: this.oz + PATH[PATH.length - 1][1] });
        this.respawn(e);
      }
      this.place(e);
    }
    // Slow fields light up only while an enemy is inside (optional Fx.fieldActive).
    const fa = (fx as { fieldActive?: (tw: number, active: boolean) => void }).fieldActive;
    if (fa)
      for (const t of [this.slow, ...this.extraFields]) {
        if (t.kind !== 'slow') continue;
        fa(t.id, !!this.nearest(t.x, t.z, TOWERS.slow.levels[t.lv - 1].range));
      }
    // Lasers.
    for (const t of this.towers) {
      if (t.kind !== 'laser') continue;
      const range = TOWERS.laser.levels[t.lv - 1].range + 1;
      const e = this.nearest(t.x, t.z, range);
      if (!e) continue;
      const chain: P3[] = [];
      if (t.lv === 3) {
        const c1 = this.nearest(e.x, e.z, 5, e);
        if (c1) {
          chain.push(this.centre(c1));
          const c2 = this.nearest(c1.x, c1.z, 5, e, c1);
          if (c2) chain.push(this.centre(c2));
        }
      }
      beamList.push({ tw: t.id, from: { x: t.x, y: 1.4, z: t.z }, to: this.centre(e), lv: t.lv, chain });
    }
    // Missiles.
    const m = this.missile;
    m.timer -= dt;
    if (m.timer <= 0) {
      const ml = TOWERS.missile.levels[m.lv - 1];
      m.timer = ml.interval!;
      const e = this.nearest(m.x, m.z, ml.range + 2);
      if (e) {
        for (let i = 0; i < ml.count!; i++) {
          const mid = nextMissile++;
          const ft = 0.9 + i * 0.12;
          fx.missile(mid, { x: m.x + (i - 1) * 0.25, y: 1.5, z: m.z }, () => this.centre(e), ft);
          later(ft, () => fx.boom(mid, this.centre(e), ml.splash!));
        }
      }
    }
    // Shield zaps, disrupt bolts.
    if ((this.t.zap -= dt) <= 0) {
      this.t.zap = 1.7;
      fx.zap(this.shield.id);
    }
    if ((this.t.disrupt -= dt) <= 0) {
      this.t.disrupt = stress ? 1.2 : 2.4;
      const src = this.enemies.find((e) => e.kind === 'disruptor') ?? this.enemies[0];
      this.t.blocked = !this.t.blocked;
      const tw = this.t.blocked ? this.protectedLaser : this.missile;
      fx.disrupt({ x: src.x, y: HALF[src.kind] + 0.3, z: src.z }, { x: tw.x, y: 1.3, z: tw.z }, this.t.blocked);
      if (!this.t.blocked) {
        fx.disabled(tw.id, this.at(tw, 0), true);
        later(2.2, () => fx.disabled(tw.id, this.at(tw, 0), false));
      }
    }
    // Deaths.
    if ((this.t.death -= dt) <= 0) {
      this.t.death = stress ? 0.3 : 0.9;
      const e = this.enemies[(Math.random() * this.enemies.length) | 0];
      fx.death(this.centre(e), e.kind, ENEMIES[e.kind].bounty);
      this.respawn(e);
    }
    // Build / upgrade / sell cycle and field level cycle.
    const b = this.buildSpot;
    const prev = this.t.cycle;
    this.t.cycle = (this.t.cycle + dt) % 12;
    const crossed = (at: number) => (prev < at && this.t.cycle >= at) || (prev > this.t.cycle && at === 0);
    if (crossed(0) || (prev === 0 && this.t.cycle > 0 && clock < 0.1)) {
      b.mesh.visible = true;
      fx.build(this.at(b, 0), 1);
    }
    if (crossed(3)) fx.build(this.at(b, 0), 2);
    if (crossed(6)) fx.build(this.at(b, 0), 3);
    if (crossed(9.5)) {
      b.mesh.visible = false;
      fx.sell(this.at(b, 0));
    }
    if (crossed(4.5)) {
      this.t.fieldLv = (this.t.fieldLv + 1) % 3;
      const lv = (this.t.fieldLv + 1) as Level;
      for (const t of [this.slow, this.beacon]) {
        t.lv = lv;
        fx.field(t.id, t.kind as 'slow', this.at(t, 0), TOWERS[t.kind].levels[lv - 1].range, lv);
      }
    }
    if ((this.t.ping -= dt) <= 0) {
      this.t.ping = 5;
      fx.ping({ x: this.ox + (Math.random() - 0.5) * 16, y: 0, z: this.oz + (Math.random() - 0.5) * 8 }, this.color);
    }
  }
}

const boards: Board[] = [];
const solo = params.get('solo');
if (solo) {
  // One effect on repeat at the origin: boom, death, leak, build, upgrade, sell, spawn, ping, disrupt, block, beam, chain.
  dist = Number(params.get('dist') ?? 12);
  const tw = towerMesh(solo === 'beam' || solo === 'chain' ? 'laser' : solo === 'block' ? 'laser' : 'missile');
  tw.position.set(-3, 0, 0);
  scene.add(tw);
  const dummies = (['runner', 'skitter', 'disruptor', 'brute', 'colossus'] as EnemyKind[]).map((k, i) => {
    const m = enemyMesh(k);
    m.position.set(2, HALF[k], i === 0 ? -3.2 : i === 1 ? -1.6 : i === 2 ? 1.6 : 40);
    scene.add(m);
    return m;
  });
  if (solo === 'block') fx.field(900, 'shield', { x: -3, y: 0, z: 0 }, 3.5, 2);
  let lvSolo = 0;
  let kindSolo = 0;
  let next = 0.2;
  const period = Number(params.get('period') ?? 1.6);
  const fire = () => {
    const o = { x: 0, y: 0, z: 0 };
    const kinds: EnemyKind[] = ['runner', 'skitter', 'disruptor', 'brute', 'colossus'];
    if (solo === 'boom') fx.boom(0, { x: 0, y: 0.4, z: 0 }, 2);
    else if (solo === 'death') {
      const k = kinds[kindSolo++ % 5];
      fx.death({ x: 0, y: HALF[k], z: 0 }, k, ENEMIES[k].bounty);
    } else if (solo === 'leak') fx.leak(o);
    else if (solo === 'build') fx.build(o, 1);
    else if (solo === 'upgrade') fx.build(o, ((lvSolo++ % 2) + 2) as Level);
    else if (solo === 'sell') fx.sell(o);
    else if (solo === 'spawn') fx.spawn(o);
    else if (solo === 'ping') fx.ping(o, PLAYER_COLS[lvSolo++ % 6]);
    else if (solo === 'disabled') {
      fx.disabled(5, { x: -3, y: 0, z: 0 }, true);
      later(1.2, () => fx.disabled(5, { x: -3, y: 0, z: 0 }, false));
    } else if (solo === 'disrupt') fx.disrupt({ x: 3, y: 0.7, z: 1 }, { x: -3, y: 1.3, z: 0 }, false);
    else if (solo === 'block') fx.disrupt({ x: 4, y: 0.7, z: 1 }, { x: -3, y: 1.3, z: 0 }, true);
    else if (solo === 'missile') {
      const mid = nextMissile++;
      fx.missile(mid, { x: -3, y: 1.5, z: 0 }, () => ({ x: 3, y: 0.4, z: 0 }), 1);
      later(1, () => fx.boom(mid, { x: 3, y: 0.4, z: 0 }, 1.6));
    }
  };
  boards.push({
    update(dt: number) {
      for (const m of dummies) m.visible = solo === 'beam' || solo === 'chain';
      if (solo === 'beam' || solo === 'chain') {
        const lv = (solo === 'chain' ? 3 : 1 + (Math.floor(clock / 2) % 2)) as Level;
        const chain = solo === 'chain' ? [{ x: 2, y: 0.25, z: -1.6 }, { x: 2, y: 0.45, z: 1.6 }] : [];
        beamList.push({ tw: 1, from: { x: -3, y: 1.4, z: 0 }, to: { x: 2, y: 0.4, z: -3.2 }, lv, chain });
        return;
      }
      if ((next -= dt) <= 0) {
        next = period;
        fire();
      }
    },
  } as unknown as Board);
} else if (stress) {
  for (let i = 0; i < 6; i++) boards.push(new Board(((i % 3) - 1) * 32, (Math.floor(i / 3) - 0.5) * 24, PLAYER_COLS[i]));
} else boards.push(new Board(0, 0, PLAYER_COLS[0]));

// ---- camera -------------------------------------------------------------------------------------------------------

const focus = (params.get('focus') ?? '').split(',').map(Number);
if (focus.length >= 2 && focus.every((v) => !Number.isNaN(v))) {
  target.set(focus[0], 0, focus[1]);
  if (focus[2]) dist = focus[2];
} else target.set(0, 0, solo || stress ? 0 : 1.5);
let yaw = Number(params.get('yaw') ?? 0);
let pitch = (Number(params.get('pitch') ?? 52) * Math.PI) / 180;
const place = () => {
  const h = Math.cos(pitch) * dist;
  camera.position.set(target.x + Math.sin(yaw) * h, Math.sin(pitch) * dist, target.z + Math.cos(yaw) * h);
  camera.lookAt(target);
  pipeFocus?.(target, dist);
};
place();
const el = renderer.domElement;
let drag = -1;
let lx = 0;
let ly = 0;
el.addEventListener('contextmenu', (e) => e.preventDefault());
el.addEventListener('pointerdown', (e) => {
  drag = e.button;
  lx = e.clientX;
  ly = e.clientY;
  el.setPointerCapture(e.pointerId);
});
el.addEventListener('pointerup', () => (drag = -1));
el.addEventListener('pointermove', (e) => {
  if (drag < 0) return;
  const dx = e.clientX - lx;
  const dy = e.clientY - ly;
  lx = e.clientX;
  ly = e.clientY;
  if (drag === 0) {
    const k = dist * 0.0012;
    target.x += (-dx * Math.cos(yaw) - dy * Math.sin(yaw)) * k;
    target.z += (dx * Math.sin(yaw) - dy * Math.cos(yaw)) * k;
  } else {
    yaw -= dx * 0.005;
    pitch = Math.min(1.45, Math.max(0.3, pitch + dy * 0.004));
  }
  place();
});
el.addEventListener('wheel', (e) => {
  dist = Math.min(300, Math.max(5, dist * Math.exp(e.deltaY * 0.001)));
  place();
});
addEventListener('keydown', (e) => {
  const q = ({ Digit1: 'low', Digit2: 'medium', Digit3: 'high' } as Record<string, Quality>)[e.code];
  if (q) {
    quality = q;
    fx.setQuality(q);
    setPostQuality(q);
  }
});

// ---- loop -----------------------------------------------------------------------------------------------------------

let fxMs = 0;
const step = (dt: number) => {
  clock += dt;
  for (let i = pending.length - 1; i >= 0; i--)
    if (pending[i].at <= clock) {
      const p = pending[i];
      pending.splice(i, 1);
      p.fn();
    }
  beamList.length = 0;
  for (const b of boards) b.update(dt);
  const t0 = performance.now();
  fx.beams(beamList);
  fx.update(dt, camera);
  fxMs = fxMs * 0.9 + (performance.now() - t0) * 0.1;
};
const ff = Number(params.get('t') ?? 0);
for (let t = 0; t < ff; t += 1 / 60) step(1 / 60);

const frozen = params.has('freeze');
let hudAt = 0;
engine.start((dt, now) => {
  if (!frozen) step(Math.min(dt, 0.05));
  if (now - hudAt > 0.4) {
    hudAt = now;
    const s = engine.stats;
    hud.textContent =
      `Garden FX lab${stress ? '  STRESS (6 boards)' : ''}  q ${quality}\n` +
      `${engine.fps.toFixed(0)} fps  ${s.calls} calls  ${(s.triangles / 1000).toFixed(0)}k tris  ratio ${s.ratio}\n` +
      `fx cpu ${fxMs.toFixed(2)} ms  beams ${beamList.length}`;
  }
});
(window as unknown as { __lab: unknown }).__lab = { fx, boards, engine, step };
