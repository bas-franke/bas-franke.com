// Garden Sentinels client: networking, snapshot interpolation, the RTS camera, input and tower placement, and the glue
// between the render modules (see api.ts for who owns what). The server decides everything; this file turns its
// snapshots and events into enemy frames, beams, missiles and sounds, and fills the HUD store.

import * as THREE from 'three';
import type { GameServerMsg, PlayerInfo, RoomView } from '@shared/protocol';
import { type BoardOrigin, type RouteGeom, boardOrigin, cellAt, cellToWorld, routeGeom, routePos, worldToCell } from '@shared/garden/board';
import { G, type GMode, coopCount } from '@shared/garden/constants';
import { ENEMIES, type EnemyKind, SKITTER_PACK, waveSpawns } from '@shared/garden/enemies';
import { type GMapDef, gmapById, isBuildableChar } from '@shared/garden/maps';
import {
  type BoardInfo,
  EFlag,
  type GEvent,
  type GSnapshot,
  type GardenServerMsg,
  type TowerInfo,
  type TowerSnap,
  TFlag,
} from '@shared/garden/protocol';
import { TOWERS, TOWER_KINDS, type TargetMode, type TowerKind } from '@shared/garden/towers';
import { Engine } from '../../engine/engine';
import { SnapshotTimeline, damp, lerpAngle } from '../../engine/interp';
import { type ClientContext, type GameClient, type Store, createStore } from '../types';
import type {
  EnemyFrame,
  Fx,
  GAudio,
  GHudState,
  GardenActions,
  GardenModels,
  HudBoard,
  HudPlayer,
  HudSelected,
  P3,
  Pipeline,
  Quality,
  Toast,
  Units,
  WorldView,
} from './api';
import { createGAudio } from './audio';
import { createFx } from './fx';
import { createModels } from './models';
import { createPipeline } from './post';
import { type Ambience, createAmbience } from './ambience';
import { createUnits } from './units';
import { createWorldView } from './world';

// ---- settings ---------------------------------------------------------------------------------------------------------

const QUALITY_KEY = 'garden.quality.v1';

export function loadGardenQuality(): Quality {
  try {
    const q = localStorage.getItem(QUALITY_KEY);
    if (q === 'low' || q === 'medium' || q === 'high') return q;
  } catch {
    /* storage blocked */
  }
  return 'medium';
}

function saveQuality(q: Quality) {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    /* storage blocked */
  }
}

const PIXEL_RATIO: Record<Quality, number> = { low: 1, medium: 1.25, high: 1.5 };

// ---- camera tuning ----------------------------------------------------------------------------------------------------

const FOV = 35;
const PITCH = (55 * Math.PI) / 180;
const MIN_DIST = 10;
const EDGE_PX = 14;
/** Pixels a press may travel and still count as a click / tap. */
const CLICK_SLOP = 6;
const TOAST_LIFE = 4500;
const BOSS_TOAST_LIFE = 7000;
const COOP_COLOR = 0x7ec850;
const v3 = (x = 0, y = 0, z = 0): P3 => ({ x, y, z });

type InitMsg = Extract<GardenServerMsg, { k: 'init' }>;

interface PressState {
  id: number;
  button: number;
  type: string;
  x0: number;
  y0: number;
  x: number;
  y: number;
  moved: boolean;
  /** Ground point grabbed at the start of a drag (kept under the pointer). */
  grab: THREE.Vector3 | null;
  alt: boolean;
  shift: boolean;
  t0: number;
}

interface Track {
  id: number;
  k: EnemyKind;
  b: number;
  r: number;
  o: number;
  hp: number;
  f: number;
  /** Recent samples (server seconds, metres along the route), oldest first. */
  s: { t: number; d: number }[];
  /** Server time of the first snapshot of its board that no longer had it. */
  removeAt: number;
  /** Display correction (metres), eased to 0, so a late sample never snaps the enemy. */
  corr: number;
  shown: boolean;
}

/** Longest extrapolation along the route past the last sample (sparse boards update ~every 0.4 s). */
const MAX_EXTRAP = 1.0;
/** A track lingers this long (server s) after its board's snapshot dropped it, so the later `die` event still finds it. */
const REMOVE_GRACE = 0.35;
/** Largest display correction (m) a late sample may add. */
const MAX_CORR = 2;
/** The render clock counts as stale when no frame ran for this long (hidden / throttled tab). */
const STALE_CLOCK = 0.2;
/** Events this late (s) are replayed without effects; cosmetic ones are dropped. */
const OVERDUE = 1;
const COSMETIC = new Set<GEvent['k']>(['msl', 'boom', 'zap', 'ping', 'dis', 'shed']);
/** Touch: pixels per cell to aim for at the home zoom. */
const TOUCH_CELL_PX = 26;
/** Portrait phones: CSS px the HUD covers at the top (status rows) and bottom (build cards). */
const PORTRAIT_INSET_TOP = 170;
const PORTRAIT_INSET_BOTTOM = 130;

interface EnemyMemo {
  kind: EnemyKind;
  b: number;
  x: number;
  z: number;
}

const emptyHud = (quality: Quality, you: string): GHudState => ({
  ready: false,
  mode: 'coop',
  mapName: '',
  wave: 0,
  maxWave: G.coopWaves,
  phase: 'build',
  left: 0,
  progress: 0,
  lives: G.lives,
  maxLives: G.lives,
  boards: [],
  players: [],
  you,
  myBoard: 0,
  spectator: false,
  viewBoard: 0,
  gold: 0,
  income: 0,
  placing: null,
  selected: null,
  next: [],
  bossNext: false,
  toasts: [],
  scoresOpen: false,
  scores: [],
  end: null,
  quality,
  paused: false,
});

