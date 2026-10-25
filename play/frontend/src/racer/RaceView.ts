// Renders and runs one race: owns the renderer, scene, world, pod models, effects, camera, audio and controls, steps
// the Race simulation every frame and publishes HUD state to a store the React HUD reads. Name tags over the rival
// pods near the player are plain DOM labels laid over the canvas. Pod destruction: the simulation reports each
// contact's damage in pod space (onParts); after the pods are placed this frame the view dents the model where it was
// hit, sprays shrapnel, and breaks the broken parts off into the debris system, which flies them across the course.
//
// Debug URL parameters (handy for screenshots and the art labs):
//   ?autopilot   the AI flies the player's pod      ?skipintro   start at the green light
//   ?at=0.4      start the player at 40% of the run  ?freeze      simulation paused (camera still renders)
//   ?quality=low|medium|high
// `window.__racer` exposes { race, view } in dev builds.

import { boostDuration } from './core/physics';
import * as THREE from 'three';
import { createStore, type Store } from '../games/types';
import { MusicDirector } from './audio/director';
import { RaceAudio } from './audio/sound';
import { PARTS, type Hit, type PartHit, type PartId } from './core/damage';
import { DISPLAY_KMH, type PodDesign } from './core/pods';
import { INTRO, Race, type Phase, type RacerSetup } from './core/race';
import { trackById } from './core/tracks';
import { ChaseCamera } from './fx/camera';
import { Controls } from './fx/controls';
import { createPostFx } from './fx/post';
import { createSpeedFx } from './fx/speed';
import { createPod } from './vehicle/pod';
import { DebrisSystem } from './world/debris';
import { buildWorld, type World } from './world';
import type { FxPod, FxView, PodVisual, PostFx, Quality, SpeedFx, WorldContext } from './world/types';

