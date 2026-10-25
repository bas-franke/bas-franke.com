// Renders and runs one race: owns the renderer, scene, world, pod models, effects, camera, audio and controls, steps
// the Race simulation every frame and publishes HUD state to a store the React HUD reads.
//
// Debug URL parameters (handy for screenshots and the art labs):
//   ?autopilot   the AI flies the player's pod      ?skipintro   start at the green light
//   ?at=0.4      start the player at 40% of the run  ?freeze      simulation paused (camera still renders)
//   ?quality=low|medium|high
// `window.__racer` exposes { race, view } in dev builds.

import * as THREE from 'three';
import { createStore, type Store } from '../games/types';
import { RaceAudio } from './audio/sound';
import { DISPLAY_KMH, type PodDesign } from './core/pods';
import { INTRO, Race, type Phase, type RacerSetup } from './core/race';
import { trackById } from './core/tracks';
import { ChaseCamera } from './fx/camera';
import { Controls } from './fx/controls';
import { createPostFx } from './fx/post';
import { createSpeedFx } from './fx/speed';
import { createPod } from './vehicle/pod';
import { buildWorld, type World } from './world';
import type { FxPod, FxView, PodVisual, PostFx, Quality, SpeedFx, WorldContext } from './world/types';

/** Hover height of a pod's centre above the road. */
export const HOVER = 1.5;
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export interface MinimapPod {
  x: number;
  y: number;
  color: string;
  player: boolean;
}

export interface HudState {
  phase: Phase;
  trackName: string;
  /** Countdown number (3, 2, 1) during the countdown, 0 = GO shown briefly, -1 otherwise. */
  countdown: number;
  /** Metres left to the finish line. */
  toGo: number;
  position: number;
  racers: number;
  /** Race time in seconds (0 before the start). */
  time: number;
  speedKmh: number;
  /** 0..1 of the top speed (boost goes above 1). */
  speed01: number;
  boost: number;
  boosting: boolean;
  drafting: boolean;
  /** Minimap outline (0..1 square) and the pods on it. */
  outline: [number, number][];
  pods: MinimapPod[];
  /** Live standings, leader first. */
  standings: { name: string; color: string; player: boolean; finished: boolean }[];
  wrongWay: boolean;
  paused: boolean;
}

export interface RaceResult {
  trackId: string;
  order: { id: string; name: string; time: number; projected: boolean; bestLap: number; player: boolean; podId: string }[];
  playerPosition: number;
  playerTime: number;
  playerBestLap: number;
}

export interface RaceViewOptions {
  trackId: string;
  racers: RacerSetup[];
  quality?: Quality;
  onFinish?(result: RaceResult): void;
}

export class RaceView {
  readonly race: Race;
  readonly hud: Store<HudState>;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(68, 1, 0.3, 6000);
  private readonly ctx: WorldContext;
  private readonly world: World;
  private readonly visuals: PodVisual[] = [];
  private readonly fx: SpeedFx;
  private readonly post: PostFx;
  private readonly chase: ChaseCamera;
  private readonly controls = new Controls();
  readonly audio: RaceAudio;
  private readonly fxPods: FxPod[] = [];
  private readonly prevPos: THREE.Vector3[] = [];
  private raf = 0;
  private last = 0;
  private time = 0;
  private hudAt = 0;
  private paused = false;
  private finished = false;
  /** Camera up for the player, without the knife-edge roll (the horizon must not tip with it). */
  private readonly camUp = new THREE.Vector3(0, 1, 0);
  private readonly observer: ResizeObserver;
  private readonly params = new URLSearchParams(location.search);
  private readonly frozen = this.params.has('freeze');

