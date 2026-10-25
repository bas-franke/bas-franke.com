// Last Light client: input, prediction, weapons, the zombie and survivor views, and the glue between the render
// modules (see api.ts for who owns what). The server decides everything that matters; this file predicts the local
// player's movement and shots so they feel instant, and replays the server's events as sound, light and debris.

import * as THREE from 'three';
import { clamp, hdist, type Vec3, type Vec3Tuple, yawForward, yawRight } from '@shared/math';
import type { GameServerMsg, RoomView } from '@shared/protocol';
import { ZB } from '@shared/zombies/constants';
import { zmapById } from '@shared/zombies/maps';
import { type Body, type NadeBody, type ZInput, eyeHeight, stepNade, stepPlayer } from '@shared/zombies/physics';
import {
  GIB,
  IMPACT_MATS,
  type LifeState,
  type MeSnap,
  type ZEvent,
  type ZPlayerSnap,
  type ZScore,
  type ZSnapshot,
  ZState,
  type ZombieSnap,
  type ZombiesServerMsg,
} from '@shared/zombies/protocol';
import { AMMO_CACHE_SHARE, AMMO_CRATE_PRICE, ARMOR_PRICE, NADE_PRICE, START_WEAPON, WEAPONS, type WeaponId, fireInterval } from '@shared/zombies/weapons';
import { type World, buildWorld, inside, raycast } from '@shared/zombies/world';
import { Engine, colorHex, makeLabel } from '../../engine/engine';
import { Input } from '../../engine/input';
import { SnapshotTimeline, damp, lerpAngle } from '../../engine/interp';
import { type ClientContext, type GameClient, createStore } from '../types';
import { type CharacterInstance, type Flashlight, type Fx, type Models, type Pipeline, type Quality, VIEWMODEL_LAYER, type WorldView, type ZAudio } from './api';
import { configureZAudio, createZAudio } from './audio';
import { type EffectsImpl, createFx } from './fx';
import { createModels } from './models';
import { texturesSettled } from './textures';
import { createPipeline } from './post';
import { Viewmodel } from './viewmodel';
import { createWorldView } from './world';

export interface Popup {
  key: number;
  n: number;
  why: string;
  at: number;
}

export interface ZHudState {
  /** Fully loaded (world, models, sharp textures, shaders, first snapshot) and the first frame is on screen: playable. */
  ready: boolean;
  /** What the loading screen shows; `done` 0..1 only ever grows. null once ready. */
  loading: { stage: string; done: number } | null;
  mapName: string;
  /** The map's wings and whether this match opened them (the squad size at the start decides). */
  wings: { name: string; open: boolean; minPlayers: number }[];
  wave: number;
  phase: 'break' | 'wave';
  left: number;
  hp: number;
  armor: number;
  points: number;
  life: LifeState;
  bleed: number;
  slots: [WeaponId, WeaponId | null];
  cur: 0 | 1;
  mag: number;
  res: number;
  nades: number;
  reloading: boolean;
  prompt: string | null;
  progress: number | null;
  popups: Popup[];
  /** performance.now() of the last confirmed hit / kill, for the hit marker. */
  hitAt: number;
  killAt: number;
  headAt: number;
  /** Direction of the last hit taken, relative to the view (radians), and when. */
  hurtYaw: number;
  hurtAt: number;
  deny: { text: string; at: number } | null;
  banner: { text: string; sub: string; at: number } | null;
  scores: ZScore[];
  ended: { scores: ZScore[]; winner: string | null; wave: number } | null;
  /** Aimed down a sniper scope: the HUD draws the scope, the viewmodel hides. */
  scope: boolean;
  paused: boolean;
  dragLook: boolean;
  ads: boolean;
  spread: number;
  flashlight: boolean;
  quality: Quality;
  feed: { key: number; text: string; at: number }[];
  /** Ids of downed teammates with how long they have left. */
  downed: { id: string; left: number }[];
}

const QUALITY_KEY = 'lastlight.quality.v1';
const SENS_KEY = 'lastlight.sens.v1';

export function loadQuality(): Quality {
  try {
    const q = localStorage.getItem(QUALITY_KEY);
    if (q === 'low' || q === 'medium' || q === 'high') return q;
  } catch {
    /* storage blocked */
  }
  return 'medium';
}

export function loadSensitivity(): number {
  try {
    const s = Number(localStorage.getItem(SENS_KEY));
    if (s > 0.1 && s < 5) return s;
  } catch {
    /* storage blocked */
  }
  return 1;
}

const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
};

const BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  fire: ['Mouse0'],
  ads: ['Mouse2', 'KeyQ'],
  use: ['KeyE'],
  wheel: ['WheelUp', 'WheelDown'],
};

const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const fromT = (t: Vec3Tuple): Vec3 => ({ x: t[0], y: t[1], z: t[2] });

interface ZombieView {
  id: number;
  inst: CharacterInstance;
  pos: THREE.Vector3;
  yaw: number;
  state: ZState;
  clip: string;
  gib: number;
  jogger: boolean;
  speed: number;
  seen: number;
  groanT: number;
  /** Hit reaction, 1 at the hit and fading; `flinchSide` leans it left or right. */
  flinch: number;
  flinchSide: number;
}

interface Corpse {
  inst: CharacterInstance;
  t: number;
  /** Knocked back by the killing blow, sliding to a stop. */
  vel: THREE.Vector3;
}

interface RemoteView {
  id: string;
  inst: CharacterInstance;
  gun: THREE.Object3D | null;
  gunId: WeaponId | null;
  label: THREE.Sprite;
  light: THREE.SpotLight;
  name: string;
  color: number;
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  life: LifeState;
  clip: string;
  reloading: boolean;
  stepT: number;
}

interface NadeView {
  id: number;
  body: NadeBody;
  mesh: THREE.Object3D;
}

type Sample = { a: ZSnapshot; b: ZSnapshot; alpha: number } | null;

/** Loading steps in the order the screen names them, with their share of the bar. */
const LOAD_STAGES = [
  { id: 'room', label: 'Waiting for the room', weight: 0.08 },
  { id: 'gear', label: 'Unpacking gear', weight: 0.4 },
  { id: 'build', label: 'Building the hotel', weight: 0.12 },
  { id: 'paint', label: 'Painting the walls', weight: 0.15 },
  { id: 'shaders', label: 'Warming up shaders', weight: 0.15 },
  { id: 'snap', label: 'Finding your squad', weight: 0.1 },
] as const;
type LoadStage = (typeof LOAD_STAGES)[number]['id'];

/** Every wait in the loading sequence gives up after this long: the game has fallbacks for anything missing. */
const LOAD_TIMEOUT = 20_000;
const within = (p: Promise<unknown>, ms = LOAD_TIMEOUT) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);

/** A camera pose for the key-art capture (play/tools/screenshots): eye position, yaw/pitch in radians, fov in degrees. */
export interface CinematicShot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  fov?: number;
}

/** Fixed-size pool of flashlight cones for other survivors (no shadows: too many). */
const REMOTE_LIGHTS = 9;

export class ZombiesClient implements GameClient {
  /**
   * Set to a pose to film the hotel from there: no viewmodel, own flashlight, HUD, bob or shake, and local input
   * leaves the camera alone. Back to null resumes normal play. Used by the screenshot tool via window.__zombies.
   */
  cinematic: CinematicShot | null = null;
  private wasCinematic = false;

  readonly hud = createStore<ZHudState>({
    ready: false,
    loading: { stage: LOAD_STAGES[0].label, done: 0 },
    mapName: '',
    wings: [],
    wave: 0,
    phase: 'break',
    left: 0,
    hp: ZB.maxHealth,
    armor: 0,
    points: ZB.startPoints,
    life: 0,
    bleed: 0,
    slots: [START_WEAPON, null],
    cur: 0,
    mag: WEAPONS[START_WEAPON].mag,
    res: WEAPONS[START_WEAPON].reserve,
    nades: 2,
    reloading: false,
    prompt: null,
    progress: null,
    popups: [],
    hitAt: 0,
    killAt: 0,
    headAt: 0,
    hurtYaw: 0,
    hurtAt: 0,
    deny: null,
    banner: null,
    scores: [],
    ended: null,
    scope: false,
    paused: false,
    dragLook: false,
    ads: false,
    spread: 0,
    flashlight: true,
    quality: loadQuality(),
    feed: [],
    downed: [],
  });

  private engine?: Engine;
  private input?: Input;
  private models?: Models;
  private audio?: ZAudio;
  private world?: World;
  private view?: WorldView;
  private pipe?: Pipeline;
  private fx?: Fx;
  private mapId: string | null = null;
  private built = false;
  private disposed = false;
  private paused = false;
  private readonly timeline = new SnapshotTimeline<ZSnapshot>();
  private latest: ZSnapshot | null = null;
  private meSnap: MeSnap | null = null;
  private pendingInit: Extract<ZombiesServerMsg, { k: 'init' }> | null = null;

  // Local player.
  private readonly me = {
    body: { pos: v3(), vel: v3(), onGround: true } as Body,
    yaw: 0,
    pitch: 0,
    seq: 0,
    pending: [] as ZInput[],
    life: 0 as LifeState,
    spawned: false,
  };
  private readonly outbox: ZInput[] = [];
  private acc = 0;
  /** Visual offset after a reconcile, eased away so corrections never snap the camera. */
  private readonly correction = new THREE.Vector3();

