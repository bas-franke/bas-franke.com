// Rockets client: first-person view with client-side prediction for the local player, interpolation for everyone
// else, extrapolated rockets, and a few effects. The server is authoritative; this only predicts and shows.

import * as THREE from 'three';
import { clamp, fromTuple, hdist, lookDir, segmentBoxes, type Vec3, v3, vadd, vscale, vsub } from '@shared/math';
import type { GameServerMsg, RoomView } from '@shared/protocol';
import { RK } from '@shared/rockets/constants';
import type { ItemKind, ItemSpawn } from '@shared/rockets/items';
import type { MapData } from '@shared/rockets/map';
import { type Body, eyePosition, stepBody } from '@shared/rockets/physics';
import type { PlayerSnap, RocketsEvent, RocketsInput, RocketsServerMsg, RocketsSnapshot, ScoreRow } from '@shared/rockets/protocol';
import { sfx } from '../../engine/audio';
import { Effects, LightPool, TRAIL_STEP, nearestSurface } from '../../engine/effects';
import { Engine, colorHex, makeLabel } from '../../engine/engine';
import { Input } from '../../engine/input';
import { SnapshotTimeline, damp, lerpAngle } from '../../engine/interp';
import { INK } from '../../engine/toon';
import { TouchInput } from '../../engine/touch';
import { type ClientContext, type GameClient, createStore } from '../types';
import { type ArenaView, addArenaLights, buildArena } from './arena';
import { type DroidPiece, WARHEAD_REST_Z, buildDroid, buildDroidPieces, buildLauncher, buildPickup, buildRocket, updateDroidPieces, warmupModels } from './models';
import { QUALITY, type Quality, applyInput, applyQuality, settings, verticalFov } from './settings';

export interface FeedLine {
  id: number;
  text: string;
  at: number;
  /** Killer and victim ids, for the HUD's coloured kill feed. */
  by?: string;
  v?: string;
  self?: boolean;
}

export interface RocketsHudState {
  ready: boolean;
  /** Name of the map this match is on. */
  mapName: string;
  fps: number;
  hp: number;
  dead: boolean;
  respawnIn: number;
  left: number;
  scores: ScoreRow[];
  feed: FeedLine[];
  hitAt: number;
  hurtAt: number;
  locked: boolean;
  dragLook: boolean;
  paused: boolean;
  ended: { scores: ScoreRow[]; winner: string | null } | null;
  message: string;
  /** Seconds of start countdown left (players are frozen while it runs). */
  countdown?: number;
  overtime?: boolean;
  armor?: number;
  /** Horizontal speed in m/s. */
  speed?: number;
  /** this.time of our last shot (reload ring). */
  firedAt?: number;
  /** Screen angle (radians, 0 = ahead, clockwise) towards whoever last hurt us. */
  hurtDir?: number;
}

interface Remote {
  group: THREE.Group;
  bobNode: THREE.Object3D | null;
  torso: THREE.Object3D | null;
  head: THREE.Object3D | null;
  aim: THREE.Object3D | null;
  recoil: THREE.Object3D | null;
  thrust: THREE.Object3D | null;
  /** Fire kick, 1 at a shot and decaying. */
  kick: number;
  /** Ground flag and vertical speed from the latest snapshot, for landing dust. */
  ground: boolean;
  vy: number;
  label: THREE.Sprite;
  /** Team-coloured arrow over the head of far-away droids, which are only a few pixels tall by then. */
  marker: THREE.Sprite;
  /** The label's scale at 1x, so it can grow with distance. */
  labelW: number;
  labelH: number;
  color: number;
  name: string;
  bob: number;
  /** Frame number this remote was last in a snapshot sample. */
  seen: number;
}

interface RocketView {
  group: THREE.Group;
  pos: Vec3;
  vel: Vec3;
  /** performance.now()/1000 when pos/vel were last set. */
  at: number;
  confirmed: boolean;
  /** Our own shot: simulated locally from the moment we fired, so snapshots (which lag behind) never pull it back. */
  local: boolean;
  born: number;
  light: THREE.PointLight | null;
  flame: THREE.Object3D | null;
  /** Visual offset from the true path at birth (own shots leave the viewmodel muzzle); it fades out quickly. */
  off: Vec3 | null;
  /** Distance travelled since the last trail puff. */
  trail: number;
  /** Own rocket that reached a wall on our side: parked and hidden until the server's boom arrives. */
  stopped: boolean;
}

/** A destroyed droid's pieces, flying for a couple of seconds. */
interface Wreck {
  pieces: DroidPiece[];
  floorY: number;
  life: number;
}

/** Which model each item kind uses, and its scale. */
const ITEM_LOOK: Record<ItemKind, { model: 'armor' | 'mega'; scale: number; color: number; lift: number }> = {
  shard: { model: 'armor', scale: 0.45, color: 0xffd23a, lift: 0.35 },
  armor: { model: 'armor', scale: 1, color: 0xffd23a, lift: 0.55 },
  mega: { model: 'mega', scale: 1, color: 0xff6fb5, lift: 0.75 },
};

const ROCKET_COLOR = 0xffa14a;
/** Viewmodel placement relative to the camera: Quake-style, big and low on the right, barrel angled in at the crosshair. */
const VM_POS = { x: 0.235, y: -0.24, z: -0.34 };
const VM_YAW = 0.085;
const VM_PITCH = 0.06;
const VM_SCALE = 0.48;
/** The bore's mouth in launcher model space (see models.ts buildLauncher). */
const VM_MUZZLE = new THREE.Vector3(0, 0.07, -0.93);
/** The viewmodel draws last, after a depth clear, so it never pokes into walls. */
const VM_ORDER = 100;
/** How fast a fired rocket's visual offset from its true path fades (seconds). */
const ROCKET_BLEND = 0.08;

/** A damped spring for camera and viewmodel motion; kicks add velocity. Substeps so stiff springs stay stable. */
class Spring {
  x = 0;
  v = 0;
  constructor(
    private readonly k: number,
    private readonly c: number,
  ) {}
  step(dt: number) {
    const n = Math.max(1, Math.ceil(dt * 120));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.x * this.k - this.v * this.c) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
  reset(x = 0) {
    this.x = x;
    this.v = 0;
  }
}

const smoothstep = (t: number) => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};

/** A downward ink-outlined arrow, white so each droid's marker material can tint it. Shared by all markers. */
let markerTex: THREE.CanvasTexture | null = null;
function markerTexture() {
  if (markerTex) return markerTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.moveTo(32, 58);
  g.lineTo(8, 12);
  g.lineTo(56, 12);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.fill();
  g.lineJoin = 'round';
  g.lineWidth = 7;
  g.strokeStyle = colorHex(INK);
  g.stroke();
  markerTex = new THREE.CanvasTexture(c);
  markerTex.colorSpace = THREE.SRGBColorSpace;
  return markerTex;
}