  constructor(private readonly container: HTMLElement, private readonly opts: RaceViewOptions) {
    const def = trackById(opts.trackId);
    const quality = (this.params.get('quality') as Quality | null) ?? opts.quality ?? defaultQuality();
    this.race = new Race(def, opts.racers, {
      onCountdown: (n) => this.audio.countdown(n),
      onImpact: (r, k) => this.audio.impact(k, r === this.race.player),
      onPad: (r) => this.audio.pad(r === this.race.player),
      onFinish: (r) => {
        if (r === this.race.player) this.audio.finish(r.position);
      },
    });
    if (this.params.has('autopilot')) this.race.autopilot = true;
    if (this.params.has('skipintro')) this.race.time = -0.01;
    const at = Number(this.params.get('at'));
    if (at > 0) {
      this.race.time = 0.01;
      this.race.phase = 'racing';
      const p = this.race.player;
      p.state.s = this.race.track.raceS(Math.min(1, at));
      p.lap = 0;
      p.state.v = p.stats.topSpeed * 0.8;
    }

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.5 : quality === 'medium' ? 1.25 : 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.className = 'racer-canvas';
    container.appendChild(this.renderer.domElement);

    this.ctx = { track: this.race.track, theme: def.theme, renderer: this.renderer, scene: this.scene, camera: this.camera, quality };
    this.world = buildWorld(this.ctx);
    for (const r of this.race.racers) {
      const v = createPod(r.pod, quality);
      this.scene.add(v.object);
      this.visuals.push(v);
      this.prevPos.push(new THREE.Vector3());
      this.fxPods.push({
        visual: v,
        isPlayer: r === this.race.player,
        livery: r.pod.livery,
        speed01: 0,
        speed: 0,
        boosting: false,
        surge: 0,
        velocity: new THREE.Vector3(),
        ground: new THREE.Vector3(),
        groundNormal: new THREE.Vector3(0, 1, 0),
        impact: 0,
        impactSide: 0,
        padHit: false,
      });
    }
    this.fx = createSpeedFx(this.ctx);
    this.scene.add(this.fx.object);
    this.post = createPostFx(this.ctx);
    this.chase = new ChaseCamera(this.camera);
    this.audio = new RaceAudio(this.race);

    const player = this.race.player;
    this.hud = createStore<HudState>({
      phase: this.race.phase,
      trackName: def.name,
      countdown: -1,
      toGo: this.race.track.raceLength,
      position: player.position,
      racers: this.race.racers.length,
      time: 0,
      speedKmh: 0,
      speed01: 0,
      boost: 0,
      boosting: false,
      drafting: false,
      outline: this.race.track.minimap.points,
      pods: [],
      standings: [],
      wrongWay: false,
      paused: false,
    });

    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(container);
    this.fit();
    this.placePods(0);
    if (import.meta.env.DEV) (window as unknown as { __racer: unknown }).__racer = { race: this.race, view: this };
  }

  start() {
    this.audio.start();
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.hud.set({ paused: p });
    this.audio.setMuted(p);
  }

  /** On-screen touch controls write here. */
  get touch() {
    return this.controls.touch;
  }