  // Weapon state (predicted on top of the server's).
  private slots: [WeaponId, WeaponId | null] = [START_WEAPON, null];
  private cur: 0 | 1 = 0;
  private mag: [number, number] = [WEAPONS[START_WEAPON].mag, 0];
  private res: [number, number] = [WEAPONS[START_WEAPON].reserve, 0];
  private nades = 2;
  private localChangeAt = -99;
  private nextFireAt = 0;
  private triggerWas = false;
  private reloadLeft = 0;
  private reloadTotal = 0;
  /** Cooldowns (seconds) for the knife and the grenade. */
  private knifeT = 0;
  private throwT = 0;
  /** Share of the current reload done, for its sounds. */
  private reloadCue = 0;
  /** Sounds scheduled a moment from now (pump, bolt). */
  private readonly later: { at: number; fn: () => void }[] = [];
  private landDip = 0;
  private landVel = 0;
  private bloom = 0;
  private adsK = 0;
  private flashOn = true;

  // Camera feel.
  private recoilPitch = 0;
  private recoilVel = 0;
  private recoilYaw = 0;
  private trauma = 0;
  private bobT = 0;
  private stepDist = 0;
  private hurtK = 0;
  private hitK = 0;
  private fov = 72;

  // Views.
  private readonly zombies = new Map<number, ZombieView>();
  private readonly corpses: Corpse[] = [];
  private readonly remotes = new Map<string, RemoteView>();
  private readonly nadeViews = new Map<number, NadeView>();
  private readonly remoteLights: THREE.SpotLight[] = [];
  private flashlight?: THREE.SpotLight;
  private vm?: Viewmodel;
  private lookX = 0;
  private lookY = 0;
  private fallSpeed = 0;
  private boards: number[] = [];
  private modelsReady = false;
  private popKey = 0;
  private tension = 0;
  private sensitivity = loadSensitivity();
  private readonly loadDone: Record<LoadStage, number> = { room: 0, gear: 0, build: 0, paint: 0, shaders: 0, snap: 0 };
  private builtSignal!: () => void;
  private readonly builtP = new Promise<void>((r) => (this.builtSignal = r));
  private snapSignal!: () => void;
  private readonly snapP = new Promise<void>((r) => (this.snapSignal = r));
  /** Characters spawned only to compile their shaders during loading. */
  private readonly warmed: CharacterInstance[] = [];

  constructor(private readonly ctx: ClientContext) {}

  // ---- lifecycle ------------------------------------------------------------------------------------------------

  mount(container: HTMLElement) {
    const engine = new Engine(container, { fov: this.fov, near: 0.03, far: 180 });
    this.engine = engine;
    engine.camera.rotation.order = 'YXZ';
    engine.scene.background = new THREE.Color(0x000000);
    engine.shadowHz = 30;
    engine.renderer.toneMapping = THREE.NoToneMapping;
    this.input = new Input(engine.renderer.domElement);
    this.input.bindings = BINDINGS;
    this.input.sensitivity = 0.0022 * this.sensitivity;
    this.audio = createZAudio();
    this.audio.unlock();
    this.models = createModels((n, total) => this.progress('gear', n / total));
    // Nothing moves until the loading screen is gone.
    this.input.enabled = false;
    engine.scene.add(engine.camera);
    this.buildLocal();
    if (this.pendingInit) this.applyInit(this.pendingInit);
    engine.start((dt, now) => this.frame(dt, now));
    if (import.meta.env.DEV) (window as unknown as { __zombies: ZombiesClient }).__zombies = this;
    void this.boot();
  }

  /** Marks loading step `stage` `v` (0..1) done and updates the screen's label (first unfinished step) and bar. */
  private progress(stage: LoadStage, v: number) {
    this.loadDone[stage] = Math.max(this.loadDone[stage], clamp(v, 0, 1));
    if (this.hud.get().ready) return;
    let done = 0;
    let label: string | null = null;
    for (const st of LOAD_STAGES) {
      done += st.weight * this.loadDone[st.id];
      if (label === null && this.loadDone[st.id] < 1) label = st.label;
    }
    this.hud.set({ loading: { stage: label ?? 'Ready', done: Math.min(0.99, done) } });
  }