const scratchV = new THREE.Vector3();
const scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const forward = new THREE.Vector3();

export class RocketsClient implements GameClient {
  readonly hud = createStore<RocketsHudState>({
    ready: false,
    mapName: '',
    fps: 0,
    hp: 100,
    dead: false,
    respawnIn: 0,
    left: RK.matchSeconds,
    scores: [],
    feed: [],
    hitAt: 0,
    hurtAt: 0,
    locked: false,
    dragLook: false,
    paused: false,
    ended: null,
    message: '',
    countdown: 0,
    overtime: false,
  });

  private engine?: Engine;
  private input?: Input;
  /** On-screen sticks and buttons for phones; the HUD mounts its overlay with this. */
  readonly touch = new TouchInput();
  private unsubSettings?: () => void;
  private effects?: Effects;
  private arena?: ArenaView;
  private map?: MapData;
  private readonly snaps = new SnapshotTimeline<RocketsSnapshot>();
  private readonly remotes = new Map<string, Remote>();
  private readonly rockets = new Map<string, RocketView>();
  private readonly packs: THREE.Group[] = [];
  private readonly packBase: number[] = [];
  private itemSpawns: ItemSpawn[] = [];
  private readonly items: THREE.Group[] = [];
  private readonly itemBase: number[] = [];
  private readonly wrecks: Wreck[] = [];
  private readonly boomNormal = v3();
  private readonly nextPos = v3();
  private viewInk: [THREE.Material, THREE.Material][] = [];
  private viewmodel?: THREE.Group;
  private readonly me = {
    body: { pos: v3(0, 50, 0), vel: v3(), onGround: false } as Body,
    /** Body position before the latest sim tick; the camera renders between it and body.pos. */
    prevPos: v3(0, 50, 0),
    yaw: 0,
    pitch: 0,
    seq: 0,
    pending: [] as RocketsInput[],
    dead: true,
    nextFire: 0,
    smooth: v3(),
    deathPos: null as Vec3 | null,
    respawnAt: 0,
  };
  private acc = 0;
  private outbox: RocketsInput[] = [];
  private lastSend = 0;
  private recoil = 0;
  private reload = 1;
  private warhead: THREE.Object3D | null = null;
  private muzzleGlow: THREE.PointLight | null = null;
  private rocketLights?: LightPool;
  // Game feel: all camera and viewmodel motion is visual only and never touches aim or prediction.
  private bob = 0;
  private bobAmp = 0;
  /** Screen-shake trauma, 0..1; the shake strength is its square so small knocks stay gentle. */
  private trauma = 0;
  private shakeT = 0;
  /** Hit-stop: seconds left during which camera and viewmodel motion run in slow motion. */
  private freeze = 0;
  private lookDX = 0;
  private lookDY = 0;
  private swayX = 0;
  private swayY = 0;
  private airY = 0;
  private roll = 0;
  private fov = verticalFov(settings.get().fov);
  private readonly kickZ = new Spring(260, 22);
  private readonly kickPitch = new Spring(180, 14);
  private readonly punchPitch = new Spring(140, 16);
  private readonly punchYaw = new Spring(140, 16);
  private readonly land = new Spring(110, 13);
  private readonly raise = new Spring(90, 17);
  private wasDead = true;
  private deathT = 0;
  private deathYaw = 0;
  private deathPitch = 0;
  private killer: string | null = null;
  private countdown = 0;
  private countdownAt = 0;
  private overtime = false;
  private frameNo = 0;
  private feedId = 0;
  private paused = false;
  private lastHud = 0;
  private time = 0;
  private serverLeft: number = RK.matchSeconds;
  private serverLeftAt = 0;
  private disposed = false;

  constructor(private readonly ctx: ClientContext) {}

  // ---- lifecycle --------------------------------------------------------------------------------------------

  mount(container: HTMLElement) {
    const engine = new Engine(container, { fov: verticalFov(settings.get().fov), near: 0.05, far: 260 });
    this.engine = engine;
    engine.camera.rotation.order = 'YXZ';
    this.input = new Input(engine.renderer.domElement);
    applyInput(this.input);
    this.unsubSettings = settings.subscribe(() => {
      const s = settings.get();
      if (this.input) applyInput(this.input, s);
      const eng = this.engine;
      if (!eng) return;
      // The frame loop eases from here to the new FOV (plus any speed kick).
      eng.camera.fov = this.fov = verticalFov(s.fov);
      eng.camera.updateProjectionMatrix();
      this.applyQualityNow(s.quality);
    });
    this.effects = new Effects(engine.scene);
    this.rocketLights = new LightPool(engine.scene, 3);
    sfx.unlock();
    this.buildViewmodel();
    if (this.map) this.buildWorld();
    this.hud.set({ ready: true });
    engine.start((dt, now) => this.frame(dt, now));
    // Dev-only handle for screenshots: __rockets.debugCam = { x, y, z, yaw, pitch } parks the camera there.
    if (import.meta.env.DEV) (window as unknown as { __rockets: RocketsClient }).__rockets = this;
  }

  /** Whether raw (unaccelerated) mouse input works here; null until pointer lock has been tried. */
  get rawSupported() {
    return this.input?.rawSupported ?? null;
  }

  /** Dev aid: when set, the camera sits here instead of following the player. */
  debugCam: { x: number; y: number; z: number; yaw: number; pitch: number } | null = null;

  // ---- game-feel hooks (HUD, effects or future weapons can call these) -------------------------------------------

