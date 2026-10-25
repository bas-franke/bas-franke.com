// Contracts between the Last Light client modules. client.ts (net, prediction, input, game rules on the client) drives
// everything; each module below owns one concern and only talks to the others through these interfaces.
//
//   models.ts   loads the Blender-built GLBs (public/models/zombies/*.glb, from tools/blender/build_zombies.py)
//   textures.ts procedural PBR texture sets (albedo / normal / roughness) for the chunk materials
//   world.ts    the room: floor, ceiling, chunk walls and props (instanced, box-projected textures, cracks), boards,
//               lockers, lamps, yard, moonlight
//   post.ts     render pipeline: HDR scene + viewmodel pass, volumetric fog raymarch, bloom, grade, composite
//   fx.ts       debris, dust, decals, blood, sparks, tracers, muzzle flashes, explosions
//   audio.ts    synthesized positional sound with a room reverb
//
// Coordinates: metres, y up, yaw 0 looks down -Z, positive yaw turns left (shared/math.ts).

import type * as THREE from 'three';
import type { Vec3 } from '@shared/math';
import type { ImpactMat } from '@shared/zombies/protocol';
import type { WeaponId, WeaponKind } from '@shared/zombies/weapons';
import type { World } from '@shared/zombies/world';

export type Quality = 'low' | 'medium' | 'high';

/** Layer of the first-person viewmodel (gun + arms): rendered in its own pass on top, never fogged. */
export const VIEWMODEL_LAYER = 1;

// ---- models.ts ------------------------------------------------------------------------------------------------------

/** Animation clips in zombie.glb (in place: the server moves the root; loops marked). */
export type ZombieClip = 'idle' | 'walk' | 'jog' | 'crawl' | 'attack' | 'tear' | 'vault' | 'rise' | 'death_back' | 'death_fwd';
/** Clips in survivor.glb. */
export type SurvivorClip = 'idle' | 'walk' | 'run' | 'downed' | 'reload';

export interface CharacterInstance {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction>;
  /** Named bones (`hand.R`, `head`, ...) for attachments. */
  bones: Record<string, THREE.Bone>;
  /** Zombie only: the separable parts for dismemberment (hide = gone). */
  parts?: { head: THREE.Object3D; armL: THREE.Object3D; armR: THREE.Object3D; legL: THREE.Object3D; legR: THREE.Object3D };
  /** Recolours the variable clothing (zombie: shirt/trousers per variant; survivor: the jacket in the player colour). */
  tint(primary: number, secondary?: number): void;
  dispose(): void;
}

/**
 * Props in props.glb (tools/blender/build_props.py). Origins at the floor centre with the front facing -Z, except: lamp
 * and pendant (origin at the bulb / chandelier ring, cable or rod 1 m up), sconce (origin on the wall plate, sticks out
 * along -Z), board and nade (centre). revolvingDoor has a child `revolvingDoor_wings` that spins around y.
 */
export type PropName =
  | 'locker' | 'lamp' | 'board' | 'nade' | 'fence' | 'tree'
  | 'sofa' | 'armchair' | 'brassTable' | 'coffeeTable' | 'tableLamp' | 'floorLamp' | 'planterTree' | 'flowers'
  | 'sconce' | 'pendant' | 'revolvingDoor' | 'elevatorDoors' | 'securityShutter' | 'barStool' | 'booth'
  | 'diningTable' | 'diningChair' | 'luggageCart' | 'stanchion' | 'receptionBell' | 'computer';

export interface Models {
  /** Resolves when every GLB is loaded (or fell back to primitives). */
  ready: Promise<void>;
  zombie(variant: number): CharacterInstance;
  survivor(color: number): CharacterInstance;
  /** A fresh copy of a gun, origin at the grip, barrel along -Z. `muzzle` is where the flash goes, `mag` animates on reload. */
  weapon(id: WeaponId): { root: THREE.Object3D; muzzle: THREE.Object3D; mag: THREE.Object3D | null };
  /** First-person arms (origin at the camera), posed to hold a gun at the grip. */
  arms(): THREE.Object3D;
  /** Props: 'locker' (1 x 2 x 0.5 m, front faces -Z, origin floor centre), 'lamp' (origin at the bulb; its bulb material is named Bulb), 'board', 'nade', 'fence', 'tree'. */
  prop(name: PropName): THREE.Object3D;
}

// ---- world.ts -------------------------------------------------------------------------------------------------------

export interface LampLight {
  pos: Vec3;
  light: THREE.SpotLight;
  /** Current brightness 0..1 after flicker (post.ts reads it for the light cone in the fog). */
  level: number;
  color: THREE.Color;
}