  /**
   * The loading sequence. GLBs download while the room state arrives; then the textures sharpen, every shader the
   * match needs compiles (zombie and survivor included: they only show up later), and `ready` waits for a real frame
   * so the loading screen lifts onto a finished picture. Every wait times out rather than hang.
   */
  private async boot() {
    const gear = within(this.models!.ready).then(() => this.progress('gear', 1));
    await within(this.builtP, 60_000);
    await gear;
    if (this.disposed) return;
    this.progress('paint', 0.1);
    await within(texturesSettled());
    this.progress('paint', 1);
    if (this.disposed || !this.built) return this.finishLoading();
    await this.warmShaders();
    this.progress('shaders', 1);
    await within(this.snapP, 8000);
    this.progress('snap', 1);
    // Two animation frames: the engine's loop has drawn the finished scene at least once.
    await within(new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))), 1500);
    this.finishLoading();
  }

  private async warmShaders() {
    const engine = this.engine!;
    try {
      // One of each character, far below the camera, so their materials compile now rather than on first sight.
      for (const inst of [this.models!.zombie(0), this.models!.survivor(0xffffff)]) {
        inst.root.position.set(engine.camera.position.x, engine.camera.position.y - 50, engine.camera.position.z);
        engine.scene.add(inst.root);
        this.warmed.push(inst);
      }
    } catch {
      /* they compile on first sight instead */
    }
    this.progress('shaders', 0.2);
    // compileAsync lets the driver build programs in parallel (KHR_parallel_shader_compile) without freezing the page.
    await within(engine.renderer.compileAsync(engine.scene, engine.camera));
    for (const inst of this.warmed.splice(0)) inst.dispose();
  }

  private finishLoading() {
    if (this.disposed || this.hud.get().ready) return;
    if (this.input) this.input.enabled = !this.paused;
    this.hud.set({ ready: true, loading: null });
  }

  unmount() {
    this.disposed = true;
    document.body.classList.remove('ll-cinematic');
    for (const inst of this.warmed.splice(0)) inst.dispose();
    this.input?.dispose();
    this.audio?.dispose();
    this.fx?.dispose();
    this.pipe?.dispose();
    this.view?.dispose();
    for (const z of this.zombies.values()) z.inst.dispose();
    for (const c of this.corpses) c.inst.dispose();
    for (const r of this.remotes.values()) r.inst.dispose();
    this.engine?.dispose();
    if (import.meta.env.DEV) delete (window as unknown as { __zombies?: ZombiesClient }).__zombies;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (this.input) {
      this.input.enabled = !paused && this.hud.get().ready;
      if (paused) this.input.exitLock();
      this.input.clearOnce();
    }
    this.hud.set({ paused });
  }

  setQuality(q: Quality) {
    store(QUALITY_KEY, q);
    this.hud.set({ quality: q });
    this.view?.setQuality(q);
    this.pipe?.setQuality(q);
    this.engine?.setMaxPixelRatio(q === 'high' ? 1.5 : q === 'medium' ? 1.25 : 1);
  }

  setSensitivity(s: number) {
    this.sensitivity = s;
    store(SENS_KEY, String(s));
    if (this.input) this.input.sensitivity = 0.0022 * s;
  }

  get sens() {
    return this.sensitivity;
  }

  onRoom(room: RoomView) {
    for (const [id, r] of this.remotes) {
      const p = room.players.find((q) => q.id === id);
      if (!p || p.name !== r.name || p.color !== r.color) this.removeRemote(id);
    }
  }

  // ---- messages -------------------------------------------------------------------------------------------------

  onMessage(raw: GameServerMsg) {
    const m = raw as ZombiesServerMsg;
    switch (m.k) {
      case 'init':
        this.progress('room', 1);
        if (!this.engine) this.pendingInit = m;
        else this.applyInit(m);
        this.hud.set({
          scores: m.scores,
          wave: m.wave,
          mapName: m.map.name,
          wings: (zmapById(m.map.id)?.zones ?? []).map((z) => ({ name: z.name, open: m.zones.includes(z.id), minPlayers: z.minPlayers })),
        });
        return;
      case 'snap':
        this.onSnapshot(m.s);
        return;
      case 'ev':
        for (const e of m.e) this.onEvent(e);
        return;
      case 'score':
        this.hud.set({ scores: m.scores });
        return;
      case 'end':
        this.hud.set({ ended: { scores: m.scores, winner: m.winner, wave: m.wave }, scores: m.scores });
        this.audio?.play('gameOver');
        this.input?.exitLock();
        return;
    }
  }

  private applyInit(m: Extract<ZombiesServerMsg, { k: 'init' }>) {
    if (this.mapId !== m.map.id) {
      const def = zmapById(m.map.id);
      if (!def) return;
      this.mapId = m.map.id;
      this.world = buildWorld(def, m.zones);
      this.buildScene();
    }
    const w = this.world!;
    for (const i of m.down) {
      w.alive[i] = 0;
      this.view?.breakChunk(i);
    }
    for (let k = 0; k + 1 < m.dmg.length; k += 2) {
      w.hp[m.dmg[k]] = m.dmg[k + 1];
      this.view?.setChunkHp(m.dmg[k], m.dmg[k + 1]);
    }
    this.setBoards(m.boards, false);
  }

  private buildScene() {
    const engine = this.engine!;
    const world = this.world!;
    const q = this.hud.get().quality;
    this.view = createWorldView(engine.scene, world, this.models!, q);
    this.pipe = createPipeline(engine.renderer, engine.scene, engine.camera, world, this.view, q);
    this.fx = createFx(engine.scene, world, this.pipe!);
    if (this.audio) configureZAudio(this.audio, { floor: world.def.floor === 'marble' ? 'tile' : world.def.floor, interior: world.interior });
    // Thunder follows each lightning flash, louder for bigger bolts.
    (this.view as WorldView & { onLightning?: (s: number) => void }).onLightning = (strength) =>
      window.setTimeout(() => this.audio?.play('boom', { amount: strength * 0.45 }), 300 + Math.random() * 900);
    engine.renderHook = () => this.pipe?.render(this.frameParams());
    this.engine?.setMaxPixelRatio(q === 'high' ? 1.5 : q === 'medium' ? 1.25 : 1);
    this.built = true;
    this.progress('build', 1);
    this.builtSignal();
  }

  /** Flashlight and viewmodel: they live on the camera. */
  private buildLocal() {
    const cam = this.engine!.camera;
    const light = new THREE.SpotLight(0xfff1dc, 55, 34, 0.42, 0.55, 1.6);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.bias = -0.0004;
    light.shadow.camera.near = 0.2;
    light.position.set(0.22, -0.12, 0.05);
    light.target.position.set(0.05, -0.1, -6);
    // World only: right next to the gun it would blow the viewmodel out.
    light.layers.set(0);
    light.userData.worldOnly = true;
    cam.add(light, light.target);
    this.flashlight = light;
    for (let i = 0; i < REMOTE_LIGHTS; i++) {
      const l = new THREE.SpotLight(0xfff1dc, 0, 26, 0.42, 0.55, 1.6);
      l.userData.worldOnly = true;
      this.engine!.scene.add(l, l.target);
      this.remoteLights.push(l);
    }
    // A faint fill only the viewmodel sees, so the gun reads in the dark.
    const fill = new THREE.PointLight(0x9fb4d8, 0.6, 2, 2);
    fill.position.set(-0.3, 0.25, 0.2);
    fill.layers.set(VIEWMODEL_LAYER);
    cam.add(fill);
    this.vm = new Viewmodel(this.models!, cam);
    void this.models!.ready.then(() => {
      if (this.disposed) return;
      this.modelsReady = true;
      this.vm?.attach(this.slots[this.cur] ?? START_WEAPON);
    });
  }

  /** Puts `id` in the hands (with the lower/raise animation unless `instant`). */
  private equip(id: WeaponId, instant = false) {
    if (!this.modelsReady) return;
    this.vm?.equip(id, instant);
  }

  // ---- snapshots ------------------------------------------------------------------------------------------------

  private onSnapshot(s: ZSnapshot) {
    this.timeline.push(s, s.t / 1000);
    this.timeline.trim(1);
    this.latest = s;
    this.snapSignal();
    if (s.bd) this.setBoards(s.bd, false);
    const own = s.pl.find((p) => p.id === this.ctx.you);
    if (own && s.me) this.reconcile(own, s.me);
    const prevWave = this.hud.get().wave;
    this.hud.set({ wave: s.wave, phase: s.ph, left: s.left });
    if (s.wave !== prevWave && s.wave > 0) this.hud.set({ banner: { text: `Wave ${s.wave}`, sub: 'They are coming', at: performance.now() } });
    const downed: { id: string; left: number }[] = [];
    for (const p of s.pl) if (p.st === 1 && p.id !== this.ctx.you) downed.push({ id: p.id, left: 0 });
    this.hud.set({ downed });
  }

  private reconcile(own: ZPlayerSnap, me: MeSnap) {
    const wasLife = this.me.life;
    this.me.life = own.st;
    this.meSnap = me;
    const body = this.me.body;
    if (!this.me.spawned || own.st === 2 || wasLife === 2) {
      body.pos = fromT(own.p);
      body.vel = fromT(own.v);
      this.me.pending = [];
      if (!this.me.spawned) {
        this.me.yaw = own.y;
        this.me.spawned = true;
      }
    } else {
      const before = new THREE.Vector3(body.pos.x, body.pos.y, body.pos.z);
      body.pos = fromT(own.p);
      body.vel = fromT(own.v);
      body.onGround = Math.abs(own.v[1]) < 1e-3;
      this.me.pending = this.me.pending.filter((i) => i.seq > me.seq);
      if (this.world) for (const inp of this.me.pending) stepPlayer(body, inp, this.world, own.st === 1);
      const err = before.sub(new THREE.Vector3(body.pos.x, body.pos.y, body.pos.z));
      if (err.lengthSq() < 1) this.correction.add(err);
      else this.correction.set(0, 0, 0);
    }
    // Weapons: trust the server unless we changed something locally a moment ago (shots, reloads in flight).
    const fresh = performance.now() / 1000 - this.localChangeAt > 0.35 + this.ctx.socket.rtt / 1000;
    if (this.slots[0] !== me.sl[0] || this.slots[1] !== me.sl[1]) {
      this.slots = [me.sl[0], me.sl[1]];
      this.cur = me.cur;
      this.mag = [...me.mag];
      this.res = [...me.res];
    } else if (fresh) {
      this.cur = me.cur;
      this.mag = [...me.mag];
      this.res = [...me.res];
      if (me.rl <= 0 && this.reloadLeft > 0.15) this.reloadLeft = 0;
    }
    this.nades = me.nd;
    const id = this.slots[this.cur] ?? START_WEAPON;
    this.equip(id);
    this.hud.set({
      hp: me.hp,
      armor: me.ar,
      points: me.pts,
      life: own.st,
      bleed: me.bo ?? 0,
      slots: this.slots,
      cur: this.cur,
      mag: this.mag[this.cur],
      res: this.res[this.cur],
      nades: this.nades,
      progress: me.pr ?? null,
    });
  }

  private setBoards(bd: number[], fx: boolean) {
    for (let i = 0; i < bd.length; i++) {
      if (this.boards[i] === bd[i]) continue;
      if (fx && this.boards[i] !== undefined) this.fx?.board(i, bd[i] < this.boards[i]);
      this.boards[i] = bd[i];
      this.view?.setBoards(i, bd[i]);
    }
  }

  // ---- events ---------------------------------------------------------------------------------------------------

  private onEvent(e: ZEvent) {
    const you = this.ctx.you;
    const audio = this.audio;
    const fx = this.fx;
    const world = this.world;
    switch (e.k) {
      case 'shot': {
        if (e.id === you) return;
        const w = WEAPONS[e.w];
        const o = fromT(e.o);
        audio?.playAt('shot', o, { kind: w.kind, weapon: w.id });
        const r = this.remotes.get(e.id);
        if (r?.gun) {
          const muzzle = r.gun.getObjectByName(`${e.w}_muzzle`) ?? r.gun;
          fx?.muzzle(muzzle, w.kind, false);
          (fx as EffectsImpl | undefined)?.casing(muzzle, w.kind);
        }
        for (const end of e.e) {
          const to = v3(end[0], end[1], end[2]);
          fx?.tracer(o, to, w.kind);
          const mat = IMPACT_MATS[end[3]] ?? 'none';
          if (mat !== 'none' && mat !== 'flesh' && world) {
            const d = normalize(v3(to.x - o.x, to.y - o.y, to.z - o.z));
            const back = v3(to.x - d.x * 0.05, to.y - d.y * 0.05, to.z - d.z * 0.05);
            const hit = raycast(world, back, d, 0.2);
            fx?.impact(to, hit?.n ?? v3(-d.x, -d.y, -d.z), mat, hit?.chunk ?? -1);
          }
        }
        return;
      }
      case 'zhit': {
        const p = fromT(e.p);
        const hitZ = this.zombies.get(e.z);
        if (hitZ) this.flinch(hitZ, e.head ? 1 : 0.6);
        if (e.by === you) this.hud.set(e.head ? { hitAt: performance.now(), headAt: performance.now() } : { hitAt: performance.now() });
        else {
          fx?.blood(p, v3(0, 0.3, 0), e.head ? 1 : 0.6);
          audio?.playAt(e.head ? 'headshot' : 'flesh', p);
        }
        return;
      }
      case 'zdie':
        this.killZombie(e.z, e.gib, fromT(e.dir), e.how);
        if (e.by === you) this.hud.set({ killAt: performance.now() });
        return;
      case 'chunks': {
        if (!world) return;
        const at = fromT(e.at);
        for (const i of [...e.d, ...e.f]) {
          world.alive[i] = 0;
          this.view?.breakChunk(i);
          fx?.chunkBroken(i);
        }
        fx?.debris(e.d, at, !!e.x);
        if (e.f.length) fx?.debris(e.f, at, false);
        const c = world.chunks[e.d[0] ?? e.f[0]];
        if (c) audio?.playAt('crumble', v3((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2), { amount: Math.min(1, (e.d.length + e.f.length) / 12) });
        return;
      }
      case 'chp':
        if (!world) return;
        for (let k = 0; k + 1 < e.c.length; k += 2) {
          world.hp[e.c[k]] = e.c[k + 1];
          this.view?.setChunkHp(e.c[k], e.c[k + 1]);
        }
        return;
      case 'board': {
        const old = this.boards[e.w];
        this.boards[e.w] = e.n;
        this.view?.setBoards(e.w, e.n);
        if (old !== undefined && old !== e.n) fx?.board(e.w, e.a === 'tear');
        const win = world?.windows[e.w];
        if (win) audio?.playAt(e.a === 'tear' ? 'tear' : 'hammer', v3(win.center.x, 1.6, win.center.z));
        return;
      }
      case 'nade': {
        const mesh = this.models?.prop('nade') ?? new THREE.Mesh(new THREE.SphereGeometry(0.05), new THREE.MeshStandardMaterial({ color: 0x3a4030 }));
        this.engine?.scene.add(mesh);
        this.nadeViews.set(e.id, { id: e.id, body: { pos: fromT(e.o), vel: fromT(e.v) }, mesh });
        audio?.playAt('throw', fromT(e.o));
        return;
      }
      case 'boom': {
        const p = fromT(e.p);
        const n = this.nadeViews.get(e.id);
        if (n) {
          n.mesh.removeFromParent();
          this.nadeViews.delete(e.id);
        }
        fx?.explosion(p);
        audio?.playAt('boom', p);
        const d = Math.hypot(p.x - this.me.body.pos.x, p.z - this.me.body.pos.z);
        this.trauma = Math.min(1, this.trauma + Math.max(0, 1 - d / 14));
        return;
      }
      case 'phurt':
        if (e.id === you) {
          const from = fromT(e.from);
          const ang = Math.atan2(-(from.x - this.me.body.pos.x), -(from.z - this.me.body.pos.z)) - this.me.yaw;
          this.hud.set({ hurtYaw: ang, hurtAt: performance.now() });
          this.hitK = 1;
          this.trauma = Math.min(1, this.trauma + 0.35);
          audio?.play('hurt', { amount: Math.min(1, e.dmg / 40) });
        }
        return;
      case 'pdown':
        if (e.id === you) audio?.play('down');
        this.feed(`${this.name(e.id)} is down!`);
        return;
      case 'previve':
        if (e.id === you || e.by === you) audio?.play('revive');
        this.feed(`${this.name(e.by)} revived ${this.name(e.id)}`);
        return;
      case 'pdead':
        this.feed(`${this.name(e.id)} bled out`);
        return;
      case 'pspawn':
        if (e.id === you) {
          this.me.body.pos = fromT(e.p);
          this.me.pending = [];
        }
        return;
      case 'wave':
        audio?.play('waveStart');
        this.hud.set({ banner: { text: `Wave ${e.n}`, sub: `${e.count} of them`, at: performance.now() } });
        return;
      case 'clear':
        audio?.play('waveEnd');
        this.hud.set({ banner: { text: `Wave ${e.n} survived`, sub: `Next wave in ${ZB.waveBreak} seconds`, at: performance.now() } });
        return;
      case 'buy':
        if (e.id === you) {
          audio?.play('buy');
          this.feed(`Bought ${e.what} (${e.cost})`);
        }
        return;
      case 'deny':
        if (e.id === you) {
          audio?.play('deny');
          this.hud.set({ deny: { text: e.why, at: performance.now() } });
        }
        return;
      case 'pts':
        if (e.id === you) {
          const popups = this.hud.get().popups.filter((p) => performance.now() - p.at < 1200).slice(-6);
          popups.push({ key: ++this.popKey, n: e.n, why: e.why, at: performance.now() });
          this.hud.set({ popups });
          audio?.play('points');
        }
        return;
      case 'zatk': {
        const z = this.zombies.get(e.z);
        if (z) audio?.playAt(Math.random() < 0.3 ? 'scream' : 'swipe', { x: z.pos.x, y: 1.5, z: z.pos.z }, { id: e.z });
        return;
      }
      case 'melee':
        if (e.id !== you) {
          const r = this.remotes.get(e.id);
          if (r) audio?.playAt('knife', { x: r.pos.x, y: 1.3, z: r.pos.z });
        }
        return;
    }
  }

  private name(id: string) {
    return this.ctx.room().players.find((p) => p.id === id)?.name ?? 'Someone';
  }

  private feed(text: string) {
    const feed = this.hud.get().feed.filter((f) => performance.now() - f.at < 6000).slice(-4);
    feed.push({ key: ++this.popKey, text, at: performance.now() });
    this.hud.set({ feed });
  }

  // ---- frame ----------------------------------------------------------------------------------------------------

  private frame(rawDt: number, now: number) {
    const input = this.input;
    if (!input || !this.built) return;
    // The first frame after start can report a negative step (rAF time before the engine's clock).
    const dt = clamp(rawDt, 0, 0.1);
    this.hud.set({ dragLook: input.dragLook });
    const cine = !!this.cinematic;
    if (cine !== this.wasCinematic) {
      this.wasCinematic = cine;
      document.body.classList.toggle('ll-cinematic', cine);
      if (cine) input.exitLock();
    }
    // Look.
    this.lookX = 0;
    this.lookY = 0;
    if (!this.paused && !cine) {
      const look = input.look();
      const adsScale = this.adsK > 0.5 ? WEAPONS[this.slots[this.cur] ?? START_WEAPON].zoom : 1;
      this.lookX = -look.dx * adsScale;
      this.lookY = -look.dy * adsScale;
      this.me.yaw += this.lookX;
      this.me.pitch = clamp(this.me.pitch + this.lookY, -ZB.maxPitch, ZB.maxPitch);
    }
    const clock = performance.now() / 1000;
    for (let i = this.later.length - 1; i >= 0; i--)
      if (clock >= this.later[i].at) {
        this.later[i].fn();
        this.later.splice(i, 1);
      }
    this.knifeT = Math.max(0, this.knifeT - dt);
    this.throwT = Math.max(0, this.throwT - dt);
    this.handleActions();
    // Fixed-step commands.
    this.acc += dt;
    let n = 0;
    while (this.acc >= ZB.dt && n < 8) {
      this.acc -= ZB.dt;
      n++;
      this.tickInput();
    }
    if (this.acc > ZB.dt) this.acc = 0;
    if (this.outbox.length) {
      this.ctx.socket.send({ t: 'g', m: { k: 'in', i: this.outbox.splice(0) } });
    }
    this.handleFire(dt);
    const sample = this.timeline.sample(performance.now() / 1000);
    this.updateZombies(sample, dt, now);
    this.updateRemotes(sample, dt);
    this.updateCorpses(dt);
    this.updateCamera(dt, now);
    this.updateViewmodel(dt);
    const held = this.slots[this.cur] ?? START_WEAPON;
    const scope = WEAPONS[held].kind === 'sniper' && this.adsK > 0.88 && this.me.life === 0;
    if (scope !== this.hud.get().scope) this.hud.set({ scope });
    this.updatePrompt();
    this.view?.update(dt, now);
    this.fx?.update(dt, this.engine!.camera);
    // Audio: ears, tension, health.
    const cam = this.engine!.camera;
    this.audio?.listen(cam.position, this.me.yaw, this.me.pitch);
    const want = this.latest?.ph === 'wave' ? Math.min(1, 0.4 + this.zombies.size / 16) : 0.15;
    this.tension = damp(this.tension, want, 0.5, dt);
    this.audio?.setTension(this.tension);
    const hp = this.hud.get().hp;
    this.hurtK = damp(this.hurtK, this.me.life === 1 ? 1 : clamp(1 - hp / 70, 0, 1), 3, dt);
    this.hitK = Math.max(0, this.hitK - dt * 2.5);
    this.audio?.setHurt(this.hurtK, this.me.life === 1);
    input.clearOnce();
  }

  private frameParams() {
    const flashlights: Flashlight[] = [];
    const dir = new THREE.Vector3();
    if (this.flashlight) {
      const lp = this.flashlight.getWorldPosition(new THREE.Vector3());
      this.flashlight.target.getWorldPosition(dir).sub(lp).normalize();
      flashlights.push({ pos: lp, dir: dir.clone(), on: this.flashOn && this.me.life !== 2 && !this.cinematic ? 1 : 0 });
    }
    for (const r of this.remotes.values()) {
      if (r.life === 2) continue;
      const f = r.light.getWorldPosition(new THREE.Vector3());
      const d = r.light.target.getWorldPosition(new THREE.Vector3()).sub(f).normalize();
      flashlights.push({ pos: f, dir: d, on: 1 });
    }
    return {
      time: performance.now() / 1000,
      dt: 1 / Math.max(10, this.engine!.fps),
      hurt: this.hurtK,
      hit: this.hitK,
      downed: this.me.life === 1,
      flashlights,
      flashes: this.fx?.flashes() ?? [],
    };
  }

  private canAct() {
    const h = this.hud.get();
    return !this.paused && !this.cinematic && h.ready && this.me.life !== 2 && !h.ended;
  }

  /** Reload, switch, knife, grenade, flashlight. */
  private handleActions() {
    const input = this.input!;
    if (!this.canAct()) return;
    if (input.once('KeyR')) this.startReload();
    const other: 0 | 1 = this.cur === 0 ? 1 : 0;
    if (input.once('Digit1') && this.cur !== 0) this.switchTo(0);
    if (input.once('Digit2') && this.cur !== 1 && this.slots[1]) this.switchTo(1);
    if ((input.once('KeyX') || this.wheelOnce()) && this.slots[other]) this.switchTo(other);
    if ((input.once('KeyF') && !input.dragLook) || input.once('KeyL')) {
      this.flashOn = !this.flashOn;
      this.hud.set({ flashlight: this.flashOn });
      this.audio?.play('empty');
    }
    if (input.once('KeyV') && this.me.life === 0 && this.knifeT <= 0) {
      this.knifeT = 0.6;
      this.cancelReload();
      this.vm?.knife();
      const eye = this.eye();
      const d = this.lookDir();
      this.ctx.socket.send({ t: 'g', m: { k: 'knife', o: tuple(eye), d: tuple(d), rt: this.renderTimeMs() } });
      this.audio?.play('knife');
    }
    if (input.once('KeyG') && this.me.life === 0 && this.nades > 0 && this.throwT <= 0) {
      this.throwT = 0.8;
      this.cancelReload();
      this.vm?.throwNade();
      const eye = this.eye();
      const d = this.lookDir();
      const vel = v3(d.x * ZB.nadeSpeed + this.me.body.vel.x, d.y * ZB.nadeSpeed + 2.5 + this.me.body.vel.y * 0.5, d.z * ZB.nadeSpeed + this.me.body.vel.z);
      const o = v3(eye.x + d.x * 0.4, eye.y + d.y * 0.4 - 0.1, eye.z + d.z * 0.4);
      this.ctx.socket.send({ t: 'g', m: { k: 'throw', o: tuple(o), v: tuple(vel) } });
      this.nades--;
      this.hud.set({ nades: this.nades });
    }
  }

  /** A wheel notch reads as held for one poll. */
  private wheelOnce() {
    return this.input!.held('wheel');
  }

  private switchTo(s: 0 | 1) {
    if (!this.slots[s]) return;
    this.cur = s;
    this.reloadLeft = 0;
    this.localChangeAt = performance.now() / 1000;
    this.ctx.socket.send({ t: 'g', m: { k: 'slot', s } });
    this.equip(this.slots[s]!);
    this.vm?.cancelReload();
    this.nextFireAt = performance.now() / 1000 + 0.42;
    this.audio?.play('reloadIn', { amount: 0.4 });
    this.hud.set({ cur: s, mag: this.mag[s], res: this.res[s] });
  }

  private startReload() {
    const id = this.slots[this.cur];
    if (!id || this.reloadLeft > 0) return;
    const w = WEAPONS[id];
    const missing = w.mag - this.mag[this.cur];
    if (missing <= 0 || this.res[this.cur] <= 0) return;
    const shells = Math.min(missing, this.res[this.cur]);
    this.reloadTotal = this.reloadLeft = w.perShell ? (w.reload / w.mag) * shells + 0.3 : w.reload;
    this.reloadCue = 0;
    this.vm?.reload(this.reloadTotal, shells);
    this.localChangeAt = performance.now() / 1000;
    this.ctx.socket.send({ t: 'g', m: { k: 'reload' } });
    this.audio?.play('reloadOut');
    this.hud.set({ reloading: true });
  }

  /** Knife and grenade interrupt a reload (the server does the same: a new reload starts over). */
  private cancelReload() {
    if (this.reloadLeft <= 0) return;
    this.reloadLeft = 0;
    this.vm?.cancelReload();
    this.hud.set({ reloading: false });
  }

  private soon(seconds: number, fn: () => void) {
    this.later.push({ at: performance.now() / 1000 + seconds, fn });
  }

  private tickInput() {
    const input = this.input!;
    const me = this.me;
    const act = this.canAct();
    const inp: ZInput = {
      seq: ++me.seq,
      f: act ? input.actionAxis('back', 'forward') : 0,
      s: act ? input.actionAxis('left', 'right') : 0,
      jump: act && input.held('jump'),
      sprint: act && input.held('sprint') && this.reloadLeft <= 0,
      ads: act && input.held('ads') && this.reloadLeft <= 0 && this.me.life === 0,
      use: act && input.held('use'),
      yaw: Math.round(me.yaw * 1e4) / 1e4,
      pitch: Math.round(me.pitch * 1e4) / 1e4,
    };
    if (this.world && me.life !== 2) {
      const wasGround = me.body.onGround;
      const before = { x: me.body.pos.x, z: me.body.pos.z };
      const fall = -me.body.vel.y;
      stepPlayer(me.body, inp, this.world, me.life === 1);
      if (!wasGround && me.body.onGround && fall > 2) {
        this.vm?.landed(fall);
        this.landVel -= Math.min(1.2, fall * 0.12);
      }
      const moved = Math.hypot(me.body.pos.x - before.x, me.body.pos.z - before.z);
      if (me.body.onGround) this.stepDist += moved;
      const stride = inp.sprint ? 1.25 : 0.95;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        this.audio?.play('step', { amount: inp.sprint ? 0.8 : 0.45 });
      }
      if (!wasGround && me.body.onGround && fall > 2) this.audio?.play('step', { amount: Math.min(1, 0.5 + fall / 10) });
      this.bobT += moved * (inp.sprint ? 1.6 : 2.1);
    }
    me.pending.push(inp);
    if (me.pending.length > 240) me.pending.splice(0, me.pending.length - 240);
    this.outbox.push(inp);
    this.hud.set({ ads: inp.ads });
    // Grenades in flight (cosmetic; the server decides where they blow).
    for (const n of this.nadeViews.values()) {
      if (this.world && stepNade(n.body, this.world)) this.audio?.playAt('clink', n.body.pos);
      n.mesh.position.set(n.body.pos.x, n.body.pos.y, n.body.pos.z);
      n.mesh.rotation.x += 0.2;
    }
  }

  private eye(): Vec3 {
    const p = this.me.body.pos;
    return v3(p.x, p.y + eyeHeight(this.me.life === 1), p.z);
  }

  private lookDir(yaw = this.me.yaw, pitch = this.me.pitch): Vec3 {
    const c = Math.cos(pitch);
    return v3(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c);
  }

  private renderTimeMs() {
    const t = this.timeline.renderTime;
    return Number.isFinite(t) ? Math.round(t * 1000) : this.ctx.socket.serverNow();
  }

  // ---- shooting -------------------------------------------------------------------------------------------------

  private handleFire(dt: number) {
    const input = this.input!;
    const t = performance.now() / 1000;
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      const id = this.slots[this.cur]!;
      const w = WEAPONS[id];
      // Sounds on the animation's beats (viewmodel.ts): mag in, charge; or a click per shell, then the pump.
      const before = this.reloadCue;
      const k = 1 - Math.max(0, this.reloadLeft) / this.reloadTotal;
      this.reloadCue = k;
      const crossed = (at: number) => before < at && k >= at;
      if (w.perShell) {
        const shells = Math.max(1, Math.round((this.reloadTotal - 0.3) / (w.reload / w.mag)));
        for (let i = 0; i < shells; i++) if (crossed(0.1 + ((i + 0.6) / shells) * 0.74)) this.audio?.play('reloadIn', { amount: 0.5 });
        if (crossed(0.88)) this.audio?.play('pump');
      } else {
        if (crossed(0.62)) this.audio?.play('reloadIn');
        if (crossed(0.84)) this.audio?.play(w.kind === 'pistol' ? 'reloadOut' : 'bolt', { amount: 0.6 });
      }
      if (this.reloadLeft <= 0) {
        this.reloadLeft = 0;
        const take = Math.min(w.mag - this.mag[this.cur], this.res[this.cur]);
        this.mag[this.cur] += take;
        this.res[this.cur] -= take;
        this.localChangeAt = t;
        this.vm?.setEmpty(false);
        this.hud.set({ reloading: false, mag: this.mag[this.cur], res: this.res[this.cur] });
      }
    }
    const trigger = this.canAct() && input.fire();
    const pressed = trigger && !this.triggerWas;
    this.triggerWas = trigger;
    const id = this.slots[this.cur] ?? START_WEAPON;
    const w = WEAPONS[id];
    this.bloom = Math.max(0, this.bloom - (1 / 60) * 2.5);
    const moving = Math.hypot(this.me.body.vel.x, this.me.body.vel.z);
    const base = this.adsK > 0.6 ? w.ads : w.hip;
    const spread = base * (1 + moving / (this.adsK > 0.6 ? 12 : 4)) * (this.me.body.onGround ? 1 : 2) + this.bloom * (this.adsK > 0.6 ? 0.3 : 1);
    this.hud.set({ spread });
    if (!trigger || this.reloadLeft > 0 || this.vm?.busy || t < this.nextFireAt) return;
    if (!w.auto && !pressed) return;
    if (this.mag[this.cur] <= 0) {
      if (pressed) this.audio?.play('empty');
      if (this.res[this.cur] > 0) this.startReload();
      return;
    }
    this.nextFireAt = t + fireInterval(w);
    this.mag[this.cur]--;
    this.localChangeAt = t;
    this.hud.set({ mag: this.mag[this.cur] });
    const eye = this.eye();
    const dirs: Vec3[] = [];
    for (let i = 0; i < w.pellets; i++) {
      // Uniform in a cone, a little denser in the middle.
      const r = spread * Math.sqrt(Math.random()) * (w.pellets > 1 ? 1 : 0.8);
      const a = Math.random() * Math.PI * 2;
      dirs.push(this.lookDir(this.me.yaw + Math.cos(a) * r, this.me.pitch + Math.sin(a) * r));
    }
    this.ctx.socket.send({ t: 'g', m: { k: 'fire', w: id, o: tuple(eye), d: dirs.map(tuple), rt: this.renderTimeMs() } });
    // Local feedback straight away: sound, flash, recoil, impacts where the bullets will land.
    this.audio?.play('shot', { kind: w.kind, weapon: id });
    const muzzle = this.vm?.muzzle;
    if (muzzle) {
      this.fx?.muzzle(muzzle, w.kind, true);
      (this.fx as EffectsImpl | undefined)?.casing(muzzle, w.kind);
    }
    this.vm?.fire();
    if (this.mag[this.cur] === 0) this.vm?.setEmpty(w.kind === 'pistol');
    if (id === 'trench') this.soon(0.2, () => this.audio?.play('pump'));
    if (id === 'kar98k') this.soon(0.25, () => this.audio?.play('bolt'));
    const ads = this.adsK > 0.6;
    // Aim kick: part stays (the climb you pull down), part is a visual punch that springs back. Automatic guns climb
    // steadily with a little sideways wander; pistols snap; shotguns and snipers punch hard.
    const kick = w.kick * (ads ? 0.6 : 1) * (0.85 + Math.random() * 0.3);
    const keep = w.auto ? 0.6 : w.kind === 'pistol' ? 0.35 : 0.45;
    this.me.pitch = clamp(this.me.pitch + kick * keep, -ZB.maxPitch, ZB.maxPitch);
    this.me.yaw += (Math.random() - (w.auto ? 0.45 : 0.5)) * kick * (w.auto ? 0.7 : 0.4);
    this.recoilVel += kick * (w.kind === 'shotgun' || w.kind === 'sniper' ? 30 : 22);
    this.recoilYaw += (Math.random() - 0.5) * kick * 0.8;
    this.bloom = Math.min(w.hip * 1.5, this.bloom + w.kick * 0.5);
    this.trauma = Math.min(1, this.trauma + (w.kind === 'shotgun' || w.kind === 'sniper' ? 0.18 : 0.04));
    const muzzleWorld = muzzle ? muzzle.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(eye.x, eye.y, eye.z);
    for (const d of dirs) {
      const end = this.traceLocal(eye, d);
      if (Math.random() < (w.kind === 'lmg' || w.kind === 'rifle' ? 0.5 : 0.25)) this.fx?.tracer(muzzleWorld, end.p, w.kind);
      if (end.zombie) {
        this.flinch(end.zombie, end.head ? 1 : 0.55);
        this.fx?.blood(end.p, d, w.damage > 100 ? 1 : 0.5);
        this.audio?.playAt(end.head ? 'headshot' : 'flesh', end.p);
      } else if (end.n && end.mat) {
        this.fx?.impact(end.p, end.n, end.mat, end.chunk);
        if (Math.random() < 0.4) this.audio?.playAt('impact', end.p);
      }
    }
  }

  /** Where a bullet from the eye lands right now: world or a rendered zombie (approximate hitboxes). */
  private traceLocal(o: Vec3, d: Vec3) {
    const hit = this.world ? raycast(this.world, o, d, 140) : null;
    let best = hit ? hit.t : 140;
    let zombie: ZombieView | null = null;
    let head = false;
    for (const z of this.zombies.values()) {
      if (z.state === ZState.Rise) continue;
      const f = yawForward(z.yaw);
      const th = sphereT(o, d, z.pos.x + f.x * 0.14, z.pos.y + ZB.zombieHeadY, z.pos.z + f.z * 0.14, ZB.zombieHeadR);
      if (th >= 0 && th < best && !(z.gib & GIB.head)) {
        best = th;
        zombie = z;
        head = true;
      }
      const tb = cylinderT(o, d, z.pos.x, z.pos.z, z.pos.y, z.pos.y + ZB.zombieBodyH, ZB.zombieBodyR, best);
      if (tb >= 0 && tb < best) {
        best = tb;
        zombie = z;
        head = false;
      }
    }
    const p = v3(o.x + d.x * best, o.y + d.y * best, o.z + d.z * best);
    if (zombie) return { p, zombie, head, n: null, mat: null, chunk: -1 };
    return { p, zombie: null, head: false, n: hit?.n ?? null, mat: hit?.mat ?? null, chunk: hit?.chunk ?? -1 };
  }

  // ---- zombies --------------------------------------------------------------------------------------------------

  private updateZombies(sample: Sample, dt: number, now: number) {
    if (!sample || !this.models || !this.modelsReady) return;
    const { a, b, alpha } = sample;
    const byId = new Map<number, ZombieSnap>();
    for (const z of a.zb) byId.set(z.id, z);
    const seen = new Set<number>();
    for (const zb of b.zb) {
      const za = byId.get(zb.id) ?? zb;
      seen.add(zb.id);
      let view = this.zombies.get(zb.id);
      if (!view) {
        view = this.spawnZombieView(zb);
        if (!view) continue;
      }
      const k = clamp(alpha, 0, 1.5);
      const x = za.p[0] + (zb.p[0] - za.p[0]) * k;
      const y = za.p[1] + (zb.p[1] - za.p[1]) * k;
      const z = za.p[2] + (zb.p[2] - za.p[2]) * k;
      const moved = Math.hypot(x - view.pos.x, z - view.pos.z);
      view.speed = damp(view.speed, moved / Math.max(dt, 1e-3), 6, dt);
      view.pos.set(x, y, z);
      view.yaw = lerpAngle(za.y, zb.y, clamp(k, 0, 1));
      view.seen = now;
      if (zb.g !== view.gib) this.applyGib(view, zb.g);
      this.animateZombie(view, zb, dt);
      // Groans.
      view.groanT -= dt;
      if (view.groanT <= 0) {
        view.groanT = 2.5 + Math.random() * 6;
        this.audio?.playAt('groan', { x, y: 1.5, z }, { id: view.id, amount: view.jogger ? 0.8 : 0.5 });
      }
    }
    for (const [id, view] of this.zombies) {
      if (!seen.has(id) && now - view.seen > 0.5) {
        view.inst.root.removeFromParent();
        view.inst.dispose();
        this.zombies.delete(id);
      }
    }
  }

  private spawnZombieView(zb: ZombieSnap): ZombieView | undefined {
    const inst = this.models!.zombie(zb.v);
    inst.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    this.engine!.scene.add(inst.root);
    const view: ZombieView = {
      id: zb.id,
      inst,
      pos: new THREE.Vector3(zb.p[0], zb.p[1], zb.p[2]),
      yaw: zb.y,
      state: zb.s,
      clip: '',
      gib: 0,
      jogger: zb.j === 1,
      speed: 0,
      seen: 0,
      groanT: Math.random() * 3,
      flinch: 0,
      flinchSide: 0,
    };
    if (zb.s === ZState.Rise) {
      this.fx?.rise(v3(zb.p[0], 0, zb.p[2]));
      this.audio?.playAt('scream', v3(zb.p[0], 0.5, zb.p[2]), { id: zb.id, amount: 0.4 });
    }
    this.zombies.set(zb.id, view);
    return view;
  }

  private play(inst: CharacterInstance, name: string, current: string, opts: { once?: boolean; fade?: number; restart?: boolean } = {}) {
    const next = inst.actions[name];
    if (!next) return current;
    if (name === current && !opts.restart) return current;
    const prev = inst.actions[current];
    next.reset();
    next.setLoop(opts.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = !!opts.once;
    next.enabled = true;
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, opts.fade ?? 0.25, false);
    return name;
  }

  private animateZombie(z: ZombieView, s: ZombieSnap, dt: number) {
    const inst = z.inst;
    const legless = (s.g & (GIB.legL | GIB.legR)) !== 0;
    const enter = s.s !== z.state;
    z.state = s.s;
    let yOff = 0;
    switch (s.s) {
      case ZState.Rise:
        z.clip = this.play(inst, 'rise', z.clip, { once: true, fade: 0.05 });
        yOff = -1.5 * Math.pow(1 - s.a, 2);
        break;
      case ZState.Walk: {
        const clip = legless ? 'crawl' : z.jogger ? 'jog' : 'walk';
        z.clip = this.play(inst, clip, z.clip, { fade: 0.35 });
        const act = inst.actions[clip];
        if (act) act.timeScale = clamp(z.speed / (z.jogger ? 2.1 : legless ? 0.4 : 0.95), 0.35, 1.8);
        break;
      }
      case ZState.Tear:
        z.clip = this.play(inst, 'tear', z.clip, { fade: 0.3 });
        break;
      case ZState.Bash:
        z.clip = this.play(inst, 'attack', z.clip, { fade: 0.2 });
        break;
      case ZState.Vault:
        z.clip = this.play(inst, 'vault', z.clip, { once: true, fade: 0.15, restart: enter });
        break;
      case ZState.Attack:
        z.clip = this.play(inst, 'attack', z.clip, { once: true, fade: 0.12, restart: enter });
        break;
    }
    inst.root.position.set(z.pos.x, z.pos.y + yOff, z.pos.z);
    inst.root.rotation.y = z.yaw;
    unpose(inst);
    inst.mixer.update(dt);
    // Hit reaction on top of whatever the clip says: the torso snaps back, the head whips.
    if (z.flinch > 0.01) {
      const f = z.flinch * z.flinch;
      pose(inst, 'spine', -0.22 * f, 0);
      pose(inst, 'chest', -0.3 * f, 0.18 * f * z.flinchSide);
      pose(inst, 'head', -0.45 * f, 0);
      z.flinch = Math.max(0, z.flinch - dt * 4.5);
    }
  }

  private flinch(z: ZombieView, amount: number) {
    z.flinch = Math.min(1, Math.max(z.flinch, amount));
    z.flinchSide = Math.random() < 0.5 ? -1 : 1;
  }

  private applyGib(z: ZombieView, mask: number) {
    const parts = z.inst.parts;
    const added = mask & ~z.gib;
    z.gib = mask;
    if (!parts || !added) return;
    const f = yawForward(z.yaw);
    const r = yawRight(z.yaw);
    const spot = (side: number, h: number) => v3(z.pos.x + r.x * side, z.pos.y + h, z.pos.z + r.z * side);
    const list: [number, THREE.Object3D, Vec3][] = [
      [GIB.head, parts.head, spot(0, 1.6)],
      [GIB.armL, parts.armL, spot(-0.25, 1.3)],
      [GIB.armR, parts.armR, spot(0.25, 1.3)],
      [GIB.legL, parts.legL, spot(-0.12, 0.5)],
      [GIB.legR, parts.legR, spot(0.12, 0.5)],
    ];
    for (const [bit, obj, p] of list) {
      if (!(added & bit)) continue;
      obj.visible = false;
      this.fx?.gib(p, v3(-f.x + (Math.random() - 0.5), 0.8, -f.z + (Math.random() - 0.5)));
      this.fx?.blood(p, v3(0, 0.5, 0), 1);
    }
  }

  private killZombie(id: number, gib: number, dir: Vec3, how: string) {
    const z = this.zombies.get(id);
    if (!z) return;
    this.zombies.delete(id);
    this.applyGib(z, gib);
    const f = yawForward(z.yaw);
    // Shot from the front falls backwards.
    const back = f.x * dir.x + f.z * dir.z < 0;
    z.clip = this.play(z.inst, back ? 'death_back' : 'death_fwd', z.clip, { once: true, fade: 0.1, restart: true });
    this.fx?.blood(v3(z.pos.x, 1.2, z.pos.z), dir, how === 'nade' ? 1.5 : 0.8);
    (this.fx as EffectsImpl | undefined)?.corpse(v3(z.pos.x, 0, z.pos.z), dir);
    this.audio?.playAt(Math.random() < 0.5 ? 'flesh' : 'groan', { x: z.pos.x, y: 1.2, z: z.pos.z }, { id, amount: 0.3 });
    z.inst.root.position.y = Math.max(0, z.pos.y);
    // The killing blow carries the body a little way; a grenade throws it.
    const push = how === 'nade' ? 3.2 : how === 'knife' ? 0.6 : 1.1;
    const dl = Math.hypot(dir.x, dir.z) || 1;
    const act = z.inst.actions[z.clip];
    if (act) act.timeScale = 0.9 + Math.random() * 0.35;
    this.corpses.push({ inst: z.inst, t: 0, vel: new THREE.Vector3((dir.x / dl) * push, 0, (dir.z / dl) * push) });
    if (this.corpses.length > 24) {
      const old = this.corpses.shift()!;
      old.inst.root.removeFromParent();
      old.inst.dispose();
    }
  }

  private updateCorpses(dt: number) {
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      if (c.t < 2) c.inst.mixer.update(dt);
      if (c.vel.lengthSq() > 1e-4) {
        // Slide with friction, and never into a wall.
        const p = c.inst.root.position;
        const nx = p.x + c.vel.x * dt;
        const nz = p.z + c.vel.z * dt;
        const clear = !this.world || !raycast(this.world, v3(p.x, 0.4, p.z), normalize(v3(c.vel.x, 0, c.vel.z)), Math.hypot(nx - p.x, nz - p.z) + 0.3);
        if (clear) p.set(nx, p.y, nz);
        else c.vel.set(0, 0, 0);
        c.vel.multiplyScalar(Math.exp(-dt * 5));
      }
      // Bodies sink into the floor after a while.
      if (c.t > 14) c.inst.root.position.y -= dt * 0.25;
      if (c.t > 18) {
        c.inst.root.removeFromParent();
        c.inst.dispose();
        this.corpses.splice(i, 1);
      }
    }
  }

  // ---- other survivors ------------------------------------------------------------------------------------------

  private remote(id: string): RemoteView | null {
    const existing = this.remotes.get(id);
    if (existing) return existing;
    const info = this.ctx.room().players.find((p) => p.id === id);
    if (!info || !this.models || !this.modelsReady) return null;
    const inst = this.models.survivor(info.color);
    inst.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    const label = makeLabel(info.name, colorHex(info.color));
    label.position.set(0, 2.05, 0);
    label.scale.multiplyScalar(0.42);
    inst.root.add(label);
    this.engine!.scene.add(inst.root);
    const light = this.remoteLights[this.remotes.size % REMOTE_LIGHTS];
    const r: RemoteView = {
      id,
      inst,
      gun: null,
      gunId: null,
      label,
      light,
      name: info.name,
      color: info.color,
      pos: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
      life: 0,
      clip: '',
      reloading: false,
      stepT: 0,
    };
    this.remotes.set(id, r);
    return r;
  }

  private removeRemote(id: string) {
    const r = this.remotes.get(id);
    if (!r) return;
    r.inst.root.removeFromParent();
    r.inst.dispose();
    r.light.intensity = 0;
    this.remotes.delete(id);
  }

  private updateRemotes(sample: Sample, dt: number) {
    if (!sample) return;
    const { a, b, alpha } = sample;
    const seen = new Set<string>();
    for (const pb of b.pl) {
      if (pb.id === this.ctx.you) continue;
      const pa = a.pl.find((p) => p.id === pb.id) ?? pb;
      const r = this.remote(pb.id);
      if (!r) continue;
      seen.add(pb.id);
      const k = clamp(alpha, 0, 1.2);
      const nx = pa.p[0] + (pb.p[0] - pa.p[0]) * k;
      const ny = pa.p[1] + (pb.p[1] - pa.p[1]) * k;
      const nz = pa.p[2] + (pb.p[2] - pa.p[2]) * k;
      const speed = Math.hypot(nx - r.pos.x, nz - r.pos.z) / Math.max(dt, 1e-3);
      r.pos.set(nx, ny, nz);
      r.yaw = lerpAngle(pa.y, pb.y, clamp(k, 0, 1));
      r.pitch = pa.pt + (pb.pt - pa.pt) * clamp(k, 0, 1);
      r.life = pb.st;
      const root = r.inst.root;
      root.visible = pb.st !== 2;
      root.position.copy(r.pos);
      root.rotation.y = r.yaw;
      // Gun in hand.
      if (r.gunId !== pb.w) {
        r.gun?.removeFromParent();
        const g = this.models!.weapon(pb.w);
        const hand = r.inst.bones.grip ?? r.inst.bones['hand.R'];
        (hand ?? root).add(g.root);
        if (!hand) g.root.position.set(0.25, 1.25, -0.3);
        r.gun = g.root;
        r.gunId = pb.w;
      }
      const base = pb.st === 1 ? 'downed' : speed > 4.8 ? 'run' : speed > 0.4 ? 'walk' : 'idle';
      // Pistols have their own stance, walk and reload when the model carries them (`<clip>_pistol`).
      const pistol = WEAPONS[pb.w]?.kind === 'pistol';
      const pick = (name: string) => (pistol && r.inst.actions[`${name}_pistol`] ? `${name}_pistol` : name);
      const clip = base === 'downed' ? base : pick(base);
      r.clip = this.play(r.inst, clip, r.clip, { fade: 0.25 });
      const act = r.inst.actions[clip];
      if (act && base !== 'idle' && base !== 'downed') act.timeScale = clamp(speed / (base === 'run' ? 6 : 3.6), 0.5, 1.5);
      if (pb.r && !r.reloading) {
        const rel = r.inst.actions[pick('reload')];
        if (rel) {
          rel.reset().setLoop(THREE.LoopOnce, 1).play();
          rel.weight = 0.8;
        }
        this.audio?.playAt('reloadOut', r.pos);
      }
      r.reloading = !!pb.r;
      unpose(r.inst);
      r.inst.mixer.update(dt);
      // Aim: bend the spine and chest towards where they look (the clips hold the gun level).
      if (pb.st === 0) {
        pose(r.inst, 'spine', r.pitch * 0.35, 0);
        pose(r.inst, 'chest', r.pitch * 0.4, 0);
        pose(r.inst, 'neck', r.pitch * 0.2, 0);
      }
      // Flashlight from the head along the view.
      const eyeY = pb.st === 1 ? 0.5 : 1.55;
      const fwd = this.lookDir(r.yaw, r.pitch);
      const rgt = yawRight(r.yaw);
      r.light.intensity = pb.st === 2 ? 0 : 40;
      r.light.castShadow = false;
      r.light.position.set(r.pos.x + rgt.x * 0.2 + fwd.x * 0.3, r.pos.y + eyeY - 0.15, r.pos.z + rgt.z * 0.2 + fwd.z * 0.3);
      r.light.target.position.set(r.light.position.x + fwd.x * 6, r.light.position.y + fwd.y * 6, r.light.position.z + fwd.z * 6);
      r.light.target.updateMatrixWorld();
      r.stepT += speed * dt;
      if (r.stepT > 1.1 && pb.st === 0) {
        r.stepT = 0;
        this.audio?.playAt('step', r.pos, { amount: 0.4 });
      }
    }
    for (const id of [...this.remotes.keys()]) if (!seen.has(id)) this.removeRemote(id);
  }

  // ---- camera and viewmodel -------------------------------------------------------------------------------------

  private updateCamera(dt: number, now: number) {
    const cam = this.engine!.camera;
    const me = this.me;
    this.correction.multiplyScalar(Math.exp(-dt * 12));
    const shot = this.cinematic;
    if (shot) {
      // Key-art camera: exactly the pose asked for, none of the player's feel on top.
      cam.position.set(shot.x, shot.y, shot.z);
      cam.rotation.set(shot.pitch, shot.yaw, 0);
      const fov = shot.fov ?? 72;
      if (cam.fov !== fov) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
      if (this.flashlight) this.flashlight.intensity = 0;
      return;
    }
    if (me.life === 2) {
      // Spectate: hover over the first survivor still standing.
      const r = [...this.remotes.values()].find((x) => x.life === 0);
      if (r) {
        const f = yawForward(r.yaw);
        cam.position.lerp(new THREE.Vector3(r.pos.x - f.x * 3, r.pos.y + 2.6, r.pos.z - f.z * 3), 1 - Math.exp(-dt * 4));
        cam.lookAt(r.pos.x, r.pos.y + 1.2, r.pos.z);
      }
      return;
    }
    // Recoil spring (visual kick on top of the aim change) and the landing dip.
    this.recoilVel += (-this.recoilPitch * 180 - this.recoilVel * 18) * dt;
    this.recoilPitch += this.recoilVel * dt;
    this.landVel += (-this.landDip * 160 - this.landVel * 14) * dt;
    this.landDip += this.landVel * dt;
    this.recoilYaw = damp(this.recoilYaw, 0, 10, dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const shake = this.trauma * this.trauma;
    const sx = (Math.sin(now * 37.1) + Math.sin(now * 23.7)) * 0.5 * shake * 0.03;
    const sy = (Math.sin(now * 41.3) + Math.sin(now * 19.9)) * 0.5 * shake * 0.03;
    const eye = eyeHeight(me.life === 1);
    const speed = Math.hypot(me.body.vel.x, me.body.vel.z);
    const bob = me.body.onGround ? Math.min(1, speed / ZB.walkSpeed) * (1 - this.adsK * 0.8) : 0;
    const bobY = Math.abs(Math.sin(this.bobT * Math.PI)) * 0.035 * bob;
    const bobX = Math.sin(this.bobT * Math.PI) * 0.02 * bob;
    const r = yawRight(me.yaw);
    cam.position.set(
      me.body.pos.x + this.correction.x + r.x * bobX,
      me.body.pos.y + this.correction.y + eye + bobY - 0.02 + this.landDip * 0.12,
      me.body.pos.z + this.correction.z + r.z * bobX,
    );
    // A hit tilts the head away from where it came from, for a moment.
    const hurtAge = (performance.now() - this.hud.get().hurtAt) / 1000;
    const hurtRoll = hurtAge < 0.5 ? Math.sin(this.hud.get().hurtYaw) * 0.06 * (1 - hurtAge / 0.5) : 0;
    cam.rotation.set(
      me.pitch + this.recoilPitch + sy + this.landDip * 0.05,
      me.yaw + this.recoilYaw + sx,
      (me.life === 1 ? 0.25 : Math.sin(this.bobT * Math.PI) * 0.004 * bob) + hurtRoll,
    );
    // FOV: aim zoom, a touch wider when sprinting.
    const id = this.slots[this.cur] ?? START_WEAPON;
    const sprint = this.input?.held('sprint') && speed > ZB.walkSpeed + 0.3;
    const want = 72 * (1 - this.adsK * (1 - WEAPONS[id].zoom)) * (sprint ? 1.06 : 1);
    if (Math.abs(cam.fov - want) > 0.01) {
      cam.fov = damp(cam.fov, want, 14, dt);
      cam.updateProjectionMatrix();
    }
    if (this.flashlight) this.flashlight.intensity = this.flashOn ? 55 + Math.sin(now * 13) * 0.6 : 0;
  }

  private updateViewmodel(dt: number) {
    const vm = this.vm;
    if (!vm) return;
    const ads = this.hud.get().ads && this.reloadLeft <= 0 && !vm.busy;
    this.adsK = damp(this.adsK, ads ? 1 : 0, 14, dt);
    const speed = Math.hypot(this.me.body.vel.x, this.me.body.vel.z);
    const sprint = !!this.input?.held('sprint') && speed > ZB.walkSpeed + 0.3;
    const scoped = WEAPONS[this.slots[this.cur] ?? START_WEAPON].kind === 'sniper' && this.adsK > 0.88;
    vm.update({
      dt,
      ads: this.adsK,
      sprint,
      move: Math.min(1, speed / ZB.walkSpeed),
      bob: this.bobT,
      onGround: this.me.body.onGround,
      lookX: this.lookX,
      lookY: this.lookY,
      downed: this.me.life === 1,
      visible: this.me.life !== 2 && !scoped && !this.cinematic,
    });
  }

  private updatePrompt() {
    const world = this.world;
    const s = this.latest;
    if (!world || !s) return;
    const me = this.me;
    const pos = me.body.pos;
    let prompt: string | null = null;
    if (me.life === 1) prompt = `You are down. Hold on! ${Math.ceil(this.hud.get().bleed)}s`;
    else if (me.life === 0) {
      const downed = s.pl.find((p) => p.id !== this.ctx.you && p.st === 1 && Math.hypot(p.p[0] - pos.x, p.p[2] - pos.z) < ZB.useRange);
      if (downed) prompt = `Hold E to revive ${this.name(downed.id)}`;
      else {
        const win = world.windows.find((w) => hdist(w.inside, pos) < ZB.useRange && (this.boards[w.i] ?? 0) < ZB.boardsPerWindow && inside(world, pos.x, pos.z));
        if (win) prompt = 'Hold E to rebuild the barrier';
        else {
          const st = world.stations.find((x) => hdist(x.pos, pos) < ZB.useRange);
          if (st) prompt = this.stationPrompt(st.kind, st.item);
        }
      }
    }
    if (prompt !== this.hud.get().prompt) this.hud.set({ prompt });
  }

  private stationPrompt(kind: string, item?: WeaponId) {
    switch (kind) {
      case 'weapon': {
        const w = WEAPONS[item!];
        const owned = this.slots.indexOf(w.id) >= 0;
        return owned ? `Press E to buy ${w.name} ammo [${w.ammoPrice}]` : `Press E to buy ${w.name} [${w.price}]${w.era === 'classic' ? ' · classic' : ''}`;
      }
      case 'ammo': {
        let cost = 0;
        for (let s = 0; s < 2; s++) {
          const id = this.slots[s];
          if (id && this.res[s] < WEAPONS[id].reserve) cost += WEAPONS[id].ammoPrice;
        }
        cost = Math.round((cost * AMMO_CACHE_SHARE) / 10) * 10;
        return cost ? `Press E to refill all ammo [${cost}]` : 'Ammo cache: you are full';
      }
      case 'crate': {
        const full = this.slots.every((id, s) => !id || this.res[s] >= WEAPONS[id].reserve);
        return full ? 'Ammo crate: you are full' : `Press E for a full ammo pack [${AMMO_CRATE_PRICE}]`;
      }
      case 'nades':
        return `Press E for frag grenades [${NADE_PRICE}]`;
      case 'armor':
        return `Press E for body armor [${ARMOR_PRICE}]`;
    }
    return null;
  }
}