  private fit() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h, this.renderer.getPixelRatio());
  }

  private frame(dt: number) {
    if (this.paused) return;
    this.time += dt;
    const race = this.race;
    race.playerInput = this.controls.read(dt);
    if (!this.frozen) race.update(dt);
    this.placePods(dt);

    const player = race.player;
    const pv = this.visuals[race.racers.indexOf(player)];
    const pos = pv.object.position;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(pv.object.quaternion);
    const speed01 = player.state.v / player.stats.topSpeed;

    if (race.phase === 'intro') {
      const u = 1 - (-race.time - 3) / INTRO;
      const f = race.track.frameAt(race.track.startS - 30);
      this.chase.intro(Math.max(0, Math.min(1, u)), f.pos.clone().add(new THREE.Vector3(0, 2, 0)), f.tangent);
      if (u >= 0.98) this.chase.reset();
    } else {
      // Use the track up for the camera rather than the pod's roll so the horizon only follows the banking.
      const f = race.track.frameAt(player.state.s);
      this.chase.update(dt, { pos, forward, up: f.up.clone().lerp(this.camUp, 0.25).normalize(), speed01, boosting: player.state.boosting, surge: player.state.surge, impact: this.fxPods[race.racers.indexOf(player)].impact, finished: race.phase === 'finished' }, this.time);
    }

    const view: FxView = {
      dt,
      time: this.time,
      camera: this.camera,
      playerPos: pos,
      playerForward: forward,
      speed01,
      boosting: player.state.boosting,
      playerS: player.state.s,
      pods: this.fxPods,
    };
    this.world.update(view);
    this.fx.update(view);
    this.audio.update(dt, this.camera.position);
    this.post.render(view);
    this.publishHud(dt);

    if (race.phase === 'finished' && !this.finished) {
      this.finished = true;
      // Let the player see the finish for a moment, then report.
      setTimeout(() => this.opts.onFinish?.(this.result()), 2600);
    }
  }

  private placePods(dt: number) {
    const race = this.race;
    const track = race.track;
    race.racers.forEach((r, i) => {
      const st = r.state;
      const v = this.visuals[i];
      const f = track.frameAt(st.s);
      const bob = Math.sin(this.time * 2.3 + i * 1.7) * 0.12 + Math.sin(this.time * 17 + i) * 0.03 * Math.min(1, st.v / 60);
      // On its side the lower engine would scrape the road: ride higher.
      const lift = Math.abs(st.roll) * 1.9;
      const pos = f.pos.clone().addScaledVector(f.right, st.x).addScaledVector(f.up, HOVER + bob + lift);
      pos.y += st.h;
      const forward = f.tangent.clone().multiplyScalar(Math.cos(st.psi)).addScaledVector(f.right, -Math.sin(st.psi)).normalize();
      const right = forward.clone().cross(f.up).normalize();
      const up = right.clone().cross(forward).normalize();
      const m = new THREE.Matrix4().makeBasis(right, up, forward.clone().negate());
      v.object.quaternion.setFromRotationMatrix(m);
      // Lean into turns, nose up a touch under thrust.
      // Lean into turns, nose up a touch under thrust; in the air the nose follows the flight path.
      const roll = THREE.MathUtils.clamp(-st.yawRate * 0.45 + (st.phi - st.psi) * 0.6, -0.6, 0.6);
      let pitch = (r.input.throttle - r.input.brake) * 0.03 + (st.boosting ? 0.03 : 0);
      if (st.air) pitch += THREE.MathUtils.clamp(Math.atan2(st.vy, Math.max(10, st.v)) - Math.asin(THREE.MathUtils.clamp(f.tangent.y, -1, 1)), -0.5, 0.5);
      v.object.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, 0, roll, 'ZXY')));
      if (r === race.player) this.camUp.set(0, 1, 0).applyQuaternion(v.object.quaternion);
      // Knife edge: Q rolls onto the left side, E onto the right.
      if (st.roll) v.object.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, (-st.roll * Math.PI) / 2));
      v.object.position.copy(pos);

      const fp = this.fxPods[i];
      if (dt > 0) fp.velocity.copy(pos).sub(this.prevPos[i]).divideScalar(dt);
      this.prevPos[i].copy(pos);
      fp.speed = st.v;
      fp.speed01 = st.v / r.stats.topSpeed;
      fp.boosting = st.boosting;
      fp.surge = st.surge;
      fp.ground.copy(f.pos).addScaledVector(f.right, st.x);
      fp.groundNormal.copy(f.up);
      // Impacts are reported per physics step; keep the strongest of this frame.
      fp.impact = st.impact;
      fp.impactSide = st.impactSide;
      fp.padHit = st.padHit;
      v.update({ dt, time: this.time, speed01: fp.speed01, throttle: r.input.throttle, steer: r.input.steer, boosting: st.boosting, surge: st.surge });
    });
  }

  private publishHud(dt: number) {
    this.hudAt -= dt;
    const race = this.race;
    const p = race.player;
    const patch: Partial<HudState> = {
      phase: race.phase,
      countdown: race.phase === 'countdown' ? Math.ceil(-race.time) : race.time >= 0 && race.time < 0.9 ? 0 : -1,
      time: p.finish ?? Math.max(0, race.time),
      toGo: Math.max(0, race.track.finishS - p.state.s),
      position: p.position,
      speedKmh: Math.round(p.state.v * DISPLAY_KMH),
      speed01: p.state.v / p.stats.topSpeed,
      boost: p.state.boost,
      boosting: p.state.boosting,
      drafting: p.state.draft > 0,
      wrongWay: Math.abs(p.state.psi) > 1.25 && p.state.v > 5,
    };
    if (this.hudAt <= 0) {
      this.hudAt = 1 / 12;
      const proj = race.track.minimap.project;
      patch.pods = race.racers.map((r, i) => {
        const [x, y] = proj(this.visuals[i].object.position);
        return { x, y, color: podColor(r.pod), player: r === p };
      });
      patch.standings = [...race.racers]
        .sort((a, b) => a.position - b.position)
        .map((r) => ({ name: r.name, color: podColor(r.pod), player: r === p, finished: r.finish !== null }));
    }
    this.hud.set(patch);
  }

  result(): RaceResult {
    const race = this.race;
    const order = race.classification().map((c) => ({
      id: c.racer.id,
      name: c.racer.name,
      time: c.time,
      projected: c.projected,
      bestLap: c.racer.bestLap,
      player: c.racer === race.player,
      podId: (c.racer.pod as PodDesign).id,
    }));
    const pi = order.findIndex((o) => o.player);
    return { trackId: race.track.def.id, order, playerPosition: pi + 1, playerTime: order[pi].time, playerBestLap: race.player.bestLap };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.controls.dispose();
    this.audio.dispose();
    this.world.dispose();
    this.fx.dispose();
    this.post.dispose();
    for (const v of this.visuals) v.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** The pod's most saturated paint, for minimap dots and standings. */
export function podColor(pod: PodDesign): string {
  const sat = (hex: string) => {
    const c = new THREE.Color(hex);
    const hsl = { h: 0, s: 0, l: 0 };
    c.getHSL(hsl);
    return hsl.s * (1 - Math.abs(hsl.l * 2 - 1));
  };
  const { primary, secondary } = pod.livery;
  return sat(primary) >= sat(secondary) ? primary : secondary;
}

function defaultQuality(): Quality {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  return coarse ? 'low' : 'high';
}