const isTyping = (e: Event) => {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class GardenClient implements GameClient {
  readonly store: Store<GHudState>;
  readonly actions: GardenActions;
  /** Same store under the name the screenshot tool and the room page's dev hooks read (`__playClient.hud`). */
  get hud() {
    return this.store;
  }

  private engine?: Engine;
  private container?: HTMLElement;
  private models?: GardenModels;
  private modelsReady = false;
  private world?: WorldView;
  private pipe?: Pipeline;
  private units?: Units;
  private fx?: Fx;
  private audio?: GAudio;
  private ambience?: Ambience;
  private built = false;
  private builtMap: string | null = null;
  private disposed = false;
  private paused = false;

  // Match state.
  private def: GMapDef | null = null;
  private mode: GMode = 'coop';
  private boards: BoardInfo[] = [];
  private origins: BoardOrigin[] = [];
  /** Route geometry per board, per route. */
  private geoms: RouteGeom[][] = [];
  private readonly towers = new Map<number, TowerInfo>();
  private readonly towerLive = new Map<number, TowerSnap>();
  private readonly timeline = new SnapshotTimeline<GSnapshot>(0.08, 0.3);
  private latest: GSnapshot | null = null;
  /** Enemy tracks: server samples of distance along the route, interpolated / extrapolated at the render clock. */
  private readonly tracks = new Map<number, Track>();
  /** Events wait until the render clock reaches the moment they happened. */
  private readonly events: { due: number; e: GEvent }[] = [];
  /** Enemies killed / leaked (never shown again). */
  private readonly gone = new Set<number>();
  /** The board the server was last told this client views (versus). */
  private sentView = -2;
  private readonly memo = new Map<number, EnemyMemo>();
  private readonly muzzleTurn = new Map<number, number>();
  private readonly disabledOn = new Set<number>();
  private readonly beaming = new Set<number>();
  private waveTotal = 1;
  private lastWave = -1;
  private room: RoomView;
  private lastDt = 1 / 60;
  private sizeKey = '';
  private toastKey = 0;
  private toastPrune = 0;
  private slowFor = 0;
  private laserSoundAt = 0;
  /** performance.now() seconds of the last rendered frame (the render clock is stale while the tab is hidden). */
  private lastFrameAt = -Infinity;
  /** Board the server put this client on in init (-1 = versus spectator); undefined until an init says. */
  private initBoard: number | undefined;
  /** Tower id -> wave whose build phase it was built in (-1 = during a wave): selling it then refunds everything. */
  private readonly builtIn = new Map<number, number>();
  /** Greenhouse health / wilt last applied to the world view, so snapshots only touch it on change. */
  private readonly shownHealth = new Map<number, number>();
  private readonly shownOut = new Set<number>();
  /** Per-frame scratch, reused to keep the render loop allocation-free. */
  private readonly framePool: EnemyFrame[] = [];
  private readonly frameList: EnemyFrame[] = [];
  private readonly keepIds = new Set<number>();
  private readonly beamPool: { tw: number; from: P3; to: P3; lv: 1 | 2 | 3; chain: P3[]; chainPool: P3[] }[] = [];
  private readonly beamList: Parameters<Fx['beams']>[0] = [];
  private readonly seenTowers = new Set<number>();
  private readonly aimTmp = v3();
  private readonly routeTmp = { x: 0, z: 0, yaw: 0 };
  /** Portrait (taller than wide) layout: the camera turns the long map axis vertical. */
  private portrait = false;

  // Camera: goal values (input writes) and current values (damped towards the goals).
  private readonly cam = { x: 0, z: 0, dist: 60, yaw: 0 };
  private readonly goal = { x: 0, z: 0, dist: 60, yaw: 0 };
  private maxDist = 120;
  private bounds = { minX: -40, maxX: 40, minZ: -30, maxZ: 30 };
  private readonly raycaster = new THREE.Raycaster();
  private readonly ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly ndc = new THREE.Vector2();
  private readonly tmpV = new THREE.Vector3();

  // Input.
  private readonly keys = new Set<string>();
  private readonly presses = new Map<number, PressState>();
  private pinch: { span: number; dist: number } | null = null;
  private pointer = { x: 0, y: 0, inside: false, mouse: false, moved: false };
  /** Touch placement: the cell the ghost sits on (a second tap there builds). */
  private touchGhost: { col: number; row: number } | null = null;
  private selectedId: number | null = null;

  constructor(private readonly ctx: ClientContext) {
    this.room = ctx.room();
    this.store = createStore<GHudState>(emptyHud(loadGardenQuality(), ctx.you));
    this.actions = {
      // Re-tapping the active card cancels placing.
      place: (kind) => this.setPlacing(kind !== null && kind === this.store.get().placing ? null : kind),
      upgrade: (id) => this.upgrade(id),
      sell: (id) => this.sell(id),
      setTarget: (id, tm) => this.send({ k: 'tm', id, tm }),
      deselect: () => this.select(null),
      ready: () => {
        if (this.isSpectator()) return;
        this.send({ k: 'ready' });
        this.audio?.play('click');
      },
      send: (kind, to) => {
        if (this.isSpectator()) return;
        this.send({ k: 'send', e: kind, to });
        this.audio?.play('click');
      },
      viewBoard: (b) => this.viewBoard(b),
      setScoresOpen: (open) => this.store.set({ scoresOpen: open }),
      setQuality: (q) => this.setQuality(q),
      leave: () => this.ctx.leave(),
    };
  }

  // ---- lifecycle ------------------------------------------------------------------------------------------------------

  mount(container: HTMLElement) {
    this.container = container;
    const engine = new Engine(container, { fov: FOV, near: 0.5, far: 900 });
    this.engine = engine;
    engine.scene.background = new THREE.Color(0x9fd3e8);
    engine.setMaxPixelRatio(PIXEL_RATIO[this.store.get().quality]);
    this.audio = createGAudio();
    // The room page replays the last init it saw, which can predate towers built since: ask for a current one.
    this.send({ k: 'sync' });
    this.models = createModels();
    this.models.ready
      .catch(() => undefined)
      .then(() => {
        if (this.disposed) return;
        this.modelsReady = true;
        this.tryBuild();
      });
    const el = engine.renderer.domElement;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', this.prevent);
    el.addEventListener('auxclick', this.prevent);
    el.addEventListener('mousedown', this.onMouseDown);
    el.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mouseleave', this.onPointerLeave);
    engine.renderHook = () => {
      if (this.pipe) this.pipe.render(this.lastDt);
      else engine.renderer.render(engine.scene, engine.camera);
    };
    this.applyCamera();
    engine.start((dt, now) => this.frame(dt, now));
    this.tryBuild();
    if (import.meta.env.DEV) (window as unknown as { __garden: unknown }).__garden = this.devHook();
  }

  unmount() {
    this.disposed = true;
    const el = this.engine?.renderer.domElement;
    if (el) {
      el.removeEventListener('pointerdown', this.onPointerDown);
      el.removeEventListener('pointermove', this.onPointerMove);
      el.removeEventListener('pointerup', this.onPointerUp);
      el.removeEventListener('pointercancel', this.onPointerUp);
      el.removeEventListener('wheel', this.onWheel);
      el.removeEventListener('contextmenu', this.prevent);
      el.removeEventListener('auxclick', this.prevent);
      el.removeEventListener('mousedown', this.onMouseDown);
      el.removeEventListener('pointerleave', this.onPointerLeave);
    }
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mouseleave', this.onPointerLeave);
    this.engine?.stop();
    this.teardownScene();
    this.audio?.dispose();
    this.engine?.dispose();
    if (import.meta.env.DEV) {
      const w = window as unknown as { __garden?: { client: unknown } };
      if (w.__garden?.client === this) delete w.__garden;
    }
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.keys.clear();
    this.presses.clear();
    this.pinch = null;
    this.store.set({ paused });
  }

  onRoom(room: RoomView) {
    this.room = room;
    this.refreshPlayers();
    this.refreshBoards();
  }

  // ---- messages -------------------------------------------------------------------------------------------------------

  onMessage(raw: GameServerMsg) {
    const m = raw as GardenServerMsg;
    switch (m.k) {
      case 'init':
        this.applyInit(m);
        return;
      case 'snap':
        this.onSnapshot(m.s);
        return;
      case 'ev': {
        const now = performance.now() / 1000;
        const due = now + Math.min(0.3, this.timeline.delay);
        for (const e of m.e) {
          // Feedback to your own actions is immediate; everything that shows on the board waits for the render clock.
          if (e.k === 'deny') this.onEvent(e);
          else this.events.push({ due, e });
        }
        // A hidden tab renders no frames: keep the queue from piling up (state applies, stale cosmetics are dropped).
        this.drainEvents(now, now - OVERDUE);
        return;
      }
      case 'score':
        this.store.set({ scores: m.scores });
        this.refreshBoards();
        return;
      case 'end': {
        this.store.set({ end: { win: m.win, winner: m.winner, wave: m.wave }, scores: m.scores, phase: 'over', placing: null });
        this.units?.ghost(null);
        const won = this.mode === 'coop' ? m.win : m.winner === this.ctx.you;
        this.audio?.play(won ? 'victory' : 'defeat');
        return;
      }
    }
  }

  private applyInit(m: InitMsg) {
    const def = gmapById(m.map.id);
    if (!def) {
      console.warn(`[garden] unknown map ${m.map.id}`);
      return;
    }
    // Same garden again (a re-sent init): keep the scene, just resync the towers.
    const same = this.built && this.builtMap === def.id && this.origins.length === m.boards.length && this.mode === m.mode;
    if (same) {
      for (const t of this.towers.values()) {
        this.units?.removeTower(t.id);
        this.fx?.field(t.id, null, this.towerPos(t), 0, t.lv);
        if (this.disabledOn.delete(t.id)) this.fx?.disabled(t.id, this.towerPos(t), false);
      }
      this.units?.select(null);
    }
    this.def = def;
    this.mode = m.mode;
    this.boards = m.boards;
    this.origins = m.boards.map((_, i) => boardOrigin(def, i, m.boards.length));
    this.geoms = this.origins.map((o) => def.routes.map((r) => routeGeom(def, o, r)));
    this.initBoard = m.myBoard;
    this.towers.clear();
    this.towerLive.clear();
    for (const t of m.towers) this.towers.set(t.id, { ...t });
    for (const id of this.builtIn.keys()) if (!this.towers.has(id)) this.builtIn.delete(id);
    this.timeline.reset();
    this.latest = null;
    this.events.length = 0;
    this.tracks.clear();
    this.gone.clear();
    this.sentView = -2;
    this.memo.clear();
    this.selectedId = null;
    this.lastWave = -1;
    this.store.set({
      mode: m.mode,
      mapName: m.map.name,
      wave: m.wave,
      maxWave: m.mode === 'coop' ? G.coopWaves : 0,
      scores: m.scores,
      end: null,
      selected: null,
      placing: null,
      myBoard: this.myBoard(),
      spectator: this.isSpectator(),
    });
    if (same) {
      for (const t of this.towers.values()) this.addTowerView(t, false);
    } else {
      if (this.built) this.teardownScene();
      this.tryBuild();
    }
    this.refreshBoards();
    this.refreshPlayers();
    this.refreshNext(m.wave);
  }

  /** Builds the scene once the engine is mounted, the models are loaded and init has arrived. */
  private tryBuild() {
    const engine = this.engine;
    const def = this.def;
    if (!engine || !def || !this.modelsReady || this.built || this.disposed) return;
    const q = this.store.get().quality;
    const models = this.models!;
    this.world = createWorldView(engine.scene, def, this.origins, models, q);
    this.units = createUnits(engine.scene, def, this.origins, models);
    this.fx = createFx(engine.scene, q);
    this.pipe = createPipeline(engine.renderer, engine.scene, engine.camera, q);
    try {
      const amb = createAmbience(engine.scene, def, this.origins, q);
      // Guard against a stub that does not implement everything yet.
      if (amb && typeof amb.update === 'function') this.ambience = amb;
    } catch (err) {
      console.warn('[garden] ambience failed', err);
    }
    this.sizeKey = '';
    this.built = true;
    this.builtMap = def.id;
    this.shownHealth.clear();
    this.shownOut.clear();
    this.syncBoardViews(this.latest);
    this.portrait = this.isPortrait();
    this.bounds = { ...this.world.bounds };
    const bw = this.bounds.maxX - this.bounds.minX;
    const bh = this.bounds.maxZ - this.bounds.minZ;
    this.maxDist = Math.max(40, this.fitDist(bw, bh) * 1.15);
    for (const t of this.towers.values()) this.addTowerView(t, false);
    this.home(true);
    try {
      engine.warmup();
    } catch {
      /* warmup is best effort */
    }
    this.store.set({ ready: true });
  }

  private teardownScene() {
    this.ambience?.dispose?.();
    this.ambience = undefined;
    this.fx?.dispose();
    this.units?.dispose();
    this.pipe?.dispose();
    this.world?.dispose();
    this.fx = undefined;
    this.units = undefined;
    this.pipe = undefined;
    this.world = undefined;
    this.built = false;
    this.builtMap = null;
    this.disabledOn.clear();
    this.beaming.clear();
    this.store.set({ ready: false });
  }

  private onSnapshot(s: GSnapshot) {
    this.timeline.push(s, s.t / 1000);
    this.timeline.trim(1.5);
    this.latest = s;
    if (s.wave !== this.lastWave || (s.ph === 'wave' && s.left > this.waveTotal)) {
      if (s.wave !== this.lastWave) this.waveTotal = Math.max(1, s.left);
      else this.waveTotal = s.left;
      this.lastWave = s.wave;
      this.refreshNext(s.wave);
    }
    for (const t of s.tw) this.towerLive.set(t.id, t);
    this.ingestEnemies(s);
    let progress = 0;
    let left = s.left;
    if (s.ph === 'build') {
      const full = s.wave === 0 ? G.firstBuild : G.betweenWaves;
      progress = Math.max(0, Math.min(1, 1 - s.left / full));
    } else if (s.ph === 'wave') {
      const tot = s.tot && s.tot > 0 ? s.tot : this.waveTotal;
      progress = Math.max(0, Math.min(1, 1 - s.left / tot));
      // Versus: "enemies left" of the board you look at.
      if (this.mode === 'vs') {
        // `rem` is left out for boards that are done with the wave.
        if (s.bd.some((x) => x.rem !== undefined)) left = s.bd.find((x) => x.b === this.store.get().viewBoard)?.rem ?? 0;
      }
    } else progress = 1;
    const me = s.pl.find((p) => p.id === this.ctx.you);
    const hud = this.store.get();
    const patch: Partial<GHudState> = {
      wave: s.wave,
      phase: hud.end ? 'over' : s.ph,
      left,
      progress,
      gold: me?.gold ?? 0,
      income: me?.inc ?? 0,
    };
    const mb = this.myBoard();
    if (mb !== hud.myBoard) patch.myBoard = mb;
    const spectator = this.isSpectator();
    if (spectator !== hud.spectator) patch.spectator = spectator;
    if (spectator && hud.placing) patch.placing = null;
    this.store.set(patch);
    this.syncBoardViews(s);
    // The wave starts: a tower you cannot afford stops following the cursor / finger.
    const placing = this.store.get().placing;
    if (hud.phase === 'build' && s.ph === 'wave' && placing && (me?.gold ?? 0) < TOWERS[placing].levels[0].cost) this.setPlacing(null);
    this.refreshBoards();
    this.refreshPlayers();
    if (this.selectedId !== null) this.refreshSelected();
    this.audio?.setIntensity(this.intensity(s));
  }

  /**
   * Adds a snapshot's enemies to their tracks. Snapshots only carry the boards listed in `eb` (own + viewed every time,
   * the rest every ~4th); tracks of other boards keep extrapolating until their board shows up again.
   */
  private ingestEnemies(s: GSnapshot) {
    const T = s.t / 1000;
    const boards = s.eb ? new Set(s.eb) : null;
    const now = this.timeline.renderTime;
    // While the tab is hidden no frame advances the render clock: a correction measured against it would be
    // seconds stale (enemies jumping back metres on return), so only correct against a live clock.
    const live = Number.isFinite(now) && performance.now() / 1000 - this.lastFrameAt < STALE_CLOCK;
    const present = new Set<number>();
    for (const e of s.en) {
      present.add(e.id);
      let tr = this.tracks.get(e.id);
      if (!tr) {
        tr = { id: e.id, k: e.k, b: e.b, r: e.r, o: e.o, hp: e.hp, f: e.f, s: [], removeAt: Infinity, corr: 0, shown: false };
        this.tracks.set(e.id, tr);
      } else if (e.hp < tr.hp - 0.005 && tr.shown) this.units?.hit(e.id);
      const before = tr.shown && live ? this.trackD(tr, now) : NaN;
      if (tr.r !== e.r) tr.s.length = 0;
      tr.r = e.r;
      tr.b = e.b;
      tr.o = e.o;
      tr.hp = e.hp;
      tr.f = e.f;
      tr.removeAt = Infinity;
      const last = tr.s[tr.s.length - 1];
      if (!last || T > last.t) tr.s.push({ t: T, d: e.d });
      else if (T === last.t) last.d = e.d;
      if (tr.s.length > 4) tr.s.shift();
      if (!Number.isNaN(before)) {
        const jump = before - this.trackD(tr, now);
        if (Math.abs(jump) < 4) tr.corr = Math.max(-MAX_CORR, Math.min(MAX_CORR, tr.corr + jump));
        else tr.corr = 0;
      } else if (!live) tr.corr = 0;
    }
    for (const tr of this.tracks.values()) {
      if (present.has(tr.id) || tr.removeAt !== Infinity) continue;
      // A grace period: the kill / leak event for it is still on its way through the event queue.
      if (!boards || boards.has(tr.b)) tr.removeAt = T + REMOVE_GRACE;
    }
  }

  /** Metres along the route at server time T: interpolated between samples, extrapolated past the last one. */
  private trackD(tr: Track, T: number): number {
    const s = tr.s;
    const n = s.length;
    if (!n) return 0;
    if (T <= s[0].t) return s[0].d;
    for (let i = n - 2; i >= 0; i--) {
      if (s[i].t <= T && T < s[i + 1].t) return s[i].d + ((s[i + 1].d - s[i].d) * (T - s[i].t)) / (s[i + 1].t - s[i].t);
    }
    const last = s[n - 1];
    return last.d + this.trackSpeed(tr) * Math.min(MAX_EXTRAP, T - last.t);
  }

  /** Metres per second along the route, from the last two samples (or the kind's speed). */
  private trackSpeed(tr: Track): number {
    if (tr.f & EFlag.stunned) return 0;
    const s = tr.s;
    const n = s.length;
    if (n >= 2) {
      const a = s[n - 2];
      const b = s[n - 1];
      if (b.t - a.t > 0 && b.t - a.t < 1.5) return Math.max(0, (b.d - a.d) / (b.t - a.t));
    }
    return ENEMIES[tr.k].speed * (tr.f & EFlag.slowed ? 0.6 : 1);
  }

  private intensity(s: GSnapshot) {
    if (s.ph !== 'wave') return 0;
    if (s.en.some((e) => e.k === 'colossus')) return 2;
    return Math.min(1, 0.3 + s.en.length / 40);
  }

  // ---- events ---------------------------------------------------------------------------------------------------------

  /**
   * Applies queued events due by `upTo` (local seconds). Events more than OVERDUE late (a hidden or throttled tab)
   * still change state, but cosmetic ones are dropped and the rest play without effects or sound.
   */
  private drainEvents(now: number, upTo: number) {
    const q = this.events;
    if (!q.length || q[0].due > upTo) return;
    let n = 0;
    while (n < q.length && q[n].due <= upTo) n++;
    const batch = q.splice(0, n);
    const stale = now - OVERDUE;
    for (const ev of batch) {
      const late = ev.due < stale;
      if (late && COSMETIC.has(ev.e.k)) continue;
      this.quiet = late;
      try {
        this.onEvent(ev.e);
      } finally {
        this.quiet = false;
      }
    }
  }

  /** Set while replaying overdue events: no particles, no sounds. */
  private quiet = false;

  private onEvent(e: GEvent) {
    const quiet = this.quiet;
    const fx = quiet ? undefined : this.fx;
    const units = this.units;
    const audio = quiet ? undefined : this.audio;
    const you = this.ctx.you;
    switch (e.k) {
      case 'build': {
        this.towers.set(e.t.id, { ...e.t });
        // Same rule as the server: a tower sold in the build phase it was built in refunds everything.
        const ph = this.latest?.ph ?? this.store.get().phase;
        this.builtIn.set(e.t.id, ph === 'build' ? (this.latest?.wave ?? this.store.get().wave) : -1);
        this.addTowerView(e.t, !quiet);
        audio?.play('build', { at: this.towerPos(e.t), kind: e.t.k });
        return;
      }
      case 'up': {
        const t = this.towers.get(e.id);
        if (!t) return;
        t.lv = e.lv;
        t.spent = e.spent;
        units?.upgradeTower(e.id, e.lv);
        const at = this.towerPos(t);
        fx?.build(at, e.lv);
        this.setField(t);
        audio?.play('upgrade', { at, kind: t.k });
        if (this.selectedId === e.id) this.refreshSelected();
        return;
      }
      case 'sell': {
        const t = this.towers.get(e.id);
        if (!t) return;
        const at = this.towerPos(t);
        units?.removeTower(e.id);
        fx?.sell(at);
        fx?.field(e.id, null, at, 0, t.lv);
        if (this.disabledOn.delete(e.id)) fx?.disabled(e.id, at, false);
        this.towers.delete(e.id);
        this.towerLive.delete(e.id);
        this.muzzleTurn.delete(e.id);
        this.builtIn.delete(e.id);
        audio?.play('sell', { at });
        if (e.by === you && e.refund > 0) audio?.play('coin', { amount: 0.5 });
        if (this.selectedId === e.id) this.select(null);
        return;
      }
      case 'tm': {
        const t = this.towers.get(e.id);
        if (t) t.tm = e.tm;
        if (this.selectedId === e.id) this.refreshSelected();
        return;
      }
      case 'msl': {
        const t = this.towers.get(e.tw);
        if (!t) return;
        const turn = this.muzzleTurn.get(e.tw) ?? 0;
        this.muzzleTurn.set(e.tw, turn + 1);
        const from = units?.muzzle(e.tw, turn) ?? { ...this.towerPos(t), y: 1.4 };
        let last: P3 | null = units?.enemyPos(e.en) ?? null;
        fx?.missile(
          e.mid,
          from,
          () => {
            const p = this.units?.enemyPos(e.en);
            if (p) last = { x: p.x, y: p.y, z: p.z };
            return last;
          },
          e.ft,
        );
        audio?.play('missile', { at: from });
        return;
      }
      case 'boom': {
        const at = v3(e.x, 0.3, e.z);
        fx?.boom(e.mid, at, e.r);
        this.ambience?.scare(e.x, e.z, e.r * 2.5);
        audio?.play('boom', { at, amount: Math.min(1, e.r / 2.6) });
        return;
      }
      case 'zap':
        fx?.zap(e.tw);
        audio?.play('zap', { at: this.towerPosById(e.tw) ?? undefined, amount: 0.4 });
        return;
      case 'die': {
        const memo = this.memo.get(e.en);
        const at =
          units?.enemyPos(e.en) ?? (memo ? v3(memo.x, 0.5, memo.z) : e.x !== undefined && e.z !== undefined ? v3(e.x, 0.5, e.z) : null);
        this.gone.add(e.en);
        units?.kill(e.en);
        if (at) {
          // Gold pops only for players who got it: every defender in co-op, player `to` in versus.
          const b = e.b ?? memo?.b ?? 0;
          const mine = this.mode === 'coop' ? this.myBoard() >= 0 : e.to !== undefined ? e.to === you : this.boards[b]?.own === you;
          fx?.death(at, e.kind, mine ? e.gold : 0);
          if (!quiet) this.ambience?.scare(at.x, at.z, e.kind === 'colossus' ? 6 : 2.5);
          const big = e.kind === 'brute' || e.kind === 'colossus';
          audio?.play(big ? 'dieBig' : 'die', { at, kind: e.kind });
          if (mine && e.gold > 0 && big) audio?.play('coin', { at, amount: 0.6 });
        }
        return;
      }
      case 'spawn': {
        // The track starts now (at the render clock), so even an enemy on a sparsely updated board shows up on time.
        if (this.tracks.has(e.en) || this.gone.has(e.en)) return;
        const T = this.timeline.renderTime;
        if (!Number.isFinite(T)) return;
        this.tracks.set(e.en, {
          id: e.en,
          k: e.kind,
          b: e.b,
          r: e.r,
          o: e.o,
          hp: 1,
          f: e.from ? EFlag.sent : 0,
          s: [{ t: T, d: e.d }],
          removeAt: Infinity,
          corr: 0,
          shown: false,
        });
        return;
      }
      case 'gold': {
        if (e.id !== you || e.n <= 0) return;
        if (e.why === 'refund') return; // the sell poof + coin already say it
        const why = e.why === 'clear' ? 'wave bonus' : e.why === 'income' ? 'income' : 'called the wave early';
        this.toast(`+${e.n} gold (${why})`, 'good');
        audio?.play('coin', { amount: 0.7 });
        return;
      }
      case 'leak': {
        this.gone.add(e.en);
        const goal = this.world?.goals[e.b] ?? this.boardCenter(e.b);
        fx?.leak(goal);
        this.setBoardHealth(e.b, e.lives);
        const mine = this.mode === 'coop' || e.b === this.myBoard();
        audio?.play('leak', { at: goal, amount: mine ? 1 : 0.4 });
        const kind = this.memo.get(e.en)?.kind ?? this.tracks.get(e.en)?.k;
        const name = kind ? ENEMIES[kind].name : 'An enemy';
        if (mine) this.toast(`${name} reached the greenhouse! ${plural(Math.max(0, e.lives), 'life')} left`, 'bad');
        else if (e.from && e.from === you) {
          const lost = kind ? ENEMIES[kind].lives : 1;
          this.toast(`Your ${name.toLowerCase()} took ${plural(lost, 'life')} from ${this.boardName(e.b)}`, 'good');
        }
        return;
      }
      case 'dis': {
        const t = this.towers.get(e.tw);
        const from = units?.enemyPos(e.en);
        units?.cast(e.en);
        if (t && from) {
          const to = units?.muzzle(e.tw, 0) ?? { ...this.towerPos(t), y: 1.2 };
          fx?.disrupt(from, to, e.blocked === 1);
        }
        audio?.play(e.blocked ? 'blocked' : 'disrupt', { at: from ?? undefined });
        if (t && t.own === you && !e.blocked) this.toast(`Your ${TOWERS[t.k].name} was disrupted`, 'bad');
        return;
      }
      case 'shed': {
        const at = units?.enemyPos(e.en);
        if (at) fx?.spawn(at);
        audio?.play('dieBig', { at: at ?? undefined, amount: 0.5 });
        return;
      }
      case 'wave':
        this.toast(e.boss ? `Wave ${e.n}: the Prism Colossus approaches!` : `Wave ${e.n}`, e.boss ? 'boss' : 'info');
        audio?.play(e.boss ? 'bossWave' : 'waveStart');
        return;
      case 'clear':
        // Versus clears come per board: only yours (or the one you watch) gets the fanfare.
        if (e.b !== undefined && this.mode === 'vs' && e.b !== this.myBoard()) return;
        this.toast(`Wave ${e.n} cleared!`, 'good');
        audio?.play('waveClear');
        return;
      case 'send': {
        const name = ENEMIES[e.kind].name;
        const what = `${e.n} ${name}${e.n === 1 ? '' : 's'}`;
        if (e.from === you) {
          this.toast(`Sent ${what} to ${this.boardName(e.to)}`, 'good');
          audio?.play('send');
        } else if (e.to === this.myBoard()) {
          this.toast(`${this.playerName(e.from)} sent ${what} at you!`, 'bad');
          audio?.play('incoming');
        } else this.toast(`${this.playerName(e.from)} sent ${what} to ${this.boardName(e.to)}`, 'info');
        return;
      }
      case 'out': {
        this.setBoardOut(e.b);
        const own = this.boards[e.b]?.own;
        this.outPlaces.set(e.b, e.place);
        if (own === you) this.toast(`Your garden has fallen. You finish ${ordinal(e.place)}.`, 'bad');
        else this.toast(`${this.boardName(e.b)} has fallen (${ordinal(e.place)})`, 'info');
        audio?.play('out');
        this.refreshBoards();
        return;
      }
      case 'ping': {
        const color = this.playerColor(e.id);
        const at = v3(e.x, 0.05, e.z);
        fx?.ping(at, color);
        audio?.play('ping', { at });
        return;
      }
      case 'deny':
        if (e.id === you) {
          this.toast(e.why, 'bad');
          audio?.play('deny');
        }
        return;
    }
  }

  private readonly outPlaces = new Map<number, number>();

  private setBoardHealth(b: number, lives: number) {
    const frac = Math.max(0, lives) / G.lives;
    if (this.shownHealth.get(b) === frac || !this.world) return;
    this.shownHealth.set(b, frac);
    this.world.setHealth(b, frac);
  }

  private setBoardOut(b: number) {
    if (this.shownOut.has(b) || !this.world) return;
    this.shownOut.add(b);
    this.world.setOut(b);
  }

  /** Greenhouse damage and wilted boards from a snapshot (a late joiner or reload never saw the leak / out events). */
  private syncBoardViews(s: GSnapshot | null) {
    if (!s) return;
    for (const bs of s.bd) {
      this.setBoardHealth(bs.b, bs.lives);
      if (bs.out) this.setBoardOut(bs.b);
    }
  }

  private addTowerView(t: TowerInfo, fresh: boolean) {
    if (!this.units) return;
    this.units.addTower(t, this.playerColor(t.own));
    const at = this.towerPos(t);
    if (fresh) this.fx?.build(at, t.lv);
    this.setField(t);
  }

  private setField(t: TowerInfo) {
    if (t.k !== 'slow' && t.k !== 'shield' && t.k !== 'beacon') return;
    this.fx?.field(t.id, t.k, this.towerPos(t), TOWERS[t.k].levels[t.lv - 1].range, t.lv);
  }

  private towerPos(t: TowerInfo): P3 {
    const o = this.origins[t.b] ?? { x: 0, z: 0 };
    const p = cellToWorld(this.def!, o, t.x + 0.5, t.y + 0.5);
    return v3(p.x, 0, p.z);
  }

  private towerPosById(id: number) {
    const t = this.towers.get(id);
    return t ? this.towerPos(t) : null;
  }

  // ---- frame ----------------------------------------------------------------------------------------------------------

  private frame(dt: number, time: number) {
    this.lastDt = dt;
    const engine = this.engine!;
    this.updateCamera(dt);
    if (!this.built) return;
    const now = performance.now() / 1000;
    this.checkSize();

    // Events whose moment the render clock has reached.
    this.drainEvents(now, now);
    this.lastFrameAt = now;

    this.timeline.sample(now);
    this.renderEnemies(dt);
    this.renderTowers();

    this.updatePlacement();
    this.updateCursor(now);
    this.world!.update(dt, time);
    this.units!.update(dt, engine.camera);
    this.fx!.update(dt, engine.camera);
    this.ambience?.update(dt, time, engine.camera);
    const target = v3(this.cam.x, 0, this.cam.z);
    this.pipe!.setFocus(target, this.cam.dist);
    this.audio?.listen(target, Math.max(0, Math.min(1, (this.cam.dist - MIN_DIST) / (this.maxDist - MIN_DIST))));

    if (now - this.toastPrune > 0.25) {
      this.toastPrune = now;
      this.pruneToasts();
      this.autoQuality(0.25);
    }
  }

  private renderEnemies(dt: number) {
    const T = this.timeline.renderTime;
    if (!Number.isFinite(T)) return;
    const list = this.frameList;
    const pool = this.framePool;
    list.length = 0;
    const pos = this.routeTmp;
    const k = Math.exp(-6 * dt);
    for (const tr of this.tracks.values()) {
      if (T >= tr.removeAt) {
        this.tracks.delete(tr.id);
        this.gone.delete(tr.id);
        continue;
      }
      if (this.gone.has(tr.id)) continue;
      const g = this.geoms[tr.b]?.[tr.r];
      if (!g || !tr.s.length) continue;
      // Not born yet at the render clock.
      if (!tr.shown && T < tr.s[0].t - 0.01) continue;
      tr.corr *= k;
      const d = this.trackD(tr, T) + tr.corr;
      routePos(g, d, tr.o, pos);
      if (!tr.shown) {
        tr.shown = true;
        if (d < 3) {
          const portal = this.world?.portals[tr.b]?.[g.route.entry];
          const p0 = routePos(g, 0, 0);
          this.fx?.spawn(portal ?? v3(p0.x, 0, p0.z));
        }
      }
      let m = this.memo.get(tr.id);
      if (!m) {
        m = { kind: tr.k, b: tr.b, x: pos.x, z: pos.z };
        this.memo.set(tr.id, m);
      }
      m.x = pos.x;
      m.z = pos.z;
      const speed = Math.max(0, Math.min(2, this.trackSpeed(tr) / ENEMIES[tr.k].speed));
      let fr = pool[list.length];
      if (!fr) {
        fr = { id: 0, kind: tr.k, b: 0, x: 0, z: 0, yaw: 0, hp: 1, f: 0, speed: 1 };
        pool.push(fr);
      }
      fr.id = tr.id;
      fr.kind = tr.k;
      fr.b = tr.b;
      fr.x = pos.x;
      fr.z = pos.z;
      fr.yaw = pos.yaw;
      fr.hp = tr.hp;
      fr.f = tr.f;
      fr.speed = speed;
      list.push(fr);
    }
    this.units!.syncEnemies(list);
    if (this.memo.size > list.length + 200) {
      const keep = this.keepIds;
      keep.clear();
      for (const e of list) keep.add(e.id);
      for (const id of this.memo.keys()) if (!keep.has(id)) this.memo.delete(id);
    }
  }

  private renderTowers() {
    const units = this.units!;
    const fx = this.fx!;
    const live = this.towerLive.values();
    const beams = this.beamList;
    beams.length = 0;
    const now = performance.now();
    const seen = this.seenTowers;
    seen.clear();
    for (const ts of live) {
      const t = this.towers.get(ts.id);
      if (!t) continue;
      seen.add(ts.id);
      const aim = ts.tg ? units.enemyPos(ts.tg, this.aimTmp) : null;
      units.setTowerState(ts.id, aim, ts.f);
      const dis = (ts.f & TFlag.disabled) !== 0;
      if (dis !== this.disabledOn.has(ts.id)) {
        if (dis) this.disabledOn.add(ts.id);
        else this.disabledOn.delete(ts.id);
        fx.disabled(ts.id, this.towerPos(t), dis);
      }
      if (t.k === 'laser' && aim && !dis) {
        // Pooled per beam slot: fx.beams copies the numbers, never keeps the objects.
        let bm = this.beamPool[beams.length];
        if (!bm) {
          bm = { tw: 0, from: v3(), to: v3(), lv: 1, chain: [], chainPool: [] };
          this.beamPool.push(bm);
        }
        bm.tw = ts.id;
        bm.lv = t.lv;
        bm.to.x = aim.x;
        bm.to.y = aim.y;
        bm.to.z = aim.z;
        const from = units.muzzle(ts.id, 0, bm.from);
        if (!from) {
          const p = this.towerPos(t);
          bm.from.x = p.x;
          bm.from.y = 1.3;
          bm.from.z = p.z;
        }
        bm.chain.length = 0;
        if (ts.ch) for (const id of ts.ch) {
          const slot = bm.chainPool[bm.chain.length] ?? (bm.chainPool[bm.chain.length] = v3());
          if (units.enemyPos(id, slot)) bm.chain.push(slot);
        }
        beams.push(bm);
        if (!this.beaming.has(ts.id)) {
          this.beaming.add(ts.id);
          if (now - this.laserSoundAt > 90) {
            this.laserSoundAt = now;
            this.audio?.play('laser', { at: { ...bm.from }, amount: 0.5 });
          }
        }
      } else this.beaming.delete(ts.id);
    }
    for (const id of this.beaming) if (!seen.has(id)) this.beaming.delete(id);
    fx.beams(beams);
    this.audio?.setBeams(beams.length);
  }

  // ---- camera ---------------------------------------------------------------------------------------------------------

  /**
   * Distance that fits `w` metres across the screen and `h` metres deep (along the view direction) into the view.
   * `vFrac` = share of the screen height free for it (portrait phones lose the top and bottom to the HUD).
   */
  private fitDist(w: number, h: number, vFrac = 1) {
    const engine = this.engine;
    const aspect = engine ? engine.camera.aspect || 16 / 9 : 16 / 9;
    const tanV = Math.tan(((FOV / 2) * Math.PI) / 180);
    const dv = (h * Math.sin(PITCH) * 0.5) / (tanV * vFrac);
    const dh = (w * 0.5) / (tanV * aspect);
    // A little slack: the HUD covers the top corners and the bottom build bar.
    return Math.max(dv, dh) * 1.14;
  }

  private viewSize() {
    const el = this.engine?.renderer.domElement;
    return { w: el?.clientWidth || 1, h: el?.clientHeight || 1 };
  }

  private isPortrait() {
    const { w, h } = this.viewSize();
    return h > w * 1.05;
  }

  private coarse() {
    try {
      return matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  }

  /** Screen rows (CSS px) the HUD covers at the top and bottom, which framing keeps the board out of. */
  private insets() {
    if (!this.portrait) return { top: 0, bottom: 0 };
    const { h } = this.viewSize();
    // Never let the insets eat more than 60% of a short screen.
    const k = Math.min(1, (h * 0.6) / (PORTRAIT_INSET_TOP + PORTRAIT_INSET_BOTTOM));
    return { top: PORTRAIT_INSET_TOP * k, bottom: PORTRAIT_INSET_BOTTOM * k };
  }

  /** Camera distance at which one cell is `px` CSS pixels wide at the screen centre. */
  private distForCellPx(px: number) {
    const tanV = Math.tan(((FOV / 2) * Math.PI) / 180);
    return (G.cell * this.viewSize().h) / (2 * tanV * px);
  }

  /** Pixels per cell (width) at the screen centre for a camera distance (for tests / the dev hook). */
  private cellPx(dist: number) {
    const tanV = Math.tan(((FOV / 2) * Math.PI) / 180);
    return (G.cell * this.viewSize().h) / (2 * tanV * dist);
  }

  private boardSize() {
    const def = this.def;
    if (!def) return { w: 40, h: 30 };
    return { w: def.grid[0].length * G.cell, h: def.grid.length * G.cell };
  }

  private boardCenter(b: number): P3 {
    const o = this.origins[b] ?? { x: 0, z: 0 };
    return v3(o.x, 0, o.z);
  }

  /** Fly to (or jump to) your board, framed. */
  private home(snap = false) {
    const b = this.mode === 'vs' ? Math.max(0, this.myBoard()) : 0;
    this.flyTo(b, snap);
  }

  private flyTo(b: number, snap = false) {
    const c = this.boardCenter(b);
    const { w, h } = this.boardSize();
    const Q = Math.PI / 2;
    // Quarter turns: keep the player's heading, but run the board's long axis along the screen's long axis
    // (portrait phones see the map turned 90 degrees).
    let q = Math.round(this.goal.yaw / Q);
    const wantOdd = this.portrait !== h > w;
    // Even -> one turn left, odd -> back one turn: a phone turned there and back ends on the heading it started on.
    if ((((q % 2) + 2) % 2 === 1) !== wantOdd) q += wantOdd ? 1 : -1;
    const yaw = q * Q;
    const odd = (((q % 2) + 2) % 2) === 1;
    const across = odd ? h : w;
    const deep = odd ? w : h;
    const { h: vh } = this.viewSize();
    const ins = this.insets();
    const vFrac = Math.max(0.3, (vh - ins.top - ins.bottom) / vh);
    let dist = this.fitDist(across, deep, vFrac);
    // Fingers need bigger cells than the whole board fitted on a phone gives: zoom in (the board then pans).
    if (this.coarse()) dist = Math.min(dist, this.distForCellPx(TOUCH_CELL_PX));
    dist = Math.min(this.maxDist, Math.max(MIN_DIST, dist));
    // Screen-down on the ground (towards the camera) for this heading.
    const downX = Math.sin(yaw);
    const downZ = Math.cos(yaw);
    let shift: number;
    if (this.portrait) {
      // Centre the board in the free band between the HUD rows: the ground point the band's centre shows sits
      // `off` metres along the view direction from the target; move the target by the opposite.
      const tanV = Math.tan(((FOV / 2) * Math.PI) / 180);
      const yc = (ins.top + vh - ins.bottom) / 2;
      const v = -(yc - vh / 2) / (vh / 2);
      const ang = PITCH - Math.atan(v * tanV);
      // Metres along the view direction (forward = screen-up) from the target to the ground the band centre shows.
      const off = (Math.sin(PITCH) * dist) / Math.tan(ang) - Math.cos(PITCH) * dist;
      // That point is target - down * off; make it the board centre.
      shift = off;
    } else {
      // Nudge the target screen-down so the board's near edge clears the build bar at the bottom of the screen.
      shift = deep * 0.05;
    }
    this.goal.x = c.x + downX * shift;
    this.goal.z = c.z + downZ * shift;
    this.goal.dist = dist;
    this.goal.yaw = yaw;
    if (snap) Object.assign(this.cam, this.goal);
    this.store.set({ viewBoard: b });
  }

  /** Versus: tell the server which board the camera is on (it then streams that board's enemies every snapshot). */
  private sendView(b: number) {
    if (this.mode !== 'vs' || b === this.sentView || !this.built) return;
    this.sentView = b;
    this.send({ k: 'view', b });
  }

  private viewBoard(b: number) {
    if (b < 0 || b >= this.origins.length) return;
    this.flyTo(b);
  }

  lookAt(x: number, z: number, dist?: number, snap = true) {
    this.goal.x = x;
    this.goal.z = z;
    if (dist !== undefined) this.goal.dist = Math.max(MIN_DIST * 0.5, dist);
    if (snap) Object.assign(this.cam, this.goal);
    this.applyCamera();
  }

  private updateCamera(dt: number) {
    if (!this.paused) {
      // Keyboard + edge pan, relative to the camera's heading.
      let fx = 0;
      let fz = 0;
      const k = this.keys;
      if (k.has('KeyW') || k.has('ArrowUp')) fz -= 1;
      if (k.has('KeyS') || k.has('ArrowDown')) fz += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
      const p = this.pointer;
      if (p.inside && p.mouse && p.moved && this.presses.size === 0 && document.hasFocus()) {
        const el = this.engine!.renderer.domElement;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (p.x < EDGE_PX) fx -= 1;
        else if (p.x > w - EDGE_PX) fx += 1;
        if (p.y < EDGE_PX) fz -= 1;
        else if (p.y > h - EDGE_PX) fz += 1;
      }
      if (fx || fz) {
        const len = Math.hypot(fx, fz);
        const speed = this.goal.dist * 0.9 * dt;
        const sin = Math.sin(this.goal.yaw);
        const cos = Math.cos(this.goal.yaw);
        // Screen right = (cos, -sin), screen down = (sin, cos) on the ground for yaw about y.
        const dx = (fx * cos + fz * sin) / len;
        const dz = (-fx * sin + fz * cos) / len;
        this.goal.x += dx * speed;
        this.goal.z += dz * speed;
      }
    }
    this.clampGoal();
    const c = this.cam;
    c.x = damp(c.x, this.goal.x, 10, dt);
    c.z = damp(c.z, this.goal.z, 10, dt);
    c.dist = damp(c.dist, this.goal.dist, 9, dt);
    c.yaw = lerpAngle(c.yaw, this.goal.yaw, 1 - Math.exp(-8 * dt));
    this.applyCamera();
    // Versus: the board the camera is over is the one the HUD shows.
    if (this.mode === 'vs' && this.origins.length > 1) {
      let best = 0;
      let bd = Infinity;
      this.origins.forEach((o, i) => {
        const d = Math.hypot(o.x - c.x, o.z - c.z);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best !== this.store.get().viewBoard) {
        this.store.set({ viewBoard: best });
        this.refreshBoards();
      }
      this.sendView(best);
    }
  }

  private clampGoal() {
    const b = this.bounds;
    const g = this.goal;
    g.x = Math.max(b.minX, Math.min(b.maxX, g.x));
    g.z = Math.max(b.minZ, Math.min(b.maxZ, g.z));
    g.dist = Math.max(MIN_DIST, Math.min(this.maxDist, g.dist));
  }

  private applyCamera() {
    const cam = this.engine?.camera;
    if (!cam) return;
    const c = this.cam;
    const horiz = Math.cos(PITCH) * c.dist;
    cam.position.set(c.x + Math.sin(c.yaw) * horiz, Math.sin(PITCH) * c.dist, c.z + Math.cos(c.yaw) * horiz);
    cam.lookAt(c.x, 0, c.z);
    cam.updateMatrixWorld();
  }

  private checkSize() {
    const engine = this.engine!;
    const el = engine.renderer.domElement;
    const key = `${el.clientWidth}x${el.clientHeight}@${engine.renderer.getPixelRatio()}`;
    if (key !== this.sizeKey) {
      this.sizeKey = key;
      this.pipe?.setSize(el.clientWidth, el.clientHeight);
      // Phone turned (or window reshaped past square): re-frame with the long map axis along the long screen axis.
      const portrait = this.isPortrait();
      if (portrait !== this.portrait) {
        this.portrait = portrait;
        if (this.built) this.flyTo(this.store.get().viewBoard);
      }
    }
  }

  // ---- pointer --------------------------------------------------------------------------------------------------------

  private readonly prevent = (e: Event) => e.preventDefault();
  /** Middle button: no autoscroll (it pans / pings here). */
  private readonly onMouseDown = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };

  private rayAt(x: number, y: number) {
    const el = this.engine!.renderer.domElement;
    this.ndc.set((x / el.clientWidth) * 2 - 1, -(y / el.clientHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.engine!.camera);
    return this.raycaster.ray;
  }

  private groundAt(x: number, y: number, out = new THREE.Vector3()) {
    return this.rayAt(x, y).intersectPlane(this.ground, out);
  }

  private local(e: PointerEvent | WheelEvent) {
    const r = this.engine!.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (this.paused) return;
    this.audio?.unlock();
    const { x, y } = this.local(e);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (e.button === 1) e.preventDefault();
    this.presses.set(e.pointerId, {
      id: e.pointerId,
      button: e.button,
      type: e.pointerType,
      x0: x,
      y0: y,
      x,
      y,
      moved: false,
      grab: this.groundAt(x, y),
      alt: e.altKey,
      shift: e.shiftKey,
      t0: performance.now(),
    });
    if (e.pointerType === 'touch') this.startPinch();
  };

  private touches() {
    return [...this.presses.values()].filter((p) => p.type === 'touch');
  }

  private startPinch() {
    const t = this.touches();
    if (t.length >= 2) {
      this.pinch = { span: Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y) || 1, dist: this.goal.dist };
      for (const p of t) {
        p.moved = true;
        p.grab = null;
      }
      const mx = (t[0].x + t[1].x) / 2;
      const my = (t[0].y + t[1].y) / 2;
      t[0].grab = this.groundAt(mx, my);
    }
  }

  private readonly onPointerMove = (e: PointerEvent) => {
    const { x, y } = this.local(e);
    if (e.pointerType === 'mouse') {
      this.pointer = { x, y, inside: true, mouse: true, moved: true };
    } else this.pointer = { ...this.pointer, x, y, mouse: false };
    const p = this.presses.get(e.pointerId);
    if (!p || this.paused) return;
    p.x = x;
    p.y = y;
    if (!p.moved && Math.hypot(x - p.x0, y - p.y0) > CLICK_SLOP) p.moved = true;
    const t = this.touches();
    if (p.type === 'touch' && t.length >= 2 && this.pinch) {
      const span = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y) || 1;
      this.goal.dist = Math.max(MIN_DIST, Math.min(this.maxDist, (this.pinch.dist * this.pinch.span) / span));
      this.cam.dist = this.goal.dist;
      this.applyCamera();
      this.dragTo(t[0].grab, (t[0].x + t[1].x) / 2, (t[0].y + t[1].y) / 2);
      return;
    }
    // Drag pans: left (when not placing), right, middle, one finger. The grabbed ground point stays under the pointer.
    const placingMouseLeft = p.type === 'mouse' && p.button === 0 && this.store.get().placing !== null;
    if (p.moved && !placingMouseLeft) this.dragTo(p.grab, x, y);
  };

  private dragTo(grab: THREE.Vector3 | null, x: number, y: number) {
    if (!grab) return;
    const hit = this.groundAt(x, y, this.tmpV);
    if (!hit) return;
    const dx = grab.x - hit.x;
    const dz = grab.z - hit.z;
    this.goal.x += dx;
    this.goal.z += dz;
    this.clampGoal();
    this.cam.x = this.goal.x;
    this.cam.z = this.goal.z;
    this.applyCamera();
  }

  private readonly onPointerUp = (e: PointerEvent) => {
    const p = this.presses.get(e.pointerId);
    this.presses.delete(e.pointerId);
    if (p?.type === 'touch') {
      if (this.touches().length < 2) this.pinch = null;
      // Lifting one finger of a pinch: the other keeps panning from where it is.
      for (const q of this.touches()) {
        q.grab = this.groundAt(q.x, q.y);
        q.moved = true;
      }
    }
    if (!p || this.paused || e.type === 'pointercancel') return;
    if (p.moved) return;
    const quick = performance.now() - p.t0 < 600;
    if (p.button === 1 || (p.button === 0 && p.alt)) {
      this.ping(p.x, p.y);
      return;
    }
    if (p.button === 2) {
      if (this.store.get().placing) this.setPlacing(null);
      else this.select(null);
      return;
    }
    if (p.button !== 0 || (p.type === 'touch' && !quick)) return;
    this.click(p.x, p.y, p.shift || e.shiftKey, p.type === 'touch');
  };

  private readonly onPointerLeave = () => {
    this.pointer.inside = false;
  };

  private readonly onBlur = () => {
    this.keys.clear();
    this.pointer.inside = false;
    // Alt-Tab while holding Tab: the keyup never arrives here.
    if (this.store.get().scoresOpen) this.store.set({ scoresOpen: false });
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.paused) return;
    const { x, y } = this.local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    const before = this.goal.dist;
    const next = Math.max(MIN_DIST, Math.min(this.maxDist, before * Math.exp(delta * 0.0013)));
    // Zoom towards the point under the cursor.
    const hit = this.groundAt(x, y);
    if (hit && next < before) {
      const k = 1 - next / before;
      this.goal.x += (hit.x - this.goal.x) * k;
      this.goal.z += (hit.z - this.goal.z) * k;
    }
    this.goal.dist = next;
  };

  private ping(x: number, y: number) {
    const hit = this.groundAt(x, y);
    if (hit) this.send({ k: 'ping', x: Math.round(hit.x * 100) / 100, z: Math.round(hit.z * 100) / 100 });
  }

  private click(x: number, y: number, keep: boolean, touch: boolean) {
    const placing = this.store.get().placing;
    if (placing) {
      const cell = touch ? this.touchCellAt(x, y) : this.cellAtScreen(x, y);
      if (!cell) return;
      if (touch && (!this.touchGhost || this.touchGhost.col !== cell.col || this.touchGhost.row !== cell.row)) {
        // First tap moves the ghost, a second tap on the same cell builds.
        this.touchGhost = { col: cell.col, row: cell.row };
        this.audio?.play('hover');
        return;
      }
      const why = this.placeProblem(placing, cell.b, cell.col, cell.row);
      if (why) {
        this.toast(why, 'bad');
        this.audio?.play('deny');
        return;
      }
      this.send({ k: 'build', t: placing, x: cell.col, y: cell.row });
      this.touchGhost = null;
      if (!keep) this.setPlacing(null);
      return;
    }
    const id = this.units?.pickTower(this.rayAt(x, y)) ?? null;
    if (id !== null) {
      this.select(id);
      this.audio?.play('click');
    } else this.select(null);
  }

  /** The board you build on: co-op the shared one, versus your own. */
  private buildBoard() {
    return this.mode === 'coop' ? 0 : this.myBoard();
  }

  private myBoard() {
    if (this.mode === 'coop') return 0;
    const own = this.boards.findIndex((b) => b.own === this.ctx.you);
    if (own >= 0) return own;
    return this.latest?.pl.find((p) => p.id === this.ctx.you)?.b ?? this.initBoard ?? 0;
  }

  /** Versus: watching a match you have no board in. */
  private isSpectator() {
    return this.mode === 'vs' && this.myBoard() < 0;
  }

  private cellAtScreen(x: number, y: number) {
    const def = this.def;
    if (!def) return null;
    const hit = this.groundAt(x, y);
    if (!hit) return null;
    const b = this.buildBoard();
    const o = this.origins[b];
    if (!o) return null;
    const { col, row } = worldToCell(def, o, hit.x, hit.z);
    if (row < 0 || col < 0 || row >= def.grid.length || col >= def.grid[0].length) return null;
    return { b, col, row };
  }

  /**
   * Touch placement: fingers are blunt, so a tap snaps to the nearest open, free cell within about one cell of where
   * it landed (the tapped cell itself when it is open).
   */
  private touchCellAt(x: number, y: number) {
    const def = this.def;
    const hit = this.groundAt(x, y);
    if (!def || !hit) return null;
    const b = this.buildBoard();
    const o = this.origins[b];
    if (!o) return null;
    const raw = worldToCell(def, o, hit.x, hit.z);
    const rows = def.grid.length;
    const cols = def.grid[0].length;
    const reach = G.cell * 1.15;
    let best: { b: number; col: number; row: number } | null = null;
    let bestD = Infinity;
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const col = raw.col + dc;
        const row = raw.row + dr;
        if (row < 0 || col < 0 || row >= rows || col >= cols) continue;
        if (!isBuildableChar(cellAt(def, col, row))) continue;
        if (this.towerAt(b, col, row)) continue;
        const p = cellToWorld(def, o, col + 0.5, row + 0.5);
        const d = Math.hypot(p.x - hit.x, p.z - hit.z);
        if (d < bestD && d <= reach) {
          bestD = d;
          best = { b, col, row };
        }
      }
    if (best) return best;
    if (raw.row < 0 || raw.col < 0 || raw.row >= rows || raw.col >= cols) return null;
    return { b, col: raw.col, row: raw.row };
  }

  private towerAt(b: number, col: number, row: number) {
    for (const t of this.towers.values()) if (t.b === b && t.x === col && t.y === row) return true;
    return false;
  }

  /** Why a tower cannot go here (null = it can). */
  private placeProblem(kind: TowerKind, b: number, col: number, row: number): string | null {
    const def = this.def;
    if (!def) return 'Not ready';
    if (!isBuildableChar(cellAt(def, col, row))) return 'Build on open grass';
    for (const t of this.towers.values()) if (t.b === b && t.x === col && t.y === row) return 'A tower already stands here';
    if (this.store.get().gold < TOWERS[kind].levels[0].cost) return 'Not enough gold';
    if (this.store.get().phase === 'over') return 'The match is over';
    return null;
  }

  private updatePlacement() {
    const placing = this.store.get().placing;
    const units = this.units!;
    if (!placing || !this.def) {
      units.ghost(null);
      return;
    }
    let cell: { b: number; col: number; row: number } | null = null;
    if (this.touchGhost) cell = { b: this.buildBoard(), ...this.touchGhost };
    else if (this.pointer.inside && this.pointer.mouse) cell = this.cellAtScreen(this.pointer.x, this.pointer.y);
    if (!cell) {
      units.ghost(null);
      return;
    }
    const p = cellToWorld(this.def, this.origins[cell.b], cell.col + 0.5, cell.row + 0.5);
    const ok = this.placeProblem(placing, cell.b, cell.col, cell.row) === null;
    units.ghost({ kind: placing, x: p.x, z: p.z, ok, range: TOWERS[placing].levels[0].range });
  }

  private cursorAt = 0;
  private cursor = '';

  /** Pointer cursor over towers, crosshair while placing, grab while dragging (checked ~12 times a second). */
  private updateCursor(now: number) {
    if (now - this.cursorAt < 0.08) return;
    this.cursorAt = now;
    let c = 'default';
    if (this.presses.size && [...this.presses.values()].some((p) => p.moved)) c = 'grabbing';
    else if (this.store.get().placing) c = 'crosshair';
    else if (this.pointer.inside && this.pointer.mouse && this.units?.pickTower(this.rayAt(this.pointer.x, this.pointer.y)) != null) c = 'pointer';
    if (c !== this.cursor) {
      this.cursor = c;
      this.engine!.renderer.domElement.style.cursor = c;
    }
  }

  private setPlacing(kind: TowerKind | null) {
    if (kind && (this.store.get().phase === 'over' || this.buildBoard() < 0)) kind = null;
    this.touchGhost = null;
    if (kind) this.select(null);
    if (kind !== this.store.get().placing) this.audio?.play('click', { amount: 0.5 });
    this.store.set({ placing: kind });
    if (!kind) this.units?.ghost(null);
  }

  // ---- selection ------------------------------------------------------------------------------------------------------

  private select(id: number | null) {
    if (id !== null && !this.towers.has(id)) id = null;
    this.selectedId = id;
    this.units?.select(id);
    this.refreshSelected();
  }

  private refreshSelected() {
    const id = this.selectedId;
    const t = id !== null ? this.towers.get(id) : undefined;
    if (!t) {
      if (this.store.get().selected) this.store.set({ selected: null });
      this.selectedId = null;
      return;
    }
    const owner = this.room.players.find((p) => p.id === t.own);
    const sel: HudSelected = {
      tower: { ...t },
      ownerName: owner?.name ?? 'Someone',
      ownerColor: owner?.color ?? 0xffffff,
      mine: t.own === this.ctx.you,
      upCost: t.lv < 3 ? TOWERS[t.k].levels[t.lv as 1 | 2].cost : null,
      sellValue: this.undoable(t.id) ? t.spent : Math.floor(t.spent * G.sellRefund),
      flags: this.towerLive.get(t.id)?.f ?? 0,
    };
    const prev = this.store.get().selected;
    if (
      prev &&
      prev.tower.id === sel.tower.id &&
      prev.sellValue === sel.sellValue &&
      prev.tower.lv === sel.tower.lv &&
      prev.tower.tm === sel.tower.tm &&
      prev.tower.spent === sel.tower.spent &&
      prev.flags === sel.flags &&
      prev.ownerName === sel.ownerName &&
      prev.ownerColor === sel.ownerColor
    )
      return;
    this.store.set({ selected: sel });
  }

  /** Selling now refunds everything: still the build phase the tower was built in (server rule in sim.ts sell). */
  private undoable(id: number) {
    const s = this.latest;
    const built = this.builtIn.get(id);
    return !!s && s.ph === 'build' && built !== undefined && built === s.wave;
  }

  private upgrade(id: number) {
    const t = this.towers.get(id);
    if (!t) return;
    if (t.lv >= 3) {
      this.audio?.play('deny');
      return;
    }
    if (this.store.get().gold < TOWERS[t.k].levels[t.lv as 1 | 2].cost) {
      this.toast('Not enough gold', 'bad');
      this.audio?.play('deny');
      return;
    }
    this.send({ k: 'up', id });
  }

  private sell(id: number) {
    if (!this.towers.has(id)) return;
    this.send({ k: 'sell', id });
  }

  private cycleTarget(id: number) {
    const t = this.towers.get(id);
    if (!t || !TOWERS[t.k].targets || t.own !== this.ctx.you) return;
    this.send({ k: 'tm', id, tm: ((t.tm + 1) % 4) as TargetMode });
    this.audio?.play('click');
  }

  // ---- keyboard -------------------------------------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e)) return;
    if (e.code === 'Escape') {
      // Cancel placement / deselect before the room's escape menu sees the key.
      if (!this.paused && (this.store.get().placing || this.selectedId !== null)) {
        if (this.store.get().placing) this.setPlacing(null);
        else this.select(null);
        e.stopImmediatePropagation();
        e.preventDefault();
      }
      return;
    }
    if (this.paused || e.ctrlKey || e.metaKey) return;
    this.audio?.unlock();
    const code = e.code;
    // Tab opens the scores only while nothing focusable has focus; otherwise it keeps moving focus through the HUD.
    const tabScores = code === 'Tab' && this.focusIsGame();
    if (code === 'Tab' && !tabScores) return;
    if (code.startsWith('Arrow') || code === 'Tab' || code === 'Space' || code === 'Backspace') e.preventDefault();
    this.keys.add(code);
    if (e.repeat) return;
    const sel = this.selectedId;
    const kind = TOWER_KINDS.find((k) => `Digit${TOWERS[k].key}` === code || `Numpad${TOWERS[k].key}` === code);
    if (kind) {
      this.setPlacing(this.store.get().placing === kind ? null : kind);
      return;
    }
    switch (code) {
      case 'KeyQ':
        this.goal.yaw += Math.PI / 2;
        return;
      case 'KeyE':
        this.goal.yaw -= Math.PI / 2;
        return;
      case 'Home':
      case 'Space':
      case 'KeyF':
        this.home();
        return;
      case 'KeyU':
        if (sel !== null) this.upgrade(sel);
        return;
      case 'KeyX':
      case 'Delete':
      case 'Backspace':
        if (sel !== null && this.towers.get(sel)?.own === this.ctx.you) this.sell(sel);
        return;
      case 'KeyT':
        if (sel !== null) this.cycleTarget(sel);
        return;
      case 'KeyR':
        this.actions.ready();
        return;
      case 'Tab':
        this.store.set({ scoresOpen: true });
        return;
      case 'Equal':
      case 'NumpadAdd':
        this.goal.dist = Math.max(MIN_DIST, this.goal.dist / 1.25);
        return;
      case 'Minus':
      case 'NumpadSubtract':
        this.goal.dist = Math.min(this.maxDist, this.goal.dist * 1.25);
        return;
    }
  };

  private focusIsGame() {
    const a = document.activeElement;
    return !a || a === document.body || a === document.documentElement || a === this.engine?.renderer.domElement;
  }

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    if (e.code === 'Tab' && this.store.get().scoresOpen) this.store.set({ scoresOpen: false });
  };

  // ---- HUD ------------------------------------------------------------------------------------------------------------

  private playerInfo(id: string): PlayerInfo | undefined {
    return this.room.players.find((p) => p.id === id);
  }

  private playerName(id: string) {
    return this.playerInfo(id)?.name ?? 'Someone';
  }

  private playerColor(id: string) {
    return this.playerInfo(id)?.color ?? 0xffffff;
  }

  private boardName(b: number) {
    if (this.mode === 'coop') return 'the garden';
    const own = this.boards[b]?.own;
    if (!own) return `Garden ${b + 1}`;
    if (own === this.ctx.you) return 'your garden';
    return `${this.playerName(own)}'s garden`;
  }

  private refreshBoards() {
    const s = this.latest;
    const boards: HudBoard[] = this.boards.map((bi, i) => {
      const bs = s?.bd.find((x) => x.b === i);
      const own = bi.own;
      return {
        b: i,
        own,
        name: this.mode === 'coop' ? 'The Garden' : own ? this.playerName(own) : `Garden ${i + 1}`,
        color: own ? this.playerColor(own) : COOP_COLOR,
        lives: bs?.lives ?? G.lives,
        out: !!bs?.out || this.outPlaces.has(i),
        // Late joiners never saw the `out` event: the score table knows the finishing place too.
        place: this.outPlaces.get(i) ?? (bs?.out && own ? this.store.get().scores.find((sc) => sc.id === own)?.place : undefined),
      };
    });
    const hud = this.store.get();
    const focus = this.mode === 'coop' ? 0 : hud.viewBoard;
    const lives = boards[focus]?.lives ?? G.lives;
    const same =
      hud.boards.length === boards.length &&
      hud.boards.every((o, i) => {
        const n = boards[i];
        return o.lives === n.lives && o.out === n.out && o.name === n.name && o.color === n.color && o.place === n.place;
      });
    if (same && hud.lives === lives) return;
    this.store.set({ boards, lives, maxLives: G.lives });
  }

  private refreshPlayers() {
    const s = this.latest;
    const room = this.room.players;
    const players: HudPlayer[] = [];
    const ids = s ? s.pl.map((p) => p.id) : room.map((p) => p.id);
    for (const id of ids) {
      const ps = s?.pl.find((p) => p.id === id);
      const info = room.find((p) => p.id === id);
      players.push({
        id,
        name: info?.name ?? 'Player',
        color: info?.color ?? 0xffffff,
        bot: info?.bot ?? false,
        gold: ps?.gold ?? 0,
        income: ps?.inc ?? 0,
        ready: ps?.rd === 1,
        b: ps?.b ?? (this.mode === 'coop' ? 0 : this.boards.findIndex((b) => b.own === id)),
      });
    }
    const prev = this.store.get().players;
    const same =
      prev.length === players.length &&
      prev.every((o, i) => {
        const n = players[i];
        return o.id === n.id && o.gold === n.gold && o.income === n.income && o.ready === n.ready && o.name === n.name && o.color === n.color && o.b === n.b;
      });
    if (!same) this.store.set({ players });
  }

  private refreshNext(wave: number) {
    const def = this.def;
    const n = wave + 1;
    if (!def || (this.mode === 'coop' && n > G.coopWaves)) {
      this.store.set({ next: [], bossNext: false });
      return;
    }
    const defenders = this.latest?.pl.length ?? this.room.players.length;
    const scale = this.mode === 'coop' ? coopCount(defenders) : 1;
    const counts = new Map<EnemyKind, number>();
    for (const g of waveSpawns(n, def.routes.length)) {
      const per = g.kind === 'skitter' ? SKITTER_PACK : 1;
      const count = (g.kind === 'colossus' ? g.count : Math.max(1, Math.round(g.count * scale))) * per;
      counts.set(g.kind, (counts.get(g.kind) ?? 0) + count);
    }
    this.store.set({ next: [...counts].map(([kind, count]) => ({ kind, count })), bossNext: n % 10 === 0 });
  }

  private toast(text: string, tone: Toast['tone']) {
    const at = performance.now();
    const toasts = [...this.store.get().toasts.filter((t) => t.text !== text), { key: ++this.toastKey, text, tone, at }];
    this.store.set({ toasts: toasts.slice(-5) });
  }

  private pruneToasts() {
    const now = performance.now();
    const t = this.store.get().toasts;
    const keep = t.filter((x) => now - x.at < (x.tone === 'boss' ? BOSS_TOAST_LIFE : TOAST_LIFE));
    if (keep.length !== t.length) this.store.set({ toasts: keep });
  }

  // ---- quality --------------------------------------------------------------------------------------------------------

  private setQuality(q: Quality) {
    saveQuality(q);
    this.store.set({ quality: q });
    this.world?.setQuality(q);
    this.pipe?.setQuality(q);
    this.fx?.setQuality(q);
    this.ambience?.setQuality?.(q);
    this.engine?.setMaxPixelRatio(PIXEL_RATIO[q]);
    this.sizeKey = '';
  }

  /** Very low frame rates for a while drop the graphics to low (once; the setting still persists). */
  private autoQuality(dt: number) {
    const engine = this.engine;
    if (!engine || document.hidden || this.store.get().quality === 'low') return;
    if (engine.fps < 20) this.slowFor += dt;
    else this.slowFor = Math.max(0, this.slowFor - dt * 2);
    if (this.slowFor > 8) {
      this.slowFor = 0;
      this.setQuality('low');
      this.toast('Graphics set to low to keep things smooth', 'info');
    }
  }

  // ---- misc -----------------------------------------------------------------------------------------------------------

  private send(m: Parameters<ClientContext['socket']['sendGame']>[0]) {
    this.ctx.socket.sendGame(m);
  }

  private devHook() {
    return {
      client: this,
      store: this.store,
      actions: this.actions,
      /** Point the camera at world x/z from `dist` metres (snaps). */
      lookAt: (x: number, z: number, dist?: number) => this.lookAt(x, z, dist),
      home: () => this.home(true),
      viewBoard: (b: number) => this.flyTo(b, true),
      rotate: (quarterTurns: number) => {
        this.goal.yaw += (quarterTurns * Math.PI) / 2;
        this.cam.yaw = this.goal.yaw;
      },
      camera: () => ({ ...this.cam }),
      /** CSS pixels per cell (width) at the screen centre for the current zoom. */
      cellPx: () => this.cellPx(this.cam.dist),
      state: () => ({
        built: this.built,
        map: this.builtMap,
        mode: this.mode,
        towers: [...this.towers.values()],
        enemies: this.latest?.en.length ?? 0,
        snapshot: this.latest,
        delay: this.timeline.delay,
        fps: this.engine?.fps ?? 0,
      }),
      /** World x/z of a cell's centre on board b (for scripted clicks). */
      cellToWorld: (b: number, col: number, row: number) => (this.def ? cellToWorld(this.def, this.origins[b], col + 0.5, row + 0.5) : null),
      /** Screen position (CSS px within the canvas) of a world point. */
      toScreen: (x: number, z: number, y = 0) => {
        const cam = this.engine!.camera;
        const el = this.engine!.renderer.domElement;
        const v = new THREE.Vector3(x, y, z).project(cam);
        return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight };
      },
    };
  }
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