/** Hover height of a pod's centre above the road. */
export const HOVER = 2.1;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
/** Height of a wreck's centre above the ground when it lies on the sand. */
const WRECK_REST = 1;
/** Name tags show within TAG_FAR metres of the camera, fully opaque inside TAG_NEAR. */
const TAG_FAR = 140;
const TAG_NEAR = 70;
const tagPos = new THREE.Vector3();

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
  /** The player's damage per part (left engine, right engine, cockpit), 0..1. */
  damage: [number, number, number];
  /** Seconds until the player's wreck is back on the course (0 = not wrecked), and seconds of ghosting left. */
  wrecked: number;
  ghost: number;
  /** The player's per-part health (1 intact .. 0 broken), see core/damage.ts. */
  parts?: Record<PartId, number>;
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
  /** Called every frame before the race steps (networked races write the remote pods and the clock here). */
  onFrame?(dt: number): void;
  /**
   * A race in a room (racer/net): the debug URL parameters ?at, ?freeze and ?skipintro do nothing (?autopilot only in
   * dev builds, for the screenshot tool), and a slow frame is caught up in full (up to the Race's 0.25 s) instead of
   * running the local pod in slow motion against everyone else's.
   */
  networked?: boolean;
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
  readonly music: MusicDirector;
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
  private readonly frozen: boolean;
  private readonly tagLayer = document.createElement('div');
  private readonly tags: HTMLDivElement[] = [];
  private readonly debris: DebrisSystem;
  /** Contacts reported by the simulation since the last frame, per racer, applied to the models in placePods. */
  private readonly pendingHits: { hits: PartHit[]; hit: Hit }[][] = [];
  /** Racers to rebuild a fresh model for (respawned: their broken-off parts are lying on the course). */
  private readonly rebuild = new Set<number>();
  /** Bumped whenever the player's parts change, so the HUD gets a new `parts` object only then. */
  private partsVersion = 0;
  private partsPublished = -1;
  private readonly quality: Quality;

  constructor(private readonly container: HTMLElement, private readonly opts: RaceViewOptions) {
    const def = trackById(opts.trackId);
    const quality = (this.params.get('quality') as Quality | null) ?? opts.quality ?? defaultQuality();
    this.quality = quality;
    this.race = new Race(def, opts.racers, {
      onCountdown: (n) => this.audio.countdown(n),
      onImpact: (r, k) => this.audio.impact(k, r === this.race.player),
      onPad: (r) => this.audio.pad(r === this.race.player),
      onWreck: (r) => {
        if (r === this.race.player) this.audio.wreck();
      },
      onParts: (r, hits, hit) => {
        const i = this.race.racers.indexOf(r);
        (this.pendingHits[i] ??= []).push({ hits, hit });
        if (r === this.race.player) this.partsVersion++;
      },
      onRespawn: (r) => {
        this.rebuild.add(this.race.racers.indexOf(r));
        if (r === this.race.player) this.partsVersion++;
      },
      onFinish: (r) => {
        if (r === this.race.player) this.audio.finish(r.position);
      },
    });
    // Debug parameters: in a room they would move the pod for everyone (?at=0.95 wins the race).
    const net = !!opts.networked;
    this.frozen = !net && this.params.has('freeze');
    if (this.params.has('autopilot') && (!net || import.meta.env.DEV)) this.race.autopilot = true;
    if (!net && this.params.has('skipintro')) this.race.time = -0.01;
    const at = net ? 0 : Number(this.params.get('at'));
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
    this.debris = new DebrisSystem(this.ctx);
    this.scene.add(this.debris.object);
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
        damage: r.damage,
        wrecked: false,
        hit: null,
        health: r.parts.health,
        anchors: r.anchors,
      });
      const tag = document.createElement('div');
      tag.className = 'racer-tag';
      tag.textContent = r.name;
      tag.style.setProperty('--tag-color', r.color ?? podColor(r.pod));
      this.tagLayer.appendChild(tag);
      this.tags.push(tag);
    }
    this.tagLayer.className = 'racer-tags';
    container.appendChild(this.tagLayer);
    this.fx = createSpeedFx(this.ctx);
    this.scene.add(this.fx.object);
    this.post = createPostFx(this.ctx);
    this.chase = new ChaseCamera(this.camera);
    this.audio = new RaceAudio(this.race);
    this.music = new MusicDirector(this.race);

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
      damage: [0, 0, 0],
      wrecked: 0,
      ghost: 0,
    });

    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(container);
    this.fit();
    this.placePods(0);
    if (import.meta.env.DEV) (window as unknown as { __racer: unknown }).__racer = { race: this.race, view: this };
  }

  start() {
    this.audio.start();
    this.music.start();
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(this.opts.networked ? 0.25 : 0.05, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.hud.set({ paused: p });
    this.audio.setMuted(p);
    this.music.setPaused(p);
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
    this.opts.onFrame?.(dt);
    if (!this.frozen) race.update(dt);
    this.placePods(dt);

    const player = race.player;
    const pv = this.visuals[race.racers.indexOf(player)];
    const pos = pv.object.position;
    // A tumbling wreck would spin the chase camera with it: follow the course's direction until the respawn.
    const forward = player.wrecked > 0 ? race.track.frameAt(player.state.s).tangent.clone() : new THREE.Vector3(0, 0, -1).applyQuaternion(pv.object.quaternion);
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
    // Pods (and wrecks) knock the debris lying on the course; ones in the air pass over it.
    for (let i = 0; i < race.racers.length; i++) {
      const o = this.visuals[i].object;
      this.debris.setPod(i, o.position, this.fxPods[i].velocity, o.quaternion, race.racers[i].state.air);
    }
    this.debris.setPodCount(race.racers.length);
    view.smokeSources = this.debris.update(view);
    this.world.update(view);
    this.fx.update(view);
    const h = player.parts.health;
    this.audio.setEngineHealth(Math.min(h.intakeL, h.fanL, h.nozzleL, h.nacelleL), Math.min(h.intakeR, h.fanR, h.nozzleR, h.nacelleR));
    this.audio.update(dt, this.camera.position);
    this.music.update(dt);
    this.post.render(view);
    this.placeTags();
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
    // A respawned pod gets a whole new model: the old one's broken parts are debris now.
    for (const i of this.rebuild) {
      const old = this.visuals[i];
      const v = createPod(race.racers[i].pod, this.quality);
      v.object.position.copy(old.object.position);
      v.object.quaternion.copy(old.object.quaternion);
      this.scene.remove(old.object);
      old.dispose();
      this.scene.add(v.object);
      this.visuals[i] = v;
      this.fxPods[i].visual = v;
    }
    this.rebuild.clear();
    race.racers.forEach((r, i) => {
      const st = r.state;
      const v = this.visuals[i];
      const f = track.frameAt(st.s);
      const bob = Math.sin(this.time * 2.3 + i * 1.7) * 0.12 + Math.sin(this.time * 17 + i) * 0.03 * Math.min(1, st.v / 60);
      // Leaning into a turn (roll, below) the inner engine dips by about its reach times the lean, and on its side the
      // lower engine would scrape the road: ride higher for both.
      const roll = THREE.MathUtils.clamp(st.yawRate * 0.45 + (st.psi - st.phi) * 0.6, -0.6, 0.6);
      const lift = Math.abs(st.roll) * 1.9 + Math.abs(Math.sin(roll)) * 2.4;
      // A wreck tumbles through the air and comes to rest on the sand (its centre about a metre up).
      const wrecked = r.wrecked > 0;
      const pos = f.pos.clone().addScaledVector(f.right, st.x).addScaledVector(f.up, wrecked ? WRECK_REST : HOVER + bob + lift);
      pos.y += st.h;
      const forward = f.tangent.clone().multiplyScalar(Math.cos(st.psi)).addScaledVector(f.right, -Math.sin(st.psi)).normalize();
      const right = forward.clone().cross(f.up).normalize();
      const up = right.clone().cross(forward).normalize();
      const m = new THREE.Matrix4().makeBasis(right, up, forward.clone().negate());
      v.object.quaternion.setFromRotationMatrix(m);
      // Lean into turns, nose up a touch under thrust.
      // Lean into turns, nose up a touch under thrust; in the air the nose follows the flight path.
      let pitch = (r.input.throttle - r.input.brake) * 0.03 + (st.boosting ? 0.03 : 0);
      if (st.air) pitch += THREE.MathUtils.clamp(Math.atan2(st.vy, Math.max(10, st.v)) - Math.asin(THREE.MathUtils.clamp(f.tangent.y, -1, 1)), -0.5, 0.5);
      v.object.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, 0, roll, 'ZXY')));
      if (wrecked) {
        const w = r.wreck;
        v.object.quaternion.setFromRotationMatrix(m.makeBasis(f.right, f.up, f.tangent.clone().negate()));
        v.object.quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(w.pitch, w.yaw, w.roll, 'YXZ')));
      } else if (r === race.player) this.camUp.set(0, 1, 0).applyQuaternion(v.object.quaternion);
      // Knife edge: Q rolls onto the left side, E onto the right.
      if (st.roll && !wrecked) v.object.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, (-st.roll * Math.PI) / 2));
      v.object.position.copy(pos);
      // A ghost after the respawn blinks.
      v.object.visible = !r.gone && (r.ghost <= 0 || Math.floor(r.ghost * 9) % 2 === 0);

      const fp = this.fxPods[i];
      // A spectator's camera moves from pod to pod.
      fp.isPlayer = r === race.player;
      if (dt > 0) fp.velocity.copy(pos).sub(this.prevPos[i]).divideScalar(dt);
      this.prevPos[i].copy(pos);
      fp.speed = st.v;
      fp.speed01 = st.v / r.stats.topSpeed;
      fp.boosting = st.boosting;
      fp.surge = st.surge;
      fp.ground.copy(f.pos).addScaledVector(f.right, st.x);
      fp.ground.y += track.lift(st.s, st.x);
      fp.groundNormal.copy(f.up);
      // Impacts are reported per physics step; keep the strongest of this frame.
      fp.impact = st.impact;
      fp.impactSide = st.impactSide;
      fp.padHit = st.padHit;
      fp.damage = r.damage;
      fp.wrecked = r.wrecked > 0;
      fp.health = r.parts.health;
      fp.anchors = r.anchors;
      fp.hit = null;
      const pending = this.pendingHits[i];
      if (pending?.length) {
        v.object.updateMatrixWorld();
        for (const { hits, hit } of pending) this.applyHit(i, hits, hit);
        pending.length = 0;
        v.setPartHealth?.(r.parts.health, r.parts.broken);
      }
      v.update({ dt, time: this.time, speed01: fp.speed01, throttle: r.input.throttle, steer: r.input.steer, boosting: st.boosting, surge: st.surge, damage: r.damage, wrecked: fp.wrecked });
    });
  }

  /**
   * One contact on racer i's model (its transform is current): dent the skin at the pod-space point, spray shrapnel
   * from it, and break the broken parts off into the debris, thrown with the pod's velocity plus a kick along the push
   * and a spin as hard as the hit. A broken part that carries others (a nacelle with its fin, flap and nozzle) goes as
   * one piece, so its passengers are skipped.
   */
  private applyHit(i: number, hits: PartHit[], hit: Hit) {
    const r = this.race.racers[i];
    const v = this.visuals[i];
    const fp = this.fxPods[i];
    const m = v.object.matrixWorld;
    const point = new THREE.Vector3(...hit.point);
    const dir = new THREE.Vector3(...hit.dir).normalize();
    const e = Math.min(2, hit.energy);
    v.dent?.(point, dir, Math.min(0.45, 0.06 + 0.22 * e));
    const wp = point.clone().applyMatrix4(m);
    const wd = dir.clone().transformDirection(m);
    // The strongest contact this frame feeds the effects (sparks at the real point).
    if (!fp.hit || e > fp.hit.energy) fp.hit = { point: wp, dir: wd, energy: e, kind: hit.kind };
    this.debris.shrapnel(wp, wd.clone().negate().add(fp.velocity.clone().multiplyScalar(0.01)).normalize(), Math.round(3 + 18 * e), 6 + 14 * e, new THREE.Color(r.pod.livery.primary));
    const broke = hits.filter((h) => h.broke);
    if (!broke.length) return;
    const gone = new Set<PartId>();
    // Carriers first, so what they carry leaves with them.
    broke.sort((a, b) => (PARTS[b.part].carries ? 1 : 0) - (PARTS[a.part].carries ? 1 : 0));
    for (const h of broke) {
      if (gone.has(h.part)) continue;
      for (const c of PARTS[h.part].carries ?? []) gone.add(c);
      gone.add(h.part);
      this.audio.partBroken(h.part, e, r === this.race.player, i);
      const piece = PARTS[h.part].detaches ? v.breakOff?.(h.part) : (v.breakOff?.(h.part), null);
      if (!piece) continue;
      const big = h.part.startsWith('nacelle') || h.part === 'hull';
      const vel = fp.velocity.clone().multiplyScalar(0.85).addScaledVector(wd, (big ? 4 : 7) * (0.5 + e)).add(new THREE.Vector3(0, 2 + Math.random() * (big ? 4 : 7), 0));
      const k = (big ? 3 : 8) * (0.4 + e);
      const spin = new THREE.Vector3((Math.random() - 0.5) * k, (Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
      this.debris.spawn(piece, vel, spin, { smoke: big ? 1 : 0.35, burning: big });
    }
  }

  /** Name tags over the other pods, fading in from TAG_FAR metres and fully shown inside TAG_NEAR. */
  private placeTags() {
    const race = this.race;
    const cam = this.camera.position;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const show = race.phase === 'racing' || race.phase === 'finished';
    // Nearest first; a tag that would cover a nearer one moves up above it, so a bunched pack stays readable.
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const order = race.racers.map((r, i) => ({ r, i, d: this.visuals[i].object.position.distanceTo(cam) })).sort((a, b) => a.d - b.d);
    for (const { r, i, d } of order) {
      const tag = this.tags[i];
      const obj = this.visuals[i].object;
      if (!show || r === race.player || d > TAG_FAR || !obj.visible) {
        tag.style.opacity = '0';
        continue;
      }
      tagPos.copy(obj.position).y += 4 + d * 0.012;
      tagPos.project(this.camera);
      if (tagPos.z > 1 || Math.abs(tagPos.x) > 1.1 || Math.abs(tagPos.y) > 1.1) {
        tag.style.opacity = '0';
        continue;
      }
      const a = Math.min(1, (TAG_FAR - d) / (TAG_FAR - TAG_NEAR));
      const k = 0.75 + 0.25 * a;
      const tw = tag.offsetWidth * k;
      const th = tag.offsetHeight * k;
      const x = ((tagPos.x + 1) / 2) * w;
      let y = ((1 - tagPos.y) / 2) * h;
      for (let n = 0; n < 8; n++) {
        const hit = placed.find((p) => Math.abs(p.x - x) < (p.w + tw) / 2 && Math.abs(p.y - y) < (p.h + th) / 2);
        if (!hit) break;
        y = hit.y - (hit.h + th) / 2 - 2;
      }
      placed.push({ x, y, w: tw, h: th });
      tag.style.opacity = a.toFixed(2);
      tag.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${k.toFixed(2)})`;
    }
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
      // Burning down while it runs, charging back up the rest of the time.
      boost: p.state.boosting ? p.state.boostLeft / boostDuration(p.stats) : p.state.boost,
      boosting: p.state.boosting,
      drafting: p.state.draft > 0,
      wrongWay: Math.abs(p.state.psi) > 1.25 && p.state.v > 5 && p.wrecked <= 0,
      wrecked: p.wrecked,
      ghost: p.ghost,
    };
    const hd = this.hud.get().damage;
    if (hd.some((v, k) => Math.abs(v - p.damage[k]) > 0.005)) patch.damage = [...p.damage];
    // A new parts object only when they changed: the diagram flashes the parts whose health dropped since the last one.
    if (this.partsPublished !== this.partsVersion) {
      this.partsPublished = this.partsVersion;
      patch.parts = { ...p.parts.health };
    }
    if (this.hudAt <= 0) {
      this.hudAt = 1 / 12;
      const proj = race.track.minimap.project;
      patch.pods = race.racers.flatMap((r, i) => {
        if (r.gone) return [];
        const [x, y] = proj(this.visuals[i].object.position);
        return [{ x, y, color: r.color ?? podColor(r.pod), player: r === p }];
      });
      patch.standings = race.racers
        .filter((r) => !r.gone)
        .sort((a, b) => a.position - b.position)
        .map((r) => ({ name: r.name, color: r.color ?? podColor(r.pod), player: r === p, finished: r.finish !== null }));
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
    this.music.dispose();
    this.world.dispose();
    this.fx.dispose();
    this.debris.dispose();
    this.post.dispose();
    for (const v of this.visuals) v.dispose();
    this.tagLayer.remove();
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
