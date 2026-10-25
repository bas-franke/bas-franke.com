// Live 3D backdrop behind the menus: the real race world of one track with a few pods flying a slow lap, filmed
// like a broadcast (chase, trackside, aerial and head-on shots with hard cuts), or a single pod hovering on the
// track as a garage turntable. One renderer for every menu screen; it is disposed when the menus unmount (the race
// starts). Cheap by design: medium quality on desktop, low on touch devices, half frame rate on low, and if the
// machine still struggles it drops to a few frames per second. Without WebGL the host's CSS painting shows instead.

import * as THREE from 'three';
import { Track, type Frame } from '../core/track';
import { trackById } from '../core/tracks';
import type { PodDesign } from '../core/pods';
import { createPostFx } from '../fx/post';
import { createSpeedFx } from '../fx/speed';
import { createPod } from '../vehicle/pod';
import { buildWorld, type World } from '../world';
import type { FxPod, FxView, PodVisual, PostFx, Quality, SpeedFx, WorldContext } from '../world/types';

const HOVER = 1.5;
/** Flyby speed (m/s): well below race pace so the menus feel calm. */
const FLY_SPEED = 58;
const SHOT_TIME = 7;

export interface BackdropScene {
  kind: 'flyby' | 'showcase';
  trackId: string;
  /** The hero pod (garage: the one on the turntable) and, in a flyby, the pods flying with it. */
  pod: PodDesign;
  rivals?: PodDesign[];
  /** Where on screen (fractions of width/height) the subject should sit, so it is not behind a panel. */
  focus?: [number, number];
}

interface FlyPod {
  design: PodDesign;
  visual: PodVisual;
  /** Gap behind the lead pod (m) and lateral lane. */
  gap: number;
  lane: number;
  fx: FxPod;
}

function pickQuality(): Quality {
  const q = new URLSearchParams(location.search).get('quality') as Quality | null;
  if (q === 'low' || q === 'medium' || q === 'high') return q;
  return window.matchMedia?.('(pointer: coarse)').matches ? 'low' : 'medium';
}

export class Backdrop {
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(58, 1, 0.3, 6000);
  private readonly quality = pickQuality();
  private ctx: WorldContext | null = null;
  private world: World | null = null;
  private post: PostFx | null = null;
  private fx: SpeedFx | null = null;
  private track: Track | null = null;
  private pods: FlyPod[] = [];
  private want: BackdropScene | null = null;
  private built: { trackId: string; pods: string } | null = null;
  private raf = 0;
  private last = 0;
  private time = 0;
  private frame = 0;
  private slowFrames = 0;
  /** Render every n-th frame (2 on low quality, more if the machine is slow). */
  private every = 1;
  private readonly observer: ResizeObserver;
  private rebuildTimer = 0;
  private readonly f1: Frame;
  private readonly f2: Frame;
  private readonly look = new THREE.Vector3();
  private readonly m = new THREE.Matrix4();
  private readonly back = new THREE.Vector3();
  private shotStartS = 0;
  private shot = -1;
  /** True when the GL backdrop works; otherwise the host keeps its CSS painting. */
  readonly ok: boolean;

