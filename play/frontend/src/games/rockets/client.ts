// Rockets client: first-person view with client-side prediction for the local player, interpolation for everyone
// else, extrapolated rockets, and a few effects. The server is authoritative; this only predicts and shows.

import * as THREE from 'three';
import { clamp, fromTuple, hdist, lookDir, segmentBoxes, type Vec3, v3, vadd, vscale, vsub } from '@shared/math';
import type { RocketsMode as GameMode, GameServerMsg, PlayerInfo, RoomView, Team } from '@shared/protocol';
import { RK } from '@shared/rockets/constants';
import type { ItemKind, ItemSpawn } from '@shared/rockets/items';
import type { MapData } from '@shared/rockets/map';
import { DEFAULT_LOOK, type Look } from '@shared/rockets/cosmetics';
import { CTF, ELIM, MODES, TEAMS, teamBases } from '@shared/rockets/modes';
import { type Body, eyePosition, splashKnock, stepBody } from '@shared/rockets/physics';
import type { FlagSnap, PlayerSnap, RocketsEvent, RocketsInput, RocketsServerMsg, RocketsSnapshot, RoundSnap, ScoreRow } from '@shared/rockets/protocol';
import { sfx } from '../../engine/audio';
import { Effects, LightPool, TRAIL_STEP, nearestSurface } from '../../engine/effects';
import { Engine, colorHex, makeLabel } from '../../engine/engine';
import { Input } from '../../engine/input';
import { SnapshotTimeline, damp, lerpAngle } from '../../engine/interp';
import { INK } from '../../engine/toon';
import { TouchInput } from '../../engine/touch';
import { type ClientContext, type GameClient, createStore } from '../types';
import { type ArenaView, addArenaLights, buildArena } from './arena';
import { buildFlag, buildFlagStand, buildReturnRing, updateFlagTime } from './flags';
import { type CharacterPiece, type CharacterState, animateCharacter, buildCharacter, buildCharacterPieces, characterKey, updateCharacterPieces, warmupCharacters } from './character';
import { loadLook } from './look';
import { type Bloom, createBloom } from './bloom';
import { themeOf } from './arenaDecor';
import { WARHEAD_REST_Z, buildLauncher, buildPickup, buildRocket, buildViewHand, warmupModels } from './models';
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
  ended: { scores: ScoreRow[]; winner: string | null; winnerTeam?: Team | null } | null;
  message: string;
  /** Game mode of this match (from init). */
  mode?: GameMode;
  /** Our team in team modes. */
  myTeam?: Team;
  /** Team modes: team scores [red, blue]. */
  ts?: [number, number];
  /** CTF: each team's flag (index = team). */
  flags?: [FlagSnap, FlagSnap];
  /** CTF: seconds until each dropped flag goes home by itself (0 when not dropped). */
  flagReturn?: [number, number];
  /** Elimination round state. */
  round?: RoundSnap;
  /** Big comic callout (flag events, rounds); `id` changes per callout so the HUD can replay its pop-in. */
  callout?: { id: number; text: string; team?: Team; at: number };
  /** Elimination: the teammate whose view we are watching while dead. */
  spectating?: string | null;
  /** Seconds of start countdown left (players are frozen while it runs). */
  countdown?: number;
  overtime?: boolean;
  armor?: number;
  /** Horizontal speed in m/s. */
  speed?: number;
  /** Vertical speed in m/s (up is positive), so rocket-jump climbs read on the speedometer too. */
  vspeed?: number;
  /** this.time of our last shot (reload ring). */
  firedAt?: number;
  /** Screen angle (radians, 0 = ahead, clockwise) towards whoever last hurt us. */
  hurtDir?: number;
}

interface Remote {
  group: THREE.Group;
  /** The robot's look, the team colour that replaces its body colour (team modes), and characterKey of both. */
  look: Look;
  tint: number | undefined;
  lookKey: string;
  /** Reused every frame for animateCharacter. */
  pose: CharacterState;
  /** Fire kick, 1 at a shot and decaying. */
  kick: number;
  /** Ground flag and vertical speed from the latest snapshot, for landing dust. */
  ground: boolean;
  vy: number;
  label: THREE.Sprite;
  /** Team-coloured arrow over the head of far-away droids, which are only a few pixels tall by then. */
  marker: THREE.Sprite;
  /** Team modes: a diamond over teammates, seen through walls, so you know whom not to shoot. */
  ally: THREE.Sprite | null;
  team?: Team;
  /** The colour the model is painted in (the team colour in team modes, else the player colour). */
  paint: number;
  /** The label's scale at 1x, so it can grow with distance. */
  labelW: number;
  labelH: number;
  color: number;
  name: string;
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
  /** Our own shot's position stepped once per command (the server's timeline), for predicting its hit. */
  sim?: Vec3;
  /** The per-command simulation hit the map (its knockback, if any, is predicted). */
  hit?: boolean;
  /** Set once removed, so a predicted knockback knows the server has resolved this rocket. */
  gone?: boolean;
}

