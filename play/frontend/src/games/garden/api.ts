// Contracts between the Garden Sentinels client modules. client.ts (net, interpolation, camera, input, placement)
// drives everything; each module below owns one concern and only talks to the others through these interfaces.
//
//   models.ts    loads the Blender-built GLBs (public/models/garden/{towers,enemies,kit}.glb from tools/blender/build_garden_*.py)
//   world.ts     the garden boards: terrain, paths, water, bridges, foliage, rocks, lamps, portals, greenhouse, sun, sky
//   post.ts      render pipeline: HDR, bloom, soft tilt-shift, grade, vignette, AA
//   units.ts     tower and enemy views: placement, aiming, animation, health bars, selection ring, range circles
//   fx.ts        laser beams, missiles, explosions, slow fields, shield bubbles, zaps, disrupt bolts, deaths, popups
//   audio.ts     synthesized sound and a gentle music bed
//   Hud.tsx      React HUD (garden.css) reading the client store and calling client actions
//
// Coordinates: metres, y up, ground at y = 0, yaw 0 faces -Z, positive yaw turns left. A board's cells and routes map
// to the world through @shared/garden/board (boardOrigin, cellToWorld, routeGeom, routePos).

import type * as THREE from 'three';
import type { GMode } from '@shared/garden/constants';
import type { EnemyKind } from '@shared/garden/enemies';
import type { BoardOrigin } from '@shared/garden/board';
import type { GMapDef } from '@shared/garden/maps';
import type { BoardInfo, GScore, Phase, TowerInfo } from '@shared/garden/protocol';
import type { Level, TargetMode, TowerKind } from '@shared/garden/towers';

export type Quality = 'low' | 'medium' | 'high';

export interface P3 {
  x: number;
  y: number;
  z: number;
}

// ---- models.ts ------------------------------------------------------------------------------------------------------
//
// GLB conventions (written by the Blender scripts, relied on here):
//   towers.glb   one root object per kind and level: `Tower_<kind>_<lv>` (lv 1..3), origin at the ground centre,
//                footprint within a 1.8 m circle (one 2 m cell), front = Blender +Y (glTF -Z). Children:
//                `<root>_head`   (optional) pivot that yaws to aim (laser, missile); its local -Z (glTF) is the aim
//                `<root>_muzzle` / `<root>_muzzle<N>` empties where beams / missiles leave
//                Materials named `Team` are tinted with the owner's colour; materials named `Glow*` are emissive and
//                may be pulsed. Level 3 is visibly grander (gold trim "Masterwork").
//   enemies.glb  one root per kind: `Enemy_<kind>`, origin at the feet, facing Blender +Y, real-world size (runner
//                0.8 m tall, skitter 0.5 m, disruptor 0.9 m, brute 1.8 m, colossus 3 m). Animation clips named
//                `<kind>_walk` (loop), `<kind>_idle` (loop), `<kind>_die`, and `disruptor_cast`. Materials `Crystal*`
//                and `Eyes` are emissive.
//   kit.glb      one root per piece: `Kit_<name>` (see KitName), origin at the ground centre, sized in metres for a
//                2 m grid. `Kit_bridge` spans 2 x 2 cells along its local Y; `Kit_portal` is 2 x 2 cells and opens
//                towards +Y; `Kit_greenhouse` is 4 x 4 cells with its door towards +Y.

export type KitName =
  | 'rock_a'
  | 'rock_b'
  | 'rock_c'
  | 'bush_a'
  | 'bush_b'
  | 'fern'
  | 'tree_a'
  | 'tree_b'
  | 'flowers_a'
  | 'flowers_b'
  | 'flowers_c'
  | 'grass_tuft'
  | 'reeds'
  | 'lilypad'
  | 'lamp'
  | 'solar'
  | 'bridge'
  | 'portal'
  | 'greenhouse'
  | 'path_stone'
  | 'pebble'
  | 'hedge_strip'
  | 'pad';

export interface TowerModel {
  root: THREE.Object3D;
  /** Yaw pivot (laser, missile); null for towers that do not aim. */
  head: THREE.Object3D | null;
  /** Where beams / missiles leave, in order (at least one for laser and missile). */
  muzzles: THREE.Object3D[];
  /** Emissive materials (pulse them for charge / disabled flicker). */
  glow: THREE.MeshStandardMaterial[];
  dispose(): void;
}