// ---- helpers --------------------------------------------------------------------------------------------------------

/**
 * Procedural bone offsets on top of the animation (hit flinch, aim pitch). The bone's animated rotation is saved
 * first and put back by unpose() before the next mixer update, so bones a clip does not key never drift.
 */
const posed = new WeakMap<CharacterInstance, { bone: THREE.Bone; q: THREE.Quaternion }[]>();

function pose(inst: CharacterInstance, bone: string, x: number, z: number) {
  const b = inst.bones[bone];
  if (!b) return;
  let list = posed.get(inst);
  if (!list) posed.set(inst, (list = []));
  if (!list.some((e) => e.bone === b)) list.push({ bone: b, q: b.quaternion.clone() });
  if (x) b.rotateX(x);
  if (z) b.rotateZ(z);
}

function unpose(inst: CharacterInstance) {
  const list = posed.get(inst);
  if (!list?.length) return;
  for (const e of list) e.bone.quaternion.copy(e.q);
  list.length = 0;
}

const tuple = (p: Vec3): Vec3Tuple => [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000, Math.round(p.z * 1000) / 1000];

function normalize(p: Vec3): Vec3 {
  const l = Math.hypot(p.x, p.y, p.z) || 1;
  return v3(p.x / l, p.y / l, p.z / l);
}

function sphereT(o: Vec3, d: Vec3, cx: number, cy: number, cz: number, r: number) {
  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : -1;
}

function cylinderT(o: Vec3, d: Vec3, cx: number, cz: number, y0: number, y1: number, r: number, maxT: number) {
  const ox = o.x - cx;
  const oz = o.z - cz;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-9) return -1;
  const b = ox * d.x + oz * d.z;
  const c = ox * ox + oz * oz - r * r;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  if (t < 0 || t > maxT) return -1;
  const y = o.y + d.y * t;
  return y >= y0 && y <= y1 ? t : -1;
}