  /** Adds screen-shake trauma (0..1). The shake is smooth noise scaled by trauma squared, and fades in about a second. */
  addTrauma(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Briefly runs camera and viewmodel motion in slow motion, so a hit lands with weight. Aim and sim are untouched. */
  hitStop(seconds: number) {
    this.freeze = Math.max(this.freeze, seconds);
  }

  /** Knocks the view by a spring impulse (radians per second); it settles back on its own. */
  punch(pitch: number, yaw: number) {
    const k = settings.get().reducedMotion ? 0.3 : 1;
    this.punchPitch.v += pitch * k;
    this.punchYaw.v += yaw * k;
  }

  unmount() {
    this.disposed = true;
    this.input?.dispose();
    this.touch.dispose();
    this.unsubSettings?.();
    this.effects?.dispose();
    this.arena?.dispose();
    this.engine?.dispose();
    if (import.meta.env.DEV) delete (window as unknown as { __rockets?: RocketsClient }).__rockets;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    if (this.input) {
      this.input.enabled = !paused;
      if (paused) this.input.exitLock();
      this.input.clearOnce();
    }
    this.touch.enabled = !paused;
    this.hud.set({ paused });
  }

  onRoom(room: RoomView) {
    for (const [id, r] of this.remotes) {
      const p = room.players.find((q) => q.id === id);
      if (!p || r.name !== p.name || r.color !== p.color) this.removeRemote(id);
    }
  }

  // ---- messages -----------------------------------------------------------------------------------------------

  onMessage(m: GameServerMsg) {
    const msg = m as RocketsServerMsg;
    switch (msg.k) {
      case 'init':
        this.map = msg.map;
        this.itemSpawns = msg.items ?? [];
        this.serverLeft = msg.left;
        this.serverLeftAt = this.time;
        this.hud.set({ scores: msg.scores, left: msg.left, mapName: msg.map.name });
        if (this.engine) this.buildWorld();
        break;
      case 'snap':
        this.onSnapshot(msg.s);
        break;
      case 'ev':
        for (const e of msg.e) this.onEvent(e);
        break;
      case 'score':
        this.hud.set({ scores: msg.scores });
        break;
      case 'end':
        this.hud.set({ ended: { scores: msg.scores, winner: msg.winner }, scores: msg.scores });
        this.input?.exitLock();
        if (msg.winner === this.ctx.you) sfx.play('win');
        break;
    }
  }

  private onSnapshot(s: RocketsSnapshot) {
    // Keyed by simulation time, not arrival time, so network jitter and bursts do not show as stutter.
    this.snaps.push(s, s.tick * RK.dt);
    this.snaps.trim(1);
    this.serverLeft = s.left;
    this.serverLeftAt = this.time;
    const extra = s as { cd?: number; ot?: 1 };
    this.countdown = extra.cd ?? 0;
    this.countdownAt = this.time;
    this.overtime = !!extra.ot;
    const own = s.pl.find((p) => p.id === this.ctx.you);
    if (own) {
      this.reconcile(own);
      const hp = Math.max(0, Math.round(own.hp));
      const armor = Math.max(0, Math.round(own.ar ?? 0));
      const h = this.hud.get();
      if (hp !== h.hp || armor !== h.armor) this.hud.set({ hp, armor });
    }
    for (let i = 0; i < this.packs.length; i++) this.packs[i].visible = s.pk.includes(i);
    const it = s.it ?? [];
    for (let i = 0; i < this.items.length; i++) this.items[i].visible = it.includes(i);
    const now = performance.now() / 1000;
    // Where on our clock this snapshot's moment falls, so remote rockets extrapolate from the right time.
    const at = this.snaps.toLocal(s.tick * RK.dt);
    const seen = new Set<string>();
    for (const r of s.rk) {
      seen.add(r.id);
      const view = this.rockets.get(r.id) ?? (r.o === this.ctx.you ? this.adoptLocal(r.id) : null) ?? this.spawnRocket(r.id, fromTuple(r.p), fromTuple(r.v), true, false);
      view.confirmed = true;
      if (view.local) continue;
      view.pos = fromTuple(r.p);
      view.vel = fromTuple(r.v);
      view.at = at;
    }
    for (const [id, view] of this.rockets) {
      if (view.confirmed && !seen.has(id)) this.removeRocket(id);
      else if (!view.confirmed && now - view.born > 1) this.removeRocket(id);
    }
  }

  /**
   * The server names rockets by the input seq it fired on, which can be a tick off from ours. Hand the server's id to
   * our oldest still-unconfirmed shot, so it keeps flying instead of a second copy appearing.
   */
  private adoptLocal(id: string): RocketView | null {
    let bestId: string | null = null;
    let best: RocketView | null = null;
    for (const [key, view] of this.rockets) {
      if (view.local && !view.confirmed && (!best || view.born < best.born)) {
        bestId = key;
        best = view;
      }
    }
    if (!best || bestId === null) return null;
    this.rockets.delete(bestId);
    this.rockets.set(id, best);
    best.confirmed = true;
    return best;
  }

  private reconcile(own: PlayerSnap) {
    const me = this.me;
    const wasDead = me.dead;
    me.dead = own.d === 1;
    if (!this.map) return;
    if (me.dead) {
      me.deathPos ??= { ...me.body.pos };
      me.pending = [];
      return;
    }
    if (wasDead) {
      // Fresh spawn: take the server's view direction and position outright.
      me.yaw = own.y;
      me.pitch = own.pt;
      me.body.pos = fromTuple(own.p);
      me.body.vel = fromTuple(own.v);
      me.body.onGround = own.g === 1;
      me.prevPos = { ...me.body.pos };
      me.smooth = v3();
      me.deathPos = null;
      me.pending = [];
      return;
    }
    const before = { ...me.body.pos };
    me.body.pos = fromTuple(own.p);
    me.body.vel = fromTuple(own.v);
    me.body.onGround = own.g === 1;
    if (own.seq !== undefined) me.pending = me.pending.filter((i) => i.seq > own.seq!);
    for (const i of me.pending) stepBody(me.body, i, this.map);
    const err = vsub(before, me.body.pos);
    const len = Math.hypot(err.x, err.y, err.z);
    // Corrections are eased in visually (the in-between-ticks position shifts with the body, the eased offset takes up
    // the difference). Knockback is not predicted, so a rocket jump at high ping is metres off; only teleports snap.
    if (len < 8) {
      me.smooth = vadd(me.smooth, err);
      me.prevPos = vsub(me.prevPos, err);
    } else {
      me.smooth = v3();
      me.prevPos = { ...me.body.pos };
    }
  }

  private onEvent(e: RocketsEvent) {
    const you = this.ctx.you;
    const eye = eyePosition(this.me.body.pos);
    const dist = (p: Vec3) => hdist(eye, p);
    // No particles or fireballs for a hidden tab: they would pile up and all play at once on return.
    const fx = document.hidden ? undefined : this.effects;
    switch (e.k) {
      case 'fire': {
        if (e.o === you) {
          const view = this.rockets.get(e.id) ?? this.adoptLocal(e.id);
          if (view) view.confirmed = true;
          break;
        }
        const pos = fromTuple(e.p);
        if (!this.rockets.has(e.id)) this.spawnRocket(e.id, pos, fromTuple(e.v), true, false);
        sfx.playAt('fire', pos.x, pos.y, pos.z);
        const shooter = this.remotes.get(e.o);
        if (shooter) shooter.kick = 1;
        break;
      }
      case 'boom': {
        const pos = fromTuple(e.p);
        this.removeRocket(e.id);
        if (fx) {
          const n = this.boomNormal;
          const on = !!this.map && nearestSurface(pos, this.map.boxes, 0.6, n);
          fx.explode(pos, on ? n : null);
        }
        const d = dist(pos);
        if (d < 40) fx?.boom(pos, 1.4 + d * 0.04);
        sfx.playAt('boom', pos.x, pos.y, pos.z);
        // Nearby blasts shake the view; the falloff is steep so distant fights do not rattle you.
        if (d < 14) {
          const near = 1 - d / 14;
          this.addTrauma(near * near * 0.75);
        }
        break;
      }
      case 'hurt':
        if (e.id === you) {
          sfx.play('hurt', 0, e.dmg / 100);
          this.addTrauma(Math.min(0.45, e.dmg / 160));
          // Snap the view away from whoever hit us, and point the HUD's damage arc at them.
          const from = e.by !== you ? this.remotes.get(e.by) : undefined;
          let side = Math.random() - 0.5;
          let hurtDir: number | undefined;
          if (from) {
            const dx = from.group.position.x - eye.x;
            const dz = from.group.position.z - eye.z;
            const yaw = this.me.yaw;
            const right = Math.cos(yaw) * dx - Math.sin(yaw) * dz;
            side = right > 0 ? 1 : -1;
            hurtDir = Math.atan2(right, -Math.sin(yaw) * dx - Math.cos(yaw) * dz);
          }
          this.hud.set({ hurtAt: this.time, hp: Math.max(0, this.hud.get().hp - e.dmg), hurtDir });
          const k = Math.min(1, e.dmg / 60);
          this.punch(-1.1 * k, side * 1.3 * k);
        } else if (e.by === you) {
          this.hud.set({ hitAt: this.time });
          sfx.play('hit', 0, e.dmg / 100);
          this.hitStop(0.045);
          const victim = this.remotes.get(e.id);
          if (victim) {
            const vp = victim.group.position;
            fx?.sparks({ x: vp.x, y: vp.y + 1.1, z: vp.z });
          }
        }
        break;
      case 'kill': {
        const victim = this.name(e.v);
        const text = e.self ? `${victim} blew ${e.v === you ? 'yourself' : 'themselves'} up` : `${this.name(e.by)} rocketed ${victim}`;
        this.feed(text, e.by, e.v, e.self);
        const r = this.remotes.get(e.v);
        if (r && fx && r.group.visible) this.wreck(r, e.self ? undefined : e.by);
        if (e.by === you && !e.self) {
          sfx.play('kill');
          this.hitStop(0.09);
          this.addTrauma(0.12);
        }
        if (e.v === you) {
          this.killer = e.self ? null : e.by;
          sfx.play('die');
          this.me.respawnAt = this.time + RK.respawnDelay;
          this.hud.set({ dead: true, hp: 0 });
        }
        break;
      }
      case 'spawn': {
        const pos = fromTuple(e.p);
        if (e.id !== you) fx?.burst(vadd(pos, v3(0, 1, 0)), 0xffffff, 25, 3, 0.6, 0.8);
        if (e.id === you) {
          sfx.play('spawn');
          this.hud.set({ dead: false, hp: RK.maxHealth });
        } else sfx.playAt('spawn', pos.x, pos.y, pos.z);
        break;
      }
      case 'pack': {
        const pos = this.map?.packs[e.i];
        if (pos) fx?.burst(vadd(pos, v3(0, 0.6, 0)), 0x7cf4c9, 20, 3, 0.5, 1);
        if (e.by === you) {
          sfx.play('health');
          this.hud.set({ hp: Math.max(this.hud.get().hp, Math.min(RK.maxHealth, this.hud.get().hp + RK.healthPackAmount)) });
        } else if (pos) sfx.playAt('health', pos.x, pos.y, pos.z);
        break;
      }
      case 'item': {
        const spawn = this.itemSpawns[e.i];
        const sound = e.t === 'mega' ? 'mega' : 'armor';
        if (spawn) {
          const look = ITEM_LOOK[e.t];
          fx?.burst({ x: spawn.p.x, y: spawn.p.y + look.lift, z: spawn.p.z }, look.color, e.t === 'shard' ? 10 : 22, 3, 0.5, 1);
        }
        if (e.by === you) sfx.play(sound);
        else if (spawn) sfx.playAt(sound, spawn.p.x, spawn.p.y, spawn.p.z);
        break;
      }
      case 'pad': {
        if (e.id === you) break;
        const r = this.remotes.get(e.id);
        if (r) {
          const rp = r.group.position;
          sfx.playAt('pad', rp.x, rp.y, rp.z);
          fx?.padBurst(rp, this.map?.accent ?? 0x7cf4ff);
        }
        break;
      }
    }
  }

  private name(id: string) {
    return this.ctx.room().players.find((p) => p.id === id)?.name ?? 'someone';
  }

  private feed(text: string, by?: string, v?: string, self?: boolean) {
    const line: FeedLine = { id: ++this.feedId, text, at: this.time, by, v, self };
    this.hud.set((s) => ({ feed: [...s.feed.slice(-5), line] }));
  }

  // ---- world ---------------------------------------------------------------------------------------------------

  private buildWorld() {
    const { engine, map } = this;
    if (!engine || !map || this.arena) return;
    addArenaLights(engine.scene, map);
    this.arena = buildArena(map);
    engine.scene.add(this.arena.group);
    for (const pos of map.packs) {
      const pack = buildPickup('health');
      pack.position.set(pos.x, pos.y + 0.55, pos.z);
      engine.scene.add(pack);
      this.packs.push(pack);
      this.packBase.push(pos.y + 0.55);
    }
    for (const spawn of this.itemSpawns) {
      const look = ITEM_LOOK[spawn.k];
      const item = buildPickup(look.model);
      item.scale.setScalar(look.scale);
      item.position.set(spawn.p.x, spawn.p.y + look.lift, spawn.p.z);
      engine.scene.add(item);
      this.items.push(item);
      this.itemBase.push(spawn.p.y + look.lift);
    }
    this.applyQualityNow(settings.get().quality);
    engine.warmup(warmupModels());
  }

  private buildViewmodel() {
    const { engine } = this;
    if (!engine) return;
    const mine = this.ctx.room().players.find((p) => p.id === this.ctx.you);
    const vm = buildLauncher(mine?.color);
    // The viewmodel gets its own copies of the (shared, cached) materials so it can draw in a late pass: transparent
    // materials at full opacity sort by renderOrder after everything opaque, and a depth clear right before them
    // keeps the barrel from sinking into walls when you hug them.
    const own = new Map<THREE.Material, THREE.Material>();
    vm.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = VM_ORDER;
      if (Array.isArray(mesh.material)) return;
      const src = mesh.material;
      let mat = own.get(src);
      if (!mat) {
        mat = src.clone();
        mat.onBeforeCompile = src.onBeforeCompile;
        mat.onBeforeRender = src.onBeforeRender;
        mat.customProgramCacheKey = src.customProgramCacheKey;
        mat.transparent = true;
        own.set(src, mat);
        // Outline copies follow the quality setting's ink switch on the shared originals.
        if ((src as THREE.MeshBasicMaterial).isMeshBasicMaterial && src.side === THREE.BackSide) this.viewInk.push([src, mat]);
      }
      mesh.material = mat;
    });
    const clearGeo = new THREE.BufferGeometry();
    clearGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const clearer = new THREE.Mesh(clearGeo, new THREE.MeshBasicMaterial({ transparent: true, colorWrite: false, depthWrite: false }));
    clearer.frustumCulled = false;
    clearer.renderOrder = VM_ORDER - 1;
    clearer.onBeforeRender = (renderer) => renderer.clearDepth();
    vm.add(clearer);
    vm.scale.setScalar(VM_SCALE);
    engine.camera.add(vm);
    engine.scene.add(engine.camera);
    // The muzzle glow hangs off the camera, not the viewmodel: hiding the viewmodel (death) must never hide a light,
    // or the light count changes and every lit material recompiles. It only ever changes intensity.
    const glow = new THREE.PointLight(0xffb070, 0, 4, 2);
    vm.updateMatrix();
    glow.position.copy(VM_MUZZLE).applyMatrix4(vm.matrix);
    glow.position.z -= 0.08;
    engine.camera.add(glow);
    this.muzzleGlow = glow;
    this.warhead = vm.getObjectByName('warhead') ?? null;
    this.viewmodel = vm;
    this.raise.reset(-0.3);
  }

  /** Pixel-ratio cap, shadows and outlines for a quality preset. applyQuality drops the shadow map, so redraw it. */
  private applyQualityNow(q: Quality) {
    const engine = this.engine;
    if (!engine) return;
    engine.setMaxPixelRatio(QUALITY[q].pixelRatio);
    applyQuality(engine.scene, q);
    engine.invalidateShadows();
  }

  private remote(id: string): Remote | null {
    let r = this.remotes.get(id);
    if (r) return r;
    const info = this.ctx.room().players.find((p) => p.id === id);
    if (!info || !this.engine) return null;
    const group = buildDroid(info.color);
    const label = makeLabel(info.name, colorHex(info.color));
    label.position.y = RK.height + 0.2;
    group.add(label);
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTexture(), color: info.color, transparent: true, depthWrite: false }));
    marker.renderOrder = 10;
    marker.visible = false;
    group.add(marker);
    this.engine.scene.add(group);
    r = {
      group,
      bobNode: group.getObjectByName('bob') ?? null,
      torso: group.getObjectByName('torso') ?? null,
      head: group.getObjectByName('head') ?? null,
      aim: group.getObjectByName('aim') ?? null,
      recoil: group.getObjectByName('recoil') ?? null,
      thrust: group.getObjectByName('thrust') ?? null,
      kick: 0,
      ground: true,
      vy: 0,
      label,
      marker,
      labelW: label.scale.x,
      labelH: label.scale.y,
      color: info.color,
      name: info.name,
      bob: Math.random() * 6,
      seen: 0,
    };
    this.remotes.set(id, r);
    return r;
  }

  private removeRemote(id: string) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.engine?.scene.remove(r.group);
    const mat = r.label.material;
    mat.map?.dispose();
    mat.dispose();
    r.marker.material.dispose();
    this.remotes.delete(id);
  }

  /** Blows a remote droid apart where it stands; the pieces fly away from the killer. */
  private wreck(r: Remote, by?: string) {
    const engine = this.engine;
    if (!engine) return;
    const at = r.group.position;
    const from = by === this.ctx.you ? this.me.body.pos : by ? this.remotes.get(by)?.group.position : undefined;
    let push: THREE.Vector3 | undefined;
    if (from) {
      push = new THREE.Vector3(at.x - from.x, 0, at.z - from.z);
      const len = push.length();
      if (len > 0.01) push.multiplyScalar(4 / len);
    }
    const pieces = buildDroidPieces(r.color, r.group, push);
    for (const p of pieces) engine.scene.add(p.object);
    this.wrecks.push({ pieces, floorY: at.y, life: 2.5 });
  }

  private spawnRocket(id: string, pos: Vec3, vel: Vec3, confirmed: boolean, local: boolean): RocketView {
    const group = buildRocket();
    const light = this.rocketLights?.take(ROCKET_COLOR, 8, 7) ?? null;
    this.engine?.scene.add(group);
    // Rockets fly straight, so they are aimed once here.
    const len = Math.hypot(vel.x, vel.y, vel.z) || 1;
    group.position.set(pos.x, pos.y, pos.z);
    group.lookAt(pos.x + vel.x / len, pos.y + vel.y / len, pos.z + vel.z / len);
    const t = performance.now() / 1000;
    const view: RocketView = { group, pos, vel, at: t, confirmed, local, born: t, light, flame: group.getObjectByName('flame') ?? null, off: null, trail: 0, stopped: false };
    this.rockets.set(id, view);
    return view;
  }

  private removeRocket(id: string) {
    const view = this.rockets.get(id);
    if (!view) return;
    this.engine?.scene.remove(view.group);
    if (view.light) this.rocketLights?.give(view.light);
    sfx.rocketEnd(view.group.id);
    this.rockets.delete(id);
  }

  // ---- per frame -----------------------------------------------------------------------------------------------

  private frame(dt: number, now: number) {
    this.time = now;
    this.frameNo++;
    const { engine, input, map, effects, me } = this;
    if (!engine || !input) return;

    // Mouse look applies every rendered frame, not per sim tick, so turning is as smooth as the display; the sim
    // ticks just read yaw and pitch. Without a map the deltas are thrown away.
    const look = input.look();
    const tlook = this.touch.look();
    if (map && !this.paused) {
      const dx = look.dx + tlook.dx;
      const dy = look.dy + tlook.dy;
      me.yaw -= dx;
      me.pitch = clamp(me.pitch - dy, -RK.maxPitch, RK.maxPitch);
      this.lookDX += dx;
      this.lookDY += dy;
    }

    if (map) {
      this.acc = Math.min(this.acc + dt, RK.dt * 6);
      while (this.acc >= RK.dt) {
        this.tick(now);
        this.acc -= RK.dt;
      }
      if (this.outbox.length && (this.outbox.length >= 2 || now - this.lastSend > 0.05)) {
        this.ctx.socket.sendGame({ k: 'in', i: this.outbox });
        this.outbox = [];
        this.lastSend = now;
      }
    }

    this.updateCamera(dt, now);
    const cam = engine.camera;
    sfx.listen(cam.position.x, cam.position.y, cam.position.z, cam.rotation.y);
    sfx.heartbeat(this.me.dead ? 0 : this.hud.get().hp, RK.maxHealth);
    this.updateRemotes(dt, now);
    this.updateRockets(dt, now);
    if (this.arena) for (const ring of this.arena.padRings) ring.rotation.z += dt * 1.5;
    for (let i = 0; i < this.packs.length; i++) {
      const pack = this.packs[i];
      pack.rotation.y += dt;
      pack.position.y = this.packBase[i] + Math.sin(now * 3 + i) * 0.06;
    }
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      item.rotation.y += dt * 1.6;
      item.position.y = this.itemBase[i] + Math.sin(now * 2.5 + i * 1.7) * 0.08;
    }
    this.updateWrecks(dt);
    for (const [src, copy] of this.viewInk) copy.visible = src.visible;
    effects?.update(dt);

    if (now - this.lastHud > 0.1) {
      this.lastHud = now;
      const s = this.hud.get();
      const left = Math.max(0, this.serverLeft - (now - this.serverLeftAt));
      const respawnIn = this.me.dead ? Math.max(0, this.me.respawnAt - now) : 0;
      const countdown = this.countdownLeft();
      if (
        Math.abs(s.left - left) > 0.05 ||
        s.locked !== input.locked ||
        s.dragLook !== input.dragLook ||
        s.dead !== this.me.dead ||
        Math.abs(s.respawnIn - respawnIn) > 0.05 ||
        Math.abs((s.countdown ?? 0) - countdown) > 0.05 ||
        s.overtime !== this.overtime
      ) {
        this.hud.set({ left, locked: input.locked, dragLook: input.dragLook, dead: this.me.dead, respawnIn, countdown, overtime: this.overtime });
      }
      const fps = Math.round(engine.fps);
      if (Math.abs(fps - s.fps) >= 2) this.hud.set({ fps });
      const speed = this.me.dead ? 0 : Math.hypot(this.me.body.vel.x, this.me.body.vel.z);
      if (s.speed === undefined || Math.abs(s.speed - speed) > 0.3) this.hud.set({ speed });
    }
  }

  /** Flying droid pieces: a couple of seconds of tumbling, then gone (they share the droid's geometry and materials). */
  private updateWrecks(dt: number) {
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.life -= dt;
      if (w.life > 0) {
        updateDroidPieces(w.pieces, dt, w.floorY);
        continue;
      }
      for (const piece of w.pieces) this.engine?.scene.remove(piece.object);
      this.wrecks.splice(i, 1);
    }
  }

  private countdownLeft() {
    return Math.max(0, this.countdown - (this.time - this.countdownAt));
  }

  private tick(now: number) {
    const { input, map, me, touch } = this;
    if (!input || !map) return;
    // During the start countdown everyone is frozen on the server, so predict standing still.
    const hold = this.paused || this.countdownLeft() > 0;
    const inp: RocketsInput = {
      seq: ++me.seq,
      f: hold ? 0 : clamp(input.actionAxis('back', 'forward') + touch.f, -1, 1),
      s: hold ? 0 : clamp(input.actionAxis('left', 'right') + touch.s, -1, 1),
      jump: !hold && (input.held('jump') || touch.down('Space')),
      fire: !hold && (input.fire() || touch.fire()) && !this.hud.get().ended,
      yaw: me.yaw,
      pitch: me.pitch,
    };
    if (!me.dead) {
      const wasGround = me.body.onGround;
      const fallSpeed = -me.body.vel.y;
      me.prevPos.x = me.body.pos.x;
      me.prevPos.y = me.body.pos.y;
      me.prevPos.z = me.body.pos.z;
      const res = stepBody(me.body, inp, map);
      if (res.pad >= 0) {
        sfx.play('pad');
        const pad = map.pads[res.pad];
        if (pad) this.effects?.padBurst(pad.pos, map.accent ?? 0x7cf4ff);
      } else if (inp.jump && wasGround && !me.body.onGround) sfx.play('jump');
      // Landing dip, scaled by how hard we came down (a bunny hop barely registers, a long fall thumps).
      if (!wasGround && me.body.onGround && fallSpeed > 3) this.land.v -= 0.25 + Math.min(1, (fallSpeed - 3) / 16) * 1.1;
      if (!wasGround && me.body.onGround && fallSpeed > 4) sfx.play('land', 0, clamp((fallSpeed - 4) / 14, 0, 1));
      if (!wasGround && me.body.onGround && fallSpeed > 7) this.effects?.dust(me.body.pos, (fallSpeed - 7) / 15);
      if (inp.fire && now >= me.nextFire) {
        me.nextFire = now + RK.fireInterval;
        const dir = lookDir(me.yaw, me.pitch);
        const origin = vadd(eyePosition(me.body.pos), vscale(dir, RK.muzzleOffset));
        const view = this.spawnRocket(`${this.ctx.you}:${inp.seq}`, origin, vscale(dir, RK.rocketSpeed), false, true);
        this.fireFeel(view, dir);
        sfx.play('fire');
      }
    }
    me.pending.push(inp);
    if (me.pending.length > 180) me.pending.splice(0, me.pending.length - 180);
    this.outbox.push(inp);
  }

  /** Kick, slide-back and a muzzle puff for our own shot, and the rocket's visual starts at the viewmodel muzzle. */
  private fireFeel(view: RocketView, dir: Vec3) {
    this.recoil = 1;
    this.reload = 0;
    this.hud.set({ firedAt: this.time });
    const k = settings.get().reducedMotion ? 0.3 : 1;
    this.kickZ.v += 2.4 * k;
    this.kickPitch.v += 4.5 * k;
    this.punch(0.6, (Math.random() - 0.5) * 0.3);
    const vm = this.viewmodel;
    if (!vm || this.debugCam) return;
    // Muzzle in camera space (last frame's viewmodel pose), turned into the world with this tick's view. The rocket
    // really starts muzzleOffset ahead of the eye; the difference is drawn as an offset that fades in a few frames.
    const me = this.me;
    vm.updateMatrix();
    scratchV.copy(VM_MUZZLE).applyMatrix4(vm.matrix).applyEuler(scratchEuler.set(me.pitch, me.yaw, 0, 'YXZ'));
    view.off = v3(scratchV.x + me.smooth.x - dir.x * RK.muzzleOffset, scratchV.y + me.smooth.y - dir.y * RK.muzzleOffset, scratchV.z + me.smooth.z - dir.z * RK.muzzleOffset);
    const muzzle = vadd(view.pos, view.off);
    this.effects?.burst(muzzle, 0xeeeae2, 6, 1.4, 0.35, 0.25);
    this.effects?.flash(muzzle, 0xffc24a, 0.22, 0.09, 6);
  }

  private updateCamera(dt: number, now: number) {
    const { engine, me } = this;
    if (!engine) return;
    const cam = engine.camera;
    const prefs = settings.get();
    const calm = prefs.reducedMotion;
    // Hit-stop: camera and viewmodel motion crawl for a few frames.
    this.freeze = Math.max(0, this.freeze - dt);
    const fdt = this.freeze > 0 ? dt * 0.12 : dt;
    me.smooth.x = damp(me.smooth.x, 0, 14, dt);
    me.smooth.y = damp(me.smooth.y, 0, 14, dt);
    me.smooth.z = damp(me.smooth.z, 0, 14, dt);

    if (me.dead && !this.wasDead) {
      this.deathT = 0;
      this.deathYaw = me.yaw;
      this.deathPitch = me.pitch;
    } else if (!me.dead && this.wasDead) {
      // Respawn: the launcher swings up into view, nothing left over from the last life.
      this.raise.reset(-0.3);
      this.kickZ.reset();
      this.kickPitch.reset();
      this.land.reset();
      this.trauma = 0;
    }
    this.wasDead = me.dead;
    const alive = !me.dead;

    // Render position: the predicted body between the last two sim ticks, plus the eased reconcile correction.
    let ex: number;
    let ey: number;
    let ez: number;
    if (me.dead && me.deathPos) {
      ex = me.deathPos.x;
      ey = me.deathPos.y;
      ez = me.deathPos.z;
    } else {
      const a = clamp(this.acc / RK.dt, 0, 1);
      const p = me.body.pos;
      const q = me.prevPos;
      ex = q.x + (p.x - q.x) * a + me.smooth.x;
      ey = q.y + (p.y - q.y) * a + me.smooth.y;
      ez = q.z + (p.z - q.z) * a + me.smooth.z;
    }
    ey += RK.eyeHeight;

    const v = me.body.vel;
    const speed = alive ? Math.hypot(v.x, v.z) : 0;
    const grounded = alive && me.body.onGround;
    // Bob follows distance walked; its size follows speed and fades out in the air, so bunny hops stay steady.
    this.bobAmp = damp(this.bobAmp, grounded ? Math.min(1, speed / RK.groundSpeed) : 0, 8, dt);
    if (grounded) this.bob += fdt * speed * 1.2;
    const bobAmp = calm || !prefs.bob ? 0 : this.bobAmp;
    const bobX = Math.sin(this.bob) * bobAmp;
    const bobY = (Math.cos(this.bob * 2) - 1) * 0.5 * bobAmp;

    // Sway: the launcher lags behind mouse look (clamped, so flicks do not fling it off screen).
    const rate = dt > 0 ? 1 / dt : 0;
    this.swayX = damp(this.swayX, clamp(this.lookDX * rate * 0.006, -0.05, 0.05), 10, fdt);
    this.swayY = damp(this.swayY, clamp(this.lookDY * rate * 0.006, -0.04, 0.04), 10, fdt);
    this.lookDX = 0;
    this.lookDY = 0;
    this.airY = damp(this.airY, alive && !me.body.onGround ? clamp(-v.y * 0.003, -0.035, 0.035) : 0, 6, dt);
    const side = Math.cos(me.yaw) * v.x - Math.sin(me.yaw) * v.z;
    this.roll = damp(this.roll, calm || !alive ? 0 : clamp(-side / RK.groundSpeed, -1, 1) * 0.016, 8, dt);

    const kickZ = this.kickZ.step(fdt);
    const kickPitch = this.kickPitch.step(fdt);
    const punchPitch = this.punchPitch.step(fdt);
    const punchYaw = this.punchYaw.step(fdt);
    const land = this.land.step(fdt);
    const raise = this.raise.step(fdt);

    // Shake: smooth layered sines (not per-frame random jitter), scaled by trauma squared and capped small.
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    if (this.freeze <= 0) this.shakeT += dt;
    const s = this.trauma * this.trauma * (calm ? 0.3 : 1);
    const t = this.shakeT;
    const shPitch = s * 0.03 * (Math.sin(t * 23.1) * 0.6 + Math.sin(t * 41.7 + 1.3) * 0.4);
    const shYaw = s * 0.03 * (Math.sin(t * 19.3 + 2.1) * 0.6 + Math.sin(t * 37.9 + 0.4) * 0.4);
    const shRoll = s * 0.04 * (Math.sin(t * 17.7 + 4.2) * 0.6 + Math.sin(t * 29.3 + 2.8) * 0.4);
    const shX = s * 0.04 * Math.sin(t * 27.1 + 0.7);
    const shY = s * 0.04 * Math.sin(t * 31.3 + 3.3);

    let yaw = me.yaw;
    let pitch = me.pitch;
    let roll = this.roll;
    if (me.dead) {
      // Death camera: sink to the floor, tip onto one side and turn to face whoever got us.
      this.deathT += dt;
      const k = smoothstep(this.deathT / 0.9);
      const floor = (me.deathPos ?? me.body.pos).y + 0.4;
      ey += (floor - ey) * k;
      const killer = this.killer ? this.remotes.get(this.killer) : undefined;
      if (killer?.group.visible) {
        const dx = killer.group.position.x - ex;
        const dz = killer.group.position.z - ez;
        const dy = killer.group.position.y + 1.2 - ey;
        this.deathYaw = lerpAngle(this.deathYaw, Math.atan2(-dx, -dz), 1 - Math.exp(-2.5 * dt));
        this.deathPitch = damp(this.deathPitch, clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.8, 0.8), 2.5, dt);
      } else this.deathPitch = damp(this.deathPitch, -0.25, 2, dt);
      yaw = this.deathYaw;
      pitch = this.deathPitch;
      roll = 0.38 * k * (calm ? 0.3 : 1);
    }
    cam.position.set(ex + shX, ey + bobY * 0.022 + land + shY, ez);
    cam.rotation.set(pitch + punchPitch + shPitch, yaw + punchYaw + shYaw, roll + shRoll);

    // A few degrees of extra FOV at rocket-jump speeds sells the velocity.
    const fast = alive && !calm ? clamp((speed - RK.groundSpeed * 1.15) / 12, 0, 1) : 0;
    this.fov = damp(this.fov, verticalFov(prefs.fov) + fast * 8, 3.5, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }

    if (this.debugCam) {
      const d = this.debugCam;
      cam.position.set(d.x, d.y, d.z);
      cam.rotation.set(d.pitch, d.yaw, 0);
    }

    const vm = this.viewmodel;
    if (vm) {
      this.recoil = Math.max(0, this.recoil - dt * 6);
      this.reload = Math.min(1, this.reload + dt / RK.fireInterval);
      vm.position.set(
        VM_POS.x + bobX * 0.014 - this.swayX * 0.6,
        VM_POS.y + bobY * 0.012 + this.swayY * 0.5 + this.airY + land * 0.5 + raise,
        VM_POS.z + kickZ,
      );
      vm.rotation.set(VM_PITCH + kickPitch + this.swayY * 1.2 - land * 0.6 + raise * 0.8, VM_YAW + this.swayX * 1.4 + bobX * 0.01, -this.swayX * 1.2 + bobX * 0.012);
      vm.visible = alive;
      // The fired warhead is gone; a fresh one slides into the muzzle over the reload time.
      if (this.warhead) {
        const r = this.reload;
        this.warhead.visible = r > 0.25;
        this.warhead.position.z = WARHEAD_REST_Z + (1 - Math.min(1, (r - 0.25) / 0.6)) * 0.35;
      }
      if (this.muzzleGlow) this.muzzleGlow.intensity = this.recoil * 14;
    }
    void now;
  }

  private updateRemotes(dt: number, now: number) {
    const sample = this.snaps.sample(now);
    const frame = this.frameNo;
    const cam = this.engine?.camera.position;
    if (sample) {
      const { a, b, alpha } = sample;
      for (const pb of b.pl) {
        if (pb.id === this.ctx.you) continue;
        const r = this.remote(pb.id);
        if (!r) continue;
        r.seen = frame;
        const pa = a.pl.find((p) => p.id === pb.id) ?? pb;
        const dead = pb.d === 1;
        r.group.visible = !dead;
        if (dead) continue;
        const sameLife = pa.d === pb.d;
        const x = sameLife ? pa.p[0] + (pb.p[0] - pa.p[0]) * alpha : pb.p[0];
        const y = sameLife ? pa.p[1] + (pb.p[1] - pa.p[1]) * alpha : pb.p[1];
        const z = sameLife ? pa.p[2] + (pb.p[2] - pa.p[2]) * alpha : pb.p[2];
        const yaw = sameLife ? lerpAngle(pa.y, pb.y, alpha) : pb.y;
        r.bob += dt * 3;
        r.group.position.set(x, y + (pb.g ? 0 : 0.05), z);
        r.group.rotation.y = yaw;
        if (r.bobNode) r.bobNode.position.y = Math.sin(r.bob) * 0.04;
        // Lean the torso into the movement direction a little; the gun arm and head still aim where they look.
        const vx = pb.v[0];
        const vz = pb.v[2];
        const fwd = -Math.sin(yaw) * vx - Math.cos(yaw) * vz;
        const side = Math.cos(yaw) * vx - Math.sin(yaw) * vz;
        const leanX = clamp(-fwd * 0.02, -0.25, 0.25);
        if (r.torso) {
          r.torso.rotation.x = leanX;
          r.torso.rotation.z = clamp(-side * 0.02, -0.25, 0.25);
        }
        const pitch = sameLife ? pa.pt + (pb.pt - pa.pt) * alpha : pb.pt;
        if (r.aim) r.aim.rotation.x = pitch - (r.torso ? leanX : 0);
        if (r.head) r.head.rotation.x = pitch * 0.5;
        r.kick = Math.max(0, r.kick - dt * 4);
        if (r.recoil) {
          r.recoil.position.z = r.kick * 0.12;
          r.recoil.rotation.x = r.kick * 0.3;
        }
        if (r.thrust) r.thrust.scale.set(1, (pb.g ? 0.7 : 1.3) + Math.sin(r.bob * 9) * 0.12, 1);
        // Landing dust, from the older of the two snapshots so it lines up with where the droid is drawn.
        if (sameLife && pa.g === 1 && !r.ground && r.vy < -7) this.effects?.dust(r.group.position, (-r.vy - 7) / 15);
        r.ground = pa.g === 1;
        if (!r.ground) r.vy = pa.v[1];
        // Name tags grow with distance so they stay readable, and only fade out far away.
        if (cam) {
          const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
          const k = clamp(d / 14, 1, 3.5);
          r.label.scale.set(r.labelW * k, r.labelH * k, 1);
          r.label.material.opacity = 1 - clamp((d - 80) / 20, 0, 1);
          // Past ~25 m a droid is a few pixels tall: fade in a marker of roughly constant screen size over its head.
          const show = clamp((d - 25) / 10, 0, 1);
          const size = d * 0.022;
          r.marker.visible = show > 0;
          r.marker.material.opacity = show;
          r.marker.scale.set(size, size, 1);
          r.marker.position.y = RK.height + 0.15 + size * 0.5;
          r.label.position.y = RK.height + 0.2 + (show > 0 ? size : 0) + r.labelH * (k - 1) * 0.5;
        }
      }
    }
    for (const r of this.remotes.values()) if (r.seen !== frame) r.group.visible = false;
  }

  private updateRockets(dt: number, now: number) {
    // Rocket times are on the performance.now() clock (set when messages arrive), not the frame clock.
    const pnow = performance.now() / 1000;
    for (const view of this.rockets.values()) {
      const v = view.vel;
      let x: number;
      let y: number;
      let z: number;
      if (view.confirmed && !view.local) {
        const t = Math.max(0, pnow - view.at);
        x = view.pos.x + v.x * t;
        y = view.pos.y + v.y * t;
        z = view.pos.z + v.z * t;
      } else {
        if (view.stopped) continue;
        // Our rocket runs a round trip ahead of the server's: stop it at the wall and let the boom event remove it,
        // instead of flying on through for 100+ ms.
        const next = this.nextPos;
        next.x = view.pos.x + v.x * dt;
        next.y = view.pos.y + v.y * dt;
        next.z = view.pos.z + v.z * dt;
        if (this.map && segmentBoxes(view.pos, next, this.map.boxes)) {
          view.stopped = true;
          view.group.visible = false;
          if (view.light) view.light.intensity = 0;
          continue;
        }
        view.pos.x = next.x;
        view.pos.y = next.y;
        view.pos.z = next.z;
        x = view.pos.x;
        y = view.pos.y;
        z = view.pos.z;
      }
      if (view.off) {
        const k = Math.exp(-Math.max(0, pnow - view.born) / ROCKET_BLEND);
        x += view.off.x * k;
        y += view.off.y * k;
        z += view.off.z * k;
        if (k < 0.01) view.off = null;
      }
      view.group.position.set(x, y, z);
      sfx.rocket(view.group.id, x, y, z, v.x, v.y, v.z);
      if (view.light) {
        view.light.position.set(x, y, z);
        view.light.intensity = 6 + Math.sin(now * 40) * 2;
      }
      if (view.flame) view.flame.scale.set(1, 1, 0.8 + Math.random() * 0.45);
      // Smoke trail by distance flown, so it looks the same at any frame rate.
      const speed = Math.hypot(v.x, v.y, v.z);
      view.trail += speed * dt;
      if (view.trail >= TRAIL_STEP && speed > 0) {
        forward.set(v.x / speed, v.y / speed, v.z / speed);
        while (view.trail >= TRAIL_STEP) {
          view.trail -= TRAIL_STEP;
          scratchV.set(x - forward.x * (view.trail + 0.25), y - forward.y * (view.trail + 0.25), z - forward.z * (view.trail + 0.25));
          this.effects?.trail(scratchV, 1 - Math.min(1, (pnow - view.born) / RK.rocketLife));
        }
      }
    }
  }

}