export interface EnemyModel {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  /** Missing clips are undefined (fall back to bobbing). */
  actions: Partial<Record<'walk' | 'idle' | 'die' | 'cast', THREE.AnimationAction>>;
  /** Emissive materials (flash white on hit). */
  glow: THREE.MeshStandardMaterial[];
  dispose(): void;
}

export interface GardenModels {
  /** Resolves when every GLB is loaded or failed (then primitives stand in). */
  ready: Promise<void>;
  tower(kind: TowerKind, lv: Level, color: number): TowerModel;
  enemy(kind: EnemyKind): EnemyModel;
  /** A fresh (shared-geometry) copy of a kit piece; a primitive if the GLB is missing. */
  kit(name: KitName): THREE.Object3D;
  /** Geometry + material pairs of a kit piece, for instancing (world.ts scatters hundreds of these). */
  kitParts(name: KitName): { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }[];
}

export type CreateModels = () => GardenModels;

// ---- world.ts -------------------------------------------------------------------------------------------------------

export interface WorldView {
  readonly group: THREE.Group;
  readonly sun: THREE.DirectionalLight;
  /** Bounds of everything (for the camera clamp): min/max world x/z. */
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Greenhouse world position per board (for leak flashes and the camera "home"). */
  readonly goals: P3[];
  /** Portal mouth world position per board, per entry. */
  readonly portals: P3[][];
  /** Lives lost on a board (cracks / dimming on the greenhouse); 0..1 of lives left. */
  setHealth(b: number, frac: number): void;
  /** Versus: a board was eliminated (wilt it: desaturate, lights off). */
  setOut(b: number): void;
  /** Wind sway, water, lamp flicker, portal swirl. */
  update(dt: number, time: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

export type CreateWorldView = (scene: THREE.Scene, def: GMapDef, origins: BoardOrigin[], models: GardenModels, quality: Quality) => WorldView;

// ---- post.ts --------------------------------------------------------------------------------------------------------

export interface Pipeline {
  /** Renders the scene through the post chain (called from the engine's render hook). */
  render(dt: number): void;
  setSize(w: number, h: number): void;
  setQuality(q: Quality): void;
  /** Tilt-shift focus: world point the camera looks at, and the camera's distance to it. */
  setFocus(target: P3, distance: number): void;
  dispose(): void;
}

export type CreatePipeline = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, quality: Quality) => Pipeline;

// ---- units.ts -------------------------------------------------------------------------------------------------------

/** One enemy's interpolated state for this frame (client.ts computes it from the snapshots with routePos). */
export interface EnemyFrame {
  id: number;
  kind: EnemyKind;
  b: number;
  x: number;
  z: number;
  yaw: number;
  /** 0..1 */
  hp: number;
  /** EFlag bits. */
  f: number;
  /** Speed multiplier this frame (slowed enemies animate slower). */
  speed: number;
  /** Height above the ground (flying Glow Moths cruise at FLY_HEIGHT; 0 or missing for walkers). */
  y?: number;
}

export interface Units {
  /** Tower views. Positions come from the board origin + cell. */
  addTower(t: TowerInfo, color: number): void;
  upgradeTower(id: number, lv: Level): void;
  removeTower(id: number): void;
  /** Live state each snapshot: aim at a world point (null = idle scan), TFlag bits. */
  setTowerState(id: number, aim: P3 | null, flags: number): void;
  /** World position of a tower's muzzle `i` (wraps), for beams and missiles; written into `out` when given. */
  muzzle(id: number, i: number, out?: P3): P3 | null;
  /** All enemies this frame; enemies missing from the list are removed (without a death; deaths come via kill()). */
  syncEnemies(list: EnemyFrame[]): void;
  /** Play the death (shatter / topple) and remove after. */
  kill(id: number): void;
  /** Hit flash. */
  hit(id: number): void;
  /** Current world position of an enemy's centre (for beams / missile homing); written into `out` when given. */
  enemyPos(id: number, out?: P3): P3 | null;
  /** Disruptor cast animation. */
  cast(id: number): void;
  /** Selection ring + range circle on a tower (null clears). */
  select(id: number | null): void;
  /** Placement ghost: a translucent tower at a cell with its range circle; red when not allowed (null hides). */
  ghost(g: { kind: TowerKind; x: number; z: number; ok: boolean; range: number } | null): void;
  /** Raycast pick: tower id under the ray, or null. */
  pickTower(ray: THREE.Ray): number | null;
  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

export type CreateUnits = (scene: THREE.Scene, def: GMapDef, origins: BoardOrigin[], models: GardenModels) => Units;

// ---- fx.ts ----------------------------------------------------------------------------------------------------------

export interface Fx {
  /**
   * Continuous laser beams this frame, keyed by tower id. Beams not in the map fade out. `chain` = extra segments
   * for the level 3 chain.
   */
  beams(list: { tw: number; from: P3; to: P3; lv: Level; chain: P3[] }[]): void;
  /** A missile flying from `from` to an enemy (position looked up each frame through `target`), landing after `ft` s. */
  missile(mid: number, from: P3, target: () => P3 | null, ft: number): void;
  /** Explosion of missile `mid` (removes it if still flying). */
  boom(mid: number, at: P3, radius: number): void;
  /** Persistent fields per tower: slow flower field, shield bubble, beacon aura. Call on build/upgrade/sell. */
  field(tw: number, kind: 'slow' | 'shield' | 'beacon' | null, at: P3, radius: number, lv: Level): void;
  /** Slow fields idle (rim only) until told an enemy is inside; ignored for other towers. Safe to call every frame. */
  fieldActive?(tw: number, active: boolean): void;
  /** Shield pulse (zap) / a disruption the shield blocked (ripple at `hit`). */
  zap(tw: number): void;
  /** Disruptor bolt from an enemy to a tower; blocked bolts splash off the bubble. */
  disrupt(from: P3, to: P3, blocked: boolean): void;
  /** Disabled tower: sparks / static while > 0 (seconds left). */
  disabled(tw: number, at: P3, on: boolean): void;
  /** Enemy death burst (crystal shards in the enemy's colours) and a floating "+gold" if gold > 0. */
  death(at: P3, kind: EnemyKind, gold: number): void;
  /** An enemy reached the greenhouse. */
  leak(at: P3): void;
  /** Build dust + leaves / upgrade sparkle / sell poof. */
  build(at: P3, lv: Level): void;
  sell(at: P3): void;
  /** Sprinkler water bomb arcing from `from` to an enemy (looked up each frame), landing after `ft` s; then splash(mid). */
  water?(mid: number, from: P3, target: () => P3 | null, ft: number): void;
  /** Water bomb landing: splash ring, droplets, a wet patch that fades (removes the bomb if still flying). */
  splash?(mid: number, at: P3, radius: number): void;
  /** Bloomkin heal pulse: a soft green-gold ring and rising petals. */
  heal?(at: P3, radius: number): void;
  /** Sunburst: a warm beam from the sky, a ground flash and a shock ring (radius m). */
  sunburst?(at: P3, radius: number): void;
  /** Sunburst aiming ring under the pointer (null hides). */
  sunAim?(at: P3 | null, radius: number): void;
  /** Spawn swirl at a portal. */
  spawn(at: P3): void;
  /** Map ping in a player's colour. */
  ping(at: P3, color: number): void;
  update(dt: number, camera: THREE.Camera): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

export type CreateFx = (scene: THREE.Scene, quality: Quality) => Fx;

// ---- audio.ts -------------------------------------------------------------------------------------------------------

export type GSound =
  | 'laser' // start of a beam (short zing); the hum is setBeams
  | 'missile'
  | 'boom'
  | 'zap'
  | 'disrupt'
  | 'blocked'
  | 'die'
  | 'dieBig'
  | 'leak'
  | 'build'
  | 'upgrade'
  | 'sell'
  | 'deny'
  | 'click'
  | 'hover'
  | 'coin'
  | 'waveStart'
  | 'bossWave'
  | 'waveClear'
  | 'send'
  | 'incoming'
  | 'out'
  | 'ping'
  | 'victory'
  | 'defeat'
  | 'splash' // sprinkler water bomb landing
  | 'heal' // Bloomkin pulse
  | 'sun' // Sunburst strike
  | 'moth'; // a Glow Moth flutters past (soft, rate-limited)

export interface GAudio {
  unlock(): void;
  /** Camera target and zoom (0 near .. 1 far) for panning / distance attenuation. */
  listen(target: P3, zoom: number): void;
  play(name: GSound, opts?: { at?: P3; amount?: number; kind?: EnemyKind | TowerKind }): void;
  /** Number of active laser beams (a soft shared hum). */
  setBeams(n: number): void;
  /** Music intensity: 0 build phase .. 1 heavy wave, 2 boss. */
  setIntensity(x: number): void;
  dispose(): void;
}

// ---- client.ts <-> Hud.tsx ------------------------------------------------------------------------------------------

/** Versus: enemies queued at a board for its next wave (server BoardSnap.inc; sender known when one player sent that kind). */
export interface HudIncoming {
  kind: EnemyKind;
  count: number;
  from?: string;
  fromColor?: number;
}

export interface HudBoard {
  b: number;
  /** Owner (versus) or null (co-op). */
  own: string | null;
  name: string;
  color: number;
  lives: number;
  out: boolean;
  /** Finishing place once out (versus). */
  place?: number;
  /** Versus: sends queued for this board's next wave (empty when none). Optional only for the lab mocks. */
  incoming?: HudIncoming[];
  /** Versus: sends between other players aimed at this board since the match started (not toasted; a quiet counter). */
  sendsIn?: number;
}

export interface HudPlayer {
  id: string;
  name: string;
  color: number;
  bot: boolean;
  gold: number;
  income: number;
  ready: boolean;
  b: number;
}

export interface HudSelected {
  tower: TowerInfo;
  /** Owner's name and colour. */
  ownerName: string;
  ownerColor: number;
  mine: boolean;
  /** Next level cost (null at level 3), sell value. */
  upCost: number | null;
  sellValue: number;
  /** Live: disabled, shielded, buffed. */
  flags: number;
}

export interface Toast {
  key: number;
  text: string;
  tone: 'info' | 'good' | 'bad' | 'boss';
  at: number;
}

export interface GHudState {
  /** Models loaded and init received. */
  ready: boolean;
  mode: GMode;
  mapName: string;
  wave: number;
  /** Co-op: last wave (victory after it). Versus: 0 (endless). */
  maxWave: number;
  phase: Phase;
  /** Build: seconds to the wave. Wave: enemies left. */
  left: number;
  /** Wave progress 0..1 (for the wave bar). */
  progress: number;
  /** Lives of the board you are looking at / defending, and its maximum. */
  lives: number;
  maxLives: number;
  boards: HudBoard[];
  players: HudPlayer[];
  you: string;
  myBoard: number;
  /** Towers you own (the Coach watches it for your first build). Always set by client.ts; optional for the lab mocks. */
  myTowers?: number;
  /** Versus: watching a running match you are not part of (myBoard -1); no building, ready or sends. Always set by
   * client.ts (optional only so the lab mock states compile). */
  spectator?: boolean;
  /** Versus: sends queued for your board's next wave (always set by client.ts; optional only for the lab mocks). */
  incoming?: HudIncoming[];
  /** Versus, out or spectating: the camera follows the action by itself (false once the player moves it). */
  autoCam?: boolean;
  /** Board the camera is on (versus: you can look at others). */
  viewBoard: number;
  gold: number;
  income: number;
  /** Tower kind being placed. */
  placing: TowerKind | null;
  selected: HudSelected | null;
  /** Next wave preview. */
  next: { kind: EnemyKind; count: number }[];
  bossNext: boolean;
  toasts: Toast[];
  scoresOpen: boolean;
  scores: GScore[];
  end: { win: boolean; winner: string | null; wave: number } | null;
  quality: Quality;
  paused: boolean;
  /** Sunburst charges you hold, and whether you are aiming one (click the board to strike, Esc / right-click cancels). */
  sun?: number;
  aimingSun?: boolean;
}

export interface GardenActions {
  /** Start placing a tower (null cancels; the kind already being placed cancels too, so re-tapping a card toggles). */
  place(kind: TowerKind | null): void;
  upgrade(id: number): void;
  sell(id: number): void;
  setTarget(id: number, tm: TargetMode): void;
  /** Deselect. */
  deselect(): void;
  ready(): void;
  send(kind: EnemyKind, to?: number): void;
  /** Start / cancel aiming a Sunburst (the HUD button and its hotkey call this; client.ts sends the strike on click). */
  sun(): void;
  /** Move the camera to a board (versus). */
  viewBoard(b: number): void;
  setScoresOpen(open: boolean): void;
  setQuality(q: Quality): void;
  leave(): void;
}

export type { BoardInfo };