/** A self-knockback we predicted from our own rocket, applied before command `seq` until the server's boom arrives. */
interface PredictedKick {
  view: RocketView;
  seq: number;
  v: Vec3;
}

/** A destroyed droid's pieces, flying for a couple of seconds. */
interface Wreck {
  pieces: CharacterPiece[];
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
/**
 * Viewmodel placement relative to the camera: big and low on the right, the barrel angled in at the crosshair so its
 * right flank shows. Pulled well back so the breech runs off the bottom of the screen, as if it sits on your shoulder.
 */
const VM_POS = { x: 0.3, y: -0.5, z: -0.5 };
const VM_YAW = 0.12;
const VM_PITCH = 0.05;
const VM_SCALE = 1.2;
/** The bore's mouth in launcher model space (see models.ts buildLauncher). */
const VM_MUZZLE = new THREE.Vector3(0, 0.07, -0.84);
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

/** The teammate marker: an ink-outlined diamond with a white pip, tinted per team. Shared by all ally markers. */
let allyTex: THREE.CanvasTexture | null = null;
function allyTexture() {
  if (allyTex) return allyTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const diamond = (r: number) => {
    g.beginPath();
    g.moveTo(32, 32 - r);
    g.lineTo(32 + r * 0.8, 32);
    g.lineTo(32, 32 + r);
    g.lineTo(32 - r * 0.8, 32);
    g.closePath();
  };
  diamond(26);
  g.fillStyle = '#ffffff';
  g.fill();
  g.lineJoin = 'round';
  g.lineWidth = 6;
  g.strokeStyle = colorHex(INK);
  g.stroke();
  diamond(9);
  g.fillStyle = colorHex(INK);
  g.fill();
  allyTex = new THREE.CanvasTexture(c);
  allyTex.colorSpace = THREE.SRGBColorSpace;
  return allyTex;
}

/** One CTF flag in the world: the stand at its base, the flag itself, and the ring and label shown while dropped. */
interface FlagView {
  team: Team;
  base: Vec3;
  stand: THREE.Group;
  flag: THREE.Group;
  ring: THREE.Mesh;
  label: THREE.Sprite | null;
  /** Whole seconds the label shows, so it is only redrawn once a second. */
  labelN: number;
  state: 0 | 1 | 2;
  /** this.time when it was dropped (for the return ring). */
  droppedAt: number;
}

const scratchV = new THREE.Vector3();
const scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const forward = new THREE.Vector3();
const scratchTo = v3();
const specFrom = v3();
const specTo = v3();
/** Reload in commands; the server counts the same for humans. */
const FIRE_STEPS = Math.round(RK.fireInterval / RK.dt);

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
  private bloom?: Bloom;
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
    /** First command seq we may fire on again. */
    fireSeq: 0,
    smooth: v3(),
    deathPos: null as Vec3 | null,
    respawnAt: 0,
    kicks: [] as PredictedKick[],
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
  /** Where the death camera settles: up and back from the body, away from the killer, never inside a solid. */
  private deathCam: Vec3 | null = null;
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
  // ---- modes and teams ----
  private mode: GameMode = 'ffa';
  private bases: [Vec3, Vec3] | null = null;
  private flagViews: FlagView[] = [];
  private lastFlags: [FlagSnap, FlagSnap] | null = null;
  private lastRound: RoundSnap | null = null;
  private calloutId = 0;
  /** Elimination spectator: whose view we follow while dead, and the eased camera. */
  private specId: string | null = null;
  private readonly specCam = v3();
  private specYaw = 0;
  private specPitch = 0;
  private specFresh = true;
  /** Dev aid: fields merged into every incoming snapshot, to preview mode HUDs against a server without them. */
  debugSnap: Partial<RocketsSnapshot> | null = null;

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
    this.bloom?.dispose();
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
      // A team switch repaints the robot and its label, a new look reshapes it: rebuild it.
      const team = this.teamOfInfo(p);
      if (!p || r.name !== p.name || r.color !== p.color || r.team !== team || r.lookKey !== characterKey(p.look ?? DEFAULT_LOOK, team !== undefined ? TEAMS[team].color : undefined)) {
        this.removeRemote(id);
      }
    }
    const myTeam = this.teamOf(this.ctx.you);
    if (myTeam !== this.hud.get().myTeam) this.hud.set({ myTeam });
  }

  /** Dev aid for screenshots before the server speaks a mode: switch the client's mode (and CTF flags) in place. */
  debugMode(mode: GameMode) {
    this.setMode(mode);
    for (const id of [...this.remotes.keys()]) this.removeRemote(id);
  }

  private setMode(mode: GameMode) {
    this.mode = mode;
    this.hud.set({ mode, myTeam: this.teamOf(this.ctx.you) });
    this.buildFlags();
  }

  private get teamMode() {
    return MODES[this.mode].teams;
  }

  private teamOfInfo(p: PlayerInfo | undefined): Team | undefined {
    if (!this.teamMode || !p) return undefined;
    return p.team ?? this.hud.get().scores.find((r) => r.id === p.id)?.team;
  }

  /** A player's team in team modes (from the room, else the scoreboard); undefined in free for all. */
  teamOf(id: string): Team | undefined {
    if (!this.teamMode) return undefined;
    const p = this.ctx.room().players.find((q) => q.id === id);
    return p?.team ?? this.hud.get().scores.find((r) => r.id === id)?.team;
  }

  /** Sends a team switch; the server kills us without penalty and respawns us on the new side. */
  switchTeam(team?: Team) {
    const mine = this.teamOf(this.ctx.you);
    const to: Team = team ?? (mine === 0 ? 1 : 0);
    this.ctx.socket.send({ t: 'setTeam', team: to });
  }

  private callout(text: string, team?: Team) {
    this.hud.set({ callout: { id: ++this.calloutId, text, team, at: this.time } });
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
        this.bases = msg.bases ? [fromTuple(msg.bases[0]), fromTuple(msg.bases[1])] : null;
        this.mode = msg.mode ?? this.ctx.room().mode ?? 'ffa';
        this.hud.set({ mode: this.mode, myTeam: this.teamOf(this.ctx.you) });
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
        this.hud.set({ ended: { scores: msg.scores, winner: msg.winner, winnerTeam: msg.winnerTeam }, scores: msg.scores });
        this.input?.exitLock();
        if (this.teamMode && msg.winnerTeam !== undefined) {
          if (msg.winnerTeam !== null && msg.winnerTeam === this.teamOf(this.ctx.you)) sfx.play('win');
          else if (msg.winnerTeam !== null) sfx.play('out');
        } else if (msg.winner === this.ctx.you) sfx.play('win');
        break;
    }
  }

  private onSnapshot(s: RocketsSnapshot) {
    if (import.meta.env.DEV && this.debugSnap) s = { ...s, ...this.debugSnap };
    this.modeSnapshot(s);
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
    // Both lists are only sent when they changed.
    const pk = s.pk;
    if (pk) for (let i = 0; i < this.packs.length; i++) this.packs[i].visible = pk.includes(i);
    const it = s.it;
    if (it) for (let i = 0; i < this.items.length; i++) this.items[i].visible = it.includes(i);
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

  /** Team scores, flags and rounds from a snapshot into the HUD (only what changed) and the flag props. */
  private modeSnapshot(s: RocketsSnapshot) {
    const h = this.hud.get();
    const patch: Partial<RocketsHudState> = {};
    if (s.ts && (!h.ts || h.ts[0] !== s.ts[0] || h.ts[1] !== s.ts[1])) patch.ts = s.ts;
    if (s.fl) {
      const prev = this.lastFlags;
      if (!prev || prev[0].s !== s.fl[0].s || prev[1].s !== s.fl[1].s || prev[0].by !== s.fl[0].by || prev[1].by !== s.fl[1].by) patch.flags = s.fl;
      for (const f of this.flagViews) {
        const snap = s.fl[f.team];
        if (snap.s === 2 && f.state !== 2) f.droppedAt = this.time;
        f.state = snap.s;
      }
      this.lastFlags = s.fl;
    }
    const rd = s.rd;
    if (rd) {
      const was = this.lastRound;
      // A new round starting (or the first one we see): banner and a go sound.
      if (rd.state === 'play' && (!was || was.n !== rd.n || was.state !== 'play')) {
        this.callout(`Round ${rd.n}`);
        sfx.play('go');
        this.specId = null;
      }
      if (!was || was.n !== rd.n || was.state !== rd.state || was.alive[0] !== rd.alive[0] || was.alive[1] !== rd.alive[1] || Math.abs(was.left - rd.left) >= 1) patch.round = rd;
      this.lastRound = rd;
    }
    if (Object.keys(patch).length) this.hud.set(patch);
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
      me.kicks = [];
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
      me.kicks = [];
      // The server allows the first shot 0.3 s after spawning (counted from about this command).
      me.fireSeq = (own.seq ?? me.seq) + Math.round(0.3 / RK.dt);
      return;
    }
    const before = { ...me.body.pos };
    me.body.pos = fromTuple(own.p);
    me.body.vel = fromTuple(own.v);
    me.body.onGround = own.g === 1;
    const acked = own.seq ?? 0;
    if (own.seq !== undefined) me.pending = me.pending.filter((i) => i.seq > acked);
    // Predicted rocket jumps: once the server's explosion has arrived (the boom event comes just before this
    // snapshot) its state includes the real kick. Until then, replay ours just before the command it happened on
    // (rockets step before the body), or up front if the server is already past that command without a boom.
    me.kicks = me.kicks.filter((k) => !k.view.gone);
    for (const k of me.kicks) if (k.seq <= acked) this.addKick(k.v);
    for (const i of me.pending) {
      for (const k of me.kicks) if (k.seq === i.seq) this.addKick(k.v);
      stepBody(me.body, i, this.map);
    }
    const err = vsub(before, me.body.pos);
    const len = Math.hypot(err.x, err.y, err.z);
    // Corrections are eased in visually over about 150 ms (the in-between-ticks position shifts with the body, the
    // eased offset takes up the difference), including knockback we could not predict; only teleports snap.
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
          this.hud.set({ dead: false, hp: this.mode === 'elim' ? ELIM.health : RK.maxHealth, spectating: null });
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
      case 'flag':
        this.onFlagEvent(e.team, e.a, e.by);
        break;
      case 'round': {
        const mine = this.teamOf(you);
        if (e.winner === null) this.callout(`Round ${e.n} drawn`);
        else this.callout(`${TEAMS[e.winner].name} takes round ${e.n}!`, e.winner);
        sfx.play(e.winner !== null && e.winner === mine ? 'win' : 'out');
        break;
      }
      case 'team': {
        const who = e.id === you ? 'You' : this.name(e.id);
        this.feed(`${who} joined ${TEAMS[e.team].name}`);
        break;
      }
    }
  }

  /** Comic callouts and sounds for a CTF flag changing hands. `team` is the flag's team. */
  private onFlagEvent(team: Team, a: 'take' | 'drop' | 'return' | 'capture', by: string) {
    const mine = this.teamOf(this.ctx.you);
    const flag = TEAMS[team].name;
    const other = (team === 0 ? 1 : 0) as Team;
    const who = by === this.ctx.you ? 'You' : this.name(by);
    const at = this.flagViews[team]?.flag.position;
    const sound = (name: Parameters<typeof sfx.play>[0]) => {
      if (by === this.ctx.you || !at) sfx.play(name);
      else sfx.playAt(name, at.x, at.y, at.z);
    };
    switch (a) {
      case 'take':
        this.callout(`${flag} flag taken!`, team);
        this.feed(`${who} took the ${flag} flag`);
        // Our flag going is an alarm everywhere on the map; taking theirs is a pickup.
        if (team === mine) sfx.play('crack');
        else sound('mega');
        if (by === this.ctx.you) this.addTrauma(0.15);
        break;
      case 'drop':
        this.callout(`${flag} flag dropped!`, team);
        sound('out');
        break;
      case 'return':
        this.callout(`${flag} flag returned`, team);
        sound('coin');
        break;
      case 'capture':
        this.callout(`${TEAMS[other].name} scores!`, other);
        this.feed(`${who} captured the ${flag} flag`);
        sfx.play(other === mine ? 'win' : 'out');
        if (this.effects && at) this.effects.burst(vadd(at, v3(0, 1.5, 0)), TEAMS[other].color, 40, 6, 0.8, 1.2);
        break;
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
    // Neon maps glow: bloom on the bright strips, signs and the sun.
    if (themeOf(map).neon) {
      const bloom = (this.bloom = createBloom(engine.renderer));
      engine.renderHook = () => bloom.render(engine.scene, engine.camera);
      // Neon trails: a hot pink streak cooling into lavender haze.
      this.effects?.trailColors.hot.set(0xff6ad8);
      this.effects?.trailColors.smoke.set(0xb8a0ff);
    }
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
    this.buildFlags();
    this.applyQualityNow(settings.get().quality);
    engine.warmup([...warmupModels(), ...warmupCharacters(loadLook())]);
  }

  /** CTF: a stand and a flag at each base (built once the map and mode are known; removed in other modes). */
  private buildFlags() {
    const { engine, map } = this;
    for (const f of this.flagViews) {
      engine?.scene.remove(f.stand, f.flag, f.ring);
      if (f.label) {
        engine?.scene.remove(f.label);
        f.label.material.map?.dispose();
        f.label.material.dispose();
      }
    }
    this.flagViews = [];
    if (!engine || !map || this.mode !== 'ctf') return;
    const bases = this.bases ?? teamBases(map);
    for (const team of [0, 1] as Team[]) {
      const base = bases[team];
      const stand = buildFlagStand(team);
      stand.position.set(base.x, base.y, base.z);
      const flag = buildFlag(team);
      // Yaw first, then tilt and lie down around the flag's own axes.
      flag.rotation.order = 'YXZ';
      flag.position.set(base.x, base.y + 0.2, base.z);
      const ring = buildReturnRing(team);
      ring.visible = false;
      engine.scene.add(stand, flag, ring);
      this.flagViews.push({ team, base, stand, flag, ring, label: null, labelN: -1, state: 0, droppedAt: 0 });
    }
  }

  private buildViewmodel() {
    const { engine } = this;
    if (!engine) return;
    const mine = this.ctx.room().players.find((p) => p.id === this.ctx.you);
    const vm = buildLauncher(mine?.color);
    vm.add(buildViewHand(mine?.color));
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
        if ((src as THREE.MeshToonMaterial).isMeshToonMaterial) {
          // Worn metal: a warm rim light round the gun's silhouette edges, picking up the dusk sun.
          const base = src.onBeforeCompile.bind(src);
          const key = src.customProgramCacheKey.bind(src);
          mat.onBeforeCompile = (shader, renderer) => {
            base(shader, renderer);
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <opaque_fragment>',
              `{
                float rim = pow(1.0 - max(dot(normalize(normal), normalize(vViewPosition)), 0.0), 3.0);
                outgoingLight += vec3(1.0, 0.58, 0.32) * rim * 0.5;
              }
              #include <opaque_fragment>`,
            );
          };
          mat.customProgramCacheKey = () => `${key()}|vmRim`;
        }
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
    const team = this.teamOfInfo(info);
    const paint = team !== undefined ? TEAMS[team].color : info.color;
    const look = info.look ?? DEFAULT_LOOK;
    const tint = team !== undefined ? TEAMS[team].color : undefined;
    const group = this.makeRemoteModel(look, tint);
    const label = makeLabel(info.name, colorHex(paint));
    label.position.y = RK.height + 0.2;
    group.add(label);
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTexture(), color: paint, transparent: true, depthWrite: false }));
    marker.renderOrder = 10;
    marker.visible = false;
    group.add(marker);
    let ally: THREE.Sprite | null = null;
    if (team !== undefined && team === this.teamOf(this.ctx.you)) {
      // Teammates show through walls; enemies never do.
      ally = new THREE.Sprite(new THREE.SpriteMaterial({ map: allyTexture(), color: paint, transparent: true, depthWrite: false, depthTest: false }));
      ally.renderOrder = 11;
      group.add(ally);
    }
    this.engine.scene.add(group);
    r = {
      group,
      look,
      tint,
      lookKey: characterKey(look, tint),
      pose: { speed: 0, vx: 0, vz: 0, yaw: 0, onGround: true, vy: 0, pitch: 0, t: 0, dt: 0, firing: 0 },
      kick: 0,
      ground: true,
      vy: 0,
      label,
      marker,
      ally,
      team,
      paint,
      labelW: label.scale.x,
      labelH: label.scale.y,
      color: info.color,
      name: info.name,
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
    r.ally?.material.dispose();
    this.remotes.delete(id);
  }

  /** The robot for another player in their look; in team modes `tint` (the team colour) replaces the body colour. */
  private makeRemoteModel(look: Look, tint: number | undefined): THREE.Group {
    return buildCharacter(look, tint);
  }

  /** Blows a remote robot apart where it stands; the pieces fly away from the killer. */
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
    const pieces = buildCharacterPieces(r.look, r.tint, r.group, push);
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
    view.gone = true;
    this.rockets.delete(id);
  }

  private addKick(v: Vec3) {
    const b = this.me.body;
    b.vel.x += v.x;
    b.vel.y += v.y;
    b.vel.z += v.z;
    if (v.y > 0) b.onGround = false;
  }

  /**
   * Our rocket hit the map: hide it until the server's explosion and, if we are in the blast, take the knockback now
   * instead of a round trip later. Same formula as the server (shared splashKnock).
   */
  private localHit(view: RocketView, at: Vec3, seq: number) {
    view.hit = true;
    view.stopped = true;
    view.group.visible = false;
    if (view.light) view.light.intensity = 0;
    const { map, me } = this;
    if (!map || me.dead) return;
    const k = splashKnock(at, me.body.pos, map.boxes, false);
    if (!k) return;
    const s = RK.selfKnockbackScale;
    const v = v3(k.x * s, k.y * s, k.z * s);
    this.addKick(v);
    me.kicks.push({ view, seq, v });
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

    // Elimination spectators flip between living teammates with a click or Space.
    if (this.mode === 'elim' && me.dead && !this.paused && (input.clicked() || input.once('Space'))) this.cycleSpectate();
    this.updateCamera(dt, now);
    const cam = engine.camera;
    sfx.listen(cam.position.x, cam.position.y, cam.position.z, cam.rotation.y);
    sfx.heartbeat(this.me.dead ? 0 : this.hud.get().hp, RK.maxHealth);
    this.updateRemotes(dt, now);
    this.updateRockets(dt, now);
    this.updateFlags(now);
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
      const spectating = this.me.dead && this.mode === 'elim' ? this.specId : null;
      if ((s.spectating ?? null) !== spectating) this.hud.set({ spectating });
      if (this.flagViews.length) {
        const ret = (team: Team) => {
          const f = this.flagViews[team];
          return f.state === 2 ? Math.ceil(Math.max(0, CTF.returnSeconds - (now - f.droppedAt))) : 0;
        };
        const r0 = ret(0);
        const r1 = ret(1);
        if (!s.flagReturn || s.flagReturn[0] !== r0 || s.flagReturn[1] !== r1) this.hud.set({ flagReturn: [r0, r1] });
      }
      const fps = Math.round(engine.fps);
      if (Math.abs(fps - s.fps) >= 2) this.hud.set({ fps });
      const speed = this.me.dead ? 0 : Math.hypot(this.me.body.vel.x, this.me.body.vel.z);
      if (s.speed === undefined || Math.abs(s.speed - speed) > 0.3) this.hud.set({ speed });
      const vspeed = this.me.dead || this.me.body.onGround ? 0 : this.me.body.vel.y;
      if (s.vspeed === undefined || Math.abs(s.vspeed - vspeed) > 0.3) this.hud.set({ vspeed });
    }
  }

  /** Flying droid pieces: a couple of seconds of tumbling, then gone (they share the droid's geometry and materials). */
  private updateWrecks(dt: number) {
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.life -= dt;
      if (w.life > 0) {
        updateCharacterPieces(w.pieces, dt, w.floorY);
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
      // Quantised before prediction so the server steps with exactly these numbers, and the upload stays short.
      yaw: Math.round(me.yaw * 1e4) / 1e4,
      pitch: Math.round(me.pitch * 1e4) / 1e4,
    };
    // Our rockets fly one step per command, before the body moves, exactly like on the server (applyInput), so a
    // hit and its knockback land on the same command there and here.
    for (const view of this.rockets.values()) {
      const p = view.sim;
      if (!p || view.hit) continue;
      const v = view.vel;
      scratchTo.x = p.x + v.x * RK.dt;
      scratchTo.y = p.y + v.y * RK.dt;
      scratchTo.z = p.z + v.z * RK.dt;
      const hit = segmentBoxes(p, scratchTo, map.boxes);
      if (hit) {
        // Like the server: the blast sits just off the surface.
        const t = hit.t * RK.dt;
        this.localHit(view, v3(p.x + v.x * t + hit.normal.x * 0.05, p.y + v.y * t + hit.normal.y * 0.05, p.z + v.z * t + hit.normal.z * 0.05), inp.seq);
      } else {
        p.x = scratchTo.x;
        p.y = scratchTo.y;
        p.z = scratchTo.z;
      }
    }
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
      // Reload counted in commands, as the server does for humans, so we fire on the same command it does.
      if (inp.fire && inp.seq >= me.fireSeq) {
        me.fireSeq = inp.seq + FIRE_STEPS;
        const dir = lookDir(inp.yaw, inp.pitch);
        const eye = eyePosition(me.body.pos);
        let origin = vadd(eye, vscale(dir, RK.muzzleOffset));
        if (segmentBoxes(eye, origin, map.boxes)) origin = vadd(eye, vscale(dir, 0.05));
        const view = this.spawnRocket(`${this.ctx.you}:${inp.seq}`, origin, vscale(dir, RK.rocketSpeed), false, true);
        view.sim = { ...origin };
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
    // The rocket shows at the muzzle from this very frame, with a hot trail puff behind it, so the shot reads at once.
    view.group.position.set(muzzle.x, muzzle.y, muzzle.z);
    view.trail = TRAIL_STEP;
    // Two small, quick puffs at the barrel tip, drifting forward and out to the right, away from the crosshair.
    const rx = Math.cos(me.yaw);
    const rz = -Math.sin(me.yaw);
    for (let i = 0; i < 2; i++) {
      const out = 0.6 + Math.random() * 0.6;
      this.effects?.smoke(
        { x: muzzle.x + rx * 0.05, y: muzzle.y - 0.02, z: muzzle.z + rz * 0.05 },
        0.1 + Math.random() * 0.06,
        0.16 + Math.random() * 0.06,
        { x: dir.x * 2 + rx * out, y: dir.y * 2 + 0.3, z: dir.z * 2 + rz * out },
        1,
      );
    }
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
    me.smooth.x = damp(me.smooth.x, 0, 20, dt);
    me.smooth.y = damp(me.smooth.y, 0, 20, dt);
    me.smooth.z = damp(me.smooth.z, 0, 20, dt);

    if (me.dead && !this.wasDead) {
      // Presses from the last life must not flip the spectator camera straight away.
      this.input?.clearOnce();
      this.specFresh = true;
      this.deathT = 0;
      this.deathYaw = me.yaw;
      this.deathPitch = me.pitch;
      this.deathCam = null;
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
    const spec = me.dead && this.mode === 'elim' && this.deathT > 1.2 ? this.spectateTarget() : null;
    if (spec) {
      // Elimination: once the death beat has played, ride along behind a living teammate.
      this.deathT += dt;
      this.chaseCam(spec, dt);
      ex = this.specCam.x;
      ey = this.specCam.y;
      ez = this.specCam.z;
      yaw = this.specYaw;
      pitch = this.specPitch;
      roll = 0;
    } else if (me.dead) {
      // Death camera: pull up and back from the body, tip a little and turn to face whoever got us.
      this.deathT += dt;
      const k = smoothstep(this.deathT / 0.9);
      const killer = this.killer ? this.remotes.get(this.killer) : undefined;
      this.deathCam ??= this.safeDeathCam(ex, ey, ez, killer?.group.visible ? killer.group.position : null, me.yaw);
      ex += (this.deathCam.x - ex) * k;
      ey += (this.deathCam.y - ey) * k;
      ez += (this.deathCam.z - ez) * k;
      if (killer?.group.visible) {
        const dx = killer.group.position.x - ex;
        const dz = killer.group.position.z - ez;
        const dy = killer.group.position.y + 1.2 - ey;
        this.deathYaw = lerpAngle(this.deathYaw, Math.atan2(-dx, -dz), 1 - Math.exp(-2.5 * dt));
        this.deathPitch = damp(this.deathPitch, clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.8, 0.8), 2.5, dt);
      } else this.deathPitch = damp(this.deathPitch, -0.25, 2, dt);
      yaw = this.deathYaw;
      pitch = this.deathPitch;
      roll = 0.2 * k * (calm ? 0.3 : 1);
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

  /** The teammate we spectate: the current pick while they live, else the first living teammate. */
  private spectateTarget(): Remote | null {
    const mine = this.teamOf(this.ctx.you);
    if (this.specId) {
      const r = this.remotes.get(this.specId);
      if (r && r.group.visible && r.team === mine) return r;
    }
    for (const [id, r] of this.remotes) {
      if (r.group.visible && r.team === mine) {
        this.specId = id;
        this.specFresh = true;
        return r;
      }
    }
    this.specId = null;
    return null;
  }

  private cycleSpectate() {
    const mine = this.teamOf(this.ctx.you);
    const ids = [...this.remotes].filter(([, r]) => r.group.visible && r.team === mine).map(([id]) => id);
    if (!ids.length) return;
    const i = this.specId ? ids.indexOf(this.specId) : -1;
    this.specId = ids[(i + 1) % ids.length];
    this.specFresh = true;
  }

  /** Over-the-shoulder camera 3 m behind and above `r`, pulled in where a wall is in the way, looking at its head. */
  private chaseCam(r: Remote, dt: number) {
    const p = r.group.position;
    const yaw = r.group.rotation.y;
    specFrom.x = p.x;
    specFrom.y = p.y + RK.eyeHeight;
    specFrom.z = p.z;
    const back = 3.2;
    specTo.x = p.x + Math.sin(yaw) * back;
    specTo.y = specFrom.y + 0.9;
    specTo.z = p.z + Math.cos(yaw) * back;
    const hit = this.map ? segmentBoxes(specFrom, specTo, this.map.boxes) : null;
    const t = hit ? Math.max(0.15, hit.t - 0.12) : 1;
    const tx = specFrom.x + (specTo.x - specFrom.x) * t;
    const ty = specFrom.y + (specTo.y - specFrom.y) * t;
    const tz = specFrom.z + (specTo.z - specFrom.z) * t;
    const c = this.specCam;
    if (this.specFresh) {
      c.x = tx;
      c.y = ty;
      c.z = tz;
    } else {
      c.x = damp(c.x, tx, 10, dt);
      c.y = damp(c.y, ty, 10, dt);
      c.z = damp(c.z, tz, 10, dt);
    }
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const dy = specFrom.y - c.y;
    const wantYaw = Math.atan2(-dx, -dz);
    const wantPitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.9, 0.6);
    if (this.specFresh) {
      this.specYaw = wantYaw;
      this.specPitch = wantPitch;
      this.specFresh = false;
    } else {
      this.specYaw = lerpAngle(this.specYaw, wantYaw, 1 - Math.exp(-12 * dt));
      this.specPitch = damp(this.specPitch, wantPitch, 12, dt);
    }
  }

  /**
   * The death camera's resting spot: up to 2 m above the eye, then up to 3.5 m back along the line from the killer
   * (or behind the view without one). Each leg is traced against the map and stops short of whatever it hits, so the
   * camera never ends up inside a box or its ink hull (which would paint the whole screen black).
   */
  private safeDeathCam(x: number, y: number, z: number, killer: THREE.Vector3 | null, yaw: number): Vec3 {
    const boxes = this.map?.boxes ?? [];
    const leg = (from: Vec3, dx: number, dy: number, dz: number, len: number): Vec3 => {
      // Probe a margin further than we go, then back off by it, so the lens keeps clear of the surface.
      const margin = 0.6;
      const reach = len + margin;
      const hit = segmentBoxes(from, v3(from.x + dx * reach, from.y + dy * reach, from.z + dz * reach), boxes);
      const go = hit ? Math.max(0, hit.t * reach - margin) : len;
      return v3(from.x + dx * go, from.y + dy * go, from.z + dz * go);
    };
    const up = leg(v3(x, y, z), 0, 1, 0, 2);
    let bx = Math.sin(yaw);
    let bz = Math.cos(yaw);
    if (killer) {
      const dx = x - killer.x;
      const dz = z - killer.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.5) {
        bx = dx / d;
        bz = dz / d;
      }
    }
    return leg(up, bx, 0, bz, 3.5);
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
        r.group.position.set(x, y + (pb.g ? 0 : 0.05), z);
        r.group.rotation.y = yaw;
        this.animateRemote(r, pa, pb, sameLife ? alpha : 1, yaw, dt);
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
          r.marker.visible = show > 0 && !r.ally;
          r.marker.material.opacity = show;
          r.marker.scale.set(size, size, 1);
          r.marker.position.y = RK.height + 0.15 + size * 0.5;
          const top = RK.height + 0.2 + (show > 0 ? size : 0) + r.labelH * (k - 1) * 0.5;
          r.label.position.y = top;
          if (r.ally) {
            // Teammates: the diamond sits above the name at a steady screen size (never smaller than up close).
            const a = Math.max(0.24, d * 0.02);
            r.ally.scale.set(a, a, 1);
            r.ally.position.y = top + r.labelH * k * 0.5 + a * 0.6;
          }
        }
      }
    }
    for (const r of this.remotes.values()) if (r.seen !== frame) r.group.visible = false;
  }

  /**
   * CTF flags: on the stand at base, on the carrier's back (pole tilted, cloth streaming behind), or lying where it
   * fell with a ring that shrinks as its auto-return runs out.
   */
  private updateFlags(now: number) {
    if (!this.flagViews.length) return;
    updateFlagTime(now);
    const fl = this.lastFlags;
    for (const f of this.flagViews) {
      const snap = fl?.[f.team];
      const g = f.flag;
      const state = snap?.s ?? 0;
      f.ring.visible = state === 2;
      if (f.label) f.label.visible = state === 2;
      if (state === 0 || !snap) {
        g.visible = true;
        g.position.set(f.base.x, f.base.y + 0.2, f.base.z);
        g.rotation.set(0, now * 0.15, 0);
        g.scale.setScalar(1);
        continue;
      }
      if (state === 1) {
        // Our own carried flag is not drawn in first person (it would fill the screen); the HUD says we have it.
        const carrier = snap.by && snap.by !== this.ctx.you ? this.remotes.get(snap.by) : undefined;
        g.visible = snap.by !== this.ctx.you && (!carrier || carrier.group.visible);
        if (carrier) {
          const cp = carrier.group.position;
          const yaw = carrier.group.rotation.y;
          g.position.set(cp.x + Math.sin(yaw) * 0.32, cp.y + 0.45, cp.z + Math.cos(yaw) * 0.32);
          g.rotation.set(0, yaw - Math.PI / 2, -0.32);
        } else {
          g.position.set(snap.p[0], snap.p[1] + 0.45, snap.p[2]);
          g.rotation.set(0, 0, -0.32);
        }
        g.scale.setScalar(0.62);
        continue;
      }
      // Dropped: the flag lies on its side, the ring and a countdown over it.
      g.visible = true;
      const lie = f.team * 1.7 + 0.6;
      g.position.set(snap.p[0], snap.p[1] + 0.15, snap.p[2]);
      g.rotation.set(1.45, lie, 0);
      g.scale.setScalar(0.85);
      // Ring and countdown centre on the lying flag, a metre along the pole.
      const cx = snap.p[0] + Math.sin(lie) * 1.1;
      const cz = snap.p[2] + Math.cos(lie) * 1.1;
      const left = Math.max(0, CTF.returnSeconds - (this.time - f.droppedAt));
      const k = Math.max(0.05, left / CTF.returnSeconds);
      f.ring.position.set(cx, snap.p[1] + 0.04, cz);
      f.ring.scale.set(k, 1, k);
      const n = Math.ceil(left);
      if (n !== f.labelN) {
        f.labelN = n;
        if (f.label) {
          this.engine?.scene.remove(f.label);
          f.label.material.map?.dispose();
          f.label.material.dispose();
        }
        f.label = makeLabel(`Back in ${n}s`, TEAMS[f.team].css);
        this.engine?.scene.add(f.label);
      }
      f.label?.position.set(cx, snap.p[1] + 1.3, cz);
    }
  }

  /** Poses a remote robot between two snapshots: walk cycle, air pose, landing, aim pitch and the shot kick. */
  private animateRemote(r: Remote, pa: PlayerSnap, pb: PlayerSnap, alpha: number, yaw: number, dt: number) {
    r.kick = Math.max(0, r.kick - dt * 4);
    const s = r.pose;
    s.vx = pa.v[0] + (pb.v[0] - pa.v[0]) * alpha;
    s.vz = pa.v[2] + (pb.v[2] - pa.v[2]) * alpha;
    s.vy = pb.v[1];
    s.speed = Math.hypot(s.vx, s.vz);
    s.yaw = yaw;
    s.onGround = pb.g === 1;
    s.pitch = pa.pt + (pb.pt - pa.pt) * alpha;
    s.t += dt;
    s.dt = dt;
    s.firing = r.kick;
    animateCharacter(r.group, s);
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
