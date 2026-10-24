// Contracts between the race view and the modules that build what you see. Every visual module is a function that
// takes a WorldContext and returns a part with an object to add to the scene and optional per-frame update/dispose.
// Keep to these signatures: the race view, the labs and the other modules depend on them.

import type * as THREE from 'three';
import type { PodLivery } from '../core/pods';
import type { Track } from '../core/track';
import type { Theme } from '../core/tracks';

export type Quality = 'low' | 'medium' | 'high';

export interface WorldContext {
  track: Track;
  theme: Theme;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  quality: Quality;
}

/** What every module sees each frame. */
export interface FrameView {
  dt: number;
  /** Seconds since the view started. */
  time: number;
  camera: THREE.PerspectiveCamera;
  /** The player's pod, world space. */
  playerPos: THREE.Vector3;
  playerForward: THREE.Vector3;
  /** Player speed as a fraction of the pod's top speed (can exceed 1 when boosting), and boost state. */
  speed01: number;
  boosting: boolean;
  /** Track-space position of the player. */
  playerS: number;
}

export interface WorldPart {
  object?: THREE.Object3D;
  update?(view: FrameView): void;
  dispose?(): void;
}

export type WorldBuilder = (ctx: WorldContext) => WorldPart;

/** Animation inputs for a pod model. */
export interface PodAnim {
  dt: number;
  time: number;
  /** Fraction of top speed, 0..~1.4. */
  speed01: number;
  throttle: number;
  steer: number;
  boosting: boolean;
  /** Seconds left on a boost-pad surge (> 0 = surging). */
  surge: number;
}

export interface PodVisual {
  /** Root of the model. Origin at the centre of the pod at hover height, nose towards -Z, up +Y, metres. */
  object: THREE.Object3D;
  /**
   * Exhaust points at the back of each engine (children of `object`), for world-space effects like dust and exhaust
   * trails. Their -Z axis... is irrelevant: effects emit towards +Z (backwards) in the pod's frame.
   */
  nozzles: THREE.Object3D[];
  update(anim: PodAnim): void;
  dispose(): void;
}

/** Per-pod data the effects get each frame. */
export interface FxPod {
  visual: PodVisual;
  isPlayer: boolean;
  /** The pod's livery: glow is its engine/exhaust colour. */
  livery: PodLivery;
  speed01: number;
  /** Speed in m/s. */
  speed: number;
  boosting: boolean;
  surge: number;
  /** World velocity, m/s. */
  velocity: THREE.Vector3;
  /** Road point directly under the pod, and the road normal. */
  ground: THREE.Vector3;
  groundNormal: THREE.Vector3;
  /** Wall/pod hit this frame: strength 0..1 and side (-1 left, 1 right). */
  impact: number;
  impactSide: number;
  padHit: boolean;
}

export interface FxView extends FrameView {
  pods: FxPod[];
}

export interface SpeedFx {
  object: THREE.Object3D;
  update(view: FxView): void;
  dispose(): void;
}

/** Final image: renders the scene with post-processing. */
export interface PostFx {
  render(view: FxView): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}