export interface WorldView {
  readonly group: THREE.Group;
  readonly lamps: LampLight[];
  /** Direction towards the moon (unit) and its colour * intensity. */
  readonly moonDir: THREE.Vector3;
  readonly moon: THREE.DirectionalLight;
  /** Chunk `i` lost health (cracks appear) / broke. */
  setChunkHp(i: number, hp: number): void;
  breakChunk(i: number): void;
  setBoards(window: number, n: number): void;
  /** Flicker, swaying lamps, etc. */
  update(dt: number, time: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

export type CreateWorldView = (scene: THREE.Scene, world: World, models: Models, quality: Quality) => WorldView;

// ---- post.ts --------------------------------------------------------------------------------------------------------

export interface Flashlight {
  pos: Vec3;
  dir: Vec3;
  /** 0..1 */
  on: number;
}

export interface FrameParams {
  time: number;
  dt: number;
  /** 0..1: low health (red vignette, desaturation, pulse). */
  hurt: number;
  /** 0..1: just took a hit (flash). */
  hit: number;
  /** Downed: blurrier, darker, redder. */
  downed: boolean;
  /** Every flashlight in the room, the local one first. */
  flashlights: Flashlight[];
  /** Short-lived point lights (muzzle flashes, explosions) for the fog. */
  flashes: { pos: Vec3; color: THREE.Color; intensity: number }[];
}

export interface Pipeline {
  /** Called by the engine's renderHook. Renders world (layer 0), then viewmodel (layer VIEWMODEL_LAYER), then post. */
  render(p: FrameParams): void;
  /** Adds a temporary blob of dust or smoke to the fog density (lit by every light in the fog). */
  puff(pos: Vec3, radius: number, density: number, life: number, grow?: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

export type CreatePipeline = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, world: World, view: WorldView, quality: Quality) => Pipeline;

// ---- fx.ts ----------------------------------------------------------------------------------------------------------

export interface Fx {
  /** Bullet impact: decal (on chunks it is removed when the chunk breaks), sparks/chips, a small dust puff. */
  impact(p: Vec3, n: Vec3, mat: ImpactMat, chunk: number): void;
  tracer(from: Vec3, to: Vec3, kind: WeaponKind): void;
  muzzle(obj: THREE.Object3D, kind: WeaponKind, viewmodel: boolean): void;
  blood(p: Vec3, dir: Vec3, amount: number): void;
  /** Chunks broke: debris pieces with that chunk's material, dust. `blast` = explosion (more velocity). */
  debris(chunks: number[], from: Vec3, blast: boolean): void;
  explosion(p: Vec3): void;
  /** A body part flies off (dismemberment): a gory chunk and a spray. */
  gib(p: Vec3, dir: Vec3): void;
  /** Dirt bursting up where a zombie rises. */
  rise(p: Vec3): void;
  /** A board flies off a window (tear) or slams on (fix). */
  board(window: number, tear: boolean): void;
  update(dt: number, camera: THREE.Camera): void;
  /** Point lights for the fog this frame. */
  flashes(): FrameParams['flashes'];
  chunkBroken(i: number): void;
  dispose(): void;
}

export type CreateFx = (scene: THREE.Scene, world: World, pipeline: Pipeline) => Fx;

// ---- audio.ts -------------------------------------------------------------------------------------------------------

export type ZSound =
  | 'shot'
  | 'empty'
  | 'reloadOut'
  | 'reloadIn'
  | 'pump'
  | 'bolt'
  | 'impact'
  | 'flesh'
  | 'headshot'
  | 'groan'
  | 'scream'
  | 'swipe'
  | 'tear'
  | 'hammer'
  | 'boom'
  | 'crumble'
  | 'buy'
  | 'deny'
  | 'hurt'
  | 'down'
  | 'revive'
  | 'step'
  | 'knife'
  | 'throw'
  | 'clink'
  | 'waveStart'
  | 'waveEnd'
  | 'gameOver'
  | 'points';

export interface ZAudio {
  unlock(): void;
  listen(pos: Vec3, yaw: number, pitch: number): void;
  /** Flat sound at the listener. `opts.kind` picks the gun voice for 'shot'; `opts.amount` 0..1 scales size. */
  play(name: ZSound, opts?: { kind?: WeaponKind; weapon?: WeaponId; amount?: number }): void;
  /** Positional sound. `id` lets a source (a zombie) keep one voice for groans. */
  playAt(name: ZSound, pos: Vec3, opts?: { kind?: WeaponKind; weapon?: WeaponId; amount?: number; id?: number }): void;
  /** Low ambience bed (wind, creaks, distant noises), 0..1 tension raises it during waves. */
  setTension(t: number): void;
  /** Heartbeat and muffling when hurt or downed. */
  setHurt(hurt: number, downed: boolean): void;
  dispose(): void;
}