  constructor(private readonly host: HTMLElement) {
    const dummy = new Track(trackById('redrock'));
    this.f1 = dummy.frameAt(0);
    this.f2 = dummy.frameAt(0);
    this.observer = new ResizeObserver(() => this.fit());
    const p = new URLSearchParams(location.search);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (p.has('nobackdrop')) {
      this.ok = false;
      return;
    }
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: this.quality !== 'low', powerPreference: 'high-performance', stencil: false });
    } catch {
      this.renderer = null;
    }
    this.ok = !!this.renderer;
    if (!this.renderer) return;
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality === 'low' ? 1 : 1.25));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.shadowMap.enabled = this.quality !== 'low';
    r.shadowMap.type = THREE.PCFShadowMap;
    r.domElement.className = 'dr-bg-canvas';
    host.appendChild(r.domElement);
    this.every = this.quality === 'low' ? 2 : 1;
    // Reduced motion: still show the world, but nearly still.
    if (reduced) this.every = 30;
    this.observer.observe(host);
    this.fit();
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Shows a scene. A different track rebuilds the world behind a short fade. */
  set(scene: BackdropScene) {
    this.want = scene;
    if (!this.renderer) return;
    const podsKey = [scene.pod.id, ...(scene.kind === 'flyby' ? (scene.rivals ?? []).map((p) => p.id) : [])].join(',');
    if (this.built && this.built.trackId === scene.trackId) {
      if (this.built.pods !== podsKey) this.buildPods(scene, podsKey);
      this.shot = -1;
      this.fit();
      return;
    }
    clearTimeout(this.rebuildTimer);
    const canvas = this.renderer.domElement;
    if (!this.built) {
      this.buildWorld(scene, podsKey);
      return;
    }
    canvas.classList.add('dr-fade');
    this.rebuildTimer = window.setTimeout(() => {
      if (this.want) this.buildWorld(this.want, podsKey);
    }, 380);
  }

  private buildWorld(scene: BackdropScene, podsKey: string) {
    const r = this.renderer!;
    this.disposeWorld();
    const def = trackById(scene.trackId);
    this.track = new Track(def);
    this.ctx = { track: this.track, theme: def.theme, renderer: r, scene: this.scene, camera: this.camera, quality: this.quality };
    this.world = buildWorld(this.ctx);
    try {
      this.fx = this.quality === 'low' ? null : createSpeedFx(this.ctx);
      if (this.fx) this.scene.add(this.fx.object);
    } catch (err) {
      console.error('backdrop speed fx failed', err);
      this.fx = null;
    }
    try {
      this.post = this.quality === 'low' ? null : createPostFx(this.ctx);
    } catch (err) {
      console.error('backdrop post fx failed', err);
      this.post = null;
    }
    this.built = { trackId: scene.trackId, pods: '' };
    this.buildPods(scene, podsKey);
    // Start somewhere scenic but different every visit.
    this.time = Math.random() * 40;
    this.shot = -1;
    this.fit();
    requestAnimationFrame(() => r.domElement.classList.remove('dr-fade'));
  }

  private buildPods(scene: BackdropScene, key: string) {
    for (const p of this.pods) {
      this.scene.remove(p.visual.object);
      p.visual.dispose();
    }
    this.pods = [];
    const designs = scene.kind === 'flyby' ? [scene.pod, ...(scene.rivals ?? []).slice(0, this.quality === 'low' ? 1 : 3)] : [scene.pod];
    designs.forEach((d, i) => {
      const visual = createPod(d, this.quality);
      this.scene.add(visual.object);
      const fx: FxPod = {
        visual,
        isPlayer: i === 0,
        livery: d.livery,
        speed01: 0.75,
        speed: FLY_SPEED,
        boosting: false,
        surge: 0,
        velocity: new THREE.Vector3(),
        ground: new THREE.Vector3(),
        groundNormal: new THREE.Vector3(0, 1, 0),
        impact: 0,
        impactSide: 0,
        padHit: false,
      };
      // The hero leads; rivals chase in alternating lanes.
      this.pods.push({ design: d, visual, gap: i === 0 ? 0 : 14 + i * 16 + (i % 2) * 6, lane: i === 0 ? -0.1 : i % 2 ? 0.45 : -0.5, fx });
    });
    if (this.built) this.built.pods = key;
  }

  private fit() {
    const r = this.renderer;
    if (!r) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    r.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Push the subject towards the focus point by shifting the projection centre.
    const focus = this.want?.focus;
    if (focus) this.camera.setViewOffset(w, h, w * (0.5 - focus[0]), h * (0.5 - focus[1]), w, h);
    else this.camera.clearViewOffset();
    this.camera.fov = this.want?.kind === 'showcase' ? (w / h < 0.8 ? 62 : 42) : w / h < 0.8 ? 75 : 58;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h, r.getPixelRatio());
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, this.last ? (now - this.last) / 1000 : 0.016);
    this.last = now;
    this.time += dt;
    this.frame++;
    if (this.frame % this.every) return;
    const t0 = performance.now();
    this.render(dt * this.every);
    // A machine that needs > 40 ms per backdrop frame gets a nearly static backdrop instead.
    if (this.frame > 20 && performance.now() - t0 > 40) {
      if (++this.slowFrames > 20 && this.every < 8) {
        this.every = 8;
        console.info('menu backdrop: slow device, throttling');
      }
    }
  };

  private podPose(p: FlyPod, s: number, x: number, h: number, yaw = 0) {
    const tr = this.track!;
    const f = tr.frameAt(s, this.f1);
    const pos = p.visual.object.position;
    pos.copy(f.pos).addScaledVector(f.right, x).addScaledVector(f.up, h);
    // Nose (-Z) along the direction of travel.
    this.back.copy(f.tangent).negate();
    this.m.makeBasis(f.right, f.up, this.back);
    p.visual.object.quaternion.setFromRotationMatrix(this.m);
    if (yaw) p.visual.object.rotateY(yaw);
    p.fx.ground.copy(f.pos).addScaledVector(f.right, x);
    p.fx.groundNormal.copy(f.up);
    p.fx.velocity.copy(f.tangent).multiplyScalar(p.fx.speed);
  }

  private render(dt: number) {
    const r = this.renderer;
    const scene = this.want;
    const tr = this.track;
    if (!r || !scene || !tr || !this.world || !this.pods.length) return;
    const cam = this.camera;
    const t = this.time;
    const lead = this.pods[0];
    let leadS: number;

    if (scene.kind === 'showcase') {
      // Garage turntable: the pod hovers just past the start line and slowly turns.
      leadS = tr.startS + 20;
      const bob = Math.sin(t * 1.6) * 0.12;
      this.podPose(lead, leadS, 0, HOVER + 0.4 + bob, t * 0.35);
      lead.fx.speed = 0;
      lead.fx.speed01 = 0;
      lead.visual.update({ dt, time: t, speed01: 0.05, throttle: 0.15, steer: Math.sin(t * 0.5) * 0.2, boosting: false, surge: 0 });
      const f = tr.frameAt(leadS, this.f2);
      const portrait = cam.aspect < 0.8;
      const dist = portrait ? 24 : 19;
      cam.position.copy(f.pos).addScaledVector(f.right, dist * 0.6).addScaledVector(f.tangent, -dist * 0.8).addScaledVector(f.up, 4.2);
      this.look.copy(lead.visual.object.position).addScaledVector(f.up, 0.2);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.look);
    } else {
      // From the start line to the finish, then round again from the start.
      leadS = tr.startS + ((t * FLY_SPEED) % tr.raceLength);
      const width = tr.frameAt(leadS, this.f2).width;
      for (const p of this.pods) {
        const s = leadS - p.gap;
        const x = (p.lane + Math.sin(t * 0.35 + p.gap * 0.07) * 0.18) * width * 0.5;
        const steer = Math.cos(t * 0.35 + p.gap * 0.07) * 0.4;
        p.fx.speed = FLY_SPEED;
        p.fx.speed01 = 0.75;
        this.podPose(p, s, x, HOVER + Math.sin(t * 2.1 + p.gap) * 0.08, 0);
        p.visual.object.rotateZ(-steer * 0.12);
        p.visual.update({ dt, time: t, speed01: 0.75, throttle: 1, steer, boosting: false, surge: 0 });
      }
      const shot = Math.floor(t / SHOT_TIME) % 4;
      if (shot !== this.shot) {
        this.shot = shot;
        this.shotStartS = leadS;
      }
      const into = t % SHOT_TIME;
      const lp = lead.visual.object.position;
      const f = this.f2;
      cam.up.set(0, 1, 0);
      if (shot === 0) {
        // Low chase from behind and to the side.
        tr.frameAt(leadS - 20, f);
        cam.position.copy(f.pos).addScaledVector(f.right, 5).addScaledVector(f.up, 4.5);
        tr.frameAt(leadS + 30, f);
        this.look.copy(f.pos).addScaledVector(f.up, 1);
      } else if (shot === 1) {
        // Trackside: a fixed camera by the barrier the pack screams past mid-shot.
        tr.frameAt(this.shotStartS + FLY_SPEED * SHOT_TIME * 0.55, f);
        cam.position.copy(f.pos).addScaledVector(f.right, f.width * 0.5 - 1.5).addScaledVector(f.up, 3);
        this.look.copy(lp).addScaledVector(f.up, 1);
      } else if (shot === 2) {
        // High crane shot from ahead, rising: shows off the canyon. Stays over the road so walls never block it.
        tr.frameAt(leadS + 45 - into * 2, f);
        cam.position.copy(f.pos).addScaledVector(f.right, -f.width * 0.3).addScaledVector(f.up, 16 + into * 2);
        this.look.copy(lp);
      } else {
        // Head-on, low: the pods come at the camera.
        tr.frameAt(leadS + 15, f);
        cam.position.copy(f.pos).addScaledVector(f.right, 3).addScaledVector(f.up, 2.4);
        this.look.copy(lp).addScaledVector(f.up, 0.8);
      }
      cam.lookAt(this.look);
    }

    const view: FxView = {
      dt,
      time: t,
      camera: cam,
      playerPos: lead.visual.object.position,
      playerForward: lead.fx.velocity.lengthSq() > 0 ? this.back.copy(lead.fx.velocity).normalize() : this.back.set(0, 0, -1),
      speed01: lead.fx.speed01,
      boosting: false,
      playerS: leadS,
      pods: this.pods.map((p) => p.fx),
    };
    this.world.update(view);
    this.fx?.update(view);
    if (this.post) this.post.render(view);
    else r.render(this.scene, cam);
  }

  private disposeWorld() {
    for (const p of this.pods) {
      this.scene.remove(p.visual.object);
      p.visual.dispose();
    }
    this.pods = [];
    if (this.fx) {
      this.scene.remove(this.fx.object);
      this.fx.dispose();
      this.fx = null;
    }
    this.post?.dispose();
    this.post = null;
    this.world?.dispose();
    this.world = null;
    // World modules may leave fog / environment / lights on the scene: start the next track clean.
    this.scene.clear();
    this.scene.fog = null;
    this.scene.background = null;
    this.scene.environment = null;
    this.built = null;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.rebuildTimer);
    this.observer.disconnect();
    this.disposeWorld();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
  }
}
